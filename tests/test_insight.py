import json

from insight import attach_insights, build_timeline, candidates, load_history, pick_targets


def _item(i, title, orig="", **kw):
    return {"id": i, "title_ko": title, "original_title": orig, "summary_ko": ["요약"], "tags": [], "importance": 5,
            "sources": [{"name": "RNZ", "url": f"https://rnz.co.nz/{i}"}], **kw}


def _write(d, day, sections):
    (d / f"{day}.json").write_text(json.dumps({"date": day, "sections": sections}, ensure_ascii=False), encoding="utf-8")


def test_history_and_candidates(tmp_path):
    _write(tmp_path, "2026-10-20", {"nz_immigration": {"items": [
        _item("p1", "행동당, 영주권 폐지 공약 발표", "ACT pledges to scrap residence visa pathway")]}})
    _write(tmp_path, "2026-10-25", {"nz_immigration": {"items": [
        _item("p1", "행동당, 영주권 폐지 공약 발표", "ACT pledges to scrap residence visa pathway"),   # 같은 기사 재등장 → 처음 날짜 유지
        _item("p2", "행동당 영주권 공약 비판 확산", "Critics slam ACT residence pledge")]},
        "kr_society": {"items": [_item("k1", "영주권 제도 개편 논의", "")]}})
    hist = load_history(tmp_path, "2026-10-28")
    assert {h["id"]: h["date"] for h in hist} == {"p1": "2026-10-20", "p2": "2026-10-25", "k1": "2026-10-25"}
    today = {**_item("t1", "행동당, 영주권 폐지 공약 철회", "ACT drops pledge to scrap residence pathway"), "_section": "nz_immigration"}
    got = [c["id"] for c in candidates(today, hist)]
    assert "p1" in got and "k1" not in got   # 한국 기사는 뉴질랜드 기사의 후보가 아님


def test_build_timeline_merges_previous_chain():
    confirmed = [{"id": "p2", "date": "2026-10-25", "title_ko": "비판 확산", "url": "u2",
                  "timeline": [{"id": "p1", "date": "2026-10-20", "title_ko": "공약 발표", "url": "u1"}]}]
    assert [t["id"] for t in build_timeline(confirmed)] == ["p1", "p2"]


class InsightLLM:
    def __init__(self):
        self.users = []

    def json_call(self, *, user, **kw):
        self.users.append(user)
        ids = [line.split()[1] for line in user.splitlines() if line.startswith("[id]")]
        out = []
        for i in ids:
            out.append({"id": i, "impact": "high" if i == "t1" else "none", "reason": "영주권 경로에 직접 영향",
                        "actions": ["INZ 안내 확인", "", "두번째", "세번째는 버림"], "watch": "11월 연정 협상",
                        "same_issue": ["p1", "zzz"] if i in ("t1", "k2") else [], "changed": "공약을 철회함"})
        return {"items": out}


def test_attach_insights(cfg, tmp_path):
    _write(tmp_path, "2026-10-20", {"nz_immigration": {"items": [
        _item("p1", "행동당, 영주권 폐지 공약 발표", "ACT pledges to scrap residence visa pathway")]}})
    sections = {
        "nz_immigration": {"label": "이민 레이더", "items": [
            _item("t1", "행동당, 영주권 폐지 공약 철회", "ACT drops pledge to scrap residence pathway")]},
        "akl_life": {"label": "생활", "items": [_item("a1", "범고래 무리 출현", "Orca pod spotted")]},
        "kr_society": {"label": "사회", "items": [_item("k9", "구룡마을 화재", "")]},           # 지난 보도 없음 → 제외
        "kr_entertainment": {"label": "연예", "items": [_item("e1", "영주권 폐지 공약 철회 드라마", "")]},  # 제외 섹션
    }
    llm = InsightLLM()
    attach_insights(sections, {}, cfg, llm, tmp_path, "2026-10-28")
    t1 = sections["nz_immigration"]["items"][0]
    assert t1["impact"] == {"level": "high", "reason": "영주권 경로에 직접 영향", "actions": ["INZ 안내 확인", "두번째"], "watch": "11월 연정 협상"}
    assert [t["id"] for t in t1["timeline"]] == ["p1"] and t1["changed"] == "공약을 철회함"   # 후보에 없는 id(zzz)는 무시
    a1 = sections["akl_life"]["items"][0]
    assert a1["impact"]["level"] == "none" and a1["impact"]["actions"] == [] and "timeline" not in a1
    assert "impact" not in sections["kr_society"]["items"][0]
    assert "[id] k9" not in llm.users[0] and "[id] e1" not in llm.users[0]


def test_attach_insights_soft_fail(cfg, tmp_path):
    class Boom:
        def json_call(self, **kw):
            raise RuntimeError("429")
    secs = {"akl_life": {"label": "생활", "items": [_item("a1", "x", "y")]}}
    assert attach_insights(secs, {}, cfg, Boom(), tmp_path, "2026-10-28") == 0
    assert attach_insights(secs, {}, cfg, None, tmp_path, "2026-10-28") == 0
