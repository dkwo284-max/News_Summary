"""자동차 칩: 오클랜드 정비소·판금·WoF 검사소·타이어·유리·토요타 서비스센터 위치 → web/public/data/car.json

- 출처 1: OpenStreetMap(Overpass API, 무료·키 없음). shop=car_repair·tyres·car_parts 와 토요타(이름·브랜드) 정비·딜러.
  종류는 OSM 태그와 이름으로 나눈다(정비/판금/WoF/타이어/유리/토요타). 이름에 한글이나 Korea 가 들어간 곳은 'ko_guess'(한인 운영 추정, 보장 아님).
- 출처 2: hanin.nz — 한인 GP 목록과 같은 사이트에 정비(카센터) 목록 페이지가 있으면 그 목록을 받아 좌표를 붙인다.
  홈페이지 링크에서 '정비·카센터·자동차' 페이지를 찾고, 없으면 건너뛴다(없다는 사실을 파일에 남김).
- 좌표 찾기는 korean_gp.py 와 같은 Nominatim(초당 1회). 한 번 찾은 주소는 파일에 남겨 다시 묻지 않는다.
- 정비소는 자주 바뀌지 않아 매일 도는 파이프라인에는 넣지 않고 매달 1회(.github/workflows/car.yml). AI 호출 없음.

    python scripts/car.py            # 30일 안에 만든 파일이면 건너뜀
    python scripts/car.py --force
"""
from __future__ import annotations

import html as htmllib
import json
import re
import sys
import time
from datetime import date
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent))
from korean_gp import _clean, _geo_queries, geocode, parse_gp_page  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "data" / "car.json"
UA = "DailyBriefBot/1.0 (+https://github.com/dkwo284-max/News_Summary)"
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
             "https://overpass.kumi.systems/api/interpreter"]
BBOX = "-37.30,174.40,-36.55,175.05"  # 오클랜드 도시권
QUERY = f'''[out:json][timeout:60];
(
  nwr["shop"="car_repair"]({BBOX});
  nwr["shop"="tyres"]({BBOX});
  nwr["amenity"="vehicle_inspection"]({BBOX});
  nwr["shop"="car"]["name"~"Toyota",i]({BBOX});
  nwr["shop"="car"]["brand"~"Toyota",i]({BBOX});
);
out center tags;'''
HANIN = "https://hanin.nz/"
MAX_AGE_DAYS = 30
HANGUL = re.compile(r"[가-힣]")


def kinds_of(tags: dict) -> list[str]:
    """OSM 태그·이름 → 종류. 하나도 못 정하면 일반 정비(repair)."""
    name = " ".join(str(tags.get(k, "")) for k in ("name", "brand", "operator")).lower()
    svc = {k.split(":")[-1]: v for k, v in tags.items() if k.startswith("service:vehicle:")}
    out = []
    if "toyota" in name:
        out.append("toyota")
    if tags.get("shop") == "tyres" or svc.get("tyres") == "yes" or re.search(r"tyre|tire|beaurepaires|bridgestone", name):
        out.append("tyre")
    if svc.get("body_repair") == "yes" or re.search(r"panel|collision|smash|body ?(shop|works|repair)|crash", name):
        out.append("panel")
    if tags.get("amenity") == "vehicle_inspection" or svc.get("inspection") == "yes" or re.search(r"\bwof\b|vtnz|\bvinz\b|warrant", name):
        out.append("wof")
    if svc.get("glass") == "yes" or re.search(r"glass|windscreen|smith ?& ?smith|novus|o'?brien", name):
        out.append("glass")
    if tags.get("shop") == "car_repair" and not set(out) - {"toyota"} or not out:
        out.append("repair")
    return sorted(set(out))


def convert(osm: dict) -> list[dict]:
    items: list[dict] = []
    for el in osm.get("elements", []):
        t = el.get("tags") or {}
        c = el if "lat" in el else el.get("center")
        name = (t.get("name") or t.get("brand") or "").strip()
        if not c or "lat" not in c or not name:
            continue
        if t.get("shop") == "car" and not re.search(r"toyota", name + t.get("brand", ""), re.I):
            continue
        lat, lon = round(c["lat"], 5), round(c["lon"], 5)
        if any(x["n"] == name and abs(x["ll"][0] - lat) < 0.0015 and abs(x["ll"][1] - lon) < 0.0015 for x in items):
            continue
        street = " ".join(x for x in (t.get("addr:housenumber", ""), t.get("addr:street", "")) if x).strip()
        sub = (t.get("addr:suburb") or t.get("addr:city") or "").strip()
        it = {"n": name, "k": kinds_of(t), "ll": [lat, lon], "a": ", ".join(x for x in (street, sub) if x)}
        for src, dst in (("phone", "p"), ("contact:phone", "p"), ("website", "w"), ("contact:website", "w"), ("opening_hours", "h")):
            if t.get(src) and dst not in it:
                it[dst] = t[src].split(";")[0].strip()
        if "w" in it and not re.match(r"https?://", it["w"]):
            it["w"] = "https://" + it["w"]
        if HANGUL.search(name) or re.search(r"\bkorea", name, re.I):
            it["ko_guess"] = True
        items.append(it)
    return sorted(items, key=lambda x: x["n"].lower())


