"""
LLM proxy + Gemma4 client wrapper.

All SPIRE LLM calls flow through RigRun's classification-proxy on port 8095
which wraps Gemma 4 26B A4B FP8 with the 5-pillar ENFORCE stack:
  - HMAC audit logging
  - Argus spillage scanner
  - Tribunal cross-check (SECRET+)
  - Action Gate
  - Hallucination probe

Headers required by the proxy:
  X-Caller-Clearance: UNCLASS
  X-Classification: UNCLASS

Context window: 524288 (512K) today, 1048576 (1M) after the 500K needle
validation passes. Do NOT advertise 1M to users until the config bump lands.
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException

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
) -> dict:
    """Call the LLM chat completion endpoint via classification-proxy.

    Every call is:
      - temperature 0 by default (demo determinism)
      - logged to the HMAC audit chain by the proxy
      - spillage-scanned and hallucination-probed

    Raises HTTPException(503) if the proxy is unreachable — callers should
    gracefully degrade to Lite Mode.

    Reads SPIRE_LLM_PROXY/SPIRE_LLM_MODEL from env at call time (not module
    import) so secret rotation via Fly takes effect without restart.

    `tools` + `tool_choice` enable OpenAI-style function calling for the
    co-pilot planner. Pass tools=None for plain chat.
    """
    proxy_url = os.environ.get("SPIRE_LLM_PROXY", LLM_PROXY_URL)
    model = os.environ.get("SPIRE_LLM_MODEL", LLM_MODEL)
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
    try:
        async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
            resp = await client.post(
                f"{proxy_url}/v1/chat/completions",
                json=payload,
                headers=headers,
            )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=503, detail=f"LLM proxy unreachable: {exc}")

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"LLM proxy error {resp.status_code}: {resp.text[:200]}")

    body = resp.json()
    content = body.get("choices", [{}])[0].get("message", {}).get("content", "")
    return {
        "content": content,
        "raw": body,
        "usage": body.get("usage", {}),
        "finish_reason": body.get("choices", [{}])[0].get("finish_reason"),
    }


@router.post("/chat")
async def chat(payload: dict):
    messages = payload.get("messages")
    if not messages:
        raise HTTPException(status_code=400, detail="messages required")
    response_format = payload.get("response_format")
    temperature = float(payload.get("temperature", 0.0))
    max_tokens = int(payload.get("max_tokens", LLM_MAX_TOKENS))
    result = await call_llm_chat(
        messages=messages,
        response_format=response_format,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    return result
