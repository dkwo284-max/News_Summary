"""낚시·카약·수영 '장소(spot)' 데이터: 보트 램프, 부두·낚시 포인트, 해변 → web/public/data/spots.json

- 출처: OpenStreetMap(Overpass API, 무료·키 없음). 장소는 거의 안 바뀌어서 1년에 한 번(또는 수동)만 받는다(.github/workflows/spots.yml).
  AI 를 쓰지 않는다. 매일 도는 파이프라인에는 들어 있지 않다.
- 종류: ramp(보트 램프 — 카약·보트 출발), pier(부두·낚시 포인트), beach(이름 있는 해변). 사유지(access=private)는 뺀다.
"""
from __future__ import annotations

import json
import sys
import time
from datetime import date
from pathlib import Path

import httpx

OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "data" / "spots.json"
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
             "https://overpass.kumi.systems/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
BBOX = "-37.45,174.20,-36.15,175.30"  # 오클랜드 광역시 + 와이헤케
QUERIES = {
    "ramp": f'[out:json][timeout:40];nwr["leisure"="slipway"]({BBOX});out center tags;',
    "pier": f'[out:json][timeout:40];(nwr["man_made"="pier"]["name"]({BBOX});nwr["leisure"="fishing"]["name"]({BBOX}););out center tags;',
    "beach": f'[out:json][timeout:40];nwr["natural"="beach"]["name"]({BBOX});out center tags;',
}
LIMITS = {"ramp": 160, "pier": 120, "beach": 220}
DEFAULT_NAME = {"ramp": "보트 램프", "pier": "부두", "beach": "해변"}


def classify(tags: dict, asked: str) -> str | None:
    if tags.get("access") in ("private", "no"):
        return None
    if asked == "ramp":
        return "ramp" if tags.get("leisure") == "slipway" else None
    if asked == "pier":
        return "pier" if (tags.get("man_made") == "pier" or tags.get("leisure") == "fishing") and tags.get("name") else None
    return "beach" if tags.get("natural") == "beach" and tags.get("name") else None


def convert(responses: dict[str, dict]) -> list[dict]:
    """종류별 Overpass 응답 → [{t, n, ll}]. 같은 종류·같은 이름이 150m 안에 또 있으면 하나로. 이름 없는 램프는 '보트 램프'."""
    out: list[dict] = []
    for asked, osm in responses.items():
        kept: list[dict] = []
        for el in osm.get("elements", []):
            tags = el.get("tags") or {}
            t = classify(tags, asked)
            c = el if "lat" in el else el.get("center")
            if not t or not c or "lat" not in c:
                continue
            name = (tags.get("name") or DEFAULT_NAME[t]).strip()
            lat, lon = round(c["lat"], 5), round(c["lon"], 5)
            if any(k["n"] == name and abs(k["ll"][0] - lat) < 0.0015 and abs(k["ll"][1] - lon) < 0.0015 for k in kept):
                continue
            kept.append({"t": t, "n": name, "ll": [lat, lon]})
        # 이름 있는 것을 먼저, 상한까지
        kept.sort(key=lambda k: (k["n"] == DEFAULT_NAME[k["t"]], k["n"]))
        out += kept[:LIMITS[asked]]
    return out


def fetch_one(client: httpx.Client, query: str) -> dict:
    last = None
    for attempt in range(3):
        for url in ENDPOINTS:
            try:
                r = client.post(url, data={"data": query})
                if r.status_code == 200:
                    return r.json()
                last = f"{url}: HTTP {r.status_code}"
            except (httpx.HTTPError, ValueError) as e:
                last = f"{url}: {type(e).__name__} {e}"
            print("spots:", last, file=sys.stderr)
        time.sleep(20 * (attempt + 1))
    raise RuntimeError(last or "overpass failed")


def main() -> int:
    with httpx.Client(timeout=45, headers={"User-Agent": "DailyBriefBot/1.0 (+https://github.com/dkwo284-max/News_Summary)"}) as client:
        got = {k: fetch_one(client, q) for k, q in QUERIES.items()}
    spots = convert(got)
    counts = {t: sum(1 for s in spots if s["t"] == t) for t in QUERIES}
    if not all(counts.values()):
        print("spots: a type came back empty — not writing", counts, file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"updated_at": date.today().isoformat(), "source": "OpenStreetMap (Overpass)", "spots": spots},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(counts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
