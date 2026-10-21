"""요약: 지역(kr / nz)별로 AI 를 한 번씩 호출해 한국어 제목·3줄 요약·이민자 관점·태그·섹션별 한 줄 브리핑을 만든다.

원문 본문은 요약 입력으로만 잠깐 쓰고 저장하지 않는다(저작권).
"""
from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor

import httpx

from common import Article, log

MAX_LINE = 80
NO_LLM_NOTE = "(AI 요약 없이 RSS 원문 설명을 그대로 표시)"

TAG_VOCAB = "비자, 이민, 영주권, 고용, 임금, 주거, 렌트, 금리, 물가, 환율, 교육, 의료, 치안, 날씨, 재난, 교통, 경제, 증시, 부동산, 정치, 사회, 사건사고, 연예, 방송, 스포츠, 기술"

SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "briefings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"section": {"type": "string"}, "briefing": {"type": "string"}},
                "required": ["section", "briefing"],
                "additionalProperties": False,
            },
        },
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
    "required": ["briefings", "items"],
    "additionalProperties": False,
}


def _system_prompt(region: str, sections: dict[str, str], profile: str = "") -> str:
    reader = f"독자: {profile}\n" if profile and region == "nz" else ""
    why = (
        "- why_it_matters: 이 독자에게 이 기사가 갖는 의미를 한 문장(60자 이내)으로. 비자·취업·영주권 관련이면 "
        "독자의 다음 단계(졸업 후 비자, 취업비자, 영주권 등)에 어떤 영향인지 구체적으로. 직접 관련이 적으면 "
        "오클랜드 생활·비용·안전 측면의 함의를. 추측성 단정은 피하세요."
        if region == "nz"
        else "- why_it_matters: 빈 문자열(\"\")로 두세요."
    )
    sec_list = ", ".join(f"{k}({v})" for k, v in sections.items())
    return f"""당신은 한국어 아침 뉴스 브리핑 편집자입니다. 이번 묶음의 섹션: {sec_list}.
{reader}
각 기사에 대해 다음을 작성하세요.
- title_ko: 자연스러운 한국어 제목 (영어 기사는 번역, 40자 이내, 낚시성 표현 제거)
- summary_ko: 정확히 3줄. 각 줄은 80자 이내의 완결된 문장. 핵심 사실 → 배경/수치 → 전망/영향 순서.
  [같은 이슈의 관련 기사]가 있으면 그 흐름까지 아울러 이슈 전체를 요약하세요(제목에 없는 사실은 만들지 말 것).
{why}
- tags: 1~3개. 가능하면 다음 중에서: {TAG_VOCAB}
그리고 각 섹션마다 그 섹션 기사들을 아우르는 '오늘의 한 줄 브리핑'을 60자 이내 한 문장으로 쓰세요
(briefings 배열에 section 키와 함께, 기사가 있는 섹션만).
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
    if a.radar_score:
        item["radar"] = int(a.radar_score)  # 이민 레이더 관련도 (중요 알림 판단용)
    return item


def offline_item(a: Article, region: str, cfg: dict) -> dict:
    sentences = [x for x in (_split_sentences(a.description) if a.description else []) if len(x) >= 8]
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


def _input_block(a: Article, keys: list[str]) -> str:
    parts = [f"[id] {a.id}", f"[섹션] {', '.join(keys)}", f"[출처] {', '.join(s.name for s in a.sources)}", f"[제목] {a.title}"]
    if a.published:
        parts.append(f"[시각] {a.published.isoformat(timespec='minutes')}")
    if a.description:
        parts.append(f"[설명] {a.description}")
    if a.related:
        parts.append("[같은 이슈의 관련 기사] " + " / ".join(a.related[:5]))
    if a.excerpt:
        parts.append(f"[본문 발췌] {a.excerpt}")
    return "\n".join(parts)


def _offline_sections(keys: list[str], chosen: dict[str, list[Article]], cfg: dict, briefing: str, error: str | None = None) -> dict:
    out = {}
    for k in keys:
        sec = cfg["sections"][k]
        items = chosen.get(k, [])
        out[k] = {"label": sec["label"], "briefing": briefing if items else "오늘은 이 섹션에 새 소식이 없습니다.",
                  "items": [offline_item(a, sec["region"], cfg) for a in items]}
        if error and items:
            out[k]["error"] = error
    return out


def summarize_region(region: str, keys: list[str], chosen: dict[str, list[Article]], cfg: dict, llm) -> dict[str, dict]:
    """한 지역의 여러 섹션을 AI 요청 1회로 요약한다."""
    if llm is None:
        return _offline_sections(keys, chosen, cfg, NO_LLM_NOTE)

    # 같은 기사가 여러 섹션(예: 뉴질랜드 + 이민 레이더)에 있으면 한 번만 보낸다
    unique: dict[str, tuple[Article, list[str]]] = {}
    for k in keys:
        for a in chosen.get(k, []):
            unique.setdefault(a.id, (a, []))[1].append(k)
    if not unique:
        return _offline_sections(keys, chosen, cfg, "")

    labels = {k: cfg["sections"][k]["label"] for k in keys}
    user = "\n\n---\n\n".join(_input_block(a, ks) for a, ks in unique.values())
    try:
        out = llm.json_call(task="summary", system=_system_prompt(region, labels, cfg.get("profile", {}).get("summary", "")), user=user,
                            schema=SUMMARY_SCHEMA, max_tokens=32000)
    except Exception as e:  # noqa: BLE001 — 실패해도 원문 정보로 페이지는 생성
        log.error("summary AI failed for %s: %s", region, e)
        return _offline_sections(keys, chosen, cfg, "요약 생성에 실패해 원문 정보를 표시합니다.", str(e)[:300])

    rows = {row.get("id"): row for row in out.get("items", [])}
    briefings = {b.get("section"): b.get("briefing", "") for b in out.get("briefings", [])}
    result = {}
    for k in keys:
        sec_region = cfg["sections"][k]["region"]
        items = []
        for a in chosen.get(k, []):  # 선별 순서(중요도순) 유지
            row = rows.get(a.id)
            if row is None:
                log.warning("summary missing for %s/%s", k, a.id)
                items.append(offline_item(a, sec_region, cfg))
                continue
            items.append(_item_dict(a, title_ko=row.get("title_ko", ""), summary=row.get("summary_ko", []),
                                    why=row.get("why_it_matters", ""), tags=row.get("tags", []), region=sec_region))
        briefing = clamp_line(briefings.get(k, ""), 100) if items else "오늘은 이 섹션에 새 소식이 없습니다."
        result[k] = {"label": labels[k], "briefing": briefing, "items": items}
    return result


def summarize_all(chosen: dict[str, list[Article]], cfg: dict, llm) -> dict[str, dict]:
    by_region: dict[str, list[str]] = {}
    for k, sec in cfg["sections"].items():
        if sec.get("pool"):  # 묶음 섹션은 출력하지 않음 (카테고리 섹션으로 나뉨)
            continue
        by_region.setdefault(sec["region"], []).append(k)
    result: dict[str, dict] = {}
    for region, keys in by_region.items():  # 순차 실행: 무료 등급 분당 한도 보호
        result.update(summarize_region(region, keys, chosen, cfg, llm))
    return {k: result[k] for k in cfg["sections"] if k in result}
