"""인사이트: 요약 뒤 기사마다 ① 나에게 미치는 영향·할 일 ② 이 이슈의 흐름(지난 30일 브리핑)을 붙인다.

① 영향: 뉴질랜드·오클랜드·이민 레이더 기사 전부. 독자 프로필 기준 영향도(high/medium/low/none)·이유·할 일·지켜볼 신호.
② 흐름: 지난 브리핑에서 제목 핵심 단어가 겹치는 기사를 후보로 고르고(코드), AI 가 같은 이슈인지 확인하면서
   '지난 보도와 달라진 점' 한 줄을 쓴다. 확인된 지난 기사의 흐름까지 이어 붙여 이슈가 길어질수록 타임라인이 자란다.
두 가지를 한 요청에 묶어 batch_size 건씩 보낸다(보통 2~3회). 실패해도 브리핑은 그대로 생성된다.
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

from common import Article, log
from rank import _keys

LEVELS = ("high", "medium", "low", "none")

SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "impact": {"type": "string"},
                    "reason": {"type": "string"},
                    "actions": {"type": "array", "items": {"type": "string"}},
                    "watch": {"type": "string"},
                    "same_issue": {"type": "array", "items": {"type": "string"}},
                    "changed": {"type": "string"},
                },
                "required": ["id", "impact", "reason", "actions", "watch", "same_issue", "changed"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}


def _system(cfg: dict) -> str:
    profile = cfg.get("profile", {}).get("summary", "")
    return f"""당신은 뉴질랜드 이민 준비 가족을 돕는 뉴스 분석가입니다. 기사마다 아래 항목을 한국어로 채웁니다.
독자: {profile} 배우자·초등 입학 예정 자녀와 함께 오클랜드에서 아파트 렌트로 살며, 졸업 후 취업비자→영주권을 준비 중.

[영향 평가] 표시가 있는 기사만:
- impact: 이 독자 가족에게 미치는 영향 "high"(비자·취업·영주권 자격이나 일정·비용에 직접 영향, 가족 안전·의료·학교에 직접 영향) /
  "medium"(생활비·렌트·고용시장·지역 생활에 간접 영향) / "low"(알아두면 좋은 정도) / "none"(사실상 무관).
- reason: 왜 그 영향도인지 독자 상황에 맞춰 한 문장(60자 이내). 일반론 말고 구체적으로.
- actions: 독자가 지금 할 수 있는 구체적 행동 0~2개(각 45자 이내). 확인할 공식 안내·준비 서류·예산 점검 등. 없으면 빈 배열.
- watch: 앞으로 지켜볼 신호·날짜 하나(45자 이내, 예: 시행일·발표 예정·의견 수렴 마감). 없으면 "".
- impact 가 "none" 이면 reason 만 짧게, actions 는 [], watch 는 "".
[영향 평가: 생략] 기사는 impact "none", reason "", actions [], watch "".

[지난 보도 후보]가 있는 기사:
- same_issue: 후보 중 이 기사와 '같은 이슈'(같은 정책·사건·논란의 이전 보도)인 것의 id 만. 단어만 겹치는 다른 사건은 제외.
- changed: same_issue 가 있으면 지난 보도와 비교해 '이번에 새로 달라진 점'을 한 문장(60자 이내). 없으면 "".
후보가 없으면 same_issue [], changed "".

