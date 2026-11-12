"""실패한 단계만 다시 하기: 오늘 브리핑이 AI 실패로 품질이 떨어졌을 때, 처음부터 다시 만들지 않고 실패한 부분만 고친다.

- 요약이 실패한 섹션(sec.error): 저장된 기사(원문 제목·RSS 설명·출처)로 그 지역만 다시 요약 (지역당 AI 1회)
- 영향 분석이 빠진 경우: 인사이트만 다시 (AI 1회)
수집·중복 제거·선별은 다시 하지 않으므로 기사 구성이 바뀌지 않고, AI 요청은 보통 1~3회로 끝난다(전체 재생성은 4회 이상).
선별 자체가 실패했던 날(휴리스틱 선별)은 고칠 수 없어 전체 재생성으로 넘긴다.
"""
from __future__ import annotations

from datetime import datetime

from common import Article, Source, log


def needs(brief: dict, cfg: dict) -> dict:
    """무엇을 고쳐야 하나: {summary: [섹션…], insight: bool, rank: bool}."""
    meta = brief.get("meta") or {}
    secs = brief.get("sections", {})
    failed = [k for k, s in secs.items() if s.get("error")]
    nz_items = [it for k, s in secs.items() if cfg["sections"].get(k, {}).get("region") == "nz" for it in s.get("items", []) if not it.get("carried_from")]
    no_impact = sum(1 for it in nz_items if not it.get("impact"))
    insight_on = cfg.get("insight", {}).get("enabled", True)
    return {"summary": failed, "insight": bool(insight_on and nz_items and no_impact / len(nz_items) > 0.5),
            "rank": "선별 실패" in (meta.get("degraded_reason") or "")}


def to_article(it: dict, section: str) -> Article:
    """저장된 기사 카드 → 요약 입력용 Article (원문 제목 + 저장해 둔 RSS 설명)."""
    srcs = it.get("sources") or [{"name": "", "url": ""}]
    pub = None
    try:
        pub = datetime.fromisoformat(it["published_at"]) if it.get("published_at") else None
    except ValueError:
        pass
    desc = " ".join(s for s in it.get("summary_ko", []) if s and s != it.get("original_title"))
    a = Article(id=it["id"], section=section, title=it.get("original_title") or it.get("title_ko", ""), url=srcs[0].get("url", ""), source=srcs[0].get("name", ""),
                published=pub, description=desc, extra_sources=[Source(s.get("name", ""), s.get("url", "")) for s in srcs[1:]])
    a.score = float(it.get("importance", 1))
    a.radar_score = int(it.get("radar", 0))
    return a


def repair(brief: dict, cfg: dict, llm, data_dir, today: str, fetch_bodies: bool = True) -> dict:
    """고친 것: {summary: [섹션…], insight: bool, requests: n}. brief 를 제자리에서 고친다."""
    from insight import attach_insights
    from summarize import attach_excerpts, summarize_region

    todo = needs(brief, cfg)
    secs = brief["sections"]
    chosen: dict[str, list[Article]] = {}
    for k, s in secs.items():
        chosen[k] = [to_article(it, k) for it in s.get("items", []) if not it.get("carried_from")]
    done = {"summary": [], "insight": False, "requests": 0}
    before = llm.requests
    if todo["summary"]:
        failed = set(todo["summary"])
        if fetch_bodies:
            attach_excerpts({k: v for k, v in chosen.items() if k in failed}, cfg)
        by_region: dict[str, list[str]] = {}
        for k in todo["summary"]:
            by_region.setdefault(cfg["sections"][k]["region"], []).append(k)
        for region, keys in by_region.items():
            out = summarize_region(region, keys, chosen, cfg, llm)
            for k in keys:
                if out.get(k) and not out[k].get("error"):
                    carried = [it for it in secs[k].get("items", []) if it.get("carried_from")]
                    secs[k] = {**out[k], "items": out[k]["items"] + carried}
                    done["summary"].append(k)
    if todo["insight"] or done["summary"]:
        try:
            done["insight"] = attach_insights(secs, chosen, cfg, llm, data_dir, today) > 0
        except Exception as e:  # noqa: BLE001
            log.warning("repair: insight failed: %s", e)
    done["requests"] = llm.requests - before
    log.info("repair: summary %s, insight %s, AI requests %d", done["summary"] or "-", done["insight"], done["requests"])
    return done
