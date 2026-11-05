import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import spots  # noqa: E402


def test_convert_filters_private_dedupes_and_names():
    got = {
        "ramp": {"elements": [
            {"type": "node", "lat": -36.80, "lon": 174.80, "tags": {"leisure": "slipway"}},                       # 이름 없는 램프 → '보트 램프'
            {"type": "node", "lat": -36.90, "lon": 174.90, "tags": {"leisure": "slipway", "name": "Sandspit Ramp"}},
            {"type": "node", "lat": -36.91, "lon": 174.91, "tags": {"leisure": "slipway", "access": "private"}},   # 사유지 제외
            {"type": "way", "center": {"lat": -36.9001, "lon": 174.9001}, "tags": {"leisure": "slipway", "name": "Sandspit Ramp"}},  # 같은 이름·근접 → 하나
        ]},
        "pier": {"elements": [
            {"type": "way", "center": {"lat": -36.84, "lon": 174.76}, "tags": {"man_made": "pier", "name": "Princes Wharf"}},
            {"type": "node", "lat": -36.0, "lon": 174.0, "tags": {"man_made": "pier"}},                           # 이름 없는 부두 제외
        ]},
        "beach": {"elements": [{"type": "way", "center": {"lat": -36.78, "lon": 174.78}, "tags": {"natural": "beach", "name": "Milford Beach"}}]},
    }
    out = spots.convert(got)
    by = {(s["t"], s["n"]) for s in out}
    assert by == {("ramp", "Sandspit Ramp"), ("ramp", "보트 램프"), ("pier", "Princes Wharf"), ("beach", "Milford Beach")}
    assert out[0]["t"] == "ramp" and out[0]["n"] == "Sandspit Ramp"   # 이름 있는 것이 먼저
