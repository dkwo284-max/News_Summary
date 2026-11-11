"""최근 7일 정리(weekly.json): 매일 브리핑 뒤에 규칙으로 만든다 (AI 요청 0회).

주 단위로 따라잡기 위한 요약: 나라·지역별 이번 주 중요 기사, 여러 날 이어진 이슈, 이민 알림, 비자 처리 기간 변화, 환율 변화.
"""
from __future__ import annotations

import json
import re
from datetime import date, timedelta
from pathlib import Path

GROUPS = [("akl", "오클랜드", ("akl_", "nz_auckland")), ("nz", "뉴질랜드", ("nz_society", "nz_education", "nz_economy", "nz_politics", "nz_national")),
          ("imm", "이민 레이더", ("nz_immigration",)), ("kr", "한국", ("kr_society", "kr_economy", "kr_entertainment"))]  # 한국 정치는 제외(앱에서 켠 사람만 봄)
PER_GROUP = 5
KO_STOP = {"오클", "뉴질", "한국", "정부", "올해", "최근", "발생"}  # 어느 기사에나 나와 다른 이슈를 한데 묶어 버리는 말
GENERIC = {"사회", "경제", "정치"}  # 거의 모든 기사에 붙어 흐름을 보여 주지 못하는 태그
STOP = set("the a an of in on for to and or after as at by with from new zealand nz auckland says say said over into about more its his her their is are be will has have had".split())


def _keys(*titles: str) -> set[str]:
    t = " ".join(x for x in titles if x).lower()
    return {w[:5] for w in re.findall(r"[a-z]{4,}", t) if w not in STOP} | ({w[:2] for w in re.findall(r"[가-힣]{2,}", t)} - KO_STOP)


def _days(s: str) -> int | None:
    m = re.search(r"([\d.]+)\s*(일|주|개월|년)", s or "")
    if not m:
        return None
    return round(float(m.group(1)) * {"일": 1, "주": 7, "개월": 30.4, "년": 365}[m.group(2)])


def build_weekly(data_dir: Path, today: date, span: int = 7) -> dict | None:
    briefs = []
    for i in range(span):
        d = (today - timedelta(days=i)).isoformat()
        try:
            briefs.append(json.loads((data_dir / f"{d}.json").read_text(encoding="utf-8")))
        except Exception:  # noqa: BLE001
            continue
    if not briefs:
        return None
    briefs.sort(key=lambda b: b["date"])
    groups = []
    for gid, label, prefixes in GROUPS:
        seen: list[tuple[set[str], dict]] = []
        for b in briefs:
            for key, sec in b["sections"].items():
                if not key.startswith(prefixes):
                    continue
                for it in sec["items"]:
                    if it.get("carried_from"):
                        continue
                    k = _keys(it.get("title_ko", ""), it.get("original_title", ""))
                    src = (it.get("sources") or [{}])[0]
                    row = {"title_ko": it["title_ko"], "url": src.get("url", ""), "source": src.get("name", ""), "date": b["date"], "section": sec["label"],
                           "importance": it.get("importance", 0), "impact": (it.get("impact") or {}).get("level", ""), "days": 1,
                           "steps": [{"date": b["date"], "title_ko": it["title_ko"], "url": src.get("url", "")}]}
                    for ks, ex in seen:
                        if len(ks & k) >= 3:  # 같은 이슈(제목 핵심어 3개 이상 겹침) → 하나로 묶고 며칠 나왔는지 센다
                            if ex["steps"][-1]["date"] == row["date"]:
                                break  # 같은 날 같은 이슈가 두 섹션에 나온 것 — 하루로 센다
                            ex["days"] += 1
                            ex["steps"] += row["steps"]
                            if row["importance"] > ex["importance"]:
                                ex.update({kk: row[kk] for kk in ("title_ko", "url", "source", "importance", "impact")})
                            break
                    else:
                        seen.append((k, row))
        rows = sorted((r for _, r in seen), key=lambda r: (-(r["impact"] == "high"), -r["importance"], -r["days"]))
        groups.append({"id": gid, "label": label, "items": rows[:PER_GROUP]})
    threads = sorted((g for grp in groups for g in grp["items"] if g["days"] >= 2), key=lambda r: -r["days"])[:5]
    for grp in groups:  # 날짜별 흐름(steps)은 여러 날 이어진 이슈에만 남긴다
        for g in grp["items"]:
            if g["days"] < 2:
                g.pop("steps", None)
    alerts = [{"date": b["date"], **{k: a.get(k, "") for k in ("kind", "text", "url")}} for b in briefs for a in (b.get("meta") or {}).get("alerts", [])]
    proc = []
    try:
        hist = json.loads((data_dir / "processing-history.json").read_text(encoding="utf-8"))
        first, last = briefs[0]["date"], briefs[-1]["date"]
        names = {i["key"]: i["name"] for i in ((briefs[-1].get("extras") or {}).get("processing_times") or {}).get("items", [])}
        for key, rows in hist.items():
            rows = [r for r in rows if first <= r["date"] <= last]
            if len(rows) >= 2:
                a, z = _days(rows[0].get("p90") or rows[0].get("p50")), _days(rows[-1].get("p90") or rows[-1].get("p50"))
                if a is not None and z is not None and a != z:
                    proc.append({"key": key, "name": names.get(key, key), "from": rows[0].get("p90") or rows[0].get("p50"), "to": rows[-1].get("p90") or rows[-1].get("p50"), "delta_days": z - a})
    except Exception:  # noqa: BLE001
        pass
    fx = [(b["date"], (b.get("extras") or {}).get("nzd_krw")) for b in briefs if (b.get("extras") or {}).get("nzd_krw")]
    return {"updated": today.isoformat(), "from": briefs[0]["date"], "to": briefs[-1]["date"], "days": len(briefs), "groups": groups, "threads": threads,
            "alerts": alerts[-8:], "processing": proc, "topics": topic_heat(data_dir, today), "monthly": build_monthly(data_dir, today), "fx": {"first": fx[0][1], "last": fx[-1][1]} if len(fx) >= 2 else None}


