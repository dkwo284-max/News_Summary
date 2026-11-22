"""세계 군사 긴장도 → web/public/data/tension.json (+ 날짜별 기록 tension-history.json)

- 출처: GDELT DOC 2.0 API (무료·키 없음). 전 세계 온라인 뉴스 가운데 지역별 '군사 충돌 관련 보도'가 차지하는
  비중(%)의 최근 3개월 추이와, 최근 3일 대표 기사 제목을 받는다. GDELT 요청은 5초에 1번 이하로 보낸다.
- 지역 점수(0~100) = 기본 긴장도(전쟁 진행 여부 등 구조적 수준, 아래 HOTSPOTS 의 base) 50% +
  뉴스 신호 50% (최근 7일 보도 비중이 최근 3개월 중 어느 정도 높은지 + 직전 3주 대비 증가율).
- 노출도: 한국·뉴질랜드 각각 지역별 영향 가중치(거리·교역로·동맹·에너지)를 곱해 '하나라도 영향이 올 확률'처럼 합친다.
- 공식 경보가 아니라 뉴스 흐름 기반 참고 지표다. 수집에 실패하면 지난 값을 그대로 두고 stale 표시만 한다.
- AI 호출 없음. 실행: python scripts/tension.py  (GitHub Actions: .github/workflows/tension.yml, 매일)
"""
from __future__ import annotations

import json
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "public" / "data" / "tension.json"
HIST = ROOT / "web" / "public" / "data" / "tension-history.json"
API = "https://api.gdeltproject.org/api/v2/doc/doc"
UA = "DailyBriefBot/1.0 (personal news digest; https://github.com/dkwo284-max/News_Summary)"
GAP = 7.0  # GDELT 요청 간격(초) — 5초에 1번 제한보다 여유 있게