def fetch_osm(client: httpx.Client) -> dict:
    last = None
    for attempt in range(2):
        for url in ENDPOINTS:
            try:
                r = client.post(url, data={"data": QUERY})
                if r.status_code == 200:
                    return r.json()
                last = f"{url}: HTTP {r.status_code}"
            except (httpx.HTTPError, ValueError) as e:
                last = f"{url}: {type(e).__name__}"
            print("car:", last, file=sys.stderr)
        time.sleep(20 * (attempt + 1))
    raise RuntimeError(last or "overpass failed")


def find_hanin_pages(home: str) -> list[str]:
    """hanin.nz 홈페이지에서 정비·카센터·자동차 관련 내부 링크를 찾는다."""
    urls = []
    for href, label in re.findall(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', home, re.S):
        text = _clean(label) + " " + href
        if re.search(r"정비|카센터|자동차|car-?repair|mechanic|panel", text, re.I) and not re.search(r"gp|병원|의원", href, re.I):
            u = htmllib.unescape(href)
            u = u if u.startswith("http") else HANIN.rstrip("/") + "/" + u.lstrip("/")
            if "hanin.nz" in u and u not in urls:
                urls.append(u)
    return urls[:3]


def fetch_hanin(client: httpx.Client, cache: dict) -> dict:
    """{status, source, shops}. 페이지가 없거나 형식이 다르면 shops 는 빈 목록."""
    try:
        pages = find_hanin_pages(client.get(HANIN).text)
    except httpx.HTTPError as e:
        return {"status": f"hanin.nz 접속 실패({type(e).__name__})", "source": HANIN, "shops": []}
    if not pages:
        return {"status": "hanin.nz 에 정비 목록 페이지가 아직 없음", "source": HANIN, "shops": []}
    shops: list[dict] = []
    for u in pages:
        try:
            got = parse_gp_page(client.get(u).text)
        except httpx.HTTPError:
            continue
        for s in got:
            if s.get("region") and s["region"] != "오클랜드" and "Auckland" not in s.get("address", ""):
                continue
            key = f"{s['name']}|{s['address']}"
            if key not in cache:
                for q in _geo_queries({**s, "region": s.get("region") or "오클랜드"}):
                    ll = geocode(client, q)
                    if ll:
                        cache[key] = ll
                        break
            shops.append({"n": s["name"], "a": s["address"], "p": s["phone"], "w": s.get("website", ""),
                          "maps": s.get("maps_url", ""), "note": s.get("doctors", ""), "ll": cache.get(key), "src": u})
        if shops:
            return {"status": "ok", "source": u, "shops": shops}
    return {"status": "정비 관련 글은 있지만 업체 목록 형식이 아님 — 원문에서 직접 확인", "source": pages[0], "shops": []}


def fresh() -> bool:
    try:
        old = json.loads(OUT.read_text(encoding="utf-8"))
        return (date.today() - date.fromisoformat(old["updated_at"])).days < MAX_AGE_DAYS
    except Exception:  # noqa: BLE001
        return False


def main() -> int:
    if "--force" not in sys.argv and fresh():
        print("car: data is under 30 days old — skipping (use --force)")
        return 0
    try:
        old = json.loads(OUT.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        old = {}
    cache = dict(old.get("geocache", {}))
    with httpx.Client(timeout=60, follow_redirects=True, headers={"User-Agent": UA}) as client:
        try:
            shops = convert(fetch_osm(client))
        except RuntimeError as e:
            if not old.get("shops"):
                raise
            print("car: overpass failed, keeping previous shops:", e, file=sys.stderr)
            shops = old["shops"]
        hanin = fetch_hanin(client, cache)
    data = {"updated_at": date.today().isoformat(), "osm_source": "https://www.openstreetmap.org/",
            "shops": shops, "hanin": hanin, "geocache": cache}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    from collections import Counter
    kc = Counter(k for s in shops for k in s["k"])
    print(f"car: {len(shops)} shops {dict(kc)}, korean-name {sum(1 for s in shops if s.get('ko_guess'))}, hanin: {hanin['status']} ({len(hanin['shops'])})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
