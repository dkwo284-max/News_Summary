from datetime import datetime, timezone

import httpx

from fetch import _split_google_title, fetch_all, fetch_feed, parse_feed
from make_fixtures import FIXTURE_NOW

FEED = {"id": "t", "name": "Test", "section": "nz_national", "google_news": False, "fallbacks": []}

RSS = """<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Fresh &amp; new</title><link>https://a.example/1</link><description>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt;&lt;/p&gt;</description>
<pubDate>Thu, 15 Oct 2026 20:00:00 GMT</pubDate></item>
<item><title>Too old</title><link>https://a.example/2</link><pubDate>Mon, 12 Oct 2026 20:00:00 GMT</pubDate></item>
<item><title>No date</title><link>https://a.example/3</link></item>
</channel></rss>"""


def test_parse_filters_by_age_and_cleans_html():
    items = parse_feed(RSS, FEED, FIXTURE_NOW, 24, 30)
    assert [a.title for a in items] == ["Fresh & new"]
    assert items[0].description == "Hello world"
    assert items[0].published == datetime(2026, 10, 15, 20, tzinfo=timezone.utc)


def test_max_items_per_feed():
    many = "".join(
        f"<item><title>T{i}</title><link>https://a.example/{i}</link><pubDate>Thu, 15 Oct 2026 20:00:00 GMT</pubDate></item>"
        for i in range(50)
    )
    items = parse_feed(f"<rss><channel>{many}</channel></rss>", FEED, FIXTURE_NOW, 24, 30)
    assert len(items) == 30


def test_google_news_title_split():
    title, pub = _split_google_title("금리 동결 결정 - 매일경제", {"source": {"title": "매일경제"}})
    assert (title, pub) == ("금리 동결 결정", "매일경제")
    title, pub = _split_google_title("Heavy rain warning - MetService", {})
    assert (title, pub) == ("Heavy rain warning", "MetService")


def _client(routes):
    def handler(request):
        status, body = routes.get(str(request.url), (404, ""))
        return httpx.Response(status, content=body)
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_fallback_used_when_primary_dead():
    feed = {**FEED, "url": "https://dead.example/rss", "fallbacks": ["https://alt.example/rss"]}
    client = _client({"https://dead.example/rss": (500, ""), "https://alt.example/rss": (200, RSS)})
    items, used, err = fetch_feed(client, feed, FIXTURE_NOW, {"lookback_hours": 24, "max_items_per_feed": 30})
    assert used == "https://alt.example/rss" and err is None and len(items) == 1


def test_all_urls_dead_reports_error():
    feed = {**FEED, "url": "https://dead.example/rss", "fallbacks": []}
    items, used, err = fetch_feed(_client({}), feed, FIXTURE_NOW, {"lookback_hours": 24, "max_items_per_feed": 30})
    assert items == [] and used is None and "404" in err


def test_one_broken_feed_does_not_stop_others(cfg, fixtures_dir):
    articles, failures, stats = fetch_all(cfg, FIXTURE_NOW, fixtures_dir)
    failed = {f["id"] for f in failures}
    assert "hani_society" in failed  # 망가진 XML
    assert articles, "다른 피드의 기사는 수집되어야 함"
    assert all("오래된" not in a.title for a in articles)
