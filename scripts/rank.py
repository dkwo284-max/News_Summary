"""선별: 섹션별 중요도(1~10)를 매기고 상위 N건을 고른다.

LLM 이 있으면 Haiku 로 배치 채점, 없으면(--no-llm) 키워드·출처수 기반 휴리스틱.
"""
from __future__ import annotations

import re
from dataclasses import replace
from collections import defaultdict
from datetime import datetime, timezone

from common import Article, log
from dedupe import dedupe

BATCH = 60
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
                },
                "required": ["id", "score", "immigration"],
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
- 그 외 일반 뉴스는 사회적 파급력에 따라 4~6점."""


def _system_prompt(cfg: dict, region: str) -> str:
    criteria = KR_CRITERIA if region == "kr" else _nz_criteria(cfg)
    return f"""당신은 뉴스 편집자입니다. 주어진 기사 목록의 각 항목에 1~10 정수 중요도를 매깁니다.
{criteria}
- immigration: 비자·이민·영주권·시민권·이민 정책/통계와 직접 관련 있으면 true, 아니면 false.
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


# ── 채점 ────────────────────────────────────────────────────

def score_articles(items: list[Article], cfg: dict, region: str, llm, now: datetime) -> None:
    if not items:
        return
    if llm is None:
        for a in items:
            a.score, a.is_immigration = heuristic_score(a, cfg, region, now)
        return
    system = _system_prompt(cfg, region)
    by_id = {a.id: a for a in items}
    for start in range(0, len(items), BATCH):
        chunk = items[start:start + BATCH]
        user = "기사 목록 (id | 출처 | 제목 — 설명):\n" + "\n".join(_line(a) for a in chunk)
        try:
            out = llm.json_call(model=cfg["llm"]["rank_model"], system=system, user=user, schema=RANK_SCHEMA,
                                effort=cfg["llm"].get("rank_effort", "low"), max_tokens=8000)
        except Exception as e:  # noqa: BLE001 — 선별 실패 시 휴리스틱으로 대체
            log.warning("rank LLM failed (%s); falling back to heuristic for %d items", e, len(chunk))
            for a in chunk:
                a.score, a.is_immigration = heuristic_score(a, cfg, region, now)
            continue
        seen = set()
        for row in out.get("scores", []):
            a = by_id.get(row["id"])
            if a is None:
                continue
            a.score = max(1, min(10, int(row["score"])))
            a.is_immigration = bool(row.get("immigration")) and region == "nz"
            seen.add(a.id)
        for a in chunk:
            if a.id not in seen:  # 모델이 빠뜨린 항목
                a.score, a.is_immigration = heuristic_score(a, cfg, region, now)


def _preselect(items: list[Article], limit: int) -> list[Article]:
    """비용 상한: 여러 곳이 보도한 기사 → 최신 기사 순으로 candidate_limit 건만 채점."""
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    return sorted(items, key=lambda a: (len(a.sources), a.published or epoch), reverse=True)[:limit]


def _top(items: list[Article], n: int) -> list[Article]:
    ranked = sorted(items, key=lambda a: (a.score, len(a.sources)), reverse=True)
    return [a for a in ranked if a.score >= MIN_SCORE][:n]


def select(articles: list[Article], cfg: dict, llm=None, now: datetime | None = None) -> dict[str, list[Article]]:
    now = now or datetime.now(timezone.utc)
    sections = cfg["sections"]
    by_section: dict[str, list[Article]] = defaultdict(list)
    for a in articles:
        by_section[a.section].append(a)

    chosen: dict[str, list[Article]] = {}
    for key, sec in sections.items():
        candidates = _preselect(by_section.get(key, []), sec.get("candidate_limit", 80))
        score_articles(candidates, cfg, sec["region"], llm, now)
        by_section[key] = candidates
        if key != "nz_immigration":
            chosen[key] = _top(candidates, sec["top_n"])

    # 이민 레이더: 이민 전용 피드 + 다른 NZ 섹션에서 이민 관련으로 분류된 기사
    flagged = [a for k in ("nz_national", "nz_auckland") for a in by_section.get(k, []) if a.is_immigration]
    pool = by_section.get("nz_immigration", [])
    for a in pool:
        a.is_immigration = True
    merged = dedupe(
        [*pool, *[_clone_to(a, "nz_immigration") for a in flagged]],
        cfg["dedupe"]["title_similarity"],
    )
    chosen["nz_immigration"] = _top(merged, sections["nz_immigration"]["top_n"])
    for key, items in chosen.items():
        log.info("selected %-17s %d", key, len(items))
    return chosen


def _clone_to(a: Article, section: str) -> Article:
    return replace(a, section=section, extra_sources=list(a.extra_sources))