def build_monthly(data_dir: Path, today: date, span: int = 30) -> dict | None:
    """한 달 변화 — 이 가족(유학→취업비자→영주권 준비, 오클랜드 렌트) 기준으로 좋아졌나 나빠졌나. 규칙으로만 만든다 (AI 0회).
    verdict: good(유리해짐) / bad(불리해짐) / flat(변동 없음) / info(방향을 말하기 어려움)."""
    briefs = []
    for i in range(span, -1, -1):
        try:
            briefs.append(json.loads((data_dir / f"{(today - timedelta(days=i)).isoformat()}.json").read_text(encoding="utf-8")))
        except Exception:  # noqa: BLE001
            continue
    if len(briefs) < 7:
        return None
    first, last = briefs[0], briefs[-1]
    ex = lambda b: b.get("extras") or {}  # noqa: E731
    rows: list[dict] = []
    def ends(get):  # 기간 안에서 값이 있는 가장 이른 날과 가장 늦은 날 (수집이 늦게 시작된 항목 대응)
        vals = [v for v in (get(ex(b)) for b in briefs) if v is not None]
        return (vals[0], vals[-1]) if len(vals) >= 2 else (None, None)
    def add(key, label, frm, to, verdict, note=""):
        rows.append({"key": key, "label": label, "from": frm, "to": to, "verdict": verdict, "note": note})
    # 비자 처리 기간: 짧아지면 유리
    try:
        hist = json.loads((data_dir / "processing-history.json").read_text(encoding="utf-8"))
        names = {i["key"]: i["name"] for i in (ex(last).get("processing_times") or {}).get("items", [])}
        for key, hs in hist.items():
            hs = [r for r in hs if first["date"] <= r["date"] <= last["date"]]
            if len(hs) < 2 or key not in names:
                continue
            a, z = hs[0].get("p90") or hs[0].get("p50"), hs[-1].get("p90") or hs[-1].get("p50")
            da, dz = _days(a), _days(z)
            if da is None or dz is None or da == dz:
                continue
            add(f"proc:{key}", f"🛂 {re.sub(r'\s*\(.*\)', '', names[key])} 처리 기간", a, z, "good" if dz < da else "bad", f"{abs(dz - da)}일 {'단축' if dz < da else '지연'}")
    except Exception:  # noqa: BLE001
        pass
    # 환율: 원화를 뉴질랜드달러로 바꿔 쓰는 가족 → 내려가면 유리
    fa, fz = ends(lambda e: e.get("nzd_krw"))
    if fa and fz:
        d = fz - fa
        add("fx", "💱 NZD/KRW 환율", f"{fa:,.1f}원", f"{fz:,.1f}원", "flat" if abs(d) < fa * 0.005 else "good" if d < 0 else "bad",
            f"1만 달러 환전 시 {abs(d) * 10000:,.0f}원 {'덜' if d < 0 else '더'} 듦" if abs(d) >= fa * 0.005 else "0.5% 안쪽 변동")
    # 렌트·유가: 내려가면 유리
    ra, rz = ends(lambda e: (e.get("living_costs") or {}).get("rent") or None)
    ra, rz = ra or {}, rz or {}
    if rz.get("median"):
        if ra.get("median") and ra.get("month") != rz.get("month"):
            d = rz["median"] - ra["median"]
            add("rent", "🏠 오클랜드 중위 렌트", f"주 ${ra['median']:.0f} ({ra['month']})", f"주 ${rz['median']:.0f} ({rz['month']})", "flat" if d == 0 else "good" if d < 0 else "bad",
                f"한 달 약 ${abs(d) * 52 / 12:,.0f} {'감소' if d < 0 else '증가'}" if d else "")
        else:
            y = rz.get("yoy_pct")
            add("rent", "🏠 오클랜드 중위 렌트", "", f"주 ${rz['median']:.0f} ({rz.get('month', '')})", "flat" if not y else "good" if y < 0 else "bad",
                f"이번 달 새 통계 없음 · 1년 전보다 {y:+.1f}%" if y is not None else "이번 달 새 통계 없음")
    pa, pz = ends(lambda e: (((e.get("living_costs") or {}).get("fuel") or {}).get("petrol91") or {}).get("nzd_per_l"))
    if pa and pz:
        c = round((pz - pa) * 100)
        add("fuel", "⛽ 휘발유 91", f"${pa:.2f}/L", f"${pz:.2f}/L", "flat" if abs(c) < 2 else "good" if c < 0 else "bad", f"50L 주유 시 ${abs(c) * 0.5:.1f} {'절약' if c < 0 else '추가'}" if abs(c) >= 2 else "")
    # 기준금리: 방향만 (렌트·환율에 간접 영향이라 좋고 나쁨을 단정하지 않는다)
    na, nz = ends(lambda e: (((e.get("policy_rates") or {}).get("rates") or {}).get("NZ") or {}).get("value"))
    if na is not None and nz is not None:
        add("ocr", "🏦 NZ 기준금리", f"{na}%", f"{nz}%", "flat" if na == nz else "info", "" if na == nz else "인하는 대출·렌트 부담 완화 쪽, 환율에는 약세 요인")
    # 이민 정책: 영향 높은 소식과 알림 건수
    seen, high = set(), []
    for b in briefs:
        for it in (b["sections"].get("nz_immigration") or {}).get("items", []):
            if it.get("id") in seen or it.get("carried_from") or (it.get("impact") or {}).get("level") != "high":
                continue
            seen.add(it.get("id"))
            high.append({"date": b["date"], "title_ko": it["title_ko"], "url": ((it.get("sources") or [{}])[0]).get("url", ""), "reason": (it.get("impact") or {}).get("reason", "")})
    n_alert = sum(len((b.get("meta") or {}).get("alerts", [])) for b in briefs)
    # 치안: 1급 사건 보도 건수 (이번 30일 vs 이전 30일)
    crime = None
    try:
        inc = json.loads((data_dir / "incidents.json").read_text(encoding="utf-8"))["incidents"]
        cut, cut2 = (today - timedelta(days=span)).isoformat(), (today - timedelta(days=span * 2)).isoformat()
        now_n = sum(1 for e in inc if e["severity"] == "1" and e["date"] > cut)
        prev = [e for e in inc if e["severity"] == "1" and cut2 < e["date"] <= cut]
        oldest = min((e["date"] for e in inc), default=today.isoformat())
        crime = {"now": now_n, "prev": len(prev) if oldest <= cut2 else None}
        add("crime", "🚓 오클랜드 1급 사건 보도", f"{len(prev)}건" if crime["prev"] is not None else "", f"{now_n}건",
            "info" if crime["prev"] is None else "flat" if now_n == len(prev) else "good" if now_n < len(prev) else "bad",
            "비교할 이전 30일 기록이 아직 부족해요" if crime["prev"] is None else "보도 건수 기준이라 실제 범죄 증감과 다를 수 있어요")
    except Exception:  # noqa: BLE001
        pass
    good, bad = sum(r["verdict"] == "good" for r in rows), sum(r["verdict"] == "bad" for r in rows)
    return {"from": first["date"], "to": last["date"], "days": len(briefs), "rows": rows, "good": good, "bad": bad,
            "immigration": {"high": high[-5:][::-1], "n_high": len(high), "n_alerts": n_alert}}


