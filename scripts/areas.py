"""동네 비교 데이터: 후보 동네별 시세 렌트(Tenancy Services)와 옛 시 단위 평균 집값(QV). 키·요금 없음, AI 요청 없음.

- 렌트: Tenancy Services 'Market rent' 검색 결과(최근 6개월 보증금 신고 기준, 주택·아파트·플랫 × 방 수별 중간값)
- 집값: QV House Price Index 페이지의 지역 설명(옛 North Shore City·Auckland City 등 단위 평균 가치)
- 결과는 web/public/data/areas.json 에 저장하고, refresh_days 가 지나야 다시 받는다(렌트 자료는 매달 갱신).
- 어떤 동네를 볼지는 앱 설정(이 기기에만 저장)에서 고르므로, 여기 목록은 흔히 찾는 동네를 넉넉히 둔다.

    python scripts/areas.py Milford Takapuna    # 점검용: 해당 동네만 받아서 출력
"""
from __future__ import annotations

import json
import re
import sys
import time
from datetime import date, datetime
from pathlib import Path

import httpx

from common import load_config, log

RENT_URL = "https://www.tenancy.govt.nz/rent-bond-and-bills/market-rent/"
QV_URL = "https://www.qv.co.nz/price-index/"
AREAS_FILE = "areas.json"

# config 의 district 키 → QV 페이지의 지역 이름 (오클랜드 통합 전 옛 시 단위)
QV_DISTRICTS = {
    "north_shore": "NORTH SHORE CITY",
    "auckland_city": "AUCKLAND CITY",
    "manukau": "MANUKAU CITY",
    "waitakere": "WAITAKERE CITY",
    "rodney": "RODNEY DISTRICT",
    "papakura": "PAPAKURA DISTRICT",
    "franklin": "FRANKLIN DISTRICT",
}

_TYPE_RE = re.compile(r"(Apartment|Flat|House|Room|Boarding house) Size Active bonds Lower Quartile Median Rent Upper Quartile")
_ROW_RE = re.compile(r"(\d\+?) bedrooms? (\d+) \$(\d+) \$(\d+) \$(\d+)")
_TOTAL_RE = re.compile(r"Bonds (\d+) Lower \(\$\) (\d+) Median \(\$\) (\d+) Upper \(\$\) (\d+)")
_PERIOD_RE = re.compile(r"(\d{2} \w{3} \d{4}) - (\d{2} \w{3} \d{4})")


def _text(html: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).replace("&amp;", "&")


def parse_market_rent(html: str, suburb: str) -> dict | None:
    """검색 결과 페이지 → {period, all, house: {"3": {...}}, apartment, flat}. 다른 동네 결과면 None."""
    t = _text(html)
    head = t.find(f"Auckland - {suburb} ")
    if head < 0:
        return None
    t = t[head:]
    out: dict = {}
    p = _PERIOD_RE.search(t)
    if p:
        out["period"] = f"{datetime.strptime(p.group(1), '%d %b %Y'):%Y-%m}~{datetime.strptime(p.group(2), '%d %b %Y'):%Y-%m}"
    parts = _TYPE_RE.split(t)
    # split 결과: [앞부분, 유형1, 내용1, 유형2, 내용2, ...]
    for kind, body in zip(parts[1::2], parts[2::2]):
        body = body.split("This data is updated")[0]
        rows = {m.group(1): {"bonds": int(m.group(2)), "lower": int(m.group(3)), "median": int(m.group(4)), "upper": int(m.group(5))}
                for m in _ROW_RE.finditer(body)}
        if rows:
            out[kind.lower().replace(" ", "_")] = rows
    if not any(k in out for k in ("house", "apartment", "flat")):
        return None
    return out


def parse_total(html: str) -> dict | None:
    m = _TOTAL_RE.search(_text(html))
    return {"bonds": int(m.group(1)), "lower": int(m.group(2)), "median": int(m.group(3)), "upper": int(m.group(4))} if m else None


def _suggestion(html: str, suburb: str) -> str | None:
    """'여러 결과' 안내에서 오클랜드 쪽 이름을 고른다 (예: Mt Eden → Auckland - Mount Eden)."""
    t = _text(html)
    if "Suggestions:" not in t:
        return None
    sugg = re.findall(r"Auckland - ([A-Z][\w' .-]+?)(?= Auckland - | [A-Z][a-z]+ - | Subscribe|$)", t.split("Suggestions:", 1)[1][:600])
    sugg = [s.strip() for s in sugg]
    exact = [s for s in sugg if s.lower() == suburb.lower()]
    return (exact or sugg or [None])[0]


