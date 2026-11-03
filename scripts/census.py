"""지역별 민족 구성 지도 데이터: Stats NZ 2023 인구총조사 '민족 집단별 인구 변화(SA2)' 공개 서비스에서 오클랜드 동네(SA2)를 받는다.

- 키·요금 없음(ArcGIS 공개 서비스). 인구총조사는 5년마다라 필요할 때만 수동 실행한다(.github/workflows/census.yml).
- 공개 서비스에는 큰 분류 6개(유럽·마오리·태평양·아시아·중동/라틴/아프리카·기타)만 있다. 한국·중국·동남아 등 상세 구분은
  Stats NZ API(키 필요)의 CEN23_ECI_016 에 있어 키를 받으면 추가한다.
- 한 사람이 여러 민족을 답할 수 있어(복수 응답) 분류별 합이 총인구보다 클 수 있다 → 비율은 '응답한 사람 중 그 민족을 답한 비율'.
- 결과: web/public/data/census-akl.json (GeoJSON, 좌표 약 11m 정밀도로 단순화)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx

SERVICE = ("https://services2.arcgis.com/vKb0s8tBIA3bdocZ/arcgis/rest/services/"
           "2023_Census_population_change_by_ethnic_group_and_SA2/FeatureServer/0/query")
ENVELOPE = "174.3,-37.3,175.3,-36.2"  # 오클랜드 광역시(와이헤케 포함)
GROUPS = ["european", "maori", "pacific", "asian", "melaa", "other"]  # VAR_1_17..22 (2023), VAR_1_9..14 (2018)
OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "data" / "census-akl.json"


def convert(feature: dict) -> dict | None:
    """ArcGIS 지오제이슨 한 건 → 화면용 압축 속성. 값이 없는(비공개·소수) 동네는 None."""
    p = feature["properties"]
    try:
        # 비공개·소수 값은 음수(-999 등)로 올 수 있어 0 으로
        g23 = [max(0, int(p[f"VAR_1_{17 + i}"])) for i in range(6)]
        total23 = int(p["VAR_1_24"])
        g18 = [max(0, int(p[f"VAR_1_{9 + i}"])) for i in range(6)]
        total18 = max(0, int(p["VAR_1_16"]))
    except (KeyError, TypeError, ValueError):
        return None
    if total23 <= 0:
        return None
    return {"type": "Feature", "geometry": feature["geometry"],
            "properties": {"c": str(p["SA22023_V1_00"]), "n": p["SA22023_V1_00_NAME"], "t": total23, "g": g23,
                           "t18": total18, "g18": g18}}


def fetch(client: httpx.Client, offset: float) -> dict:
    r = client.get(SERVICE, params={
        "where": "1=1", "geometry": ENVELOPE, "geometryType": "esriGeometryEnvelope", "inSR": 4326, "spatialRel": "esriSpatialRelIntersects",
        "outFields": "SA22023_V1_00,SA22023_V1_00_NAME," + ",".join(f"VAR_1_{i}" for i in list(range(9, 17)) + list(range(17, 25))),
        "outSR": 4326, "returnGeometry": "true", "maxAllowableOffset": offset, "geometryPrecision": 4, "f": "geojson", "resultRecordCount": 2000})
    r.raise_for_status()
    return r.json()


def main() -> int:
    with httpx.Client(timeout=120, headers={"User-Agent": "DailyBriefBot/1.0 (personal project)"}) as c:
        offset = 0.0004
        while True:
            data = fetch(c, offset)
            feats = [f for f in (convert(x) for x in data.get("features", [])) if f]
            body = json.dumps({"type": "FeatureCollection", "source": "Stats NZ 2023 Census (population change by ethnic group and SA2)",
                               "groups": GROUPS, "features": feats}, ensure_ascii=False, separators=(",", ":"))
            print(f"offset={offset} features={len(feats)} size={len(body) / 1e6:.2f}MB", file=sys.stderr)
            if len(body) <= 1_800_000 or offset > 0.004:
                break
            offset *= 2  # 파일이 너무 크면 모양을 더 단순하게
    if not feats:
        print("no features", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(body, encoding="utf-8")
    print(f"wrote {OUT} ({len(feats)} SA2)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
