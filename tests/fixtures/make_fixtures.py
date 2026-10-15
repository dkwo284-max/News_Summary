"""오프라인 테스트용 합성 RSS 피드 생성기.

모든 기사는 가짜이며 제목에 [샘플]/[Sample] 표시가 붙어 있습니다. 실제 뉴스가 아닙니다.
기준 시각 FIXTURE_NOW 에 맞춰 pubDate 를 만들고, tests/fixtures/feeds/<feed_id>.xml 로 저장합니다.

    python tests/fixtures/make_fixtures.py
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from xml.sax.saxutils import escape

FIXTURE_NOW = datetime(2026, 10, 15, 22, 0, tzinfo=timezone.utc)  # = 2026-10-16 07:00 KST
OUT = Path(__file__).parent / "feeds"

# feed_id -> [(title, description, hours_ago, link_slug)]
FEEDS: dict[str, list[tuple[str, str, float, str]]] = {
    "yna_society": [
        ("[샘플] 수도권 광역버스 노선 3개 신설 발표", "샘플 설명입니다. 출퇴근 시간 혼잡 완화를 위해 노선을 신설한다고 밝혔다. 운행은 다음 달 시작된다.", 3, "bus"),
        ("[샘플] 전국 초등학교 늘봄학교 참여율 상승", "샘플 설명입니다. 참여 학교 수가 늘었다.", 6, "school"),
        ("[샘플] 오래된 기사 (필터링 대상)", "48시간 전 기사", 48, "old"),
    ],
    "gn_kr_society": [
        ("[샘플] 수도권 광역버스 노선 3개 신설 발표 - 한국일보", "", 2.5, "bus-dup"),
        ("[샘플] 가을 태풍 북상에 남부지방 대비 강화 - KBS", "", 4, "typhoon"),
    ],
    "yna_economy": [
        ("[샘플] 한국은행 기준금리 동결 결정", "샘플 설명입니다. 금융통화위원회가 기준금리를 동결했다. 물가와 환율을 고려했다.", 5, "rate"),
        ("[샘플] 코스피 외국인 순매수 지속", "샘플 설명입니다.", 7, "kospi"),
    ],
    "gn_kr_economy": [
        ("[샘플] 한국은행, 기준금리 동결 결정 - 매일경제", "", 4.5, "rate-dup"),
    ],
    "yna_entertainment": [
        ("[샘플] 인기 드라마 시즌2 제작 확정", "샘플 설명입니다. 방송사가 후속 시즌 제작을 공식 발표했다.", 8, "drama"),
        ("[샘플] 아이돌 그룹 월드투어 일정 공개", "샘플 설명입니다.", 10, "tour"),
    ],
    "yna_politics": [
        ("[샘플] 국회 예산안 심사 본격 착수", "샘플 설명입니다. 상임위별 예산 심사가 시작됐다.", 5, "budget"),
    ],
    "rnz_national": [
        ("[Sample] Immigration NZ updates Skilled Migrant Category guidance", "Sample description. The agency published updated guidance for residence applicants.", 3, "smc"),
        ("[Sample] Unemployment rate edges up in latest quarter", "Sample description. The labour market softened further according to new data.", 5, "jobs"),
        ("[Sample] All Blacks name squad for end-of-year tour", "Sample description. Rugby squad announced.", 6, "rugby"),
    ],
    "nzh_nz": [
        ("[Sample] Immigration NZ updates Skilled Migrant Category guidance for residence", "Sample description from another outlet.", 2, "smc-dup"),
        ("[Sample] Rents fall in main centres as supply rises", "Sample description. Median rents dropped across several cities.", 9, "rent"),
    ],
    "nzh_business": [
        ("[Sample] Reserve Bank signals further OCR cut", "Sample description. The central bank said the OCR could fall again; mortgage rates may follow.", 4, "ocr"),
    ],
    "gn_nz_top": [
        ("[Sample] Heavy rain warning issued for Northland and Auckland - MetService", "", 1, "rain"),
    ],
    "inz_news": [
        ("[Sample] Changes to Accredited Employer Work Visa settings announced", "Sample description. New AEWV settings take effect next month.", 20, "aewv"),
    ],
    "gn_auckland": [
        ("[Sample] Auckland Council consults on rates increase - Stuff", "", 5, "rates"),
        ("[Sample] New CRL station opening date confirmed - RNZ", "", 7, "crl"),
    ],
    "our_auckland": [
        ("[Sample] Free family events across Auckland parks this weekend", "Sample description. Council-run events in local parks.", 12, "events"),
    ],
}


def rss(feed_id: str, items: list[tuple[str, str, float, str]]) -> str:
    entries = []
    for title, desc, hours_ago, slug in items:
        pub = format_datetime(FIXTURE_NOW - timedelta(hours=hours_ago))
        entries.append(
            f"<item><title>{escape(title)}</title><link>https://example.com/{feed_id}/{slug}?utm_source=rss</link>"
            f"<description>{escape(desc)}</description><pubDate>{pub}</pubDate></item>"
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>'
        f"<title>{feed_id} (sample)</title><link>https://example.com/</link><description>synthetic</description>"
        + "".join(entries)
        + "</channel></rss>\n"
    )


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for feed_id, items in FEEDS.items():
        (OUT / f"{feed_id}.xml").write_text(rss(feed_id, items), encoding="utf-8")
    # 망가진 피드: 파서 실패가 전체를 멈추지 않는지 확인용
    (OUT / "hani_society.xml").write_text("<html>not a feed", encoding="utf-8")
    print(f"wrote {len(FEEDS) + 1} fixture feeds to {OUT}")


if __name__ == "__main__":
    main()
