import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import stores  # noqa: E402


def test_convert_classifies_and_dedupes():
    osm = {"elements": [
        {"type": "node", "lat": -36.7305, "lon": 174.7246, "tags": {"shop": "supermarket", "name": "Woolworths Albany"}},
        {"type": "way", "center": {"lat": -36.7306, "lon": 174.7247}, "tags": {"shop": "supermarket", "name": "Woolworths Albany", "brand": "Woolworths"}},
        {"type": "node", "lat": -36.77, "lon": 174.76, "tags": {"shop": "supermarket", "name": "Countdown Milford"}},
        {"type": "node", "lat": -36.8, "lon": 174.7, "tags": {"shop": "chemist", "name": "Chemist Warehouse Newmarket"}},
        {"type": "node", "lat": -36.81, "lon": 174.71, "tags": {"amenity": "fuel", "name": "Woolworths Fuel"}},
        {"type": "node", "lat": -36.9, "lon": 174.9, "tags": {"shop": "supermarket", "name": "New World"}},
    ]}
    out = stores.convert(osm)
    assert len(out["woolworths"]) == 2  # 같은 자리 중복은 하나, 주유소·다른 마트 제외
    assert [s["n"] for s in out["chemist"]] == ["Chemist Warehouse Newmarket"]
