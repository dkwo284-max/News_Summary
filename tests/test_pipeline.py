import json
from datetime import date, datetime, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from build import BriefValidationError, prune_and_index, validate, write_brief
from common import Article
import httpx

from llm import ClaudeLLM, GeminiLLM, LLMError, RequestCapReached, make_llm, to_gemini_schema
from main import main, should_run
from make_fixtures import FIXTURE_NOW
from notify import compose
from rank import heuristic_score, select
from summarize import clamp_line, summarize_all, summarize_region

T = datetime(2026, 10, 15, 20, tzinfo=timezone.utc)


def art(i, title, section="nz_national", desc=""):
    return Article(id=str(i), section=section, title=title, url=f"https://ex.com/{i}", source="RNZ", published=T, description=desc)


class FakeLLM:
    """rank / summary 호출을 흉내내는 가짜 AI (네트워크 없음)."""

    provider = "fake"

    def __init__(self):
        self.calls = []

    def json_call(self, *, task, system, user, schema, max_tokens=16000):
        self.calls.append({"task": task, "user": user, "system": system})
        if task == "rank":
            rows = []
            for line in user.splitlines():
                if " | " not in line:
                    continue
                i, rest = line.split(" | ", 1)
                visa = "visa" in rest.lower()
                rows.append({"id": i, "score": 9 if visa else 5, "immigration": visa, "radar": 8 if visa else 0})
            return {"scores": rows}
        ids, secs = [], set()
        for line in user.splitlines():
            if line.startswith("[id] "):
                ids.append(line[5:])
            if line.startswith("[섹션] "):
                secs.update(line[5:].split(", "))
        nz = "이 독자에게" in system
        return {"briefings": [{"section": k, "briefing": f"{k} 한 줄"} for k in secs],
                "items": [{"id": i, "title_ko": f"번역 제목 {i}", "summary_ko": ["가" * 100, "둘째 줄", "셋째 줄", "넷째 줄"],
                           "why_it_matters": "이민 준비자에게 의미" if nz else "", "tags": ["비자", "주거"]} for i in ids]}


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
    assert [c["task"] for c in llm.calls] == ["rank", "rank"]  # nz 채점 1회 + 이슈 묶기 1회
    # 레이더에 실린 비자 기사는 뉴질랜드 탭에서 빠지고, 나머지 8건이 뉴질랜드 탭을 채움
    assert len(chosen["nz_national"]) == 8
    assert {a.id for a in chosen["nz_national"]}.isdisjoint({a.id for a in chosen["nz_immigration"]})

    radar_ids = {a.id for a in chosen["nz_immigration"]}
    assert {"0", "3", "6", "9"} <= radar_ids
    assert all(a.section == "nz_immigration" for a in chosen["nz_immigration"])


# ── 요약 ──

def test_summarize_region_single_request_and_postprocess(cfg):
    a, b = art(1, "Visa change"), art(2, "Rent rise", section="nz_auckland")
    a.score, b.score = 8, 6
    imm = art(1, "Visa change", section="nz_immigration")  # 같은 기사가 이민 레이더에도 있음
    imm.score = 8
    llm = FakeLLM()
    chosen = {"nz_national": [a], "nz_auckland": [b], "nz_immigration": [imm]}
    out = summarize_region("nz", ["nz_national", "nz_auckland", "nz_immigration"], chosen, cfg, llm)
    assert len(llm.calls) == 1 and llm.calls[0]["task"] == "summary"
    assert llm.calls[0]["user"].count("[id] 1") == 1  # 중복 기사는 한 번만 전송
    item = out["nz_national"]["items"][0]
    assert len(item["summary_ko"]) == 3 and all(len(x) <= 80 for x in item["summary_ko"])
    assert item["why_it_matters"] and item["sources"][0]["url"].startswith("https://")
    assert item["importance"] == 8 and out["nz_national"]["briefing"] == "nz_national 한 줄"
    assert out["nz_immigration"]["items"][0]["title_ko"] == "번역 제목 1"


