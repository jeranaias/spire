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

# ---------------------------------------------------------------------------
# Two-tier LLM router.
#
#   Tier A — primary, frontier-quality. RigRun's classification proxy
#            in front of Gemma 4 26B FP8. Reached over Tailscale.
#            ~480 ms typical for plain chat.
#   Tier B — local fallback, on-device. Ollama OpenAI-compatible
#            REST on `localhost:11434/v1` serving Gemma 4 E2B.
#            ~3 GB RAM, ~10-15 tok/s on a duty laptop CPU. Closes
#            the air-gap pitch — when SATCOM goes amber and Tier-A
#            is unreachable, Tier-B keeps the experience working
#            at ~70-80% quality.
#   Tier C — deterministic regex / lookup. Always available; only
#            fires when both A and B are unreachable. Lives in
#            backend/copilot/planner.py and isn't this module's
#            concern — call_llm_chat just throws an HTTPException
#            and the caller falls through.
# ---------------------------------------------------------------------------

LLM_PROXY_URL = os.environ.get("SPIRE_LLM_PROXY", "http://127.0.0.1:8095")
LLM_MODEL = os.environ.get("SPIRE_LLM_MODEL", "llama4-maverick")  # proxy alias for gemma4
LLM_LOCAL_URL = os.environ.get("SPIRE_LLM_LOCAL", "http://127.0.0.1:11434")
LLM_LOCAL_MODEL = os.environ.get("SPIRE_LLM_LOCAL_MODEL", "gemma4:e2b")
LLM_TIMEOUT = float(os.environ.get("SPIRE_LLM_TIMEOUT", "30"))
LLM_MAX_TOKENS = int(os.environ.get("SPIRE_LLM_MAX_TOKENS", "512"))

# Set SPIRE_LLM_LOCAL_DISABLE=1 to skip Tier-B entirely. Useful when
# the local Ollama install is missing the Gemma 4 model and we'd
# rather fail fast to deterministic rules than spend a request
# discovering the gap.
LLM_LOCAL_DISABLED = (os.environ.get("SPIRE_LLM_LOCAL_DISABLE") or "").strip().lower() in ("1", "true", "yes")


def _local_reachable_sync_cache_key() -> str:
    """Cache key for the rolling reachability of localhost:11434.
    The first failed call writes the timestamp; subsequent calls
    within a short window short-circuit Tier-B without paying the
    connection-attempt cost. Reset on next process boot.
    """
    return "spire-llm-local-unreachable-since"


_LOCAL_FAIL_CACHE: dict[str, float] = {}
_LOCAL_FAIL_BACKOFF_SEC = 30.0  # don't retry Tier-B for 30s after a failure
_PRIMARY_FAIL_BACKOFF_SEC = 30.0  # don't retry Tier-A for 30s after a failure
_PRIMARY_FAIL_KEY = "spire-llm-primary-unreachable-since"


def _local_recently_failed() -> bool:
    ts = _LOCAL_FAIL_CACHE.get(_local_reachable_sync_cache_key())
    if ts is None:
        return False
    return (time.time() - ts) < _LOCAL_FAIL_BACKOFF_SEC


def _mark_local_failed() -> None:
    _LOCAL_FAIL_CACHE[_local_reachable_sync_cache_key()] = time.time()


def _clear_local_failed() -> None:
    _LOCAL_FAIL_CACHE.pop(_local_reachable_sync_cache_key(), None)


def _primary_recently_failed() -> bool:
    ts = _LOCAL_FAIL_CACHE.get(_PRIMARY_FAIL_KEY)
    if ts is None:
        return False
    return (time.time() - ts) < _PRIMARY_FAIL_BACKOFF_SEC


def _mark_primary_failed() -> None:
    _LOCAL_FAIL_CACHE[_PRIMARY_FAIL_KEY] = time.time()


def _clear_primary_failed() -> None:
    _LOCAL_FAIL_CACHE.pop(_PRIMARY_FAIL_KEY, None)


# When the operator explicitly wants air-gap-style behavior (no upstream
# at all, ever — useful for DDIL drills + the Marine pilot deployment
# where there's no Tailscale to RigRun), set SPIRE_LLM_PRIMARY_DISABLE=1
# and Tier-A is skipped entirely. The router goes straight to local.
LLM_PRIMARY_DISABLED = (os.environ.get("SPIRE_LLM_PRIMARY_DISABLE") or "").strip().lower() in ("1", "true", "yes")


async def _probe_llm() -> dict:
    """Probe Tier-A (RigRun proxy). Used by /llm/status to surface a
    chip in the operator's StatusFooter."""
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


