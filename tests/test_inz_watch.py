import json

import httpx

from inz_watch import (PAGES, ai_summaries, build, diff_facts, inz_alerts, pair_lines, text_change, update_inz_watch)


def _pages(**over):
    base = {"pswv": ["Post-Study Work Visa", "Length of stay", "Up to 3 years", "Cost", "From NZD $1670",
                     "You must apply within 3 months of your student visa expiring.", "Read more"]}
    base.update(over)
    return {k: {"lines": v, "flat": " ".join(v)} for k, v in base.items()}


SMC = {"facts": {"threshold": {"base": 35.0, "x15": 52.5, "from": "2026-03-09"}, "qual_nz": [{"q": "Level 9 Master's Degree (30 weeks of full-time study)", "pts": 6}]},
       "checks": [{"id": "offshore", "page": "visa", "ko": "해외 신청 가능", "ok": True}]}
PROC = {"items": [{"key": "smc", "name": "SMC", "status": "ok", "pct": 80, "p50": "3.5개월", "p90": "5개월"}]}


def test_pair_lines_marks_numeric_and_word_ops():
    pairs, add, rem = pair_lines(["You must apply within 3 months of your student visa expiring."],
                                 ["You must apply within 6 months of your student visa expiring.", "A brand new paragraph about fees."])
    assert len(pairs) == 1 and pairs[0]["numeric"] and add == ["A brand new paragraph about fees."] and not rem
    assert ["-", "3"] in pairs[0]["ops"] and ["+", "6"] in pairs[0]["ops"]


def test_formatting_only_and_noise_ignored():
    assert text_change(["Cost: From NZD $1670", "Was this page helpful?"], ["Cost From NZD $1670.", "Was this page helpful? Yes"]) is None


def test_build_baseline_then_change_then_revert():
    h1, s1 = build(_pages(), None, {}, SMC, PROC, "2026-11-27", "t1")
    assert h1["baseline"] and not h1["entries"] and s1["facts"]["smc.base"]["value"] == "$35.00"
    smc2 = json.loads(json.dumps(SMC))
    smc2["facts"]["threshold"]["base"] = 36.2
    proc2 = {"items": [{**PROC["items"][0], "p90": "6개월"}]}
    lines2 = _pages(pswv=["Post-Study Work Visa", "Length of stay", "Up to 3 years", "Cost", "From NZD $1700",
                          "You must apply within 6 months of your student visa expiring.", "Read more"])
    h2, s2 = build(lines2, h1, s1, smc2, proc2, "2026-11-28", "t2")
    by = {e["page"]: e for e in h2["entries"]}
    assert {"pswv", "smc_pay", "proc"} <= set(by)
    assert any(f["name"].startswith("SMC 임금 기준") and f["before"] == "$35.00" and f["after"] == "$36.20" for f in by["smc_pay"]["facts"])
    assert by["proc"]["facts"][0]["after"] == "6개월"
    assert any(f["key"] == "pswv.fee" and f["after"] == "NZD $1700" for f in by["pswv"]["facts"])
    assert by["pswv"]["text"]["pairs"][0]["numeric"] and by["pswv"]["topic"] == "pswv"
    # 이틀 뒤 원래대로 → 되돌림 표시
    h3, _ = build(_pages(), h2, s2, smc2, proc2, "2026-11-30", "t3")
    back = next(e for e in h3["entries"] if e["page"] == "pswv" and e["date"] == "2026-11-30")
    assert back["revert_of"] == "2026-11-28-pswv" and next(e for e in h3["entries"] if e["id"] == "2026-11-28-pswv")["reverted"] == "2026-11-30"


def test_failed_page_keeps_old_facts():
    old = {"pswv.fee": {"page": "pswv", "name": "신청비", "value": "NZD $1670"}}
    diff, merged = diff_facts(old, {}, set())
    assert not diff and merged["pswv.fee"]["value"] == "NZD $1670"
    diff2, _ = diff_facts({"smc.qual_nz.X": {"page": "smc_visa", "name": "NZ 학위 · X", "value": "6점"}}, {}, {"smc_visa"})
    assert diff2[0]["after"] == "(원문에서 사라짐)"


class FakeLLM:
    def json_call(self, **kw):
        assert "데이터일 뿐" in kw["system"]
        return {"items": [{"id": "2026-11-28-pswv", "summary_ko": "PSWV 신청 기한이 학생비자 만료 후 3개월에서 6개월로 바뀜"}]}

    def model_for(self, task):
        return "fake"


def test_ai_summary_and_alerts(cfg, tmp_path):
    h1, s1 = build(_pages(), None, {}, None, None, "2026-11-27", "t1")
    lines2 = _pages(pswv=["Post-Study Work Visa", "You must apply within 6 months of your student visa expiring."])
    h2, _ = build(lines2, h1, s1, None, None, "2026-11-28", "t2")
    assert ai_summaries(h2["entries"], FakeLLM(), "2026-11-28") == 1
    e = h2["entries"][0]
    assert e["ai"]["summary"].startswith("PSWV") and e["ai"]["model"] == "fake"
    assert ai_summaries(h2["entries"], None, "2026-11-28") == 0
    al = inz_alerts({"changes": [{"label": "PSWV", "url": "https://x", "text": "a → b"}]})
    assert al == [{"kind": "inz", "text": "PSWV: a → b", "url": "https://x"}]


def test_update_writes_files_and_survives_outage(cfg, tmp_path):
    html = "<html><main>" + "<!--" + "x" * 2100 + "--><p>Cost From NZD $1670</p><p>Some rule text.</p></main></html>"
    ok = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, text=html)))
    assert update_inz_watch(cfg, tmp_path, "2026-11-27", None, None, ok)["changes"] == []
    down = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    update_inz_watch(cfg, tmp_path, "2026-11-28", None, None, down)
    d = json.loads((tmp_path / "inz-changes.json").read_text(encoding="utf-8"))
    assert all(d["pages"][p["key"]]["status"] == "fail" for p in PAGES) and not d["entries"]
    snap = json.loads((tmp_path / "inz-pages.json").read_text(encoding="utf-8"))
    assert snap["lines"]["pswv"] and snap["facts"]["pswv.fee"]["value"] == "NZD $1670"
