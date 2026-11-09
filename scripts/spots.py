"""낚시·카약·수영 '장소(spot)' 데이터: 보트 램프, 부두·낚시 포인트, 해변 → web/public/data/spots.json

- 출처: OpenStreetMap(Overpass API, 무료·키 없음). 장소는 거의 안 바뀌어서 1년에 한 번(또는 수동)만 받는다(.github/workflows/spots.yml).
  AI 를 쓰지 않는다. 매일 도는 파이프라인에는 들어 있지 않다.
- 종류: ramp(보트 램프 — 카약·보트 출발), pier(부두·낚시 포인트), beach(이름 있는 해변). 사유지(access=private)는 뺀다.
"""
from __future__ import annotations

import json
import re
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
    "ramp": [f'[out:json][timeout:30];nwr["leisure"="slipway"]({BBOX});out center tags qt;'],
    # 부두는 질의 하나가 무거워 서버가 504 를 내서, 작은 질의 둘로 나눠 받아 합친다
    "pier": [f'[out:json][timeout:30];way["man_made"="pier"]["name"]({BBOX});out center tags qt;',
             f'[out:json][timeout:30];nwr["leisure"="fishing"]["name"]({BBOX});out center tags qt;'],
    "beach": [f'[out:json][timeout:30];nwr["natural"="beach"]["name"]({BBOX});out center tags qt;'],
    # 이름 있는 놀이터(스플래시 패드·워터 플레이는 이름 키워드로 따로 분류)
    "playground": [f'[out:json][timeout:30];nwr["leisure"="playground"]["name"]({BBOX});out center tags qt;'],
}
QUERIES.update({
    # 헬스장·요가·필라테스 스튜디오 (이름 있는 것만. 한 질의로 받고 이름·종목으로 gym/studio 로 나눈다)
    "gym": [f'[out:json][timeout:60];nwr["leisure"="fitness_centre"]["name"]({BBOX});out center tags qt;',
            f'[out:json][timeout:60];nwr["sport"~"yoga|pilates"]["name"]({BBOX});out center tags qt;'],
    # 테니스: 이름 있는 클럽 + 클럽 밖 코트(가까운 코트는 하나로 묶어 '코트 N면')
    "tennis": [f'[out:json][timeout:90];nwr["sport"~"tennis"]["club"="sport"]["name"]({BBOX});out center tags qt;',
               f'[out:json][timeout:90];nwr["sport"="tennis"]["leisure"="pitch"]({BBOX});out center tags qt;'],
    "basketball": [f'[out:json][timeout:90];nwr["leisure"="pitch"]["sport"="basketball"]({BBOX});out center tags qt;'],
    "outgym": [f'[out:json][timeout:60];nwr["leisure"="fitness_station"]({BBOX});out center tags qt;'],
    "skate": [f'[out:json][timeout:60];nwr["sport"="skateboard"]["leisure"~"pitch|sports_centre"]({BBOX});out center tags qt;'],
})
LIMITS = {"ramp": 160, "pier": 120, "beach": 220, "playground": 450, "splash": 120, "gym": 330, "studio": 90, "tennis": 460,
          "basketball": 260, "outgym": 130, "skate": 90}
DEFAULT_NAME = {"ramp": "보트 램프", "pier": "부두", "beach": "해변", "playground": "놀이터", "splash": "스플래시 패드",
                "gym": "헬스장", "studio": "요가·필라테스", "tennis": "테니스 코트", "basketball": "농구 코트", "outgym": "야외 운동기구", "skate": "스케이트 파크"}
YOGA = re.compile(r"yoga|pilates|reformer|barre", re.I)
# 묶어서 보여줄 종류: (좌표 묶는 거리(도), 묶음 이름 형식)
CLUSTER = {"basketball": (0.0012, "농구 코트 {n}면"), "outgym": (0.0015, "야외 운동기구"), "skate": (0.0015, None)}
TENNIS_EPS, TENNIS_CLUB_NEAR = 0.0012, 0.0022
SPLASH = re.compile(r"splash|water ?play|aqua|water ?park|paddling", re.I)


def classify(tags: dict, asked: str) -> str | None:
    if tags.get("access") in ("private", "no"):
        return None
    if asked == "ramp":
        return "ramp" if tags.get("leisure") == "slipway" else None
    if asked == "pier":
        return "pier" if (tags.get("man_made") == "pier" or tags.get("leisure") == "fishing") and tags.get("name") else None
    if asked == "gym":
        if tags.get("leisure") not in ("fitness_centre", "sports_centre") and not YOGA.search(tags.get("name", "")):
            return None
        return "studio" if (YOGA.search(tags.get("name", "")) or YOGA.search(tags.get("sport", ""))) and "climb" not in tags.get("sport", "") else "gym"
    if asked in ("tennis", "basketball", "outgym", "skate"):
        return asked
    if asked == "playground":
        if tags.get("leisure") != "playground" or not tags.get("name"):
            return None
        return "splash" if SPLASH.search(tags["name"]) else "playground"
    return "beach" if tags.get("natural") == "beach" and tags.get("name") else None


def convert(responses: dict[str, dict]) -> list[dict]:
    """종류별 Overpass 응답 → [{t, n, ll}]. 같은 종류·같은 이름이 150m 안에 또 있으면 하나로. 이름 없는 램프는 '보트 램프'."""
    out: list[dict] = []
    for asked, osm in responses.items():
        if asked == "tennis":
            out += convert_tennis(osm)
            continue
        if asked in CLUSTER:
            out += convert_clusters(asked, osm)
            continue
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
        for t in sorted({k["t"] for k in kept}):  # 질의 하나가 두 종류(놀이터·스플래시)로 나뉠 수 있어 종류별로 상한
            out += [k for k in kept if k["t"] == t][:LIMITS[t]]
    return out


