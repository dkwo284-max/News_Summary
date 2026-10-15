import json
from datetime import date, datetime, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from build import BriefValidationError, prune_and_index, validate, write_brief
from common import Article
from llm import LLM, LLMError
from main import main, should_run
from make_fixtures import FIXTURE_NOW
from notify import compose
from rank import heuristic_score, select
from summarize import clamp_line, summarize_section

T = datetime(2026, 10, 15, 20, tzinfo=timezone.utc)


def art(i, title, section="nz_national", desc=""):
    return Article(id=str(i), section=section, title=title, url=f"https://ex.com/{i}", source="RNZ", published=T, description=desc)


class FakeLLM:
    """rank / summarize 호출을 흉내내는 가짜 LLM (네트워크 없음)."""

    def __init__(self):
        self.calls = []

    def json_call(self, *, model, system, user, schema, effort, max_tokens=16000, fallback=False):
        self.calls.append({"model": model, "fallback": fallback, "user": user})
        ids = [line.split(" | ")[0] for line in user.splitlines() if " | " in line]
        if "scores" in schema["properties"]:
            return {"scores": [{"id": i, "score": 9 if "visa" in user.split(i, 1)[1].split("\n", 1)[0].lower() else 5,
                                "immigration": "visa" in user.split(i, 1)[1].split("\n", 1)[0].lower()} for i in ids]}
        ids = [line[5:] for line in user.splitlines() if line.startswith("[id] ")]
        return {"briefing": "오늘의 한 줄",
                "items": [{"id": i, "title_ko": f"번역 제목 {i}", "summary_ko": ["가" * 100, "둘째 줄", "셋째 줄", "넷째 줄"],
                           "why_it_matters": "이민 준비자에게 의미" if "뉴질랜드" in system or "오클랜드" in system or "이민" in system else "",
                           "tags": ["비자", "주거"]} for i in ids]}


# ── 선별 ──

def test_heuristic_prefers_immigration_over_sports(cfg):
    visa, _ = heuristic_score(art(1, "Work visa changes announced for migrants"), cfg, "nz", FIXTURE_NOW), None
    rugby, _ = heuristic_score(art(2, "All Blacks win rugby match"), cfg, "nz", FIXTURE_NOW), None
    assert visa[0] > rugby[0] and visa[1] is True and rugby[1] is False
    assert rugby[0] < 3


def test_select_with_llm_builds_immigration_radar(cfg):
    topics = ["harbour bridge", "school zones", "hospital waits", "power prices", "dairy exports", "kiwifruit season",
              "train timetables", "ferry fares", "library hours", "water meters", "cycle lanes", "tourism numbers"]
    items = [art(i, f"New visa rules for {t}" if i % 3 == 0 else f"Council report on {t}") for i, t in enumerate(topics)]
    items.append(art(99, "INZ notice", section="nz_immigration"))
    llm = FakeLLM()
    chosen = select(items, cfg, llm, FIXTURE_NOW)
    assert len(chosen["nz_national"]) == 8
    assert all(c["model"] == "claude-haiku-5-5" for c in llm.calls)
    radar_ids = {a.id for a in chosen["nz_immigration"]}
    assert {"0", "3", "6", "9"} <= radar_ids
    assert all(a.section == "nz_immigration" for a in chosen["nz_immigration"])


# ── 요약 ──

def test_summarize_nz_section_postprocess(cfg):
    a = art(1, "Visa change")
    a.score = 8
    llm = FakeLLM()
    sec = summarize_section("nz_national", [a], cfg, llm)
    item = sec["items"][0]
    assert llm.calls[0]["model"] == "claude-sonnet-5-5" and llm.calls[0]["fallback"] is True
    assert len(item["summary_ko"]) == 3 and all(len(s) <= 80 for s in item["summary_ko"])
    assert item["why_it_matters"] and item["sources"][0]["url"].startswith("https://")
    assert item["importance"] == 8 and sec["briefing"] == "오늘의 한 줄"


def test_summarize_kr_section_has_no_why(cfg):
    a = art(1, "금리 동결", section="kr_economy")
    a.score = 7
    item = summarize_section("kr_economy", [a], cfg, FakeLLM())["items"][0]
    assert "why_it_matters" not in item


def test_summarize_llm_failure_falls_back(cfg):
    class Boom:
        def json_call(self, **kw):
            raise LLMError("down")
    a = art(1, "Visa change", desc="First sentence. Second one.")
    sec = summarize_section("nz_national", [a], cfg, Boom())
    assert sec["items"][0]["summary_ko"] == ["First sentence.", "Second one."]
    assert "error" in sec


def test_clamp_line():
    assert clamp_line("가" * 81) == "가" * 79 + "…"
    assert len(clamp_line("가" * 81)) == 80
    assert clamp_line("- 짧은 문장") == "짧은 문장"


# ── LLM 래퍼 ──

def _resp(text, stop="end_turn", model="claude-haiku-5-5"):
    return SimpleNamespace(model=model, stop_reason=stop, usage=SimpleNamespace(input_tokens=1000, output_tokens=200),
                           content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=text)])


