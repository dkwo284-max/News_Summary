import json

import main as main_mod


def test_update_processing_only(cfg, tmp_path, monkeypatch):
    (tmp_path / "latest.json").write_text(json.dumps({"date": "2026-10-16", "extras": {"nzd_krw": 750}, "sections": {}}))
    monkeypatch.setattr("processing.fetch_processing_times",
                        lambda cfg, llm, prev: {"updated_at": "x", "items": [{"key": "smc", "p90": "3.5개월"}]})
    assert main_mod.update_processing_only(cfg, tmp_path) == 0
    for name in ("latest.json", "2026-10-16.json"):
        d = json.loads((tmp_path / name).read_text())
        assert d["extras"]["processing_times"]["items"][0]["p90"] == "3.5개월" and d["extras"]["nzd_krw"] == 750
