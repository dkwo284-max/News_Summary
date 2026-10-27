# 경찰 공식 범죄 통계 올리는 곳

뉴질랜드 경찰 공개 데이터(policedata.nz)는 자동 수집을 막아 두어서, 분기마다 한 번 직접 내려받아 이 폴더에 올립니다.

1. https://www.police.govt.nz/about-us/publications-statistics/data-and-statistics/policedatanz 에서
   **Victimisations (time and place)** 를 엽니다.
2. 필터에서 지역(Territorial Authority)을 **Auckland** 로, 기간을 **최근 24개월**로 고릅니다
   (12개월 비교를 위해 24개월이 좋습니다). 가능하면 Area Unit(동네)·월·범죄 대분류(ANZSOC Division)가 보이게 합니다.
3. 아래쪽 **Download → Data**(또는 Crosstab)로 CSV 를 내려받습니다.
4. GitHub 저장소 화면에서 이 `data/police/` 폴더로 들어가 **Add file → Upload files** 로 올리고 Commit 합니다.
5. 다음 날 아침 실행(또는 Actions → Daily Brief → Run workflow 에서 processing_only 를 true)이
   `web/public/data/crime-stats.json` 을 만들고, 앱의 오클랜드 → 치안에 동네별 12개월 건수가 표시됩니다.

열 이름은 자동으로 추정합니다(동네/월/범죄 종류/건수). 새 파일을 올리면 예전 파일은 지워도 됩니다.
