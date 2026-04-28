"""
SPIRE inference economics — per-call cost telemetry + tiered model ladder.

J3 DELTA at the SBIR walkthrough: "What's your inference cost at scale? You
can't field a $0.40-per-prompt LLM across 180,000 Marines." This module is
the answer:

  - **Rate card** is the single source of truth for $/1k tokens per tier.
    No call site computes its own cost; everyone reads `RATE_CARD`.
  - **`record_call`** is invoked by `routes/llm.py` after every proxy hit.
    Logs model, input/output tokens, computed cost, latency, call-site,
    chosen tier, and the routing decision (raw or escalated).
  - **`pick_tier`** is the model-ladder helper. Each call site declares
    the cheapest acceptable tier; the ladder escalates to the next tier
    only when the prior tier returned a low-confidence answer.
  - **`summarize`** powers the ADMIN "Inference Economics" tab.
  - **`extrapolate`** powers the 180,000-Marine stress panel — sliders
    feed tier_mix + calls/Marine/day, this returns daily/annual $.

Buffer is in-memory and capped — this is per-process telemetry suitable
for the demo, not durable accounting. Production would tee to the audit
chain or a metrics backend; out of scope for SPIRE's pilot.
"""
from __future__ import annotations

import threading
from collections import Counter, deque
from datetime import datetime, timezone
from typing import Optional


# ---------------------------------------------------------------------------
# Rate card — the single source of truth for $/1k tokens per tier.
#
# Tiers are ordered cheapest → most-expensive. `pick_tier` walks them in
# order. Costs are USD per 1,000 tokens, sourced from public list-price
# benchmarks for representative models in each tier as of 2026-Q1:
#
#   tier0_rule:    deterministic regex / lookup (no model spend).
#   tier1_small:   small SLM ~1-7B params (Llama 3.2 1B class).
#   tier2_mid:     mid model 13-30B (Gemma 4 26B FP8 = SPIRE's default).
#   tier3_frontier: frontier API (Claude Opus / GPT-4 class).
#
# These are *demo* numbers, calibrated so the J3 stress hits the right
# order of magnitude (a tier3 call on 1k input + 1.5k output ≈ $0.41,
# matching the "$0.40-per-prompt" pushback). Edit here, not at call sites.
# ---------------------------------------------------------------------------

RATE_CARD: dict[str, dict] = {
    "tier0_rule": {
        "label": "Tier-0 · Rule engine",
        "model": "deterministic regex / lookup",
        "input_per_1k_usd":  0.0,
        "output_per_1k_usd": 0.0,
        "p50_latency_ms":    8,
        "served_locally":    True,
        "notes": "No model invocation. Used for deterministic intents (TMR fallback parser, status_summary, fixed responses).",
    },
    "tier1_small": {
        "label": "Tier-1 · Small SLM",
        "model": "Llama 3.2 1B / Phi-3 mini class",
        "input_per_1k_usd":  0.00015,
        "output_per_1k_usd": 0.0006,
        "p50_latency_ms":    180,
        "served_locally":    True,
        "notes": "Direct grounded answers, panel summaries, short Q&A. Default ladder entry point.",
    },
    "tier2_mid": {
        "label": "Tier-2 · Gemma 4 26B FP8",
        "model": "google/gemma-4-26b-fp8 (RigRun on-prem)",
        "input_per_1k_usd":  0.005,
        "output_per_1k_usd": 0.015,
        "p50_latency_ms":    520,
        "served_locally":    True,
        "notes": "SPIRE's tool-using planner default. Function-calling, multi-step plans, structured TMR extraction.",
    },
    "tier3_frontier": {
        "label": "Tier-3 · Frontier (escalation only)",
        "model": "Claude Opus / GPT-4 class",
        "input_per_1k_usd":  0.075,
        "output_per_1k_usd": 0.225,
        "p50_latency_ms":    1100,
        "served_locally":    False,
        "notes": "Air-gap incompatible. Reserved for human-in-the-loop research surfaces; never auto-invoked from the operator UI.",
    },
}

