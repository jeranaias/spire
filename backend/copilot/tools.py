"""Tool registry — JSON-schema function definitions Gemma 4 can call.

Each tool wraps an existing SPIRE endpoint or in-process helper. The
schema descriptions are written for the LLM (not the human), so they're
prescriptive about when and how to use each one.

Adding a tool: implement the runtime in `_tool_*`, register it in
`TOOL_REGISTRY` with its OpenAI-style function definition, and the
co-pilot picks it up automatically.

Role-scope enforcement: each tool calls into the same `scoping.py` /
`require_role` paths the regular routes use. So an operator's co-pilot
can never reach data its role already couldn't.
"""
from __future__ import annotations

from typing import Any, Optional

from ..state import get_dataset
from ..scoping import allowed_units, COALITION_RELEASE_ROLES


# ---------------------------------------------------------------------------
# Tool implementations — return JSON-serializable dicts on success, or
# {"error": "..."} on failure. Never raise; the planner expects every tool
# call to return a dict so it can stitch the result block back to Gemma.
# ---------------------------------------------------------------------------

def _tool_find_asset(asset_id: str, role: str) -> dict:
    """Look up one asset by id with role-scoped visibility."""
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    asset = next((a for a in ds.assets if a.asset_id == asset_id), None)
    if asset is None:
        return {"error": f"asset {asset_id!r} not found"}
    if allowed is not None and asset.unit_name not in allowed:
        return {"error": f"asset {asset_id} is outside your role's scope"}
    return {
        "asset_id": asset.asset_id,
        "equipment_type": asset.equipment_type,
        "unit_name": asset.unit_name,
        "serial_number": asset.serial_number,
        "current_state": getattr(asset, "current_state", "unknown"),
        "hours": getattr(asset, "current_hours", None),
        "deadlined": getattr(asset, "is_deadlined", False),
    }


def _tool_search_assets(query: str, role: str, limit: int = 10) -> dict:
    """Free-text fuzzy match across asset id, serial, equipment type, unit."""
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    q = query.lower().strip()
    hits = []
    for a in ds.assets:
        if allowed is not None and a.unit_name not in allowed:
            continue
        haystack = f"{a.asset_id} {a.equipment_type} {a.unit_name} {a.serial_number}".lower()
        if q in haystack:
            hits.append({
                "asset_id": a.asset_id,
                "equipment_type": a.equipment_type,
                "unit_name": a.unit_name,
                "deadlined": getattr(a, "is_deadlined", False),
            })
        if len(hits) >= limit:
            break
    return {"matches": hits, "count": len(hits), "query": query}


def _tool_find_cannibalization_match(recipient_asset_id: str, role: str) -> dict:
    """Find compatible cannibalization donors for a deadlined asset."""
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    recipient = next((a for a in ds.assets if a.asset_id == recipient_asset_id), None)
    if recipient is None:
        return {"error": f"asset {recipient_asset_id!r} not found"}
    if allowed is not None and recipient.unit_name not in allowed:
        return {"error": f"recipient {recipient_asset_id} is outside scope"}
    candidates = []
    for donor in ds.assets:
        if donor.asset_id == recipient.asset_id:
            continue
        if donor.equipment_type != recipient.equipment_type:
            continue
        if allowed is not None and donor.unit_name not in allowed:
            continue
        if getattr(donor, "is_deadlined", False):
            continue
        candidates.append({
            "donor_asset_id": donor.asset_id,
            "unit_name": donor.unit_name,
            "current_hours": getattr(donor, "current_hours", None),
        })
        if len(candidates) >= 5:
            break
    return {
        "recipient": recipient_asset_id,
        "equipment_type": recipient.equipment_type,
        "candidates": candidates,
        "count": len(candidates),
    }


