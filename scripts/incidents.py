"""치안 지도: 오클랜드 기사에서 뽑은 사건(위치·등급)을 좌표와 함께 지난 keep_days 일치 쌓는다 (web/public/data/incidents.json).

- 등급: "1"(살인·흉기·총기·성범죄·납치·마약) / "2"(강도·폭행·램레이드·차량 탈취·방화) / "3"(절도·파손·사기) / "accident"(사고)
- 위치·등급은 insight.py 가 인사이트 요청 안에서 함께 뽑는다(추가 요청 없음).
- 파일이 처음 만들어질 때만 지난 브리핑의 오클랜드 사건 기사를 AI 요청 1회로 한꺼번에 뽑아 채운다(빈 지도 방지).
- 좌표는 OpenStreetMap Nominatim (초당 1회). 찾은 장소는 geocache 에 남겨 다시 묻지 않는다.
- 뉴스에 보도된 사건만이라 실제 범죄 빈도와 다를 수 있다 → 공식 통계는 crime_stats.py.
"""
from __future__ import annotations

import json
import re
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
주어진 정보에 없는 위치는 지어내지 마세요. 구체적 장소가 없으면 "Auckland" 같은 넓은 지역 대신 location·suburb 를 "" 로 두세요. 모든 id 에 대해 한 번씩 반환하세요."""


# 지도에 찍을 수 없는 '넓은 지역' 표기: 기사에 구체적 장소가 없을 때 AI 가 "Auckland" 같은 말만 채우면
# 지오코더가 도심 좌표를 돌려줘서 모든 사건이 Auckland Central 에 몰려 보였다 → 이런 표기는 위치 없음으로 둔다.
_VAGUE_WORDS = {"auckland", "city", "region", "greater", "central", "north", "south", "east", "west", "northern", "southern", "eastern", "western",
                "counties", "tamaki", "makaurau", "nz", "new", "zealand", "the", "street", "road", "school", "area", "shopping", "centre", "center",
                "container", "terminal", "suburb", "town", "local", "near", "a", "an", "unknown", "somewhere", "region"}
_CHAINS = {"burgerfuel", "mcdonald", "mcdonalds", "kfc", "countdown", "woolworths", "paknsave", "pak", "new", "world", "warehouse", "bunnings", "subway"}
_REGION_TAIL = re.compile(r"^(?:(?:north|south|east|west|central|greater) )?auckland(?: city| region)?$|^counties manukau$")


def vague_place(q: str) -> bool:
    """위치 문구가 '오클랜드 어딘가' 수준이라 좌표를 찍으면 안 되는가 (예: "Auckland", "South Auckland", "East Auckland shopping centre")."""
    parts = [p.strip() for p in (q or "").lower().split(",") if p.strip()]
    if not parts:
        return True
    head = re.findall(r"[a-zāēīōū']+", parts[0].replace("'", ""))
    if not head or all(w in _VAGUE_WORDS for w in head) or parts[0] == "counties manukau":
        return True
    # 체인 매장 이름 + 넓은 지역("BurgerFuel, South Auckland")은 어느 지점인지 알 수 없다
    return len(parts) >= 2 and bool(_REGION_TAIL.match(parts[-1])) and all(w in _CHAINS | _VAGUE_WORDS for w in head)


def geo_queries(location: str, suburb: str) -> list[str]:
    """지오코딩에 쓸 수 있는 검색어(구체적인 것만). 위치가 넓은 지역뿐이면 동네 이름도 추측일 수 있어 도심("Auckland Central")은 쓰지 않는다."""
    loc = (location or "").strip()
    sub = (suburb or "").strip()
    qs = []
    if loc and not vague_place(loc):
        qs.append(loc)
    if sub and not vague_place(sub) and (qs or sub.lower() != "auckland central"):
        qs.append(sub)
    return qs


# ── 위치 검증: AI 가 뽑은 장소가 기사 원문에 실제로 있는지 글자로 대조한다 ──
# "Auckland street" 를 "Auckland CBD" 로 옮기는 식의 추측을 막기 위해서다. 원문에 없으면 그 장소는 버린다.
REGIONS = {  # 넓은 권역: (원문에서 찾을 표현, 한국어 이름, 요약문에서 찾을 한국어 표현)
    "central": (r"\bcbd\b|central city|city cent(?:re|er)|downtown|central auckland|inner[- ]city|auckland central|queen street|karangahape|\bk[' ]?road\b|britomart|viaduct|wynyard|myers park|aotea|albert park|sky ?tower|skycity", "도심", "도심"),
    "west": (r"\bwest(?:ern)? auckland\b|\bwaitakere\b", "서부", "서부"),
    "south": (r"\bsouth(?:ern)? auckland\b|counties manukau", "남부", "남부"),
    "east": (r"\beast(?:ern)? auckland\b", "동부", "동부"),
    "north": (r"north shore|\bnorth(?:ern)? auckland\b", "북부", "북부|노스쇼어"),
}
_PLACE_TYPES = {"street", "st", "road", "rd", "avenue", "ave", "drive", "dr", "lane", "place", "pl", "crescent", "terrace", "way", "highway", "motorway",
                "park", "reserve", "beach", "bay", "mall", "plaza", "station", "school", "college", "university", "court", "bridge", "airport", "hospital",
                "terminal", "wharf", "centre", "center", "harbour", "hotel", "island", "library", "stadium", "domain", "square", "market", "cbd"}
PRECISION = ("exact", "suburb", "region", "none")


def _norm(s: str) -> str:
    import unicodedata

    return "".join(c for c in unicodedata.normalize("NFKD", (s or "").lower()) if not unicodedata.combining(c)).replace("’", "'")


def grounded(name: str, src: str) -> bool:
    """장소 이름의 고유한 낱말이 모두 원문(제목·설명·본문 발췌)에 있는가. 고유 낱말이 없으면("Auckland Airport") 이름 전체가 있어야 한다."""
    head, text = _norm(name).split(",")[0].strip(), _norm(src)
    if not head or not text:
        return False
    toks = [w for w in re.findall(r"[a-z']+", head.replace("'", "")) if len(w) >= 3 and w not in _VAGUE_WORDS and w not in _PLACE_TYPES]
    flat = text.replace("'", "")
    if toks:
        return all(re.search(rf"\b{re.escape(w)}", flat) for w in toks)
    return head in text or (head.endswith("cbd") and bool(re.search(REGIONS["central"][0], text)))


def region_of(src: str) -> str:
    text = _norm(src)
    return next((k for k, (pat, _, _) in REGIONS.items() if re.search(pat, text)), "")


def verify_place(inc: dict, src: str) -> dict:
    """AI 가 뽑은 위치를 원문과 대조해 확실도를 붙인다.
    exact = 거리·건물·공원까지 원문에 있음 / suburb = 동네 이름만 원문에 있음 / region = 서부·남부 같은 권역만 / none = 원문에 장소 없음."""
    loc, sub = (inc.get("location") or "").strip(), (inc.get("suburb") or "").strip()
    head = loc.split(",")[0].strip()
    out = {**inc, "region": region_of(src)}
    if loc and not vague_place(loc) and grounded(head, src):
        specific = bool(re.search(r"\d", head)) or any(w in _PLACE_TYPES - {"cbd"} for w in re.findall(r"[a-z]+", _norm(head)))
        return {**out, "precision": "exact" if specific else "suburb"}
    if sub and not vague_place(sub) and grounded(sub, src):
        return {**out, "location": sub, "precision": "suburb"}
    return {**out, "location": "", "suburb": "", "precision": "region" if out["region"] else "none"}


def fix_region_words(item: dict, src: str) -> bool:
    """요약·제목의 '오클랜드 도심/서부/남부…'가 원문에 근거가 없으면 '오클랜드'로 되돌린다 (원문은 "Auckland street" 인데 요약이 "도심 거리"가 되는 것 방지)."""
    if not (src or "").strip():
        return False
    text = _norm(src)
    bad = [ko for pat, _, ko in REGIONS.values() if not re.search(pat, text)]
    if not bad:
        return False
    rx = re.compile(rf"오클랜드\s*(?:{'|'.join(bad)})(?=\s|의|에|에서|$)")
    changed = False
    def fix(s: str) -> str:
        nonlocal changed
        t = rx.sub("오클랜드", s)
        changed = changed or t != s
        return t
    item["title_ko"] = fix(item.get("title_ko", ""))
    item["summary_ko"] = [fix(x) for x in item.get("summary_ko", [])]
    return changed


def legacy_precision(e: dict) -> str:
    """원문 대조 없이 쌓인 예전 기록의 확실도 (문구 모양으로만 판단)."""
    loc = e.get("location") or ""
    if not geo_queries(loc, e.get("suburb") or ""):
        return "region" if region_of(loc) else "none"
    if vague_place(loc):
        return "suburb"
    head = _norm(loc).split(",")[0]
    return "exact" if re.search(r"\d", head) or any(w in _PLACE_TYPES - {"cbd"} for w in re.findall(r"[a-z]+", head)) else "suburb"


def follow_up_places(entries: dict[str, dict], days: int = 7) -> int:
    """위치를 모르던 사건의 후속 보도에 구체적 장소가 나오면 그 장소로 채운다 (같은 등급, days 일 안, 제목 핵심어 3개 이상 겹침)."""
    from weekly import _keys

    known = [e for e in entries.values() if e.get("precision") in ("exact", "suburb")]
    n = 0
    for e in entries.values():
        if e.get("precision") in ("exact", "suburb"):
            continue
        ke = _keys(e.get("title_ko", ""))
        for o in sorted(known, key=lambda o: o.get("precision") != "exact"):
            gap = abs((date.fromisoformat(o["date"]) - date.fromisoformat(e["date"])).days)
            if o["severity"] == e["severity"] and gap <= days and len(ke & _keys(o.get("title_ko", ""))) >= 3:
                e.update({k: o[k] for k in ("location", "suburb", "precision") if k in o})
                if o.get("latlon"):
                    e["latlon"] = o["latlon"]
                e["place_from"] = o["id"]
                n += 1
                break
    return n


def _load(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _entry(it: dict, day: str, inc: dict) -> dict:
    return {"id": it["id"], "date": day, "title_ko": it["title_ko"],
            "url": (it.get("sources") or [{}])[0].get("url", ""),
            "summary": (it.get("summary_ko") or [""])[0][:120],
            "severity": inc["severity"], "crime": inc.get("crime", ""),
            "location": inc.get("location", ""), "suburb": inc.get("suburb", ""),
            **({"precision": inc["precision"], "region": inc.get("region", "")} if inc.get("precision") in PRECISION else {})}


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
    # 지도 팝업용 한 줄 설명이 없는 예전 항목은 그날 브리핑에서 채운다
    for e in entries.values():
        if not e.get("summary"):
            b = _load(data_dir / f"{e['date']}.json")
            it = next((x for sec in b.get("sections", {}).values() for x in sec.get("items", []) if x["id"] == e["id"]), None)
            if it:
                e["summary"] = (it.get("summary_ko") or [""])[0][:120]
    for e in entries.values():  # 예전 기록에는 확실도가 없다 → 문구로 추정해 채운다
        if e.get("precision") not in PRECISION:
            e["precision"] = legacy_precision(e)
            e.setdefault("region", region_of(e.get("location") or ""))
    follow_up_places(entries)
    cache: dict[str, list[float] | None] = dict(old.get("geocache", {}))
    own = client is None
    client = client or httpx.Client(timeout=30, follow_redirects=True, headers={"User-Agent": cfg["fetch"]["user_agent"]})
    try:
        for e in entries.values():
            qs = geo_queries(e["location"], e["suburb"]) if e.get("precision") in ("exact", "suburb") else []
            if not qs:  # 구체적인 장소가 없다 → 예전에 도심 좌표로 잘못 찍힌 것도 지운다
                e.pop("latlon", None)
                if vague_place(e["location"]) and e.get("suburb", "").lower() in ("auckland central", "auckland"):
                    e["suburb"] = ""
                continue
            if e.get("latlon") and vague_place(e["location"]):
                e.pop("latlon")  # 예전에 넓은 지역 문구로 찍힌 좌표 — 동네 이름으로 다시 찾는다
            if e.get("latlon"):
                continue
            for q in qs:
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
