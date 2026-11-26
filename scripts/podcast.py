"""🎧 오늘의 오클랜드·뉴질랜드 5분 브리핑 대본(1인 앵커).

오클랜드 탭(akl_*)과 뉴질랜드 탭(nz_* 중 이민 레이더 제외)에서 오늘 새 기사만 중요도·생활 영향 순으로 골라
AI 가 라디오 앵커 말투의 한국어 대본을 쓴다(AI 요청 1회). 화면은 이 대본을 폰 내장 음성으로 읽는다.
AI 가 없거나 실패하면 기사 요약으로 대본을 만든다(source="template"). 브리핑 생성은 절대 막지 않는다.
"""
from __future__ import annotations

from datetime import date

from common import log

N_AKL, N_NZ = 4, 4
LEVEL = {"high": 3, "medium": 2, "low": 1, "none": 0}

SCHEMA = {
    "type": "object",
    "properties": {
        "intro": {"type": "string"},
        "segments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "title": {"type": "string"}, "text": {"type": "string"}},
                "required": ["id", "title", "text"],
                "additionalProperties": False,
            },
        },
        "outro": {"type": "string"},
    },
    "required": ["intro", "segments", "outro"],
    "additionalProperties": False,
}

SYSTEM = """당신은 오클랜드에 사는 한국인 가족을 위한 아침 라디오 뉴스 앵커입니다. 주어진 기사만으로 5분 분량의 1인 브리핑 대본을 한국어로 씁니다.
규칙:
- 말로 듣기 좋은 구어체 존댓말(~합니다/~예요 섞어서 자연스럽게). 짧은 문장, 한 문장에 정보 하나.
- 기사에 없는 사실·숫자·추측을 더하지 마세요. 숫자는 듣기 쉽게(예: 3.25% → 3.25퍼센트, NZ$1.2m → 120만 뉴질랜드 달러).
- 영어 고유명사는 한국어로 읽히게(예: Auckland Transport → 오클랜드 교통공사, Te Whatu Ora → 뉴질랜드 보건청). 괄호·이모지·URL 금지.
- intro: 날짜와 함께 오늘 다룰 내용을 한두 문장으로 예고(예: "11월 26일 목요일, 오클랜드와 뉴질랜드 소식입니다. 오늘은 …").
- segments: 주어진 순서대로(오클랜드 먼저, 그다음 뉴질랜드) 기사마다 하나. title 은 화면 목록용 짧은 제목(20자 이내).
  text 는 150~230자: 무슨 일인지 → 왜 중요한지/우리 생활에 무슨 영향인지(주어진 '생활 영향'이 있으면 반영) 한 문장.
  지역이 바뀌는 첫 소식에는 "이어서 뉴질랜드 전국 소식입니다" 같은 짧은 연결 말을 앞에 붙이세요.
- outro: 한두 문장으로 마무리(예: "오늘 브리핑은 여기까지입니다. 좋은 하루 보내세요.").
- 전체 1,400~1,800자."""

WEEKDAY = "월화수목금토일"


def pick_items(sections: dict, cfg: dict) -> list[dict]:
    """오클랜드 4 + 뉴질랜드 4 (오늘 새 기사, 중요도·생활 영향 순, 같은 기사 중복 제외)"""
    def cands(prefix: str) -> list[tuple[float, str, dict]]:
        out = []
        for key, sec in sections.items():
            if not key.startswith(prefix) or key == "nz_immigration" or key in ("nz_national", "nz_auckland"):
                continue
            label = cfg["sections"].get(key, {}).get("label", "")
            for it in sec.get("items", []):
                if it.get("carried_from"):
                    continue
                lv = LEVEL.get((it.get("impact") or {}).get("level", "none"), 0)
                out.append((it.get("importance", 5) + lv * 1.5, label, it))
        out.sort(key=lambda x: -x[0])
        return out

    chosen, seen = [], set()
    for prefix, n, region in (("akl_", N_AKL, "akl"), ("nz_", N_NZ, "nz")):
        k = 0
        for _, label, it in cands(prefix):
            if it["id"] in seen or k >= n:
                continue
            seen.add(it["id"]); k += 1
            chosen.append({"id": it["id"], "region": region, "label": label, "item": it})
    return chosen


