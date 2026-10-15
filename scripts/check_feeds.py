"""config.yaml 의 모든 피드(대체 피드 포함)가 살아 있는지 점검한다.

    python scripts/check_feeds.py            # 표 출력
    python scripts/check_feeds.py --strict   # 기본+대체 모두 죽은 피드가 있으면 exit 1
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone

import feedparser
import httpx

from common import load_config


def check_url(client: httpx.Client, url: str) -> tuple[str, int, str]:
    try:
        r = client.get(url)
        if r.status_code >= 400:
            return "DEAD", 0, f"HTTP {r.status_code}"
        parsed = feedparser.parse(r.content)
        n = len(parsed.entries)
        if n == 0:
            return "EMPTY", 0, "no entries" + (f" ({parsed.get('bozo_exception')})" if parsed.bozo else "")
        newest = max(
            (datetime(*e[k][:6], tzinfo=timezone.utc) for e in parsed.entries for k in ("published_parsed", "updated_parsed") if e.get(k)),
            default=None,
        )
        age = f"newest {newest:%Y-%m-%d %H:%M}Z" if newest else "no dates"
        return "OK", n, age
    except Exception as e:  # noqa: BLE001
        return "DEAD", 0, f"{type(e).__name__}: {e}"[:120]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--strict", action="store_true")
    args = ap.parse_args()
    cfg = load_config()
    ua = {"User-Agent": cfg["fetch"]["user_agent"]}
    all_dead = []
    with httpx.Client(timeout=20, headers=ua, follow_redirects=True) as client:
        for feed in cfg["feeds"]:
            flag = "" if feed["enabled"] else " (disabled)"
            print(f"\n[{feed['section']}] {feed['id']}{flag}")
            alive = False
            for i, url in enumerate([feed["url"], *feed["fallbacks"]]):
                status, n, note = check_url(client, url)
                alive |= status == "OK"
                print(f"  {'primary ' if i == 0 else 'fallback'} {status:5} {n:3}  {note}\n           {url}")
            if feed["enabled"] and not alive:
                all_dead.append(feed["id"])
    print("\n" + ("모든 활성 피드에 살아 있는 URL이 있습니다." if not all_dead else f"살아 있는 URL이 없는 피드: {', '.join(all_dead)}"))
    return 1 if (args.strict and all_dead) else 0


if __name__ == "__main__":
    sys.exit(main())
