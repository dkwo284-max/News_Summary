import json
from datetime import date

import httpx

from areas import fetch_rent, parse_market_rent, parse_qv, update_areas

PAGE = """<html><body><div>Milford (Auckland)</div><div>01 Nov 2024 - 30 Apr 2025</div>
<div>Bonds 1257 Lower ($) 600 Median ($) 680 Upper ($) 800</div>
<h2>Auckland - Milford</h2><p>01 Nov 2025 - 30 Apr 2026</p>
<h3>Apartment</h3><table><tr><th>Size</th><th>Active bonds</th><th>Lower Quartile</th><th>Median Rent</th><th>Upper Quartile</th></tr>
<tr><td>1 bedroom</td><td>60</td><td>$391</td><td>$398</td><td>$423</td></tr>
<tr><td>2 bedrooms</td><td>66</td><td>$635</td><td>$663</td><td>$716</td></tr></table>
<h3>House</h3><table><tr><th>Size</th><th>Active bonds</th><th>Lower Quartile</th><th>Median Rent</th><th>Upper Quartile</th></tr>
<tr><td>3 bedrooms</td><td>264</td><td>$680</td><td>$750</td><td>$830</td></tr>
<tr><td>5+ bedrooms</td><td>42</td><td>$875</td><td>$1000</td><td>$1050</td></tr></table>
<p>This data is updated monthly</p></body></html>"""

MULTI = "<p>Sorry, there are multiple results for &quot;Mt Eden&quot;. Suggestions: Auckland - Mount Eden Subscribe</p>"


def test_parse_market_rent():
    r = parse_market_rent(PAGE, "Milford")
    assert r["period"] == "2025-11~2026-04"
    assert r["house"]["3"] == {"bonds": 264, "lower": 680, "median": 750, "upper": 830}
    assert r["house"]["5+"]["median"] == 1000
    assert r["apartment"]["2"]["median"] == 663
    assert parse_market_rent(PAGE, "Takapuna") is None


def test_fetch_rent_follows_suggestion():
    def handler(req):
        loc = req.url.params["location"]
        return httpx.Response(200, text=PAGE.replace("Milford", "Mount Eden") if loc == "Auckland - Mount Eden" else MULTI)
    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        r = fetch_rent(c, "Mt Eden")
    assert r["name"] == "Mount Eden" and r["house"]["3"]["median"] == 750 and r["all"]["median"] == 680


def test_parse_qv():
    html = ('{"NORTH SHORE CITY": {"name": "North Shore City", "description": "<p data-block-key=\\"ypm5z\\"> North Shore City has '
            'decreased by -2.40% over the past three month period with the average value now sitting at $1,427,311 . This represents</p>", '
            '"overwrite": false, "code": "5"}}')
    assert parse_qv(html) == {"NORTH SHORE CITY": {"name": "North Shore City", "avg_value": 1427311}}


def test_update_areas_respects_refresh(cfg, tmp_path, monkeypatch):
    known = {k: {} for k in cfg["areas"]["suburbs"]}
    (tmp_path / "areas.json").write_text(json.dumps({"updated_at": "2026-10-25", "suburbs": known}), encoding="utf-8")
    import areas
    monkeypatch.setattr(areas, "fetch_areas", lambda cfg: (_ for _ in ()).throw(AssertionError("should not fetch")))
    assert update_areas(cfg, tmp_path, date(2026, 10, 27)) is False
    monkeypatch.setattr(areas, "fetch_areas", lambda cfg: {"updated_at": "2026-11-02", "suburbs": {"Milford": {"rent": {"house": {}}}}, "districts": {}})
    assert update_areas(cfg, tmp_path, date(2026, 11, 2)) is True


def test_update_areas_refetches_when_suburb_added(cfg, tmp_path, monkeypatch):
    import areas
    (tmp_path / "areas.json").write_text(json.dumps({"updated_at": "2026-10-26", "suburbs": {"Milford": {}}}), encoding="utf-8")
    monkeypatch.setattr(areas, "fetch_areas", lambda cfg: {"updated_at": "2026-10-27", "suburbs": {"Newmarket": {"rent": {"apartment": {}}}}, "districts": {}})
    assert update_areas(cfg, tmp_path, date(2026, 10, 27)) is True
