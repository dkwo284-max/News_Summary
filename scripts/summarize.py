"""요약: 섹션별로 한 번씩 Sonnet 을 호출해 한국어 제목·3줄 요약·이민자 관점·태그·한 줄 브리핑을 만든다.

원문 본문은 요약 입력으로만 잠깐 쓰고 저장하지 않는다(저작권).
"""
from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor

import httpx

from common import Article, log

MAX_LINE = 80
NO_LLM_NOTE = "(오프라인 모드: Claude 요약 없이 RSS 설명을 그대로 표시)"

TAG_VOCAB = "비자, 이민, 영주권, 고용, 임금, 주거, 렌트, 금리, 물가, 환율, 교육, 의료, 치안, 날씨, 재난, 교통, 경제, 증시, 부동산, 정치, 사회, 사건사고, 연예, 방송, 스포츠, 기술"

SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "briefing": {"type": "string"},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "title_ko": {"type": "string"},
                    "summary_ko": {"type": "array", "items": {"type": "string"}},
                    "why_it_matters": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["id", "title_ko", "summary_ko", "why_it_matters", "tags"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["briefing", "items"],
    "additionalProperties": False,
}


def _system_prompt(region: str, label: str) -> str:
    why = (
        "- why_it_matters: 뉴질랜드 이민을 준비하는 한국인에게 이 기사가 갖는 의미를 한 문장(60자 이내)으로. "
        "직접 관련이 적으면 생활·비용·안전 측면의 함의를 구체적으로. 추측성 단정은 피하세요."
        if region == "nz"
        else "- why_it_matters: 빈 문자열(\"\")로 두세요."
    )
    return f"""당신은 한국어 아침 뉴스 브리핑 편집자입니다. 섹션: {label}.
각 기사에 대해 다음을 작성하세요.
- title_ko: 자연스러운 한국어 제목 (영어 기사는 번역, 40자 이내, 낚시성 표현 제거)
- summary_ko: 정확히 3줄. 각 줄은 80자 이내의 완결된 문장. 핵심 사실 → 배경/수치 → 전망/영향 순서.
{why}
- tags: 1~3개. 가능하면 다음 중에서: {TAG_VOCAB}
그리고 섹션 전체를 아우르는 '오늘의 한 줄 브리핑'(briefing)을 60자 이내 한 문장으로 쓰세요.
규칙: 주어진 제목·설명·본문 발췌에 있는 사실만 사용하고, 없는 수치나 인용을 만들지 마세요.
입력의 모든 id 를 한 번씩 반환하세요."""


# ── 본문 발췌 ───────────────────────────────────────────────

def _extract_one(client: httpx.Client, a: Article, limit: int) -> None:
    if "news.google.com" in a.url:  # 리다이렉트가 JS 기반이라 본문 추출 불가 → RSS 정보만 사용
        return
    try:
        import trafilatura

        r = client.get(a.url)
        r.raise_for_status()
        text = trafilatura.extract(r.text, include_comments=False, include_tables=False) or ""
        a.excerpt = re.sub(r"\s+", " ", text)[:limit]
    except Exception as e:  # noqa: BLE001
        log.debug("excerpt failed %s: %s", a.url, e)


def attach_excerpts(chosen: dict[str, list[Article]], cfg: dict) -> None:
    fcfg = cfg["fetch"]
    if not fcfg.get("extract_body", True):
        return
    articles = [a for items in chosen.values() for a in items]
    with httpx.Client(timeout=fcfg["timeout_seconds"], headers={"User-Agent": fcfg["user_agent"]}, follow_redirects=True) as client:
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda a: _extract_one(client, a, fcfg.get("body_chars", 1500)), articles))
    log.info("excerpts: %d/%d articles", sum(1 for a in articles if a.excerpt), len(articles))


# ── 후처리 ─────────────────────────────────────────────────

def clamp_line(s: str, limit: int = MAX_LINE) -> str:
    s = re.sub(r"\s+", " ", s).strip().lstrip("-•·").strip()
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def _split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?。])\s+|(?<=다\.)\s*", text)
    return [p.strip() for p in parts if p and p.strip()]


