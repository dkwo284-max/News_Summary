import json

import httpx

from smc import PAGES, build, extract, main_html, smc_alerts, tables, text_lines, update_smc

PAD = "<!-- " + "x" * 2100 + " -->"
VISA = f"""<html><body><nav>menu</nav><main id="main">{PAD}
<p>You can submit an expression of interest (EOI) if you have a job or job offer from an
<glossary-tooltip button-text="accredited employer," :id="9"></glossary-tooltip> and meet the requirements.</p>
<p>Cost From NZD $6450</p><li>be aged 55 or younger when you apply</li>
<li>and (for at least 30 hours a week)</li>
<li>permanent or fixed-term for at least 12 months, or a contract or continuous contracts for at least 6 months, and</li>
<p>You can claim 6 points for a New Zealand master’s degree if you have completed at least 30 weeks of full-time study in New Zealand and have a bachelor’s degree.</p>
<p>Your job must pay 3 times the SMC wage threshold (currently NZD $105.00 an hour) or more</p>
<table><caption>Table 1: Skilled resident points you can claim for New Zealand qualifications</caption>
<tr><th>New Zealand qualification</th><th>Points you can claim</th><th>Bachelor's degree required</th></tr>
<tr><td>Level 9 Master's Degree (30 weeks of full-time study)</td><td>6</td><td>Yes</td></tr>
<tr><td>Level 7 Bachelor's Degree</td><td>5</td><td>Not applicable</td></tr></table>
<table><caption>Table 5: Additional skilled resident points you can claim for skilled work experience in New Zealand</caption>
<tr><td>2 years</td><td>3</td></tr><tr><td>1 year</td><td>1</td></tr></table>
<p>You must come to New Zealand within 12 months of the date your visa is issued, if you applied for your visa outside of New Zealand.</p>
<p>{{{{ item.innerText }}}}</p></main><footer>cookies</footer></body></html>"""
PAY = f"""<html><main>{PAD}
<table><caption>Table 1: Points-based pathway pay rates without skilled work experience in New Zealand</caption>
<tr><th></th><th>Claiming 6 points for a qualification</th></tr>
<tr><td>SMC wage threshold (ANZSCO skill levels 1 to 3)</td><td>$35.00</td><td>$105.00</td></tr>
<tr><td>1.5 times the SMC wage threshold (ANZSCO skill levels 4, 5 or unlisted jobs)</td><td>$52.50</td><td>Not applicable</td></tr></table>
<table><caption>Table 2: Points-based pathway pay rates with skilled work experience in New Zealand</caption>
<tr><td>From 9 March 2026</td><td>$35.00</td><td>$52.50</td><td>$70.00</td></tr>
<tr><td>18 August 2025 to 8 March 2026</td><td>$33.56</td><td>$50.34</td><td>$67.12</td></tr></table>
</main></html>"""


def _page(raw):
    h = main_html(raw)
    lines = text_lines(h)
    return {"html": h, "lines": lines, "flat": " ".join(lines), "tables": tables(h)}


def test_glossary_words_restored_and_template_lines_dropped():
    lines = text_lines(main_html(VISA))
    assert any("job offer from an accredited employer, and meet" in ln for ln in lines)
    assert not any("{{" in ln for ln in lines) and not any("menu" in ln or "cookies" in ln for ln in lines)


def test_extract_numbers_from_official_tables():
    f = extract({"visa": _page(VISA), "pay": _page(PAY)})
    assert f["fee_from_nzd"] == 6450 and f["age_max"] == 55
    assert f["threshold"]["base"] == 35.0 and f["threshold"]["x15"] == 52.5 and f["threshold"]["from"] == "2026-03-09"
    assert f["threshold"]["cross_check"] is True and f["threshold"]["annual_40h"] == 72800
    assert f["qual_nz"][0] == {"q": "Level 9 Master's Degree (30 weeks of full-time study)", "pts": 6, "bachelor": "Yes"}
    assert [r["pts"] for r in f["work_pts"]] == [3, 1]
    assert f["threshold_history"][1]["from"] == "2025-08-18"


def test_checks_changes_and_alerts():
    pages = {"visa": _page(VISA), "pay": _page(PAY)}
    first, lines = build(pages, None, {}, "2026-11-27", "t1")
    ok = {c["id"]: c["ok"] for c in first["checks"]}
    assert ok["job_offer"] and ok["offshore"] and ok["duration"] and ok["nz_masters"]
    assert ok["ita"] is False   # 문장이 없는 요건은 '원문 확인 필요'
    assert first["baseline"] and not first["changes"]
    assert first["pages"]["path"]["status"] == "fail"
    changed = VISA.replace("within 12 months of the date", "within 6 months of the date")
    second, _ = build({"visa": _page(changed), "pay": _page(PAY)}, first, lines, "2026-11-28", "t2")
    ch = second["changed_today"][0]
    assert ch["page"] == "visa" and any("within 6 months" in a for a in ch["added"]) and any("within 12 months" in r for r in ch["removed"])
    assert not next(c for c in second["checks"] if c["id"] == "offshore")["ok"]
    alerts = smc_alerts({"changed": [{"label": "SMC 거주비자", "url": "u", "n": 2}], "missing": ["해외 신청"]})
    assert alerts[0]["kind"] == "smc" and len(alerts) == 2


def test_update_keeps_previous_on_failure(cfg, tmp_path):
    def ok(req):
        return httpx.Response(200, text=PAY if "pay-rates" in str(req.url) else VISA)

    update_smc(cfg, tmp_path, "2026-11-27", client=httpx.Client(transport=httpx.MockTransport(ok)))
    down = httpx.Client(transport=httpx.MockTransport(lambda req: httpx.Response(503)))
    sm = update_smc(cfg, tmp_path, "2026-11-28", client=down)
    d = json.loads((tmp_path / "smc.json").read_text(encoding="utf-8"))
    assert d["facts"]["threshold"]["base"] == 35.0 and d["ok"] is False and sm["threshold"] == 35.0
    assert all(d["pages"][p["key"]]["status"] == "fail" for p in PAGES)
    assert next(c for c in d["checks"] if c["id"] == "job_offer").get("stale")
