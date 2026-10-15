"""결과 JSON 조립·검증·저장, 아카이브 인덱스 갱신, 오래된 파일 정리."""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path

import jsonschema

from common import ROOT, log

SCHEMA_PATH = ROOT / "schema" / "brief.schema.json"
DATE_FILE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.json$")


class BriefValidationError(ValueError):
    pass


def validate(brief: dict, cfg: dict) -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    try:
        jsonschema.validate(brief, schema)
    except jsonschema.ValidationError as e:
        raise BriefValidationError(f"{'/'.join(map(str, e.absolute_path))}: {e.message}") from e
    # 스키마로 표현하기 어려운 규칙: NZ 섹션의 모든 기사에는 '이민자 관점'이 있어야 함
    for key, section in brief["sections"].items():
        region = cfg["sections"].get(key, {}).get("region")
        for item in section["items"]:
            if region == "nz" and not item.get("why_it_matters", "").strip():
                raise BriefValidationError(f"{key}/{item['id']}: why_it_matters missing")


def total_items(brief: dict) -> int:
    return sum(len(s["items"]) for s in brief["sections"].values())


def write_brief(brief: dict, data_dir: Path) -> Path:
    data_dir.mkdir(parents=True, exist_ok=True)
    body = json.dumps(brief, ensure_ascii=False, indent=1)
    day_path = data_dir / f"{brief['date']}.json"
    day_path.write_text(body, encoding="utf-8")
    (data_dir / "latest.json").write_text(body, encoding="utf-8")
    return day_path


def prune_and_index(data_dir: Path, today: date, retention_days: int) -> list[str]:
    """retention_days 보다 오래된 날짜 파일을 지우고 index.json 을 다시 쓴다."""
    cutoff = today - timedelta(days=retention_days)
    dates = []
    for p in data_dir.glob("*.json"):
        m = DATE_FILE_RE.match(p.name)
        if not m:
            continue
        d = date.fromisoformat(m.group(1))
        if d < cutoff:
            log.info("pruning %s", p.name)
            p.unlink()
        else:
            dates.append(m.group(1))
    dates.sort(reverse=True)
    (data_dir / "index.json").write_text(
        json.dumps({"dates": dates, "updated_at": datetime.now().astimezone().isoformat(timespec="seconds")}, ensure_ascii=False),
        encoding="utf-8",
    )
    return dates
