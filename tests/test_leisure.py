import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import leisure  # noqa: E402


def test_amount_in_text_matches_exact_number_only():
    t = "Full membership $1,325.00 per year. Joining fee $500. Social $40"
    assert leisure.amount_in_text(1325, t) and leisure.amount_in_text(500, t) and leisure.amount_in_text(40, t)
    assert not leisure.amount_in_text(132, t)       # 1,325 의 일부는 아님
    assert not leisure.amount_in_text(1300, t)      # 글에 없는 숫자(추정)
    assert leisure.amount_in_text(1195, "Off-peak $1195")


def test_clean_fees_drops_unverifiable_and_normalises():
    text = "Adult $1,885 Joining fee $500 junior $100"
    fees = [
        {"label": "Full", "kind": "adult", "amount": 1885, "period": "year", "quote": "Adult $1,885"},
        {"label": "Couple", "kind": "couple", "amount": 3000, "period": "year", "quote": "made up"},   # 글에 없음 → 버림
        {"label": "Joining", "kind": "joining", "amount": 500, "period": "once", "quote": "Joining fee $500"},
        {"label": "Weird", "kind": "unknown-kind", "amount": 100, "period": "fortnight", "quote": "junior $100"},
        {"label": "Full", "kind": "adult", "amount": 1885, "period": "year", "quote": "dup"},          # 중복
    ]
    out = leisure.clean_fees(fees, text)
    assert [(f["kind"], f["amount"]) for f in out] == [("adult", 1885.0), ("joining", 500.0), ("other", 100.0)]
    assert out[2]["period"] == "year"


def test_merge_manual_overrides_and_hides():
    fac = {"id": "g-a", "fees": [{"label": "Full", "kind": "adult", "amount": 100, "period": "year"}], "status": "open"}
    manual = {"g-a": {"rating": {"v": 4.4, "n": 120, "asof": "2026-11"}, "fees": [{"label": "Full", "kind": "adult", "amount": 1200, "period": "year"}],
                      "checked": "2026-11-01"}}
    out = leisure.merge_manual(dict(fac), manual)
    assert out["rating"]["v"] == 4.4 and [f["amount"] for f in out["fees"]] == [1200] and out["fees"][0]["source"] == "manual"
    assert out["checked"] == "2026-11-01"
    assert leisure.merge_manual({"id": "x"}, {"x": {"hide": True}})["hide"] is True


def test_discover_links_same_site_and_fee_words():
    html = ('<a href="/membership">Membership</a><a href="/about">About</a><a href="https://other.com/fees">Fees</a>'
            '<a href="/green-fees">Green fees</a><a href="/img/logo.png">Join</a>')
    assert leisure.discover_links(html, "https://club.nz/") == ["https://club.nz/membership", "https://club.nz/green-fees"]


def test_focus_keeps_fee_lines_when_long():
    lines = [f"filler line {i}" for i in range(400)] + ["Full membership $1,885"] + [f"more filler {i}" for i in range(400)]
    out = leisure.focus("\n".join(lines), 500)
    assert "$1,885" in out and len(out) <= 500


def test_in_auckland_bbox():
    assert leisure.in_auckland(-36.85, 174.76)
    assert not leisure.in_auckland(-41.28, 174.77)   # 웰링턴


class FakeLLM:
    def __init__(self):
        self.calls = []
        self.requests = 0

    def json_call(self, *, task, system, user, schema, max_tokens=16000):
        self.calls.append(user)
        self.requests += 1
        return {"items": [
            {"id": "g-a", "status": "open", "season": "2026", "note": "", "fees": [
                {"label": "Full", "kind": "adult", "amount": 1885, "period": "year", "quote": "Full $1,885"},
                {"label": "Invented", "kind": "family", "amount": 9999, "period": "year", "quote": "x"}]},
        ]}


def test_build_end_to_end_with_fake_network(tmp_path):
    def handler(req: httpx.Request) -> httpx.Response:
        if "nominatim" in str(req.url):
            return httpx.Response(200, json=[{"lat": "-36.78", "lon": "174.77"}])
        return httpx.Response(200, text="<html><body><p>Full $1,885 per year</p></body></html>", headers={"content-type": "text/html"})

    leisure.time.sleep = lambda s: None
    src = {"facilities": [{"id": "g-a", "kind": "golf", "name": "A Golf Club", "home": "https://a.nz", "pages": ["https://a.nz/membership"]},
                          {"id": "g-b", "kind": "golf", "name": "B Golf Club", "home": None}]}
    llm = FakeLLM()
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        out = leisure.build(src, {}, {}, client, llm, "2026-11-05")
    a = next(f for f in out["facilities"] if f["id"] == "g-a")
    assert a["ll"] == [-36.78, 174.77] and [f["amount"] for f in a["fees"]] == [1885.0]   # 창작 금액은 걸러짐
    assert a["status"] == "open" and a["checked"] == "2026-11-05" and a["src"] == ["https://a.nz/membership"]
    b = next(f for f in out["facilities"] if f["id"] == "g-b")
    assert b["fees"] == [] and b["checked"] == "" and b["status"] == "unknown"             # 공식 사이트가 없으면 미확인
    assert len(llm.calls) == 1
    json.dumps(out)


