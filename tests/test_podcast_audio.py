"""5분 브리핑 음성 파일: 대본 → 챕터·해시, 챕터 시각을 쉼에 맞추기, 실패하면 파일 없이 끝나기."""
import json
import math
from array import array

import pytest

import scripts.podcast_audio as pa

BRIEF = {"date": "2026-11-29", "podcast": {
    "intro": "11월 29일 아침 브리핑입니다.",
    "segments": [
        {"region": "akl", "title": "버스 노선 변경", "text": "먼저 오클랜드 소식입니다. 노스쇼어 버스 노선이 바뀝니다."},
        {"region": "nz", "title": "기준금리", "text": "중앙은행이 기준금리를 2.5%로 유지했습니다."},
    ],
    "outro": "오늘 브리핑은 여기까지입니다."}}


def tone(sec: float, rate: int = 24000) -> array:
    return array("h", (int(8000 * math.sin(2 * math.pi * 220 * k / rate)) for k in range(int(sec * rate))))


def test_chapters_match_player_titles_and_leads():
    chs = pa.chapters(BRIEF)
    assert [c["title"] for c in chs] == ["오늘의 브리핑 시작", "오클랜드 · 버스 노선 변경", "뉴질랜드 · 기준금리", "마무리"]
    assert chs[1]["text"].startswith("먼저")                 # '먼저/이어서'로 시작하면 안내 문구 생략
    assert chs[2]["text"].startswith("다음 소식입니다.")
    assert "2.5퍼센트" in chs[2]["text"]
    assert pa.script_hash(BRIEF, chs) == pa.script_hash(BRIEF, pa.chapters(BRIEF))
    b2 = json.loads(json.dumps(BRIEF)); b2["podcast"]["outro"] = "다른 마무리."
    assert pa.script_hash(b2, pa.chapters(b2)) != pa.script_hash(BRIEF, chs)


def test_chapter_starts_snap_to_pauses():
    rate = 24000
    s = array("h"); parts = [3.0, 5.0, 4.0, 2.0]
    for i, d in enumerate(parts):
        s += tone(d)
        if i < len(parts) - 1:
            s += array("h", bytes(int(rate * 0.8) * 2))   # 소식 사이 0.8초 쉼
    chs = [{"title": str(i), "text": "가" * int(d * 10)} for i, d in enumerate(parts)]
    pa.place_chapters(chs, [0, 1, 2, 3], 0.0, len(s) / rate, pa.silences(s, rate))
    real = [0, 3.8, 9.6, 14.4]
    for c, r in zip(chs, real):
        assert abs(c["start"] - r) < 0.4, (c["start"], r)


def test_no_key_or_failure_writes_nothing(tmp_path, monkeypatch):
    data = tmp_path / "data"; data.mkdir()
    (data / "latest.json").write_text(json.dumps(BRIEF, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(pa, "DATA", data); monkeypatch.setattr(pa, "OUT", tmp_path / "audio")
    monkeypatch.setattr("sys.argv", ["x"])
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert pa.main() == 0 and not (tmp_path / "audio").exists()
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setattr(pa, "pick_models", lambda c, k: ["m"])
    monkeypatch.setattr(pa, "synth", lambda *a: (_ for _ in ()).throw(RuntimeError("m: HTTP 429")))
    assert pa.main() == 0 and not (tmp_path / "audio").exists()


def test_writes_mp3_and_manifest_then_skips_same_script(tmp_path, monkeypatch):
    pytest.importorskip("lameenc")
    data = tmp_path / "data"; data.mkdir()
    (data / "latest.json").write_text(json.dumps(BRIEF, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(pa, "DATA", data); monkeypatch.setattr(pa, "OUT", tmp_path / "audio")
    monkeypatch.setattr("sys.argv", ["x"]); monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setattr(pa, "pick_models", lambda c, k: ["m"])
    calls = []

    def fake(client, key, models, text):
        calls.append(text); out = array("h")
        for i, _ in enumerate(text.split("\n\n")):
            out += tone(1.5) + array("h", bytes(24000))
        return out.tobytes(), 24000, "m"
    monkeypatch.setattr(pa, "synth", fake)
    assert pa.main() == 0
    man = json.loads((tmp_path / "audio" / "podcast.json").read_text(encoding="utf-8"))
    assert man["date"] == "2026-11-29" and man["src"].startswith("audio/podcast-2026-11-29-")
    assert (tmp_path / man["src"]).exists() and man["bytes"] > 1000
    starts = [c["start"] for c in man["chapters"]]
    assert starts == sorted(starts) and starts[0] == 0 and len(starts) == 4
    assert pa.main() == 0 and len(calls) == 1               # 같은 대본이면 다시 안 만듦
