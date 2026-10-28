"""부가 정보: NZD·USD·JPY(100엔)/KRW 환율과 비트코인 USD 가격(Coinbase 실시간, 환율은 실패 시 frankfurter·ECB 고시),
오클랜드 날씨(Open-Meteo), 뉴질랜드·한국·미국 기준금리(BIS·FRED). 모두 API 키 불필요."""
from __future__ import annotations

import httpx

from common import log

# 1순위 Coinbase(실시간), 2순위 frankfurter(ECB 고시, 평일 하루 1회 갱신)
FX_SOURCES = [
    ("https://api.coinbase.com/v2/exchange-rates?currency={base}", lambda j, q: j["data"]["rates"][q]),
    ("https://api.frankfurter.dev/v1/latest?base={base}&symbols={quote}", lambda j, q: j["rates"][q]),
    ("https://api.frankfurter.app/latest?from={base}&to={quote}", lambda j, q: j["rates"][q]),
]

# WMO weather code → 한국어
WMO_KO = {
    0: "맑음", 1: "대체로 맑음", 2: "구름 조금", 3: "흐림", 45: "안개", 48: "서리 안개",
    51: "약한 이슬비", 53: "이슬비", 55: "강한 이슬비", 56: "어는 이슬비", 57: "어는 이슬비",
    61: "약한 비", 63: "비", 65: "강한 비", 66: "어는 비", 67: "어는 비",
    71: "약한 눈", 73: "눈", 75: "강한 눈", 77: "싸락눈",
    80: "약한 소나기", 81: "소나기", 82: "강한 소나기", 85: "눈 소나기", 86: "강한 눈 소나기",
    95: "뇌우", 96: "우박 동반 뇌우", 99: "강한 우박 뇌우",
}


def _per100(v: float | None) -> float | None:
    return round(v * 100, 2) if v is not None else None


def fetch_fx(client: httpx.Client, base: str, quote: str, digits: int = 2) -> float | None:
    for tmpl, pick in FX_SOURCES:
        try:
            r = client.get(tmpl.format(base=base, quote=quote))
            r.raise_for_status()
            return round(float(pick(r.json(), quote)), digits)
        except Exception as e:  # noqa: BLE001
            log.warning("fx failed via %s: %s", tmpl.split("/")[2], e)
    return None


def fetch_weather(client: httpx.Client, w: dict) -> dict | None:
    try:
        r = client.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": w["latitude"],
                "longitude": w["longitude"],
                "daily": "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max",
                "timezone": w["timezone"],
                "forecast_days": 1,
            },
        )
        r.raise_for_status()
        d = r.json()["daily"]
        code = int(d["weather_code"][0])
        out = {
            "max": round(d["temperature_2m_max"][0]),
            "min": round(d["temperature_2m_min"][0]),
            "desc": WMO_KO.get(code, "알 수 없음"),
            "code": code,
        }
        pop = (d.get("precipitation_probability_max") or [None])[0]
        if pop is not None:
            out["rain_chance"] = pop
        return out
    except Exception as e:  # noqa: BLE001
        log.warning("weather failed: %s", e)
        return None


def fetch_extras(cfg: dict) -> dict:
    ex = cfg["extras"]
    with httpx.Client(timeout=15) as client:
        out = {
            "nzd_krw": fetch_fx(client, ex["fx"]["base"], ex["fx"]["quote"]),
            "usd_krw": fetch_fx(client, "USD", "KRW"),
            "jpy100_krw": _per100(fetch_fx(client, "JPY", "KRW", digits=4)),  # 한국식 표기: 100엔 = 원
            "btc_usd": fetch_btc(client),
            "auckland_weather": fetch_weather(client, ex["weather"]),
        }
    try:
        from rates import fetch_rates

        with httpx.Client(timeout=40, follow_redirects=True) as client:
            out["policy_rates"] = fetch_rates(client)
    except Exception as e:  # noqa: BLE001
        log.warning("policy rates failed: %s", e)
    return out


def fetch_btc(client: httpx.Client) -> float | None:
    """비트코인 1개 USD 가격 (Coinbase 실시간)."""
    try:
        r = client.get("https://api.coinbase.com/v2/exchange-rates?currency=BTC")
        r.raise_for_status()
        return round(float(r.json()["data"]["rates"]["USD"]))
    except Exception as e:  # noqa: BLE001
        log.warning("btc price failed: %s", e)
        return None
