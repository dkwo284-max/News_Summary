"""🎧 5분 브리핑 대본: 오클랜드 먼저·뉴질랜드 다음, 이민 레이더·지난 소식 제외, AI 실패해도 요약 대본."""
from common import load_config
from podcast import build_podcast, pick_items


def _item(i, imp=5, level="none", carried=False):
    it = {"id": i, "title_ko": f"기사 {i}", "summary_ko": [f"{i} 요약 첫 문장.", f"{i} 둘째 문장.", "셋째."], "importance": imp,
          "why_it_matters": "영향", "impact": {"level": level, "reason": f"{i} 이유"}}
    if carried:
        it["carried_from"] = "2026-11-20"
    return it


SECS = {
    "akl_life": {"items": [_item("a1", 8), _item("a2", 5, "high"), _item("a3", 9, carried=True)]},
    "akl_safety": {"items": [_item("a4", 6), _item("a5", 3)]},
    "nz_economy": {"items": [_item("n1", 9), _item("n2", 4, "medium")]},
    "nz_politics": {"items": [_item("n3", 7)]},
    "nz_immigration": {"items": [_item("i1", 10, "high")]},
}


def test_pick_order_and_exclusions():
    cfg = load_config()
    ids = [p["id"] for p in pick_items(SECS, cfg)]
    assert ids[:4] == ["a2", "a1", "a4", "a5"]          # 생활 영향 high 가 앞으로, 지난 소식(a3) 제외
    assert set(ids[4:]) == {"n1", "n2", "n3"} and "i1" not in ids


def test_template_when_no_llm():
    pc = build_podcast(SECS, load_config(), None, "2026-11-26")
    assert pc["source"] == "template" and pc["intro"].startswith("11월 26일 목요일")
    assert pc["segments"][0]["text"].startswith("먼저 오클랜드 소식입니다") and pc["segments"][4]["text"].startswith("이어서 뉴질랜드")


class FakeLLM:
    def __init__(self, segs):
        self.segs = segs

    def json_call(self, **kw):
        assert "a2" in kw["user"] and "i1" not in kw["user"]
        return {"intro": "11월 26일 목요일 소식입니다.", "segments": self.segs, "outro": "여기까지입니다."}


def test_ai_script_used_and_missing_filled():
    segs = [{"id": i, "title": f"제목 {i}", "text": f"{i} 앵커 대본입니다."} for i in ["a2", "a1", "a4", "n1", "n2"]]
    pc = build_podcast(SECS, load_config(), FakeLLM(segs), "2026-11-26")
    assert pc["source"] == "ai" and [s["id"] for s in pc["segments"]] == ["a2", "a1", "a4", "a5", "n1", "n2", "n3"]
    assert pc["segments"][0]["text"] == "a2 앵커 대본입니다." and pc["segments"][3]["text"].startswith("기사 a5")   # 빠진 건 요약으로


def test_ai_failure_falls_back():
    class Bad:
        def json_call(self, **kw):
            raise RuntimeError("quota")
    pc = build_podcast(SECS, load_config(), Bad(), "2026-11-26")
    assert pc["source"] == "template" and len(pc["segments"]) == 7
