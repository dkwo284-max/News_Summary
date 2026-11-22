import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import tension  # noqa: E402


def test_daily_averages_15min_points():
    s = [{"date": "20261101T000000Z", "value": 1.0}, {"date": "20261101T001500Z", "value": 3.0}, {"date": "20261102T000000Z", "value": 2.0}]
    assert tension.daily(s) == [("2026-11-01", 2.0), ("2026-11-02", 2.0)]


def test_signal_needs_three_weeks_and_detects_surge():
    assert tension.signal([1.0] * 20) is None
    flat = tension.signal([1.0] * 60)
    assert flat is not None and abs(flat[1]) < 1e-9
    pct, chg = tension.signal([1.0] * 60 + [3.0] * 7)
    assert pct == 100 and chg > 150


def test_score_blends_base_and_news():
    assert tension.score(60, None) == 60
    calm = tension.score(60, (0, -50))     # 보도가 3개월 중 가장 적고 줄어드는 중
    hot = tension.score(60, (100, 200))    # 가장 많고 급증
    assert calm < 60 < hot <= 100


def test_levels():
    assert [tension.level(x) for x in (10, 30, 55, 70, 90)] == ["낮음", "주의", "경계", "높음", "매우 높음"]


def test_exposure_korea_more_exposed_to_peninsula():
    scores = {h["id"]: 50.0 for h in tension.HOTSPOTS}
    base = tension.exposure(scores)
    scores2 = dict(scores, korea=95.0)
    hot = tension.exposure(scores2)
    assert hot["kr"]["score"] - base["kr"]["score"] > hot["nz"]["score"] - base["nz"]["score"] > 0
    assert hot["kr"]["drivers"][0]["id"] == "korea"
    assert 0 <= base["nz"]["score"] < base["kr"]["score"] <= 100


def test_main_with_fake_gdelt(tmp_path, monkeypatch):
    monkeypatch.setattr(tension, "OUT", tmp_path / "tension.json")
    monkeypatch.setattr(tension, "HIST", tmp_path / "hist.json")

    class Fake:
        def get(self, **p):
            if p["mode"] == "artlist":
                return {"articles": [{"title": "Drills near island", "url": "https://x.test/a", "domain": "x.test", "seendate": "20261120T010000Z"}]}
            data = [{"date": f"202609{d:02d}T000000Z" if d <= 30 else f"202610{d - 30:02d}T000000Z", "value": 0.1 + (0.5 if d > 55 else 0)} for d in range(1, 62)]
            return {"timeline": [{"data": data}]}

    monkeypatch.setattr(tension, "Gdelt", Fake)
    assert tension.main() == 0
    d = json.loads((tmp_path / "tension.json").read_text(encoding="utf-8"))
    assert d["stale"] is False and len(d["hotspots"]) == len(tension.HOTSPOTS)
    assert 0 <= d["world"]["score"] <= 100 and d["world"]["series"]
    assert set(d["exposure"]) == {"kr", "nz"}
    assert d["hotspots"][0]["articles"][0]["date"] == "2026-11-20"
    assert json.loads((tmp_path / "hist.json").read_text(encoding="utf-8"))[0]["kr"] == d["exposure"]["kr"]["score"]


def test_main_keeps_previous_when_all_fail(tmp_path, monkeypatch):
    out = tmp_path / "tension.json"
    out.write_text(json.dumps({"world": {"score": 50}, "hotspots": [{"id": h["id"], "score": 50} for h in tension.HOTSPOTS]}), encoding="utf-8")
    monkeypatch.setattr(tension, "OUT", out)
    monkeypatch.setattr(tension, "HIST", tmp_path / "hist.json")

    class Dead:
        def get(self, **p):
            return None

    monkeypatch.setattr(tension, "Gdelt", Dead)
    assert tension.main() == 0
    assert json.loads(out.read_text(encoding="utf-8"))["stale"] is True
