"""공통: 설정 읽기, 로그, SEC 요청(연락처 헤더·속도 제한)."""
from __future__ import annotations

import json
import logging
import math
import os
import time
from pathlib import Path

import httpx
import yaml

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "data"
CACHE = ROOT / "cache"
log = logging.getLogger("radar")


def load_config(path: Path | None = None) -> dict:
    return yaml.safe_load((path or ROOT / "config.yaml").read_text(encoding="utf-8"))


class SEC:
    """data.sec.gov / www.sec.gov 요청. SEC 공정 접근 정책: 연락처가 담긴 User-Agent, 초당 10회 이하."""

    def __init__(self, cfg: dict, client: httpx.Client | None = None):
        ua = os.environ.get("SEC_USER_AGENT") or cfg["sec"]["user_agent"]
        self.client = client or httpx.Client(timeout=40, follow_redirects=True,
                                             headers={"User-Agent": ua, "Accept-Encoding": "gzip, deflate"})
        self.interval = float(cfg["sec"].get("request_interval", 0.15))
        self._last = 0.0

    def get(self, url: str) -> httpx.Response:
        wait = self.interval - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        for attempt in range(3):
            self._last = time.monotonic()
            r = self.client.get(url)
            if r.status_code in (429, 503) and attempt < 2:
                time.sleep(2 + attempt * 3)
                continue
            r.raise_for_status()
            return r
        r.raise_for_status()
        return r

    def json(self, url: str) -> dict:
        return self.get(url).json()

    def text(self, url: str) -> str:
        return self.get(url).text


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def finite(obj):
    """JSON 에 NaN·Infinity 가 들어가면 브라우저가 못 읽으므로 None 으로."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: finite(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [finite(v) for v in obj]
    return obj


def write_json(path: Path, data, indent: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(finite(data), ensure_ascii=False, indent=indent, allow_nan=False), encoding="utf-8")
