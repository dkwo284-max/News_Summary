import httpx

from census_detail import fetch, parse_csv

CSV = """DATAFLOW,CEN23_YEAR_001,CEN23_GEO_002,CEN23_ETH_003,CEN23_AGE_003,CEN23_GEN_002,OBS_VALUE,OBS_STATUS
STATSNZ:CEN23_ECI_016(1.0),2023,117300,443,99,99,57,
STATSNZ:CEN23_ECI_016(1.0),2023,117300,442,99,99,,
STATSNZ:CEN23_ECI_016(1.0),2018,117300,421,99,99,-999,
STATSNZ:CEN23_ECI_016(1.0),2023,125900,7777,99,99,1932,
"""


def test_parse_csv_blank_and_suppressed_become_zero():
    got = parse_csv(CSV)
    assert got[("2023", "117300", "443")] == 57 and got[("2023", "117300", "442")] == 0
    assert got[("2018", "117300", "421")] == 0 and got[("2023", "125900", "7777")] == 1932


def test_fetch_chunks_geographies_and_sends_key_only_as_header(monkeypatch):
    import census_detail
    monkeypatch.setattr(census_detail.time, "sleep", lambda s: None)
    urls = []

    def handler(req):
        urls.append(str(req.url))
        assert req.headers["accept"].startswith("application/vnd.sdmx.data+csv")
        return httpx.Response(200, text=CSV)

    with httpx.Client(transport=httpx.MockTransport(handler), headers={"Ocp-Apim-Subscription-Key": "SECRET"}) as c:
        out = fetch(c, "CEN23_ECI_016", ["2018", "2023"], [str(100000 + i) for i in range(130)], ["443", "421"], chunk=60)
    assert len(urls) == 3 and all("SECRET" not in u for u in urls)
    assert urls[0].endswith(".443+421.99.99") and "/2018+2023." in urls[0] and out[("2023", "117300", "443")] == 57
