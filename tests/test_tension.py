import io
import json
import sys
import zipfile
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import tension  # noqa: E402


def row(root="19", a1="", a2="", geo="", n=5, url="https://x.test/news/missile-strike-hits-border-town-overnight", t1="", lat="", lon=""):
    r = [""] * 58
    r[tension.A1_COUNTRY], r[tension.A2_COUNTRY], r[tension.GEO_COUNTRY] = a1, a2, geo
    r[tension.A1_T1] = t1
    r[tension.ROOT], r[tension.N_ARTICLES], r[tension.SOURCEURL] = root, str(n), url
    r[tension.GEO_LAT], r[tension.GEO_LON] = lat, lon
    return r


HS = {h["id"]: h for h in tension.HOTSPOTS}


def test_match_needs_military_or_rival_pair():
    assert tension.match(HS["ukraine"], row("19", "UKR", "RUS"))                 # 맞선 두 나라
    assert tension.match(HS["korea"], row("18", "PRK", "", "KN", t1="MIL"))      # 군인이 낀 사건
    assert not tension.match(HS["korea"], row("18", "KOR", "", "KS"))            # 일반 폭행(범죄)은 제외
    assert tension.match(HS["scs"], row("15", "", "", "", t1="MIL", lat="10", lon="114"))   # 위·경도 상자
    assert not tension.match(HS["scs"], row("15", "", "", "", t1="MIL", lat="40", lon="114"))
    assert tension.match(HS["southasia"], row("19", "IND", "PAK"))


def test_slug_title():
    assert tension.slug_title("https://a.test/world/china-deploys-more-than-100-ships-around-taiwan-1234567.html") == "China deploys more than 100 ships around taiwan"
    assert tension.slug_title("https://a.test/article_fdde_5836_bb9f") == ""
    assert tension.slug_title("https://a.test/a/b/") == ""


def _day(lines):
    return tension.parse_day(io.StringIO("\n".join("\t".join(r) for r in lines)))


def test_parse_day_counts_and_headlines():
    rows = [row("01", "USA", "USA") for _ in range(20)]                    # 군사 아닌 사건 (전체 수에만 포함)
    rows += [row("19", "UKR", "RUS", "UP", n=40, url="https://x.test/a/russian-missile-strike-hits-kyiv-power-plant")]
    rows += [row("19", "UKR", "RUS", "UP", n=2, url="https://x.test/b/russian-missile-strike-hits-kyiv-power-plant")]   # 같은 제목은 하나로
    rec = _day(rows)
    assert rec["t"] == 22 and rec["r"]["ukraine"] > 0 and rec["r"]["korea"] == 0
    assert len(rec["a"]["ukraine"]) == 1 and rec["a"]["ukraine"][0][0] == 40
    assert rec["a"]["korea"] == []


def test_signal_needs_three_weeks_and_detects_surge():
    assert tension.signal([1.0] * 20) is None
    flat = tension.signal([1.0] * 60)
    assert flat is not None and abs(flat[1]) < 1e-9
    pct, chg = tension.signal([1.0] * 60 + [3.0] * 7)
    assert pct == 100 and chg > 150


def test_score_blends_base_and_news():
    assert tension.score(60, None) == 60
    assert tension.score(60, (0, -50)) < 60 < tension.score(60, (100, 200)) <= 100


def test_levels():
    assert [tension.level(x) for x in (10, 30, 55, 70, 90)] == ["낮음", "주의", "경계", "높음", "매우 높음"]


def test_exposure_korea_more_exposed_to_peninsula():
    scores = {h["id"]: 50.0 for h in tension.HOTSPOTS}
    base = tension.exposure(scores)
    hot = tension.exposure(dict(scores, korea=95.0))
    assert hot["kr"]["score"] - base["kr"]["score"] > hot["nz"]["score"] - base["nz"]["score"] > 0
    assert hot["kr"]["drivers"][0]["id"] == "korea"
    assert 0 <= base["nz"]["score"] < base["kr"]["score"] <= 100


def _fake_zip(day_idx: int) -> bytes:
    rows = [row("01", "USA", "USA") for _ in range(2000)]
    surge = day_idx > 80
    rows += [row("19", "UKR", "RUS", "UP", n=10, url=f"https://x.test/n/russian-drone-strike-hits-kyiv-district-{day_idx}") for _ in range(30)]
    rows += [row("15", "CHN", "TWN", "TW", n=8, t1="MIL", url="https://x.test/n/china-deploys-warships-around-taiwan-strait") for _ in range(40 if surge else 2)]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("x.export.CSV", "\n".join("\t".join(r) for r in rows))
    return buf.getvalue()


class FakeClient:
    def __init__(self, today, missing=()):
        self.today, self.missing = today, set(missing)

    def get(self, url):
        d = url.rsplit("/", 1)[-1][:8]
        day = date(int(d[:4]), int(d[4:6]), int(d[6:]))
        idx = tension.WINDOW - (self.today - day).days
        if day.isoformat() in self.missing or idx < 0:
            return type("R", (), {"status_code": 404, "content": b""})()
        return type("R", (), {"status_code": 200, "content": _fake_zip(idx)})()


def test_main_backfills_then_only_fetches_missing(tmp_path, monkeypatch):
    for n in ("OUT", "HIST", "DAYS"):
        monkeypatch.setattr(tension, n, tmp_path / f"{n}.json")
    today = date(2026, 11, 22)
    assert tension.main(today, FakeClient(today)) == 0
    data = json.loads((tmp_path / "OUT.json").read_text(encoding="utf-8"))
    assert data["stale"] is False and data["data_through"] == "2026-11-21"
    assert len(data["hotspots"]) == len(tension.HOTSPOTS) and 0 <= data["world"]["score"] <= 100
    tw = next(h for h in data["hotspots"] if h["id"] == "taiwan")
    assert tw["chg7"] > 100 and tw["articles"][0]["title"].startswith("China deploys warships")   # 최근 급증
    days = json.loads((tmp_path / "DAYS.json").read_text(encoding="utf-8"))
    assert len(days) == tension.WINDOW and "a" not in days[min(days)] and "a" in days[max(days)]
    # 두 번째 실행: 이미 받은 날은 다시 받지 않는다
    class Counting(FakeClient):
        n = 0
        def get(self, url):
            Counting.n += 1
            return super().get(url)
    next_day = today + timedelta(days=1)
    assert tension.main(next_day, Counting(next_day)) == 0
    assert Counting.n == 1


def test_main_too_little_data_keeps_previous(tmp_path, monkeypatch):
    for n in ("OUT", "HIST", "DAYS"):
        monkeypatch.setattr(tension, n, tmp_path / f"{n}.json")
    (tmp_path / "OUT.json").write_text(json.dumps({"world": {"score": 50}, "hotspots": []}), encoding="utf-8")
    today = date(2026, 11, 22)
    all_missing = {(today - timedelta(days=k)).isoformat() for k in range(1, tension.WINDOW + 1)}
    assert tension.main(today, FakeClient(today, missing=all_missing)) == 0
    assert json.loads((tmp_path / "OUT.json").read_text(encoding="utf-8"))["stale"] is True
