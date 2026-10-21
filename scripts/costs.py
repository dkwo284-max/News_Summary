"""오클랜드 정착 비용판: 정부 공개 데이터에서 렌트·유가를 가져온다 (키 불필요).

- 렌트: Tenancy Services 렌트 보증금 데이터(지역별 월간 CSV). 새로 맺은 임대차 보증금 기준 주간 렌트.
  파일 이름이 매달 바뀌어서(예: detailed-monthly-tla-tenancy-october.csv) 안내 페이지에서 링크를 찾는다.
- 유가: MBIE 주간 유가 모니터링 CSV의 'Board price'(주유소 게시 가격, 전국 평균, c/L).

    python scripts/costs.py     # 결과 출력 (점검용)
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
from datetime import date

import httpx

from common import load_config, log

RENT_PAGE = "https://www.tenancy.govt.nz/about-tenancy-services/data-and-statistics/rental-bond-data/"
FUEL_CSV = "https://www.mbie.govt.nz/assets/Data-Files/Energy/Weekly-fuel-price-monitoring/weekly-table.csv"


def _num(s: str) -> float | None:
    try:
        return float(str(s).replace(",", "").strip())
    except ValueError:
        return None


def parse_rent(csv_text: str, location: str = "Auckland") -> dict | None:
    rows = [r for r in csv.DictReader(io.StringIO(csv_text)) if r.get("Location", "").strip() == location]
    rows = [r for r in rows if _num(r.get("Median Rent", "")) is not None]
    if not rows:
        return None
    rows.sort(key=lambda r: r["Time Frame"])
    last = rows[-1]
    month = last["Time Frame"][:7]
    year_ago = f"{int(month[:4]) - 1}{month[4:]}"
    prev = next((r for r in rows if r["Time Frame"].startswith(year_ago)), None)
    median = _num(last["Median Rent"])
    out = {
        "month": month,
        "median": median,
        "lower": _num(last.get("Lower Quartile Rent", "")),
        "upper": _num(last.get("Upper Quartile Rent", "")),
        "source": "Tenancy Services (신규 임대차 보증금 기준)",
        "url": RENT_PAGE,
    }
    if prev and _num(prev["Median Rent"]):
        out["yoy_pct"] = round((median / _num(prev["Median Rent"]) - 1) * 100, 1)
    return out


def parse_fuel(csv_text: str) -> dict | None:
    latest: dict[str, list[tuple[str, float]]] = {}
    for r in csv.DictReader(io.StringIO(csv_text)):
        if r.get("Variable") != "Board price" or r.get("Fuel") not in ("Regular Petrol", "Diesel", "Premium Petrol 95R"):
            continue
        v = _num(r.get("Value", ""))
        if v is not None:
            latest.setdefault(r["Fuel"], []).append((r["Date"], v))
    if "Regular Petrol" not in latest:
        return None
    out = {"source": "MBIE 주간 유가 모니터링 (전국 평균 게시 가격)", "url": FUEL_CSV.rsplit("/", 1)[0]}
    for fuel, key in (("Regular Petrol", "petrol91"), ("Premium Petrol 95R", "petrol95"), ("Diesel", "diesel")):
        series = sorted(latest.get(fuel, []))
        if not series:
            continue
        d, v = series[-1]
        item = {"date": d, "nzd_per_l": round(v / 100, 2)}
        if len(series) > 1:
            item["wow_cents"] = round(v - series[-2][1], 1)
        out[key] = item
    return out


def fetch_costs(cfg: dict, client: httpx.Client | None = None) -> dict:
    own = client is None
    client = client or httpx.Client(timeout=60, follow_redirects=True, headers={"User-Agent": cfg["fetch"]["user_agent"]})
    out: dict = {"updated_at": date.today().isoformat()}
    try:
        try:
            page = client.get(RENT_PAGE).text
            m = re.search(r'href="([^"]*detailed-monthly-tla-tenancy[^"]*\.csv[^"]*)"', page, re.I)
            if m:
                url = m.group(1) if m.group(1).startswith("http") else "https://www.tenancy.govt.nz" + m.group(1)
                out["rent"] = parse_rent(client.get(url).text, cfg.get("costs", {}).get("rent_location", "Auckland"))
        except Exception as e:  # noqa: BLE001
            log.warning("rent data failed: %s", e)
        try:
            out["fuel"] = parse_fuel(client.get(FUEL_CSV).text)
        except Exception as e:  # noqa: BLE001
            log.warning("fuel data failed: %s", e)
    finally:
        if own:
            client.close()
    log.info("living costs: rent=%s fuel=%s", bool(out.get("rent")), bool(out.get("fuel")))
    return out


if __name__ == "__main__":
    import logging

    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")
    print(json.dumps(fetch_costs(load_config()), ensure_ascii=False, indent=1))
    sys.exit(0)
