"""세계 군사 긴장도 → web/public/data/tension.json (+ 일별 집계 tension-days.json, 날짜별 기록 tension-history.json)

- 출처: GDELT 1.0 일간 사건(Event) 파일 (https://data.gdeltproject.org/events/YYYYMMDD.export.CSV.zip, 무료·키 없음, 정적 파일이라 요청 제한 없음).
  전 세계 뉴스에서 뽑은 '누가 누구에게 무엇을 했나' 사건 가운데 군사적 사건(CAMEO 15 무력 시위, 18 폭행·공격, 19 교전, 20 대량 학살)만 골라
  지역(한반도·대만·남중국해·우크라이나·중동·인도파키스탄·남태평양)별로 하루 사건량(보도 수 가중)을 센다. 그날 전체 사건 수로 나눈 비율이라 뉴스 양이 늘어난 날에 속지 않는다.
  처음 실행하면 최근 90일치를 내려받아 채우고, 이후엔 빠진 날만 받는다(일별 집계는 tension-days.json 에 누적).
- 지역 점수(0~100) = 기본 긴장도(전쟁 진행 여부 등 구조적 수준, 아래 HOTSPOTS 의 base) 50% +
  뉴스 신호 50% (최근 7일 사건 비율이 최근 3개월 중 어느 정도 높은지 + 직전 3주 대비 증가율).
- 노출도: 한국·뉴질랜드 각각 지역별 영향 가중치(거리·교역로·동맹·에너지)를 곱해 '하나라도 영향이 올 확률'처럼 합친다.
- 대표 기사: 군사 사건의 출처 기사 주소에서 영어 제목 꼴(주소 끝 문장)을 뽑는다 — 실제 제목과 다를 수 있다.
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
URL = "https://data.gdeltproject.org/events/{d}.export.CSV.zip"
UA = "DailyBriefBot/1.0 (personal news digest; https://github.com/dkwo284-max/News_Summary)"
WINDOW = 92        # 점수 계산에 쓰는 최근 일수
KEEP = 130         # 일별 집계 보관 일수
ART_DAYS = 4       # 대표 기사 후보를 남기는 최근 일수
MIL_ROOTS = {"15", "18", "19", "20"}
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


def parse_day(text_lines) -> dict:
    """사건 파일 한 날치 → {"t": 전체 사건 수, "r": {지역: 가중 합}, "a": {지역: [[기사수, 제목, 주소], ...]}}"""
    total = 0
    reg = {h["id"]: 0.0 for h in HOTSPOTS}
    arts: dict[str, dict[str, list]] = {h["id"]: {} for h in HOTSPOTS}
    for row in csv.reader(text_lines, delimiter="\t", quoting=csv.QUOTE_NONE):
        if len(row) < 58:
            continue
        total += 1
        if row[ROOT] not in MIL_ROOTS:
            continue
        n = _f(row[N_ARTICLES]) or 1.0
        w = 1.0 + min(n, 30.0) ** 0.5
        for hs in HOTSPOTS:
            if match(hs, row):
                reg[hs["id"]] += w
                t = slug_title(row[SOURCEURL])
                if t and MIL_WORDS.search(t) and re.search(hs["kw"], t, re.I):
                    cur = arts[hs["id"]].get(t.lower())
                    if cur is None or n > cur[0]:
                        arts[hs["id"]][t.lower()] = [int(n), t, row[SOURCEURL]]
    return {"t": total, "r": {k: round(v, 1) for k, v in reg.items()},
            "a": {k: sorted(v.values(), key=lambda x: -x[0])[:6] for k, v in arts.items()}}


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
    for key, rec in days.items():
        if key < cut:
            rec.pop("a", None)   # 오래된 날의 기사 후보는 지워 파일을 작게 유지
    return got


# ── 점수 ──
def signal(vals: list[float]) -> tuple[float, float] | None:
    """최근 7일 비율의 상대 위치(0~100)와 직전 3주 대비 변화율(%). 데이터가 3주 미만이면 None"""
    if len(vals) < 21:
        return None
    roll = [sum(vals[i - 6:i + 1]) / 7 for i in range(6, len(vals))]
    now = roll[-1]
    pct = 100 * sum(1 for x in roll if x <= now) / len(roll)
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


def build(days: dict, prev_hs: dict | None = None) -> dict | None:
    """일별 집계 → tension.json 내용. 데이터가 모자라면 None"""
    keys = sorted(days)[-WINDOW:]
    if len(keys) < 21:
        return None
    hotspots = []
    for hs in HOTSPOTS:
        vals = [10000.0 * days[k]["r"].get(hs["id"], 0.0) / max(1, days[k]["t"]) for k in keys]
        series = []
        for i, k in enumerate(keys):
            sg = signal(vals[: i + 1])
            series.append({"d": k, "v": round(vals[i], 4), "s": score(hs["base"], sg) if sg else None})
        sig = signal(vals)
        s = score(hs["base"], sig)
        seen, items = set(), []
        for k in reversed(keys[-ART_DAYS:]):
            for n, title, url in days[k].get("a", {}).get(hs["id"], []):
                if title.lower() in seen:
                    continue
                seen.add(title.lower())
                items.append({"title": title, "url": url, "domain": urlparse(url).netloc.removeprefix("www."), "date": k, "n": n})
        items = sorted(items, key=lambda x: (-x["n"], x["date"]))[:4]
        hotspots.append({"id": hs["id"], "name": hs["name"], "lat": hs["lat"], "lon": hs["lon"], "base": hs["base"],
                         "score": s, "level": level(s), "pct7": round(sig[0]) if sig else None, "chg7": round(sig[1]) if sig else None,
                         "series": series, "articles": items})
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


def main(today: date | None = None, client: httpx.Client | None = None) -> int:
    today = today or datetime.now(timezone.utc).date()
    days = json.loads(DAYS.read_text(encoding="utf-8")) if DAYS.exists() else {}
    got = update_days(days, today, client)
    DAYS.write_text(json.dumps(days, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8")
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
    last = max(days)
    stale = (today - date.fromisoformat(last)).days > 3   # 최근 사흘 넘게 새 파일이 없으면 오래된 값
    data = {"updated": datetime.now(timezone.utc).isoformat(timespec="minutes"), "data_through": last, "source": "GDELT 1.0 사건 파일 (gdeltproject.org)",
            "stale": stale, **res, "levels": [{"min": th, "name": n} for th, n in LEVELS]}
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    ex = res["exposure"]
    hist = json.loads(HIST.read_text(encoding="utf-8")) if HIST.exists() else []
    hist = [x for x in hist if x.get("d") != today.isoformat()] + [{"d": today.isoformat(), "world": res["world"]["score"], "kr": ex["kr"]["score"], "nz": ex["nz"]["score"],
                                                                     "hs": {h["id"]: h["score"] for h in res["hotspots"]}}]
    HIST.write_text(json.dumps(hist[-400:], ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"새로 받은 날 {got} · 보유 {len(days)}일 · 세계 {res['world']['score']} ({res['world']['level']}) · 한국 {ex['kr']['score']} · 뉴질랜드 {ex['nz']['score']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
