import json

from qa import attach_qa, pick_targets


def _item(i, imp, **kw):
    return {"id": i, "title_ko": f"기사 {i}", "summary_ko": ["요약"], "tags": [], "importance": imp,
            "sources": [{"name": "RNZ", "url": "https://rnz.co.nz/x"}], **kw}


SECTIONS = {
    "nz_immigration": {"label": "이민 레이더", "briefing": "", "items": [_item("im1", 5)]},
    "nz_economy": {"label": "경제", "briefing": "", "items": [_item("e1", 9), _item("e2", 4)]},
    "kr_entertainment": {"label": "연예", "briefing": "", "items": [_item("k1", 10)]},
    "akl_health": {"label": "의료", "briefing": "", "items": [_item("h1", 7, carried_from="2026-10-25")]},
}


def test_pick_targets_order_and_filters(cfg):
    ids = [it["id"] for _, it in pick_targets(SECTIONS, cfg)]
    assert ids == ["im1", "e1"]   # 레이더 먼저, 중요도 6 미만·연예·지난 소식 제외


class QALLM:
    def __init__(self):
        self.users = []

    def json_call(self, *, task, system, user, schema, max_tokens=16000):
        self.users.append(user)
        return {"items": [{"id": "im1", "qa": [{"q": "언제부터?", "a": "기사에는 나오지 않아요."}] * 4},
                          {"id": "e1", "qa": [{"q": " ", "a": "빈 질문은 버림"}]}]}


def test_attach_qa(cfg):
    secs = json.loads(json.dumps(SECTIONS))
    llm = QALLM()
    assert attach_qa(secs, {}, cfg, llm) == 1
    assert secs["nz_immigration"]["items"][0]["qa"] == [{"q": "언제부터?", "a": "기사에는 나오지 않아요."}] * 3  # per_item 3
    assert "qa" not in secs["nz_economy"]["items"][0]
    assert "[id] im1" in llm.users[0] and "[id] k1" not in llm.users[0]


def test_attach_qa_failure_is_soft(cfg):
    class Boom:
        def json_call(self, **kw):
            raise RuntimeError("429")
    secs = json.loads(json.dumps(SECTIONS))
    assert attach_qa(secs, {}, cfg, Boom()) == 0 and attach_qa(secs, {}, cfg, None) == 0
