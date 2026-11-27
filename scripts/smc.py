"""숙련 이민(SMC) 공식 규정 감시: INZ 공식 페이지를 매일 읽어 핵심 수치·문장을 확인하고, 바뀐 문장을 기록한다. AI 없음.

- 대상: SMC 비자 페이지, SMC 임금 기준 페이지, SMC 경로 안내, 적색·황색 직종 목록 (모두 www.immigration.govt.nz)
- CHECKS: 화면에 한국어로 보여 주는 요건마다 근거가 되는 원문 문장이 오늘도 그대로 있는지 확인한다.
  문장이 사라지면 그 요건은 '원문 확인 필요'로 표시된다(규정이 바뀌었을 수 있음).
- 숫자(임금 기준·신청비·학위/연봉/NZ 경력 점수)는 원문 HTML 표와 문장에서 뽑는다.
- 각 페이지 본문 문장을 smc-pages.json 에 저장해 두고, 다음 날 달라진 문장(추가·삭제)을 changes 에 날짜와 함께 남긴다.
- 결과는 web/public/data/smc.json (화면용). 실패한 페이지는 어제 값을 그대로 두고 status 만 fail 로 바꾼다.

    python scripts/smc.py     # 받아서 요약만 출력 (파일은 쓰지 않음)
"""
from __future__ import annotations

import html as htmllib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import httpx

from common import load_config, log

SMC_FILE = "smc.json"
PAGES_FILE = "smc-pages.json"
BASE = "https://www.immigration.govt.nz"
SMC_DIR = "/live/resident-visas-to-live-in-new-zealand/skilled-residence-pathways-in-new-zealand/skilled-migrant-category-pathway-to-residence/"
PAGES = [
    {"key": "visa", "label": "SMC 거주비자 (요건·신청 방법)", "url": BASE + "/visas/skilled-migrant-category-resident-visa/"},
    {"key": "pay", "label": "SMC 임금 기준", "url": BASE + SMC_DIR + "pay-rates-for-the-skilled-migrant-category-resident-visa/"},
    {"key": "path", "label": "SMC 경로 안내", "url": BASE + SMC_DIR},
    {"key": "lists", "label": "적색·황색 직종 목록", "url": BASE + SMC_DIR + "red-and-amber-list-occupations/"},
]
LINKS = [
    {"label": "SMC 임금 기준 계산 도구", "url": BASE + SMC_DIR + "smc-wage-threshold-tool/"},
    {"label": "인증 고용주 목록", "url": BASE + "/work/requirements-for-work-visas/approved-employers/accredited-employer-list/"},
    {"label": "ANZSCO 숙련도 찾기", "url": BASE + "/work/requirements-for-work-visas/green-list-occupations-qualifications-and-skills/find-your-anzsco-skill-level/"},
    {"label": "거주비자 처리 기간", "url": BASE + "/process-to-apply/waiting-for-a-visa/processing-a-visa-application/how-long-it-takes-to-process-an-application/resident-visa-wait-times/"},
]