def fetch_rent(client: httpx.Client, suburb: str) -> dict | None:
    name = suburb
    for _ in range(2):
        r = client.get(RENT_URL, params={"location": f"Auckland - {name}", "action_doSearch": "Search"})
        got = parse_market_rent(r.text, name)
        if got:
            total = parse_total(r.text)
            if total:
                got["all"] = total
            got["name"] = name
            return got
        alt = _suggestion(r.text, name)
        if not alt or alt == name:
            return None
        name = alt
    return None


def parse_qv(html: str) -> dict[str, dict]:
    """QV 지역 설명 문장에서 평균 가치·변화율을 뽑는다. 설명 문장의 증감 표현이 들쭉날쭉해서 평균 가치만 신뢰한다."""
    t = html.encode().decode("unicode_escape", "ignore")
    out = {}
    for key in QV_DISTRICTS.values():
        m = re.search(rf'"{key}": \{{"name": "([^"]+)", "description": "(.*?)", "overwrite"', t, re.S)
        if not m:
            continue
        desc = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", m.group(2)))
        v = re.search(r"average value now sitting at \$\s?([\d,]+)", desc)
        if v:
            out[key] = {"name": m.group(1), "avg_value": int(v.group(1).replace(",", ""))}
    return out


def fetch_areas(cfg: dict, only: list[str] | None = None, client: httpx.Client | None = None) -> dict:
    acfg = cfg.get("areas", {})
    suburbs: dict[str, str] = acfg.get("suburbs", {})
    if only:
        suburbs = {k: v for k, v in suburbs.items() if k in only} or {k: "" for k in only}
    own = client is None
    client = client or httpx.Client(timeout=30, follow_redirects=True, headers={"User-Agent": cfg["fetch"]["user_agent"]})
    out: dict = {"updated_at": date.today().isoformat(), "rent_source": RENT_URL, "value_source": QV_URL,
                 "suburbs": {}, "districts": {}}
    try:
        try:
            out["districts"] = parse_qv(client.get(QV_URL).text)
        except Exception as e:  # noqa: BLE001
            log.warning("QV failed: %s", e)
        for name, district in suburbs.items():
            try:
                rent = fetch_rent(client, name)
            except Exception as e:  # noqa: BLE001
                log.warning("market rent %s failed: %s", name, e)
                rent = None
            out["suburbs"][name] = {"district": QV_DISTRICTS.get(district, ""), "rent": rent}
            time.sleep(float(acfg.get("delay_seconds", 0.5)))
    finally:
        if own:
            client.close()
    ok = sum(1 for s in out["suburbs"].values() if s["rent"])
    log.info("areas: rent for %d/%d suburbs, %d districts", ok, len(out["suburbs"]), len(out["districts"]))
    return out


def update_areas(cfg: dict, data_dir: Path, today: date) -> bool:
    """areas.json 이 없거나 refresh_days 이상 지났거나 config 에 새 동네가 생기면 새로 받는다. 받아 온 렌트가 하나도 없으면 기존 파일 유지."""
    path = data_dir / AREAS_FILE
    days = int(cfg.get("areas", {}).get("refresh_days", 7))
    try:
        old = json.loads(path.read_text(encoding="utf-8"))
        missing = set(cfg.get("areas", {}).get("suburbs", {})) - set(old.get("suburbs", {}))
        if (today - date.fromisoformat(old["updated_at"])).days < days and not missing:
            return False
    except Exception:  # noqa: BLE001
        old = None
    new = fetch_areas(cfg)
    if not any(s["rent"] for s in new["suburbs"].values()):
        log.warning("areas: no rent data fetched; keeping previous file")
        return False
    if old and not new["districts"]:
        new["districts"] = old.get("districts", {})
    data_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(new, ensure_ascii=False), encoding="utf-8")
    return True


if __name__ == "__main__":
    import logging

    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
    print(json.dumps(fetch_areas(load_config(), sys.argv[1:] or None), ensure_ascii=False, indent=1))
