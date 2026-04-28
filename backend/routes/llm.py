"""
LLM proxy client wrapper.

All SPIRE LLM calls flow through the Thornveil-licensed safety proxy
which wraps the upstream model with classification-aware audit + scanning.
Pillar names, port numbers, and pillar-internal mechanics are not
disclosed in this public repo (see LICENSE.md § 2).

Headers required by the proxy:
  X-Caller-Clearance: UNCLASS
  X-Classification: UNCLASS

Context window is read from `/v1/models` at call time; SPIRE does not
hard-code the value here.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException

from ..inference_economics import RATE_CARD, record_call

router = APIRouter()

LLM_PROXY_URL = os.environ.get("SPIRE_LLM_PROXY", "http://127.0.0.1:8095")
LLM_MODEL = os.environ.get("SPIRE_LLM_MODEL", "llama4-maverick")  # proxy alias for gemma4
LLM_TIMEOUT = float(os.environ.get("SPIRE_LLM_TIMEOUT", "30"))
LLM_MAX_TOKENS = int(os.environ.get("SPIRE_LLM_MAX_TOKENS", "512"))


async def _probe_llm() -> dict:
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{LLM_PROXY_URL}/v1/models")
            if resp.status_code == 200:
                data = resp.json()
                model = (data.get("data") or [{}])[0]
                return {
                    "reachable": True,
                    "model_id": model.get("id"),
                    "max_context": model.get("max_model_len"),
                    "proxy": LLM_PROXY_URL,
                }
    except Exception as e:  # noqa: BLE001
        return {"reachable": False, "error": str(e), "proxy": LLM_PROXY_URL}
    return {"reachable": False, "proxy": LLM_PROXY_URL}


@router.get("/status")
async def llm_status():
    probe = await _probe_llm()
    return {
        "time": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        **probe,
    }


async def call_llm_chat(
    *,
    messages: list,
    response_format: Optional[dict] = None,
    temperature: float = 0.0,
    max_tokens: int = 512,
    tools: Optional[list] = None,
    tool_choice: Optional[Any] = None,
    tier: str = "tier2_mid",
    call_site: str = "unspecified",
    role: Optional[str] = None,
    route: str = "primary",
) -> dict:
    """Call the LLM chat completion endpoint via classification-proxy.

    Every call is:
      - temperature 0 by default (demo determinism)
      - logged to the audit chain by the proxy
      - scanned for classification spillage and ungrounded outputs by the proxy
      - cost-telemetry'd to `inference_economics.record_call` so the
        ADMIN "Inference Economics" tab can show $/call, $/min, top
        call sites, and 180k-Marine extrapolation. Every caller MUST
        declare its `tier` (cheapest acceptable model class) and
        `call_site` (stable join key for the top-spenders table).

    Raises HTTPException(503) if the proxy is unreachable — callers should
    gracefully degrade to Lite Mode.

    Reads SPIRE_LLM_PROXY/SPIRE_LLM_MODEL from env at call time (not module
    import) so secret rotation via Fly takes effect without restart.

    `tools` + `tool_choice` enable OpenAI-style function calling for the
    co-pilot planner. Pass tools=None for plain chat.
    """
    proxy_url = os.environ.get("SPIRE_LLM_PROXY", LLM_PROXY_URL)
    model = os.environ.get("SPIRE_LLM_MODEL", LLM_MODEL)
    rate_card_label = (RATE_CARD.get(tier) or {}).get("model", model)
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if response_format is not None:
        payload["response_format"] = response_format
    if tools is not None:
        payload["tools"] = tools
        if tool_choice is not None:
            payload["tool_choice"] = tool_choice
    headers = {
        "Content-Type": "application/json",
        "X-Caller-Clearance": "UNCLASSIFIED",
        "X-Classification": "UNCLASSIFIED",
    }
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
            resp = await client.post(
                f"{proxy_url}/v1/chat/completions",
                json=payload,
                headers=headers,
            )
    except httpx.RequestError as exc:
        latency_ms = (time.perf_counter() - started) * 1000
        # Log the failed proxy call so unreachable-proxy storms are
        # visible in the cost tab even though they cost $0.
        record_call(
            tier=tier, model=rate_card_label,
            input_tokens=0, output_tokens=0,
            latency_ms=latency_ms, call_site=call_site,
            route=route, role=role, error=f"proxy unreachable: {type(exc).__name__}",
        )
        raise HTTPException(status_code=503, detail=f"LLM proxy unreachable: {exc}")

    latency_ms = (time.perf_counter() - started) * 1000

    if resp.status_code != 200:
        record_call(
            tier=tier, model=rate_card_label,
            input_tokens=0, output_tokens=0,
            latency_ms=latency_ms, call_site=call_site,
            route=route, role=role, error=f"proxy {resp.status_code}",
        )
        raise HTTPException(status_code=502, detail=f"LLM proxy error {resp.status_code}: {resp.text[:200]}")

    body = resp.json()
    content = body.get("choices", [{}])[0].get("message", {}).get("content", "")
    usage = body.get("usage", {}) or {}
    input_tokens = int(usage.get("prompt_tokens") or 0)
    output_tokens = int(usage.get("completion_tokens") or 0)
    cost_entry = record_call(
        tier=tier, model=rate_card_label,
        input_tokens=input_tokens, output_tokens=output_tokens,
        latency_ms=latency_ms, call_site=call_site,
        route=route, role=role,
    )
    return {
        "content": content,
        "raw": body,
        "usage": usage,
        "finish_reason": body.get("choices", [{}])[0].get("finish_reason"),
        # Per-call economics so callers can surface "$0.0008" to the
        # operator without re-computing. Stable shape: tier, cost_usd,
        # latency_ms, call_site.
        "economics": {
            "tier": tier,
            "model": rate_card_label,
            "call_site": call_site,
            "route": route,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_usd": cost_entry["cost_usd"],
            "latency_ms": cost_entry["latency_ms"],
        },
    }


@router.post("/chat")
async def chat(payload: dict):
    messages = payload.get("messages")
    if not messages:
        raise HTTPException(status_code=400, detail="messages required")
    response_format = payload.get("response_format")
    temperature = float(payload.get("temperature", 0.0))
    max_tokens = int(payload.get("max_tokens", LLM_MAX_TOKENS))
    # `tier` / `call_site` flow through so direct /chat probes (developer
    # smoke tests) don't pollute the prod call-site table.
    tier = payload.get("tier") or "tier2_mid"
    call_site = payload.get("call_site") or "llm_chat_passthrough"
    result = await call_llm_chat(
        messages=messages,
        response_format=response_format,
        temperature=temperature,
        max_tokens=max_tokens,
        tier=tier,
        call_site=call_site,
    )
    return result
