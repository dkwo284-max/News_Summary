"""이민 레이더 전광판: 영주권·비자 종류별 처리 기간을 공식 페이지에서 가져온다.

1) config.yaml 의 processing_times 목록(비자별 후보 URL)을 차례로 받아 본문에서
   "90% of applications are processed within 6 months" 같은 문장을 정규식으로 찾는다.
2) 정규식으로 못 찾은 비자가 있으면 AI(Gemini) 요청 1회로 페이지 본문에서 추출한다.
3) 그래도 실패하면 어제 브리핑의 값을 '기준일'과 함께 그대로 보여준다.

    python scripts/processing.py          # 결과를 출력만 (점검용)
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx

from common import ROOT, load_config, log

UNIT_KO = {"day": "일", "week": "주", "month": "개월", "year": "년"}

PCT_RE = re.compile(
    r"(\d{1,3})\s?%\s+(?:of\s+(?:all\s+)?(?:visa\s+)?(?:applications?|decisions?)\s+(?:are\s+|were\s+|have\s+been\s+)?"
    r"(?:processed|decided|completed|finalised|finalized)\s+)?(?:with)?in\s+(\d+(?:\.\d+)?)\s+(day|week|month|year)s?",
    re.I,
)
# 비율 표기가 없을 때만: '처리 기간' 문맥이 바로 앞에 있는 기간만 인정 (비자 유효기간 등 오탐 방지)
RANGE_RE = re.compile(
    r"(?:processing\s+times?(?:\s+(?:is|are))?|(?:applications?\s+(?:are\s+)?)?currently\s+(?:taking|being\s+processed\s+in))"
    r"\s*:?\s*(?:about|around|approximately|up\s+to)?\s*"
    r"(\d+(?:\.\d+)?)\s*(?:(?:to|-|–)\s*(\d+(?:\.\d+)?)\s*)?(day|week|month|year)s?",
    re.I,
)

# INZ 대기 시간 표: "| Skilled Migrant Category Resident Visa | 9 weeks | 3.5 months |" (평균=50%, 대부분=80%)
_DUR = r"(\d+(?:\.\d+)?)\s*(day|week|month|year)s?"
# DIA 시민권: "within 6 months of submitting their application, 90% of applicants are granted citizenship"
CIT_RE = re.compile(r"within\s+" + _DUR + r"\s+of\s+submitting[^.%]*?(\d{1,3})\s?%\s+of\s+applicants\s+(?:are\s+granted|receive\s+an\s+outcome)", re.I)

EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "key": {"type": "string"},
                    "p50": {"type": "string"},
                    "p90": {"type": "string"},
                    "note": {"type": "string"},
                },
                "required": ["key", "p50", "p90", "note"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


def _fmt(value: str, unit: str) -> str:
    v = value.rstrip("0").rstrip(".") if "." in value else value
    return f"{v}{UNIT_KO[unit.lower()]}"


def parse_processing(text: str, match: str | None = None) -> dict | None:
    """페이지 본문에서 처리 기간을 찾는다. {'p50','p90','pct','sentence'} 또는 None.
    INZ 비자 페이지 형식: "Processing time 80% within 4 weeks".
    match 를 주면(여러 비자가 나오는 안내 페이지) 그 비자 이름 바로 뒤 구간만 본다."""
    flat = re.sub(r"\s+", " ", text)
    if match:
        i = flat.lower().find(match.lower())
        if i < 0:
            return None
        row = re.match(r"[^|]*\|\s*" + _DUR + r"\s*\|\s*" + _DUR, flat[i:i + 200], re.I)
        if row:  # INZ 대기 시간 표
            return {"p50": _fmt(row.group(1), row.group(2)), "p90": _fmt(row.group(3), row.group(4)), "pct": 80,
                    "sub": "", "sentence": row.group(0)[:160]}
        flat = flat[i:i + 400]
    cit = list(CIT_RE.finditer(flat))
    if cit:  # 시민권: '승인' 기간을 대표값으로, '결과 통보' 기간은 보조 문구로
        granted = next((m for m in cit if "granted" in m.group(0).lower()), cit[-1])
        outcome = next((m for m in cit if "outcome" in m.group(0).lower()), None)
        sub = f"{outcome.group(3)}%가 {_fmt(outcome.group(1), outcome.group(2))} 안에 결과 통보" if outcome else ""
        return {"p50": "", "p90": _fmt(granted.group(1), granted.group(2)), "pct": int(granted.group(3)),
                "sub": sub, "sentence": granted.group(0)[:160]}
    found: dict[int, str] = {}
    sentence = ""
    for m in PCT_RE.finditer(flat):
        pct = int(m.group(1))
        found.setdefault(pct, _fmt(m.group(2), m.group(3)))
        sentence = sentence or m.group(0)
    if found:
        top = max(found)
        p50 = found.get(50) or (found[min(found)] if min(found) != top else "")
        return {"p50": p50, "p90": found[top], "pct": top, "sub": "", "sentence": sentence[:160]}
    m = RANGE_RE.search(flat)
    if m:
        lo, hi, unit = m.group(1), m.group(2), m.group(3)
        return {"p50": _fmt(lo, unit) if hi else "", "p90": _fmt(hi or lo, unit), "pct": None, "sub": "", "sentence": m.group(0)[:160]}
    return None


def _page_text(client: httpx.Client, url: str) -> str:
    r = client.get(url)
    r.raise_for_status()
    try:
        import trafilatura

        text = trafilatura.extract(r.text, include_tables=True) or ""
    except Exception:  # noqa: BLE001
        text = ""
    if not text:
        text = re.sub(r"<[^>]+>", " ", r.text)
    return text


def _snippet(text: str, limit: int = 2500) -> str:
    """AI 입력용: 'process' 주변만 잘라 토큰 절약."""
    flat = re.sub(r"\s+", " ", text)
    i = flat.lower().find("process")
    start = max(0, i - 600) if i >= 0 else 0
    return flat[start:start + limit]


def fetch_processing_times(cfg: dict, llm=None, previous: dict | None = None, client: httpx.Client | None = None) -> dict:
    entries = cfg.get("processing_times", [])
    prev_items = {it["key"]: it for it in (previous or {}).get("items", [])}
    today = datetime.now(timezone.utc).date().isoformat()
    own_client = client is None
    client = client or httpx.Client(timeout=cfg["fetch"]["timeout_seconds"], follow_redirects=True,
                                    headers={"User-Agent": cfg["fetch"]["user_agent"]})
    items, unparsed = [], []
    try:
        for e in entries:
            item = {"key": e["key"], "name": e["name"], "group": e.get("group", ""), "p50": "", "p90": "", "pct": None,
                    "sub": "", "note": "", "url": e["urls"][0], "as_of": today, "status": "missing"}
            text_for_ai = ""
            for url in e["urls"]:
                try:
                    text = _page_text(client, url)
                except Exception as ex:  # noqa: BLE001
                    log.info("processing %s: %s → %s", e["key"], url, type(ex).__name__)
                    continue
                item["url"] = url
                # 여러 비자가 나오는 INZ 대기 시간 표(wait-times)는 비자 이름 뒤 구간, 비자 전용 페이지는 첫 처리 기간 문장
                overview = "wait-times" in url and e.get("match")
                parsed = parse_processing(text, e["match"]) if overview else parse_processing(text)
                if parsed:
                    item.update(p50=parsed["p50"], p90=parsed["p90"], pct=parsed["pct"], sub=parsed.get("sub", ""),
                                note=parsed["sentence"], status="ok")
                    break
                text_for_ai = text_for_ai or _snippet(text)
            if item["status"] != "ok" and text_for_ai:
                unparsed.append((item, text_for_ai))
            items.append(item)
    finally:
        if own_client:
            client.close()

    # 정규식으로 못 찾은 비자: AI 요청 1회로 추출
    if unparsed and llm is not None:
        user = "\n\n".join(f"[key] {it['key']}\n[visa] {it['name']}\n[page] {txt}" for it, txt in unparsed)
        system = ("뉴질랜드 이민국·내무부 페이지 발췌에서 비자 처리 기간을 추출합니다. 각 key 마다 p50(절반이 처리되는 기간)과 "
                  "p90(90%가 처리되는 기간)을 '3주', '6개월' 같은 한국어 표기로. 페이지에 없으면 빈 문자열. 숫자를 지어내지 마세요. "
                  "note 에는 근거 문장을 영어 원문 그대로 짧게.")
        try:
            out = llm.json_call(task="rank", system=system, user=user, schema=EXTRACT_SCHEMA, max_tokens=4000)
            by_key = {r["key"]: r for r in out.get("items", [])}
            for it, _ in unparsed:
                r = by_key.get(it["key"])
                if r and (r.get("p90") or r.get("p50")):
                    it.update(p50=r.get("p50", ""), p90=r.get("p90", ""), note=r.get("note", "")[:160], status="ok")
        except Exception as ex:  # noqa: BLE001
            log.warning("processing-time AI extraction failed: %s", ex)

    # 그래도 없으면 어제 값을 기준일과 함께 유지
    for it in items:
        if it["status"] != "ok" and prev_items.get(it["key"], {}).get("p90"):
            old = prev_items[it["key"]]
            it.update(p50=old.get("p50", ""), p90=old["p90"], pct=old.get("pct"), sub=old.get("sub", ""), note=old.get("note", ""), url=old.get("url", it["url"]),
                      as_of=old.get("as_of", ""), status="stale")
    ok = sum(1 for it in items if it["status"] == "ok")
    log.info("processing times: %d/%d updated today (%d stale)", ok, len(items), sum(1 for it in items if it["status"] == "stale"))
    return {"updated_at": datetime.now(timezone.utc).isoformat(timespec="minutes"), "items": items}


def load_previous(data_dir: Path) -> dict | None:
    try:
        return json.loads((data_dir / "latest.json").read_text(encoding="utf-8")).get("extras", {}).get("processing_times")
    except Exception:  # noqa: BLE001
        return None


def debug_pages(cfg: dict) -> list[dict]:
    """점검용: 각 후보 URL 의 응답 코드·최종 주소·'process' 주변 문장."""
    out = []
    with httpx.Client(timeout=cfg["fetch"]["timeout_seconds"], follow_redirects=True,
                      headers={"User-Agent": cfg["fetch"]["user_agent"]}) as client:
        for e in cfg.get("processing_times", []):
            for url in e["urls"]:
                row = {"key": e["key"], "url": url}
                try:
                    r = client.get(url)
                    row.update(status=r.status_code, final=str(r.url), length=len(r.text))
                    text = _page_text(client, url) if r.status_code < 400 else ""
                    flat = re.sub(r"\s+", " ", text)
                    row["snippets"] = [flat[max(0, m.start() - 200): m.start() + 300]
                                       for m in re.finditer(r"processing time|% within|skilled migrant|work to residence|straight to residence|grant|months|weeks", flat, re.I)][:16]
                    row["links"] = sorted(set(re.findall(r'href="([^"#]*(?:wait|processing|timeframe|how-long|time)[^"#]*)"', r.text, re.I)))[:40]
                except Exception as ex:  # noqa: BLE001
                    row["error"] = f"{type(ex).__name__}: {ex}"[:200]
                out.append(row)
    return out


if __name__ == "__main__":
    import logging

    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
    cfg = load_config()
    if "--debug" in sys.argv:
        print(json.dumps(debug_pages(cfg), ensure_ascii=False, indent=1))
        sys.exit(0)
    res = fetch_processing_times(cfg, previous=load_previous(ROOT / cfg["output"]["data_dir"]))
    print(json.dumps(res, ensure_ascii=False, indent=1))
    sys.exit(0)
