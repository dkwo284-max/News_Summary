"""AI 선별 실패(규칙 선별로 대체)는 품질 저하로 치지 않는다: 전체 재생성으로 넘기지 않고, 요약 실패가 같이 있으면 요약만 고친다."""
import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import main as main_mod
import repair
from common import load_config

ROOT = Path(__file__).resolve().parent.parent
CFG = load_config(ROOT / "config.yaml")
NOW = datetime(2026, 11, 25, 4, 0, tzinfo=ZoneInfo("Pacific/Auckland"))


def test_rank_only_failure_is_cleared_without_ai(tmp_path, monkeypatch):
    monkeypatch.setattr(main_mod, "set_output", lambda *a, **k: None)
    called = []
    monkeypatch.setattr(repair, "repair", lambda *a, **k: called.append(1))
    cur = {"date": "2026-11-25", "meta": {"degraded": True, "degraded_reason": "선별 실패", "retries": 1}, "sections": {"kr_society": {"items": []}}}
    rc = main_mod.repair_only(CFG, tmp_path, cur, NOW, 2, SimpleNamespace(ignore_cap=True))
    assert rc == 0 and not called
    saved = json.loads((tmp_path / "2026-11-25.json").read_text(encoding="utf-8"))
    assert saved["meta"]["degraded"] is False and saved["meta"]["rank_fallback"] is True and saved["meta"]["degraded_reason"] == ""
    assert json.loads((tmp_path / "latest.json").read_text(encoding="utf-8"))["meta"]["degraded"] is False


def test_rank_plus_summary_failure_repairs_summary_instead_of_full_regen(tmp_path, monkeypatch):
    monkeypatch.setattr(main_mod, "set_output", lambda *a, **k: None)
    import llm as llm_mod

    class FakeLLM:
        max_requests = 9
        def log_report(self):
            return {"requests": 1}
    monkeypatch.setattr(llm_mod, "make_llm", lambda cfg: FakeLLM())
    called = []

    def fake_repair(cur, cfg, llm, data_dir, today):
        called.append(today)
        cur["sections"]["kr_society"].pop("error", None)
        return {"summary": ["kr_society"], "insight": False, "requests": 1}
    monkeypatch.setattr(repair, "repair", fake_repair)
    import incidents
    monkeypatch.setattr(incidents, "update_incidents", lambda *a, **k: None)
    import notify
    monkeypatch.setattr(notify, "notify", lambda *a, **k: None)
    cur = {"date": "2026-11-25", "meta": {"degraded": True, "degraded_reason": "요약 실패: kr_society; 선별 실패", "retries": 1},
           "sections": {"kr_society": {"items": [], "error": "x"}}, "extras": {}}
    rc = main_mod.repair_only(CFG, tmp_path, cur, NOW, 2, SimpleNamespace(ignore_cap=True))
    assert rc == 0 and called == ["2026-11-25"]
    saved = json.loads((tmp_path / "2026-11-25.json").read_text(encoding="utf-8"))
    assert saved["meta"]["degraded"] is False