async def _probe_local() -> dict:
    """Probe Tier-B (Ollama localhost:11434). Cheap — Ollama answers
    /api/tags in <50 ms when up."""
    if LLM_LOCAL_DISABLED:
        return {"reachable": False, "disabled": True, "proxy": LLM_LOCAL_URL}
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{LLM_LOCAL_URL}/api/tags")
            if resp.status_code == 200:
                data = resp.json()
                models = [m.get("name") for m in (data.get("models") or [])]
                has_target = LLM_LOCAL_MODEL in models
                return {
                    "reachable": True,
                    "models": models,
                    "target_model": LLM_LOCAL_MODEL,
                    "target_loaded": has_target,
                    "proxy": LLM_LOCAL_URL,
                }
    except Exception as e:  # noqa: BLE001
        return {"reachable": False, "error": str(e), "proxy": LLM_LOCAL_URL}
    return {"reachable": False, "proxy": LLM_LOCAL_URL}


@router.get("/status")
async def llm_status():
    """Tier-A status. Kept compatible with the previous shape so the
    StatusFooter chip continues to render against existing callers.
    Tier-B status surfaces under `local`."""
    primary = await _probe_llm()
    local = await _probe_local()
    return {
        "time": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        **primary,
        "local": local,
        # Active tier hint — what the next call_llm_chat would land on.
        # Three-state: 'primary', 'local', 'rule' (when both fail).
        "active_tier": (
            "primary" if primary.get("reachable")
            else "local" if local.get("reachable") and local.get("target_loaded")
            else "rule"
        ),
    }


