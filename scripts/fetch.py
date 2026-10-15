"""RSS 수집: 피드별 실패를 격리하고, 최근 N시간 기사만 가져온다."""
from __future__ import annotations

import calendar
import hashlib
import html
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import feedparser
import httpx

from common import Article, log

TAG_RE = re.compile(r"<[^>]+>")
# "(서울=연합뉴스) 홍길동 기자 = " 같은 기사 머리 바이라인
BYLINE_RE = re.compile(r"^\s*[(\[][^)\]]{1,20}=[^)\]]{1,15}[)\]]\s*([^=]{0,40}?기자\s*=\s*)?")
WS_RE = re.compile(r"\s+")


def clean_text(s: str | None, limit: int = 400) -> str:
    s = html.unescape(TAG_RE.sub(" ", s or ""))
    s = WS_RE.sub(" ", s).strip()
    return s[:limit]


def _entry_time(entry) -> datetime | None:
    for key in ("published_parsed", "updated_parsed"):
        t = entry.get(key)
        if t:
            return datetime.fromtimestamp(calendar.timegm(t), tz=timezone.utc)
    return None


def _split_google_title(title: str, entry) -> tuple[str, str | None]:
    """Google News titles look like 'Headline - Publisher'."""
    publisher = None
    src = entry.get("source")
    if isinstance(src, dict):
        publisher = src.get("title")
    if publisher and title.endswith(" - " + publisher):
        return title[: -len(publisher) - 3].strip(), publisher
    if " - " in title:
        head, tail = title.rsplit(" - ", 1)
        if len(tail) <= 40:
            return head.strip(), publisher or tail.strip()
    return title, publisher


def parse_feed(raw: bytes | str, feed: dict, now: datetime, lookback_hours: int, max_items: int, url: str = "") -> list[Article]:
    parsed = feedparser.parse(raw)
    if parsed.bozo and not parsed.entries:
        raise ValueError(f"unparseable feed: {parsed.get('bozo_exception')!r}")
    cutoff = now - timedelta(hours=lookback_hours)
    out: list[Article] = []
    for entry in parsed.entries:
        link = entry.get("link") or ""
        title = clean_text(entry.get("title"), 300)
        if not link or not title:
            continue
        published = _entry_time(entry)
        # 날짜 없는 항목은 최신으로 간주하지 않음 (오래된 고정 글 방지)
        if published is None or published < cutoff or published > now + timedelta(hours=2):
            continue
        source_name = feed["name"]
        google = feed.get("google_news") or "news.google.com" in url
        if google:
            title, publisher = _split_google_title(title, entry)
            source_name = publisher or source_name
        desc = BYLINE_RE.sub("", clean_text(entry.get("summary") or entry.get("description"), 400))
        if google:
            desc = ""  # Google News 요약란은 제목/링크 목록이라 노이즈
        out.append(
            Article(
                id=hashlib.sha1(link.encode()).hexdigest()[:12],
                section=feed["section"],
                title=title,
                url=link,
                source=source_name,
                published=published,
                description=desc,
                feed_id=feed["id"],
            )
        )
        if len(out) >= max_items:
            break
    return out


def _download(client: httpx.Client, url: str) -> bytes:
    if url.startswith("file://"):
        return Path(url[7:]).read_bytes()
    r = client.get(url)
    r.raise_for_status()
    return r.content


def fetch_feed(client: httpx.Client, feed: dict, now: datetime, cfg_fetch: dict) -> tuple[list[Article], str | None, str | None]:
    """Try url then fallbacks. Returns (articles, used_url, error)."""
    errors = []
    reachable_url = None  # 응답은 정상이지만 최근 기사가 0건이었던 URL
    for url in [feed["url"], *feed.get("fallbacks", [])]:
        try:
            raw = _download(client, url)
            lookback = feed.get("lookback_hours", cfg_fetch["lookback_hours"])  # 피드별 기간 (이민 소식처럼 드문 피드는 길게)
            items = parse_feed(raw, feed, now, lookback, cfg_fetch["max_items_per_feed"], url)
            if items:
                return items, url, None
            reachable_url = reachable_url or url
        except Exception as e:  # noqa: BLE001 — 피드 하나 실패가 전체를 멈추면 안 됨
            errors.append(f"{url}: {type(e).__name__}: {e}"[:300])
    if reachable_url:
        return [], reachable_url, None
    return [], None, " | ".join(errors)


def fetch_all(cfg: dict, now: datetime | None = None, fixtures_dir: Path | None = None) -> tuple[list[Article], list[dict], list[dict]]:
    """Returns (articles, failures, feed_stats)."""
    now = now or datetime.now(timezone.utc)
    fcfg = cfg["fetch"]
    feeds = [f for f in cfg["feeds"] if f["enabled"]]
    if fixtures_dir is not None:
        feeds = [
            {**f, "url": f"file://{fixtures_dir / (f['id'] + '.xml')}", "fallbacks": []}
            for f in feeds
        ]

    headers = {"User-Agent": fcfg["user_agent"], "Accept": "application/rss+xml, application/xml, text/xml, */*"}
    articles: list[Article] = []
    failures: list[dict] = []
    stats: list[dict] = []
    with httpx.Client(timeout=fcfg["timeout_seconds"], headers=headers, follow_redirects=True) as client:
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda f: (f, *fetch_feed(client, f, now, fcfg)), feeds))
    for feed, items, used_url, err in results:
        stats.append({"id": feed["id"], "count": len(items), "url": used_url})
        if err:
            failures.append({"id": feed["id"], "name": feed["name"], "error": err})
            log.warning("feed failed: %s — %s", feed["id"], err)
        else:
            if used_url != feed["url"] and fixtures_dir is None:
                log.info("feed %s used fallback %s", feed["id"], used_url)
            log.info("feed %-22s %3d items", feed["id"], len(items))
        articles.extend(items)
    return articles, failures, stats