def test_build_keeps_previous_values_when_ai_fails():
    class BadLLM:
        requests = 0

        def json_call(self, **kw):
            raise RuntimeError("boom")

    leisure.time.sleep = lambda s: None
    old = {"facilities": [{"id": "g-a", "kind": "golf", "name": "A", "fees": [{"label": "Full", "kind": "adult", "amount": 1000, "period": "year", "quote": ""}],
                           "status": "open", "season": "2025", "checked": "2025-11-01", "ll": [-36.8, 174.7], "src": []}]}
    src = {"facilities": [{"id": "g-a", "kind": "golf", "name": "A", "home": "https://a.nz"}]}
    def handler(req):
        if "nominatim" in str(req.url):
            return httpx.Response(200, json=[])
        return httpx.Response(200, text="<p>$1,000</p>", headers={"content-type": "text/html"})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        out = leisure.build(src, {}, old, client, BadLLM(), "2026-11-05")
    a = out["facilities"][0]
    assert a["fees"][0]["amount"] == 1000 and a["checked"] == "2025-11-01"   # 실패하면 이전 값과 이전 확인일 유지


def test_collect_text_falls_back_to_home_links_when_listed_page_is_gone():
    leisure.time.sleep = lambda s: None

    def handler(req: httpx.Request) -> httpx.Response:
        url = str(req.url)
        if url.endswith("/old-membership"):
            return httpx.Response(404)
        if url.endswith("/fees-2027"):
            return httpx.Response(200, text="<p>Adult $900 per year</p>", headers={"content-type": "text/html"})
        if url.endswith("/members-area"):
            return httpx.Response(401)
        return httpx.Response(200, text='<a href="/members-area">Members area</a><a href="/fees-2027">Membership fees</a><p>Welcome</p>',
                              headers={"content-type": "text/html"})

    fac = {"id": "x", "name": "X", "home": "https://x.nz", "pages": ["https://x.nz/old-membership"]}
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        text, used = leisure.collect_text(client, fac)
    assert "$900" in text and "https://x.nz/fees-2027" in used and not any("members-area" in u for u in used)


def test_locate_tries_address_then_bounded_name():
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        q = dict(req.url.params)
        calls.append((q["q"], q.get("bounded")))
        if q.get("bounded") == "1":
            return httpx.Response(200, json=[{"lat": "-36.80", "lon": "174.75"}])
        return httpx.Response(200, json=[])

    leisure.time.sleep = lambda s: None
    s = {"name": "Foo Golf Club (공공)", "geo": "Foo Golf Club, Auckland", "geo2": "1 Foo Rd, Auckland"}
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert leisure.locate(client, s) == [-36.8, 174.75]
    assert [c[0] for c in calls] == ["Foo Golf Club, Auckland", "1 Foo Rd, Auckland", "Foo Golf Club"]


def test_normalize_primary_keeps_one_adult_and_demotes_the_rest():
    fees = [
        {"label": "6 Day Membership", "kind": "adult", "amount": 1634, "period": "year"},
        {"label": "Full Playing (7 day)", "kind": "adult", "amount": 1996, "period": "year"},
        {"label": "Weekday", "kind": "adult", "amount": 1419, "period": "year"},
        {"label": "Family joining", "kind": "joining", "amount": 3500, "period": "once"},
        {"label": "Joining fee", "kind": "joining", "amount": 2000, "period": "once"},
        {"label": "Visitor", "kind": "greenfee18", "amount": 70, "period": "round"},
    ]
    out = leisure.normalize_primary(fees, "golf")
    kinds = {f["label"]: f["kind"] for f in out}
    assert kinds["Full Playing (7 day)"] == "adult" and kinds["6 Day Membership"] == "other" and kinds["Weekday"] == "other"
    assert kinds["Joining fee"] == "joining" and kinds["Family joining"] == "other"
    again = {f["label"]: f["kind"] for f in leisure.normalize_primary(out, "golf")}
    assert again == kinds   # 여러 번 적용해도 같다
    cheap = leisure.normalize_primary([{"label": "Joining fee (social)", "kind": "joining", "amount": 125, "period": "once"},
                                       {"label": "Joining fee (full)", "kind": "joining", "amount": 500, "period": "once"}], "golf")
    assert [f["kind"] for f in cheap] == ["other", "joining"]   # 정규 회원 입회비(가장 비싼 개인용)가 대표
    assert kinds["Visitor"] == "greenfee18"
    # 골프가 아니면 greenfee 종류를 쓰지 않는다
    boat = leisure.normalize_primary([{"label": "Public trip", "kind": "greenfee18", "amount": 65, "period": "day"}], "fishing")
    assert boat[0]["kind"] == "other"
