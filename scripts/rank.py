"""선별: 섹션별 중요도(1~10)를 매기고 상위 N건을 고른다.

AI(기본 Gemini 무료 등급)가 있으면 지역(kr/nz)별로 묶어 배치 채점 — 보통 지역당 요청 1회.
없거나(--no-llm) 실패하면 키워드·출처수 기반 휴리스틱.
"""
from __future__ import annotations

import re
from dataclasses import replace
from collections import defaultdict
from datetime import datetime, timezone

from common import Article, log
from dedupe import dedupe

MIN_SCORE = 3  # 이 점수 미만(스포츠 결과·가십 등)은 자리가 남아도 싣지 않음

RANK_SCHEMA = {
    "type": "object",
    "properties": {
        "scores": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "score": {"type": "integer"},
                    "immigration": {"type": "boolean"},
                    "auckland": {"type": "boolean"},
                    "same_as": {"type": "string"},
                },
                "required": ["id", "score", "immigration", "auckland", "same_as"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["scores"],
    "additionalProperties": False,
}

KR_CRITERIA = """한국 독자 기준으로 중요도를 매기세요.
- 높음: 전국적 영향, 다수 언론이 보도한 사건, 정책·제도 변화, 경제 지표·시장 급변, 대형 사고·재난
- 낮음: 단순 홍보·행사 안내, 지역 단신, 같은 내용의 반복 기사, 칼럼·사설, 낚시성 제목"""


def _nz_criteria(cfg: dict) -> str:
    w = cfg["weights"]
    high = "\n".join(f"  - {t['topic']}: {', '.join(t['keywords'][:8])}" for t in w["high"])
    low = "\n".join(f"  - {t['topic']}: {', '.join(t['keywords'][:6])}" for t in w["low"])
    return f"""뉴질랜드 이민을 준비하는 한국인 관점에서 중요도를 매기세요.
- 가중치 높음 (7~10점 후보):
{high}
- 가중치 낮음 (1~3점):
{low}
- 그 외 일반 뉴스는 사회적 파급력에 따라 4~6점.
- 개인 사연·투병기·미담처럼 사회적 파급이 없는 개인 이야기, 뉴질랜드와 직접 관련 없는 해외 뉴스는 1~3점."""


AUCKLAND_RULE = """- auckland: 오클랜드 지역 소식이면 true — 오클랜드 시의회·교통(AT)·지역 개발, 오클랜드 안에서 일어난 사건사고,
  오클랜드 병원·학교, 오클랜드 날씨·재해 등. 정부 정책·전국 경제·전국 통계처럼 나라 전체에 해당하는 소식은
  오클랜드가 언급돼도 false. 다른 지역(웰링턴, 크라이스트처치 등) 소식도 false."""


def _system_prompt(cfg: dict, region: str) -> str:
    criteria = KR_CRITERIA if region == "kr" else _nz_criteria(cfg)
    return f"""당신은 뉴스 편집자입니다. 주어진 기사 목록의 각 항목에 1~10 정수 중요도를 매깁니다.
{criteria}
- immigration: 비자·이민·영주권·시민권·이민 정책/통계와 직접 관련 있으면 true, 아니면 false.
{AUCKLAND_RULE if region == "nz" else '- auckland: 항상 false.'}
- same_as: 목록의 다른 항목과 같은 사건이거나 같은 이슈의 후속·관련 기사이면(예: 같은 병원 인력난을 다룬 여러 기사,
  같은 기상 악화의 지역별 피해, 같은 비자 정책을 다룬 국내외 보도, 같은 인물의 사연) 그 묶음에서 가장 대표적인 기사의 id,
  아니면 빈 문자열 "". 대표 기사 자신은 "".
목록의 모든 id 에 대해 정확히 한 번씩 점수를 반환하세요."""


def _line(a: Article) -> str:
    desc = f" — {a.description[:160]}" if a.description else ""
    n = len(a.sources)
    return f"{a.id} | {a.source}{f' 외 {n-1}곳' if n > 1 else ''} | {a.title}{desc}"


# ── 휴리스틱 ────────────────────────────────────────────────

def _kw_hits(text: str, keywords: list[str]) -> int:
    text = text.lower()
    return sum(1 for k in keywords if re.search(r"(?<![a-z])" + re.escape(k.lower()) + r"(?![a-z])", text))


def heuristic_score(a: Article, cfg: dict, region: str, now: datetime) -> tuple[int, bool]:
    text = f"{a.title} {a.description}"
    score = 4.0 + min(len(a.sources) - 1, 3)  # 여러 곳이 보도하면 가산
    if a.published:
        age_h = (now - a.published).total_seconds() / 3600
        score += 1 if age_h < 12 else 0
    immigration = False
    if region == "nz":
        for i, topic in enumerate(cfg["weights"]["high"]):
            hits = _kw_hits(text, topic["keywords"])
            if hits:
                score += 2 + min(hits, 2)
                if i == 0:
                    immigration = True
        for topic in cfg["weights"]["low"]:
            if _kw_hits(text, topic["keywords"]):
                score -= 3
    return max(1, min(10, round(score))), immigration


def heuristic_auckland(a: Article, cfg: dict) -> bool:
    """AI 없이: 오클랜드 피드에서 왔거나 제목에 오클랜드 지명이 있으면 오클랜드 소식."""
    return a.section == "nz_auckland" or bool(_kw_hits(a.title, cfg.get("auckland_keywords", ["Auckland"])))


# ── 채점 ────────────────────────────────────────────────────

def score_articles(items: list[Article], cfg: dict, region: str, llm, now: datetime) -> None:
    if not items:
        return
    if llm is None:
        for a in items:
            a.score, a.is_immigration = heuristic_score(a, cfg, region, now)
            a.is_auckland = region == "nz" and heuristic_auckland(a, cfg)
        return
    system = _system_prompt(cfg, region)
    # 같은 기사가 여러 섹션에 있으면 id 가 같다 → 한 번만 보내고 점수는 모두에 적용
    by_id: dict[str, list[Article]] = defaultdict(list)
    for a in items:
        by_id[a.id].append(a)
    unique = [group[0] for group in by_id.values()]
    batch = int(cfg["llm"].get("rank_batch_size", 200))
    for start in range(0, len(unique), batch):
        chunk = unique[start:start + batch]
        user = "기사 목록 (id | 출처 | 제목 — 설명):\n" + "\n".join(_line(a) for a in chunk)
        scored: dict[str, dict] = {}
        try:
            out = llm.json_call(task="rank", system=system, user=user, schema=RANK_SCHEMA, max_tokens=32000)
            for row in out.get("scores", []):
                if row.get("id") in by_id:
                    scored[row["id"]] = row
        except Exception as e:  # noqa: BLE001 — 선별 실패 시 휴리스틱으로 대체
            log.warning("rank AI failed (%s); falling back to heuristic for %d items", e, len(chunk))
        for rep in chunk:
            row = scored.get(rep.id)
            for a in by_id[rep.id]:
                if row is None:  # 모델이 빠뜨린 항목·실패한 배치는 휴리스틱
                    a.score, a.is_immigration = heuristic_score(a, cfg, region, now)
                    a.is_auckland = region == "nz" and heuristic_auckland(a, cfg)
                    continue
                a.score = max(1, min(10, int(row["score"])))
                a.is_immigration = bool(row.get("immigration")) and region == "nz"
                a.is_auckland = bool(row.get("auckland")) and region == "nz"
                same = row.get("same_as") or ""
                a.same_as = same if same in by_id and same != a.id else ""


def _preselect(items: list[Article], limit: int) -> list[Article]:
    """비용 상한: 여러 곳이 보도한 기사 → 최신 기사 순으로 candidate_limit 건만 채점."""
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    return sorted(items, key=lambda a: (len(a.sources), a.published or epoch), reverse=True)[:limit]


def merge_same_story(items: list[Article], threshold: int) -> list[Article]:
    """AI 의 same_as 판단 + 제목 유사도로 같은 사건을 하나로 합친다. 대표는 점수·출처 수가 가장 높은 기사."""
    from dedupe import _merge, similar

    parent = {id(a): id(a) for a in items}
    by_obj = {id(a): a for a in items}
    by_aid: dict[str, list[Article]] = defaultdict(list)
    for a in items:
        by_aid[a.id].append(a)

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(id(a)), find(id(b))
        if ra != rb:
            parent[rb] = ra

    for a in items:
        for b in by_aid.get(a.same_as, []):
            union(a, b)
        for b in by_aid[a.id]:  # 같은 URL 이 두 섹션에 있던 경우
            union(a, b)
    for i, a in enumerate(items):
        for b in items[i + 1:]:
            if find(id(a)) != find(id(b)) and similar(a.title, b.title, threshold):
                union(a, b)

    groups: dict[int, list[Article]] = defaultdict(list)
    for a in items:
        groups[find(id(a))].append(by_obj[id(a)])
    reps = []
    for members in groups.values():
        members.sort(key=lambda x: (x.score, len(x.sources)), reverse=True)
        rep = members[0]
        for other in members[1:]:
            if other is not rep and other.id != rep.id:
                _merge(rep, other)
                if other.title not in rep.related and other.title != rep.title:
                    rep.related.append(other.title)
            rep.is_immigration |= other.is_immigration
        reps.append(rep)
    return reps


def split_nz(by_section: dict[str, list[Article]], threshold: int) -> None:
    """뉴질랜드/오클랜드 후보를 합쳐 같은 사건을 하나로 묶고, 오클랜드 지역 소식은 오클랜드 탭으로,
    전국 소식은 뉴질랜드 탭으로 다시 나눈다. → 두 탭에 같은 소식이 겹치지 않는다."""
    pool = [*by_section.get("nz_national", []), *by_section.get("nz_auckland", [])]
    reps = merge_same_story(pool, threshold)
    nat, akl = [], []
    for a in reps:
        a.section = "nz_auckland" if a.is_auckland else "nz_national"
        (akl if a.is_auckland else nat).append(a)
    log.info("nz split: %d candidates → %d stories (national %d / auckland %d)", len(pool), len(reps), len(nat), len(akl))
    by_section["nz_national"], by_section["nz_auckland"] = nat, akl


GROUP_SCHEMA = {
    "type": "object",
    "properties": {
        "nz_groups": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"ids": {"type": "array", "items": {"type": "string"}}, "tab": {"type": "string"}},
                "required": ["ids", "tab"],
                "additionalProperties": False,
            },
        },
        "radar_groups": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"ids": {"type": "array", "items": {"type": "string"}}},
                "required": ["ids"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["nz_groups", "radar_groups"],
    "additionalProperties": False,
}

