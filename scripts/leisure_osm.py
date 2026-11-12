"""레저 시설의 운영 시간·연락처를 OpenStreetMap 에서 가져온다 (AI 없음) → web/public/data/leisure-osm.json

leisure.json 의 좌표가 있는 시설마다 반경 300m 안에서 이름이 비슷한 OSM 장소를 찾아 opening_hours(기계가 읽는 형식)·phone·
wheelchair 태그를 가져오고, 150m 안에 주차장이 있는지 센다. OSM 에 등록되지 않은 곳은 비워 둔다(추측하지 않는다).
"""
from __future__ import annotations

import json
import math
import re
import sys
from datetime import date

import httpx

from common import ROOT
from spots import ENDPOINTS


def fetch_one(client: httpx.Client, query: str) -> dict:
    """Overpass 서버 후보를 한 바퀴만 돈다 (오래 기다리지 않는다 — 전체 작업이 시간 제한에 걸리지 않게)."""
    errs = []
    for url in ENDPOINTS:
        try:
            r = client.post(url, data={"data": query})
            if r.status_code == 200:
                return r.json()
            errs.append(f"{url.split('/')[2]}: HTTP {r.status_code}")
        except (httpx.HTTPError, ValueError) as e:
            errs.append(f"{url.split('/')[2]}: {type(e).__name__}")
    raise RuntimeError(" | ".join(errs) or "overpass failed")

SRC = ROOT / "web" / "public" / "data" / "leisure.json"
OUT = ROOT / "web" / "public" / "data" / "leisure-osm.json"
STOP = {"the", "club", "centre", "center", "pool", "pools", "and", "leisure", "auckland", "park", "golf", "swimming", "aquatic", "of", "at", "school"}


def km(a, b) -> float:
    dlat, dlon = math.radians(b[0] - a[0]), math.radians(b[1] - a[1])
    x = math.sin(dlat / 2) ** 2 + math.cos(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.sin(dlon / 2) ** 2
    return 12742 * math.asin(math.sqrt(x))


def words(name: str) -> set[str]:
    return {w for w in re.findall(r"[a-zāēīōū]+", (name or "").lower()) if len(w) >= 3}


def similar(a: str, b: str) -> float:
    """이름이 같은 곳인가: 흔한 낱말(club·pool 등)을 뺀 낱말이 얼마나 겹치는지 (0~1)."""
    wa, wb = words(a), words(b)
    ka, kb = wa - STOP, wb - STOP
    if not ka or not kb:
        return 1.0 if wa and wa == wb else 0.0
    return len(ka & kb) / min(len(ka), len(kb))


def match(fac: dict, elements: list[dict]) -> dict | None:
    best, score = None, 0.0
    for e in elements:
        ll = (e.get("lat") or (e.get("center") or {}).get("lat"), e.get("lon") or (e.get("center") or {}).get("lon"))
        if ll[0] is None or km(fac["ll"], ll) > 0.3:
            continue
        s = similar(fac["name"], (e.get("tags") or {}).get("name", ""))
        if s > score:
            best, score = e, s
    return best if score >= 0.6 else None


def build(facilities: list[dict], named: list[dict], parking: list[dict]) -> dict:
    out = {}
    plls = [(p.get("lat") or (p.get("center") or {}).get("lat"), p.get("lon") or (p.get("center") or {}).get("lon")) for p in parking]
    plls = [p for p in plls if p[0] is not None]
    for f in facilities:
        if not f.get("ll"):
            continue
        row: dict = {}
        e = match(f, named)
        if e:
            t = e["tags"]
            for src, dst in (("opening_hours", "hours"), ("phone", "phone"), ("contact:phone", "phone"), ("wheelchair", "wheelchair")):
                if t.get(src) and dst not in row:
                    row[dst] = t[src][:200]
        n = sum(1 for p in plls if km(f["ll"], p) <= 0.15)
        if n:
            row["parking_near"] = n
        if row:
            out[f["id"]] = row
    return out


BUDGET_S = 540   # 작업 전체 시간 예산(9분) — 서버가 느린 날에도 워크플로 제한 안에 끝내고, 그때까지 얻은 것은 저장한다
CHUNK = 20   # 한 번에 묻는 시설 수 (오클랜드 전체를 한 번에 물으면 Overpass 가 시간 초과를 낸다)


def main() -> int:
    data = json.loads(SRC.read_text(encoding="utf-8"))
    facs = [f for f in data["facilities"] if f.get("ll")]
    old = json.loads(OUT.read_text(encoding="utf-8")).get("facilities", {}) if OUT.exists() else {}
    ua = "DailyBriefBot/1.0 (+https://github.com/dkwo284-max/News_Summary)"
    import time

    named, parking, failed, t0, streak = [], [], 0, time.monotonic(), 0
    with httpx.Client(timeout=35, headers={"User-Agent": ua}) as client:
        for k in range(0, len(facs), CHUNK):
            part = facs[k:k + CHUNK]
            if time.monotonic() - t0 > BUDGET_S or streak >= 2:   # 시간이 다 됐거나 두 묶음 연속 실패 → 남은 시설은 다음 달에
                failed += len(facs) - k
                print(f"leisure-osm: stopping early at {k}/{len(facs)} (time {int(time.monotonic() - t0)}s, failures in a row {streak})", file=sys.stderr)
                break
            q = "".join(f'nwr["name"]["opening_hours"](around:300,{f["ll"][0]},{f["ll"][1]});' for f in part)
            pk = "".join(f'nwr["amenity"="parking"]["access"!="private"](around:150,{f["ll"][0]},{f["ll"][1]});' for f in part)
            try:
                named += fetch_one(client, f"[out:json][timeout:30];({q});out center tags;")["elements"]
                streak = 0
                try:
                    parking += fetch_one(client, f"[out:json][timeout:30];({pk});out center;")["elements"]
                except Exception:  # noqa: BLE001 — 주차장은 덤, 운영 시간을 우선
                    pass
            except Exception as e:  # noqa: BLE001 — 한 묶음이 실패해도 나머지는 계속, 실패한 시설은 이전 값을 둔다
                failed += len(part)
                streak += 1
                print("leisure-osm: chunk failed:", str(e)[:200], file=sys.stderr)
    rows = build(facs, named, parking)
    rows = {**{k: v for k, v in old.items() if k not in rows}, **rows} if failed else rows
    OUT.write_text(json.dumps({"updated_at": date.today().isoformat(), "source": "OpenStreetMap", "facilities": rows}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"leisure-osm: {len(rows)} of {len(facs)} matched ({sum(1 for r in rows.values() if r.get('hours'))} with hours), candidates {len(named)}, failed facilities {failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
