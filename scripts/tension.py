"""세계 군사 긴장도 → web/public/data/tension.json (+ 일별 집계 tension-days.json, 날짜별 기록 tension-history.json)

- 출처: GDELT 1.0 일간 사건(Event) 파일 (https://data.gdeltproject.org/events/YYYYMMDD.export.CSV.zip, 무료·키 없음, 정적 파일이라 요청 제한 없음).
  전 세계 뉴스에서 뽑은 '누가 누구에게 무엇을 했나' 사건 가운데 군사적 사건(CAMEO 15 무력 시위, 18 폭행·공격, 19 교전, 20 대량 학살)만 골라
  지역(한반도·대만·남중국해·우크라이나·중동·인도파키스탄·남태평양)별로 하루 사건량(보도 수 가중)을 센다. 그날 전체 사건 수로 나눈 비율이라 뉴스 양이 늘어난 날에 속지 않는다.
  처음 실행하면 최근 90일치를 내려받아 채우고, 이후엔 빠진 날만 받는다(일별 집계는 tension-days.json 에 누적).
- 지역 점수(0~100) = 기본 긴장도(전쟁 진행 여부 등 구조적 수준, 아래 HOTSPOTS 의 base) 50% +
  뉴스 신호 50% (최근 7일 사건 비율이 최근 3개월 중 어느 정도 높은지 + 직전 3주 대비 증가율).
- 노출도: 한국·뉴질랜드 각각 지역별 영향 가중치(거리·교역로·동맹·에너지)를 곱해 '하나라도 영향이 올 확률'처럼 합친다.
- 대표 기사: 군사 사건의 출처 기사 주소에서 영어 제목 꼴(주소 끝 문장)을 뽑는다 — 실제 제목과 다를 수 있다.
- 클릭형 상세: 일별 사건 유형(무력 시위·공격·교전·대량 피해)·맞선 쪽(누가 누구에게)·대표 기사를 tension-detail.json 에 둔다.
  유형별 필터(무력 시위 / 공격·교전 / 대량 피해)는 같은 방식으로 따로 계산한 점수를 detail 에 담는다.
- '왜 올랐나' 문장과 급변 알림은 규칙 기반(AI 없음). 대표 기사의 한국어 제목·상황 요약만 하루 1회 AI(Gemini)로 만들고, 키가 없거나 실패하면 영어 그대로 둔다.
- 공식 경보가 아니라 뉴스 흐름 기반 참고 지표다. 수집에 실패하면 지난 값을 그대로 두고 stale 표시만 한다.
- AI 호출 없음. 실행: python scripts/tension.py  (GitHub Actions: .github/workflows/tension.yml, 매일)
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

import httpx

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "public" / "data" / "tension.json"
HIST = ROOT / "web" / "public" / "data" / "tension-history.json"
DAYS = ROOT / "web" / "public" / "data" / "tension-days.json"
DETAIL = ROOT / "web" / "public" / "data" / "tension-detail.json"
SCHEMA_V = 2
URL = "https://data.gdeltproject.org/events/{d}.export.CSV.zip"
UA = "DailyBriefBot/1.0 (personal news digest; https://github.com/dkwo284-max/News_Summary)"
WINDOW = 92        # 점수 계산에 쓰는 최근 일수
KEEP = 130         # 일별 집계 보관 일수
ART_DAYS = 4       # 대표 기사 후보를 남기는 최근 일수
MIL_ROOTS = ("15", "18", "19", "20")        # 순서 = 유형 인덱스 (무력 시위·공격·교전·대량 피해)
TYPE_NAMES = ["무력 시위", "공격", "교전", "대량 피해"]
PRESETS = {"all": [0, 1, 2, 3], "show": [0], "fight": [1, 2], "mass": [3]}   # 화면 필터: 전체 / 무력 시위 / 공격·교전 / 대량 피해
CTRY = {"CHN": "중국", "TWN": "대만", "USA": "미국", "RUS": "러시아", "UKR": "우크라이나", "ISR": "이스라엘", "IRN": "이란", "PSE": "팔레스타인", "LBN": "레바논",
        "YEM": "예멘", "PRK": "북한", "KOR": "한국", "JPN": "일본", "IND": "인도", "PAK": "파키스탄", "PHL": "필리핀", "VNM": "베트남", "SAU": "사우디", "SYR": "시리아",
        "IRQ": "이라크", "BLR": "벨라루스", "MYS": "말레이시아", "BRN": "브루나이", "ARE": "아랍에미리트", "SLB": "솔로몬제도", "VUT": "바누아투", "FJI": "피지",
        "TON": "통가", "PNG": "파푸아뉴기니", "WSM": "사모아", "KIR": "키리바시", "GBR": "영국", "FRA": "프랑스", "DEU": "독일", "TUR": "튀르키예", "EGY": "이집트",
        "AUS": "호주", "NZL": "뉴질랜드", "IDN": "인도네시아", "THA": "태국", "AFG": "아프가니스탄", "JOR": "요르단", "QAT": "카타르", "KWT": "쿠웨이트", "BHR": "바레인", "OMN": "오만"}
# 화면에 보여 줄 대표 기사 제목 거르기(점수에는 영향 없음): 군사 단어 + 그 지역 단어가 함께 있는 제목만
MIL_WORDS = re.compile(r"\b(military|missile|missiles|strike|strikes|struck|attack|attacks|attacked|troops|navy|naval|warship|warships|ships|drill|drills|exercise|war|army|nuclear|drone|drones|weapons?|forces?|killed|defen[cs]e|border|clash|clashes|invasion|invade|bomb|bombing|bombs|shelling|artillery|ceasefire|offensive|fighter|jets?|aircraft|submarine|coast guard|conflict|hostage|rocket|rockets|airstrikes?|air force|marines|soldiers?)\b", re.I)

# CAMEO 열 번호 (GDELT 1.0 사건 파일, 탭 구분 58열)
A1_COUNTRY, A1_T1, A1_T2, A1_T3 = 7, 12, 13, 14
A2_COUNTRY, A2_T1, A2_T2, A2_T3 = 17, 22, 23, 24
ROOT, N_ARTICLES, GEO_COUNTRY, GEO_LAT, GEO_LON, SOURCEURL = 28, 33, 51, 53, 54, 57

# base: 구조적 긴장도(0~100). 전쟁이 진행 중이면 높게, 대치·분쟁 위험이면 중간. 상황이 바뀌면 여기서 고친다.
# iso: 행위자 국가코드(ISO3), fips: 사건 발생지 국가코드(FIPS), box: 위·경도 상자(남,북,서,동),
# pair: 이 두 나라(그룹)가 서로 맞선 사건도 센다
HOTSPOTS = [
    {"id": "korea", "name": "한반도", "lat": 38.3, "lon": 127.2, "base": 55, "iso": {"PRK"}, "fips": {"KN"}, "box": None, "kw": r"korea|kim jong|pyongyang|seoul|dprk|dmz",
     "pair": ({"KOR"}, {"PRK", "CHN", "RUS", "JPN"})},
    {"id": "taiwan", "name": "대만해협", "lat": 24.0, "lon": 119.8, "base": 55, "iso": {"TWN"}, "fips": {"TW"}, "box": (21.5, 26.5, 117.0, 123.5), "kw": r"taiwan|taipei|strait|pla\b",
     "pair": ({"TWN"}, {"CHN", "USA"})},
    {"id": "scs", "name": "남중국해", "lat": 12.5, "lon": 114.5, "base": 45, "iso": set(), "fips": set(), "box": (3.0, 23.0, 105.0, 121.0), "kw": r"south china sea|spratly|paracel|shoal|philippine|manila|vietnam|scarborough|coast guard|reef",
     "pair": ({"CHN"}, {"PHL", "VNM", "MYS", "BRN"})},
    {"id": "ukraine", "name": "러시아·우크라이나", "lat": 48.5, "lon": 35.0, "base": 75, "iso": {"UKR"}, "fips": {"UP"}, "box": None, "kw": r"ukrain|russia|kyiv|kiev|donbas|crimea|zelensk|putin|moscow|kharkiv|odesa",
     "pair": ({"UKR"}, {"RUS", "BLR"})},
    {"id": "mideast", "name": "중동 (이스라엘·이란·홍해)", "lat": 31.0, "lon": 40.0, "base": 72, "iso": {"ISR", "IRN", "PSE", "LBN", "SYR", "YEM"},
     "fips": {"IS", "IR", "GZ", "WE", "LE", "SY", "YM"}, "box": (12.0, 30.0, 32.0, 45.0), "pair": ({"IRN"}, {"USA", "SAU", "ARE"}),
     "kw": r"israel|iran|gaza|lebanon|hezbollah|houthi|yemen|red sea|syria|hamas|tehran|beirut|idf"},
    {"id": "southasia", "name": "인도·파키스탄", "lat": 33.5, "lon": 74.5, "base": 35, "iso": set(), "fips": set(), "box": (32.0, 37.0, 72.0, 80.0), "kw": r"india|pakistan|kashmir|pahalgam|line of control|islamabad|delhi|indus",
     "pair": ({"IND"}, {"PAK"})},
    {"id": "pacific", "name": "남태평양", "lat": -9.0, "lon": 162.0, "base": 20, "iso": set(), "fips": {"BP", "NH", "PP", "TN", "FJ", "WS", "KR", "NR", "TV"}, "kw": r"solomon|vanuatu|fiji|tonga|papua|samoa|pacific|kiribati|pacific islands",
     "box": None, "pair": ({"CHN"}, {"SLB", "VUT", "FJI", "TON", "PNG", "WSM", "KIR"})},
]
# 한국·뉴질랜드가 각 지역 위기에 얼마나 영향받나 (0~1): 직접 군사 위험·교역로·에너지·동맹 연루를 합친 정성 평가
EXPOSURE = {
    "kr": {"name": "한국", "w": {"korea": 1.0, "taiwan": 0.55, "scs": 0.3, "mideast": 0.3, "ukraine": 0.12, "southasia": 0.03, "pacific": 0.02}},
    "nz": {"name": "뉴질랜드", "w": {"pacific": 0.45, "taiwan": 0.3, "scs": 0.3, "mideast": 0.25, "korea": 0.1, "ukraine": 0.08, "southasia": 0.03}},
}
WHY = {  # 노출 이유 (화면 설명용)
    ("kr", "korea"): "직접 군사 충돌·미사일 위협",
    ("kr", "taiwan"): "주한미군 연루·반도체 공급망·해상 수송로",
    ("kr", "scs"): "원유·수출품 해상 수송로",
    ("kr", "mideast"): "원유 수입 70%가 중동산 — 유가·물가",
    ("kr", "ukraine"): "곡물·에너지 가격, 북러 군사 협력",
    ("nz", "pacific"): "뒷마당 안보·호주와의 방위 협력",
    ("nz", "scs"): "수출입 해상로(대중·대아시아 교역)",
    ("nz", "taiwan"): "최대 교역국 중국·동맹(호주·미국) 연루 가능성",
    ("nz", "mideast"): "연료 수입 의존 — 기름값·물가",
    ("nz", "korea"): "한국 가족·교역(한국은 주요 교역국)",
    ("nz", "ukraine"): "에너지·식량 가격",
}
LEVELS = [(80, "매우 높음"), (65, "높음"), (50, "경계"), (30, "주의"), (0, "낮음")]


def level(s: float) -> str:
    return next(name for th, name in LEVELS if s >= th)


# ── 사건 파일 읽기 ──
def _f(x: str) -> float | None:
    try:
        return float(x)
    except ValueError:
        return None


def _is_mil(row: list[str]) -> bool:
    return any(row[i] in ("MIL", "REB", "SPY") for i in (A1_T1, A1_T2, A1_T3, A2_T1, A2_T2, A2_T3))


def match(hs: dict, row: list[str]) -> bool:
    """이 사건이 지역 hs 의 군사 사건인가 (군사 사건 코드는 호출 전에 걸러짐)"""
    a1, a2, g = row[A1_COUNTRY], row[A2_COUNTRY], row[GEO_COUNTRY]
    where = a1 in hs["iso"] or a2 in hs["iso"] or g in hs["fips"]
    if not where and hs["box"]:
        la, lo = _f(row[GEO_LAT]), _f(row[GEO_LON])
        s, n, w, e = hs["box"]
        where = la is not None and lo is not None and s <= la <= n and w <= lo <= e
    left, right = hs["pair"]
    versus = (a1 in left and a2 in right) or (a2 in left and a1 in right)
    if versus:
        return True
    if not where:
        return False
    # 같은 지역 안의 사건도 군인·반군이 끼었거나 교전·대량 학살일 때만 (범죄·일반 폭행·외교 공방 제외)
    return _is_mil(row) or row[ROOT] in ("19", "20")


def slug_title(url: str) -> str:
    """기사 주소 끝 부분에서 영어 제목 꼴을 뽑는다. 못 뽑으면 빈 문자열"""
    path = unquote(urlparse(url).path).rstrip("/")
    seg = path.rsplit("/", 1)[-1] if path else ""
    seg = re.sub(r"\.(html?|php|aspx?|cms)$", "", seg, flags=re.I)
    seg = re.sub(r"[-_+]+", " ", seg)
    seg = re.sub(r"\b[0-9a-f]{8,}\b|\b\d{5,}\b", " ", seg, flags=re.I).strip()
    words = seg.split()
    alpha = [w for w in words if w.isalpha() and len(w) >= 2]
    if len(alpha) < 4 or len(alpha) < 0.8 * len(words) or words[0].lower() in ("article", "story", "news", "index", "default"):
        return ""
    return (seg[0].upper() + seg[1:])[:140]


NOT_MIL = re.compile(r"\b(bees?|honeybees?|stingers?|shark|crocodile|wild animals?|football|soccer|cricket|rugby|stabbing|stabbed|robbery|murder|rape|tourism|tourists?|wedding|movie|film|concert|recipe)\b", re.I)


def cname(c: str) -> str:
    return CTRY.get(c, c)


def parse_day(text_lines) -> dict:
    """사건 파일 한 날치 → {"t": 전체 사건 수, "r": {지역: {"k": [유형별 가중 합 4개], "p": [[행위자1, 행위자2, 가중 합]...], "a": [[기사수, 제목, 주소, 유형]...]}}}"""
    total = 0
    reg = {h["id"]: {"k": [0.0] * 4, "p": {}, "a": {}} for h in HOTSPOTS}
    for row in csv.reader(text_lines, delimiter="\t", quoting=csv.QUOTE_NONE):
        if len(row) < 58:
            continue
        total += 1
        root = row[ROOT]
        if root not in MIL_ROOTS:
            continue
        ti = MIL_ROOTS.index(root)
        n = _f(row[N_ARTICLES]) or 1.0
        w = 1.0 + min(n, 30.0) ** 0.5
        for hs in HOTSPOTS:
            if not match(hs, row):
                continue
            r = reg[hs["id"]]
            r["k"][ti] += w
            a1, a2 = row[A1_COUNTRY], row[A2_COUNTRY]
            if a1 or a2:
                key = (a1, a2) if (a1 and a2 and a1 != a2) else (a1 or a2, "")
                r["p"][key] = r["p"].get(key, 0.0) + w
            t = slug_title(row[SOURCEURL])
            if t and MIL_WORDS.search(t) and re.search(hs["kw"], t, re.I) and not NOT_MIL.search(t):
                cur = r["a"].get(t.lower())
                if cur is None or n > cur[0]:
                    r["a"][t.lower()] = [int(n), t, row[SOURCEURL], ti]
    out = {}
    for rid, r in reg.items():
        pairs = sorted(r["p"].items(), key=lambda kv: -kv[1])[:4]
        out[rid] = {"k": [round(x, 1) for x in r["k"]], "p": [[a, b, round(v, 1)] for (a, b), v in pairs],
                    "a": sorted(r["a"].values(), key=lambda x: -x[0])[:8]}
    return {"t": total, "r": out}


def fetch_day(client: httpx.Client, day: date) -> dict | None:
    r = client.get(URL.format(d=day.strftime("%Y%m%d")))
    if r.status_code != 200:
        return None
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        with z.open(z.namelist()[0]) as f:
            return parse_day(io.TextIOWrapper(f, encoding="utf-8", errors="replace", newline=""))


def update_days(days: dict, today: date, client: httpx.Client | None = None) -> int:
    """최근 WINDOW 일 중 없는 날을 받아 days 에 채운다. 받은 날짜 수 반환"""
    got = 0
    client = client or httpx.Client(headers={"User-Agent": UA}, timeout=120, follow_redirects=True)
    for k in range(WINDOW, 0, -1):    # 어제까지 (오늘 파일은 아직 없을 수 있음)
        d = today - timedelta(days=k)
        key = d.isoformat()
        if key in days:
            continue
        try:
            rec = fetch_day(client, d)
        except (httpx.HTTPError, zipfile.BadZipFile, OSError) as e:
            print(f"  {key} 받기 실패: {e}", file=sys.stderr)
            continue
        if rec and rec["t"] > 1000:
            days[key] = rec
            got += 1
        else:
            print(f"  {key} 없음", file=sys.stderr)
    for key in sorted(days)[:-KEEP]:
        days.pop(key, None)
    cut = (today - timedelta(days=ART_DAYS + 1)).isoformat()
    for key, rec in days.items():       # 오래된 날은 기사 후보를 3개까지만 남겨 파일을 작게 유지
        if key < cut:
            for r in rec["r"].values():
                r["a"] = r["a"][:3]
    return got


# ── 점수 ──
def signal(vals: list[float]) -> tuple[float, float] | None:
    """최근 7일 비율의 상대 위치(0~100)와 직전 3주 대비 변화율(%). 데이터가 3주 미만이면 None"""
    if len(vals) < 21:
        return None
    roll = [sum(vals[i - 6:i + 1]) / 7 for i in range(6, len(vals))]
    now = roll[-1]
    pct = 100 * (sum(1 for x in roll if x < now) + 0.5 * sum(1 for x in roll if x == now)) / len(roll)   # 같은 값은 중간 순위(평평하거나 0 만 이어진 지역이 최고로 나오지 않게)
    prev = vals[-28:-7] if len(vals) >= 28 else vals[:-7]
    base = sum(prev) / len(prev) if prev else 0
    chg = (now / base - 1) * 100 if base > 0 else 0.0
    return pct, chg


def score(base: float, sig: tuple[float, float] | None) -> float:
    if not sig:
        return float(base)
    pct, chg = sig
    dyn = 0.7 * pct + 0.3 * max(0.0, min(100.0, 50 + chg / 2))
    return round(0.5 * base + 0.5 * dyn, 1)


def exposure(scores: dict[str, float]) -> dict:
    out = {}
    for key, ex in EXPOSURE.items():
        keep, drivers = 1.0, []
        for hid, w in ex["w"].items():
            if hid not in scores:
                continue
            p = 0.6 * w * scores[hid] / 100   # 그 지역 위기가 이 나라에 영향을 줄 정도
            keep *= 1 - p
            drivers.append({"id": hid, "w": w, "contrib": round(p * 100, 1), "why": WHY.get((key, hid), "")})
        s = round((1 - keep) * 100, 1)
        drivers.sort(key=lambda d: -d["contrib"])
        out[key] = {"name": ex["name"], "score": s, "level": level(s), "drivers": drivers}
    return out


def region_values(days: dict, keys: list[str], rid: str, types: list[int]) -> list[float]:
    return [10000.0 * sum(days[k]["r"][rid]["k"][t] for t in types) / max(1, days[k]["t"]) for k in keys]


def build(days: dict, types: list[int] | None = None) -> dict | None:
    """일별 집계 → 점수 묶음(세계·지역·노출도). types: 센 사건 유형 인덱스(기본 전부). 데이터가 모자라면 None"""
    types = types if types is not None else PRESETS["all"]
    keys = sorted(days)[-WINDOW:]
    if len(keys) < 21:
        return None
    hotspots = []
    for hs in HOTSPOTS:
        vals = region_values(days, keys, hs["id"], types)
        series = []
        for i, k in enumerate(keys):
            sg = signal(vals[: i + 1])
            series.append({"d": k, "v": round(vals[i], 4), "s": score(hs["base"], sg) if sg else None})
        sig = signal(vals)
        s = score(hs["base"], sig)
        hotspots.append({"id": hs["id"], "name": hs["name"], "lat": hs["lat"], "lon": hs["lon"], "base": hs["base"],
                         "score": s, "level": level(s), "pct7": round(sig[0]) if sig else None, "chg7": round(sig[1]) if sig else None, "series": series})
    scores = {h["id"]: h["score"] for h in hotspots}
    wsum = sum(h["base"] for h in hotspots)
    world = round(0.6 * sum(h["score"] * h["base"] for h in hotspots) / wsum + 0.4 * max(scores.values()), 1)
    by_day: dict[str, dict[str, float]] = {}
    for h in hotspots:
        for p in h["series"]:
            if p["s"] is not None:
                by_day.setdefault(p["d"], {})[h["id"]] = p["s"]
    wseries = []
    for d in sorted(by_day):
        row = by_day[d]
        if len(row) == len(hotspots):
            ws = sum(row[h["id"]] * h["base"] for h in hotspots) / wsum
            wseries.append({"d": d, "s": round(0.6 * ws + 0.4 * max(row.values()), 1)})
    return {"world": {"score": world, "level": level(world), "series": wseries},
            "hotspots": sorted(hotspots, key=lambda h: -h["score"]), "exposure": exposure(scores)}


# ── 클릭형 상세: 기사·유형·맞선 쪽 ──
def top_articles(days: dict, keys: list[str], rid: str, types: list[int], limit: int) -> list[dict]:
    seen, items = set(), []
    for k in reversed(keys):
        for n, title, url, ti in days[k]["r"][rid]["a"]:
            if ti in types and title.lower() not in seen:
                seen.add(title.lower())
                items.append({"title": title, "url": url, "domain": urlparse(url).netloc.removeprefix("www."), "date": k, "n": n, "type": TYPE_NAMES[ti]})
    return sorted(items, key=lambda x: (-x["n"], x["date"]))[:limit]


def top_pairs(days: dict, keys: list[str], rid: str, limit: int = 3) -> list[dict]:
    acc: dict[tuple[str, str], float] = {}
    for k in keys:
        for a, b, w in days[k]["r"][rid]["p"]:
            acc[(a, b)] = acc.get((a, b), 0.0) + w
    tot = sum(acc.values()) or 1.0
    return [{"a": cname(a), "b": cname(b) if b else "", "share": round(100 * w / tot)} for (a, b), w in sorted(acc.items(), key=lambda kv: -kv[1])[:limit]]


def type_mix(days: dict, keys: list[str], rid: str) -> list[int]:
    tot = [sum(days[k]["r"][rid]["k"][t] for k in keys) for t in range(4)]
    s = sum(tot) or 1.0
    return [round(100 * x / s) for x in tot]


def why_text(days: dict, keys: list[str], hs: dict) -> str:
    """점수가 그렇게 움직인 이유를 한 문장으로 (규칙 기반)"""
    rid = hs["id"]
    last7, recent3 = keys[-7:], keys[-3:]
    chg = hs.get("chg7")
    parts = []
    if chg is not None:
        parts.append(f"최근 7일 군사 사건이 직전 3주보다 {abs(chg)}% {'늘었어요' if chg > 0 else '줄었어요' if chg < 0 else '비슷해요'}")
    mix = type_mix(days, last7, rid)
    if sum(mix):
        parts.append(f"주로 {TYPE_NAMES[max(range(4), key=lambda i: mix[i])]}({max(mix)}%)")
    pr = top_pairs(days, last7, rid, 1)
    if pr:
        parts.append(f"가장 많이 등장한 쪽은 {pr[0]['a']}{'→' + pr[0]['b'] if pr[0]['b'] else ''}")
    art = top_articles(days, recent3, rid, [0, 1, 2, 3], 1)
    text = ", ".join(parts)
    if art:
        text += f". 가장 크게 보도된 소식: “{art[0]['title']}” ({art[0]['date'][5:].replace('-', '/')}, 기사 {art[0]['n']}건)"
    return text


def detail(days: dict, default: dict) -> dict:
    """tension-detail.json: 일별 유형·맞선 쪽·기사, 유형 필터별 점수"""
    keys = sorted(days)[-WINDOW:]
    out_days = {h["id"]: {} for h in HOTSPOTS}
    for k in keys:
        for hs in HOTSPOTS:
            r = days[k]["r"][hs["id"]]
            out_days[hs["id"]][k] = {"k": r["k"], "p": [[cname(a), cname(b) if b else "", w] for a, b, w in r["p"][:3]], "a": r["a"][:3] if k < keys[-ART_DAYS] else r["a"][:6]}
    presets = {}
    for name, types in PRESETS.items():
        if name == "all":
            continue
        b = build(days, types)
        if b:
            presets[name] = {"world": b["world"], "exposure": b["exposure"],
                             "hotspots": [{"id": h["id"], "score": h["score"], "level": h["level"], "pct7": h["pct7"], "chg7": h["chg7"],
                                           "series": [{"d": p["d"], "s": p["s"]} for p in h["series"]]} for h in b["hotspots"]]}
    return {"v": SCHEMA_V, "data_through": keys[-1], "type_names": TYPE_NAMES, "days": out_days, "presets": presets}


def add_context(days: dict, res: dict) -> None:
    """res(기본 묶음)에 지역별 대표 기사·유형 구성·'왜 올랐나' 문장, 급변 알림을 덧붙인다"""
    keys = sorted(days)[-WINDOW:]
    alerts = []
    for h in res["hotspots"]:
        rid = h["id"]
        h["articles"] = top_articles(days, keys[-ART_DAYS:], rid, [0, 1, 2, 3], 4)
        h["mix"] = type_mix(days, keys[-7:], rid)
        h["pairs"] = top_pairs(days, keys[-14:], rid, 3)
        ss = [p["s"] for p in h["series"] if p["s"] is not None]
        d7 = round(ss[-1] - ss[-8], 1) if len(ss) >= 8 else None
        h["delta7"] = d7
        h["why"] = why_text(days, keys, h)
        if d7 is not None and abs(d7) >= 10:
            alerts.append({"id": rid, "name": h["name"], "delta7": d7, "score": h["score"], "level": h["level"], "text": h["why"]})
    alerts.sort(key=lambda a: -abs(a["delta7"]))
    res["alerts"] = alerts


# ── 한국어 제목·상황 요약 (하루 1회 AI, 실패해도 영어 그대로) ──
KO_SCHEMA = {"type": "object", "properties": {"regions": {"type": "array", "items": {"type": "object", "properties": {
    "id": {"type": "string"}, "situation_ko": {"type": "string"},
    "items": {"type": "array", "items": {"type": "object", "properties": {"i": {"type": "integer"}, "title_ko": {"type": "string"}}, "required": ["i", "title_ko"], "additionalProperties": False}}},
    "required": ["id", "situation_ko", "items"], "additionalProperties": False}}}, "required": ["regions"], "additionalProperties": False}
KO_SYSTEM = ("너는 안보·군사 뉴스를 한국어로 옮기는 편집자다. 입력은 영어 기사 주소에서 뽑은 제목 조각이라 실제 제목과 다를 수 있다. "
             "title_ko 는 그 조각을 자연스러운 한국어 제목 한 줄(40자 이내)로 옮긴다. 조각에 없는 사실·숫자·장소를 지어내지 않는다. "
             "situation_ko 는 그 지역에서 지금 무슨 일이 있는지 제목들에서 확인되는 사실만으로 2문장 이내(120자 이내)로 쓴다. 단정·예측 금지, 확인되지 않으면 '대표 기사 기준'이라고 밝힌다.")


def translate(res: dict, prev: dict, llm) -> int:
    """지역별 대표 기사 제목을 한국어로. 이미 번역한 주소는 건너뛰고, 새 기사가 있을 때만 요청 1회. 반환: 새로 번역한 개수"""
    done = {a["url"]: a["title_ko"] for h in prev.get("hotspots", []) for a in h.get("articles", []) if a.get("title_ko")}
    prev_sit = {h["id"]: h.get("situation_ko", "") for h in prev.get("hotspots", [])}
    need = []
    for h in res["hotspots"]:
        for a in h["articles"]:
            if a["url"] in done:
                a["title_ko"] = done[a["url"]]
        h["situation_ko"] = prev_sit.get(h["id"], "")
        if any("title_ko" not in a for a in h["articles"]):
            need.append(h)
    if not need or llm is None:
        return 0
    lines = []
    for h in need:
        lines.append(f"[{h['id']}] {h['name']}")
        lines += [f"  {i}. {a['title']} (기사 {a['n']}건)" for i, a in enumerate(h["articles"])]
    try:
        out = llm.json_call(task="summary", system=KO_SYSTEM, user="\n".join(lines), schema=KO_SCHEMA, max_tokens=6000)
    except Exception as e:  # noqa: BLE001 — 번역 실패가 점수 갱신을 막지 않게
        print(f"  한국어 요약 실패: {type(e).__name__}: {e}", file=sys.stderr)
        return 0
    by_id = {h["id"]: h for h in need}
    n = 0
    for r in out.get("regions", []):
        h = by_id.get(r.get("id"))
        if not h:
            continue
        if (r.get("situation_ko") or "").strip():
            h["situation_ko"] = r["situation_ko"].strip()[:200]
        for it in r.get("items", []):
            i = it.get("i")
            if isinstance(i, int) and 0 <= i < len(h["articles"]) and (it.get("title_ko") or "").strip():
                h["articles"][i]["title_ko"] = it["title_ko"].strip()[:100]
                n += 1
    return n


def _make_llm():
    """AI 키가 있을 때만 요청 1회짜리 LLM 을 만든다 (config.yaml 의 모델 설정 재사용)"""
    try:
        from common import load_config
        from llm import make_llm
        llm = make_llm(load_config())
        llm.max_requests = 1
        return llm
    except Exception as e:  # noqa: BLE001 — 키 없음 등
        print(f"  AI 사용 안 함: {e}", file=sys.stderr)
        return None


def load_days() -> dict:
    if DAYS.exists():
        d = json.loads(DAYS.read_text(encoding="utf-8"))
        if d.get("v") == SCHEMA_V:
            return d.get("days", {})
    return {}   # 예전 형식이면 새로 받는다


def main(today: date | None = None, client: httpx.Client | None = None, llm="auto") -> int:
    today = today or datetime.now(timezone.utc).date()
    days = load_days()
    got = update_days(days, today, client)
    DAYS.write_text(json.dumps({"v": SCHEMA_V, "days": days}, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    res = build(days)
    prev = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    if res is None:
        print(f"사건 파일 {len(days)}일치뿐이라 점수를 못 만듦(21일 이상 필요) — 지난 값 유지", file=sys.stderr)
        if prev:
            prev["stale"] = True
            prev["last_try"] = datetime.now(timezone.utc).isoformat(timespec="minutes")
            OUT.write_text(json.dumps(prev, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            return 0
        return 1
    add_context(days, res)
    llm = _make_llm() if llm == "auto" else llm
    n_ko = translate(res, prev, llm)
    last = max(days)
    stale = (today - date.fromisoformat(last)).days > 3   # 최근 사흘 넘게 새 파일이 없으면 오래된 값
    data = {"updated": datetime.now(timezone.utc).isoformat(timespec="minutes"), "data_through": last, "source": "GDELT 1.0 사건 파일 (gdeltproject.org)",
            "stale": stale, **res, "levels": [{"min": th, "name": n} for th, n in LEVELS]}
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    DETAIL.write_text(json.dumps(detail(days, res), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    ex = res["exposure"]
    hist = json.loads(HIST.read_text(encoding="utf-8")) if HIST.exists() else []
    hist = [x for x in hist if x.get("d") != today.isoformat()] + [{"d": today.isoformat(), "world": res["world"]["score"], "kr": ex["kr"]["score"], "nz": ex["nz"]["score"],
                                                                     "hs": {h["id"]: h["score"] for h in res["hotspots"]}}]
    HIST.write_text(json.dumps(hist[-400:], ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"새로 받은 날 {got} · 보유 {len(days)}일 · 세계 {res['world']['score']} ({res['world']['level']}) · 한국 {ex['kr']['score']} · 뉴질랜드 {ex['nz']['score']} · 급변 {len(res['alerts'])}곳 · 한국어 제목 {n_ko}개", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