GROUP_SYSTEM = """당신은 뉴질랜드 뉴스 편집자입니다. 상위 후보 기사들을 '이슈' 단위로 묶습니다.
[A] 뉴질랜드·오클랜드 후보:
- 같은 사건, 같은 이슈의 후속·관련 기사(같은 병원 문제, 같은 기상 악화의 여러 지역 피해, 같은 정책 등)는 한 그룹으로 묶으세요.
- 각 그룹의 tab: 오클랜드 지역 소식(오클랜드 시의회·교통·지역 사건사고·오클랜드 병원/학교·오클랜드 날씨)이면 "auckland",
  전국 단위 소식(정부 정책·전국 경제·전국 날씨·전국 통계)이면 오클랜드가 언급돼도 "national".
- 모든 id 가 정확히 한 그룹에 들어가야 합니다(혼자인 기사는 1개짜리 그룹).
[B] 이민 레이더 후보: 같은 비자·이민 이슈를 다룬 기사(국내외 보도 포함)를 한 그룹으로 묶으세요. 모든 id 를 정확히 한 번씩."""


def _apply_groups(items: list[Article], groups: list[dict], tab_key: str | None) -> list[Article]:
    """AI 가 묶은 그룹대로 기사를 합친다. 그룹에 없는 기사는 그대로 둔다."""
    from dedupe import _merge

    by_id = {a.id: a for a in items}
    used, out = set(), []
    for g in groups:
        members = [by_id[i] for i in dict.fromkeys(g.get("ids", [])) if i in by_id and i not in used]
        if not members:
            continue
        members.sort(key=lambda x: (x.score, len(x.sources)), reverse=True)
        rep = members[0]
        for other in members[1:]:
            _merge(rep, other)
            rep.is_immigration |= other.is_immigration
            for t in [other.title, *other.related]:
                if t != rep.title and t not in rep.related:
                    rep.related.append(t)
        if tab_key:
            rep.is_auckland = g.get(tab_key) == "auckland"
        used.update(m.id for m in members)
        out.append(rep)
    out.extend(a for a in items if a.id not in used)
    return out


