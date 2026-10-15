"""중복 제거: URL 정규화 + 제목 유사도로 같은 사건을 하나로 묶고, 출처는 여러 개 남긴다."""
from __future__ import annotations

import re
from collections import defaultdict
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from rapidfuzz import fuzz

from common import Article, Source

TRACKING_PARAMS = re.compile(r"^(utm_.*|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|cmpid|ocid|rss|from|outputType|oc)$", re.I)
BRACKET_RE = re.compile(r"^\s*(\[[^\]]{1,12}\]|【[^】]{1,12}】|\([^)]{1,8}\))\s*")
PUNCT_RE = re.compile(r"[\"'“”‘’`·…,.!?:;|\-–—/\\()\[\]{}<>]+")


def normalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    host = parts.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    if host.startswith("m."):
        host = host[2:]
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=False) if not TRACKING_PARAMS.match(k)]
    path = parts.path.rstrip("/") or "/"
    return urlunsplit(("https", host, path, urlencode(sorted(query)), ""))


def normalize_title(title: str) -> str:
    t = title
    while True:  # "[속보] [단독] ..." 같은 머리표 제거
        new = BRACKET_RE.sub("", t)
        if new == t:
            break
        t = new
    t = PUNCT_RE.sub(" ", t.lower())
    return re.sub(r"\s+", " ", t).strip()


def similar(a: str, b: str, threshold: int) -> bool:
    na, nb = normalize_title(a), normalize_title(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    # token_set_ratio 는 짧은 제목이 긴 제목의 부분집합이면 100이 나오므로,
    # 짧은 쪽이 너무 짧으면(단어 3개 미만) 일반 ratio 로만 비교
    if min(len(na.split()), len(nb.split())) < 3:
        return fuzz.ratio(na, nb) >= threshold
    return fuzz.token_set_ratio(na, nb) >= threshold


def _merge(into: Article, other: Article) -> None:
    for s in other.sources:
        if s.url not in {x.url for x in into.sources}:
            into.extra_sources.append(Source(s.name, s.url))
    if len(other.description) > len(into.description):
        into.description = other.description
    if other.published and (into.published is None or other.published > into.published):
        into.published = other.published
    if other.id != into.id:
        into.merged_ids.extend(i for i in [other.id, *other.merged_ids] if i not in into.merged_ids and i != into.id)
    into.radar_score = max(into.radar_score, other.radar_score)
    into.is_immigration |= other.is_immigration


def _rank_key(a: Article) -> tuple:
    # 대표 기사: Google News 리다이렉트보다 언론사 직접 링크, 설명이 긴 것 우선
    return ("news.google.com" in a.url, -len(a.description))


def dedupe(articles: list[Article], threshold: int = 85) -> list[Article]:
    by_section: dict[str, list[Article]] = defaultdict(list)
    for a in articles:
        by_section[a.section].append(a)

    result: list[Article] = []
    for section, items in by_section.items():
        # 1) URL 기준
        by_url: dict[str, Article] = {}
        for a in sorted(items, key=_rank_key):
            key = normalize_url(a.url)
            if key in by_url:
                _merge(by_url[key], a)
            else:
                by_url[key] = a
        # 2) 제목 유사도 기준 (그리디 클러스터링)
        clusters: list[Article] = []
        for a in by_url.values():
            for c in clusters:
                if similar(c.title, a.title, threshold):
                    _merge(c, a)
                    break
            else:
                clusters.append(a)
        result.extend(clusters)
    return result
