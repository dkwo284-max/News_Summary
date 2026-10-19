"""Shared config loading, data model and time helpers."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "config.yaml"

log = logging.getLogger("brief")


def load_config(path: Path | str = DEFAULT_CONFIG) -> dict:
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    for feed in cfg.get("feeds", []):
        feed.setdefault("enabled", True)
        feed.setdefault("fallbacks", [])
        feed.setdefault("google_news", False)
        if feed["section"] not in cfg["sections"]:
            raise ValueError(f"feed {feed['id']}: unknown section {feed['section']}")
    return cfg


def tz(cfg: dict) -> ZoneInfo:
    return ZoneInfo(cfg.get("timezone", "Asia/Seoul"))


def now_local(cfg: dict) -> datetime:
    return datetime.now(timezone.utc).astimezone(tz(cfg))


@dataclass
class Source:
    name: str
    url: str

    def to_dict(self) -> dict:
        return {"name": self.name, "url": self.url}


@dataclass
class Article:
    """One story. After dedupe an Article may carry several sources."""

    id: str
    section: str
    title: str
    url: str
    source: str
    published: datetime | None
    description: str = ""
    feed_id: str = ""
    publisher_domain: str = ""  # 실제 언론사 도메인 (Google News 는 <source url>, 그 외는 기사 링크)
    extra_sources: list[Source] = field(default_factory=list)
    # filled by rank.py
    score: float = 0.0
    is_immigration: bool = False
    is_auckland: bool = False   # 오클랜드 지역 소식인지 (NZ 기사만)
    same_as: str = ""           # AI 가 같은 사건이라고 판단한 다른 기사 id
    related: list[str] = field(default_factory=list)  # 하나로 묶인 관련 기사 제목 (요약 입력용)
    merged_ids: list[str] = field(default_factory=list)  # 이 카드로 합쳐진 다른 기사 id (탭 간 중복 제거용)
    radar_score: int = 0        # 이민 레이더 관련도 0~10 (독자 프로필 기준, NZ 기사만)
    junk: bool = False          # 개인 사연·매물·광고성 기사 (AI 판단) → 제외
    category: str = ""          # 뉴질랜드 전국 기사 분류: society | education | economy | politics
    # transient: article body excerpt used only as summary input, never written out
    excerpt: str = ""

    @property
    def sources(self) -> list[Source]:
        seen, names, out = set(), set(), []
        for s in [Source(self.source, self.url), *self.extra_sources]:
            if s.url in seen or s.name in names:  # 같은 언론사의 다른 URL 은 첫 번째만 표시
                continue
            seen.add(s.url)
            names.add(s.name)
            out.append(s)
        return out
