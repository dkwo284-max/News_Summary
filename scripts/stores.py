"""울월쓰(Woolworths NZ)·케미스트웨어하우스 매장 위치 → web/public/data/stores.json

- 출처: OpenStreetMap(Overpass API, 무료·키 없음). 매장은 자주 바뀌지 않아 매일 도는 파이프라인에는 넣지 않고,
  1년에 한 번(또는 수동 --force) 갱신한다(.github/workflows/stores.yml). 파일이 1년 안에 만든 것이면 자동 실행은 건너뛴다.
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
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter",
             "https://overpass.kumi.systems/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
BBOX = "-37.45,174.20,-36.15,175.30"  # 오클랜드 광역시 + 와이헤케
# 체인별로 따로 묻는다(서버 부담↓). shop 태그로 먼저 좁힌 뒤 이름을 거른다.
QUERIES = [
    f'''[out:json][timeout:60];
(
  nwr["shop"="supermarket"]["name"~"Woolworths|Countdown",i]({BBOX});
  nwr["shop"="supermarket"]["brand"~"Woolworths|Countdown",i]({BBOX});
);
out center tags;''',
    f'''[out:json][timeout:60];
(
  nwr["shop"~"^(chemist|pharmacy)$"]["name"~"Chemist Warehouse",i]({BBOX});
  nwr["shop"~"^(chemist|pharmacy)$"]["brand"~"Chemist Warehouse",i]({BBOX});
);
out center tags;''',
]
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
        where = (tags.get("addr:suburb") or tags.get("addr:street") or tags.get("addr:city") or "").strip()
        out[chain].append({"n": name, "a": where, "ll": [lat, lon]})
    return {k: sorted(v, key=lambda s: s["n"]) for k, v in out.items()}


def fetch() -> dict:
    """두 질의 결과를 합친다. 서버가 바쁘면 다른 서버로, 그래도 안 되면 잠시 쉬었다 다시."""
    elements: list[dict] = []
    with httpx.Client(timeout=90, headers={"User-Agent": "DailyBriefBot/1.0 (+https://github.com/dkwo284-max/News_Summary)"}) as client:
        for q in QUERIES:
            last = None
            for attempt in range(3):
                got = None
                for url in ENDPOINTS:
                    try:
                        r = client.post(url, data={"data": q})
                        if r.status_code == 200:
                            got = r.json()
                            break
                        last = f"{url}: HTTP {r.status_code}"
                    except (httpx.HTTPError, ValueError) as e:
                        last = f"{url}: {type(e).__name__} {e}"
                    print("stores:", last, file=sys.stderr)
                if got is not None:
                    elements += got.get("elements", [])
                    break
                time.sleep(20 * (attempt + 1))
            else:
                raise RuntimeError(last or "overpass failed")
    return {"elements": elements}


MAX_AGE_DAYS = 365


def fresh() -> bool:
    try:
        old = json.loads(OUT.read_text(encoding="utf-8"))
        return (date.today() - date.fromisoformat(old["updated_at"])).days < MAX_AGE_DAYS
    except Exception:  # noqa: BLE001 — 파일이 없거나 깨졌으면 새로 받는다
        return False


def main() -> int:
    if "--force" not in sys.argv and fresh():
        print("stores: data is under a year old — skipping (use --force to refresh)")
        return 0
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