def _item_dict(a: Article, *, title_ko: str, summary: list[str], why: str, tags: list[str], region: str) -> dict:
    lines = [clamp_line(s) for s in summary if s and s.strip()][:3] or [clamp_line(a.title)]
    item = {
        "id": a.id,
        "title_ko": title_ko.strip() or a.title,
        "summary_ko": lines,
        "tags": [t.strip() for t in tags if t.strip()][:3],
        "importance": int(max(1, min(10, round(a.score or 1)))),
        "sources": [s.to_dict() for s in a.sources],
        "original_title": a.title,
        "published_at": a.published.isoformat(timespec="minutes") if a.published else None,
    }
    if region == "nz":
        item["why_it_matters"] = clamp_line(why or "", 120)
    return item


def offline_item(a: Article, region: str, cfg: dict) -> dict:
    sentences = _split_sentences(a.description) if a.description else []
    tags = []
    if region == "nz":
        from rank import _kw_hits

        for t in cfg["weights"]["high"]:
            if _kw_hits(f"{a.title} {a.description}", t["keywords"]):
                tags.append(t["topic"].split("/")[0].split("·")[0])
    return _item_dict(
        a,
        title_ko=a.title,
        summary=sentences[:3] or [a.title],
        why=NO_LLM_NOTE if region == "nz" else "",
        tags=tags,
        region=region,
    )


def _input_block(a: Article) -> str:
    parts = [f"[id] {a.id}", f"[출처] {', '.join(s.name for s in a.sources)}", f"[제목] {a.title}"]
    if a.published:
        parts.append(f"[시각] {a.published.isoformat(timespec='minutes')}")
    if a.description:
        parts.append(f"[설명] {a.description}")
    if a.excerpt:
        parts.append(f"[본문 발췌] {a.excerpt}")
    return "\n".join(parts)


def summarize_section(key: str, items: list[Article], cfg: dict, llm) -> dict:
    sec = cfg["sections"][key]
    region, label = sec["region"], sec["label"]
    if not items:
        return {"label": label, "briefing": "오늘은 이 섹션에 새 소식이 없습니다.", "items": []}
    if llm is None:
        return {"label": label, "briefing": NO_LLM_NOTE, "items": [offline_item(a, region, cfg) for a in items]}

    user = "\n\n---\n\n".join(_input_block(a) for a in items)
    try:
        out = llm.json_call(
            model=cfg["llm"]["summary_model"],
            system=_system_prompt(region, label),
            user=user,
            schema=SUMMARY_SCHEMA,
            effort=cfg["llm"].get("summary_effort", "low"),
            max_tokens=16000,
            fallback=cfg["llm"].get("summary_fallback", True),
        )
    except Exception as e:  # noqa: BLE001 — 한 섹션 실패가 전체를 멈추지 않게
        log.error("summary LLM failed for %s: %s", key, e)
        return {"label": label, "briefing": "요약 생성에 실패해 원문 정보를 표시합니다.",
                "items": [offline_item(a, region, cfg) for a in items], "error": str(e)[:300]}

    by_id = {row["id"]: row for row in out.get("items", [])}
    result_items = []
    for a in items:  # 선별 순서(중요도순) 유지
        row = by_id.get(a.id)
        if row is None:
            log.warning("summary missing for %s/%s", key, a.id)
            result_items.append(offline_item(a, region, cfg))
            continue
        result_items.append(_item_dict(a, title_ko=row["title_ko"], summary=row["summary_ko"],
                                       why=row.get("why_it_matters", ""), tags=row.get("tags", []), region=region))
    return {"label": label, "briefing": clamp_line(out.get("briefing", ""), 100), "items": result_items}


def summarize_all(chosen: dict[str, list[Article]], cfg: dict, llm) -> dict[str, dict]:
    keys = list(cfg["sections"])
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = pool.map(lambda k: summarize_section(k, chosen.get(k, []), cfg, llm), keys)
    return dict(zip(keys, results))
