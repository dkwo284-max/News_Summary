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
    assert ids == ["im1", "e1", "e2"]   # 뉴질랜드는 중요도와 상관없이 전부(레이더 먼저), 연예·지난 소식 제외


def test_pick_targets_kr_limited_by_importance(cfg):
    secs = {"kr_society": {"label": "사회", "items": [_item(f"k{i}", 10 - i) for i in range(12)]},
            "akl_life": {"label": "생활", "items": [_item("a1", 3)]}}
    ids = [it["id"] for _, it in pick_targets(secs, cfg)]
    assert ids[0] == "a1" and ids[1:] == [f"k{i}" for i in range(5)]   # 한국은 중요도 6 이상만 (10..6 → 5건)


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


def test_attach_qa_batches(cfg):
    secs = {"akl_life": {"label": "생활", "items": [_item(f"a{i}", 3) for i in range(30)]}}
    calls = []

    class BatchLLM:
        def json_call(self, *, user, **kw):
            ids = [line.split()[1] for line in user.splitlines() if line.startswith("[id]")]
            calls.append(len(ids))
            return {"items": [{"id": i, "qa": [{"q": "질문?", "a": "답."}]} for i in ids]}

    assert attach_qa(secs, {}, cfg, BatchLLM()) == 30 and calls == [22, 8]
