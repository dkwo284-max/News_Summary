"""치안 지도: 오클랜드 기사에서 뽑은 사건(위치·등급)을 좌표와 함께 지난 keep_days 일치 쌓는다 (web/public/data/incidents.json).

- 등급: "1"(살인·흉기·총기·성범죄·납치·마약) / "2"(강도·폭행·램레이드·차량 탈취·방화) / "3"(절도·파손·사기) / "accident"(사고)
- 위치·등급은 insight.py 가 인사이트 요청 안에서 함께 뽑는다(추가 요청 없음).
- 파일이 처음 만들어질 때만 지난 브리핑의 오클랜드 사건 기사를 AI 요청 1회로 한꺼번에 뽑아 채운다(빈 지도 방지).
- 좌표는 OpenStreetMap Nominatim (초당 1회). 찾은 장소는 geocache 에 남겨 다시 묻지 않는다.
- 뉴스에 보도된 사건만이라 실제 범죄 빈도와 다를 수 있다 → 공식 통계는 crime_stats.py.
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import httpx

from common import log
from korean_gp import geocode

INCIDENTS_FILE = "incidents.json"
SEVERITIES = ("1", "2", "3", "accident")

BACKFILL_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {k: {"type": "string"} for k in ("id", "severity", "crime", "location", "suburb")},
                "required": ["id", "severity", "crime", "location", "suburb"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}

BACKFILL_SYSTEM = """오클랜드 뉴스 목록에서 실제로 일어난 범죄·사건사고의 위치와 등급을 뽑습니다. 각 id 마다:
- severity: "1"(살인·살인미수, 흉기·총기 공격, 성범죄, 납치, 마약 제조·밀수·거래·대량 압수) / "2"(강도, 폭행, 램레이드, 차량 탈취, 방화) /
  "3"(절도, 침입 절도, 기물 파손, 사기) / "accident"(교통사고·화재·실종 등 범죄 아닌 사고). 사건이 아니거나 위치를 모르면 "".
- crime: 사건 종류를 한국어로 짧게. location: 가장 구체적인 장소(영어). suburb: 오클랜드 동네 이름 하나(영어). 아니면 "".
주어진 정보에 없는 위치는 지어내지 마세요. 모든 id 에 대해 한 번씩 반환하세요."""


def _load(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _entry(it: dict, day: str, inc: dict) -> dict:
    return {"id": it["id"], "date": day, "title_ko": it["title_ko"],
            "url": (it.get("sources") or [{}])[0].get("url", ""),
            "severity": inc["severity"], "crime": inc.get("crime", ""),
            "location": inc["location"], "suburb": inc.get("suburb", "")}


def _past_akl_items(data_dir: Path, today: str, days: int) -> list[tuple[str, dict]]:
    t = date.fromisoformat(today)
    out, seen = [], set()
    for back in range(days, 0, -1):
        d = (t - timedelta(days=back)).isoformat()
        b = _load(data_dir / f"{d}.json")
        for key, sec in b.get("sections", {}).items():
            if key != "nz_auckland" and not key.startswith("akl_"):
                continue
            for it in sec.get("items", []):
                if it.get("carried_from") or it["id"] in seen:
                    continue
                seen.add(it["id"])
                out.append((d, it))
    return out


def backfill(data_dir: Path, today: str, llm, days: int = 30, cfg: dict | None = None) -> list[dict]:
    """지난 브리핑의 오클랜드 기사에서 사건을 한꺼번에 뽑는다 (AI 요청 1회). 치안 키워드가 있는 기사만 보낸다."""
    from rank import _kw_hits

    kws = (cfg or {}).get("akl_topics", {}).get("safety", [])
    items = [(d, it) for d, it in _past_akl_items(data_dir, today, days)
             if not kws or _kw_hits(f"{it.get('original_title', '')} {it['title_ko']}", kws)
             or any(t in ("치안", "사건사고") for t in it.get("tags", []))][-60:]
    if llm is None or not items:
        return []
    user = "\n".join(f"[{it['id']}] {it.get('original_title') or ''} | {it['title_ko']} | {' '.join(it.get('summary_ko', []))}"
                     for _, it in items)
    try:
        out = llm.json_call(task="rank", system=BACKFILL_SYSTEM, user=user, schema=BACKFILL_SCHEMA, max_tokens=16000)
    except Exception as e:  # noqa: BLE001
        log.warning("incident backfill failed: %s", e)
        return []
    rows = {r.get("id"): r for r in out.get("items", [])}
    found = []
    for d, it in items:
        r = rows.get(it["id"]) or {}
        sev = (r.get("severity") or "").strip().lower()
        if sev in SEVERITIES and (r.get("location") or "").strip():
            found.append(_entry(it, d, {"severity": sev, "crime": r.get("crime", "")[:30],
                                        "location": r["location"][:100], "suburb": r.get("suburb", "")[:40]}))
    log.info("incident backfill: %d of %d past items", len(found), len(items))
    return found


def update_incidents(sections: dict, cfg: dict, data_dir: Path, today: str, llm=None,
                     client: httpx.Client | None = None) -> int:
    icfg = cfg.get("incidents", {})
    keep = int(icfg.get("keep_days", 90))
    path = data_dir / INCIDENTS_FILE
    old = _load(path)
    entries = {e["id"]: e for e in old.get("incidents", [])}
    if not old:
        for e in backfill(data_dir, today, llm, int(icfg.get("backfill_days", 30)), cfg):
            entries.setdefault(e["id"], e)
    for sec in sections.values():
        for it in sec.get("items", []):
            inc = it.get("incident")
            if inc and not it.get("carried_from") and it["id"] not in entries:
                entries[it["id"]] = _entry(it, today, inc)
    cutoff = (date.fromisoformat(today) - timedelta(days=keep)).isoformat()
    entries = {k: e for k, e in entries.items() if e["date"] >= cutoff}
    cache: dict[str, list[float] | None] = dict(old.get("geocache", {}))
    own = client is None
    client = client or httpx.Client(timeout=30, follow_redirects=True, headers={"User-Agent": cfg["fetch"]["user_agent"]})
    try:
        for e in entries.values():
            if e.get("latlon"):
                continue
            for q in (e["location"], e["suburb"]):
                if not q:
                    continue
                if q not in cache:
                    try:
                        cache[q] = geocode(client, f"{q}, Auckland, New Zealand")
                    except Exception as ex:  # noqa: BLE001
                        log.warning("geocode %s failed: %s", q, ex)
                        break
                if cache.get(q):
                    e["latlon"] = cache[q]
                    break
    finally:
        if own:
            client.close()
    data = {"updated_at": today, "keep_days": keep,
            "incidents": sorted(entries.values(), key=lambda e: e["date"], reverse=True), "geocache": cache}
    data_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    log.info("incidents: %d stored (%d located)", len(entries), sum(1 for e in entries.values() if e.get("latlon")))
    return len(entries)
