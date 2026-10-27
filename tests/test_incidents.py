import json

import httpx

from crime_stats import summarize, type_ko
from incidents import update_incidents


def _brief_item(i, title, **kw):
    return {"id": i, "title_ko": title, "summary_ko": ["s"], "tags": [], "importance": 5,
            "sources": [{"name": "RNZ", "url": f"https://rnz.co.nz/{i}"}], **kw}


def _geo_client(calls):
    def handler(req):
        calls.append(req.url.params["q"])
        if "Nowhere" in req.url.params["q"]:
            return httpx.Response(200, json=[])
        return httpx.Response(200, json=[{"lat": "-36.85", "lon": "174.76"}])
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_update_incidents_accumulates_and_geocodes(cfg, tmp_path, monkeypatch):
    import korean_gp
    monkeypatch.setattr(korean_gp.time, "sleep", lambda s: None)
    (tmp_path / "incidents.json").write_text(json.dumps({"incidents": [
        {"id": "old", "date": "2026-06-01", "title_ko": "오래된 사건", "url": "", "severity": "2", "crime": "", "location": "X", "suburb": ""},
        {"id": "keep", "date": "2026-10-20", "title_ko": "지난 사건", "url": "", "severity": "1", "crime": "마약 압수",
         "location": "Queen Street", "suburb": "Auckland Central", "latlon": [-36.85, 174.76]}],
        "geocache": {"Queen Street": [-36.85, 174.76]}}), encoding="utf-8")
    sections = {"akl_safety": {"label": "치안", "items": [
        _brief_item("n1", "흉기 피습", incident={"severity": "1", "crime": "흉기 피습", "location": "Myers Park", "suburb": "Auckland Central"}),
        _brief_item("n2", "위치 모름", incident={"severity": "3", "crime": "절도", "location": "Nowhere Lane", "suburb": "Nowhere"}),
        _brief_item("c1", "지난 소식", carried_from="2026-10-25", incident={"severity": "2", "crime": "", "location": "A", "suburb": ""})]}}
    calls = []
    with _geo_client(calls) as c:
        n = update_incidents(sections, cfg, tmp_path, "2026-10-28", None, client=c)
    data = json.loads((tmp_path / "incidents.json").read_text())
    ids = {e["id"]: e for e in data["incidents"]}
    assert n == 3 and set(ids) == {"keep", "n1", "n2"}         # 90일 지난 것·지난 소식 제외
    assert ids["n1"]["latlon"] == [-36.85, 174.76] and "latlon" not in ids["n2"]
    assert calls == ["Myers Park, Auckland, New Zealand", "Nowhere Lane, Auckland, New Zealand", "Nowhere, Auckland, New Zealand"]


def test_backfill_when_file_missing(cfg, tmp_path, monkeypatch):
    import korean_gp
    monkeypatch.setattr(korean_gp.time, "sleep", lambda s: None)
    (tmp_path / "2026-10-26.json").write_text(json.dumps({"date": "2026-10-26", "sections": {"akl_safety": {"items": [
        _brief_item("p1", "마약 대량 압수", original_title="Police seize meth in Manukau raid", tags=["치안"]),
        _brief_item("p2", "도서관 개관", original_title="Library opens in Albany")]}}}), encoding="utf-8")

    class LLM:
        def __init__(self):
            self.users = []

        def json_call(self, *, user, **kw):
            self.users.append(user)
            return {"items": [{"id": "p1", "severity": "1", "crime": "마약 압수", "location": "Manukau", "suburb": "Manukau"}]}

    llm = LLM()
    with _geo_client([]) as c:
        update_incidents({}, cfg, tmp_path, "2026-10-28", llm, client=c)
    data = json.loads((tmp_path / "incidents.json").read_text())
    assert [(e["id"], e["date"], e["severity"]) for e in data["incidents"]] == [("p1", "2026-10-26", "1")]
    assert "p2" not in llm.users[0]          # 치안 키워드 없는 기사는 보내지 않음


def test_crime_stats_summarize():
    rows = []
    for y, m in [(2024, i) for i in range(11, 13)] + [(2025, i) for i in range(1, 13)] + [(2026, i) for i in range(1, 11)]:
        month = f"{['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]}-{y}"
        rows.append({"Territorial Authority": "Auckland.", "Area Unit": "Milford", "Year Month": month,
                     "ANZSOC Division": "Theft and Related Offences", "Victimisations": "3"})
        rows.append({"Territorial Authority": "Auckland.", "Area Unit": "Milford", "Year Month": month,
                     "ANZSOC Division": "Acts Intended to Cause Injury", "Victimisations": "1"})
        rows.append({"Territorial Authority": "Hamilton City.", "Area Unit": "Hamilton Central", "Year Month": month,
                     "ANZSOC Division": "Theft and Related Offences", "Victimisations": "9"})
    out = summarize(rows)
    assert out["period"] == "2025-11~2026-10" and set(out["areas"]) == {"Milford"}
    mf = out["areas"]["Milford"]
    assert mf["total"] == 48 and mf["prev_total"] == 48 and mf["by_type"] == {"절도": 36, "폭행·상해": 12}


def test_type_ko():
    assert type_ko("Illicit Drug Offences") == "마약" and type_ko("Robbery, Extortion and Related Offences") == "강도"