def _tool_recommend_actions(unit: Optional[str] = None, role: str = "mef_commander", top: int = 5) -> dict:
    """Return ranked replenishment recommendations for a unit (GC-1).

    `unit` is optional — when omitted, the underlying handler returns the
    operator's whole-scope ranking. The previous signature treated unit as
    required which broke LLM tool-calls that omitted it.
    """
    from ..routes.pulse import recommend_actions  # lazy import to avoid cycles
    try:
        result = recommend_actions(unit=unit, asset_id=None, top=top, role=role)
        actions = getattr(result, "actions", None)
        if actions is None and isinstance(result, dict):
            actions = result.get("actions", [])
        return {"actions": actions or [], "unit": unit, "count": len(actions or [])}
    except Exception as e:  # noqa: BLE001
        return {"error": f"recommend_actions failed: {type(e).__name__}: {e}"}


def _tool_predict_failures(unit: Optional[str] = None, role: str = "mef_commander", horizon_days: int = 14) -> dict:
    """Predict component-level failures within a horizon (GC-3).

    `unit` is optional — when omitted, falls back to whole-scope.
    """
    from ..routes.pulse import predict_failures
    try:
        result = predict_failures(unit=unit, asset_id=None, horizon_days=horizon_days, threshold=0.4, role=role)
        return {
            "predictions": getattr(result, "predictions", []) or result.get("predictions", []),
            "horizon_days": horizon_days,
        }
    except Exception as e:  # noqa: BLE001
        return {"error": f"predict_failures failed: {type(e).__name__}: {e}"}


def _tool_parse_tmr(text: str) -> dict:
    """Parse a natural-language TMR via the LLM extractor."""
    import asyncio
    from ..routes.tmr import parse_tmr_text_llm
    try:
        # We're called from within an async context; the planner wraps
        # in asyncio.run if needed.
        coro = parse_tmr_text_llm(text)
        if asyncio.iscoroutine(coro):
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    # Nested call — already inside an async route. Schedule
                    # via run_until_complete won't work. Defer to caller.
                    return {"_async_coroutine": coro}
            except RuntimeError:
                pass
        return {"error": "tmr_parse must be called via async dispatch"}
    except Exception as e:  # noqa: BLE001
        return {"error": f"parse_tmr failed: {type(e).__name__}: {e}"}


def _tool_get_coalition_view(profile: str, role: str = "data_custodian") -> dict:
    """Preview the redacted dataset visible to a coalition partner (GC-5)."""
    from ..routes.sentry import coalition_view
    try:
        result = coalition_view(profile_key=profile)
        return {
            "profile": profile,
            "distribution_statement": getattr(result, "distribution_statement", None),
            "partners": getattr(result, "partners", []),
            "units_allowed": getattr(result, "units_allowed", []),
            "units_blocked_count": len(getattr(result, "units_blocked", [])),
        }
    except Exception as e:  # noqa: BLE001
        return {"error": f"coalition_view failed: {type(e).__name__}: {e}"}


def _tool_status_summary(role: str) -> dict:
    """High-level system status for context — useful for `summarize_view`."""
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    in_scope = ds.assets if allowed is None else [a for a in ds.assets if a.unit_name in allowed]
    return {
        "your_assets": len(in_scope),
        "total_units": len(ds.units),
        "your_units": "all" if allowed is None else sorted(allowed),
        "deadlined_in_scope": sum(1 for a in in_scope if getattr(a, "is_deadlined", False)),
    }


# ---------------------------------------------------------------------------
# Schema definitions — what the LLM sees as available functions.
# ---------------------------------------------------------------------------

