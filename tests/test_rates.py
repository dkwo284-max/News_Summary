from datetime import date

import httpx

from rates import fetch_rates, parse_bis, summarize_series

BIS = """FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE
D,NZ,2025-10-01,2.5
D,NZ,2026-08-20,2.5
D,NZ,2026-08-21,2.75
D,NZ,2026-10-20,2.75
D,NZ,2026-10-21,NaN
D,NZ,2026-10-22,
D,KR,2025-10-01,2.5
D,KR,2026-10-20,2.5
D,US,2026-10-20,3.875
"""


def test_summarize_series_change_and_year_ago():
    s = summarize_series(parse_bis(BIS)["NZ"], date(2026, 10, 28))
    assert s == {"value": 2.75, "as_of": "2026-10-20", "changed_on": "2026-08-21", "previous": 2.5, "year_ago": 2.5}
    kr = summarize_series(parse_bis(BIS)["KR"], date(2026, 10, 28))
    assert kr["value"] == 2.5 and "changed_on" not in kr


def test_fetch_rates_prefers_fresher_fred_range():
    def handler(req):
        u = str(req.url)
        if "bis.org" in u:
            return httpx.Response(200, text=BIS)
        if "DFEDTARU" in u:
            return httpx.Response(200, text="observation_date,DFEDTARU\n2026-09-16,3.75\n2026-09-17,4.00\n2026-10-27,4.00\n")
        return httpx.Response(200, text="observation_date,DFEDTARL\n2026-09-16,3.50\n2026-09-17,3.75\n2026-10-27,3.75\n")
    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        out = fetch_rates(c, date(2026, 10, 28))
    us = out["rates"]["US"]
    assert us["source"] == "FRED" and us["range"] == [3.75, 4.0] and us["as_of"] == "2026-10-27"
    assert us["changed_on"] == "2026-09-17" and us["previous"] == 3.625
    assert out["rates"]["NZ"]["source"] == "BIS"


def test_finite_replaces_nan():
    from common import finite
    assert finite({"a": [1.0, float("nan")], "b": {"c": float("inf")}}) == {"a": [1.0, None], "b": {"c": None}}
