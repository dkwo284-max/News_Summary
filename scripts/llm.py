"""AI 호출 래퍼: 구조화된 JSON 출력 + 요청 수/토큰 집계.

provider
  - gemini    (기본) Google Gemini API 무료 등급. 결제가 연결되지 않은 키를 쓰면 요금이 발생하지 않는다.
  - anthropic (선택) Claude API. 사용량만큼 별도 청구된다.

rank.py / summarize.py 는 task("rank" | "summary")만 넘기고, 모델 선택은 여기서 한다.
한 번 실행에서 보낼 수 있는 요청 수는 max_requests_per_run 으로 제한한다.
"""
from __future__ import annotations

import json
import os
import time
from collections import defaultdict

import httpx

from common import log

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class LLMError(RuntimeError):
    pass


class RequestCapReached(LLMError):
    pass


class BaseLLM:
    provider = "base"
    key_env = ""

    def __init__(self, cfg: dict):
        self.llm_cfg = cfg["llm"]
        self.pcfg = cfg["llm"][self.provider]
        self.max_requests = int(cfg["llm"].get("max_requests_per_run", 6))
        self.requests = 0
        self.disabled: str | None = None  # 키 오류 등 재시도해도 소용없는 실패면 이후 요청을 보내지 않음
        self.usage: dict[str, dict] = defaultdict(lambda: {"calls": 0, "input_tokens": 0, "output_tokens": 0})

    def model_for(self, task: str) -> str:
        return self.models_for(task)[0]

    def models_for(self, task: str) -> list[str]:
        """config 의 *_model 은 문자열 또는 후보 목록(앞에서부터 시도)."""
        m = self.pcfg[f"{task}_model"]
        return [m] if isinstance(m, str) else list(m)

    def json_call(self, *, task: str, system: str, user: str, schema: dict, max_tokens: int = 16000) -> dict:
        if self.disabled:
            raise LLMError(f"AI disabled for this run: {self.disabled}")
        if self.requests >= self.max_requests:
            raise RequestCapReached(f"max_requests_per_run={self.max_requests} reached")
        self.requests += 1
        return self._call(task=task, system=system, user=user, schema=schema, max_tokens=max_tokens)

    def _call(self, **kw) -> dict:  # pragma: no cover
        raise NotImplementedError

    def _record(self, model: str, inp: int, out: int) -> None:
        u = self.usage[model]
        u["calls"] += 1
        u["input_tokens"] += inp or 0
        u["output_tokens"] += out or 0

    def report(self) -> dict:
        pricing = self.pcfg.get("pricing", {})
        models, total = {}, 0.0
        for model, u in self.usage.items():
            p = pricing.get(model, {"input": 0, "output": 0})
            cost = u["input_tokens"] / 1e6 * p["input"] + u["output_tokens"] / 1e6 * p["output"]
            total += cost
            models[model] = {**u, "cost_usd": round(cost, 4)}
        return {"provider": self.provider, "requests": self.requests, "models": models, "total_cost_usd": round(total, 4)}

    def log_report(self) -> dict:
        rep = self.report()
        for model, u in rep["models"].items():
            log.info("usage %-24s calls=%d in=%d out=%d cost=$%.4f", model, u["calls"], u["input_tokens"], u["output_tokens"], u["cost_usd"])
        log.info("usage provider=%s requests=%d/%d total cost=$%.4f", self.provider, self.requests, self.max_requests, rep["total_cost_usd"])
        return rep


# ── Google Gemini (무료 등급) ─────────────────────────────────

def to_gemini_schema(schema: dict) -> dict:
    """JSON Schema → Gemini responseSchema(OpenAPI 부분집합): additionalProperties 제거, type 대문자."""
    out = {}
    for k, v in schema.items():
        if k == "additionalProperties":
            continue
        if k == "type" and isinstance(v, str):
            out[k] = v.upper()
        elif k == "properties":
            out[k] = {name: to_gemini_schema(sub) for name, sub in v.items()}
        elif k == "items":
            out[k] = to_gemini_schema(v)
        else:
            out[k] = v
    return out


