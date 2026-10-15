from datetime import datetime, timezone

from common import Article, Source
from dedupe import dedupe, normalize_title, normalize_url, similar

T = datetime(2026, 10, 15, 20, tzinfo=timezone.utc)


def art(i, title, url, section="kr_society", source="A", desc=""):
    return Article(id=str(i), section=section, title=title, url=url, source=source, published=T, description=desc)


def test_normalize_url_strips_tracking_and_www():
    assert normalize_url("http://www.Example.com/a/b/?utm_source=x&id=3#top") == "https://example.com/a/b?id=3"
    assert normalize_url("https://m.example.com/a?fbclid=1") == "https://example.com/a"


def test_normalize_title_strips_tags():
    assert normalize_title("[속보] [단독] 금리 동결!") == "금리 동결"


def test_similar_threshold():
    assert similar("한국은행 기준금리 동결 결정", "한국은행, 기준금리 동결 결정", 85)
    assert not similar("한국은행 기준금리 동결 결정", "코스피 외국인 순매수 지속", 85)
    # 짧은 제목이 긴 제목의 부분집합이어도 단어 3개 미만이면 ratio 로만 비교
    assert not similar("금리 동결", "금리 동결에 부동산 시장 반응 엇갈려 전문가 전망", 85)


def test_dedupe_merges_url_and_title_keeps_sources():
    items = [
        art(1, "수도권 광역버스 노선 3개 신설", "https://a.com/x?utm_source=rss", source="연합뉴스", desc="짧음"),
        art(2, "수도권 광역버스 노선 3개 신설", "https://www.a.com/x", source="연합뉴스"),
        art(3, "[속보] 수도권 광역버스 노선 3개 신설 발표", "https://b.com/y", source="한국일보", desc="더 긴 설명입니다"),
        art(4, "가을 태풍 북상", "https://c.com/z", source="KBS"),
    ]
    out = dedupe(items, 85)
    assert len(out) == 2
    bus = next(a for a in out if "버스" in a.title)
    assert {s.name for s in bus.sources} == {"연합뉴스", "한국일보"}
    assert bus.description == "더 긴 설명입니다"


def test_dedupe_is_per_section():
    items = [art(1, "같은 제목의 기사 입니다", "https://a.com/1", section="nz_national"),
             art(2, "같은 제목의 기사 입니다", "https://a.com/2", section="nz_auckland")]
    assert len(dedupe(items, 85)) == 2


def test_sources_unique_by_outlet():
    a = art(1, "제목 하나 둘 셋", "https://a.com/1", source="조선일보")
    a.extra_sources = [Source("조선일보", "https://a.com/2"), Source("연합뉴스", "https://b.com/1")]
    assert [s.name for s in a.sources] == ["조선일보", "연합뉴스"]