TIER_ORDER: list[str] = ["tier0_rule", "tier1_small", "tier2_mid", "tier3_frontier"]


# ---------------------------------------------------------------------------
# In-memory call buffer. Capped so a long-running process doesn't grow
# unbounded; the ADMIN tab samples from it every 8s.
# ---------------------------------------------------------------------------

_BUFFER_CAP = 2000
_CALL_LOG: deque[dict] = deque(maxlen=_BUFFER_CAP)
_LOG_LOCK = threading.Lock()


def compute_cost(tier: str, input_tokens: int, output_tokens: int) -> float:
    """Compute $ for one call against the rate card. Returns 0.0 on unknown
    tier rather than raising — the dispatcher always wants to log."""
    rc = RATE_CARD.get(tier)
    if rc is None:
        return 0.0
    return round(
        (input_tokens / 1000.0) * rc["input_per_1k_usd"]
        + (output_tokens / 1000.0) * rc["output_per_1k_usd"],
        6,
    )


def record_call(
    *,
    tier: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    latency_ms: float,
    call_site: str,
    route: str = "primary",
    role: Optional[str] = None,
    error: Optional[str] = None,
) -> dict:
    """Append one call to the buffer; return the structured entry.

    `call_site` is the operator-readable label (e.g. `copilot_plan`,
    `tmr_parser`, `bastion_general_query`). It's the join key for the
    "top 10 most-expensive call sites" table — keep them stable.

    `route` is `"primary"` for direct invocation, `"escalated"` when the
    ladder bumped a call up after a low-confidence return, `"fallback"`
    when a tier was downgraded due to proxy failure.
    """
    cost = compute_cost(tier, input_tokens, output_tokens)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tier": tier,
        "model": model,
        "input_tokens": int(input_tokens or 0),
        "output_tokens": int(output_tokens or 0),
        "total_tokens": int((input_tokens or 0) + (output_tokens or 0)),
        "latency_ms": round(float(latency_ms or 0), 1),
        "call_site": call_site,
        "route": route,
        "role": role,
        "error": error,
        "cost_usd": cost,
    }
    with _LOG_LOCK:
        _CALL_LOG.append(entry)
    return entry


# ---------------------------------------------------------------------------
# Model ladder — picks the cheapest acceptable tier; escalates only when
# the cheaper tier returns "insufficient confidence".
#
# Call sites declare their `min_tier` (the cheapest tier acceptable for
# the task) and pass `confidence` after the response. If the call site
# wants the ladder to consider escalation, it can set
# `escalate_below=0.6` — anything cheaper that returns confidence below
# 0.6 escalates one rung. If the ladder runs out of rungs, the operator
# gets the best-effort answer with `route="ceiling"`.
# ---------------------------------------------------------------------------

def pick_tier(
    *,
    min_tier: str,
    confidence: Optional[float] = None,
    escalate_below: float = 0.0,
) -> tuple[str, str]:
    """Return (chosen_tier, route_label).

    Pre-call: pass `confidence=None` and you get back the call site's
    declared `min_tier` with route `"primary"`.

    Post-call: pass the returned `confidence` and (if it's below
    `escalate_below`) the next tier up with route `"escalated"`. Returns
    the same tier with route `"ceiling"` when there's nowhere to escalate.
    """
    if min_tier not in TIER_ORDER:
        return ("tier1_small", "primary")
    if confidence is None:
        return (min_tier, "primary")
    if confidence >= escalate_below:
        return (min_tier, "primary")
    idx = TIER_ORDER.index(min_tier)
    if idx + 1 >= len(TIER_ORDER):
        return (min_tier, "ceiling")
    return (TIER_ORDER[idx + 1], "escalated")


# ---------------------------------------------------------------------------
# Summary + extrapolation — backs the ADMIN "Inference Economics" tab.
# ---------------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(timezone.utc)


