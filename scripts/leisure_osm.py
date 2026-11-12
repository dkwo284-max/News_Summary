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

from common import ROOT, load_config
from spots import fetch_one

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


CHUNK = 20   # 한 번에 묻는 시설 수 (오클랜드 전체를 한 번에 물으면 Overpass 가 시간 초과를 낸다)


def main() -> int:
    data = json.loads(SRC.read_text(encoding="utf-8"))
    facs = [f for f in data["facilities"] if f.get("ll")]
    old = json.loads(OUT.read_text(encoding="utf-8")).get("facilities", {}) if OUT.exists() else {}
    ua = load_config()["fetch"]["user_agent"]
    named, parking, failed = [], [], 0
    with httpx.Client(timeout=90, headers={"User-Agent": ua}) as client:
        for k in range(0, len(facs), CHUNK):
            part = facs[k:k + CHUNK]
            q = "".join(f'nwr["name"]["opening_hours"](around:300,{f["ll"][0]},{f["ll"][1]});' for f in part)
            pk = "".join(f'nwr["amenity"="parking"]["access"!="private"](around:150,{f["ll"][0]},{f["ll"][1]});' for f in part)
            try:
                named += fetch_one(client, f"[out:json][timeout:60];({q});out center tags;")["elements"]
                parking += fetch_one(client, f"[out:json][timeout:60];({pk});out center;")["elements"]
            except Exception as e:  # noqa: BLE001 — 한 묶음이 실패해도 나머지는 계속, 실패한 시설은 이전 값을 둔다
                failed += len(part)
                print("leisure-osm: chunk failed:", str(e)[:120], file=sys.stderr)
    rows = build(facs, named, parking)
    rows = {**{k: v for k, v in old.items() if k not in rows}, **rows} if failed else rows
    OUT.write_text(json.dumps({"updated_at": date.today().isoformat(), "source": "OpenStreetMap", "facilities": rows}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"leisure-osm: {len(rows)} of {len(facs)} matched ({sum(1 for r in rows.values() if r.get('hours'))} with hours), candidates {len(named)}, failed facilities {failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
