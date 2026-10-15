"""Claude API 래퍼: 구조화된 JSON 출력 + 토큰 사용량/비용 집계."""
from __future__ import annotations

import json
from collections import defaultdict

import anthropic

from common import log

FALLBACK_BETA = "server-side-fallback-2026-07-01"


class LLMError(RuntimeError):
    pass


class LLM:
    def __init__(self, cfg: dict, client: anthropic.Anthropic | None = None):
        self.cfg = cfg["llm"]
        self.client = client or anthropic.Anthropic(max_retries=3, timeout=180)
        self.usage: dict[str, dict] = defaultdict(lambda: {"calls": 0, "input_tokens": 0, "output_tokens": 0})

    def json_call(self, *, model: str, system: str, user: str, schema: dict, effort: str,
                  max_tokens: int = 16000, fallback: bool = False) -> dict:
        """JSON 스키마로 제약된 응답을 받아 dict 로 돌려준다.

        Sonnet 5.5 는 강제 tool_choice 를 지원하지 않으므로 tool-use 대신
        structured outputs(output_config.format)로 JSON 을 보장받는다.
        """
        kwargs = dict(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        )
        if fallback:
            resp = self.client.beta.messages.create(**kwargs, betas=[FALLBACK_BETA], fallbacks="default")
        else:
            resp = self.client.messages.create(**kwargs)

        u = self.usage[resp.model or model]
        u["calls"] += 1
        u["input_tokens"] += resp.usage.input_tokens or 0
        u["output_tokens"] += resp.usage.output_tokens or 0

        if resp.stop_reason == "refusal":
            raise LLMError(f"{model} refused the request")
        if resp.stop_reason == "max_tokens":
            raise LLMError(f"{model} hit max_tokens={max_tokens}")
        text = next((b.text for b in resp.content if b.type == "text"), None)
        if text is None:
            raise LLMError(f"{model} returned no text block")
        return json.loads(text)

    def report(self) -> dict:
        pricing = self.cfg.get("pricing", {})
        models, total = {}, 0.0
        for model, u in self.usage.items():
            p = pricing.get(model)
            if p is None:
                log.warning("no pricing configured for %s — cost counted as 0", model)
                cost = 0.0
            else:
                cost = u["input_tokens"] / 1e6 * p["input"] + u["output_tokens"] / 1e6 * p["output"]
            total += cost
            models[model] = {**u, "cost_usd": round(cost, 4)}
        return {"models": models, "total_cost_usd": round(total, 4)}

    def log_report(self) -> dict:
        rep = self.report()
        for model, u in rep["models"].items():
            log.info("usage %-20s calls=%d in=%d out=%d cost=$%.4f", model, u["calls"], u["input_tokens"], u["output_tokens"], u["cost_usd"])
        log.info("usage total cost=$%.4f (budget $%.2f)", rep["total_cost_usd"], self.cfg.get("daily_budget_usd", 0))
        if rep["total_cost_usd"] > self.cfg.get("daily_budget_usd", float("inf")):
            log.warning("daily budget exceeded: $%.4f", rep["total_cost_usd"])
        return rep
