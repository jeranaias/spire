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

def _is_deadlined(asset) -> bool:
    """Truth check for "is this asset deadlined right now?" — uses the
    canonical current_status field (MC / PMC / NMCS / NMCM) emitted by
    the lifecycle simulation. Anything starting with NMC means the asset
    is non-mission-capable / deadlined.

    Reviewer caught the prior implementation using a non-existent
    is_deadlined attribute via getattr default-False, which made every
    "deadlined" check silently return zero — including SPIRO's
    status_summary saying deadlined_in_scope: 0 while the alert stream
    showed 14 NMCS units. This single helper is now the source of truth.
    """
    status = getattr(asset, "current_status", "") or ""
    return status.startswith("NMC")


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
        "current_status": getattr(asset, "current_status", "unknown"),
        "hours": getattr(asset, "current_hours", None),
        "deadlined": _is_deadlined(asset),
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
                "deadlined": _is_deadlined(a),
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
        if _is_deadlined(donor):
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


async def _tool_recommend_actions(unit: Optional[str] = None, role: str = "mef_commander", top: int = 5) -> dict:
    """Return ranked replenishment recommendations for a unit (GC-1).

    The endpoint returns `{"assets": [{asset_id, unit_name, actions: [...]}]}`,
    one block per at-risk asset. We flatten that into a single ranked list
    of actions for the LLM, preserving per-asset context so SPIRO can answer
    "what should I do" without losing which asset each action targets.

    `unit` is optional — when omitted the underlying handler returns the
    operator's whole-scope ranking. Earlier versions of this wrapper read
    `result.actions` (using getattr on a coroutine), which always evaluated
    to `[]` and reported "no recommendations" even with 39 deadlined assets
    in scope — caught live during walkthrough audit on 2026-04-26.
    """
    from ..routes.pulse import recommend_actions  # lazy import to avoid cycles
    try:
        result = await recommend_actions(unit=unit, asset_id=None, top=top, role=role)
        if not isinstance(result, dict):
            return {"actions": [], "unit": unit, "count": 0,
                    "warning": "handler returned unexpected type"}

        flat: list[dict] = []
        for blk in result.get("assets", []):
            ctx = {"asset_id": blk.get("asset_id"),
                   "unit_name": blk.get("unit_name"),
                   "equipment_type": blk.get("equipment_type")}
            for act in blk.get("actions", []):
                flat.append({**act, **ctx})
        flat.sort(key=lambda a: a.get("score", 0), reverse=True)
        flat = flat[:top]
        return {
            "actions": flat,
            "unit": unit or "all in scope",
            "count": len(flat),
            "as_of": result.get("as_of"),
        }
    except Exception as e:  # noqa: BLE001
        return {"error": f"recommend_actions failed: {type(e).__name__}: {e}"}


