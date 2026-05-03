"""Side-by-side local LLM benchmark — gemma4:e2b vs gemma4:e4b on Lunar Lake.

Hits Ollama's /api/chat with `"think": false` (matches the SPIRE Tier-B
caller in backend/routes/llm.py). Measures:
  - first-token latency (time to first non-empty content stream chunk)
  - tokens/sec on completion
  - tool-call structure: did the model emit valid JSON the planner can
    use, and did it select the right tool/args?

Run:
  python scripts/bench_local_llm.py
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from dataclasses import dataclass
from typing import Any

OLLAMA_URL = "http://127.0.0.1:11434/api/chat"

SYSTEM_PROMPT = (
    "You are SPIRO, the SPIRE planning assistant. When the operator asks you "
    "to find a cannibalization donor, propose a tool call as a JSON object on "
    "its own line:\n"
    '{"tool": "find_cannib_donor", "args": {"recipient_asset_id": "..."}}\n'
    "Do not explain. Output only the JSON object."
)

USER_PROMPT = "Find a cannib donor for M21670-MTVR_CARGO-006."


@dataclass
class Result:
    model: str
    first_token_ms: float | None
    total_ms: float
    completion_text: str
    completion_tokens: int
    tok_per_sec: float
    tool_call_parsed: dict[str, Any] | None
    tool_call_valid: bool
    error: str | None = None


def _bench(model: str) -> Result:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": USER_PROMPT},
        ],
        "stream": True,
        "think": False,  # Suppress Gemma's reasoning channel.
        "options": {"temperature": 0.0, "num_predict": 256},
    }
    req = urllib.request.Request(
        OLLAMA_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    started = time.perf_counter()
    first_token_at: float | None = None
    completion = []
    completion_tokens = 0
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            for raw in resp:
                if not raw:
                    continue
                try:
                    chunk = json.loads(raw.decode("utf-8"))
                except json.JSONDecodeError:
                    continue
                msg = chunk.get("message") or {}
                piece = msg.get("content") or ""
                if piece:
                    if first_token_at is None:
                        first_token_at = time.perf_counter()
                    completion.append(piece)
                    completion_tokens += 1  # rough — Ollama emits per-token-ish chunks
                if chunk.get("done"):
                    break
    except Exception as e:
        return Result(
            model=model,
            first_token_ms=None,
            total_ms=(time.perf_counter() - started) * 1000,
            completion_text="",
            completion_tokens=0,
            tok_per_sec=0.0,
            tool_call_parsed=None,
            tool_call_valid=False,
            error=repr(e),
        )

    total_s = time.perf_counter() - started
    text = "".join(completion).strip()
    first_token_ms = (
        (first_token_at - started) * 1000 if first_token_at is not None else None
    )
    tok_per_sec = completion_tokens / total_s if total_s > 0 else 0.0

    # Try to extract a tool call. We accept either:
    #   - bare JSON object on its own line
    #   - JSON wrapped in ```json … ``` fences
    parsed = _extract_tool_call(text)
    valid = (
        parsed is not None
        and isinstance(parsed, dict)
        and parsed.get("tool") == "find_cannib_donor"
        and isinstance(parsed.get("args"), dict)
        and parsed.get("args", {}).get("recipient_asset_id") == "M21670-MTVR_CARGO-006"
    )

    return Result(
        model=model,
        first_token_ms=first_token_ms,
        total_ms=total_s * 1000,
        completion_text=text,
        completion_tokens=completion_tokens,
        tok_per_sec=tok_per_sec,
        tool_call_parsed=parsed,
        tool_call_valid=valid,
        error=None,
    )


def _extract_tool_call(text: str) -> dict[str, Any] | None:
    """Find a JSON object in the completion. Tolerant of code fences."""
    cleaned = text
    # Strip ``` fences
    if "```" in cleaned:
        parts = cleaned.split("```")
        for part in parts:
            stripped = part.strip()
            if stripped.startswith("json"):
                stripped = stripped[4:].strip()
            if stripped.startswith("{"):
                try:
                    return json.loads(stripped)
                except json.JSONDecodeError:
                    pass
    # Look for the first { ... } that parses
    depth = 0
    start = -1
    for i, ch in enumerate(cleaned):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                blob = cleaned[start : i + 1]
                try:
                    return json.loads(blob)
                except json.JSONDecodeError:
                    start = -1
    return None


def _print_result(r: Result) -> None:
    print(f"=== {r.model} ===")
    if r.error:
        print(f"  ERROR: {r.error}")
        return
    ftt = f"{r.first_token_ms:.0f}ms" if r.first_token_ms is not None else "n/a"
    print(f"  first-token latency: {ftt}")
    print(f"  total latency:       {r.total_ms:.0f}ms")
    print(f"  completion tokens:   {r.completion_tokens}")
    print(f"  tok/s (avg):         {r.tok_per_sec:.1f}")
    print(f"  tool-call parsed:    {r.tool_call_parsed is not None}")
    print(f"  tool-call valid:     {r.tool_call_valid}")
    print(f"  completion text:")
    for line in r.completion_text.splitlines()[:12]:
        print(f"    | {line}")
    if len(r.completion_text.splitlines()) > 12:
        print(f"    | ... ({len(r.completion_text)} chars total)")


def main() -> int:
    print("Benchmark: gemma4 e2b vs e4b on Lunar Lake CPU (Ollama)")
    print(f"prompt: {USER_PROMPT!r}\n")

    # Models can step on each other's memory layout when both are
    # loaded. Unload via keep_alive=0 between models; the cold-load
    # cost shows up in total_ms but not in `tok_per_sec` (we measure
    # post-first-token throughput separately).
    results = []
    for model in ("gemma4:e2b", "gemma4:e4b"):
        # Warmup — one-time mmap + KV cache init artificially inflates
        # first-token. Skip for models that fail to load (warmup error
        # is the same as bench error; capture and move on).
        warmup = _bench(model)
        if warmup.error and "memory" in (warmup.error or "").lower():
            results.append(warmup)
            _print_result(warmup)
            print()
            continue
        r = _bench(model)
        results.append(r)
        _print_result(r)
        print()
        # Unload so next model has the full memory layout to itself.
        try:
            urllib.request.urlopen(
                urllib.request.Request(
                    "http://127.0.0.1:11434/api/generate",
                    data=json.dumps({"model": model, "keep_alive": 0}).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                ),
                timeout=10,
            )
        except Exception:
            pass

    print("=== summary ===")
    for r in results:
        ftt = f"{r.first_token_ms:.0f}ms" if r.first_token_ms is not None else "n/a"
        flag = "OK" if r.tool_call_valid else "BAD"
        print(
            f"  {r.model:14}  ftt={ftt:>7}  tps={r.tok_per_sec:>5.1f}  "
            f"tool={flag}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