def test_summarize_all_uses_two_requests(cfg):
    kr = art(1, "금리 동결", section="kr_economy")
    kr.score = 7
    llm = FakeLLM()
    out = summarize_all({"kr_economy": [kr], "nz_national": [art(2, "Visa")]}, cfg, llm)
    assert len(llm.calls) == 2
    assert "why_it_matters" not in out["kr_economy"]["items"][0]
    assert out["kr_society"]["items"] == []


def test_summarize_failure_falls_back(cfg):
    class Boom:
        def json_call(self, **kw):
            raise LLMError("down")
    a = art(1, "Visa change", desc="First sentence. Second one.")
    sec = summarize_region("nz", ["nz_national"], {"nz_national": [a]}, cfg, Boom())["nz_national"]
    assert sec["items"][0]["summary_ko"] == ["First sentence.", "Second one."]
    assert sec["items"][0]["why_it_matters"]
    assert "error" in sec


def test_clamp_line():
    assert clamp_line("가" * 81) == "가" * 79 + "…"
    assert len(clamp_line("가" * 81)) == 80
    assert clamp_line("- 짧은 문장") == "짧은 문장"


# ── AI 래퍼: Gemini ──

def _gemini(cfg, handler, sleeps=None):
    import os
    os.environ["GEMINI_API_KEY"] = "test-key"
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return GeminiLLM(cfg, client=client, sleep=(sleeps.append if sleeps is not None else lambda s: None))


def _gemini_ok(text='{"ok": 1}', finish="STOP"):
    return {"candidates": [{"content": {"parts": [{"text": text}]}, "finishReason": finish}],
            "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 200, "thoughtsTokenCount": 0}}


def test_gemini_request_shape_and_zero_cost(cfg):
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=_gemini_ok())

    llm = _gemini(cfg, handler)
    schema = {"type": "object", "properties": {"x": {"type": "array", "items": {"type": "string"}}},
              "required": ["x"], "additionalProperties": False}
    assert llm.json_call(task="rank", system="s", user="u", schema=schema) == {"ok": 1}
    req = seen[0]
    assert "gemini-3.8-flash-lite:generateContent" in str(req.url)
    assert "key=" not in str(req.url) and req.headers["x-goog-api-key"] == "test-key"
    body = json.loads(req.content)
    gc = body["generationConfig"]
    assert gc["responseMimeType"] == "application/json"
    assert gc["responseSchema"]["type"] == "OBJECT" and "additionalProperties" not in gc["responseSchema"]
    assert "thinkingConfig" not in gc
    rep = llm.report()
    assert rep["total_cost_usd"] == 0 and rep["requests"] == 1 and rep["provider"] == "gemini"


def test_gemini_request_cap(cfg):
    cfg["llm"]["max_requests_per_run"] = 2
    llm = _gemini(cfg, lambda req: httpx.Response(200, json=_gemini_ok()))
    llm.json_call(task="rank", system="s", user="u", schema={})
    llm.json_call(task="summary", system="s", user="u", schema={})
    with pytest.raises(RequestCapReached):
        llm.json_call(task="summary", system="s", user="u", schema={})


def test_gemini_503_moves_to_next_model(cfg):
    urls, sleeps = [], []

    def handler(req):
        urls.append(str(req.url))
        if "gemini-3.8-flash:" in str(req.url):
            return httpx.Response(503, json={"error": {"status": "UNAVAILABLE"}})
        return httpx.Response(200, json=_gemini_ok('{"ok": 3}'))

    llm = _gemini(cfg, handler, sleeps)
    assert llm.json_call(task="summary", system="s", user="u", schema={}) == {"ok": 3}
    assert len(urls) == 3 and "gemini-flash-latest" in urls[2] and 20.0 in sleeps


