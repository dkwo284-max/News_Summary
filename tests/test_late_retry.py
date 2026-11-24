"""늦은 안전망 재시도(--retry-late): 현지 11:00~14:29 에만, 제대로 끝났으면 아무것도 안 함, 브리핑이 없거나 degraded 일 때만 움직임"""
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import main as main_mod
from common import load_config

ROOT = Path(__file__).resolve().parent.parent
CFG = load_config(ROOT / "config.yaml")


def utc(s):
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def test_window_covers_11_to_14_for_both_daylight_saving_bands():
    from zoneinfo import ZoneInfo
    nz = ZoneInfo("Pacific/Auckland")
    ok = lambda s: main_mod.late_retry_ok(CFG, utc(s).astimezone(nz))   # noqa: E731
    # 서머타임(NZDT, UTC+13): 22·23·0·1시 UTC = 현지 11·12·13·14시 → 실행, 2시 UTC = 15시 → 건너뜀
    assert [ok(f"2026-11-23T{h:02d}:00") for h in (22, 23)] == [True, True] and ok("2026-11-24T00:00") and ok("2026-11-24T01:00")
    assert not ok("2026-11-24T02:00") and not ok("2026-11-23T21:00")
    # 표준시(NZST, UTC+12): 23·0·1·2시 UTC = 현지 11~14시 → 실행, 22시 UTC = 10시 → 건너뜀
    assert ok("2026-06-23T23:00") and ok("2026-06-24T00:00") and ok("2026-06-24T01:00") and ok("2026-06-24T02:00")
    assert not ok("2026-06-23T22:00") and not ok("2026-06-24T03:00")
    # 14:29 까지는 예약이 늦어져도 받고, 14:30 부터는 안 함
    assert ok("2026-11-24T01:29") and not ok("2026-11-24T01:30")


def run(tmp_path, monkeypatch, now, brief=None, extra=()):
    """main 을 실제로 돌리되 데이터 폴더만 임시 폴더로, 생성·복구 단계는 호출 여부만 기록"""
    cfg = json.loads(json.dumps(CFG))
    data = tmp_path / "data"
    data.mkdir(exist_ok=True)
    cfg["output"]["data_dir"] = str(data)
    monkeypatch.setattr(main_mod, "ROOT", tmp_path)
    cfg["output"]["data_dir"] = "data"
    monkeypatch.setattr(main_mod, "load_config", lambda _p=None: cfg)
    local = utc(now).astimezone(main_mod.tz(cfg))
    if brief is not None:
        (data / f"{local.date().isoformat()}.json").write_text(json.dumps(brief), encoding="utf-8")
    calls = []
    monkeypatch.setattr(main_mod, "repair_only", lambda *a, **k: (calls.append("repair"), 0)[1])

    class Stop(Exception):
        pass

    def boom(*a, **k):
        calls.append("generate")
        raise Stop

    import fetch
    monkeypatch.setattr(fetch, "fetch_all", boom, raising=False)
    monkeypatch.setattr(main_mod, "set_output", lambda *a, **k: None)
    try:
        rc = main_mod.main(["--retry-late", "--no-llm", *extra, "--now", now.replace("T", "T") + "+00:00"])
    except Stop:
        rc = "stop"
    except Exception as e:  # noqa: BLE001 — 생성 경로가 가짜 fetch 전에 다른 곳에서 막혀도 '생성하려 했다'는 것만 보면 된다
        rc = f"err:{type(e).__name__}"
    return rc, calls


def test_fine_brief_means_nothing_to_do(tmp_path, monkeypatch):
    rc, calls = run(tmp_path, monkeypatch, "2026-11-24T00:00", brief={"meta": {"degraded": False, "retries": 0}, "sections": {}})
    assert rc == 0 and calls == []


def test_outside_window_does_nothing_even_if_degraded(tmp_path, monkeypatch):
    rc, calls = run(tmp_path, monkeypatch, "2026-11-24T02:00", brief={"meta": {"degraded": True, "retries": 0}, "sections": {}})   # 현지 15:00
    assert rc == 0 and calls == []


def test_degraded_brief_is_repaired_in_window_and_cap_is_raised_for_late_runs(tmp_path, monkeypatch):
    rc, calls = run(tmp_path, monkeypatch, "2026-11-24T00:00", brief={"meta": {"degraded": True, "retries": 0, "degraded_reason": "요약 실패"}, "sections": {"kr_society": {"items": []}}})
    assert calls == ["repair"]
    # 새벽 복구를 10번 다 썼어도 늦은 안전망은 4번 더 (총 14번)
    rc, calls = run(tmp_path, monkeypatch, "2026-11-24T00:00", brief={"meta": {"degraded": True, "retries": 10, "degraded_reason": "요약 실패"}, "sections": {"kr_society": {"items": []}}})
    assert calls == ["repair"]
    rc, calls = run(tmp_path, monkeypatch, "2026-11-24T00:00", brief={"meta": {"degraded": True, "retries": 14, "degraded_reason": "요약 실패"}, "sections": {"kr_society": {"items": []}}})
    assert rc == 0 and calls == []


def test_missing_brief_is_generated_even_outside_the_morning_window(tmp_path, monkeypatch):
    rc, calls = run(tmp_path, monkeypatch, "2026-11-24T00:00")   # 현지 13:00, 오늘 파일 없음
    assert calls == ["generate"]      # 아침 시각 창(03~09시) 밖인데도 기사 수집부터 생성을 시도한다
