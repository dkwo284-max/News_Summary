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


def test_playgrounds_split_into_plain_and_splash_and_unnamed_dropped():
    got = {"playground": {"elements": [
        {"type": "node", "lat": -36.79, "lon": 174.77, "tags": {"leisure": "playground", "name": "Takapuna Beach Reserve Playground"}},
        {"type": "node", "lat": -36.80, "lon": 174.78, "tags": {"leisure": "playground", "name": "Devonport Splash Pad"}},
        {"type": "node", "lat": -36.81, "lon": 174.79, "tags": {"leisure": "playground"}},                      # 이름 없음 → 제외
    ]}}
    out = spots.convert(got)
    assert {(s["t"], s["n"]) for s in out} == {("playground", "Takapuna Beach Reserve Playground"), ("splash", "Devonport Splash Pad")}


def test_gym_studio_split_and_tennis_clusters():
    g = {"elements": [{"lat": -36.8, "lon": 174.7, "tags": {"leisure": "fitness_centre", "name": "Anytime Fitness"}},
                      {"lat": -36.81, "lon": 174.7, "tags": {"leisure": "fitness_centre", "name": "Studio Pilates"}},
                      {"lat": -36.7, "lon": 174.7, "tags": {"sport": "yoga", "name": "Sweat Yoga", "leisure": "fitness_centre"}}]}
    got = {s["n"]: s["t"] for s in spots.convert({"gym": g})}
    assert got == {"Anytime Fitness": "gym", "Studio Pilates": "studio", "Sweat Yoga": "studio"}
    t = {"elements": [
        {"lat": -36.8, "lon": 174.7, "tags": {"sport": "tennis", "club": "sport", "name": "Test Tennis Club"}},
        {"lat": -36.8001, "lon": 174.7001, "tags": {"sport": "tennis", "leisure": "pitch"}},   # 클럽 근처 → 클럽에 포함(따로 안 셈)
        {"lat": -36.9, "lon": 174.8, "tags": {"sport": "tennis", "leisure": "pitch"}},
        {"lat": -36.9002, "lon": 174.8002, "tags": {"sport": "tennis", "leisure": "pitch"}},
        {"lat": -36.95, "lon": 174.8, "tags": {"sport": "tennis", "leisure": "pitch", "access": "private"}},
        {"lat": -36.5, "lon": 174.5, "tags": {"sport": "table_tennis", "club": "sport", "name": "TT club"}}]}
    names = [s["n"] for s in spots.convert({"tennis": t})]
    assert names == ["Test Tennis Club", "테니스 코트 2면"]