def test_gemini_429_retries_once_then_errors(cfg):
    calls, sleeps = [], []

    def handler(req):
        calls.append(1)
        return httpx.Response(429, json={"error": {"status": "RESOURCE_EXHAUSTED"}})

    llm = _gemini(cfg, handler, sleeps)
    with pytest.raises(LLMError, match="429"):
        llm.json_call(task="rank", system="s", user="u", schema={})
    n = len(cfg["llm"]["gemini"]["rank_model"])
    assert len(calls) == 2 * n and 60.0 in sleeps  # 모델마다 1회 재시도 후 다음 후보


def test_gemini_429_then_success(cfg):
    responses = [httpx.Response(429, json={}), httpx.Response(200, json=_gemini_ok('{"ok": 2}'))]
    llm = _gemini(cfg, lambda req: responses.pop(0))
    assert llm.json_call(task="rank", system="s", user="u", schema={}) == {"ok": 2}


def test_gemini_bad_finish_and_blocked(cfg):
    llm = _gemini(cfg, lambda req: httpx.Response(200, json=_gemini_ok("{", finish="MAX_TOKENS")))
    with pytest.raises(LLMError, match="MAX_TOKENS"):
        llm.json_call(task="summary", system="s", user="u", schema={})
    llm = _gemini(cfg, lambda req: httpx.Response(200, json={"promptFeedback": {"blockReason": "SAFETY"}}))
    with pytest.raises(LLMError, match="SAFETY"):
        llm.json_call(task="summary", system="s", user="u", schema={})


def test_gemini_rank_failure_uses_heuristic(cfg):
    llm = _gemini(cfg, lambda req: httpx.Response(500, text="boom"))
    chosen = select([art(1, "Work visa changes for migrants"), art(2, "All Blacks rugby match")], cfg, llm, FIXTURE_NOW)
    assert [a.id for a in chosen["nz_immigration"]] == ["1"]  # 휴리스틱: 취업비자 → 레이더
    assert chosen["nz_national"] == []                         # 럭비는 점수 미달, 비자 기사는 레이더로 이동


def test_gemini_invalid_key_stops_further_requests(cfg):
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(400, json={"error": {"status": "INVALID_ARGUMENT", "details": [{"reason": "API_KEY_INVALID"}]}})

    llm = _gemini(cfg, handler)
    for _ in range(3):
        with pytest.raises(LLMError):
            llm.json_call(task="rank", system="s", user="u", schema={})
    assert len(calls) == 1


def test_gemini_model_404_falls_back_and_remembers(cfg):
    urls = []

    def handler(req):
        urls.append(str(req.url))
        if "3.8-flash-lite" in str(req.url):
            return httpx.Response(404, json={"error": {"message": "no longer available"}})
        return httpx.Response(200, json=_gemini_ok())

    llm = _gemini(cfg, handler)
    llm.json_call(task="rank", system="s", user="u", schema={})
    llm.json_call(task="rank", system="s", user="u", schema={})
    assert ["3.8-flash-lite" in u for u in urls] == [True, False, False]
    assert "flash-lite-latest" in urls[1] and urls[1] == urls[2]
    assert llm.requests == 2


def test_gemini_all_models_404(cfg):
    llm = _gemini(cfg, lambda req: httpx.Response(404, json={}))
    with pytest.raises(LLMError, match="404"):
        llm.json_call(task="summary", system="s", user="u", schema={})


def test_to_gemini_schema_nested():
    out = to_gemini_schema({"type": "object", "additionalProperties": False,
                            "properties": {"a": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                                                                            "properties": {"b": {"type": "integer"}}}}}})
    assert out == {"type": "OBJECT", "properties": {"a": {"type": "ARRAY", "items": {"type": "OBJECT",
                                                                                      "properties": {"b": {"type": "INTEGER"}}}}}}


