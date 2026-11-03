"""상세 민족 구성: Stats NZ 데이터 탐색기 API(무료 구독 키 필요, 환경변수 STATSNZ_API_KEY)에서 2023·2018 인구총조사 상세 분류를 받는다.

두 표를 쓴다 (둘 다 '복수 응답' 기준 — 한 사람이 여러 민족을 답하면 각각에 센다):
  - CEN23_ECI_016  동네(SA2) × 상세 3단계 (한국인·일본인·중국인·동남아·인도·스리랑카·중동·라틴아메리카·아프리카·유럽 하위 등)
        → web/public/data/census-akl.json 의 각 동네 properties.d(2023)·d18(2018) 배열 (헤더 codes 순서)
  - CEN23_ECI_018  지역위원회(local board) 21곳 × 상세 4단계 (미국인·캐나다인·러시아인·아랍·이란·브라질·멕시코 등)
        → web/public/data/census-akl-detail.json
키는 요청 헤더로만 보내고 출력·저장하지 않는다.
"""
from __future__ import annotations

import csv
import io
import json
import os
import sys
import time
from pathlib import Path

import httpx

API = "https://api.data.stats.govt.nz/rest/data/STATSNZ,{flow},1.0/{key}"
DATA = Path(__file__).resolve().parent.parent / "web" / "public" / "data"

# 동네 표(3단계) 코드 — 화면의 분류는 web/src/ethmap.ts 의 CATEGORIES 가 이 코드들을 합산한다
SA2_CODES = ["7777", "1", "111", "100", "121", "122", "123", "124", "125", "126", "127", "128", "129",
             "2", "3", "4", "400", "410", "411", "412", "413", "414", "421", "431", "441", "442", "443", "444",
             "5", "511", "521", "531", "6", "9"]

# 지역위원회 표(4단계) — (그룹, 한국어 이름, 코드). 총인구 코드는 777777
BOARDS = ["07601", "07602", "07603", "07604", "07605", "07606", "07607", "07608", "07609", "07610", "07611",
          "07612", "07613", "07614", "07615", "07616", "07617", "07618", "07619", "07620", "07621", "076"]
BOARD_NAMES = {  # 2023 Census 지역위원회 코드 → 이름 (코드표 CL_CEN23_GEO_008 의 이름에서 'Local Board Area' 뺀 것)
    "07601": "Rodney", "07602": "Hibiscus and Bays", "07603": "Upper Harbour", "07604": "Kaipātiki", "07605": "Devonport-Takapuna",
    "07606": "Henderson-Massey", "07607": "Waitākere Ranges", "07608": "Aotea/Great Barrier", "07609": "Waiheke", "07610": "Waitematā",
    "07611": "Whau", "07612": "Albert-Eden", "07613": "Puketāpapa", "07614": "Ōrākei", "07615": "Maungakiekie-Tāmaki", "07616": "Howick",
    "07617": "Māngere-Ōtāhuhu", "07618": "Ōtara-Papatoetoe", "07619": "Manurewa", "07620": "Papakura", "07621": "Franklin", "076": "오클랜드 전체",
}
CATALOG = [
    ("북미·유럽", [("미국인", "12943"), ("캐나다인", "12945"), ("영국(잉글랜드)", "12114"), ("아일랜드", "12116"), ("스코틀랜드", "12119"),
                  ("독일", "12711"), ("네덜란드", "12211"), ("프랑스", "12924"), ("이탈리아", "12611"), ("스페인", "12939"),
                  ("러시아", "12935"), ("폴란드", "12411"), ("그리스", "12311"), ("남아공 유럽계", "12948"), ("아프리카너", "12949")]),
    ("중동", [("아랍", "51112"), ("이란·페르시아", "51115"), ("터키", "51127"), ("이스라엘·유대", "51117"), ("이라크", "51116"),
             ("레바논", "51120"), ("이집트", "51114"), ("쿠르드", "51119"), ("시리아", "51125")]),
    ("남미·카리브", [("브라질", "52113"), ("멕시코", "52123"), ("아르헨티나", "52111"), ("칠레", "52114"), ("콜롬비아", "52115"),
                  ("페루", "52127"), ("카리브", "53118"), ("자메이카", "53113")]),
    ("아프리카", [("나이지리아", "53115"), ("케냐", "53114"), ("소말리아", "53119"), ("에티오피아", "53121"), ("가나", "53122"), ("수단", "53125")]),
    ("아시아 세부", [("대만", "42116"), ("홍콩 중국계", "42111"), ("필리핀", "41111"), ("베트남", "41311"), ("태국", "41415"), ("인도네시아", "41412"),
                  ("말레이", "41414"), ("캄보디아", "41211"), ("미얀마", "41411"), ("네팔", "44413"), ("파키스탄", "44414"), ("방글라데시", "44412"),
                  ("펀자브", "43115"), ("시크", "43116"), ("스리랑카 신할라", "44111"), ("아프간", "44411"), ("몽골", "44419")]),
]


