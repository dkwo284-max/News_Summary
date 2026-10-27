"""미리 만든 Q&A: 요약이 끝난 뒤 주요 기사마다 독자가 물어볼 만한 질문과 답을 AI 요청 1회로 만든다.

- 대상: 이민 레이더 기사 전부 → 나머지는 중요도순으로 qa.max_items 건까지 (config.yaml 의 qa)
- 답은 기사 요약·본문 발췌 안의 정보로만. 기사에 없는 내용은 "기사에는 나오지 않아요"라고 하고 확인할 곳을 안내.
- 실패해도 브리핑은 Q&A 없이 그대로 생성된다.
"""
from __future__ import annotations

from common import Article, log

QA_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "qa": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"q": {"type": "string"}, "a": {"type": "string"}},
                            "required": ["q", "a"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["id", "qa"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


def _system(cfg: dict, per_item: int) -> str:
    profile = cfg.get("profile", {}).get("summary", "")
    return f"""당신은 뉴스 해설 기자입니다. 각 기사마다 독자가 가장 궁금해할 질문 {per_item}개와 답을 한국어로 만듭니다.
독자: {profile} (뉴질랜드 기사 기준. 한국 기사는 일반 한국인 독자 기준)
- 질문: 짧고 구체적으로(40자 이내). 예) "무엇이 바뀌나요?", "언제부터 적용되나요?", "누가 영향을 받나요?",
  뉴질랜드 이민·비자 기사면 "졸업 후 취업비자(PSWV)·영주권 준비에 영향이 있나요?"처럼 독자 상황에 맞춘 질문을 1개 이상.
- 답: 2~3문장(150자 이내). 주어진 [요약]·[이민자 관점]·[본문 발췌]·[원문 제목] 안의 정보로만 답하세요.
  기사에 없는 내용은 지어내지 말고 "기사에는 나오지 않아요."라고 쓴 뒤 확인할 곳(예: INZ 공식 안내, 해당 기관)을 짧게 안내.
- 수치·날짜·기관명은 기사에 있는 그대로. 추측성 단정, 투자·법률 조언 단정은 피하세요.
- 같은 내용을 반복하는 질문은 만들지 마세요. 모든 id 에 대해 정확히 한 번씩 반환하세요."""


def _block(item: dict, label: str, art: Article | None) -> str:
    parts = [f"[id] {item['id']}", f"[섹션] {label}", f"[제목] {item['title_ko']}"]
    if item.get("original_title") and item["original_title"] != item["title_ko"]:
        parts.append(f"[원문 제목] {item['original_title']}")
    parts.append("[요약] " + " / ".join(item.get("summary_ko", [])))
    if item.get("why_it_matters"):
        parts.append(f"[이민자 관점] {item['why_it_matters']}")
    if art is not None and art.excerpt:
        parts.append(f"[본문 발췌] {art.excerpt}")
    return "\n".join(parts)


def pick_targets(sections: dict, cfg: dict) -> list[tuple[str, dict]]:
    """(섹션 키, 기사) 목록. 이민 레이더 먼저, 나머지는 중요도순. 같은 기사는 한 번만."""
    qcfg = cfg.get("qa", {})
    limit = int(qcfg.get("max_items", 16))
    min_imp = int(qcfg.get("min_importance", 6))
    skip = set(qcfg.get("skip_sections", []))
    first = [("nz_immigration", it) for it in sections.get("nz_immigration", {}).get("items", [])]
    rest = [(k, it) for k, sec in sections.items() if k != "nz_immigration" and k not in skip
            for it in sec.get("items", []) if it.get("importance", 0) >= min_imp]
    rest.sort(key=lambda x: x[1].get("importance", 0), reverse=True)
    out, seen = [], set()
    for k, it in first + rest:
        if it.get("carried_from") or it["id"] in seen:
            continue
        seen.add(it["id"])
        out.append((k, it))
        if len(out) >= limit:
            break
    return out


def attach_qa(sections: dict, chosen: dict[str, list[Article]], cfg: dict, llm) -> int:
    """sections 의 기사 dict 에 qa: [{q, a}] 를 붙인다. 붙인 기사 수를 돌려준다."""
    qcfg = cfg.get("qa", {})
    if llm is None or not qcfg.get("enabled", True):
        return 0
    targets = pick_targets(sections, cfg)
    if not targets:
        return 0
    per_item = int(qcfg.get("per_item", 3))
    arts = {a.id: a for items in chosen.values() for a in items}
    user = "\n\n---\n\n".join(_block(it, sections[k]["label"], arts.get(it["id"])) for k, it in targets)
    try:
        out = llm.json_call(task="summary", system=_system(cfg, per_item), user=user, schema=QA_SCHEMA, max_tokens=24000)
    except Exception as e:  # noqa: BLE001 — Q&A 실패가 브리핑 생성을 막지 않게
        log.warning("Q&A AI failed: %s", e)
        return 0
    by_id = {}
    for row in out.get("items", []):
        qa = [{"q": x["q"].strip()[:80], "a": x["a"].strip()[:300]} for x in row.get("qa", [])
              if x.get("q", "").strip() and x.get("a", "").strip()][:per_item]
        if qa:
            by_id[row.get("id")] = qa
    n = 0
    for sec in sections.values():
        for it in sec.get("items", []):
            if it["id"] in by_id and not it.get("carried_from"):
                it["qa"] = by_id[it["id"]]
                n += 1
    log.info("Q&A attached to %d/%d item(s)", n, len(targets))
    return n
