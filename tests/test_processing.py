import httpx
import pytest

from processing import fetch_processing_times, parse_processing


@pytest.mark.parametrize("text,p50,p90", [
    ("50% of applications are processed within 3 weeks. 90% of applications are processed within 6 months.", "3주", "6개월"),
    ("90% of visa applications were decided within 11 months", "", "11개월"),
    ("Processing times are currently taking 8 to 10 months for most applications.", "8개월", "10개월"),
    ("Processing time: about 12 weeks", "", "12주"),
    ("Current processing time 2.5 months", "", "2.5개월"),
])
def test_parse_processing(text, p50, p90):
    r = parse_processing(text)
    assert r and r["p50"] == p50 and r["p90"] == p90


def test_parse_ignores_validity_periods():
    assert parse_processing("This visa lets you stay for up to 3 years. It costs $700.") is None


def _cfg(cfg):
    cfg["processing_times"] = [
        {"key": "smc", "name": "SMC", "urls": ["https://a.example/dead", "https://a.example/smc"]},
        {"key": "wtr", "name": "WTR", "urls": ["https://a.example/wtr"]},
        {"key": "cit", "name": "Citizenship", "urls": ["https://a.example/cit"]},
    ]
    return cfg


def test_fetch_with_fallback_url_ai_and_stale(cfg):
    pages = {
        "https://a.example/smc": "<p>90% of applications are processed within 7 months</p>",
        "https://a.example/wtr": "<p>We aim to process applications as quickly as possible.</p>",
    }

    def handler(req):
        url = str(req.url)
        return httpx.Response(200, text=pages[url]) if url in pages else httpx.Response(404)

    class FakeAI:
        def json_call(self, **kw):
            return {"items": [{"key": "wtr", "p50": "", "p90": "4개월", "note": "most decided in 4 months"}]}

    prev = {"items": [{"key": "cit", "p50": "", "p90": "15개월", "note": "x", "url": "https://a.example/cit", "as_of": "2026-10-01"}]}
    res = fetch_processing_times(_cfg(cfg), llm=FakeAI(), previous=prev, client=httpx.Client(transport=httpx.MockTransport(handler)))
    by = {it["key"]: it for it in res["items"]}
    assert by["smc"]["p90"] == "7개월" and by["smc"]["url"] == "https://a.example/smc" and by["smc"]["status"] == "ok"
    assert by["wtr"]["p90"] == "4개월" and by["wtr"]["status"] == "ok"
    assert by["cit"]["status"] == "stale" and by["cit"]["as_of"] == "2026-10-01"


def test_parse_inz_visa_page_format():
    text = "Apply online - Length of stay Up to 3 years - Cost From NZD $1670 - Processing time 80% within 4 weeks - Residence option"
    r = parse_processing(text)
    assert r["p90"] == "4주" and r["pct"] == 80 and r["p50"] == ""


def test_parse_with_match_on_multi_visa_page():
    text = ("Student Visa 80% within 6 weeks. Skilled Migrant Category Resident Visa 80% within 9 months. "
            "Work to Residence Visa 80% within 5 months.")
    assert parse_processing(text, "Skilled Migrant Category")["p90"] == "9개월"
    assert parse_processing(text, "Work to Residence")["p90"] == "5개월"
    assert parse_processing(text, "Parent Category") is None


def test_parse_inz_wait_times_table():
    text = ("| Parent Resident Visa | 7 months | 11 months | | Skilled Migrant Category Resident Visa | 9 weeks | 3.5 months | "
            "| Work to Residence Visa | 8 weeks | 3 months | | Permanent Resident Visa | 1.5 weeks | 2 weeks |")
    r = parse_processing(text, "Skilled Migrant Category Resident Visa")
    assert (r["p50"], r["p90"], r["pct"]) == ("9주", "3.5개월", 80)
    assert parse_processing(text, "Permanent Resident Visa")["p50"] == "1.5주"


def test_parse_dia_citizenship():
    text = ("In general: - within 4 months of submitting their application, 90% of applicants receive an outcome - "
            "within 6 months of submitting their application, 90% of applicants are granted citizenship.")
    r = parse_processing(text)
    assert r["p90"] == "6개월" and r["pct"] == 90 and r["sub"] == "90%가 4개월 안에 결과 통보"


def test_fx_prefers_coinbase_then_frankfurter():
    from extras import fetch_fx

    def handler(req):
        if "coinbase" in str(req.url):
            return httpx.Response(200, json={"data": {"currency": "NZD", "rates": {"KRW": "754.1334257"}}})
        return httpx.Response(200, json={"rates": {"KRW": 750.0}})

    assert fetch_fx(httpx.Client(transport=httpx.MockTransport(handler)), "NZD", "KRW") == 754.13

    def down(req):
        if "coinbase" in str(req.url):
            return httpx.Response(503)
        return httpx.Response(200, json={"rates": {"KRW": 750.0}})

    assert fetch_fx(httpx.Client(transport=httpx.MockTransport(down)), "NZD", "KRW") == 750.0


def test_history_trend_and_alerts(tmp_path):
    import json as _json
    from processing import processing_alerts, to_days, update_history

    assert to_days("3.5개월") == 3.5 * 30.4 and to_days("9주") == 63 and to_days("") is None
    (tmp_path / "processing-history.json").write_text(_json.dumps({
        "smc": [{"date": "2026-10-10", "p50": "9주", "p90": "3.5개월"}],
        "aewv": [{"date": "2026-10-12", "p50": "2주", "p90": "5주"}],
    }))
    res = {"items": [
        {"key": "smc", "name": "SMC", "p50": "10주", "p90": "5개월", "status": "ok"},
        {"key": "aewv", "name": "AEWV", "p50": "2주", "p90": "5주", "status": "ok"},
        {"key": "pr", "name": "PR", "p50": "", "p90": "2주", "status": "ok"},
    ]}
    out = update_history(res, tmp_path, "2026-10-21")
    by = {it["key"]: it for it in out["items"]}
    assert by["smc"]["trend"]["delta_days"] == round(5 * 30.4 - 3.5 * 30.4)
    assert by["aewv"]["trend"]["delta_days"] == 0 and "trend" not in by["pr"]
    hist = _json.loads((tmp_path / "processing-history.json").read_text())
    assert hist["smc"][-1] == {"date": "2026-10-21", "p50": "10주", "p90": "5개월"} and len(hist["pr"]) == 1
    alerts = processing_alerts(out)
    assert [a["key"] for a in alerts] == ["smc"] and "3.5개월 → 5개월" in alerts[0]["text"]
    # 같은 날 다시 실행해도 중복으로 쌓이지 않음
    update_history(res, tmp_path, "2026-10-21")
    assert len(_json.loads((tmp_path / "processing-history.json").read_text())["smc"]) == 2


def test_history_seeded_from_past_briefs(tmp_path):
    import json as _json
    from processing import update_history
    (tmp_path / "2026-10-12.json").write_text(_json.dumps({"extras": {"processing_times": {"items": [
        {"key": "smc", "p50": "9주", "p90": "3.5개월", "status": "ok"}]}}}))
    out = update_history({"items": [{"key": "smc", "name": "SMC", "p50": "9주", "p90": "4개월", "status": "ok"}]}, tmp_path, "2026-10-21")
    assert out["items"][0]["trend"]["prev_p90"] == "3.5개월"
