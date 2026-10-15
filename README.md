# Daily Brief — 한국 + 뉴질랜드 이민 준비자를 위한 아침 뉴스 요약

매일 아침 8시 전에 아래 섹션의 주요 뉴스를 Claude가 한국어로 요약해 웹/모바일(PWA)로 보여줍니다.

| 탭 | 내용 |
|---|---|
| 🇰🇷 한국 | 사회 · 경제 · 연예 (정치는 설정에서 켰을 때만 표시) |
| 🇳🇿 뉴질랜드 | 이민 준비자 관점으로 가중치를 둔 전국 뉴스 + "이민자 관점" 한 줄 |
| 🏙️ 오클랜드 | 오클랜드 지역 뉴스 |
| 🛂 이민 레이더 | 비자·이민 정책 변경만 모은 섹션 (탭에 건수 배지) |

서버 없이 **GitHub Actions(수집·요약) + GitHub Pages(정적 사이트)**로만 동작합니다. 유료 항목은 Claude API 사용료뿐입니다.

<p>
<img src="docs/screenshots/01-iphone-kr.png" width="240" alt="iPhone 한국 탭">
<img src="docs/screenshots/03-360-dark-imm.png" width="240" alt="360px 다크모드 이민 레이더">
<img src="docs/screenshots/04a-settings.png" width="240" alt="설정 화면">
</p>

<sub>스크린샷은 레이아웃 확인용 샘플 데이터([샘플] 표시, 환율·날씨 값 포함)로 찍었으며 실제 뉴스가 아닙니다.</sub>

---

## 동작 방식

```
GitHub Actions (매시간 :30)
  └─ scripts/main.py
       ├─ 시각 확인: config.yaml 의 timezone 기준 07시대가 아니거나 오늘 파일이 이미 있으면 종료
       ├─ fetch.py      RSS 수집 (최근 24시간, 피드당 30건, 피드별 실패 격리, 대체 피드 자동 시도)
       ├─ dedupe.py     URL 정규화 + 제목 유사도(rapidfuzz ≥ 85)로 같은 사건 묶기, 출처는 모두 보존
       ├─ rank.py       Claude Haiku 5.5 로 섹션별 중요도 1~10 채점 → 상위 N건 (한국 5 / NZ 8 / 오클랜드 5)
       ├─ summarize.py  Claude Sonnet 5.5 로 섹션당 1회 호출: 한국어 제목, 3줄 요약, 이민자 관점, 태그, 한 줄 브리핑
       ├─ extras.py     NZD/KRW 환율(frankfurter), 오클랜드 날씨(Open-Meteo)
       ├─ build.py      스키마 검증 → web/public/data/YYYY-MM-DD.json, latest.json, index.json / 30일 지난 파일 삭제
       └─ notify.py     (선택) Telegram / Gmail 알림
  └─ 데이터 커밋 → deploy.yml 로 Pages 배포
```

- **원문 전문은 저장하지 않습니다.** 상위 기사 본문 일부(최대 1,500자)를 요약 입력으로만 쓰고, 결과 JSON에는 요약과 원문 링크만 남깁니다.
- JSON 출력은 structured outputs(`output_config.format` + JSON 스키마)로 강제합니다. Sonnet 5.5는 tool_choice 로 도구 호출을 강제하는 방식을 지원하지 않아서 이 방식을 씁니다.
- Sonnet 요약 요청은 server-side fallback(`fallbacks: "default"`)을 켜 두었습니다. 드물게 안전 분류기가 요청을 거절하면 서버가 다른 모델로 자동 재시도합니다. `config.yaml` 의 `llm.summary_fallback: false` 로 끌 수 있습니다.
- 피드 하나가 실패하거나, Claude 호출 하나가 실패해도 나머지는 계속 진행합니다. 실패한 피드 목록은 JSON `meta.failed_feeds` 와 화면 하단에 표시됩니다.
- 기사가 0건이거나 스키마 검증에 실패하면 워크플로가 실패하고 **GitHub 이슈가 자동 생성**됩니다. 같은 제목의 열린 이슈가 있으면 댓글을 추가합니다.

## 처음 설정하기

