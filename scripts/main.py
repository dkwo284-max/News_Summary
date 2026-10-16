"""Daily Brief 파이프라인: 수집 → 중복제거 → 선별 → 요약 → 저장.

사용 예
  python scripts/main.py                     # 정해진 시각(현지 07시대)일 때만 실행, 결과를 web/public/data 에 저장
  python scripts/main.py --force             # 시각 조건 무시하고 바로 실행
  python scripts/main.py --dry-run           # 실제 수집·AI 요약(기본 Gemini 무료 등급)까지 하되 out/dry-run/ 에만 저장, 알림·정리 없음
  python scripts/main.py --dry-run --no-llm  # AI 호출 없이 (키워드 선별 + RSS 설명) 파이프라인만 점검
  python scripts/main.py --dry-run --no-llm --fixtures tests/fixtures/feeds   # 네트워크 없이 로컬 샘플 피드로 점검

종료 코드: 0 성공/건너뜀, 2 기사 0건, 3 스키마 검증 실패
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from common import ROOT, load_config, log, tz

EXIT_EMPTY, EXIT_INVALID = 2, 3


def set_output(name: str, value: str) -> None:
    """GitHub Actions 다음 단계로 값 전달."""
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{name}={value}\n")


def should_run(cfg: dict, local_now: datetime, data_dir: Path) -> tuple[bool, str]:
    start = cfg.get("run_hour", 7)
    until = cfg.get("catchup_until_hour", start + 1)
    if not (start <= local_now.hour < until):
        return False, f"local time {local_now:%H:%M} {cfg['timezone']} outside {start:02d}:00–{until:02d}:00"
    if (data_dir / f"{local_now.date().isoformat()}.json").exists():
        return False, f"brief for {local_now.date()} already exists"
    return True, "ok"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(ROOT / "config.yaml"))
    ap.add_argument("--force", action="store_true", help="시각 조건·중복 실행 검사 무시")
    ap.add_argument("--dry-run", action="store_true", help="out/dry-run 에만 저장, 알림·정리 안 함")
    ap.add_argument("--no-llm", action="store_true", help="AI 호출 없이 휴리스틱으로 실행")
    ap.add_argument("--fixtures", type=Path, help="피드를 이 폴더의 <feed_id>.xml 에서 읽음 (오프라인 테스트)")
    ap.add_argument("--no-extras", action="store_true", help="환율·날씨 조회 생략")
    ap.add_argument("--now", help="현재 시각 대체 (ISO 8601, 테스트용)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "httpcore", "trafilatura", "anthropic"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    cfg = load_config(args.config)
    now_utc = datetime.fromisoformat(args.now).astimezone(timezone.utc) if args.now else datetime.now(timezone.utc)
    local_now = now_utc.astimezone(tz(cfg))
    data_dir = ROOT / cfg["output"]["data_dir"]
    out_dir = ROOT / "out" / "dry-run" if args.dry_run else data_dir
    set_output("generated", "false")

    if not (args.force or args.dry_run):
        ok, why = should_run(cfg, local_now, data_dir)
        if not ok:
            log.info("skip: %s", why)
            return 0

    # 1) 수집
    from fetch import fetch_all
    articles, failures, feed_stats = fetch_all(cfg, now_utc, args.fixtures)
    log.info("fetched %d articles from %d feeds (%d failed)", len(articles), len(feed_stats), len(failures))

    # 2) 중복 제거
    from dedupe import dedupe
    articles = dedupe(articles, cfg["dedupe"]["title_similarity"])
    log.info("after dedupe: %d stories", len(articles))

    # 3) 선별 / 4) 요약 — AI 요청은 보통 5회(지역별 선별 1 + NZ 이슈 묶기 1 + 지역별 요약 1)
    llm = None
    if not args.no_llm:
        from llm import LLMError, make_llm
        try:
            llm = make_llm(cfg)
        except LLMError as e:
            log.error("%s", e)
            return 1

    from rank import select
    chosen = select(articles, cfg, llm, now_utc)

    from summarize import attach_excerpts, summarize_all
    if llm is not None and args.fixtures is None:
        attach_excerpts(chosen, cfg)
    sections = summarize_all(chosen, cfg, llm)

    extras = {"nzd_krw": None, "auckland_weather": None}
    if not args.no_extras and args.fixtures is None:
        from extras import fetch_extras
        from processing import fetch_processing_times, load_previous
        extras = fetch_extras(cfg)
        # 이민 레이더 전광판: 비자별 처리 기간 (정규식으로 못 찾으면 AI 요청 1회)
        try:
            extras["processing_times"] = fetch_processing_times(cfg, llm, load_previous(data_dir))
        except Exception as e:  # noqa: BLE001 — 전광판 실패가 브리핑 생성을 막지 않게
            log.warning("processing times failed: %s", e)

    usage = llm.log_report() if llm else {"provider": None, "requests": 0, "models": {}, "total_cost_usd": 0}
    brief = {
        "date": local_now.date().isoformat(),
        "generated_at": datetime.now(timezone.utc).astimezone(tz(cfg)).isoformat(timespec="seconds"),
        "timezone": cfg["timezone"],
        "sections": sections,
        "extras": extras,
        "meta": {
            "mode": "no-llm" if llm is None else llm.provider,
            "failed_feeds": failures,
            "feeds_total": len(feed_stats),
            "stories_after_dedupe": len(articles),
            "usage": usage,
        },
    }

    # 5) 검증 · 저장
    from build import BriefValidationError, prune_and_index, total_items, validate, write_brief
    try:
        validate(brief, cfg)
    except BriefValidationError as e:
        log.error("schema validation failed: %s", e)
        return EXIT_INVALID
    n = total_items(brief)
    if n == 0:
        log.error("0 items in brief — not writing")
        return EXIT_EMPTY

    path = write_brief(brief, out_dir)
    prune_and_index(out_dir, local_now.date(), cfg["output"]["retention_days"])
    log.info("wrote %s (%d items)", path.relative_to(ROOT), n)

    if args.dry_run:
        print(json.dumps({k: {"briefing": s["briefing"], "titles": [i["title_ko"] for i in s["items"]]}
                          for k, s in sections.items()}, ensure_ascii=False, indent=1))
        return 0

    set_output("generated", "true")
    set_output("date", brief["date"])
    from notify import notify
    notify(brief, cfg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