def _points(osm: dict, asked: str) -> list[tuple[float, float, dict]]:
    pts = []
    for el in osm.get("elements", []):
        tags = el.get("tags") or {}
        if classify(tags, asked) is None:
            continue
        c = el if "lat" in el else el.get("center")
        if c and "lat" in c:
            pts.append((round(c["lat"], 5), round(c["lon"], 5), tags))
    return pts


def _cluster(pts: list[tuple[float, float, dict]], eps: float) -> list[dict]:
    """가까운 점을 하나로 (탐욕 방식). 반환: [{ll, n(개수), name}]"""
    groups: list[dict] = []
    for lat, lon, tags in pts:
        for g in groups:
            if abs(g["ll"][0] - lat) < eps and abs(g["ll"][1] - lon) < eps:
                g["n"] += 1
                g["name"] = g["name"] or tags.get("name", "")
                break
        else:
            groups.append({"ll": [lat, lon], "n": 1, "name": tags.get("name", "")})
    return groups


def convert_tennis(osm: dict) -> list[dict]:
    """이름 있는 클럽은 그대로, 클럽 밖 코트는 가까운 것끼리 '테니스 코트 N면'. 사유(access=private) 코트는 뺀다."""
    clubs: list[dict] = []
    courts: list[tuple[float, float, dict]] = []
    for lat, lon, tags in _points(osm, "tennis"):
        name = (tags.get("name") or "").strip()
        if tags.get("club") == "sport" and name and "table" not in tags.get("sport", ""):
            if not any(k["n"] == name and abs(k["ll"][0] - lat) < 0.0015 and abs(k["ll"][1] - lon) < 0.0015 for k in clubs):
                clubs.append({"t": "tennis", "n": name, "ll": [lat, lon], "x": "클럽"})
        elif tags.get("leisure") == "pitch":
            courts.append((lat, lon, tags))
    free = [c for c in courts if not any(abs(c[0] - k["ll"][0]) < TENNIS_CLUB_NEAR and abs(c[1] - k["ll"][1]) < TENNIS_CLUB_NEAR for k in clubs)]
    groups = _cluster(free, TENNIS_EPS)
    cl = [{"t": "tennis", "n": g["name"] or f"테니스 코트 {g['n']}면", "ll": g["ll"], "x": f"{g['n']}면"} for g in groups]
    cl.sort(key=lambda k: -int(k["x"][:-1]))
    clubs.sort(key=lambda k: k["n"])
    return (clubs + cl)[:LIMITS["tennis"]]


def convert_clusters(asked: str, osm: dict) -> list[dict]:
    eps, fmt = CLUSTER[asked]
    groups = _cluster(_points(osm, asked), eps)
    out = []
    for g in groups:
        name = g["name"] or (fmt.format(n=g["n"]) if fmt else DEFAULT_NAME[asked])
        out.append({"t": asked, "n": name, "ll": g["ll"], "x": f"{g['n']}개" if asked == "outgym" else (f"{g['n']}면" if asked == "basketball" else "")})
    out.sort(key=lambda k: (k["n"] in (DEFAULT_NAME[asked],), k["n"]))
    return out[:LIMITS[asked]]


def fetch_one(client: httpx.Client, query: str) -> dict:
    last = None
    for attempt in range(2):
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


def main(argv: list[str] | None = None) -> int:
    """종류별로 따로 받는다. 일부만 받아져도 저장하고(못 받은 종류는 이전 값 유지), 하나도 못 받으면 실패."""
    only = set(filter(None, ((argv or sys.argv[1:] or [""])[0]).split(","))) or set(QUERIES)  # 예: python scripts/spots.py pier
    old: dict[str, list[dict]] = {t: [] for t in QUERIES}
    try:
        for sp in json.loads(OUT.read_text(encoding="utf-8")).get("spots", []):
            old.setdefault(sp["t"], []).append(sp)
    except Exception:  # noqa: BLE001
        pass
    got: dict[str, dict] = {}
    with httpx.Client(timeout=45, headers={"User-Agent": "DailyBriefBot/1.0 (+https://github.com/dkwo284-max/News_Summary)"}) as client:
        for kind, q in QUERIES.items():
            if kind not in only:
                continue
            try:
                got[kind] = {"elements": [el for query in q for el in fetch_one(client, query).get("elements", [])]}
            except Exception as e:  # noqa: BLE001
                print(f"spots: {kind} failed — keeping previous ({len(old.get(kind, []))}): {e}", file=sys.stderr)
    if not got:
        print("spots: nothing fetched — not writing", file=sys.stderr)
        return 1
    fresh = convert(got)
    own = {"playground": ("playground", "splash"), "gym": ("gym", "studio")}
    keep = [sp for sp in (s for v in old.values() for s in v) if not any(sp["t"] in own.get(k, (k,)) for k in got)]
    spots = fresh + keep  # 못 받았거나 이번에 안 묻은 종류는 이전 값 유지
    counts = {t: sum(1 for sp in spots if sp["t"] == t) for t in LIMITS}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"updated_at": date.today().isoformat(), "source": "OpenStreetMap (Overpass)", "spots": spots},
                              ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(counts, "(나머지 종류는 이전 값 유지)" if len(got) < len(QUERIES) else "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
