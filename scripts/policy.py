"""이민 정책 추적: 매일 브리핑 기사 중 '정당·정부 + 이민 정책' 기사를 규칙(키워드)으로 모아 policy-news.json 에 누적한다.

AI 를 쓰지 않는다 (요청 0회). 누적 기록이라 브리핑 보관 기간(30일)이 지나도 남는다.
정당 입장·정부 반영 상태 자체는 사람이 확인해 web/public/data/policy.json 에 적는다 (이 파일은 읽기만 한다).
"""
from __future__ import annotations

import json
import logging
import re
from datetime import date, timedelta
from pathlib import Path

log = logging.getLogger("brief")

KEEP_DAYS = 150
MAX_ITEMS = 200
SECTIONS_SKIP = ("kr_",)  # 한국 섹션은 제외

# 정당·정부 이름 (영문은 대소문자 구분: 'ACT' 와 일반 단어 'act' 구분, 'Labour market' 같은 일반 용례 제외)
PARTIES: dict[str, re.Pattern] = {
    "national": re.compile(r"National Party|Nat(?:ional)?s? (?:MP|leader|minister)|Luxon|Nicola Willis|국민당|럭슨"),
    "labour": re.compile(r"Labour(?: Party| leader| MP| government| says| would| will| pledge| policy| announces)|Hipkins|Twyford|노동당|힙킨스"),
    "nzfirst": re.compile(r"NZ First|New Zealand First|Winston Peters|Casey Costello|Shane Jones|뉴질랜드 퍼스트|피터스"),
    "act": re.compile(r"\bACT (?:Party|leader|MP|says|would|will|wants|proposes)|David Seymour|Seymour|Parmjeet Parmar|ACT당|시모어"),
    "greens": re.compile(r"Green Party|\bGreens\b|Menéndez March|Menendez March|녹색당"),
    "gov": re.compile(r"Immigration New Zealand|\bINZ\b|Erica Stanford|immigration minister|Immigration Minister|이민성|이민부|이민 장관"),
}
RELEVANT = re.compile(r"immigra|visa|resident|residence|migrant|citizenship|asylum|refugee|overstay|deport|AEWV|이민|이주민|비자|영주권|시민권|난민|망명|추방|불법체류", re.I)
CHANGE = re.compile(r"announc|vow|would |plans? to|wants? to|unveil|pledge|promis|scrap|abolish|introduc|propos|manifesto|policy|bill\b|law\b|reform|cap\b|change|발표|공약|폐지|도입|개정|법안|정책|제안", re.I)
ISSUES: dict[str, re.Pattern] = {
    "pr_path": re.compile(r"permanent resident|residence|resident visa|citizenship|\bPR\b|skilled migrant|영주권|시민권", re.I),
    "work_visa": re.compile(r"AEWV|work visa|accredited employer|employer|취업비자|고용주", re.I),
    "welfare": re.compile(r"welfare|benefit|jobseeker|accommodation supplement|복지|수당", re.I),
    "cap": re.compile(r"net migration|population|cap\b|numbers|상한|순이민|인구", re.I),
    "enforcement": re.compile(r"deport|overstay|asylum|enforcement|exploit|추방|불법체류|망명", re.I),
    "students": re.compile(r"student|graduate|post-study|유학생|학생비자|졸업", re.I),
    "family": re.compile(r"parent|partner|family|refugee|Pacific|부모|난민|가족|태평양", re.I),
}


def _text(item: dict) -> str:
    return " ".join(filter(None, [item.get("original_title"), item.get("title_ko"), " ".join(item.get("summary_ko") or [])]))


def scan_brief(brief: dict) -> list[dict]:
    """브리핑 하나에서 정당·정부 이민 정책 기사 추출."""
    out: list[dict] = []
    for key, sec in (brief.get("sections") or {}).items():
        if key.startswith(SECTIONS_SKIP):
            continue
        for it in sec.get("items") or []:
            text = _text(it)
            title = " ".join(filter(None, [it.get("original_title"), it.get("title_ko")]))
            # 이민 레이더 기사이거나, 다른 섹션이면 제목에 이민 관련어가 있어야 한다 (본문에만 스치는 기사 제외)
            if not (RELEVANT.search(title) or (key == "nz_immigration" and RELEVANT.search(text))):
                continue
            parties = [p for p, rx in PARTIES.items() if rx.search(text)]
            change = bool(CHANGE.search(text))
            if parties == ["gov"] and not change:  # 정부·INZ 기사는 정책 변화 표현이 있을 때만
                continue
            if not parties:
                continue
            issues = [k for k, rx in ISSUES.items() if rx.search(text)]
            if not (issues or RELEVANT.search(title)):  # 이민 레이더 기사라도 정책 쟁점도 제목 단서도 없으면 제외
                continue
            src = (it.get("sources") or [{}])[0]
            url = src.get("url")
            if not url:
                continue
            out.append({
                "date": brief.get("date"),
                "title": it.get("title_ko") or it.get("original_title") or "",
                "url": url,
                "source": src.get("name", ""),
                "parties": parties,
                "issues": issues,
                "change": change,
            })
    return out


def update_policy_news(data_dir: Path, today: date, brief: dict | None = None) -> int:
    """policy-news.json 갱신. 오늘 브리핑(brief)이 있으면 그것을, 없으면 보관된 브리핑 파일을 읽는다. 반환: 총 기사 수"""
    path = data_dir / "policy-news.json"
    old: list[dict] = []
    if path.exists():
        try:
            old = json.loads(path.read_text(encoding="utf-8")).get("items", [])
        except Exception:  # noqa: BLE001
            old = []
    by_url = {x["url"]: x for x in old if x.get("url")}
    briefs: list[dict] = []
    if brief is not None:
        briefs.append(brief)
    else:  # 처음 만들 때: 보관 중인 브리핑 전부로 채운다
        for f in sorted(data_dir.glob("20??-??-??.json")):
            try:
                briefs.append(json.loads(f.read_text(encoding="utf-8")))
            except Exception:  # noqa: BLE001
                continue
    for b in briefs:
        for it in scan_brief(b):
            prev = by_url.get(it["url"])
            if prev:  # 같은 기사가 다시 나오면 날짜는 처음 본 날을 유지
                it["date"] = min(prev.get("date") or it["date"], it["date"])
            by_url[it["url"]] = it
    cutoff = (today - timedelta(days=KEEP_DAYS)).isoformat()
    items = sorted((x for x in by_url.values() if (x.get("date") or "") >= cutoff), key=lambda x: (x["date"], x["url"]), reverse=True)[:MAX_ITEMS]
    body = json.dumps({"updated": today.isoformat(), "items": items}, ensure_ascii=False, indent=1)
    if not path.exists() or path.read_text(encoding="utf-8") != body:
        path.write_text(body, encoding="utf-8")
    log.info("policy news: %d items", len(items))
    return len(items)
