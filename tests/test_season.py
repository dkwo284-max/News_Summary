"""쇼핑 시즌 피드(기간 한정 수집)와 광고 필터: 블랙프라이데이 '소식'은 싣고 '할인 목록'은 뺀다."""
from datetime import datetime, timezone

from common import Article, load_config
from fetch import in_season
from rank import excluded_reason

SEASON = {"season": ["11-15..12-05", "12-20..01-05"]}


def test_season_window_includes_ranges_and_crosses_year():
    assert in_season({}, datetime(2026, 7, 1, tzinfo=timezone.utc))          # season 없으면 항상
    assert in_season(SEASON, datetime(2026, 11, 26, tzinfo=timezone.utc))    # 블랙프라이데이 주간
    assert in_season(SEASON, datetime(2026, 12, 31, tzinfo=timezone.utc))    # 박싱데이 세일
    assert in_season(SEASON, datetime(2027, 1, 4, tzinfo=timezone.utc))      # 해를 넘는 범위
    assert not in_season(SEASON, datetime(2026, 12, 10, tzinfo=timezone.utc))
    assert not in_season(SEASON, datetime(2027, 2, 1, tzinfo=timezone.utc))
    # 뉴질랜드 날짜 기준: UTC 11/14 12시 = NZ 11/15 01시 → 시즌
    assert in_season(SEASON, datetime(2026, 11, 14, 12, tzinfo=timezone.utc))


def test_shopping_news_kept_but_deal_lists_excluded():
    cfg = load_config()
    mk = lambda t: Article(id=t, feed_id="gn_nz_shopping_season", section="nz_national", source="RNZ", title=t, url="https://x.nz/a", published=None)
    assert excluded_reason(mk("Black Friday spending hits record as retailers report busy start"), cfg) is None
    assert excluded_reason(mk("Commerce Commission warns of fake Black Friday sale prices"), cfg) is None
    assert excluded_reason(mk("Boxing Day scams: Netsafe urges shoppers to check websites"), cfg) is None
    assert excluded_reason(mk("The best Black Friday deals in NZ right now"), cfg)
    assert excluded_reason(mk("Boxing Day deals: 40% off TVs and laptops"), cfg)
    assert excluded_reason(mk("Exclusive coupon for Cyber Monday"), cfg)


def test_shopping_feed_is_seasonal():
    cfg = load_config()
    f = next(x for x in cfg["feeds"] if x["id"] == "gn_nz_shopping_season")
    assert f["enabled"] and f["season"]
