"""울월쓰(Woolworths NZ)·케미스트웨어하우스 매장 위치 → web/public/data/stores.json

- 출처: OpenStreetMap(Overpass API, 무료·키 없음). 매장은 자주 바뀌지 않아 한 달에 한 번(또는 수동) 갱신한다(.github/workflows/stores.yml).
- 앱에서 관심 동네 중심 좌표와 직선거리(km)를 계산해 가장 가까운 매장을 보여준다. 도로 거리·영업시간은 아님.
"""
from __future__ import annotations

import json
import sys
import time
from datetime import date
from pathlib import Path

import httpx

OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "data" / "stores.json"
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
BBOX = "-37.45,174.20,-36.15,175.30"  # 오클랜드 광역시 + 와이헤케
QUERY = f"""[out:json][timeout:90];
(
  nwr["shop"="supermarket"]["name"~"Woolworths|Countdown",i]({BBOX});
  nwr["shop"="supermarket"]["brand"~"Woolworths|Countdown",i]({BBOX});
  nwr["shop"~"chemist|pharmacy"]["name"~"Chemist Warehouse",i]({BBOX});
  nwr["shop"~"chemist|pharmacy"]["brand"~"Chemist Warehouse",i]({BBOX});
);
out center tags;"""
CHAINS = {
    "woolworths": "울월쓰 (Woolworths)",
    "chemist": "케미스트웨어하우스",
}


def classify(tags: dict) -> str | None:
    text = " ".join(str(tags.get(k, "")) for k in ("name", "brand")).lower()
    if "chemist warehouse" in text:
        return "chemist"
    if ("woolworths" in text or "countdown" in text) and "fuel" not in text and tags.get("shop") == "supermarket":
        return "woolworths"
    return None


def convert(osm: dict) -> dict:
    """Overpass 응답 → {chain: [{n, ll}]}. 같은 이름이 약 150m 안에 또 있으면(건물·출입구 중복) 하나로."""
    out: dict[str, list[dict]] = {k: [] for k in CHAINS}
    for el in osm.get("elements", []):
        tags = el.get("tags") or {}
        chain = classify(tags)
        c = el if "lat" in el else el.get("center")
        if not chain or not c or "lat" not in c:
            continue
        name = (tags.get("name") or CHAINS[chain]).strip()
        lat, lon = round(c["lat"], 5), round(c["lon"], 5)
        if any(s["n"] == name and abs(s["ll"][0] - lat) < 0.0015 and abs(s["ll"][1] - lon) < 0.0015 for s in out[chain]):
            continue
        out[chain].append({"n": name, "ll": [lat, lon]})
    return {k: sorted(v, key=lambda s: s["n"]) for k, v in out.items()}


def fetch() -> dict:
    last = None
    with httpx.Client(timeout=120, headers={"User-Agent": "DailyBriefBot/1.0 (+https://github.com/dkwo284-max/News_Summary)"}) as client:
        for attempt in range(3):
            for url in ENDPOINTS:
                try:
                    r = client.post(url, data={"data": QUERY})
                    if r.status_code == 200:
                        return r.json()
                    last = f"{url}: HTTP {r.status_code}"
                except httpx.HTTPError as e:
                    last = f"{url}: {e}"
            time.sleep(15 * (attempt + 1))
    raise RuntimeError(last or "overpass failed")


def main() -> int:
    chains = convert(fetch())
    if not all(chains.values()):
        print("stores: a chain came back empty — not writing", {k: len(v) for k, v in chains.items()}, file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"updated_at": date.today().isoformat(), "source": "OpenStreetMap (Overpass)",
                               "chains": {k: {"label": CHAINS[k], "stores": v} for k, v in chains.items()}},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print({k: len(v) for k, v in chains.items()})
    return 0


if __name__ == "__main__":
    sys.exit(main())
