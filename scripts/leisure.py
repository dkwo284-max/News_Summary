"""레저(골프·요트·카약·낚시) 요금 데이터: 공식 페이지를 읽어 web/public/data/leisure.json 을 만든다.

- 시설 목록은 data/leisure-src.json (손으로 관리), 평점·직접 확인한 요금은 data/leisure-manual.json 에 적는다.
- 요금은 해마다 한 번(또는 수동) 갱신한다(.github/workflows/leisure.yml). 평소 매일 도는 파이프라인에는 들어 있지 않다.
- 흐름: 좌표(Nominatim, 캐시) → 공식 페이지 글 받기(HTML·PDF) → AI(Gemini)로 요금 항목만 뽑기 → 검증 → 저장.
- 검증: AI 가 뽑은 금액이 실제 페이지 글에 그 숫자로 들어 있지 않으면 버린다(추정·환산·창작 방지). 못 읽은 시설은 이전 값을 유지하고
  "미확인"으로 표시한다. AI 요청은 시설 3곳당 1회(전체 보통 10회 안팎, 1년에 한 번). 키·예산이 없으면 AI 단계는 건너뛴다.

    python scripts/leisure.py              # 전체 갱신
    python scripts/leisure.py --no-ai      # 좌표·수동 값만 (AI·요금 페이지 읽기 없음)
    python scripts/leisure.py --only g-wainui,g-pupuke
"""
from __future__ import annotations

import argparse
import io
import json
import logging
import re
import sys
import time
from datetime import date
from pathlib import Path
from urllib.parse import quote_plus, urljoin, urlparse

import httpx

from common import ROOT, load_config, log

SRC = ROOT / "data" / "leisure-src.json"
MANUAL = ROOT / "data" / "leisure-manual.json"
OUT = ROOT / "web" / "public" / "data" / "leisure.json"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
BBOX = (-37.45, -36.15, 174.20, 175.30)  # 오클랜드 광역시(위도 하한·상한, 경도 하한·상한)
KINDS = ["golf", "sailing", "kayak", "fishing"]
FEE_KINDS = ["adult", "couple", "family", "junior", "student", "social", "joining", "greenfee18", "greenfee9", "hire", "tour", "berth", "other"]
PERIODS = ["year", "season", "month", "week", "day", "hour", "round", "once", "person"]
STATUS = ["open", "waitlist", "closed", "unknown"]
BATCH = 3             # AI 한 번에 보내는 시설 수(작게 보내야 과부하·한도에 덜 걸림)
PAGE_CHARS = 5000     # 페이지당 AI 에 보내는 최대 글자
FACILITY_CHARS = 8000
LINK_WORDS = re.compile(r"member|subscri|fee|rate|green|price|pricing|join|categor|cost", re.I)
SKIP_LINKS = re.compile(r"login|log-in|signin|sign-in|members?-?area|member-?portal|cart|checkout|wp-admin", re.I)

SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "status": {"type": "string", "enum": STATUS},
                    "season": {"type": "string"},
                    "note": {"type": "string"},
                    "fees": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string"},
                                "kind": {"type": "string", "enum": FEE_KINDS},
                                "amount": {"type": "number"},
                                "period": {"type": "string", "enum": PERIODS},
                                "quote": {"type": "string"},
                            },
                            "required": ["label", "kind", "amount", "period", "quote"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["id", "status", "season", "note", "fees"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}

SYSTEM = """당신은 뉴질랜드 레저 시설(골프장·요트클럽·카약·낚시)의 요금표를 정리하는 조사원입니다.
각 시설(id)마다 주어진 공식 페이지 글에서 요금 항목만 뽑으세요. 금액은 모두 NZD 이며, 규칙은 엄격합니다.
- 글에 실제로 적힌 금액만 쓰세요. 계산·환산·추정·평균·다른 시설 값 참고 금지. 모르면 항목을 비우세요.
- kind: adult=성인 1인 정규 연회비(골프는 18홀 풀 플레잉 회원), couple=부부·성인 2인 연회비(총액),
  family=가족 연회비, junior=주니어·청소년, student=학생, social=비플레이 사교 회원, joining=입회비(1회),
  greenfee18=비회원(방문자) 18홀 1인 성인 요금(여러 개면 평일·비제휴 방문자 기준), greenfee9=같은 조건 9홀,
  hire=장비 대여(시간 또는 일 단위), tour=가이드 투어, berth=정박료, other=그 밖의 요금.
- period: year/season/month/week/day/hour/round(1라운드)/once(1회)/person(1인 1회).
- label: 글에 나온 이름 그대로(영어 가능). quote: 그 금액이 적힌 원문을 80자 이내로 그대로 옮기세요.
- 같은 종류가 여럿(예: 풀·위크데이·9홀)이면 각각 별도 항목으로, label 에 구분을 넣으세요. adult 는 가장 일반적인 한 개만.
- status: 글에 신규 가입 마감(full/closed/waitlist 대기 명단)이면 waitlist 또는 closed, 가입 가능하면 open, 알 수 없으면 unknown.
- season: 요금이 적용되는 시즌·연도 표기(예: "2026", "1 Sept 2026 – 31 Aug 2027")를 글 그대로. 없으면 "".
- note: 입회 심사·대기·참고 조건을 한국어 한 줄(40자 이내)로. 없으면 "".
모든 id 를 한 번씩 반환하세요. 요금을 못 찾은 시설은 fees 를 빈 배열로."""


# ── 글 받기 ─────────────────────────────────────────────

def _html_to_text(html: str) -> str:
    try:
        import trafilatura

        text = trafilatura.extract(html, include_tables=True, include_comments=False, favor_recall=True)
        if text:
            return text
    except Exception:  # noqa: BLE001
        pass
    text = re.sub(r"(?is)<(script|style|noscript).*?</\1>", " ", html)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return re.sub(r"[ \t\r\f\v]+", " ", re.sub(r"&nbsp;|&#160;", " ", text))


def _pdf_to_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader

        return "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(data)).pages[:6])
    except Exception as e:  # noqa: BLE001
        log.warning("pdf read failed: %s", e)
        return ""


def fetch_page(client: httpx.Client, url: str) -> tuple[str, str]:
    """(글, 원본 HTML). 실패하면 빈 값."""
    r = None
    for attempt in range(2):
        try:
            r = client.get(url)
            r.raise_for_status()
            break
        except httpx.HTTPStatusError as e:
            if e.response.status_code >= 500 and attempt == 0:
                time.sleep(4)
                continue
            log.warning("leisure fetch failed %s: %s", url, e)
            return "", ""
        except Exception as e:  # noqa: BLE001
            log.warning("leisure fetch failed %s: %s", url, e)
            return "", ""
    if r is None:
        return "", ""
    ctype = r.headers.get("content-type", "")
    if "pdf" in ctype or url.lower().split("?")[0].endswith(".pdf"):
        return _pdf_to_text(r.content), ""
    return _html_to_text(r.text), r.text


def discover_links(html: str, base: str, limit: int = 3) -> list[str]:
    """홈페이지에서 요금·회원 관련 링크를 최대 limit 개 찾는다(같은 사이트만)."""
    host = urlparse(base).netloc
    out: list[str] = []
    for m in re.finditer(r'(?is)<a\s[^>]*href=["\']([^"\'#]+)["\'][^>]*>(.*?)</a>', html or ""):
        href, label = m.group(1), re.sub(r"<[^>]+>", " ", m.group(2))
        url = urljoin(base, href)
        if urlparse(url).netloc != host or url == base or url.lower().endswith((".jpg", ".png", ".jpeg", ".gif")):
            continue
        if SKIP_LINKS.search(label) or SKIP_LINKS.search(urlparse(url).path):
            continue
        if LINK_WORDS.search(label) or LINK_WORDS.search(urlparse(url).path):
            if url not in out:
                out.append(url)
        if len(out) >= limit:
            break
    return out


def focus(text: str, limit: int) -> str:
    """긴 글에서 금액·요금 단어가 있는 줄을 우선 남긴다."""
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) <= limit:
        return text
    keep = re.compile(r"\$|member|fee|joining|subscri|green|rate|couple|family|junior|season|annual|per ", re.I)
    lines = text.splitlines()
    picked: list[str] = []
    size = 0
    for i, line in enumerate(lines):
        if keep.search(line):
            for seg in lines[max(0, i - 1): i + 2]:
                if seg not in picked:
                    picked.append(seg)
                    size += len(seg) + 1
        if size >= limit:
            break
    return "\n".join(picked)[:limit]