@router.get("/tiers")
async def llm_tiers():
    """Per-tier status — the StatusFooter chip uses this to render
    `LLM · 26B / E2B-LOCAL / RULE` based on which tier is currently
    serving."""
    primary = await _probe_llm()
    local = await _probe_local()
    return {
        "primary": primary,
        "local": local,
        "active_tier": (
            "primary" if primary.get("reachable")
            else "local" if local.get("reachable") and local.get("target_loaded")
            else "rule"
        ),
        "as_of": datetime.utcnow().isoformat(timespec="seconds") + "Z",
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
    # Tier-A: licensed RigRun proxy (frontier 26B). Default path,
    # unless SPIRE_LLM_PRIMARY_DISABLE=1 (air-gap pilot mode) or
    # we recently failed Tier-A (backoff cache: skip Tier-A for 30s
    # after a failure so subsequent calls don't each pay the full
    # connect-timeout before falling through).
    primary_url = os.environ.get("SPIRE_LLM_PROXY", LLM_PROXY_URL)
    primary_model = os.environ.get("SPIRE_LLM_MODEL", LLM_MODEL)
    skip_primary = LLM_PRIMARY_DISABLED or _primary_recently_failed()

    if not skip_primary:
        try:
            result = await _call_one_tier(
                base_url=primary_url,
                model=primary_model,
                tier_label="primary",
                messages=messages,
                response_format=response_format,
                temperature=temperature,
                max_tokens=max_tokens,
                tools=tools,
                tool_choice=tool_choice,
                tier=tier,
                call_site=call_site,
                role=role,
                route=route,
            )
            _clear_primary_failed()
            return result
        except HTTPException as exc:
            # Tier-A failures that warrant trying Tier-B: connection
            # refused (503), upstream gateway error (502), timeout (504).
            # 4xx is a malformed request — falling back won't help.
            if exc.status_code not in (502, 503, 504):
                raise
            _mark_primary_failed()
            if LLM_LOCAL_DISABLED or _local_recently_failed():
                raise

    # Tier-B: localhost Ollama (gemma4:e2b by default). Falls back
    # only when Tier-A is unreachable, so a normal demo with RigRun
    # online never spends a Tier-B call.
    #
    # Gemma 4 ships configurable-thinking — by default the model
    # dumps a "Thinking Process: 1. Analyze the request..." block
    # into the OpenAI-compat `reasoning` field BEFORE emitting the
    # actual answer in `content`. For SPIRE's workload (short Tier-2
    # explainer + SPIRO chat) we want answer-direct. Prepend a system
    # message that suppresses the thinking block. Only applied when
    # the caller didn't already set their own system message — we
    # don't want to override role-aware grounding (e.g. the SPIRO
    # planner's full system prompt).
    # Gemma 4 ships configurable-thinking. By default the model emits
    # a "Thinking Process: 1. Analyze the request..." block into the
    # OpenAI-compat `reasoning` field BEFORE emitting the actual answer
    # in `content`. For SPIRE's workload (Tier-2 explainer + SPIRO chat)
    # we want answer-direct.
    #
    # Always tack a no-reasoning suffix onto the system message — if
    # the caller already set one (e.g. the SENTRY explainer system
    # prompt), append; if not, insert. This keeps caller grounding
    # intact while unconditionally suppressing the thinking block.
    NO_REASONING_LINE = (
        "\n\nIMPORTANT — operate in answer-direct mode. Do not output any "
        "reasoning, thinking process, chain-of-thought, or step-by-step "
        "analysis before your answer. Output only the final answer/JSON "
        "as requested."
    )
    local_messages = list(messages or [])
    has_system_idx = next(
        (i for i, m in enumerate(local_messages) if m.get("role") == "system"),
        -1,
    )
    if has_system_idx >= 0:
        existing = local_messages[has_system_idx]
        local_messages[has_system_idx] = {
            **existing,
            "content": (existing.get("content") or "") + NO_REASONING_LINE,
        }
    else:
        local_messages.insert(0, {
            "role": "system",
            "content": "Respond directly." + NO_REASONING_LINE,
        })
    try:
        result = await _call_one_tier(
            base_url=LLM_LOCAL_URL,
            model=LLM_LOCAL_MODEL,
            tier_label="local",
            messages=local_messages,
            response_format=response_format,
            temperature=temperature,
            max_tokens=max_tokens,
            tools=tools,
            tool_choice=tool_choice,
            tier=tier,
            call_site=call_site,
            role=role,
            route="fallback-local",
        )
        _clear_local_failed()
        return result
    except HTTPException:
        _mark_local_failed()
        raise


async def _call_one_tier(
    *,
    base_url: str,
    model: str,
    tier_label: str,
    messages: list,
    response_format: Optional[dict],
    temperature: float,
    max_tokens: int,
    tools: Optional[list],
    tool_choice: Optional[Any],
    tier: str,
    call_site: str,
    role: Optional[str],
    route: str,
) -> dict:
    """Single-tier LLM call. Owns the HTTP round-trip + cost
    bookkeeping for one upstream. Raises HTTPException on any
    failure so the parent router can decide whether to fall through."""
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
                f"{base_url}/v1/chat/completions",
                json=payload,
                headers=headers,
            )
    except httpx.RequestError as exc:
        latency_ms = (time.perf_counter() - started) * 1000
        record_call(
            tier=tier, model=rate_card_label,
            input_tokens=0, output_tokens=0,
            latency_ms=latency_ms, call_site=call_site,
            route=f"{route}/{tier_label}", role=role,
            error=f"{tier_label} unreachable: {type(exc).__name__}",
        )
        raise HTTPException(status_code=503, detail=f"LLM {tier_label} unreachable: {exc}")

    latency_ms = (time.perf_counter() - started) * 1000

    if resp.status_code != 200:
        record_call(
            tier=tier, model=rate_card_label,
            input_tokens=0, output_tokens=0,
            latency_ms=latency_ms, call_site=call_site,
            route=f"{route}/{tier_label}", role=role,
            error=f"{tier_label} {resp.status_code}",
        )
        raise HTTPException(
            status_code=502 if resp.status_code >= 500 else resp.status_code,
            detail=f"LLM {tier_label} error {resp.status_code}: {resp.text[:200]}",
        )

    body = resp.json()
    msg0 = body.get("choices", [{}])[0].get("message", {}) or {}
    content = msg0.get("content", "") or ""
    # Gemma 4's configurable-thinking sometimes ignores our "no
    # reasoning" suffix and emits the entire response into the
    # `reasoning` field with `content` empty. When that happens
    # the user sees nothing despite tokens having been generated
    # and billed. Fall back to reasoning if content is empty —
    # lossy (the operator sees the thinking + answer concatenated)
    # but better than a silent empty box. Tier-A (RigRun 26B) never
    # hits this path because its chat template doesn't emit a
    # separate reasoning field.
    if not content.strip():
        reasoning = msg0.get("reasoning") or ""
        if reasoning.strip():
            content = reasoning
    usage = body.get("usage", {}) or {}
    input_tokens = int(usage.get("prompt_tokens") or 0)
    output_tokens = int(usage.get("completion_tokens") or 0)
    cost_entry = record_call(
        tier=tier, model=rate_card_label,
        input_tokens=input_tokens, output_tokens=output_tokens,
        latency_ms=latency_ms, call_site=call_site,
        route=f"{route}/{tier_label}", role=role,
    )
    return {
        "content": content,
        "raw": body,
        "usage": usage,
        "finish_reason": body.get("choices", [{}])[0].get("finish_reason"),
        "economics": {
            "tier": tier,
            "model": rate_card_label,
            "call_site": call_site,
            "route": f"{route}/{tier_label}",
            "served_by": tier_label,  # primary | local
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
