import json
from pathlib import Path

from usage import record, used_today


def test_record_accumulates_per_day(cfg, tmp_path):
    record(tmp_path, "2026-10-29", 6, cfg)
    record(tmp_path, "2026-10-29", 2, cfg)
    record(tmp_path, "2026-10-30", 5, cfg)
    assert used_today(tmp_path, "2026-10-29") == 8 and used_today(tmp_path, "2026-10-30") == 5
    d = json.loads((tmp_path / "ai-usage.json").read_text())
    assert d["days"]["2026-10-29"] == {"requests": 8, "runs": 2} and d["cap"] == cfg["llm"]["guaranteed"] == 7


def test_forced_rerun_skipped_when_no_budget_left(cfg, tmp_path, monkeypatch):
    import budget
    import main as main_mod
    data = tmp_path / "web" / "public" / "data"
    data.mkdir(parents=True)
    (data / "2026-10-29.json").write_text("{}")
    record(data, "2026-10-29", 8, cfg)                         # 보장량 7 을 넘게 씀
    monkeypatch.setattr(main_mod, "ROOT", tmp_path)
    monkeypatch.setattr(budget, "fetch_json", lambda *a, **k: None)   # My Hub 를 못 읽으면 내 보장량만 → 남은 0회
    called = []
    monkeypatch.setattr("fetch.fetch_all", lambda *a, **k: called.append(1) or ([], [], {}))
    cfg_path = str(Path(__file__).resolve().parent.parent / "config.yaml")
    rc = main_mod.main(["--config", cfg_path, "--force", "--now", "2026-10-29T08:00:00+13:00"])
    assert rc == 0 and called == []
