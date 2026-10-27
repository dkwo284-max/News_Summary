import httpx

from korean_gp import _geo_queries, build, parse_gp_page

LI = ('<li class="flex"><div><div><span class="text-[15px] font-bold" style="">{name}</span>'
      '<span class="rounded-full px-2 font-bold" style="">등록 <!-- -->{status}</span></div>'
      '<p class="mt-0.5 text-[13px] font-medium" style="">{doctors}</p>'
      '<a href="https://www.google.com/maps/search/?api=1&amp;query=x" target="_blank">📍 <!-- -->{addr}</a>'
      '<div><a href="https://clinic.example.nz/" target="_blank">병원 웹사이트 ↗</a>'
      '<a href="https://www.healthpoint.co.nz/gp/x/" target="_blank">Healthpoint ↗</a></div></div>'
      '<a href="tel:09 123 4567" class="x">09 123 4567</a></li>')
PAGE = ('<section><h2 class="mb-2"><span>🩺</span>오클랜드<span class="text-[12px]">2<!-- -->곳</span></h2><ul>'
        + LI.format(name="Green Cross Clinic", status="가능", doctors="Dr Kim", addr="4 Auburn Street, Takapuna")
        + LI.format(name="Health New Lynn", status="마감", doctors="Dr Cho · Dr Lee",
                    addr="Level 1, Totara Health Services, 1 McCrae Way, New Lynn")
        + "</ul></section>")


def test_parse_gp_page():
    cs = parse_gp_page(PAGE)
    assert [c["name"] for c in cs] == ["Green Cross Clinic", "Health New Lynn"]
    c = cs[0]
    assert (c["region"], c["status"], c["doctors"], c["address"], c["phone"]) == \
        ("오클랜드", "등록 가능", "Dr Kim", "4 Auburn Street, Takapuna", "09 123 4567")
    assert c["website"] == "https://clinic.example.nz/" and c["healthpoint"].startswith("https://www.healthpoint.co.nz/")
    assert c["maps_url"] == "https://www.google.com/maps/search/?api=1&query=x"


def test_geo_queries_strip_level_and_building():
    c = parse_gp_page(PAGE)[1]
    assert _geo_queries(c)[0] == "1 McCrae Way, New Lynn, Auckland, New Zealand"


def test_build_uses_geocache(cfg, monkeypatch):
    calls = []

    def handler(req):
        if "hanin.nz" in str(req.url):
            return httpx.Response(200, text=PAGE)
        calls.append(req.url.params["q"])
        return httpx.Response(200, json=[{"lat": "-36.8", "lon": "174.7"}])

    cfg = {**cfg, "areas": {"suburbs": {"Milford": "north_shore"}}}
    old = {"geocache": {"Green Cross Clinic|4 Auburn Street, Takapuna": [-36.79, 174.77]}, "suburbs": {"Milford": [-36.77, 174.76]}}
    import korean_gp
    monkeypatch.setattr(korean_gp.time, "sleep", lambda s: None)
    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        out = build(cfg, old, c)
    assert calls == ["1 McCrae Way, New Lynn, Auckland, New Zealand"]   # 캐시에 없는 병원만 조회
    assert out["clinics"][0]["latlon"] == [-36.79, 174.77] and out["clinics"][1]["latlon"] == [-36.8, 174.7]