async def _tool_predict_failures(unit: Optional[str] = None, role: str = "mef_commander", horizon_days: int = 14) -> dict:
    """Predict component-level failures within a horizon (GC-3).

    `unit` is optional — when omitted, falls back to whole-scope.

    Earlier versions called `predict_failures` (an async handler) without
    await and read `.predictions` off the coroutine, which always returned
    `[]`. Same bug as `_tool_recommend_actions`; fixed alongside it.
    """
    from ..routes.pulse import predict_failures
    try:
        result = await predict_failures(unit=unit, asset_id=None, horizon_days=horizon_days, threshold=0.4, role=role)
        if not isinstance(result, dict):
            return {"predictions": [], "horizon_days": horizon_days,
                    "warning": "handler returned unexpected type"}
        return {
            "predictions": result.get("predictions", []),
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


_TOOL_PROFILE_ALIASES = {
    "japan": "JPN_COALITION", "jpn": "JPN_COALITION", "jsdf": "JPN_COALITION",
    "australia": "AUS_COALITION", "aus": "AUS_COALITION", "adf": "AUS_COALITION",
    "philippines": "PHL_COALITION", "phl": "PHL_COALITION", "afp": "PHL_COALITION",
    "fvey": "FVEY_BASE", "five eyes": "FVEY_BASE",
    "fvey-log": "FVEY_LOG", "fvey log": "FVEY_LOG",
}


async def _tool_get_coalition_view(profile: str, role: str = "data_custodian") -> dict:
    """Preview the redacted dataset visible to a coalition partner (GC-5).

    Walkthrough audit (same class as recommend_actions / predict_failures
    earlier): coalition_view is `async def`. The previous wrapper called
    it synchronously and treated the returned coroutine as a result
    object — every getattr returned the default, so the tool reported
    'no profile / no partners / no units' regardless of input.

    Defense-in-depth: if Gemma sends a short alias ("JPN", "Japan",
    "FVEY") the canonicalizer maps it to the full backend key. The
    planner regex catches this on the rule-based path; this catches
    it on the LLM-tool-call path.
    """
    from ..routes.sentry import coalition_view
    canonical = _TOOL_PROFILE_ALIASES.get(profile.lower().strip(), profile)
    try:
        result = await coalition_view(profile_key=canonical)
        if isinstance(result, dict):
            return {
                "profile": canonical,
                "display_name": result.get("display_name"),
                "distribution_statement": result.get("distribution_statement"),
                "partners": result.get("partners", []),
                "allowed_units": result.get("allowed_units", []),
                "unit_count": len(result.get("allowed_units", [])),
                "sample_count": len(result.get("sample_records", [])),
                "caveats_applied": result.get("caveats_applied", []),
            }
        return {
            "profile": canonical,
            "distribution_statement": getattr(result, "distribution_statement", None),
            "partners": getattr(result, "partners", []),
            "allowed_units": getattr(result, "allowed_units", []),
        }
    except Exception as e:  # noqa: BLE001
        return {"error": f"coalition_view failed: {type(e).__name__}: {e}"}


def _tool_status_summary(role: str) -> dict:
    """High-level system status for context — uses the canonical end-of-day
    readiness snapshot (MC / PMC / NMCM / NMCS) so SPIRO's answers can never
    disagree with the COP map or the alert stream.

    Walkthrough caught the prior version computing MC% from the asset's
    `current_status` field and treating "anything not deadlined" as MC,
    which counts PMC as MC. SPIRO then echoed "CLB-6 90.0%, 63/70 ops"
    while the map and alerts said 55.7%, 39/70. Strict MC only — PMC is
    its own state.
    """
    from collections import Counter
    from ..state import last_day_snapshots
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    last = last_day_snapshots(ds)
    if not last:
        return {"error": "canonical snapshot empty"}
    in_scope = last if allowed is None else [s for s in last if s.unit_name in allowed]

    by_unit: dict[str, Counter] = {}
    for s in in_scope:
        by_unit.setdefault(s.unit_name, Counter())[s.readiness_code] += 1

    rows = []
    for unit_name, c in by_unit.items():
        total = sum(c.values())
        mc = c.get("MC", 0)
        pmc = c.get("PMC", 0)
        nmcm = c.get("NMCM", 0)
        nmcs = c.get("NMCS", 0)
        deadlined = nmcm + nmcs
        rows.append({
            "unit": unit_name,
            "total": total,
            "mc": mc,
            "pmc": pmc,
            "nmcm": nmcm,
            "nmcs": nmcs,
            "deadlined": deadlined,
            "mc_pct": round((mc / total) * 100, 1) if total else 100,
        })
    # Worst three units by *strict* MC% (lowest first), tie-broken by deadlined count.
    worst = sorted(rows, key=lambda x: (x["mc_pct"], -x["deadlined"]))[:3]

    deadlined_snaps = [s for s in in_scope if s.readiness_code in ("NMCM", "NMCS")]
    return {
        "your_assets": len(in_scope),
        "total_units": len(ds.units),
        "your_units": "all" if allowed is None else sorted(allowed),
        "deadlined_in_scope": len(deadlined_snaps),
        "worst_units": worst,
        "deadlined_examples": [
            {"asset_id": s.asset_id, "unit": s.unit_name, "equipment": s.equipment_type, "status": s.readiness_code}
            for s in deadlined_snaps[:5]
        ],
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
                # Walkthrough audit: prior enum used short codes ('JPN' /
                # 'AUS' / 'PHL') so Gemma's tool_call carried those through
                # to coalition_view, which expects the full keys from
                # coalition_profiles.json ('JPN_COALITION' / 'AUS_COALITION'
                # / 'PHL_COALITION'). 'what does Japan see?' returned
                # 'unknown profile JPN'. Enum now matches the backend.
                "description": "Preview the redacted dataset visible to a coalition partner (GC-5). Returns distribution statement, partners, and unit visibility counts. Profile is one of FVEY_BASE, FVEY_LOG, JPN_COALITION, AUS_COALITION, PHL_COALITION.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "profile": {"type": "string", "enum": ["FVEY_BASE", "FVEY_LOG", "JPN_COALITION", "AUS_COALITION", "PHL_COALITION"]},
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


async def run_tool(name: str, args: dict, role: str) -> dict:
    """Execute one tool call. Always returns a dict; on error returns {error}.

    Some tool runners are sync, some are `async def`, and some are sync
    but happen to return a coroutine object (because they call an async
    FastAPI handler under the hood). This dispatcher awaits whichever
    shape we get. Callers must `await` `run_tool(...)`.
    """
    import asyncio, inspect
    entry = TOOL_REGISTRY.get(name)
    if entry is None:
        return {"error": f"unknown tool {name!r}"}
    runner = entry["runner"]
    try:
        kwargs = dict(args or {})
        sig = inspect.signature(runner)
        if "role" in sig.parameters:
            kwargs["role"] = role
        result = runner(**kwargs)
        if asyncio.iscoroutine(result):
            result = await result
        return result
    except TypeError as e:
        return {"error": f"argument error: {e}"}
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"}


def tools_for_planner() -> list:
    """Return the JSON-schema function list for the LLM call."""
    return [entry["definition"] for entry in TOOL_REGISTRY.values()]