def refine_nz(by_section: dict[str, list[Article]], radar: list[Article], cfg: dict, llm) -> list[Article]:
    """상위 후보만 모아 AI 로 이슈 묶기 + 탭 재배정을 한 번 더 한다 (요청 1회). 실패하면 그대로 둔다."""
    sec = cfg["sections"]
    window = lambda items, n: sorted(items, key=lambda a: (a.score, len(a.sources)), reverse=True)[: n * 2]
    nz_items = window(by_section["nz_national"], sec["nz_national"]["top_n"]) + window(by_section["nz_auckland"], sec["nz_auckland"]["top_n"])
    radar_items = window(radar, sec["nz_immigration"]["top_n"])
    if not nz_items and not radar_items:
        return radar
    user = ("[A]\n" + "\n".join(_line(a) for a in nz_items) + "\n\n[B]\n" + "\n".join(_line(a) for a in radar_items))
    try:
        out = llm.json_call(task="rank", system=GROUP_SYSTEM, user=user, schema=GROUP_SCHEMA, max_tokens=16000)
    except Exception as e:  # noqa: BLE001
        log.warning("nz grouping AI failed (%s); keeping first-pass split", e)
        return radar
    window_ids = {a.id for a in nz_items}
    rest = [a for k in ("nz_national", "nz_auckland") for a in by_section[k] if a.id not in window_ids]
    regrouped = _apply_groups(nz_items, out.get("nz_groups", []), "tab")
    nat, akl = [], []
    for a in regrouped + rest:
        a.section = "nz_auckland" if a.is_auckland else "nz_national"
        (akl if a.is_auckland else nat).append(a)
    by_section["nz_national"], by_section["nz_auckland"] = nat, akl
    radar_ids = {a.id for a in radar_items}
    radar = _apply_groups(radar_items, out.get("radar_groups", []), None) + [a for a in radar if a.id not in radar_ids]
    log.info("nz grouping: A %d → %d, B %d → %d", len(nz_items), len(regrouped), len(radar_items),
             len(radar) - (len([a for a in radar if a.id not in radar_ids])))
    return radar


