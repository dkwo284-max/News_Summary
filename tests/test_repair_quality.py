import json

import quality
import repair
import status
import usage


def item(i, title="한국어 제목입니다", summary=("첫째 줄 요약입니다.", "둘째 줄 요약입니다.", "셋째 줄입니다."), **kw):
    return {"id": i, "title_ko": title, "summary_ko": list(summary), "tags": [], "importance": 6, "sources": [{"name": "RNZ", "url": f"https://x/{i}"}],
            "original_title": kw.pop("orig", "Original English title"), "published_at": "2026-11-12T05:00+13:00", **kw}


CFG = {"sections": {"kr_society": {"region": "kr", "label": "사회"}, "nz_society": {"region": "nz", "label": "사회"}, "akl_life": {"region": "nz", "label": "생활"}},
       "insight": {"enabled": True}, "fetch": {}, "weights": {"high": []}}


def test_quality_flags_untranslated_and_thin_items_and_asks_redo_per_region():
    ok = [item(f"k{i}") for i in range(4)]
    bad = [item("n1", title="Police swarm Auckland street", summary=("Police swarm Auckland street after incident.",), orig="Police swarm Auckland street"),
           item("n2", title="Rents rise again", summary=("Rents rise.", "Again."), orig="Rents rise again"), item("n3"), item("n4")]
    q = quality.check({"kr_society": {"items": ok}, "nz_society": {"items": bad}}, CFG)
    assert q["bad"] == 2 and q["redo"] == ["nz"] and q["by_region"]["kr"]["bad"] == 0 and set(q["bad_ids"]) == {"n1", "n2"}
    assert "제목 미번역" in quality.item_problems(bad[0]) and quality.item_problems(ok[0]) == []
    assert quality.check({"nz_society": {"items": [item("c", title="English only title here", carried_from="2026-11-10")]}}, CFG)["items"] == 0


def test_repair_resummarizes_only_failed_sections_and_keeps_the_rest(monkeypatch):
    brief = {"date": "2026-11-12", "meta": {"degraded": True, "degraded_reason": "요약 실패: nz_society"},
             "sections": {"kr_society": {"label": "사회", "briefing": "b", "items": [item("k1")]},
                          "nz_society": {"label": "사회", "briefing": "요약 생성에 실패", "error": "503", "items": [item("n1", title="Rents rise", summary=("Rents rise in Auckland.",), orig="Rents rise"), item("old", carried_from="2026-11-10")]}}}
    assert repair.needs(brief, CFG) == {"summary": ["nz_society"], "insight": True, "rank": False}

    class LLM:
        requests = 0

        def json_call(self, *, task, system, user, schema, max_tokens=0):
            self.requests += 1
            assert "[id] n1" in user and "k1" not in user and "[id] old" not in user          # 실패한 섹션의 새 기사만 다시 보낸다
            return {"briefings": [{"section": "nz_society", "briefing": "렌트 상승"}],
                    "items": [{"id": "n1", "title_ko": "오클랜드 렌트 상승", "summary_ko": ["가", "나", "다"], "why_it_matters": "렌트 부담", "tags": ["렌트"], "number": "", "number_label": ""}]}
    import insight
    monkeypatch.setattr(insight, "attach_insights", lambda *a, **k: 1)
    llm = LLM()
    done = repair.repair(brief, CFG, llm, None, "2026-11-12", fetch_bodies=False)
    s = brief["sections"]["nz_society"]
    assert done["summary"] == ["nz_society"] and done["requests"] == 1 and "error" not in s
    assert s["items"][0]["title_ko"] == "오클랜드 렌트 상승" and s["items"][1]["id"] == "old"   # 이어 온 기사는 그대로
    assert brief["sections"]["kr_society"]["items"][0]["title_ko"] == "한국어 제목입니다"
    assert repair.needs({"meta": {"degraded_reason": "선별 실패"}, "sections": {}}, CFG)["rank"]


def test_usage_by_kind_and_week_quality(tmp_path, monkeypatch):
    monkeypatch.delenv("AI_PROFILE", raising=False)
    usage.record(tmp_path, "2026-11-12", 4, {"llm": {}}, kind="scheduled")
    usage.record(tmp_path, "2026-11-12", 2, {"llm": {}}, kind="retry")
    u = usage.record(tmp_path, "2026-11-12", 40, {"llm": {}}, kind="side")
    assert u["days"]["2026-11-12"] == {"requests": 46, "runs": 3, "by": {"scheduled": 4, "retry": 2, "side": 40}} and usage.run_kind() == "manual"
    (tmp_path / "2026-11-12.json").write_text(json.dumps({"meta": {"degraded": False, "retries": 1, "repaired": {"summary": ["x"]}, "quality": {"items": 60, "bad": 3, "redone": ["nz"]}}}))
    (tmp_path / "2026-11-11.json").write_text(json.dumps({"meta": {"degraded": True, "retries": 2}}))
    w = status.week_quality(tmp_path, "2026-11-12", u)
    assert w == {"days": 2, "degraded": 1, "repaired": 1, "retries": 3, "bad_items": 3, "items": 60, "redone": 1, "requests": 46, "by": {"scheduled": 4, "retry": 2, "side": 40}}