# 화면의 한국어 요건 ↔ 근거 원문 문장 (정규식, 대소문자·공백·따옴표 무시). group: 화면 묶음
CHECKS = [
    ("apply", "job_offer", "visa", "인증 고용주의 일자리 또는 잡오퍼가 있고 SMC 경로 1개를 충족하면 EOI(관심 표명)를 낼 수 있어요. 아직 출근 전이어도 잡오퍼로 됩니다.",
     r"submit an expression of interest \(EOI\) if you have a job or job offer from an accredited employer"),
    ("apply", "offshore", "visa", "한국 등 NZ 밖에서도 신청할 수 있어요. 해외에서 신청했다면 비자 발급일로부터 12개월 안에 NZ에 들어와야 해요.",
     r"must come to New Zealand within 12 months of the date your visa is issued, if you applied for your visa outside of New Zealand"),
    ("apply", "eoi", "visa", "EOI는 무료이고, 내면 바로 요건 충족 여부를 알려 줘요.",
     r"no fee to submit an EOI"),
    ("apply", "ita", "visa", "초청(ITA)을 받으면 4개월 안에 신청해야 해요. 넘기면 EOI부터 다시.",
     r"submit your visa application within 4 months of receiving your ITA"),
    ("apply", "interim", "visa", "NZ 안에서 기다리는 동안에는 유효한 비자가 있어야 하고, 새 임시비자를 신청하지 않았다면 SMC 임시비자(Interim)를 줄 수 있어요.",
     r"we may give you a Skilled Migrant Category Interim Visa"),
    ("apply", "age", "visa", "신청할 때 55세 이하.", r"be aged 55 or younger when you apply"),
    ("job", "full_time", "visa", "일자리는 주 30시간 이상(풀타임).", r"for at least 30 hours a week"),
    ("job", "duration", "visa", "정규직, 12개월 이상 계약직, 또는 계약(연속 계약 포함) 6개월 이상.",
     r"permanent or fixed-term for at least 12 months, or a contract or continuous contracts for at least 6 months"),
    ("job", "invited_rate", "pay", "학위로 6점(NZ 경력 불필요)이면 일자리 임금은 '초청받을 때'의 SMC 임금 기준만 넘으면 돼요(보통 EOI 제출일).",
     r"current job or job offer must meet the SMC wage threshold that is in place when you are invited to apply for residence"),
    ("job", "skill45", "pay", "ANZSCO 숙련도 4·5단계나 목록에 없는 직무는 기준의 1.5배.",
     r"1\.5 times the SMC wage threshold \(ANZSCO skill levels 4, 5 or unlisted jobs\)"),
    ("points", "pathways", "visa", "경로는 3개: 점수제(6점) · 숙련 경력 · 기술직.",
     r"Points-based pathway, Skilled Work Experience pathway or Trades and Technicians pathway"),
    ("points", "nz_masters", "visa", "NZ 석사는 NZ에서 30주 이상 풀타임으로 공부했고 학사가 있으면 6점, 아니면 5점.",
     r"claim 6 points for a New Zealand master's degree if you have completed at least 30 weeks of full-time study in New Zealand and have a bachelor's degree"),
    ("points", "swe", "visa", "숙련 경력 경로: 관련 경력 5년 이상(그중 NZ 숙련 경력 2년 이상).",
     r"at least 5 years of directly relevant work experience, including at least 2 years of skilled work experience in New Zealand"),
    ("points", "trades", "visa", "기술직 경로: 관련 자격 + 자격 취득 후 경력 4년 이상(그중 NZ 18개월 이상).",
     r"at least 4 years of post-qualification work experience, including at least 18 months of skilled work experience in New Zealand"),
    ("points", "red_list", "visa", "적색 목록 직종이나 숙련도 4·5단계 직무는 숙련 경력 경로를 쓸 수 없어요(점수제와는 별개).",
     r"Red List, or is an ANZSCO skill level 4 or 5 occupation, you are not eligible for this pathway"),
]

_BLOCK = re.compile(r"(?i)<br\s*/?>|</(?:p|li|h[1-6]|div|tr|section|caption|th|td|dt|dd)>")


def norm(s: str) -> str:
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace(" ", " ")
    return re.sub(r"\s+", " ", s).strip()


def main_html(raw: str) -> str:
    m = re.search(r"(?is)<main\b[^>]*>(.*?)</main>", raw)
    s = m.group(1) if m else raw
    # 용어 설명 팝업은 단어를 속성(button-text)에만 담는다 → 본문 단어로 되살림
    s = re.sub(r'(?is)<glossary-tooltip\b[^>]*?button-text="([^"]*)"[^>]*>', lambda g: " " + g.group(1) + " ", s)
    s = re.sub(r"(?is)</glossary-tooltip>", " ", s)
    return re.sub(r"(?is)<(script|style|noscript|svg|template)\b[^>]*>.*?</\1>", " ", s)


def text_lines(h: str) -> list[str]:
    s = _BLOCK.sub("\n", re.sub(r"\s+", " ", h))
    s = htmllib.unescape(re.sub(r"<[^>]+>", " ", s))
    out: list[str] = []
    for line in s.split("\n"):
        line = norm(line)
        if not line or "{{" in line or (out and out[-1] == line):
            continue
        out.append(line)
    return out


def cell_text(c: str) -> str:
    return norm(htmllib.unescape(re.sub(r"<[^>]+>", " ", c)))


def tables(h: str) -> list[dict]:
    out = []
    for t in re.findall(r"(?is)<table\b.*?</table>", h):
        cap = re.search(r"(?is)<caption[^>]*>(.*?)</caption>", t)
        rows = [[cell_text(c) for c in re.findall(r"(?is)<t[hd]\b[^>]*>(.*?)</t[hd]>", r)] for r in re.findall(r"(?is)<tr\b.*?</tr>", t)]
        out.append({"caption": cell_text(cap.group(1)) if cap else "", "rows": [r for r in rows if any(r)]})
    return out


def find_table(tbls: list[dict], *words: str) -> list[list[str]]:
    for t in tbls:
        if all(w.lower() in t["caption"].lower() for w in words):
            return t["rows"]
    return []


def money(s: str) -> float | None:
    m = re.search(r"\$\s*([\d,]+(?:\.\d+)?)", s or "")
    return float(m.group(1).replace(",", "")) if m else None


def iso_date(s: str) -> str:
    m = re.search(r"(\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})", s or "")
    if not m:
        return ""
    return datetime.strptime(" ".join(m.groups()), "%d %B %Y").date().isoformat()


