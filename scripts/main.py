"""Daily Brief 파이프라인: 수집 → 중복제거 → 선별 → 요약 → 저장.

사용 예
  python scripts/main.py                     # 정해진 시각(현지 run_hour 시대)일 때만 실행, 결과를 web/public/data 에 저장
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
from datetime import date, datetime, timezone
from pathlib import Path

from common import ROOT, finite, load_config, log, tz

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


def build_alerts(sections: dict, extras: dict, cfg: dict) -> list[dict]:
    """즉시 알릴 만한 것: 처리 기간 급변, 이민 레이더 관련도 9점 이상 기사."""
    from processing import processing_alerts

    alerts = processing_alerts(extras.get("processing_times") or {})
    min_radar = int(cfg.get("profile", {}).get("alert_radar_score", 9))
    for it in sections.get("nz_immigration", {}).get("items", []):
        if it.get("radar", 0) >= min_radar:
            alerts.append({"kind": "radar", "text": it["title_ko"], "url": it["sources"][0]["url"] if it["sources"] else ""})
    return alerts


def carry_over(sections: dict, cfg: dict, data_dir: Path, today: str, max_items: int = 2) -> None:
    """carry_days 가 있는 섹션(오클랜드 의료·교육·치안·부동산)이 비면 최근 브리핑의 같은 섹션 기사를 '지난 소식'으로 채운다."""
    from datetime import date, timedelta

    t = date.fromisoformat(today)
    for key, sec in cfg["sections"].items():
        days = int(sec.get("carry_days", 0))
        if not days or key not in sections or sections[key]["items"]:
            continue
        for back in range(1, days + 1):
            d = (t - timedelta(days=back)).isoformat()
            try:
                old = json.loads((data_dir / f"{d}.json").read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                continue
            fresh = [it for it in old.get("sections", {}).get(key, {}).get("items", []) if not it.get("carried_from")]
            if fresh:
                sections[key]["items"] = [{**it, "carried_from": d} for it in fresh[:max_items]]
                log.info("carried %d item(s) into %s from %s", len(sections[key]["items"]), key, d)
                break


def update_processing_only(cfg: dict, data_dir: Path) -> int:
    """최신 브리핑 파일의 extras.processing_times 만 다시 받아 덮어쓴다 (AI 요청 없음)."""
    from processing import fetch_processing_times

    latest = data_dir / "latest.json"
    if not latest.exists():
        log.error("no latest.json to update")
        return 1
    brief = json.loads(latest.read_text(encoding="utf-8"))
    previous = brief.get("extras", {}).get("processing_times")
    from processing import update_history

    # AI 없이 갱신되는 부가 데이터도 함께 (한인 GP 지도·동네 비교)
    for mod, fn, args in (("korean_gp", "update_korean_gp", (cfg, data_dir)), ("areas", "update_areas", (cfg, data_dir, date.fromisoformat(brief["date"]))),
                          ("crime_stats", "update_crime_stats", (data_dir,)),
                          ("incidents", "update_incidents", ({}, cfg, data_dir, brief["date"]))):
        try:
            getattr(__import__(mod), fn)(*args)
        except Exception as e:  # noqa: BLE001
            log.warning("%s failed: %s", mod, e)
    # 환율·비트코인·기준금리·날씨도 함께 새로 (AI 없음)
    try:
        from extras import fetch_extras

        brief.setdefault("extras", {}).update({k: v for k, v in fetch_extras(cfg).items() if v is not None})
    except Exception as e:  # noqa: BLE001
        log.warning("extras refresh failed: %s", e)
    pt = fetch_processing_times(cfg, None, previous)
    brief.setdefault("extras", {})["processing_times"] = update_history(pt, data_dir, brief["date"])
    body = json.dumps(finite(brief), ensure_ascii=False, indent=1, allow_nan=False)
    latest.write_text(body, encoding="utf-8")
    (data_dir / f"{brief['date']}.json").write_text(body, encoding="utf-8")
    set_output("generated", "true")
    set_output("date", f"{brief['date']} (processing times)")
    log.info("updated processing times in %s", brief["date"])
    return 0


MAX_RETRIES = 4   # 하루 자동 복구 시도 상한 (실패한 단계만 고치므로 한 번에 AI 1~3회)


def repair_only(cfg: dict, data_dir: Path, cur: dict, local_now, retries: int, args) -> int | None:
    """오늘 브리핑의 실패한 단계만 고쳐 저장한다. 전체 재생성이 필요하면(선별 실패) None 을 돌려준다."""
    import repair
    from llm import LLMError, make_llm

    todo = repair.needs(cur, cfg)
    if todo["rank"] or not (todo["summary"] or todo["insight"]):
        return None
    today = local_now.date().isoformat()
    try:
        llm = make_llm(cfg)
    except LLMError as e:
        log.error("%s", e)
        return 1
    if not args.ignore_cap:
        from budget import allowance, describe
        from usage import used_today
        left, binfo = allowance("daily-brief", used_today(data_dir, today), int(cfg.get("llm", {}).get("guaranteed", 7)), today)
        log.info("%s", describe("daily-brief", left, binfo))
        if left <= 0:
            log.warning("skip repair: 오늘 AI 몫이 남지 않음")
            return 0
        llm.max_requests = min(llm.max_requests, left)
    done = repair.repair(cur, cfg, llm, data_dir, today)
    usage = llm.log_report()
    from usage import record
    record(data_dir, today, usage.get("requests", 0), cfg, kind="retry")
    import quality
    left_over = repair.needs(cur, cfg)
    reason = "; ".join(filter(None, ["요약 실패: " + ", ".join(left_over["summary"]) if left_over["summary"] else "",
                                     "영향 분석 실패" if left_over["insight"] and not left_over["summary"] else ""]))
    q = quality.check(cur["sections"], cfg)
    m = cur.setdefault("meta", {})
    m.update({"degraded": bool(reason), "degraded_reason": reason, "retries": retries, "repaired": {"summary": done["summary"], "insight": done["insight"], "requests": done["requests"]},
              "quality": {"items": q["items"], "bad": q["bad"], "redone": [], "bad_ids": q["bad_ids"]}, "alerts": build_alerts(cur["sections"], cur.get("extras", {}), cfg)})
    if not (done["summary"] or done["insight"]):
        log.warning("repair: 고친 것이 없음 (AI 가 여전히 실패) — 다음 시도에서 다시")
        from status import write_status
        write_status(data_dir, cur)
        (data_dir / f"{today}.json").write_text(json.dumps(finite(cur), ensure_ascii=False, indent=1, allow_nan=False), encoding="utf-8")
        (data_dir / "latest.json").write_text(json.dumps(finite(cur), ensure_ascii=False, indent=1, allow_nan=False), encoding="utf-8")
        set_output("generated", "true")
        set_output("date", f"{today} (repair pending)")
        return 0
    cur["generated_at"] = datetime.now(timezone.utc).astimezone(tz(cfg)).isoformat(timespec="seconds")
    try:
        from incidents import update_incidents
        update_incidents(cur["sections"], cfg, data_dir, today, None)
    except Exception as e:  # noqa: BLE001
        log.warning("incidents failed: %s", e)
    body = json.dumps(finite(cur), ensure_ascii=False, indent=1, allow_nan=False)
    (data_dir / f"{today}.json").write_text(body, encoding="utf-8")
    (data_dir / "latest.json").write_text(body, encoding="utf-8")
    for mod, call in (("policy", lambda m: m.update_policy_news(data_dir, local_now.date(), cur)), ("weekly", lambda m: m.write_weekly(data_dir, local_now.date())),
                      ("status", lambda m: m.write_status(data_dir, cur))):
        try:
            call(__import__(mod))
        except Exception as e:  # noqa: BLE001
            log.warning("%s failed: %s", mod, e)
    set_output("generated", "true")
    set_output("date", f"{today} (repaired)")
    log.info("repaired %s: %s", today, reason or "모두 복구")
    if not reason:  # 처음 알림은 원문 상태로 나갔으니, 복구되면 한 번 다시 알린다
        from notify import notify
        notify(cur, cfg)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(ROOT / "config.yaml"))
    ap.add_argument("--force", action="store_true", help="시각 조건·중복 실행 검사 무시")
    ap.add_argument("--skip-existing", action="store_true", help="--force 여도 오늘 브리핑이 이미 있으면 AI 호출 없이 종료 (중복 실행 방지)")
    ap.add_argument("--dry-run", action="store_true", help="out/dry-run 에만 저장, 알림·정리 안 함")
    ap.add_argument("--no-llm", action="store_true", help="AI 호출 없이 휴리스틱으로 실행")
    ap.add_argument("--fixtures", type=Path, help="피드를 이 폴더의 <feed_id>.xml 에서 읽음 (오프라인 테스트)")
    ap.add_argument("--no-extras", action="store_true", help="환율·날씨 조회 생략")
    ap.add_argument("--now", help="현재 시각 대체 (ISO 8601, 테스트용)")
    ap.add_argument("--update-processing", action="store_true",
                    help="AI·뉴스 수집 없이 최신 브리핑의 비자 처리 기간 전광판만 갱신")
    ap.add_argument("--ignore-cap", action="store_true", help="AI 공용 예산(budget.py) 무시")
    ap.add_argument("--retry-degraded", action="store_true",
                    help="오늘 브리핑이 AI 실패(요약·선별)로 원문·휴리스틱으로 나갔을 때만 다시 생성 (하루 최대 2번, 자동 재시도 예약 실행용)")
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

    if args.update_processing:
        return update_processing_only(cfg, data_dir)

    retries = 0
    if args.retry_degraded:
        try:
            cur = json.loads((data_dir / f"{local_now.date().isoformat()}.json").read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            log.info("skip: no brief for %s yet (--retry-degraded)", local_now.date())
            return 0
        m = cur.get("meta") or {}
        retries = int(m.get("retries", 0))
        if not m.get("degraded"):
            log.info("skip: today's brief is fine (--retry-degraded)")
            return 0
        if retries >= MAX_RETRIES:
            log.warning("skip: already retried %d times today (--retry-degraded)", retries)
            return 0
        log.info("retrying degraded brief (%s), attempt %d", m.get("degraded_reason", ""), retries + 1)
        retries += 1
        args.force = True

    # 실패한 단계만 다시: 선별은 멀쩡하고 요약·영향 분석만 실패했으면 처음부터 다시 만들지 않는다 (AI 1~3회)
    if args.retry_degraded and not args.dry_run:
        rc = repair_only(cfg, data_dir, cur, local_now, retries, args)
        if rc is not None:
            return rc

    if args.skip_existing and not args.dry_run and (data_dir / f"{local_now.date().isoformat()}.json").exists():
        log.info("skip: brief for %s already exists (--skip-existing)", local_now.date())
        return 0

    if not (args.force or args.dry_run):
        ok, why = should_run(cfg, local_now, data_dir)
        if not ok:
            log.info("skip: %s", why)
            return 0

    # AI 공용 예산(My Hub budget.json): 내 보장량 + 공유 예비분 중 오늘 남은 몫. 하루 = 오클랜드 00시 리셋(local_now 가 오클랜드 시간).
    # 오늘 브리핑이 이미 있는데 재실행(--force)하면서 몫이 모자라면 건너뛴다 (아침 첫 생성은 보장량이 있어 항상 진행)
    today = local_now.date().isoformat()
    ai_left = None
    if not (args.dry_run or args.no_llm or args.ignore_cap):
        from budget import allowance, describe
        from usage import used_today
        lc = cfg.get("llm", {})
        ai_left, binfo = allowance("daily-brief", used_today(data_dir, today), int(lc.get("guaranteed", 7)), today)
        log.info("%s", describe("daily-brief", ai_left, binfo))
        if ai_left < int(lc.get("expected_per_run", 6)) and (data_dir / f"{today}.json").exists() and not args.retry_degraded:
            log.warning("skip: AI 예산 부족 — 오늘 남은 %d회, 이미 오늘 브리핑이 있음 (--ignore-cap 으로 무시)", ai_left)
            return 0

    # 1) 수집
    from fetch import fetch_all
    articles, failures, feed_stats = fetch_all(cfg, now_utc, args.fixtures)
    log.info("fetched %d articles from %d feeds (%d failed)", len(articles), len(feed_stats), len(failures))

    # 2) 중복 제거
    from dedupe import dedupe
    articles = dedupe(articles, cfg["dedupe"]["title_similarity"])
    log.info("after dedupe: %d stories", len(articles))

    # 3) 선별 / 4) 요약 — AI 요청은 보통 6회(지역별 선별 1 + NZ 이슈 묶기 1 + 지역별 요약 1 + 인사이트 1)
    llm = None
    if not args.no_llm:
        from llm import LLMError, make_llm
        try:
            llm = make_llm(cfg)
        except LLMError as e:
            log.error("%s", e)
            return 1
        if ai_left is not None:  # 오늘 남은 몫을 넘지 않게 (핵심 선별·요약이 앞에 있어 모자라면 뒤의 인사이트가 먼저 빠짐)
            llm.max_requests = min(llm.max_requests, max(ai_left, 0))

    from rank import select
    chosen = select(articles, cfg, llm, now_utc)

    from summarize import attach_excerpts, summarize_all
    if llm is not None and args.fixtures is None:
        attach_excerpts(chosen, cfg)
    sections = summarize_all(chosen, cfg, llm)
    # 품질 점검: 응답은 왔지만 한국어가 아니거나 요약이 빈약한 지역은 한 번만 다시 요약한다 (하루 1회 상한은 실행당 1회로 지킨다)
    import quality as _quality
    qrep = _quality.check(sections, cfg)
    qrep["redone"] = []
    if llm is not None and qrep["redo"]:
        from summarize import summarize_region
        for region in qrep["redo"][:1]:
            keys = [k for k in sections if cfg["sections"][k]["region"] == region and not sections[k].get("error")]
            try:
                again = summarize_region(region, keys, chosen, cfg, llm)
            except Exception as e:  # noqa: BLE001
                log.warning("quality redo failed for %s: %s", region, e)
                continue
            trial = {**sections, **{k: v for k, v in again.items() if not v.get("error")}}
            after = _quality.check(trial, cfg)
            if after["by_region"].get(region, {}).get("bad", 99) < qrep["by_region"][region]["bad"]:
                sections = trial
                qrep["redone"].append(region)
                log.info("quality: %s re-summarized (%d → %d below standard)", region, qrep["by_region"][region]["bad"], after["by_region"][region]["bad"])
        final = _quality.check(sections, cfg)
        qrep.update({k: final[k] for k in ("bad", "by_region", "bad_ids")})
    # 인사이트: 나에게 미치는 영향·할 일 + 이 이슈의 흐름(지난 30일) (AI 요청 2~3회, 실패해도 계속)
    from insight import attach_insights
    attach_insights(sections, chosen, cfg, llm, data_dir, local_now.date().isoformat())
    # 치안 지도: 오클랜드 사건 위치·등급 누적 (처음 한 번만 지난 기사 채우기 AI 요청 1회)
    if not args.dry_run and args.fixtures is None:
        try:
            from incidents import update_incidents

            update_incidents(sections, cfg, data_dir, local_now.date().isoformat(), llm)
        except Exception as e:  # noqa: BLE001
            log.warning("incidents failed: %s", e)
    carry_over(sections, cfg, data_dir, local_now.date().isoformat())

    extras = {"nzd_krw": None, "auckland_weather": None}
    if not args.no_extras and args.fixtures is None:
        from extras import fetch_extras
        from processing import fetch_processing_times, load_previous
        extras = fetch_extras(cfg)
        # 이민 레이더 전광판: 비자별 처리 기간 (정규식으로 못 찾으면 AI 요청 1회)
        try:
            from processing import update_history

            pt = fetch_processing_times(cfg, llm, load_previous(data_dir))
            extras["processing_times"] = update_history(pt, out_dir, local_now.date().isoformat())
        except Exception as e:  # noqa: BLE001 — 전광판 실패가 브리핑 생성을 막지 않게
            log.warning("processing times failed: %s", e)
        # 동네 비교: 시세 렌트·평균 집값 (주 1회 갱신, 별도 파일 areas.json)
        if not args.dry_run:
            try:
                from areas import update_areas

                update_areas(cfg, out_dir, local_now.date())
            except Exception as e:  # noqa: BLE001
                log.warning("areas failed: %s", e)
        # 경찰 공식 통계 (data/police/ 에 올린 CSV 가 있을 때만)
        if not args.dry_run:
            try:
                from crime_stats import update_crime_stats

                update_crime_stats(out_dir)
            except Exception as e:  # noqa: BLE001
                log.warning("crime stats failed: %s", e)
        # 한인 GP 지도: hanin.nz 목록 + 좌표 (좌표는 캐시, 새 주소만 조회)
        if not args.dry_run:
            try:
                from korean_gp import update_korean_gp

                update_korean_gp(cfg, out_dir)
            except Exception as e:  # noqa: BLE001
                log.warning("korean gp failed: %s", e)
        # 오클랜드 정착 비용판: 렌트 중간값·유가 (정부 공개 CSV, AI 요청 없음)
        try:
            from costs import fetch_costs

            extras["living_costs"] = fetch_costs(cfg)
        except Exception as e:  # noqa: BLE001
            log.warning("living costs failed: %s", e)

    # AI 가 있었는데 요약·선별이 실패해 원문·휴리스틱으로 나간 섹션이 있으면 '품질 저하' 표시 → 화면 안내 + 같은 날 자동 재시도
    import rank as _rank
    failed_secs = [k for k, sec in sections.items() if sec.get("error")]
    import repair as _repair
    insight_missing = llm is not None and _repair.needs({"sections": sections, "meta": {}}, cfg)["insight"]
    degraded_reason = "; ".join(filter(None, ["요약 실패: " + ", ".join(failed_secs) if failed_secs else "", "선별 실패" if _rank.FAILED else "",
                                              "영향 분석 실패" if insight_missing and not failed_secs else ""]))
    degraded = llm is not None and bool(degraded_reason)
    usage = llm.log_report() if llm else {"provider": None, "requests": 0, "models": {}, "total_cost_usd": 0}
    if llm is not None and not args.dry_run:
        from usage import record
        from usage import run_kind
        record(data_dir, local_now.date().isoformat(), usage.get("requests", 0), cfg, kind="retry" if args.retry_degraded else run_kind())
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
            "alerts": build_alerts(sections, extras, cfg),
            "degraded": degraded,
            "degraded_reason": degraded_reason,
            "retries": retries,
            "quality": {k: qrep[k] for k in ("items", "bad", "redone", "bad_ids")},
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

    # 이민 정책 추적: 정당·정부 이민 기사 누적 (AI 없음, 실패해도 브리핑에 영향 없음)
    try:
        from policy import update_policy_news

        update_policy_news(out_dir, local_now.date(), brief)
    except Exception as e:  # noqa: BLE001
        log.warning("policy news failed: %s", e)

    try:
        from weekly import write_weekly

        write_weekly(out_dir, local_now.date())
    except Exception as e:  # noqa: BLE001
        log.warning("weekly failed: %s", e)
    try:
        from status import write_status

        write_status(out_dir, brief)
    except Exception as e:  # noqa: BLE001
        log.warning("status failed: %s", e)

    set_output("generated", "true")
    set_output("date", brief["date"])
    from notify import notify
    notify(brief, cfg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