def test_make_llm_requires_key(cfg, monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(LLMError, match="GEMINI_API_KEY"):
        make_llm(cfg)
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    assert make_llm(cfg).provider == "gemini"


# ── AI 래퍼: Claude (선택) ──

def _resp(text, stop="end_turn", model="claude-haiku-5-5"):
    return SimpleNamespace(model=model, stop_reason=stop, usage=SimpleNamespace(input_tokens=1000, output_tokens=200),
                           content=[SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=text)])


def test_claude_wrapper_usage_and_fallback_kwargs(cfg):
    seen = {}
    client = SimpleNamespace(
        messages=SimpleNamespace(create=lambda **kw: seen.setdefault("plain", kw) and _resp('{"ok": 1}')),
        beta=SimpleNamespace(messages=SimpleNamespace(
            create=lambda **kw: seen.setdefault("beta", kw) and _resp('{"ok": 2}', model="claude-sonnet-5-5"))),
    )
    llm = ClaudeLLM(cfg, client=client)
    assert llm.json_call(task="rank", system="s", user="u", schema={}) == {"ok": 1}
    assert llm.json_call(task="summary", system="s", user="u", schema={}) == {"ok": 2}
    assert seen["plain"]["model"] == "claude-haiku-5-5"
    assert seen["plain"]["output_config"]["format"]["type"] == "json_schema"
    assert "tool_choice" not in seen["plain"]
    assert seen["beta"]["fallbacks"] == "default" and seen["beta"]["betas"] == ["server-side-fallback-2026-07-01"]
    rep = llm.report()
    assert rep["models"]["claude-haiku-5-5"]["cost_usd"] == pytest.approx(0.0002)
    assert rep["models"]["claude-sonnet-5-5"]["cost_usd"] == pytest.approx(0.004)


def test_claude_wrapper_refusal(cfg):
    client = SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: _resp("", stop="refusal")))
    with pytest.raises(LLMError):
        ClaudeLLM(cfg, client=client).json_call(task="rank", system="s", user="u", schema={})


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


# ── 뉴질랜드 / 오클랜드 나누기 ──

class SplitLLM(FakeLLM):
    """오클랜드 판단과 same_as 를 돌려주는 가짜 AI."""

    def __init__(self, auckland_ids, same_as):
        super().__init__()
        self.auckland_ids, self.same_as = auckland_ids, same_as

    def json_call(self, *, task, system, user, schema, max_tokens=16000):
        out = super().json_call(task=task, system=system, user=user, schema=schema, max_tokens=max_tokens)
        if task == "rank":
            for row in out["scores"]:
                row["auckland"] = row["id"] in self.auckland_ids
                row["same_as"] = self.same_as.get(row["id"], "")
        return out


def test_split_nz_no_overlap_between_tabs(cfg):
    items = [
        art("n1", "Reserve Bank cuts OCR again"),                                   # 전국
        art("n2", "Mum heartbroken as toddler's cancer treatment delayed"),         # 오클랜드(스타쉽) — 전국 피드
        art("a1", "Starship Hospital delays cancer treatments over nurse shortage", section="nz_auckland"),
        art("a2", "Government announces nationwide fuel tax change", section="nz_auckland"),  # 오클랜드 피드지만 전국 소식
        art("a3", "Piha campground to reopen this summer", section="nz_auckland"),
    ]
    llm = SplitLLM(auckland_ids={"n2", "a1", "a3"}, same_as={"n2": "a1"})
    chosen = select(items, cfg, llm, FIXTURE_NOW)
    nat = {a.id for a in chosen["nz_national"]}
    akl = {a.id for a in chosen["nz_auckland"]}
    assert nat.isdisjoint(akl)
    assert nat == {"n1", "a2"}
    assert akl == {"a1", "a3"} or akl == {"n2", "a3"}  # 스타쉽 기사 두 건은 하나로 합쳐짐
    starship = next(a for a in chosen["nz_auckland"] if a.id in {"a1", "n2"})
    assert len(starship.sources) == 1 or {s.url for s in starship.sources} >= {"https://ex.com/a1", "https://ex.com/n2"}
    assert all(a.section == "nz_auckland" for a in chosen["nz_auckland"])