def topic_heat(data_dir: Path, today: date, span: int = 30, top: int = 8) -> dict:
    """최근 span 일 동안 날짜별로 어떤 주제(태그)가 얼마나 나왔는지: {dates: [...], rows: [{tag, counts: [...], total}]} (한국 정치 제외)."""
    dates, per = [], []
    for i in range(span - 1, -1, -1):
        d = (today - timedelta(days=i)).isoformat()
        try:
            b = json.loads((data_dir / f"{d}.json").read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        cnt: dict[str, int] = {}
        seen: set[str] = set()
        for key, sec in b["sections"].items():
            if key == "kr_politics":
                continue
            for it in sec["items"]:
                iid = it.get("id") or it.get("title_ko", "")
                if iid in seen or it.get("carried_from"):
                    continue
                seen.add(iid)
                for t in it.get("tags") or []:
                    if t in GENERIC:
                        continue
                    cnt[t] = cnt.get(t, 0) + 1
        dates.append(d)
        per.append(cnt)
    total: dict[str, int] = {}
    for c in per:
        for t, n in c.items():
            total[t] = total.get(t, 0) + n
    tags = sorted(total, key=lambda t: -total[t])[:top]
    return {"dates": dates, "rows": [{"tag": t, "counts": [c.get(t, 0) for c in per], "total": total[t]} for t in tags]}


def write_weekly(data_dir: Path, today: date) -> None:
    w = build_weekly(data_dir, today)
    if w:
        (data_dir / "weekly.json").write_text(json.dumps(w, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