def points_rows(rows: list[list[str]]) -> list[dict]:
    """[이름, 점수, (학사 필요)] 행 → [{q, pts, bachelor}] (머리글 행은 점수가 숫자가 아니라 빠짐)"""
    out = []
    for r in rows:
        if len(r) >= 2 and re.fullmatch(r"\d", r[1]):
            out.append({"q": r[0], "pts": int(r[1]), **({"bachelor": r[2]} if len(r) > 2 else {})})
    return out


def extract(pages: dict) -> dict:
    """페이지별 {'html','lines','flat','tables'} → 화면에 쓸 숫자들. 못 찾은 값은 넣지 않는다."""
    facts: dict = {}
    v, p = pages.get("visa"), pages.get("pay")
    if v:
        m = re.search(r"Cost From NZD \$ ?([\d,]+)", v["flat"])
        if m:
            facts["fee_from_nzd"] = int(m.group(1).replace(",", ""))
        m = re.search(r"be aged (\d+) or younger", v["flat"])
        if m:
            facts["age_max"] = int(m.group(1))
        for key, words in (("qual_nz", ("New Zealand qualifications",)), ("qual_intl", ("international qualifications",)),
                           ("income_pts", ("for income",)), ("work_pts", ("skilled work experience in New Zealand",))):
            rows = points_rows(find_table(v["tables"], *words))
            if rows:
                facts[key] = rows
    if p:
        t1 = find_table(p["tables"], "without skilled work experience")
        base = next((money(c) for r in t1 if "1 to 3" in r[0] for c in r[1:] if money(c)), None)
        x15 = next((money(c) for r in t1 if r[0].startswith("1.5 times") for c in r[1:] if money(c)), None)
        hist = []
        for r in find_table(p["tables"], "with skilled work experience"):
            vals = [money(c) for c in r[1:]]
            if len(r) >= 4 and all(vals[:3]):
                frm = iso_date(r[0].split(" to ")[0]) if " to " in r[0] else iso_date(r[0])
                hist.append({"period": r[0], "from": frm, "base": vals[0], "x15": vals[1], "x2": vals[2]})
        if base:
            facts["threshold"] = {"base": base, "x15": x15 or round(base * 1.5, 2), "x2": round(base * 2, 2), "x3": round(base * 3, 2),
                                  "from": hist[0]["from"] if hist and abs(hist[0]["base"] - base) < 0.005 else "",
                                  "annual_40h": round(base * 40 * 52)}
        if hist:
            facts["threshold_history"] = hist
    if v and facts.get("threshold"):   # 비자 페이지의 '3배 = 현재 $105.00' 문장과 교차 확인
        m = re.search(r"3 times the SMC wage threshold \(currently NZD \$([\d.]+) an hour\)", v["flat"])
        if m:
            facts["threshold"]["cross_check"] = abs(float(m.group(1)) - facts["threshold"]["x3"]) < 0.01
    return facts


def run_checks(pages: dict) -> list[dict]:
    out = []
    for group, cid, page, ko, pat in CHECKS:
        pg = pages.get(page)
        m = re.search(pat, pg["flat"], re.I) if pg else None
        row = {"group": group, "id": cid, "page": page, "ko": ko, "ok": bool(m) if pg else None}
        if m:
            row["quote"] = quote_of(pg["lines"], pat) or m.group(0)
        out.append(row)
    return out


def quote_of(lines: list[str], pat: str) -> str:
    """근거 문장이 든 원문 한 줄(문단·목록 항목·표 칸). 짧은 목록 항목이면 앞 줄을 붙여 뜻이 통하게."""
    for i, line in enumerate(lines):
        if re.search(pat, line, re.I):
            parts = [line]
            j = i - 1
            while j >= 0 and sum(map(len, parts)) < 70 and len(parts) < 4:
                parts.insert(0, lines[j])
                j -= 1
            return " … ".join(parts)[:360]
    return ""


def diff_lines(old: list[str], new: list[str], cap: int = 12) -> tuple[list[str], list[str]]:
    o, n = set(old), set(new)
    return [x for x in new if x not in o][:cap], [x for x in old if x not in n][:cap]


def fetch_pages(cfg: dict, client: httpx.Client | None = None) -> dict:
    own = client is None
    client = client or httpx.Client(timeout=cfg["fetch"]["timeout_seconds"], follow_redirects=True,
                                    headers={"User-Agent": cfg["fetch"]["user_agent"]})
    pages: dict = {}
    try:
        for pg in PAGES:
            try:
                r = client.get(pg["url"])
                if r.status_code != 200 or len(r.text) < 2000:
                    raise ValueError(f"HTTP {r.status_code}")
                h = main_html(r.text)
                lines = text_lines(h)
                pages[pg["key"]] = {"html": h, "lines": lines, "flat": norm(" ".join(lines)), "tables": tables(h), "final": str(r.url)}
            except Exception as e:  # noqa: BLE001
                log.warning("smc page %s failed: %s", pg["key"], e)
    finally:
        if own:
            client.close()
    return pages


