"""경찰 공식 통계: 저장소 data/police/ 에 올린 policedata.nz CSV 를 동네별 12개월 범죄 피해 건수로 요약한다.

policedata.nz(Victimisations — Time and Place)는 자동 수집을 막아 두어서, 분기마다 한 번 직접 내려받아 올린다.
  1) policedata.nz → Victimisations (time and place) → 지역을 Auckland 로 거르고 → Download → Data(CSV)
  2) GitHub 저장소 data/police/ 폴더에 파일 업로드 (Add file → Upload files)
  3) 다음 아침 실행(또는 Actions 의 Daily Brief → processing_only)이 web/public/data/crime-stats.json 을 만든다.

열 이름은 내보내기 방식마다 조금씩 달라서 이름으로 추정한다(동네/월/범죄 종류/건수, 있으면 지역(TA)).
UTF-8·UTF-16, 쉼표·탭 구분을 모두 읽는다.
"""
from __future__ import annotations

import csv
import io
import json
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from common import ROOT, log

POLICE_DIR = ROOT / "data" / "police"
STATS_FILE = "crime-stats.json"

# 경찰 통계의 범죄 대분류(ANZSOC Division) → 한국어
TYPE_KO = {
    "theft": "절도", "burglary": "침입 절도", "unlawful entry": "침입 절도", "acts intended to cause injury": "폭행·상해",
    "assault": "폭행·상해", "robbery": "강도", "extortion": "강도·갈취", "sexual": "성범죄", "abduction": "납치·괴롭힘",
    "homicide": "살인", "property damage": "기물 파손", "fraud": "사기", "drug": "마약", "weapons": "무기",
}


def type_ko(name: str) -> str:
    n = name.lower()
    for k, v in TYPE_KO.items():
        if k in n:
            return v
    return name.strip()[:20] or "기타"


def _read(path: Path) -> list[dict]:
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        return []
    sample = text[:4000]
    delim = "\t" if sample.count("\t") > sample.count(",") else ","
    return list(csv.DictReader(io.StringIO(text), delimiter=delim))


def _col(cols: list[str], *names: str, exclude: tuple[str, ...] = ()) -> str | None:
    for want in names:
        for c in cols:
            lc = c.lower().strip()
            if want in lc and not any(x in lc for x in exclude):
                return c
    return None


def _month(s: str) -> str | None:
    s = s.strip()
    for fmt in ("%b-%Y", "%B %Y", "%b %Y", "%Y-%m", "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%Y%m", "%b-%y", "%B-%Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m")
        except ValueError:
            continue
    m = re.search(r"(20\d\d)[-/ ]?(\d{1,2})", s)
    return f"{m.group(1)}-{int(m.group(2)):02d}" if m else None


def _num(s: str) -> float:
    try:
        return float(str(s).replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def summarize(rows: list[dict], region: str = "Auckland") -> dict | None:
    if not rows:
        return None
    cols = list(rows[0].keys())
    area = _col(cols, "area unit", "sa2", "suburb", "meshblock", "area", exclude=("territorial", "region", "district"))
    ta = _col(cols, "territorial", "district", "region")
    month = _col(cols, "year month", "month year", "month", "date", "year")
    kind = _col(cols, "anzsoc division", "division", "offence", "crime", "anzsoc")
    count = _col(cols, "victimisation", "count", "number", "value", "sum")
    if not (area and month and count):
        log.warning("crime stats: unknown columns %s", cols)
        return None
    agg: dict[str, dict[str, dict[str, float]]] = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    months = set()
    for r in rows:
        if ta and region and region.lower() not in (r.get(ta) or "").lower():
            continue
        m = _month(r.get(month, ""))
        name = (r.get(area) or "").strip()
        if not m or not name or name.lower() in ("total", "grand total", "all"):
            continue
        months.add(m)
        agg[name][m][type_ko(r.get(kind, "")) if kind else "전체"] += _num(r.get(count, ""))
    if not months:
        return None
    ordered = sorted(months)
    last12, prev12 = ordered[-12:], ordered[-24:-12]
    areas = {}
    for name, by_month in agg.items():
        by_type: dict[str, float] = defaultdict(float)
        for m in last12:
            for t, v in by_month.get(m, {}).items():
                by_type[t] += v
        total = sum(by_type.values())
        prev = sum(sum(by_month.get(m, {}).values()) for m in prev12) if len(prev12) == 12 else None
        if total or prev:
            areas[name] = {"total": int(total), "prev_total": int(prev) if prev is not None else None,
                           "by_type": {t: int(v) for t, v in sorted(by_type.items(), key=lambda x: -x[1]) if v},
                           "monthly": [int(sum(by_month.get(m, {}).values())) for m in last12]}
    return {"period": f"{last12[0]}~{last12[-1]}", "months": last12, "areas": areas}


def update_crime_stats(data_dir: Path, police_dir: Path = POLICE_DIR) -> bool:
    files = sorted(p for p in police_dir.glob("*") if p.suffix.lower() in (".csv", ".txt", ".tsv")) if police_dir.exists() else []
    if not files:
        return False
    rows = [r for f in files for r in _read(f)]
    out = summarize(rows)
    if not out:
        return False
    out["files"] = [f.name for f in files]
    out["source"] = "https://www.police.govt.nz/about-us/publications-statistics/data-and-statistics/policedatanz"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / STATS_FILE).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    log.info("crime stats: %d areas, %s", len(out["areas"]), out["period"])
    return True
