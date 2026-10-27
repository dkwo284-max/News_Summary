import json

import main as main_mod


def test_update_processing_only(cfg, tmp_path, monkeypatch):
    (tmp_path / "latest.json").write_text(json.dumps({"date": "2026-10-16", "extras": {"nzd_krw": 750}, "sections": {}}))
    monkeypatch.setattr("processing.fetch_processing_times",
                        lambda cfg, llm, prev: {"updated_at": "x", "items": [{"key": "smc", "p90": "3.5개월"}]})
    called = []
    monkeypatch.setattr("extras.fetch_extras", lambda cfg: {"nzd_krw": None, "btc_usd": 100000})
    monkeypatch.setattr("korean_gp.update_korean_gp", lambda cfg, d: called.append("gp"))
    monkeypatch.setattr("areas.update_areas", lambda cfg, d, today: called.append(("areas", today.isoformat())))
    monkeypatch.setattr("incidents.update_incidents", lambda secs, cfg, d, today: called.append("incidents"))
    assert main_mod.update_processing_only(cfg, tmp_path) == 0
    assert called == ["gp", ("areas", "2026-10-16"), "incidents"]   # AI 없이 갱신되는 부가 데이터도 함께
    for name in ("latest.json", "2026-10-16.json"):
        d = json.loads((tmp_path / name).read_text())
        assert d["extras"]["processing_times"]["items"][0]["p90"] == "3.5개월" and d["extras"]["nzd_krw"] == 750 and d["extras"]["btc_usd"] == 100000