def parse_csv(text: str) -> dict[tuple[str, str, str], int]:
    """SDMX CSV → {(연도, 지역코드, 민족코드): 인원}. 값이 비었거나 음수(비공개)면 0."""
    out: dict[tuple[str, str, str], int] = {}
    rows = csv.reader(io.StringIO(text))
    next(rows, None)
    for r in rows:
        if len(r) < 7:
            continue
        try:
            v = max(0, int(float(r[6]))) if r[6].strip() else 0
        except ValueError:
            v = 0
        out[(r[1], r[2], r[3])] = v
    return out


def fetch(client: httpx.Client, flow: str, years: list[str], geos: list[str], eths: list[str], chunk: int = 60) -> dict[tuple[str, str, str], int]:
    out: dict[tuple[str, str, str], int] = {}
    for i in range(0, len(geos), chunk):
        key = f"{'+'.join(years)}.{'+'.join(geos[i:i + chunk])}.{'+'.join(eths)}.99.99"
        for attempt in range(4):
            r = client.get(API.format(flow=flow, key=key), headers={"Accept": "application/vnd.sdmx.data+csv;version=1.0.0"})
            if r.status_code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(5 * (attempt + 1))
                continue
            r.raise_for_status()
            break
        out.update(parse_csv(r.text))
        time.sleep(0.6)
    return out


def build_sa2(client: httpx.Client) -> int:
    path = DATA / "census-akl.json"
    fc = json.loads(path.read_text(encoding="utf-8"))
    geos = [f["properties"]["c"] for f in fc["features"]]
    got = fetch(client, "CEN23_ECI_016", ["2018", "2023"], geos, SA2_CODES)
    for f in fc["features"]:
        p = f["properties"]
        p["d"] = [got.get(("2023", p["c"], c), 0) for c in SA2_CODES]
        p["d18"] = [got.get(("2018", p["c"], c), 0) for c in SA2_CODES]
        p["t"] = p["d"][0] or p["t"]       # 총 응답자(7777)
        p["t18"] = p["d18"][0] or p["t18"]
    fc["codes"] = SA2_CODES
    path.write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    nz = sum(1 for f in fc["features"] if f["properties"]["d"][SA2_CODES.index("443")] > 0)
    print(f"SA2: {len(geos)} areas, Korean>0 in {nz}", file=sys.stderr)
    return len(geos)


def build_boards(client: httpx.Client) -> None:
    eths = ["777777"] + [c for _, items in CATALOG for _, c in items]
    got = fetch(client, "CEN23_ECI_018", ["2023"], BOARDS, eths)
    boards = [{"c": b, "n": BOARD_NAMES.get(b, b)} for b in BOARDS]
    out = {"year": 2023, "source": "Stats NZ 2023 Census (CEN23_ECI_018, 지역위원회 단위)", "boards": boards,
           "total": [got.get(("2023", b, "777777"), 0) for b in BOARDS],
           "groups": [{"label": g, "items": [{"label": lab, "code": c, "v": [got.get(("2023", b, c), 0) for b in BOARDS]} for lab, c in items]}
                      for g, items in CATALOG]}
    (DATA / "census-akl-detail.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"boards: {len(BOARDS)} x {len(eths) - 1} origins", file=sys.stderr)


def main() -> int:
    key = os.environ.get("STATSNZ_API_KEY", "").strip()
    if not key:
        print("STATSNZ_API_KEY 가 없습니다", file=sys.stderr)
        return 1
    with httpx.Client(timeout=120, headers={"Ocp-Apim-Subscription-Key": key, "User-Agent": "DailyBriefBot/1.0 (personal project)"}) as c:
        build_sa2(c)
        build_boards(c)
    return 0


if __name__ == "__main__":
    sys.exit(main())