TOOL_REGISTRY: dict[str, dict] = {
    "find_asset": {
        "definition": {
            "type": "function",
            "function": {
                "name": "find_asset",
                "description": "Look up one asset by its asset_id (e.g. 'M21670-MTVR_CARGO-006'). Returns equipment type, unit, serial, current hours, and deadline status.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "asset_id": {"type": "string", "description": "Asset id, e.g. 'M21670-MTVR_CARGO-006'"},
                    },
                    "required": ["asset_id"],
                },
            },
        },
        "runner": _tool_find_asset,
    },
    "search_assets": {
        "definition": {
            "type": "function",
            "function": {
                "name": "search_assets",
                "description": "Free-text search across asset id, serial, equipment type, and unit. Returns up to 10 matches in role scope.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Free-text query, e.g. 'MTVR' or 'CLB-6 deadlined' or 'JLTV'"},
                        "limit": {"type": "integer", "description": "Max matches (default 10)"},
                    },
                    "required": ["query"],
                },
            },
        },
        "runner": _tool_search_assets,
    },
    "find_cannibalization_match": {
        "definition": {
            "type": "function",
            "function": {
                "name": "find_cannibalization_match",
                "description": "Given a deadlined recipient asset, return up to 5 compatible donor assets the operator could cannibalize from. Filters by equipment type and excludes already-deadlined donors.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "recipient_asset_id": {"type": "string", "description": "Asset id of the deadlined recipient"},
                    },
                    "required": ["recipient_asset_id"],
                },
            },
        },
        "runner": _tool_find_cannibalization_match,
    },
    "recommend_actions": {
        "definition": {
            "type": "function",
            "function": {
                "name": "recommend_actions",
                "description": "Return ranked GC-1 replenishment recommendations (cannibalize / expedite / cross-level) for a unit. Each action shows MC delta, cost, ETA.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "unit": {"type": "string", "description": "Unit name (e.g. 'CLB-6'). Omit for whole-scope."},
                        "top": {"type": "integer", "description": "Max actions to return (default 5)"},
                    },
                },
            },
        },
        "runner": _tool_recommend_actions,
    },
    "predict_failures": {
        "definition": {
            "type": "function",
            "function": {
                "name": "predict_failures",
                "description": "GC-3 component-level failure prediction within a horizon (days). Returns predictions sorted by criticality.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "unit": {"type": "string", "description": "Unit name. Omit for whole-scope."},
                        "horizon_days": {"type": "integer", "description": "Horizon in days (default 14)"},
                    },
                },
            },
        },
        "runner": _tool_predict_failures,
    },
    "get_coalition_view": {
        "definition": {
            "type": "function",
            "function": {
                "name": "get_coalition_view",
                "description": "Preview the redacted dataset visible to a coalition partner (GC-5). Returns distribution statement, partners, and unit visibility counts. Profile is one of FVEY_BASE, FVEY_LOG, JPN, AUS, PHL.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "profile": {"type": "string", "enum": ["FVEY_BASE", "FVEY_LOG", "JPN", "AUS", "PHL"]},
                    },
                    "required": ["profile"],
                },
            },
        },
        "runner": _tool_get_coalition_view,
    },
    "status_summary": {
        "definition": {
            "type": "function",
            "function": {
                "name": "status_summary",
                "description": "High-level scope summary for the operator: how many assets they see, which units, how many are deadlined. Useful when the operator asks 'what's going on?' or 'where do I start?'",
                "parameters": {"type": "object", "properties": {}},
            },
        },
        "runner": _tool_status_summary,
    },
}


def run_tool(name: str, args: dict, role: str) -> dict:
    """Execute one tool call. Always returns a dict; on error returns {error}."""
    entry = TOOL_REGISTRY.get(name)
    if entry is None:
        return {"error": f"unknown tool {name!r}"}
    runner = entry["runner"]
    # Inject role into the runtime call. Tools that don't take role just
    # ignore the kwarg.
    try:
        kwargs = dict(args or {})
        # Walk the runner's signature to pass role only if accepted.
        import inspect
        sig = inspect.signature(runner)
        if "role" in sig.parameters:
            kwargs["role"] = role
        return runner(**kwargs)
    except TypeError as e:
        return {"error": f"argument error: {e}"}
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"}


def tools_for_planner() -> list:
    """Return the JSON-schema function list for the LLM call."""
    return [entry["definition"] for entry in TOOL_REGISTRY.values()]
