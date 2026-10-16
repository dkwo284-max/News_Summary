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