사실은 주어진 기사 정보 안에서만. 날짜·수치를 지어내지 말고, 법률·투자 조언을 단정하지 마세요. 모든 id 에 대해 한 번씩 반환하세요."""


# ── 이 이슈의 흐름: 지난 브리핑에서 후보 찾기 ─────────────────────

def load_history(data_dir: Path, today: str, days: int = 30) -> list[dict]:
    """지난 브리핑의 기사들 (날짜·섹션 포함). 같은 기사(id)는 처음 나온 날짜로 한 번만."""
    t = date.fromisoformat(today)
    seen: dict[str, dict] = {}
    for back in range(days, 0, -1):  # 오래된 날부터 → 처음 보도일 유지
        d = (t - timedelta(days=back)).isoformat()
        try:
            b = json.loads((data_dir / f"{d}.json").read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        for key, sec in b.get("sections", {}).items():
            for it in sec.get("items", []):
                if it.get("carried_from") or it["id"] in seen:
                    continue
                seen[it["id"]] = {"id": it["id"], "date": d, "section": key, "title_ko": it["title_ko"],
                                  "original_title": it.get("original_title", ""),
                                  "url": (it.get("sources") or [{}])[0].get("url", ""),
                                  "timeline": it.get("timeline", [])}
    return list(seen.values())


def _item_keys(title_ko: str, original: str) -> set[str]:
    return _keys(f"{title_ko} {original}")


def candidates(item: dict, history: list[dict], limit: int = 6, min_shared: int = 2) -> list[dict]:
    """제목 핵심 단어가 min_shared 개 이상 겹치는 지난 기사 (같은 지역끼리), 겹침이 많은 순."""
    keys = _item_keys(item["title_ko"], item.get("original_title", ""))
    kr = item["_section"].startswith("kr_")
    scored = []
    for h in history:
        if h["id"] == item["id"] or h["section"].startswith("kr_") != kr:
            continue
        shared = len(keys & _item_keys(h["title_ko"], h["original_title"]))
        if shared >= min_shared:
            scored.append((shared, h["date"], h))
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return [h for _, _, h in scored[:limit]]


def build_timeline(confirmed: list[dict]) -> list[dict]:
    """확인된 지난 기사 + 그 기사들의 흐름을 합쳐 날짜순 (같은 기사·같은 제목 한 번만)."""
    rows: dict[str, dict] = {}
    for h in confirmed:
        for t in [*h.get("timeline", []), {"date": h["date"], "title_ko": h["title_ko"], "url": h["url"], "id": h["id"]}]:
            k = t.get("id") or t["title_ko"]
            if k not in rows or t["date"] < rows[k]["date"]:
                rows[k] = t
    out = sorted(rows.values(), key=lambda t: t["date"])
    return [{"date": t["date"], "title_ko": t["title_ko"], "url": t.get("url", ""), "id": t.get("id", "")} for t in out][-8:]


# ── 요청 ──────────────────────────────────────────────────

def _block(item: dict, label: str, art: Article | None, assess: bool, cands: list[dict]) -> str:
    parts = [f"[id] {item['id']}", f"[섹션] {label}", f"[제목] {item['title_ko']}"]
    if item.get("original_title") and item["original_title"] != item["title_ko"]:
        parts.append(f"[원문 제목] {item['original_title']}")
    parts.append("[요약] " + " / ".join(item.get("summary_ko", [])))
    if item.get("why_it_matters"):
        parts.append(f"[이민자 관점] {item['why_it_matters']}")
    if art is not None and art.excerpt:
        parts.append(f"[본문 발췌] {art.excerpt[:900]}")
    parts.append("[영향 평가]" if assess else "[영향 평가: 생략]")
    if cands:
        parts.append("[지난 보도 후보] " + " / ".join(f"({c['id']}) {c['date']} {c['title_ko']}" for c in cands))
    return "\n".join(parts)


def pick_targets(sections: dict, cfg: dict, history: list[dict]) -> list[tuple[str, dict, bool, list[dict]]]:
    """(섹션, 기사, 영향 평가 여부, 지난 보도 후보). 뉴질랜드 기사는 전부, 한국 기사는 지난 보도 후보가 있을 때만."""
    region = lambda k: cfg["sections"].get(k, {}).get("region", "kr" if k.startswith("kr_") else "nz")
    skip = set(cfg.get("insight", {}).get("skip_sections", []))
    out, seen = [], set()
    order = sorted(sections.items(), key=lambda kv: kv[0] != "nz_immigration")  # 레이더 먼저
    for k, sec in order:
        if k in skip:
            continue
        for it in sec.get("items", []):
            if it.get("carried_from") or it["id"] in seen:
                continue
            cands = candidates({**it, "_section": k}, history)
            nz = region(k) == "nz"
            if nz or cands:
                seen.add(it["id"])
                out.append((k, it, nz, cands))
    return out


def attach_insights(sections: dict, chosen: dict[str, list[Article]], cfg: dict, llm, data_dir: Path, today: str) -> int:
    icfg = cfg.get("insight", {})
    if llm is None or not icfg.get("enabled", True):
        return 0
    history = load_history(data_dir, today, int(icfg.get("history_days", 30)))
    targets = pick_targets(sections, cfg, history)
    if not targets:
        return 0
    arts = {a.id: a for items in chosen.values() for a in items}
    batch = int(icfg.get("batch_size", 22))
    rows: dict[str, dict] = {}
    for start in range(0, len(targets), batch):
        chunk = targets[start:start + batch]
        user = "\n\n---\n\n".join(_block(it, sections[k]["label"], arts.get(it["id"]), assess, cands)
                                  for k, it, assess, cands in chunk)
        try:
            out = llm.json_call(task="summary", system=_system(cfg), user=user, schema=SCHEMA, max_tokens=24000)
            rows.update({r.get("id"): r for r in out.get("items", [])})
        except Exception as e:  # noqa: BLE001 — 인사이트 실패가 브리핑 생성을 막지 않게 (남은 묶음도 시도)
            log.warning("insight AI failed for batch %d: %s", start // batch + 1, e)
    by_id = {it["id"]: (assess, cands) for _, it, assess, cands in targets}
    n_imp = n_tl = 0
    for sec in sections.values():
        for it in sec.get("items", []):
            row = rows.get(it["id"])
            if row is None or it["id"] not in by_id or it.get("carried_from"):
                continue
            assess, cands = by_id[it["id"]]
            level = (row.get("impact") or "").lower()
            if assess and level in LEVELS:
                it["impact"] = {
                    "level": level,
                    "reason": row.get("reason", "").strip()[:120],
                    "actions": [a.strip()[:80] for a in row.get("actions", []) if a.strip()][:2] if level != "none" else [],
                    "watch": row.get("watch", "").strip()[:80] if level != "none" else "",
                }
                n_imp += 1
            ok = {c["id"] for c in cands}
            confirmed = [c for c in cands if c["id"] in set(row.get("same_issue", [])) & ok]
            if confirmed:
                it["timeline"] = build_timeline(confirmed)
                if row.get("changed", "").strip():
                    it["changed"] = row["changed"].strip()[:120]
                n_tl += 1
    log.info("insights: impact %d, timeline %d (of %d targets)", n_imp, n_tl, len(targets))
    return n_imp + n_tl