def collect_text(client: httpx.Client, fac: dict) -> tuple[str, list[str]]:
    """시설 한 곳의 공식 페이지 글을 모은다 → (글, 읽은 주소들)."""
    pages = list(fac.get("pages") or [])
    chunks, used = [], []
    home_html = ""
    if not pages and fac.get("home"):
        text, home_html = fetch_page(client, fac["home"])
        if text:
            chunks.append(f"[{fac['home']}]\n{focus(text, PAGE_CHARS // 2)}")
            used.append(fac["home"])
        pages = discover_links(home_html, fac["home"])
    explicit = bool(fac.get("pages"))
    for url in pages[:3]:
        text, _ = fetch_page(client, url)
        if text:
            chunks.append(f"[{url}]\n{focus(text, PAGE_CHARS)}")
            used.append(url)
        time.sleep(0.4)
    if explicit and not chunks and fac.get("home"):  # 적어 둔 페이지 주소가 바뀌었으면 홈페이지에서 다시 찾는다
        text, home_html = fetch_page(client, fac["home"])
        if text:
            chunks.append(f"[{fac['home']}]\n{focus(text, PAGE_CHARS // 2)}")
            used.append(fac["home"])
        for url in discover_links(home_html, fac["home"])[:2]:
            text, _ = fetch_page(client, url)
            if text:
                chunks.append(f"[{url}]\n{focus(text, PAGE_CHARS)}")
                used.append(url)
            time.sleep(0.4)
    return "\n\n".join(chunks)[:FACILITY_CHARS], used


# ── 검증 ────────────────────────────────────────────────

def amount_in_text(amount: float, text: str) -> bool:
    """금액이 페이지 글에 그 숫자 그대로 있는지(1,325 · 1325 · 1,325.00 등)."""
    variants = {f"{amount:,.0f}", f"{amount:.0f}", f"{amount:,.2f}", f"{amount:.2f}"}
    if abs(amount - round(amount)) > 1e-9:
        variants -= {f"{amount:,.0f}", f"{amount:.0f}"}
    for v in variants:
        if re.search(rf"(?<![\d,.]){re.escape(v)}(?![\d])", text):
            return True
    return False


def clean_fees(fees: list[dict], text: str) -> list[dict]:
    out, seen = [], set()
    for f in fees or []:
        try:
            amount = float(f["amount"])
        except (KeyError, TypeError, ValueError):
            continue
        kind = f.get("kind") if f.get("kind") in FEE_KINDS else "other"
        period = f.get("period") if f.get("period") in PERIODS else "year"
        if not (3 <= amount <= 300000) or not amount_in_text(amount, text):
            log.info("leisure: dropped unverifiable fee %s %.2f", f.get("label"), amount)
            continue
        key = (kind, f.get("label", ""), amount, period)
        if key in seen:
            continue
        seen.add(key)
        out.append({"label": str(f.get("label", ""))[:60], "kind": kind, "amount": round(amount, 2), "period": period,
                    "quote": str(f.get("quote", ""))[:100]})
    return out


PRIMARY_LABEL = re.compile(r"full|unlimited|7.?day|seven|standard|playing|18|adult|single|individual|open|regular", re.I)
GROUP_LABEL = re.compile(r"family|couple|joint|junior|student|youth|social|corporate|country|9.?hole|week.?day|midweek|off.?peak|intermediate|senior|ladies", re.I)


def normalize_primary(fees: list[dict], facility_kind: str) -> list[dict]:
    """한 종류(adult·couple·family·joining·greenfee)에는 대표 1개만 남기고 나머지는 other 로 내린다(이름은 그대로).
    - 골프 외 시설에는 greenfee 종류가 없으므로 other 로.
    - adult 대표: 이름이 풀·언리미티드·7일 등 '정규'이면서 주니어·가족·위크데이 등이 아닌 것 중 가장 비싼 것(없으면 가장 비싼 것).
    - joining 대표: 가족·커플·주니어가 아닌 것 중 가장 싼 것(성인 개인 입회비)."""
    out = [dict(f) for f in fees]
    if facility_kind != "golf":
        for f in out:
            if f["kind"] in ("greenfee18", "greenfee9"):
                f["kind"] = "other"
    def demote_except(kind: str, keep: dict | None) -> None:
        for f in out:
            if f["kind"] == kind and f is not keep:
                f["kind"] = "other"
    adults = [f for f in out if f["kind"] == "adult" and f["period"] in ("year", "season")]
    if adults:
        regular = [f for f in adults if PRIMARY_LABEL.search(f["label"]) and not GROUP_LABEL.search(f["label"])] or \
                  [f for f in adults if not GROUP_LABEL.search(f["label"])] or adults
        demote_except("adult", max(regular, key=lambda f: f["amount"]))
    joins = [f for f in out if f["kind"] == "joining"]
    if joins:
        indiv = [f for f in joins if not re.search(r"family|couple|joint|junior", f["label"], re.I)] or joins
        demote_except("joining", min(indiv, key=lambda f: f["amount"]))
    for k in ("couple", "family", "greenfee18", "greenfee9"):
        group = [f for f in out if f["kind"] == k]
        if len(group) > 1:
            demote_except(k, group[0] if k.startswith("greenfee") else min(group, key=lambda f: f["amount"]))
    return out