def test_split_nz_heuristic_uses_auckland_keywords(cfg):
    items = [
        art("n1", "Auckland Transport announces new bus lanes"),
        art("n2", "Inflation eases to 2.1 percent"),
        art("a1", "Takapuna beach clean-up draws hundreds", section="nz_auckland"),
    ]
    chosen = select(items, cfg, None, FIXTURE_NOW)
    assert {a.id for a in chosen["nz_auckland"]} == {"n1", "a1"}
    assert {a.id for a in chosen["nz_national"]} == {"n2"}


def test_same_as_merges_kr_stories(cfg):
    items = [art("k1", "한일 통화스와프 연장 합의", section="kr_economy"),
             art("k2", "韓日 재무장관 100억달러 스와프 3년 연장", section="kr_economy")]
    items[1].source = "매일경제"
    llm = SplitLLM(auckland_ids=set(), same_as={"k2": "k1"})
    chosen = select(items, cfg, llm, FIXTURE_NOW)
    assert len(chosen["kr_economy"]) == 1
    assert {s.name for s in chosen["kr_economy"][0].sources} == {"RNZ", "매일경제"}


def test_immigration_radar_merges_same_issue(cfg):
    items = [
        art("n1", "Work visa refusals spike amid fraud crackdown"),
        art("i1", "NZ rejects 70 percent of Bangladeshi work visa applicants", section="nz_immigration"),
        art("i2", "New Zealand joins UK in work visa clampdown", section="nz_immigration"),
        art("i3", "Green List roles expanded for engineers", section="nz_immigration"),
    ]
    for a in items:
        a.title += " visa"
    llm = SplitLLM(auckland_ids=set(), same_as={"i1": "n1", "i2": "n1"})
    radar = select(items, cfg, llm, FIXTURE_NOW)["nz_immigration"]
    assert len(radar) == 2
    student = next(a for a in radar if a.id in {"n1", "i1", "i2"})
    assert len(student.sources) >= 1 and {a.id for a in radar} & {"i3"}


class GroupLLM(SplitLLM):
    """2차 이슈 묶기 요청에 그룹을 돌려주는 가짜 AI."""

    def __init__(self, auckland_ids, same_as, nz_groups, radar_groups):
        super().__init__(auckland_ids, same_as)
        self.nz_groups, self.radar_groups = nz_groups, radar_groups

    def json_call(self, *, task, system, user, schema, max_tokens=16000):
        if "nz_groups" in schema["properties"]:
            self.calls.append({"task": "group", "user": user, "system": system})
            return {"nz_groups": self.nz_groups, "radar_groups": self.radar_groups}
        return super().json_call(task=task, system=system, user=user, schema=schema, max_tokens=max_tokens)


def test_refine_groups_issue_and_moves_tab(cfg):
    items = [
        art("n1", "Starship cancer treatment delayed for toddler"),       # 1차에서 전국으로 분류됨
        art("a1", "Starship cancer ward three months from full staffing", section="nz_auckland"),
        art("n2", "Thunderstorms and hail for the weekend"),
        art("n3", "Cold snap sends Christchurch temperatures plunging"),
        art("n4", "Slips close State Highway 3 after heavy rain"),
        art("n5", "Government delays home insurance review"),
        art("i1", "Work visa refusals spike visa", section="nz_immigration"),
        art("i2", "NZ rejects 70 percent of Bangladeshi work visa", section="nz_immigration"),
    ]
    llm = GroupLLM(
        auckland_ids={"a1"}, same_as={"n3": "n2", "n4": "n2"},  # 날씨 3건은 1차에서도 같은 이슈로 연결
        nz_groups=[{"ids": ["a1", "n1"], "tab": "auckland"}, {"ids": ["n2", "n3", "n4"], "tab": "national"},
                   {"ids": ["n5"], "tab": "national"}],
        radar_groups=[{"ids": ["i1", "i2"]}],
    )
    chosen = select(items, cfg, llm, FIXTURE_NOW)
    nat = {a.id for a in chosen["nz_national"]}
    akl = {a.id for a in chosen["nz_auckland"]}
    assert len(akl) == 1 and akl <= {"a1", "n1"} and nat.isdisjoint({"a1", "n1"})
    assert len(nat & {"n2", "n3", "n4"}) == 1 and "n5" in nat
    weather = next(a for a in chosen["nz_national"] if a.id in {"n2", "n3", "n4"})
    assert len(weather.related) == 2
    assert len(chosen["nz_immigration"]) == 1
    assert sum(1 for c in llm.calls if c["task"] == "group") == 1


