import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import car  # noqa: E402


def test_kinds():
    assert car.kinds_of({"shop": "car_repair", "name": "Joe's Mechanics"}) == ["repair"]
    assert car.kinds_of({"shop": "car_repair", "name": "Smith Panel & Paint"}) == ["panel"]
    assert car.kinds_of({"shop": "tyres", "name": "Beaurepaires Albany"}) == ["tyre"]
    assert car.kinds_of({"amenity": "vehicle_inspection", "name": "VTNZ Penrose"}) == ["wof"]
    assert car.kinds_of({"shop": "car_repair", "name": "Smith & Smith"}) == ["glass"]
    assert car.kinds_of({"shop": "car_repair", "name": "Toyota North Shore Service"}) == ["repair", "toyota"]
    assert car.kinds_of({"shop": "car_repair", "name": "X", "service:vehicle:inspection": "yes"}) == ["wof"]


def test_convert_filters_dedupes_and_flags_korean():
    osm = {"elements": [
        {"type": "node", "lat": -36.8, "lon": 174.7, "tags": {"shop": "car_repair", "name": "한국 카센터", "phone": "09 123", "website": "ko.nz"}},
        {"type": "way", "center": {"lat": -36.8001, "lon": 174.7001}, "tags": {"shop": "car_repair", "name": "한국 카센터"}},
        {"type": "node", "lat": -36.9, "lon": 174.8, "tags": {"shop": "car", "name": "Honda Dealer"}},
        {"type": "node", "lat": -36.9, "lon": 174.8, "tags": {"shop": "car", "name": "Toyota Penrose"}},
        {"type": "node", "lat": -36.95, "lon": 174.85, "tags": {"shop": "car_repair"}},
    ]}
    out = car.convert(osm)
    assert [x["n"] for x in out] == ["Toyota Penrose", "한국 카센터"]
    ko = out[1]
    assert ko["ko_guess"] and ko["p"] == "09 123" and ko["w"] == "https://ko.nz"
    assert out[0]["k"] == ["toyota"]


def test_find_hanin_pages():
    home = '<a href="/korean-gp">한인 GP</a><a href="/korean-mechanic">🚗 한인 정비소</a><a href="https://other.com/car">x</a>'
    assert car.find_hanin_pages(home) == ["https://hanin.nz/korean-mechanic"]
    assert car.find_hanin_pages('<a href="/korean-gp">한인 GP</a>') == []