### 1. 저장소 설정
1. **Settings → Pages → Build and deployment → Source: GitHub Actions** 를 선택합니다.
2. **Settings → Secrets and variables → Actions → New repository secret**:

   | 이름 | 필수 | 설명 |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | ✅ | https://console.anthropic.com 에서 발급 |
   | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | 선택 | 텔레그램 알림 (`notify.telegram.enabled: true` 필요) |
   | `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_TO` | 선택 | Gmail 알림. 비밀번호는 [앱 비밀번호](https://myaccount.google.com/apppasswords) 사용 |

   키는 코드나 `config.yaml` 에 절대 적지 마세요.
3. **Settings → Actions → General → Workflow permissions: Read and write permissions** 를 선택합니다. 데이터 커밋과 이슈 생성에 필요합니다.
4. 무료 GitHub Pages 를 쓰려면 저장소가 public 이어야 합니다.

### 2. 첫 실행
- `main` 브랜치에 병합한 뒤 **Actions → Check feeds → Run workflow** 로 피드 상태를 먼저 확인합니다. 죽은 피드는 `config.yaml` 에서 URL을 바꾸거나 `enabled: false` 로 끕니다.
- **Actions → Daily Brief → Run workflow** 로 수동 실행합니다. `force` 가 기본으로 켜져 있어 시각 조건 없이 바로 생성됩니다. 끝나면 Pages 에 배포됩니다.
- 사이트 주소: `https://<계정>.github.io/<저장소>/` (예: https://dkwo284-max.github.io/News_Summary/)

> 예약 실행(`schedule`)은 GitHub 정책상 **기본 브랜치(main)** 에서만 동작합니다.

### 3. 홈 화면에 설치
- **iPhone (Safari)**: 공유 버튼 → "홈 화면에 추가"
- **Android (Chrome)**: 메뉴 → "앱 설치" 또는 "홈 화면에 추가"

한 번 열어 두면 오프라인에서도 마지막으로 받은 브리핑을 볼 수 있습니다.

## 실행 시각 / 타임존

- 기본값은 `timezone: "Asia/Seoul"`, `run_hour: 7` 입니다. 22:30 UTC 실행분(= 07:30 KST)에서 생성됩니다.
- **뉴질랜드로 이주한 뒤에는** `config.yaml` 에서 `timezone: "Pacific/Auckland"` 로 바꾸기만 하면 됩니다. 뉴질랜드 서머타임(9월 말~4월 초, UTC+13)과 표준시(UTC+12)를 스크립트가 자동으로 처리합니다. 그래서 워크플로는 매시간 실행되고, 현지 07시대가 아니면 수십 초 안에 종료됩니다(public 저장소는 Actions 무료).
- GitHub cron 은 붐비는 시간에 수십 분 늦게 시작될 수 있습니다. 그래서 `catchup_until_hour`(기본 11시) 전까지는 그날 브리핑이 아직 없으면 다음 실행에서 이어서 생성합니다.

## 피드 추가·삭제

`config.yaml` 의 `feeds:` 목록을 고칩니다.

```yaml
  - id: hankyung_economy          # 고유 이름 (영문)
    name: "한국경제"               # 카드에 표시될 출처명
    section: kr_economy           # kr_society | kr_economy | kr_entertainment | kr_politics | nz_national | nz_auckland | nz_immigration
    url: "https://www.hankyung.com/feed/economy"
    fallbacks: []                 # 기본 URL 이 죽었거나 0건일 때 순서대로 시도할 대체 피드
    enabled: true
    google_news: false            # Google News RSS 면 true ("제목 - 언론사"를 분리해 실제 언론사명을 출처로 사용)
```

- 공식 RSS 가 없는 사이트는 Google News 검색 RSS 로 대체할 수 있습니다:
  `https://news.google.com/rss/search?q=site:example.com+when:1d&hl=en-NZ&gl=NZ&ceid=NZ:en`
- 추가한 뒤 `python scripts/check_feeds.py` 또는 **Check feeds** 워크플로로 확인하세요.
- 섹션별 건수(`top_n`), 뉴질랜드 가중치 키워드(`weights`), 모델(`llm`)도 같은 파일에서 바꿉니다.

## 로컬 실행

```bash
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt

pytest                                         # 파서·중복제거·스키마·게이트 테스트 (네트워크/API 불필요)

# 네트워크·API 없이 샘플 피드로 전체 파이프라인 확인
python scripts/main.py --dry-run --no-llm --fixtures tests/fixtures/feeds --now 2026-10-15T22:00:00Z

# 실제 피드 + Claude 요약, 결과는 out/dry-run/ 에만 저장 (알림·정리 안 함)
export ANTHROPIC_API_KEY=...
python scripts/main.py --dry-run

# 프론트엔드
cd web && npm install && npm run dev           # http://localhost:5173 (web/public/data 의 JSON 사용)
```

`--dry-run` 결과를 화면에서 보려면 `out/dry-run/*.json` 을 `web/public/data/` 로 복사한 뒤 `npm run dev` 를 실행하세요.

| 옵션 | 설명 |
|---|---|
| `--force` | 시각 조건·중복 실행 검사를 무시 |
| `--dry-run` | `out/dry-run/` 에만 저장, 알림·오래된 파일 정리 안 함 |
| `--no-llm` | Claude 호출 없이 키워드 점수 + RSS 설명으로 실행 (요약 품질 없음, 점검용) |
| `--fixtures DIR` | 피드를 `DIR/<feed_id>.xml` 에서 읽음 |
| `--no-extras` | 환율·날씨 조회 생략 |

## 비용

- 모델: 선별 `claude-haiku-5-5` ($0.10 / $0.50 per 1M tokens), 요약 `claude-sonnet-5-5` ($2 / $10).
- 배치로 묶어 호출합니다. 하루에 Haiku 섹션당 1~2회(후보 60건 단위), Sonnet 섹션당 1회(7회)입니다.
- 실행이 끝나면 모델별 토큰 수와 예상 비용이 Actions 로그(`usage ...` 줄)와 JSON `meta.usage` 에 기록됩니다. `llm.daily_budget_usd`(기본 $0.30)를 넘으면 경고를 남깁니다.
- 아직 실제로 실행해 측정하지 않은 추정치입니다. 기사 약 40건 기준 하루 **$0.15~0.25** 정도로 예상합니다. 첫 실행 후 로그로 확인하세요. 비용을 줄이려면 `candidate_limit`, `top_n`, `fetch.body_chars` 를 낮추세요.

## 데이터 형식

`web/public/data/latest.json` (스키마: `schema/brief.schema.json`)

```jsonc
{
  "date": "2026-10-16",
  "generated_at": "2026-10-16T07:42:00+09:00",
  "timezone": "Asia/Seoul",
  "sections": {
    "nz_national": {
      "label": "뉴질랜드",
      "briefing": "오늘의 한 줄 브리핑",
      "items": [{
        "id": "3b8cf217f5d9",
        "title_ko": "한국어 제목",
        "summary_ko": ["줄1 (≤80자)", "줄2", "줄3"],
        "why_it_matters": "이민 준비자에게 의미 (NZ 섹션만)",
        "tags": ["비자", "주거"],
        "importance": 8,
        "sources": [{ "name": "RNZ", "url": "https://..." }],
        "original_title": "Original English title",
        "published_at": "2026-10-15T20:00+00:00"
      }]
    }
    // kr_society, kr_economy, kr_entertainment, kr_politics, nz_auckland, nz_immigration
  },
  "extras": { "nzd_krw": 812.3, "auckland_weather": { "max": 18, "min": 11, "desc": "구름 조금", "rain_chance": 20 } },
  "meta": { "mode": "claude", "failed_feeds": [], "usage": { "total_cost_usd": 0.0 } }
}
```

## 디렉터리

```
.github/workflows/  daily.yml (수집·요약·커밋·배포) · deploy.yml (Pages) · ci.yml · check-feeds.yml
config.yaml         피드, 섹션별 건수, 타임존, 가중치, 모델, 알림
scripts/            main.py fetch.py dedupe.py rank.py summarize.py build.py llm.py extras.py notify.py check_feeds.py
schema/             brief.schema.json
tests/              pytest + 합성 샘플 피드(tests/fixtures)
web/                Vite + TypeScript PWA (index.html, src/, public/manifest.json, public/sw.js, public/icons/)
```

## 문제 해결

| 증상 | 확인 |
|---|---|
| 사이트가 갱신되지 않음 | Actions → Daily Brief 로그의 `skip:` 줄 (시각 조건 / 이미 생성됨) |
| 특정 언론사 기사가 안 나옴 | 화면 하단 "수집 실패한 피드", **Check feeds** 워크플로 |
| `ANTHROPIC_API_KEY 가 없습니다` | Secrets 설정 확인 |
| 데이터 커밋 push 실패 | Settings → Actions → Workflow permissions 가 Read and write 인지 확인 |
| 홈 화면 앱이 옛 화면을 보여줌 | 앱을 완전히 닫았다가 다시 열기 (서비스 워커가 다음 실행 때 갱신) |
