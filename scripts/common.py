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
    extra_sources: list[Source] = field(default_factory=list)
    # filled by rank.py
    score: float = 0.0
    is_immigration: bool = False
    is_auckland: bool = False   # 오클랜드 지역 소식인지 (NZ 기사만)
    same_as: str = ""           # AI 가 같은 사건이라고 판단한 다른 기사 id
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
