import json

from usage import over_cap, record, used_today


def test_record_accumulates_and_caps(cfg, tmp_path):
    cfg = {**cfg, "llm": {**cfg["llm"], "daily_cap": 14, "expected_per_run": 6}}
    record(tmp_path, "2026-10-29", 6, cfg)
    assert used_today(tmp_path, "2026-10-29") == 6
    assert over_cap(tmp_path, "2026-10-29", cfg) == (False, 6, 14)     # 6 + 6 <= 14
    record(tmp_path, "2026-10-29", 6, cfg)
    assert over_cap(tmp_path, "2026-10-29", cfg) == (True, 12, 14)
    assert over_cap(tmp_path, "2026-10-30", cfg)[0] is False             # 날짜가 바뀌면 새로
    d = json.loads((tmp_path / "ai-usage.json").read_text())
    assert d["days"]["2026-10-29"] == {"requests": 12, "runs": 2} and d["cap"] == 14


def test_forced_rerun_skipped_when_over_cap(cfg, tmp_path, monkeypatch):
    import main as main_mod
    data = tmp_path / "web" / "public" / "data"
    data.mkdir(parents=True)
    (data / "2026-10-29.json").write_text("{}")
    record(data, "2026-10-29", 12, cfg)
    monkeypatch.setattr(main_mod, "ROOT", tmp_path)
    called = []
    monkeypatch.setattr("fetch.fetch_all", lambda *a, **k: called.append(1) or ([], [], {}))
    from pathlib import Path
    cfg_path = str(Path(__file__).resolve().parent.parent / "config.yaml")
    rc = main_mod.main(["--config", cfg_path, "--force", "--now", "2026-10-29T08:00:00+13:00"])
    assert rc == 0 and called == []