def merge_manual(fac: dict, manual: dict) -> dict:
    """data/leisure-manual.json 의 평점·직접 확인한 요금·메모를 덮어쓴다(수동 값이 우선)."""
    m = manual.get(fac["id"])
    if not m:
        return fac
    if m.get("hide"):
        fac["hide"] = True
    if m.get("rating"):
        fac["rating"] = m["rating"]
    if m.get("note"):
        fac["note"] = m["note"]
    if m.get("status") in STATUS:
        fac["status"] = m["status"]
    if m.get("fees"):
        mine = {(f["kind"], f.get("label", "")) for f in m["fees"]}
        fac["fees"] = [f for f in fac.get("fees", []) if (f["kind"], f.get("label", "")) not in mine] + \
                      [{**f, "source": "manual"} for f in m["fees"]]
        if m.get("checked"):
            fac["checked"] = m["checked"]
    return fac


# ── 좌표 ────────────────────────────────────────────────

def in_auckland(lat: float, lon: float) -> bool:
    return BBOX[0] <= lat <= BBOX[1] and BBOX[2] <= lon <= BBOX[3]


def geocode(client: httpx.Client, query: str, bounded: bool = False) -> list[float] | None:
    params = {"q": query, "format": "json", "limit": 1, "countrycodes": "nz"}
    if bounded:  # 오클랜드 안에서만 찾기 (왼쪽,위,오른쪽,아래)
        params.update({"viewbox": f"{BBOX[2]},{BBOX[1]},{BBOX[3]},{BBOX[0]}", "bounded": 1})
    try:
        r = client.get(NOMINATIM, params=params)
    except httpx.HTTPError as e:
        log.warning("geocode failed %s: %s", query, e)
        return None
    time.sleep(1.1)  # Nominatim 사용 정책: 초당 1회
    if r.status_code != 200 or not r.json():
        return None
    row = r.json()[0]
    lat, lon = float(row["lat"]), float(row["lon"])
    return [round(lat, 5), round(lon, 5)] if in_auckland(lat, lon) else None


def locate(client: httpx.Client, s: dict) -> list[float] | None:
    """좌표 찾기: 적어 둔 geo → 주소(geo2) → 이름만(오클랜드 안에서)."""
    tries = [(s.get("geo") or f"{s['name']}, Auckland", False)]
    if s.get("geo2"):
        tries.append((s["geo2"], False))
    tries.append((re.sub(r"\s*\(.*?\)", "", s["name"]), True))
    for q, bounded in tries:
        ll = geocode(client, q, bounded)
        if ll:
            return ll
    return None


# ── AI 추출 ─────────────────────────────────────────────

def extract(llm, batch: list[tuple[dict, str]]) -> dict[str, dict]:
    user = "\n\n=====\n\n".join(f"[id] {f['id']}\n[이름] {f['name']}\n[종류] {f['kind']}\n{text}" for f, text in batch)
    out = llm.json_call(task="summary", system=SYSTEM, user=user, schema=SCHEMA, max_tokens=24000)
    return {row.get("id"): row for row in out.get("items", [])}