ARMED = '(military OR missile OR airstrike OR troops OR warship OR drone OR artillery OR "armed forces" OR invasion OR shelling)'
# base: 구조적 긴장도(0~100). 전쟁이 진행 중이면 높게, 대치·분쟁 위험이면 중간. 상황이 바뀌면 여기서 고친다.
HOTSPOTS = [
    {"id": "korea", "name": "한반도", "lat": 38.3, "lon": 127.2, "base": 55,
     "q": f'("north korea" OR pyongyang OR dprk OR "korean peninsula") {ARMED}'},
    {"id": "taiwan", "name": "대만해협", "lat": 24.0, "lon": 119.8, "base": 55,
     "q": f'(taiwan OR "taiwan strait") {ARMED}'},
    {"id": "scs", "name": "남중국해", "lat": 12.5, "lon": 114.5, "base": 45,
     "q": f'("south china sea" OR spratly OR "scarborough shoal" OR "second thomas shoal") {ARMED}'},
    {"id": "ukraine", "name": "러시아·우크라이나", "lat": 48.5, "lon": 35.0, "base": 75,
     "q": f'(ukraine OR kyiv OR donbas OR crimea) {ARMED}'},
    {"id": "mideast", "name": "중동 (이스라엘·이란·홍해)", "lat": 31.0, "lon": 40.0, "base": 72,
     "q": f'(israel OR iran OR gaza OR lebanon OR hezbollah OR houthi OR "red sea") {ARMED}'},
    {"id": "southasia", "name": "인도·파키스탄", "lat": 33.5, "lon": 74.5, "base": 35,
     "q": f'(kashmir OR "line of control" OR "india pakistan" OR "pakistan india") {ARMED}'},
    {"id": "pacific", "name": "남태평양", "lat": -9.0, "lon": 162.0, "base": 20,
     "q": f'("solomon islands" OR "pacific islands" OR "papua new guinea" OR vanuatu OR tonga OR fiji) (military OR navy OR "security pact" OR "naval base" OR warship)'},
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


class Gdelt:
    def __init__(self) -> None:
        self.c = httpx.Client(headers={"User-Agent": UA}, timeout=45, follow_redirects=True)
        self.last = 0.0

    def get(self, **params) -> dict | None:
        for k in range(4):
            wait = self.last + GAP - time.time()
            if wait > 0:
                time.sleep(wait)
            self.last = time.time()
            try:
                r = self.c.get(API, params={"format": "json", **params})
                t = r.text.strip()
                if r.status_code == 200 and t.startswith("{"):
                    return json.loads(t)
                print(f"  GDELT {r.status_code}: {t[:90]!r}", file=sys.stderr)
            except (httpx.HTTPError, json.JSONDecodeError) as e:
                print(f"  GDELT 오류: {e}", file=sys.stderr)
            time.sleep(15 * (k + 1))  # 제한에 걸리면 점점 길게 쉰다
        return None


def daily(series: list[dict]) -> list[tuple[str, float]]:
    """GDELT 시계열(15분·하루 단위 모두 가능) → 날짜별 평균"""
    acc: dict[str, list[float]] = {}
    for p in series:
        d = str(p.get("date", ""))[:8]
        if len(d) == 8 and isinstance(p.get("value"), (int, float)):
            acc.setdefault(f"{d[:4]}-{d[4:6]}-{d[6:]}", []).append(float(p["value"]))
    return sorted((d, sum(v) / len(v)) for d, v in acc.items())


def signal(vals: list[float]) -> tuple[float, float] | None:
    """최근 7일 보도 비중의 상대 위치(0~100)와 직전 3주 대비 변화율(%). 데이터가 3주 미만이면 None"""
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


def main() -> int:
    prev = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    prev_hs = {h["id"]: h for h in prev.get("hotspots", [])}
    g = Gdelt()
    hotspots, fails = [], 0
    for hs in HOTSPOTS:
        print(f"· {hs['name']}", file=sys.stderr)
        tl = g.get(query=hs["q"], mode="timelinevol", timespan="3months")
        days = daily(tl["timeline"][0]["data"]) if tl and tl.get("timeline") else []
        arts = g.get(query=f'{hs["q"]} sourcelang:english', mode="artlist", timespan="3days", maxrecords=8, sort="hybridrel")
        if not days:
            fails += 1
            if hs["id"] in prev_hs:   # 실패하면 지난 값 유지
                hotspots.append({**prev_hs[hs["id"]], "stale": True})
                continue
        vals = [v for _, v in days]
        sig = signal(vals)
        s = score(hs["base"], sig)
        # 날짜별 점수(그날까지의 자료로 계산) — 추이 그래프용, 앞 4주는 계산 불가라 비움
        series = []
        for i, (d, v) in enumerate(days):
            sg = signal(vals[: i + 1])
            series.append({"d": d, "v": round(v, 4), "s": score(hs["base"], sg) if sg else None})
        seen, items = set(), []
        for a in (arts or {}).get("articles", []):
            t = (a.get("title") or "").strip()
            if not t or t.lower() in seen:
                continue
            seen.add(t.lower())
            sd = str(a.get("seendate", ""))
            items.append({"title": t[:160], "url": a.get("url", ""), "domain": a.get("domain", ""),
                          "date": f"{sd[:4]}-{sd[4:6]}-{sd[6:8]}" if len(sd) >= 8 else ""})
            if len(items) == 4:
                break
        hotspots.append({"id": hs["id"], "name": hs["name"], "lat": hs["lat"], "lon": hs["lon"], "base": hs["base"],
                         "score": s, "level": level(s), "pct7": round(sig[0]) if sig else None, "chg7": round(sig[1]) if sig else None,
                         "series": series[-91:], "articles": items or prev_hs.get(hs["id"], {}).get("articles", [])})
    if not hotspots or fails == len(HOTSPOTS) and not prev_hs:
        print("GDELT 수집 실패 — 파일을 바꾸지 않음", file=sys.stderr)
        return 1
    if fails == len(HOTSPOTS):
        prev["stale"] = True
        prev["last_try"] = datetime.now(timezone.utc).isoformat(timespec="minutes")
        OUT.write_text(json.dumps(prev, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print("GDELT 전부 실패 — 지난 값 유지(stale)", file=sys.stderr)
        return 0

    scores = {h["id"]: h["score"] for h in hotspots}
    # 세계 지수: 기본 긴장도로 가중한 평균 60% + 가장 뜨거운 곳 40%
    wsum = sum(h["base"] for h in hotspots)
    world = round(0.6 * sum(h["score"] * h["base"] for h in hotspots) / wsum + 0.4 * max(scores.values()), 1)
    # 세계 지수 날짜별 (모든 지역 점수가 있는 날만)
    by_day: dict[str, dict[str, float]] = {}
    for h in hotspots:
        for p in h.get("series", []):
            if p.get("s") is not None:
                by_day.setdefault(p["d"], {})[h["id"]] = p["s"]
    wseries = []
    for d in sorted(by_day):
        row = by_day[d]
        if len(row) == len(hotspots):
            ws = sum(row[h["id"]] * h["base"] for h in hotspots) / wsum
            wseries.append({"d": d, "s": round(0.6 * ws + 0.4 * max(row.values()), 1)})
    ex = exposure(scores)
    today = date.today().isoformat()
    data = {"updated": datetime.now(timezone.utc).isoformat(timespec="minutes"), "source": "GDELT DOC 2.0 (gdeltproject.org)",
            "stale": fails > 0, "world": {"score": world, "level": level(world), "series": wseries[-91:]},
            "hotspots": sorted(hotspots, key=lambda h: -h["score"]), "exposure": ex,
            "levels": [{"min": th, "name": n} for th, n in LEVELS]}
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    hist = json.loads(HIST.read_text(encoding="utf-8")) if HIST.exists() else []
    hist = [x for x in hist if x.get("d") != today] + [{"d": today, "world": world, "kr": ex["kr"]["score"], "nz": ex["nz"]["score"], "hs": scores}]
    HIST.write_text(json.dumps(hist[-400:], ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"세계 {world} ({level(world)}) · 한국 {ex['kr']['score']} · 뉴질랜드 {ex['nz']['score']} · 실패 {fails}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