def _speakable(s: str) -> str:
    return " ".join(str(s or "").replace("·", ", ").split())


def template(picked: list[dict], day: str) -> dict:
    d = date.fromisoformat(day)
    head = f"{d.month}월 {d.day}일 {WEEKDAY[d.weekday()]}요일"
    segs, prev = [], None
    for p in picked:
        it = p["item"]
        lead = "" if p["region"] == prev else ("먼저 오클랜드 소식입니다. " if p["region"] == "akl" else "이어서 뉴질랜드 전국 소식입니다. ")
        prev = p["region"]
        body = " ".join((it.get("summary_ko") or [])[:2])
        reason = (it.get("impact") or {}).get("reason", "")
        segs.append({"id": p["id"], "region": p["region"], "title": it.get("title_ko", "")[:40],
                     "text": _speakable(f"{lead}{it.get('title_ko', '')}. {body}{' ' + reason if reason and (it.get('impact') or {}).get('level') in ('high', 'medium') else ''}")})
    return {"intro": f"{head}, 오늘의 오클랜드와 뉴질랜드 주요 소식입니다.", "segments": segs,
            "outro": "오늘 브리핑은 여기까지입니다. 좋은 하루 보내세요.", "source": "template"}


def build_podcast(sections: dict, cfg: dict, llm, day: str) -> dict | None:
    picked = pick_items(sections, cfg)
    if not picked:
        return None
    base = template(picked, day)
    out = {"date": day, "title": f"{date.fromisoformat(day).month}월 {date.fromisoformat(day).day}일 오클랜드·뉴질랜드 브리핑", **base}
    if llm is None:
        return out
    d = date.fromisoformat(day)
    lines = [f"오늘: {d.year}년 {d.month}월 {d.day}일 {WEEKDAY[d.weekday()]}요일"]
    for p in picked:
        it = p["item"]; imp = it.get("impact") or {}
        lines.append(f"[{p['id']}] ({'오클랜드' if p['region'] == 'akl' else '뉴질랜드'}·{p['label']}) {it.get('title_ko', '')}\n"
                     f"  요약: {' '.join(it.get('summary_ko') or [])}\n"
                     f"  이민자 관점: {it.get('why_it_matters', '')}\n"
                     f"  생활 영향({imp.get('level', 'none')}): {imp.get('reason', '')}")
    try:
        r = llm.json_call(task="summary", system=SYSTEM, user="\n".join(lines), schema=SCHEMA, max_tokens=6000)
        by = {p["id"]: p for p in picked}
        segs = [{"id": s["id"], "region": by[s["id"]]["region"], "title": s["title"].strip()[:40], "text": _speakable(s["text"])}
                for s in r.get("segments", []) if s.get("id") in by and s.get("text", "").strip()]
        if len(segs) < max(3, len(picked) // 2) or not r.get("intro", "").strip():
            raise ValueError(f"script too short ({len(segs)} segments)")
        # AI 가 빠뜨린 기사는 요약으로 채워 순서 유지
        have = {s["id"] for s in segs}
        for s in base["segments"]:
            if s["id"] not in have:
                segs.append(s)
        order = {p["id"]: i for i, p in enumerate(picked)}
        segs.sort(key=lambda s: order[s["id"]])
        out.update({"intro": _speakable(r["intro"]), "segments": segs, "outro": _speakable(r.get("outro") or base["outro"]), "source": "ai"})
    except Exception as e:  # noqa: BLE001 — 대본 실패가 브리핑을 막지 않게
        log.warning("podcast script failed (template used): %s", e)
    return out