def test_refine_keeps_unrelated_items_separate(cfg):
    items = [
        art("a1", "Hamish McKay evicted from Mission Bay rental after dispute", section="nz_auckland"),
        art("a2", "Auckland Council approves new library budget", section="nz_auckland"),
        art("a3", "Hamish McKay tenancy dispute: tribunal orders eviction", section="nz_auckland"),
    ]
    llm = GroupLLM(auckland_ids={"a1", "a2", "a3"}, same_as={},
                   nz_groups=[{"ids": ["a1", "a2", "a3"], "tab": "auckland"}], radar_groups=[])
    akl = select(items, cfg, llm, FIXTURE_NOW)["nz_auckland"]
    ids = {a.id for a in akl}
    assert "a2" in ids and len(akl) == 2  # 무관한 시의회 기사는 따로, 매케이 기사 2건은 하나로
    mckay = next(a for a in akl if a.id != "a2")
    assert {s.url for s in mckay.sources} == {"https://ex.com/a1", "https://ex.com/a3"} or len(mckay.sources) == 1


# ── 제외 · 이민 레이더 (독자 프로필) ──

from rank import excluded_reason, heuristic_radar  # noqa: E402


@pytest.mark.parametrize("title,source,excluded", [
    ("Huntly mum's Givealittle page passes $50k", "NZ Herald", True),
    ("Remuera 68 sqm townhouse a mini masterpiece", "Stuff", True),
    ("Three-bedroom home for sale in Ponsonby", "Stuff", True),
    ("First-home buyers: best suburbs under $700k", "OneRoof", True),          # 출처 제외
    ("[광고] 여름 특가 항공권", "연합뉴스", True),
    ("강남 신축 아파트 분양 일정", "매일경제", True),
    ("Reserve Bank cuts OCR to 2.25%", "RNZ", False),
    ("Starship Hospital delays cancer treatments over nurse shortage", "RNZ", False),
    ("Saleswoman jailed for fraud", "RNZ", False),                              # 'sale' 부분 일치는 제외 안 함
])
def test_keyword_and_source_exclusion(cfg, title, source, excluded):
    a = art(1, title)
    a.source = source
    assert (excluded_reason(a, cfg) is not None) is excluded


def test_ai_junk_flag_drops_article(cfg):
    class JunkLLM(SplitLLM):
        def json_call(self, **kw):
            out = super().json_call(**kw)
            if kw["task"] == "rank" and "scores" in out:
                for r in out["scores"]:
                    r["junk"] = r["id"] == "n2"
            return out
    items = [art("n1", "Inflation eases to 2.1 percent"), art("n2", "Inside a stunning Mission Bay renovation")]
    chosen = select(items, cfg, JunkLLM(set(), {}), FIXTURE_NOW)
    assert [a.id for a in chosen["nz_national"]] == ["n1"]