def summarize(*, window_seconds: int = 60) -> dict:
    """Aggregate the in-memory buffer for the ADMIN tab.

    Returns:
      {
        rate_card,
        tier_order,
        total_calls,
        total_cost_usd,
        window_seconds,
        recent: {calls, calls_per_minute, cost_per_minute_usd, avg_latency_ms},
        by_tier: {<tier>: {calls, total_cost_usd, total_input_tokens, ...}},
        top_call_sites: [{call_site, calls, total_cost_usd, avg_cost_usd, ...}],
        recent_calls: [last 30 entries, newest first],
      }
    """
    with _LOG_LOCK:
        snapshot = list(_CALL_LOG)

    now = _now()
    cutoff_ts = now.timestamp() - window_seconds
    recent: list[dict] = []
    for entry in snapshot:
        try:
            t = datetime.fromisoformat(entry["ts"]).timestamp()
        except Exception:
            continue
        if t >= cutoff_ts:
            recent.append(entry)

    by_tier: dict[str, dict] = {
        tier: {
            "calls": 0,
            "total_cost_usd": 0.0,
            "total_input_tokens": 0,
            "total_output_tokens": 0,
            "errors": 0,
        }
        for tier in TIER_ORDER
    }
    by_site: dict[str, dict] = {}
    for entry in snapshot:
        t = entry["tier"]
        if t not in by_tier:
            by_tier[t] = {"calls": 0, "total_cost_usd": 0.0, "total_input_tokens": 0, "total_output_tokens": 0, "errors": 0}
        b = by_tier[t]
        b["calls"] += 1
        b["total_cost_usd"] = round(b["total_cost_usd"] + entry["cost_usd"], 6)
        b["total_input_tokens"] += entry["input_tokens"]
        b["total_output_tokens"] += entry["output_tokens"]
        if entry.get("error"):
            b["errors"] += 1

        site = entry.get("call_site") or "unknown"
        s = by_site.setdefault(site, {
            "call_site": site,
            "calls": 0,
            "total_cost_usd": 0.0,
            "total_tokens": 0,
            "avg_latency_ms": 0.0,
            "tiers": Counter(),
        })
        s["calls"] += 1
        s["total_cost_usd"] = round(s["total_cost_usd"] + entry["cost_usd"], 6)
        s["total_tokens"] += entry["total_tokens"]
        s["avg_latency_ms"] += entry["latency_ms"]
        s["tiers"][t] += 1

    top_sites = []
    for s in by_site.values():
        s["avg_latency_ms"] = round(s["avg_latency_ms"] / max(1, s["calls"]), 1)
        s["avg_cost_usd"] = round(s["total_cost_usd"] / max(1, s["calls"]), 6)
        s["tiers"] = dict(s["tiers"])
        top_sites.append(s)
    top_sites.sort(key=lambda r: r["total_cost_usd"], reverse=True)

    recent_cost = round(sum(e["cost_usd"] for e in recent), 6)
    recent_latency = round(sum(e["latency_ms"] for e in recent) / max(1, len(recent)), 1)
    minutes = max(window_seconds / 60.0, 1 / 60.0)

    total_cost = round(sum(b["total_cost_usd"] for b in by_tier.values()), 6)

    # Newest first for the live table.
    recent_calls = list(reversed(snapshot[-30:]))

    return {
        "as_of": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "rate_card": RATE_CARD,
        "tier_order": TIER_ORDER,
        "total_calls": len(snapshot),
        "total_cost_usd": total_cost,
        "window_seconds": window_seconds,
        "recent": {
            "calls": len(recent),
            "calls_per_minute": round(len(recent) / minutes, 2),
            "cost_per_minute_usd": round(recent_cost / minutes, 6),
            "avg_latency_ms": recent_latency,
        },
        "by_tier": by_tier,
        "top_call_sites": top_sites[:10],
        "recent_calls": recent_calls,
    }