def build(src: dict, manual: dict, old: dict, client: httpx.Client, llm, today: str, only: set[str] | None = None) -> dict:
    old_by_id = {f["id"]: f for f in old.get("facilities", [])}
    geocache: dict[str, list[float] | None] = dict(old.get("geocache", {}))
    facilities: list[dict] = []
    todo: list[tuple[dict, str, list[str]]] = []
    for s in src["facilities"]:
        if only and s["id"] not in only:
            if s["id"] in old_by_id:
                facilities.append(merge_manual(dict(old_by_id[s["id"]]), manual))
            continue
        prev = old_by_id.get(s["id"], {})
        geo = s.get("geo") or f"{s['name']}, Auckland"
        if not geocache.get(geo):  # 못 찾은 곳(null)은 다음 실행에서 다시 시도
            geocache[geo] = locate(client, s)
        fac = {"id": s["id"], "kind": s["kind"], "name": s["name"], "area": s.get("area", ""), "ll": geocache.get(geo),
               "home": s.get("home") or "", "gmaps": "https://www.google.com/maps/search/?api=1&query=" + quote_plus(f"{s['name']} Auckland"),
               "fees": prev.get("fees", []), "status": prev.get("status", "unknown"), "season": prev.get("season", ""),
               "note": s.get("note") or prev.get("note", ""), "checked": prev.get("checked", ""), "src": prev.get("src", [])}
        if s.get("note"):
            fac["note"] = s["note"]
        if llm is not None and (s.get("home") or s.get("pages")):
            text, used = collect_text(client, s)
            if text:
                todo.append((fac, text, used))
        facilities.append(fac)
    if llm is not None and todo:
        chunks = [todo[i:i + BATCH] for i in range(0, len(todo), BATCH)]
        results: list[tuple[list, dict]] = []
        for attempt in range(2):  # 실패한 묶음은 잠시 쉬었다 한 번 더
            failed = []
            for n, chunk in enumerate(chunks, 1):
                try:
                    results.append((chunk, extract(llm, [(f, t) for f, t, _ in chunk])))
                except Exception as e:  # noqa: BLE001 — 실패하면 이전 값을 그대로 둔다
                    log.warning("leisure AI failed for batch %d (try %d): %s", n, attempt + 1, str(e)[:200])
                    failed.append(chunk)
            if not failed:
                break
            chunks = failed
            time.sleep(90)
        for chunk, rows in results:
            for fac, text, used in chunk:
                row = rows.get(fac["id"])
                if row is None:
                    continue
                fees = normalize_primary(clean_fees(row.get("fees", []), text), fac["kind"])
                if fees or not fac.get("fees"):
                    fac["fees"] = fees
                fac["status"] = row.get("status") if row.get("status") in STATUS else "unknown"
                fac["season"] = str(row.get("season", ""))[:60]
                if row.get("note") and not fac.get("note"):
                    fac["note"] = str(row["note"])[:80]
                fac["checked"] = today
                fac["src"] = used
    for f in facilities:  # 이전 실행 값도 같은 규칙으로 정리(여러 번 적용해도 결과가 같다)
        f["fees"] = normalize_primary(f.get("fees", []), f["kind"])
    facilities = [merge_manual(f, manual) for f in facilities]
    facilities = [f for f in facilities if not f.get("hide")]
    return {"updated_at": today, "source": "각 시설 공식 사이트(연 1회 AI로 요금표 추출 후 금액 검증), 좌표 OpenStreetMap",
            "facilities": facilities, "geocache": geocache}


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-ai", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--ignore-cap", action="store_true", help="AI 공용 예산 무시")
    ap.add_argument("--if-stale", action="store_true", help="파일이 330일 안에 만든 것이면 건너뜀 (자동 실행용)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "httpcore", "trafilatura"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    cfg = load_config()
    src, manual, old = load_json(SRC, {"facilities": []}), load_json(MANUAL, {}), load_json(OUT, {})
    manual = {k: v for k, v in manual.items() if not k.startswith("_")}
    only = set(filter(None, args.only.split(","))) or None
    today = date.today().isoformat()
    if args.if_stale and old.get("updated_at"):
        try:
            if (date.today() - date.fromisoformat(old["updated_at"])).days < 330:
                log.info("leisure: data is %s — under a year old, skipping (--if-stale)", old["updated_at"])
                return 0
        except ValueError:
            pass
    todo_n = len([s for s in src["facilities"] if (s.get("home") or s.get("pages")) and (not only or s["id"] in only)])
    batches = -(-todo_n // BATCH)

    llm = None
    if not args.no_ai:
        try:
            from llm import LLMError, make_llm
            from budget import allowance, describe, nz_today
            from usage import used_today

            data_dir = ROOT / cfg["output"]["data_dir"]
            day = nz_today()
            left, info = allowance("daily-brief", used_today(data_dir, day), int(cfg["llm"].get("guaranteed", 7)), day)
            log.info("%s", describe("daily-brief", left, info))
            if left < batches and not args.ignore_cap:
                log.warning("AI 예산 부족(남은 %d회, 필요 %d회) — 요금 읽기는 건너뛰고 좌표·수동 값만 갱신 (--ignore-cap 으로 무시)", left, batches)
            else:
                llm = make_llm(cfg)
                llm.max_requests = batches * 2  # 실패한 묶음 재시도 여유
        except Exception as e:  # noqa: BLE001
            log.warning("AI 를 쓸 수 없어 요금 읽기를 건너뜁니다: %s", e)

    ua = cfg["fetch"]["user_agent"]
    with httpx.Client(timeout=30, follow_redirects=True, headers={"User-Agent": ua}) as client:
        out = build(src, manual, old, client, llm, today, only)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    priced = sum(1 for f in out["facilities"] if f["fees"])
    log.info("leisure: %d facilities, %d with fees, %d located", len(out["facilities"]), priced, sum(1 for f in out["facilities"] if f["ll"]))
    if llm is not None and llm.requests:
        from budget import nz_today
        from usage import record

        record(ROOT / cfg["output"]["data_dir"], nz_today(), llm.requests, cfg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