def build(pages: dict, prev: dict | None, prev_lines: dict, today: str, now: str) -> tuple[dict, dict]:
    """오늘 받은 페이지 + 어제 결과 → (smc.json, smc-pages.json)"""
    prev = prev or {}
    facts = {**prev.get("facts", {}), **extract(pages)}
    checks = run_checks(pages)
    for c in checks:   # 페이지를 못 받은 날은 어제 판정을 유지
        if c["ok"] is None:
            old = next((x for x in prev.get("checks", []) if x["id"] == c["id"]), None)
            if old:
                c.update(ok=old.get("ok"), quote=old.get("quote", ""), stale=True)
    changes = list(prev.get("changes", []))
    new_lines = dict(prev_lines)
    meta = {}
    for pg in PAGES:
        k, got = pg["key"], pages.get(pg["key"])
        old_meta = prev.get("pages", {}).get(k, {})
        if not got:
            meta[k] = {**{x: pg[x] for x in ("label", "url")}, "status": "fail", "checked": now, "ok_at": old_meta.get("ok_at", "")}
            continue
        meta[k] = {**{x: pg[x] for x in ("label", "url")}, "status": "ok", "checked": now, "ok_at": now, "lines": len(got["lines"])}
        if k in prev_lines and prev_lines[k]:
            added, removed = diff_lines(prev_lines[k], got["lines"])
            if added or removed:
                changes.insert(0, {"date": today, "page": k, "label": pg["label"], "url": pg["url"], "added": added, "removed": removed})
        new_lines[k] = got["lines"]
    out = {
        "checked_at": now, "checked_date": today,
        "ok": all(m["status"] == "ok" for m in meta.values()),
        "pages": meta, "links": LINKS, "facts": facts, "checks": checks,
        "changes": changes[:40],
        "changed_today": [c for c in changes if c["date"] == today],
        "baseline": not prev_lines,
    }
    return out, new_lines


def update_smc(cfg: dict, data_dir: Path, today: str, client: httpx.Client | None = None) -> dict | None:
    """smc.json·smc-pages.json 을 갱신하고, 브리핑 알림용 요약을 돌려준다."""
    f, fp = data_dir / SMC_FILE, data_dir / PAGES_FILE
    prev = json.loads(f.read_text(encoding="utf-8")) if f.exists() else None
    prev_lines = json.loads(fp.read_text(encoding="utf-8")) if fp.exists() else {}
    pages = fetch_pages(cfg, client)
    if not pages and prev is None:
        log.warning("smc: no page fetched and no previous data")
        return None
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out, lines = build(pages, prev, prev_lines, today, now)
    f.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    fp.write_text(json.dumps(lines, ensure_ascii=False, indent=0), encoding="utf-8")
    log.info("smc: %d page(s) ok, %d change(s) today, %d check(s) missing", sum(1 for m in out["pages"].values() if m["status"] == "ok"),
             len(out["changed_today"]), sum(1 for c in out["checks"] if c["ok"] is False))
    return summary(out)


def summary(out: dict) -> dict:
    return {"checked_date": out["checked_date"], "ok": out["ok"],
            "changed": [{"label": c["label"], "url": c["url"], "n": len(c["added"]) + len(c["removed"])} for c in out["changed_today"]],
            "missing": [c["ko"] for c in out["checks"] if c["ok"] is False],
            "threshold": (out["facts"].get("threshold") or {}).get("base")}


def smc_alerts(sm: dict | None) -> list[dict]:
    """브리핑 '오늘의 이민 알림'용: 근거 문장이 사라진 요건 (페이지 변경 알림은 inz_watch 가 이전→이후로 냄)."""
    if not sm:
        return []
    out = []
    if sm.get("missing"):
        out.append({"kind": "smc", "text": f"SMC 요건 원문 확인 필요 {len(sm['missing'])}건: {sm['missing'][0][:40]}…",
                    "url": PAGES[0]["url"]})
    return out


if __name__ == "__main__":
    cfg = load_config()
    pg = fetch_pages(cfg)
    res, _ = build(pg, None, {}, datetime.now().date().isoformat(), datetime.now(timezone.utc).isoformat(timespec="seconds"))
    res.pop("changes", None)
    json.dump({"pages": res["pages"], "facts": res["facts"], "checks": [{k: c[k] for k in ("id", "ok")} for c in res["checks"]]},
              sys.stdout, ensure_ascii=False, indent=1)
