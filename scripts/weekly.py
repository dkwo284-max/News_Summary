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
            "alerts": alerts[-8:], "processing": proc, "topics": topic_heat(data_dir, today), "fx": {"first": fx[0][1], "last": fx[-1][1]} if len(fx) >= 2 else None}


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
