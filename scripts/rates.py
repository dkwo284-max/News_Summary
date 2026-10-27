"""기준금리 비교: 뉴질랜드(OCR)·한국(기준금리)·미국(연방기금 목표) — 키·요금 없음.

- BIS 중앙은행 정책금리(일별, 보통 1주 정도 늦게 반영): 세 나라 현재 값·최근 변경·1년 전 값
- 미국은 FRED 의 목표 범위(DFEDTARL~DFEDTARU)가 더 빨리 반영돼 범위와 함께 우선 사용
- RBNZ·한국은행 사이트는 GitHub 실행 환경에서 막히거나(403) 키가 필요해 쓰지 않는다.

    python scripts/rates.py     # 점검용 출력
"""
from __future__ import annotations

import csv
import io
import json
from datetime import date, timedelta

import httpx

from common import log

BIS_URL = "https://stats.bis.org/api/v1/data/WS_CBPOL/D.NZ+KR+US/all"
FRED_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}"
COUNTRIES = {"NZ": ("뉴질랜드", "OCR"), "KR": ("한국", "기준금리"), "US": ("미국", "연방기금 목표")}


def summarize_series(points: list[tuple[str, float]], today: date) -> dict | None:
    """날짜순 (날짜, 값) → 현재 값·기준일·최근 변경(날짜·이전 값)·1년 전 값."""
    pts = sorted(p for p in points if p[1] is not None)
    if not pts:
        return None
    as_of, value = pts[-1]
    out = {"value": value, "as_of": as_of}
    for d, v in reversed(pts):
        if v != value:
            nxt = next(x for x in pts if x[0] > d)  # 바뀐 첫날
            out["changed_on"], out["previous"] = nxt[0], v
            break
    year_ago = (today - timedelta(days=365)).isoformat()
    old = [v for d, v in pts if d <= year_ago]
    if old:
        out["year_ago"] = old[-1]
    return out


def parse_bis(text: str) -> dict[str, list[tuple[str, float]]]:
    out: dict[str, list[tuple[str, float]]] = {}
    for r in csv.DictReader(io.StringIO(text)):
        try:
            out.setdefault(r["REF_AREA"], []).append((r["TIME_PERIOD"], float(r["OBS_VALUE"])))
        except (KeyError, ValueError):
            continue
    return out


def parse_fred(text: str) -> list[tuple[str, float]]:
    rows = list(csv.reader(io.StringIO(text)))[1:]
    pts = []
    for row in rows:
        try:
            pts.append((row[0], float(row[1])))
        except (IndexError, ValueError):
            continue
    return pts


def fetch_rates(client: httpx.Client, today: date | None = None) -> dict | None:
    today = today or date.today()
    start = (today - timedelta(days=500)).isoformat()
    series: dict[str, list[tuple[str, float]]] = {}
    try:
        r = client.get(BIS_URL, params={"startPeriod": start, "format": "csv"})
        r.raise_for_status()
        series = parse_bis(r.text)
    except Exception as e:  # noqa: BLE001
        log.warning("BIS policy rates failed: %s", e)
    out = {}
    for code, (name, label) in COUNTRIES.items():
        s = summarize_series(series.get(code, []), today)
        if s:
            out[code] = {"name": name, "label": label, **s, "source": "BIS"}
    # 미국: FRED 목표 범위(상단·하단)가 더 최신이면 그 값을 쓴다
    try:
        upper = [p for p in parse_fred(client.get(FRED_URL.format(sid="DFEDTARU")).text) if p[0] >= start]
        lower = dict(p for p in parse_fred(client.get(FRED_URL.format(sid="DFEDTARL")).text) if p[0] >= start)
        mid = [(d, round((u + lower[d]) / 2, 3)) for d, u in upper if d in lower]
        s = summarize_series(mid, today)
        if s and (not out.get("US") or s["as_of"] >= out["US"]["as_of"]):
            last = max(upper)[0]
            out["US"] = {"name": "미국", "label": "연방기금 목표", **s, "source": "FRED",
                         "range": [lower[last], dict(upper)[last]]}
    except Exception as e:  # noqa: BLE001
        log.warning("FRED fed funds failed: %s", e)
    if not out:
        return None
    log.info("policy rates: %s", {k: (v["value"], v["as_of"]) for k, v in out.items()})
    return {"updated_at": today.isoformat(), "rates": out}


if __name__ == "__main__":
    import logging

    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
    with httpx.Client(timeout=40, follow_redirects=True) as c:
        print(json.dumps(fetch_rates(c), ensure_ascii=False, indent=1))