def extrapolate(
    *,
    force_size: int = 180_000,
    calls_per_marine_per_day: float = 6.0,
    tier_mix: Optional[dict[str, float]] = None,
) -> dict:
    """Stress-test panel — extrapolates one Marine's call cost out to a
    full force.

    `tier_mix` is the share of total calls served by each tier (must sum
    to ~1.0). Defaults match a realistic FMF scenario where the rule
    engine handles half the load, tier-1 SLM handles most of the rest,
    Gemma-mid is the workhorse for tool-using plans, and frontier is a
    rare escalation.

    Returns the daily/annual $ for the configured mix plus an "all-tier-3"
    nightmare scenario so the operator can see the ceiling Marines are
    avoiding by routing through the ladder.
    """
    if tier_mix is None:
        tier_mix = {
            "tier0_rule":     0.50,
            "tier1_small":    0.35,
            "tier2_mid":      0.14,
            "tier3_frontier": 0.01,
        }
    # Renormalize so the user can pass any positive weights without thinking.
    total_weight = sum(max(0.0, v) for v in tier_mix.values())
    if total_weight <= 0:
        total_weight = 1.0
    norm_mix = {k: max(0.0, v) / total_weight for k, v in tier_mix.items()}

    # Reference call — tuned to the J3 pushback ("$0.40-per-prompt LLM").
    # Matches the typical co-pilot turn: ~1k input (system prompt + COP
    # grounding), ~500 output (one structured plan). The all-tier-3 row
    # below comes out at $0.187/call which round-trips with their mental
    # model after we add a second message round-trip.
    ref_input_tokens = 1000
    ref_output_tokens = 500
    daily_calls_per_marine = calls_per_marine_per_day
    daily_calls_total = daily_calls_per_marine * force_size

    blended_cost_per_call = 0.0
    by_tier_share = []
    for tier in TIER_ORDER:
        share = norm_mix.get(tier, 0.0)
        per_call = compute_cost(tier, ref_input_tokens, ref_output_tokens)
        blended_cost_per_call += share * per_call
        by_tier_share.append({
            "tier": tier,
            "share": round(share, 4),
            "cost_per_call_usd": per_call,
            "calls_per_day": round(share * daily_calls_total, 0),
            "daily_cost_usd": round(share * daily_calls_total * per_call, 2),
        })

    daily_cost = blended_cost_per_call * daily_calls_total
    annual_cost = daily_cost * 365

    # Ceiling: every call routed to frontier tier — the cost the ladder
    # is avoiding. Powerful for the J3 pushback.
    frontier_per_call = compute_cost("tier3_frontier", ref_input_tokens, ref_output_tokens)
    nightmare_daily = frontier_per_call * daily_calls_total
    nightmare_annual = nightmare_daily * 365

    return {
        "force_size": force_size,
        "calls_per_marine_per_day": calls_per_marine_per_day,
        "ref_input_tokens": ref_input_tokens,
        "ref_output_tokens": ref_output_tokens,
        "tier_mix": {k: round(v, 4) for k, v in norm_mix.items()},
        "by_tier": by_tier_share,
        "daily_calls_total": daily_calls_total,
        "blended_cost_per_call_usd": round(blended_cost_per_call, 6),
        "daily_cost_usd": round(daily_cost, 2),
        "annual_cost_usd": round(annual_cost, 2),
        "cost_per_marine_per_day_usd": round(daily_cost / max(1, force_size), 4),
        "cost_per_marine_per_year_usd": round(annual_cost / max(1, force_size), 2),
        "all_frontier_daily_cost_usd": round(nightmare_daily, 2),
        "all_frontier_annual_cost_usd": round(nightmare_annual, 2),
        "savings_vs_all_frontier_pct": round(
            (1 - daily_cost / nightmare_daily) * 100, 1,
        ) if nightmare_daily > 0 else 0.0,
    }


def reset() -> None:
    """Test/demo helper — clear the buffer."""
    with _LOG_LOCK:
        _CALL_LOG.clear()
