"""요약 품질 점검 (AI 없음): AI 가 '성공'으로 응답했어도 내용이 기준에 못 미치는 기사를 찾아낸다.

기준(기사 한 건): ① 제목·요약이 한국어인가(한글 비율) ② 요약이 2줄 이상인가 ③ 영어 기사의 제목이 번역됐는가(원문 제목과 다름)
④ 'AI 요약 없이' 안내 문구가 남아 있지 않은가. 한 지역(한국/뉴질랜드)에서 기준 미달이 일정 비율을 넘으면 그 지역만 한 번 다시 요약한다.
"""
from __future__ import annotations

import re

MIN_HANGUL = 0.45     # 글자(한글+영문) 중 한글 비율
BAD_SHARE = 0.25      # 한 지역에서 이 비율 넘게 미달이면 다시 요약
NOTE = "AI 요약 없이"


def hangul_ratio(text: str) -> float:
    ko, en = len(re.findall(r"[가-힣]", text)), len(re.findall(r"[A-Za-z]", text))
    return ko / (ko + en) if ko + en else 1.0


def item_problems(it: dict) -> list[str]:
    out = []
    body = " ".join([it.get("title_ko", ""), *it.get("summary_ko", [])])
    if hangul_ratio(body) < MIN_HANGUL:
        out.append("한국어가 아님")
    if len([s for s in it.get("summary_ko", []) if s.strip()]) < 2:
        out.append("요약이 짧음")
    orig = (it.get("original_title") or "").strip()
    if orig and re.search(r"[A-Za-z]{4,}", orig) and not re.search(r"[가-힣]", orig) and it.get("title_ko", "").strip() == orig:
        out.append("제목 미번역")
    if NOTE in body or NOTE in (it.get("why_it_matters") or ""):
        out.append("AI 요약 없음")
    return out


def check(sections: dict, cfg: dict) -> dict:
    """{items, bad, by_region: {kr: {n, bad}}, redo: [지역…], bad_ids: […]} — 이어 온 기사(carried_from)는 보지 않는다."""
    by: dict[str, dict] = {}
    bad_ids, seen = [], set()
    for k, sec in sections.items():
        region = cfg["sections"].get(k, {}).get("region", "kr" if k.startswith("kr_") else "nz")
        r = by.setdefault(region, {"n": 0, "bad": 0})
        for it in sec.get("items", []):
            if it.get("carried_from") or it["id"] in seen:
                continue
            seen.add(it["id"])
            r["n"] += 1
            if item_problems(it):
                r["bad"] += 1
                bad_ids.append(it["id"])
    redo = [g for g, r in by.items() if r["n"] >= 4 and r["bad"] / r["n"] > BAD_SHARE]
    return {"items": sum(r["n"] for r in by.values()), "bad": len(bad_ids), "by_region": by, "redo": redo, "bad_ids": bad_ids[:30]}