class GeminiLLM(BaseLLM):
    provider = "gemini"
    key_env = "GEMINI_API_KEY"

    def __init__(self, cfg: dict, client: httpx.Client | None = None, sleep=time.sleep):
        super().__init__(cfg)
        self.key = os.environ.get(self.key_env, "")
        self.client = client or httpx.Client(timeout=180)
        self.sleep = sleep
        self.min_interval = float(self.pcfg.get("min_interval_seconds", 10))
        self._last = 0.0
        self._working: dict[str, list[str]] = {}

    def _post(self, model: str, body: dict) -> httpx.Response:
        wait = self._last + self.min_interval - time.monotonic()
        if wait > 0:  # 분당 요청 한도(RPM)를 넘지 않도록 간격 유지
            self.sleep(wait)
        self._last = time.monotonic()
        # 키는 URL 이 아닌 헤더로 보낸다 (오류 메시지·로그에 키가 찍히지 않게)
        return self.client.post(GEMINI_URL.format(model=model), headers={"x-goog-api-key": self.key}, json=body)

    def _call(self, *, task, system, user, schema, max_tokens) -> dict:
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": to_gemini_schema(schema),
                "maxOutputTokens": max_tokens,
            },
        }
        if self.pcfg.get("thinking_budget") is not None:
            body["generationConfig"]["thinkingConfig"] = {"thinkingBudget": int(self.pcfg["thinking_budget"])}

        # 모델 후보를 앞에서부터 시도: 404(단종·신규 사용자 불가)면 다음 후보로. 성공한 모델은 기억해 다음 요청에 바로 사용
        candidates = self._working.get(task) or self.models_for(task)
        last_err = None
        for model in candidates:
            r = self._post(model, body)
            if r.status_code == 429:
                # 분당 한도 초과면 잠시 후 한 번만 재시도. 일일 한도 소진이면 재시도해도 실패 → 상위에서 AI 없이 진행
                log.warning("gemini 429 (rate limit) — retrying once in %ss", self.pcfg.get("retry_wait_seconds", 60))
                self.sleep(float(self.pcfg.get("retry_wait_seconds", 60)))
                r = self._post(model, body)
            if r.status_code == 404:
                last_err = f"gemini HTTP 404 for {model}: {r.text[:200]}"
                log.warning("gemini model %s unavailable (404) — trying next candidate", model)
                continue
            if r.status_code >= 400:
                if r.status_code in (401, 403) or "API_KEY_INVALID" in r.text:
                    self.disabled = f"gemini HTTP {r.status_code} (API 키 확인 필요)"
                raise LLMError(f"gemini HTTP {r.status_code}: {r.text[:300]}")
            self._working[task] = [model]
            return self._parse(model, r.json())
        raise LLMError(last_err or "no gemini model candidates")

    def _parse(self, model: str, data: dict) -> dict:
        um = data.get("usageMetadata", {})
        self._record(model, um.get("promptTokenCount", 0), um.get("candidatesTokenCount", 0) + um.get("thoughtsTokenCount", 0))
        if data.get("promptFeedback", {}).get("blockReason"):
            raise LLMError(f"gemini blocked prompt: {data['promptFeedback']['blockReason']}")
        cands = data.get("candidates") or []
        if not cands:
            raise LLMError("gemini returned no candidates")
        cand = cands[0]
        if cand.get("finishReason") not in (None, "STOP"):
            raise LLMError(f"gemini finishReason={cand.get('finishReason')}")
        text = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", []) if not p.get("thought"))
        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            raise LLMError(f"gemini returned invalid JSON: {e}") from e


# ── Anthropic Claude (유료, 선택) ─────────────────────────────

class ClaudeLLM(BaseLLM):
    provider = "anthropic"
    key_env = "ANTHROPIC_API_KEY"

    def __init__(self, cfg: dict, client=None):
        super().__init__(cfg)
        if client is None:
            import anthropic

            client = anthropic.Anthropic(max_retries=3, timeout=180)
        self.client = client

    def _call(self, *, task, system, user, schema, max_tokens) -> dict:
        model = self.model_for(task)
        kwargs = dict(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            # Sonnet 5.5 는 강제 tool_choice 를 지원하지 않으므로 structured outputs 로 JSON 을 보장
            output_config={"effort": self.pcfg.get(f"{task}_effort", "low"), "format": {"type": "json_schema", "schema": schema}},
        )
        if task == "summary" and self.pcfg.get("summary_fallback", True):
            resp = self.client.beta.messages.create(**kwargs, betas=[FALLBACK_BETA], fallbacks="default")
        else:
            resp = self.client.messages.create(**kwargs)
        self._record(resp.model or model, resp.usage.input_tokens, resp.usage.output_tokens)
        if resp.stop_reason == "refusal":
            raise LLMError(f"{model} refused the request")
        if resp.stop_reason == "max_tokens":
            raise LLMError(f"{model} hit max_tokens={max_tokens}")
        text = next((b.text for b in resp.content if b.type == "text"), None)
        if text is None:
            raise LLMError(f"{model} returned no text block")
        return json.loads(text)


PROVIDERS = {"gemini": GeminiLLM, "anthropic": ClaudeLLM}


def make_llm(cfg: dict) -> BaseLLM:
    provider = cfg["llm"].get("provider", "gemini")
    cls = PROVIDERS.get(provider)
    if cls is None:
        raise ValueError(f"unknown llm.provider: {provider}")
    if not os.environ.get(cls.key_env):
        raise LLMError(f"{cls.key_env} 가 없습니다. (provider={provider}, 오프라인 점검은 --no-llm)")
    return cls(cfg)