def test_radar_prefers_profile_topics_and_has_no_overlap(cfg):
    class RadarLLM(SplitLLM):
        RADAR = {"r1": 9, "r2": 8, "r3": 2, "r4": 3, "n1": 0}

        def json_call(self, **kw):
            out = super().json_call(**kw)
            if kw["task"] == "rank" and "scores" in out:
                for r in out["scores"]:
                    r["radar"] = self.RADAR.get(r["id"], 0)
                    r["score"] = 8
            return out
    items = [
        art("r1", "Post-study work visa holders get longer to find skilled jobs"),       # 전국 피드 → 레이더로
        art("r2", "Skilled Migrant Category points threshold unchanged", section="nz_immigration"),
        art("r3", "Student visa refusals spike amid fraud crackdown"),                  # 학생비자: 관심 낮음
        art("r4", "Tourist visa fees to rise", section="nz_immigration"),
        art("n1", "Inflation eases to 2.1 percent"),
    ]
    chosen = select(items, cfg, RadarLLM(set(), {}), FIXTURE_NOW)
    radar = [a.id for a in chosen["nz_immigration"]]
    nat = {a.id for a in chosen["nz_national"]}
    assert radar == ["r1", "r2"]               # 졸업 후 취업비자·영주권만, 관련도 순
    assert "r1" not in nat and nat >= {"n1", "r3"}  # 레이더 기사는 뉴질랜드 탭에서 빠지고, 학생비자 기사는 뉴질랜드 탭에 남음


def test_heuristic_radar_scores(cfg):
    assert heuristic_radar(art(1, "Changes to post-study work visa rules"), cfg) >= 8
    assert heuristic_radar(art(2, "Green List residence pathway expanded"), cfg) >= 8
    assert heuristic_radar(art(3, "International students: student visa refusals rise"), cfg) <= 3
    assert heuristic_radar(art(4, "Inflation eases"), cfg) == 0


def test_radar_low_topics_capped_even_if_ai_scores_high(cfg):
    class HighLLM(SplitLLM):
        def json_call(self, **kw):
            out = super().json_call(**kw)
            if kw["task"] == "rank" and "scores" in out:
                for r in out["scores"]:
                    r["radar"], r["score"] = 9, 8
            return out
    items = [art("s1", "Student visa refusals spike amid fraud crackdown"),
             art("f1", "Global mobility forum discusses residence options", section="nz_immigration"),
             art("w1", "Median wage threshold for work visas to change", section="nz_immigration")]
    radar = [a.id for a in select(items, cfg, HighLLM(set(), {}), FIXTURE_NOW)["nz_immigration"]]
    assert "w1" in radar and "s1" not in radar
    assert "f1" in radar  # 'residence'(관심 키워드)가 함께 있으면 제한하지 않음


def test_kr_story_not_repeated_across_categories(cfg):
    items = [art("k1", "SK 솔리다임, 트럼프 측근 로비스트 영입", section="kr_economy"),
             art("k1", "SK 솔리다임, 트럼프 측근 로비스트 영입", section="kr_politics"),
             art("k2", "국정감사 여야 정면충돌", section="kr_politics")]
    chosen = select(items, cfg, None, FIXTURE_NOW)
    assert [a.id for a in chosen["kr_economy"]] == ["k1"]
    assert [a.id for a in chosen["kr_politics"]] == ["k2"]


def test_cap_radar_study_visa_wording(cfg):
    from rank import cap_radar
    assert cap_radar(art(1, "What is behind a recent spike in refused study visa applications?"), cfg, 9) == 3
    assert cap_radar(art(2, "Post-study work visa changes for graduates"), cfg, 9) == 9


def test_gemini_timeout_moves_to_next_model(cfg):
    urls = []

    def handler(req):
        urls.append(str(req.url))
        if "gemini-3.8-flash:" in str(req.url):
            raise httpx.ReadTimeout("The read operation timed out", request=req)
        return httpx.Response(200, json=_gemini_ok('{"ok": 4}'))

    llm = _gemini(cfg, handler)
    assert llm.json_call(task="summary", system="s", user="u", schema={}) == {"ok": 4}
    assert sum("gemini-3.8-flash:" in u for u in urls) == 2 and "gemini-flash-latest" in urls[-1]
