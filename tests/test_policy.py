import json
from datetime import date

from policy import scan_brief, update_policy_news


def _brief(day, items, sec="nz_immigration"):
    return {"date": day, "sections": {sec: {"items": items}, "kr_politics": {"items": [{
        "title_ko": "노동당 이민", "summary_ko": [], "sources": [{"name": "x", "url": "https://kr"}]}]}}}


def _item(title, url, summary=""):
    return {"title_ko": title, "original_title": title, "summary_ko": [summary] if summary else [], "sources": [{"name": "RNZ", "url": url}]}


def test_scan_finds_party_and_issue_and_skips_kr():
    b = _brief("2026-11-06", [
        _item("Labour would double the wait for permanent residence", "https://a", ""),
        _item("Labour market weakens as unemployment rises", "https://b"),       # 일반 'Labour market' → 정당 아님
        _item("ACT proposes $6 daily surcharge on work visa holders", "https://c"),
        _item("Housing prices rise", "https://d"),
    ])
    got = {x["url"]: x for x in scan_brief(b)}
    assert set(got) == {"https://a", "https://c"}
    assert got["https://a"]["parties"] == ["labour"] and "pr_path" in got["https://a"]["issues"] and got["https://a"]["change"]
    assert got["https://c"]["parties"] == ["act"] and "work_visa" in got["https://c"]["issues"]


def test_accumulates_and_keeps_first_seen_date(tmp_path):
    d = tmp_path
    b1 = _brief("2026-11-05", [_item("NZ First unveils immigration policy on citizenship", "https://x")])
    update_policy_news(d, date(2026, 11, 5), b1)
    b2 = _brief("2026-11-06", [_item("NZ First unveils immigration policy on citizenship", "https://x"),
                               _item("Greens want amnesty for overstayers", "https://y")])
    n = update_policy_news(d, date(2026, 11, 6), b2)
    items = json.loads((d / "policy-news.json").read_text(encoding="utf-8"))["items"]
    assert n == 2
    assert {x["url"]: x["date"] for x in items} == {"https://x": "2026-11-05", "https://y": "2026-11-06"}


def test_backfill_from_saved_briefs(tmp_path):
    (tmp_path / "2026-11-01.json").write_text(json.dumps(_brief("2026-11-01", [_item("Winston Peters promises visa cap", "https://z")]), ensure_ascii=False), encoding="utf-8")
    assert update_policy_news(tmp_path, date(2026, 11, 2)) == 1


def test_curated_policy_json_is_consistent():
    from pathlib import Path
    d = json.loads((Path(__file__).resolve().parent.parent / "web/public/data/policy.json").read_text(encoding="utf-8"))
    issues = {x["id"] for x in d["issues"]}
    for p in d["parties"]:
        for k, v in p["positions"].items():
            assert k in issues and v["dir"] in d["dirs"] and v["status"] in d["statuses"]
            assert v["src"] and set(v["src"]) <= set(d["sources"])
    for t in d["timeline"] + d["govt"] + d["watch"]:
        assert set(t["src"]) <= set(d["sources"])
    assert all(g["type"] in ("done", "pending", "pledge") for g in d["govt"])


def test_status_builds_from_brief(tmp_path):
    from status import build_status

    (tmp_path / "leisure.json").write_text('{"updated_at": "2026-11-09"}', encoding="utf-8")
    b = {"date": "2026-11-09", "generated_at": "x", "meta": {"degraded": True, "degraded_reason": "요약 실패", "feeds_total": 3, "failed_feeds": [{"id": "a", "name": "A"}], "usage": {"requests": 4}}, "extras": {}}
    st = build_status(tmp_path, b)
    assert st["brief"]["degraded"] and st["feeds"]["failed"][0]["id"] == "a" and st["files"]["leisure"] == "2026-11-09"


def test_notify_content_options():
    from notify import compose

    brief = {"date": "2026-11-09", "meta": {"degraded": True, "alerts": [{"text": "처리 기간 변화"}]}, "extras": {"nzd_krw": 800},
             "sections": {"nz_immigration": {"label": "이민", "briefing": "b1", "items": [{"title_ko": "큰 뉴스", "impact": {"level": "high"}}]},
                          "akl_life": {"label": "생활", "briefing": "b2", "items": [{"title_ko": "x"}]}}}
    cfg = {"output": {"app_url": "u"}, "notify": {"content": {"sections": ["nz_immigration"], "high_impact": True, "weather_fx": False}}}
    t = compose(brief, cfg)
    assert "⚠️" in t and "🚨 이민 알림" in t and "🎯" in t and "큰 뉴스" in t and "b1" in t and "b2" not in t and "💱" not in t
