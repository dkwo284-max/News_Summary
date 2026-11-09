"""데이터 상태 파일(status.json): 화면의 '데이터 상태' 패널이 읽는다. AI 를 쓰지 않는다.

브리핑 생성 시각·품질 저하 여부·수집 실패 피드·AI 사용량과, 별도로 갱신되는 데이터 파일(처리 기간·레저·장소·동네 등)의 마지막 갱신일을 모은다.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path


def _load(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def build_status(data_dir: Path, brief: dict, usage: dict | None = None) -> dict:
    meta = brief.get("meta") or {}
    ex = brief.get("extras") or {}
    files = {}
    for key, name, field in [("processing", "processing-history.json", "updated_at"), ("leisure", "leisure.json", "updated_at"), ("spots", "spots.json", "updated_at"),
                             ("areas", "areas.json", "updated_at"), ("stores", "stores.json", "updated_at"), ("policy", "policy.json", "updated"),
                             ("incidents", "incidents.json", "updated_at")]:
        d = _load(data_dir / name)
        v = d.get(field) if isinstance(d, dict) else None
        if v is None and isinstance(d, dict) and key == "processing":
            v = (d.get("updated") or d.get("updated_at"))
        files[key] = v
    pt = (ex.get("processing_times") or {}).get("updated_at")
    if pt:
        files["processing"] = pt
    ai = _load(data_dir / "ai-usage.json") or {}
    day = brief.get("date")
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "brief": {"date": day, "generated_at": brief.get("generated_at"), "mode": meta.get("mode"), "degraded": bool(meta.get("degraded")),
                  "degraded_reason": meta.get("degraded_reason", ""), "retries": meta.get("retries", 0), "requests": (meta.get("usage") or {}).get("requests", 0)},
        "feeds": {"total": meta.get("feeds_total"), "failed": [{"id": f.get("id"), "name": f.get("name")} for f in meta.get("failed_feeds", [])]},
        "ai": {"today": (ai.get("days", {}).get(day) or {}).get("requests", 0), "cap": ai.get("cap")},
        "files": files,
    }


def write_status(data_dir: Path, brief: dict) -> None:
    out = build_status(data_dir, brief)
    (data_dir / "status.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