def _top(items: list[Article], n: int) -> list[Article]:
    ranked = sorted(items, key=lambda a: (a.score, len(a.sources)), reverse=True)
    return [a for a in ranked if a.score >= MIN_SCORE][:n]


def select(articles: list[Article], cfg: dict, llm=None, now: datetime | None = None) -> dict[str, list[Article]]:
    now = now or datetime.now(timezone.utc)
    sections = cfg["sections"]
    by_section: dict[str, list[Article]] = defaultdict(list)
    for a in articles:
        by_section[a.section].append(a)

    # 섹션별 후보를 추린 뒤, 같은 지역(kr/nz) 후보를 한꺼번에 채점해 요청 수를 최소화
    by_region: dict[str, list[Article]] = defaultdict(list)
    for key, sec in sections.items():
        by_section[key] = _preselect(by_section.get(key, []), sec.get("candidate_limit", 80))
        by_region[sec["region"]].extend(by_section[key])
    for region, items in by_region.items():
        score_articles(items, cfg, region, llm, now)

    threshold = cfg["dedupe"]["title_similarity"]
    # 한국: 섹션 안에서 AI 가 같은 사건이라고 본 기사 합치기
    for key, sec in sections.items():
        if sec["region"] == "kr":
            by_section[key] = merge_same_story(by_section[key], threshold)
    # 뉴질랜드/오클랜드: 겹치지 않게 다시 나누기
    if "nz_national" in sections and "nz_auckland" in sections:
        split_nz(by_section, threshold)

    # 이민 레이더: 이민 전용 피드 + 다른 NZ 섹션에서 이민 관련으로 분류된 기사
    flagged = [a for k in ("nz_national", "nz_auckland") for a in by_section.get(k, []) if a.is_immigration]
    pool = by_section.get("nz_immigration", [])
    for a in pool:
        a.is_immigration = True
    # 같은 비자 이슈를 다룬 국내외 기사 여러 건은 한 장으로 (AI same_as + 제목 유사도)
    merged = merge_same_story(
        dedupe([*pool, *[_clone_to(a, "nz_immigration") for a in flagged]], threshold), threshold,
    )
    # 2차: 상위 후보만 모아 이슈 묶기·탭 재배정 (AI 요청 1회)
    if llm is not None and "nz_national" in sections and "nz_auckland" in sections:
        merged = refine_nz(by_section, merged, cfg, llm)

    chosen: dict[str, list[Article]] = {}
    for key, sec in sections.items():
        if key != "nz_immigration":
            chosen[key] = _top(by_section[key], sec["top_n"])
    chosen["nz_immigration"] = _top(merged, sections["nz_immigration"]["top_n"])
    for key, items in chosen.items():
        log.info("selected %-17s %d", key, len(items))
    return chosen


def _clone_to(a: Article, section: str) -> Article:
    return replace(a, section=section, extra_sources=list(a.extra_sources), related=list(a.related))
