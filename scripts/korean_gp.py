"""한인 GP 지도: hanin.nz 의 '뉴질랜드 한인 GP 목록'을 받아 좌표를 붙여 저장한다 (키·요금 없음, AI 요청 없음).

- 목록: https://hanin.nz/korean-gp (병원 이름·의사·주소·전화·등록 가능 여부). 출처를 앱에 표시하고 원문으로 연결한다.
- 좌표: OpenStreetMap Nominatim (초당 1회 제한 준수). 한 번 찾은 주소는 korean-gp.json 에 남겨 다시 묻지 않는다.
- 관심 동네와의 거리를 보여주려고 areas.suburbs 의 동네 중심 좌표도 같은 방식으로 한 번만 찾아 둔다.

    python scripts/korean_gp.py      # 점검용: 받아서 출력 (파일 저장 안 함)
"""
from __future__ import annotations

import html as htmllib
import json
import re
import time
from datetime import date
from pathlib import Path

import httpx

from common import load_config, log

SOURCE_URL = "https://hanin.nz/korean-gp"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
GP_FILE = "korean-gp.json"


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", htmllib.unescape(re.sub(r"<!-- -->|<[^>]+>", "", s))).strip()


def parse_gp_page(page: str) -> list[dict]:
    """지역별 <section> 안의 <li> 하나가 병원 하나."""
    clinics = []
    for sec in re.findall(r"<section>(.*?)</section>", page, re.S):
        h2 = re.search(r"<h2[^>]*>(.*?)</h2>", sec, re.S)
        region = re.sub(r"^🩺|\d+곳$", "", _clean(h2.group(1))).strip() if h2 else ""
        region = re.sub(r"\d+\s*곳$", "", region).strip()
        for li in re.findall(r"<li[^>]*>(.*?)</li>", sec, re.S):
            spans = re.findall(r'<span class="[^"]*font-bold[^"]*"[^>]*>(.*?)</span>', li, re.S)
            if not spans:
                continue
            name = _clean(spans[0])
            status = _clean(spans[1]) if len(spans) > 1 else ""
            doctors = re.search(r'<p class="mt-0\.5[^"]*"[^>]*>(.*?)</p>', li, re.S)
            addr = re.search(r'href="(https://www\.google\.com/maps/[^"]+)"[^>]*>(.*?)</a>', li, re.S)
            phone = re.search(r'href="tel:([^"]+)"', li)
            links = {
                "website": next((htmllib.unescape(u) for u, label in re.findall(r'href="(https?://[^"]+)"[^>]*>(.*?)</a>', li, re.S)
                                 if "웹사이트" in label), ""),
                "healthpoint": next((htmllib.unescape(u) for u in re.findall(r'href="(https?://www\.healthpoint\.co\.nz/[^"]+)"', li)), ""),
            }
            clinics.append({
                "name": name,
                "status": status,
                "doctors": _clean(doctors.group(1)) if doctors else "",
                "address": _clean(addr.group(2)).lstrip("📍").strip() if addr else "",
                "maps_url": htmllib.unescape(addr.group(1)) if addr else "",
                "phone": phone.group(1).strip() if phone else "",
                "region": region,
                **links,
            })
    return clinics


def _geo_queries(c: dict) -> list[str]:
    """Nominatim 이 잘 찾도록: 'Level 1, Unit 11,' 같은 앞부분과 두 번째 주소(·)를 떼고 도시·나라를 붙인다."""
    city = {"오클랜드": "Auckland", "크라이스트처치": "Christchurch", "해밀턴": "Hamilton"}.get(c["region"], "")
    addr = c["address"].split("·")[0]
    parts = [p.strip() for p in addr.split(",") if p.strip() and not re.match(r"(?i)^(level|unit|suite|shop)\b", p.strip())]
    parts = [p for p in parts if not re.search(r"(?i)health services|medical centre", p)] or parts
    tail = ", ".join(x for x in (city, "New Zealand") if x and x.lower() not in addr.lower())
    qs = []
    if parts:
        qs.append(", ".join(parts) + (f", {tail}" if tail else ""))
        if len(parts) > 1:
            qs.append(f"{parts[-1]}, {tail}" if tail else parts[-1])  # 동네만
    qs.append(f"{c['name']}, {tail}" if tail else c["name"])
    return qs


def geocode(client: httpx.Client, query: str) -> list[float] | None:
    r = client.get(NOMINATIM, params={"q": query, "format": "json", "limit": 1, "countrycodes": "nz"})
    time.sleep(1.1)  # Nominatim 사용 정책: 초당 1회
    if r.status_code != 200:
        return None
    rows = r.json()
    return [round(float(rows[0]["lat"]), 5), round(float(rows[0]["lon"]), 5)] if rows else None


def build(cfg: dict, old: dict | None, client: httpx.Client) -> dict | None:
    page = client.get(SOURCE_URL).text
    clinics = parse_gp_page(page)
    if not clinics:
        log.warning("korean gp: no clinics parsed")
        return None
    cache: dict[str, list[float]] = dict((old or {}).get("geocache", {}))
    for c in clinics:
        key = f"{c['name']}|{c['address']}"
        if key not in cache:
            for q in _geo_queries(c):
                ll = geocode(client, q)
                if ll:
                    cache[key] = ll
                    break
        c["latlon"] = cache.get(key)
    suburbs: dict[str, list[float]] = dict((old or {}).get("suburbs", {}))
    for name in cfg.get("areas", {}).get("suburbs", {}):
        if name not in suburbs:
            ll = geocode(client, f"{name}, Auckland, New Zealand")
            if ll:
                suburbs[name] = ll
    found = sum(1 for c in clinics if c["latlon"])
    log.info("korean gp: %d clinics (%d located), %d suburb centres", len(clinics), found, len(suburbs))
    return {"updated_at": date.today().isoformat(), "source": SOURCE_URL, "clinics": clinics,
            "suburbs": suburbs, "geocache": cache}


def update_korean_gp(cfg: dict, data_dir: Path) -> bool:
    path = data_dir / GP_FILE
    try:
        old = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        old = None
    ua = cfg["fetch"]["user_agent"]
    with httpx.Client(timeout=30, follow_redirects=True, headers={"User-Agent": ua}) as client:
        new = build(cfg, old, client)
    if not new:
        return False
    data_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(new, ensure_ascii=False), encoding="utf-8")
    return True


if __name__ == "__main__":
    import logging

    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
    cfg = load_config()
    with httpx.Client(timeout=30, follow_redirects=True, headers={"User-Agent": cfg["fetch"]["user_agent"]}) as c:
        out = build(cfg, None, c)
    print(json.dumps(out, ensure_ascii=False, indent=1))
