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

    Live walkthrough audit 2026-04-30: prior shape read `result.predictions`
    but the route actually returns `assets: [{asset_id, unit_name,
    equipment_type, predictions: [...]}, ...]`. So the runner shipped
    silently empty for every call. Now flattens to a ranked list of
    component-level predictions tagged with their owning asset, sorted
    by probability descending. Threshold dropped from 0.4 to 0.2 — the
    rule-based engine outputs sparse high-probability hits at 0.4 even
    when the dataset has plenty of medium-risk assets, leaving SPIRO
    with nothing to surface; 0.2 lets the realistic mid-band through.
    """
    from ..routes.pulse import predict_failures
    try:
        result = await predict_failures(unit=unit, asset_id=None, horizon_days=horizon_days, threshold=0.2, role=role)
        if not isinstance(result, dict):
            return {"predictions": [], "horizon_days": horizon_days,
                    "warning": "handler returned unexpected type"}
        assets = result.get("assets", [])
        flat: list[dict] = []
        for blk in assets:
            for pred in blk.get("predictions", []) or []:
                flat.append({
                    "asset_id":            blk.get("asset_id"),
                    "unit_name":           blk.get("unit_name"),
                    "equipment_type":      blk.get("equipment_type"),
                    "component":           pred.get("component"),
                    "probability":         pred.get("probability"),
                    "predicted_window_days": pred.get("predicted_window_days"),
                    "confidence":          pred.get("confidence"),
                    "criticality":         pred.get("criticality"),
                    "common_failure_modes": pred.get("common_failure_modes") or [],
                })
        flat.sort(key=lambda p: -(p.get("probability") or 0))
        return {
            "predictions": flat[:30],
            "asset_count": len(assets),
            "horizon_days": horizon_days,
            "engine": result.get("engine", "rule-based"),
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


async def _tool_mark_text(text: str, role: str, release_authority: str = "US_ONLY") -> dict:
    """Run the SENTRY classifier on an arbitrary draft remark and return
    the recommended marking + caveats + evidence spans. Lets SPIRO
    answer 'is this CUI?' without forcing the operator into the
    SENTRY Mark Draft tab. Mirrors POST /api/sentry/mark exactly.
    """
    from ..routes.sentry import tier1_classify, _select_distribution, SENTRY_MARK_ROLES
    from ..scoping import require_role
    require_role(role, SENTRY_MARK_ROLES, "sentry.mark.via_spiro")
    if not text or not text.strip():
        return {"error": "empty_text"}
    tier1 = tier1_classify(text.strip())
    cls = tier1["classification"]
    flags = tier1["flags"]
    distribution_letter, distribution_text = _select_distribution(cls, flags)
    return {
        "recommended_classification": cls,
        "confidence": tier1.get("confidence", 0.0),
        "flags": flags,
        "evidence": [
            {"flag": h.get("category"), "evidence": h.get("text"), "rule": h.get("rule")}
            for h in tier1.get("highlights", [])
        ],
        "distribution_statement": {"letter": distribution_letter, "text": distribution_text},
        "release_authority_requested": release_authority,
        "engine": "SENTRY pattern engine (rule-based)",
    }


async def _tool_forecast_unit(unit: Optional[str], role: str, horizon_days: int = 14) -> dict:
    """Monte Carlo readiness forecast — calls /api/pulse/forecast under
    the hood and returns the headline percentile bands + crossing
    probability so the operator gets the answer in chat without
    opening the Forecast tab.

    The full forecast payload includes 200 sample paths + per-day bands;
    we surface only the start/end of the projection envelope and the
    threshold-cross probability so the chat row stays scannable.
    """
    from ..routes.pulse import forecast as pulse_forecast
    try:
        result = await pulse_forecast(window=horizon_days, unit=unit, role=role)
    except Exception as e:  # noqa: BLE001
        return {"error": f"forecast_failed: {str(e)[:200]}"}
    if not isinstance(result, dict):
        return {"error": "forecast handler returned unexpected type"}

    history = result.get("history") or []
    proj = result.get("projection") or []
    threshold = result.get("threshold")
    cross_date = result.get("threshold_cross_date")
    cross_dir = result.get("cross_direction")

    def pct(x):
        return round(float(x) * 100, 1) if x is not None else None

    current_mc = pct(history[-1]["mc_rate"]) if history else None
    if proj:
        end = proj[-1]
        start = proj[0]
        projected_mean = pct(end["projected_mc_rate"])
        p10 = pct(end["p10"])
        p90 = pct(end["p90"])
        # Probability of crossing the threshold in the window — max
        # cross_probability across the projection days.
        p_cross = max((p["cross_probability"] for p in proj), default=0.0)
        first_cross_days = None
        if cross_date and start.get("date"):
            try:
                from datetime import date
                d0 = date.fromisoformat(start["date"])
                d1 = date.fromisoformat(cross_date)
                first_cross_days = (d1 - d0).days
            except Exception:  # noqa: BLE001
                first_cross_days = None
    else:
        projected_mean = p10 = p90 = first_cross_days = None
        p_cross = 0.0

    return {
        "unit": result.get("unit") or unit or "fleet",
        "horizon_days": horizon_days,
        "current_mc_pct": current_mc,
        "projected_mean_pct": projected_mean,
        "p10_pct": p10,
        "p90_pct": p90,
        "threshold_pct": pct(threshold) if threshold is not None else None,
        "cross_direction": cross_dir,
        "first_cross_days": first_cross_days,
        "p_cross_in_window": round(float(p_cross), 3),
        "as_of": result.get("as_of"),
    }


async def _tool_list_alerts(role: str, severity: Optional[str] = None, limit: int = 10) -> dict:
    """Return the top N active BASTION alerts in role scope, optionally
    filtered by severity. Lets SPIRO answer 'anything blowing up?' or
    'show me the criticals' without leaving the chat. Mirrors GET
    /api/bastion/alerts so an operator gets the same list they'd see on
    the COP.
    """
    from ..routes.bastion import alerts as bastion_alerts
    try:
        result = await bastion_alerts(limit=30, role=role)
    except Exception as e:  # noqa: BLE001
        return {"error": f"alerts_failed: {type(e).__name__}: {e}"}
    records = result.get("alerts", []) if isinstance(result, dict) else []
    sev = (severity or "").upper().strip()
    if sev and sev != "ALL":
        records = [r for r in records if (r.get("severity") or "").upper() == sev]
    rank = {"CRITICAL": 4, "HIGH": 3, "MODERATE": 2, "LOW": 1, "INFO": 0}
    records.sort(key=lambda r: -rank.get((r.get("severity") or "").upper(), 0))
    out = []
    for r in records[: max(1, min(limit, 30))]:
        out.append({
            "id": r.get("id"),
            "severity": r.get("severity"),
            "title": r.get("title") or r.get("message"),
            "unit": r.get("unit"),
            "kind": r.get("kind"),
            "ts": r.get("ts") or r.get("created_at"),
        })
    return {
        "count": len(out),
        "alerts": out,
        "severity_counts": result.get("severity_counts", {}) if isinstance(result, dict) else {},
    }


def _tool_walk_unit(unit: str, role: str) -> dict:
    """Composite walk: status + recommend + predict for one unit. The
    'tell me everything about CLB-1' button. SPIRO can pair this with
    map_select_marker(pulse_unit=...) and map_fly_to(pulse_unit=...)
    in the same plan to drive the full audience-facing demo beat.
    """
    from collections import Counter
    from ..state import last_day_snapshots
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    last = last_day_snapshots(ds)
    if allowed is not None and unit not in allowed:
        return {"error": f"out_of_scope: {unit}"}
    snaps = [s for s in last if s.unit_name == unit]
    if not snaps:
        return {"error": f"no_snapshots_for: {unit}"}
    c = Counter(s.readiness_code for s in snaps)
    total = sum(c.values())
    mc = c.get("MC", 0)
    nmcm = c.get("NMCM", 0)
    nmcs = c.get("NMCS", 0)
    pmc = c.get("PMC", 0)
    deadlined_examples = [
        {"asset_id": s.asset_id, "equipment": s.equipment_type, "status": s.readiness_code}
        for s in snaps if s.readiness_code in ("NMCM", "NMCS")
    ][:5]
    return {
        "unit": unit,
        "snapshot": {
            "total": total,
            "mc": mc, "pmc": pmc, "nmcm": nmcm, "nmcs": nmcs,
            "mc_pct": round((mc / total) * 100, 1) if total else 100,
            "deadlined": nmcm + nmcs,
        },
        "deadlined_examples": deadlined_examples,
        "recommend": (
            f"Run recommend_actions(unit='{unit}') for ranked cannib/expedite/cross-level options, "
            f"and predict_failures(unit='{unit}', horizon_days=14) for the next-two-week risk band."
        ),
    }


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
    "mark_text": {
        "definition": {
            "type": "function",
            "function": {
                "name": "mark_text",
                "description": "Run the SENTRY classifier on a draft remark/message and return the recommended classification (UNCLASSIFIED or CUI), confidence, evidence spans, and the matching distribution statement. Use when the operator asks 'is this CUI?', 'mark this', 'classify this', or pastes draft text and asks for a marking. Caps at CUI by policy.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string", "description": "Draft remark or message text to classify."},
                        "release_authority": {"type": "string", "description": "Release authority (default US_ONLY)"},
                    },
                    "required": ["text"],
                },
            },
        },
        "runner": _tool_mark_text,
    },
    "forecast_unit": {
        "definition": {
            "type": "function",
            "function": {
                "name": "forecast_unit",
                "description": "Monte Carlo readiness forecast for a unit (or fleet) over a horizon. Returns current MC%, projected mean MC%, p10/p90 bands, and the probability of crossing the readiness threshold in the window. Use when the operator asks 'what will CLB-X look like in 14 days?', 'is CLB-1 going to drop?', or 'where are we headed on readiness?'",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "unit": {"type": "string", "description": "Unit name (e.g. 'CLB-1'). Omit for fleet-wide forecast."},
                        "horizon_days": {"type": "integer", "description": "Forecast window in days (default 14)"},
                    },
                },
            },
        },
        "runner": _tool_forecast_unit,
    },
    "list_alerts": {
        "definition": {
            "type": "function",
            "function": {
                "name": "list_alerts",
                "description": "Return the top N active BASTION alerts in the operator's role scope, sorted by severity (CRITICAL > HIGH > MODERATE > LOW). Use when the operator asks 'anything blowing up?', 'what's critical?', 'show me the alerts', or 'what's happening on the COP?'",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "severity": {"type": "string", "enum": ["CRITICAL", "HIGH", "MODERATE", "LOW", "INFO", "ALL"], "description": "Filter to a severity (default ALL)"},
                        "limit": {"type": "integer", "description": "Max alerts to return (default 10, max 30)"},
                    },
                },
            },
        },
        "runner": _tool_list_alerts,
    },
    "walk_unit": {
        "definition": {
            "type": "function",
            "function": {
                "name": "walk_unit",
                "description": "Composite snapshot for one unit: MC/PMC/NMCM/NMCS counts, MC%, deadlined examples, and a hint to follow up with recommend_actions / predict_failures. Use when the operator asks 'tell me about CLB-1', 'walk me through CLB-6', or 'what's the picture on 3d Maint Bn?' Pair with map_select_marker(pulse_unit=...) to focus the COP.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "unit": {"type": "string", "description": "Unit name (e.g. 'CLB-1', 'CLB-6')"},
                    },
                    "required": ["unit"],
                },
            },
        },
        "runner": _tool_walk_unit,
    },
    # ─────────────────────────────────────────────────────────────────
    # Map-control tools — runner is a stub because these execute
    # client-side in Spiro.tsx via the MapBridge. The planner surface
    # still needs the schema so Gemma can route map intents
    # ("show me Miyako", "what's within 50km of CLB-1") through these
    # tools. The frontend partitions map_* steps out before /execute
    # and runs them locally; result rows merge into the transcript so
    # the audit trail looks identical to backend tools.
    # ─────────────────────────────────────────────────────────────────
    "map_fly_to": {
        "definition": {
            "type": "function",
            "function": {
                "name": "map_fly_to",
                "description": "Fly the BASTION map camera to a location. Accepts an island name (okinawa/miyako/ishigaki), a marker id, a pulse_unit name (e.g. 'CLB-1'), a marker label (e.g. '12 MAR'), or explicit lng/lat/zoom. Use this when the operator asks 'show me X', 'go to X', 'fly to X'.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "island":     {"type": "string", "enum": ["okinawa", "miyako", "ishigaki"]},
                        "marker_id":  {"type": "string"},
                        "pulse_unit": {"type": "string", "description": "PULSE fixture unit name like 'CLB-1', 'CLB-6', '3d Maint Bn'"},
                        "label":      {"type": "string", "description": "Marker label like '12 MAR' or 'III MEF'"},
                        "lng":        {"type": "number"},
                        "lat":        {"type": "number"},
                        "zoom":       {"type": "number"},
                    },
                },
            },
        },
        "runner": _tool_status_summary,  # client-side; never reached server-side
    },
    "map_select_marker": {
        "definition": {
            "type": "function",
            "function": {
                "name": "map_select_marker",
                "description": "Select + highlight a marker on the BASTION map and open its detail drawer. Use this to focus the operator on a specific unit you're discussing. Pair with map_fly_to to also move the camera. Accepts marker_id, label, or pulse_unit.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "marker_id":  {"type": "string"},
                        "label":      {"type": "string"},
                        "pulse_unit": {"type": "string"},
                    },
                },
            },
        },
        "runner": _tool_status_summary,  # client-side
    },
    "map_list_markers": {
        "definition": {
            "type": "function",
            "function": {
                "name": "map_list_markers",
                "description": "Return the list of map markers, optionally filtered to one island. Use this when the operator asks 'what's on Miyako', 'list everything in the picture', etc.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "island": {"type": "string", "enum": ["okinawa", "miyako", "ishigaki"]},
                    },
                },
            },
        },
        "runner": _tool_status_summary,  # client-side
    },
    "map_query_within_radius": {
        "definition": {
            "type": "function",
            "function": {
                "name": "map_query_within_radius",
                "description": "Find every marker within a given distance (km) of a center point. Center can be a marker_id, label, or explicit lng/lat. Use this for spatial questions like 'what's within 100km of Miyako' or 'closest fuel point to CLB-1'.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "marker_id": {"type": "string"},
                        "label":     {"type": "string"},
                        "lng":       {"type": "number"},
                        "lat":       {"type": "number"},
                        "radius_km": {"type": "number", "description": "Search radius in km (default 100)"},
                    },
                },
            },
        },
        "runner": _tool_status_summary,  # client-side
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