def test_llm_wrapper_usage_and_fallback_kwargs(cfg):
    seen = {}
    client = SimpleNamespace(
        messages=SimpleNamespace(create=lambda **kw: seen.setdefault("plain", kw) and _resp('{"ok": 1}')),
        beta=SimpleNamespace(messages=SimpleNamespace(
            create=lambda **kw: seen.setdefault("beta", kw) and _resp('{"ok": 2}', model="claude-sonnet-5-5"))),
    )
    llm = LLM(cfg, client=client)
    assert llm.json_call(model="claude-haiku-5-5", system="s", user="u", schema={}, effort="low") == {"ok": 1}
    assert llm.json_call(model="claude-sonnet-5-5", system="s", user="u", schema={}, effort="low", fallback=True) == {"ok": 2}
    assert seen["plain"]["output_config"]["format"]["type"] == "json_schema"
    assert "tool_choice" not in seen["plain"]
    assert seen["beta"]["fallbacks"] == "default" and seen["beta"]["betas"] == ["server-side-fallback-2026-07-01"]
    rep = llm.report()
    assert rep["models"]["claude-haiku-5-5"]["cost_usd"] == pytest.approx(0.0002)
    assert rep["models"]["claude-sonnet-5-5"]["cost_usd"] == pytest.approx(0.004)


def test_llm_wrapper_refusal(cfg):
    client = SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: _resp("", stop="refusal")))
    with pytest.raises(LLMError):
        LLM(cfg, client=client).json_call(model="claude-haiku-5-5", system="s", user="u", schema={}, effort="low")


# ── 스키마 · 저장 ──

def _brief(cfg, why="의미"):
    item = {"id": "a", "title_ko": "제목", "summary_ko": ["한 줄"], "tags": [], "importance": 5,
            "sources": [{"name": "RNZ", "url": "https://rnz.co.nz/x"}], "why_it_matters": why}
    return {"date": "2026-10-16", "generated_at": "2026-10-16T07:42:00+09:00", "timezone": "Asia/Seoul",
            "sections": {k: {"label": v["label"], "briefing": "", "items": [dict(item)] if k == "nz_national" else []}
                         for k, v in cfg["sections"].items()},
            "extras": {"nzd_krw": 812.3, "auckland_weather": {"max": 18, "min": 11, "desc": "맑음"}}}


def test_schema_accepts_valid(cfg):
    validate(_brief(cfg), cfg)


def test_schema_requires_why_for_nz(cfg):
    with pytest.raises(BriefValidationError, match="why_it_matters"):
        validate(_brief(cfg, why=""), cfg)


def test_schema_requires_source_link(cfg):
    b = _brief(cfg)
    b["sections"]["nz_national"]["items"][0]["sources"] = []
    with pytest.raises(BriefValidationError):
        validate(b, cfg)
    b["sections"]["nz_national"]["items"][0]["sources"] = [{"name": "x", "url": "javascript:alert(1)"}]
    with pytest.raises(BriefValidationError):
        validate(b, cfg)


def test_write_prune_index(cfg, tmp_path):
    for d in ("2026-09-01", "2026-09-20", "2026-10-15"):
        (tmp_path / f"{d}.json").write_text("{}")
    write_brief(_brief(cfg), tmp_path)
    dates = prune_and_index(tmp_path, date(2026, 10, 16), 30)
    assert dates == ["2026-10-16", "2026-10-15", "2026-09-20"]
    assert not (tmp_path / "2026-09-01.json").exists()
    assert json.loads((tmp_path / "latest.json").read_text())["date"] == "2026-10-16"
    assert json.loads((tmp_path / "index.json").read_text())["dates"][0] == "2026-10-16"


# ── 실행 시각 게이트 ──

@pytest.mark.parametrize("tzname,utc_iso,expected", [
    ("Asia/Seoul", "2026-10-15T22:30:00+00:00", True),        # 07:30 KST
    ("Asia/Seoul", "2026-10-15T21:30:00+00:00", False),       # 06:30 KST
    ("Pacific/Auckland", "2026-10-15T18:30:00+00:00", True),  # 07:30 NZDT (UTC+13, 서머타임)
    ("Pacific/Auckland", "2026-06-15T19:30:00+00:00", True),  # 07:30 NZST (UTC+12)
    ("Pacific/Auckland", "2026-06-15T18:30:00+00:00", False), # 06:30 NZST
])
def test_should_run_gate(cfg, tmp_path, tzname, utc_iso, expected):
    cfg["timezone"] = tzname
    local = datetime.fromisoformat(utc_iso).astimezone(ZoneInfo(tzname))
    assert should_run(cfg, local, tmp_path)[0] is expected


def test_should_run_skips_when_already_generated(cfg, tmp_path):
    local = datetime(2026, 10, 16, 7, 30, tzinfo=ZoneInfo("Asia/Seoul"))
    (tmp_path / "2026-10-16.json").write_text("{}")
    assert should_run(cfg, local, tmp_path)[0] is False


def test_compose_hides_politics(cfg):
    b = _brief(cfg)
    b["sections"]["kr_politics"]["items"] = [b["sections"]["nz_national"]["items"][0]]
    b["sections"]["kr_politics"]["briefing"] = "정치 브리핑"
    text = compose(b, cfg)
    assert "정치 브리핑" not in text and "812.3" in text and cfg["output"]["app_url"] in text


# ── 전체 파이프라인 (오프라인) ──

def test_main_offline_end_to_end(fixtures_dir, monkeypatch, tmp_path):
    import main as main_mod
    monkeypatch.setattr(main_mod, "ROOT", tmp_path)
    rc = main(["--config", str(fixtures_dir.parent.parent.parent / "config.yaml"), "--dry-run", "--no-llm", "--fixtures", str(fixtures_dir), "--now", FIXTURE_NOW.isoformat()])
    assert rc == 0
    brief = json.loads((tmp_path / "out" / "dry-run" / "latest.json").read_text())
    assert brief["date"] == "2026-10-16"
    assert any(f["id"] == "hani_society" for f in brief["meta"]["failed_feeds"])
    for sec in brief["sections"].values():
        for item in sec["items"]:
            assert item["sources"] and all(s["url"].startswith("http") for s in item["sources"])
