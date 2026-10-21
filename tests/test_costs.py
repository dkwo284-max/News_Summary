from costs import parse_fuel, parse_rent

RENT = """Time Frame,Location Id,Location,Lodged Bonds,Active Bonds,Closed Bonds,Median Rent,Geometric Mean Rent,Upper Quartile Rent,Lower Quartile Rent,Log Std Dev Weekly Rent
2025-08-01,7,Auckland,3000,90000,2900,630,620,750,540,0.3
2026-07-01,7,Auckland,3100,91000,3000,640,630,760,545,0.3
2026-08-01,7,Auckland,3200,92000,3100,650,640,765,550,0.3
2026-08-01,8,Hamilton,900,20000,800,560,550,640,480,0.3
"""

FUEL = """Week,Date,Fuel,Variable,Value,Unit,Status
42,2026-10-09,Regular Petrol,Board price,365.2,NZc/L,Final
42,2026-10-09,Diesel,Board price,326.0,NZc/L,Final
43,2026-10-16,Regular Petrol,Board price,361.7,NZc/L,Final
43,2026-10-16,Diesel,Board price,324.5,NZc/L,Final
43,2026-10-16,Regular Petrol,Importer cost,200.0,NZc/L,Final
"""


def test_parse_rent_latest_and_yoy():
    r = parse_rent(RENT)
    assert r["month"] == "2026-08"
    assert (r["median"], r["lower"], r["upper"]) == (650, 550, 765)
    assert r["yoy_pct"] == round((650 / 630 - 1) * 100, 1)


def test_parse_rent_missing_location():
    assert parse_rent(RENT, "Wellington") is None


def test_parse_fuel_board_price_only():
    f = parse_fuel(FUEL)
    assert f["petrol91"] == {"date": "2026-10-16", "nzd_per_l": 3.62, "wow_cents": -3.5}
    assert f["diesel"]["nzd_per_l"] == 3.25
    assert "petrol95" not in f
