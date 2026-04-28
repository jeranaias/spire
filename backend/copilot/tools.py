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
from ..scoping import (
    allowed_units,
    COALITION_RELEASE_ROLES,
    BASTION_SIMULATE_ROLES,
    AIRGAP_ROLES,
    SENTRY_REVIEW_ROLES,
    SCENARIO_CONTROL_ROLES,
    AUDIT_READ_ROLES,
)
from ..persistence import log as audit_log


# ---------------------------------------------------------------------------
# In-process state for tools that don't have a backing endpoint yet.
# Reset by /api/system/admin/reset-demo via reset_tools_state() below.
# ---------------------------------------------------------------------------

_FPCON_STATE: dict = {"current": "BRAVO", "set_by": None, "set_at": None}
_QRF_DISPATCHES: list[dict] = []

_FPCON_LADDER = ("NORMAL", "ALPHA", "BRAVO", "CHARLIE", "DELTA")

# Tool-level role gates layered on top of the underlying endpoint gates.
# The endpoint role checks remain authoritative; these gates short-circuit
# tools that have no separate endpoint (set_fpcon, dispatch_qrf, etc.).
_FPCON_SET_ROLES   = frozenset({"mef_commander", "security_manager"})
_QRF_DISPATCH_ROLES = frozenset({"mef_commander", "security_manager", "g4"})
_RESET_DEMO_TOOL_ROLES = frozenset({"g4", "security_manager"})


def _actor(role: Optional[str], caller_dodid: Optional[str]) -> str:
    """Resolve the audit-log actor.

    Code review G-2: audit rows must record the *operator's* DODID (not
    their role) so an investigator can attribute a specific Marine to a
    SPIRO-issued mutation. We fall back to role only when no session is
    available (background jobs, internal callers) so the chain never
    breaks.
    """
    return (caller_dodid or role or "unknown").strip() or "unknown"


def reset_tools_state() -> dict:
    """Wipe SPIRO tool ephemeral state. Called from /admin/reset-demo.

    Returns a small summary dict so the reset-demo response can show what
    SPIRO state was cleared, alongside the bastion / mission-clock /
    comms-timeline counts the AdminTab already surfaces.
    """
    global _FPCON_STATE, _QRF_DISPATCHES
    qrf_cleared = len(_QRF_DISPATCHES)
    fpcon_was = _FPCON_STATE.get("current", "BRAVO")
    _FPCON_STATE = {"current": "BRAVO", "set_by": None, "set_at": None}
    _QRF_DISPATCHES = []
    return {
        "fpcon_was": fpcon_was,
        "fpcon_now": "BRAVO",
        "qrf_dispatches_cleared": qrf_cleared,
    }


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


async def _tool_parse_tmr(text: str, role: str = "g4") -> dict:
    """Parse a natural-language TMR via the LLM extractor (async).

    Code review G-1: the previous implementation tried to detect the
    running event loop and either deferred or errored — `run_tool` already
    awaits coroutines, so it's safe to make this a regular `async def`
    and just await the LLM extractor. Always returns a dict.
    """
    from ..routes.tmr import parse_tmr_text_llm
    try:
        result = await parse_tmr_text_llm(text)
        if isinstance(result, dict):
            return {"text": text, **result}
        # The route currently returns a dict; if a future change returns
        # a model instance we degrade gracefully rather than 500ing.
        return {"text": text, "parsed": str(result)}
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
# SPIRO tooling expansion (Task #194 / SPIRE-MDM-2026 demo) — 25 new tools
# spanning SENTRY, PULSE, BASTION, DHA RESCUE, System, Audit. Each wrapper
# defers to the existing FastAPI handler when one exists so role-scoping and
# audit trails stay consistent with the regular UI surface.
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    from datetime import datetime as _dt
    return _dt.utcnow().isoformat(timespec="seconds") + "Z"


def _check_role(role: Optional[str], allowed: frozenset[str], action: str) -> Optional[dict]:
    if role and role in allowed:
        return None
    return {
        "error": f"role {role!r} cannot {action}; on scope: {sorted(allowed)}",
        "refusal": "off_scope",
    }


# ---------- SENTRY ---------------------------------------------------------

async def _tool_classify_text(text: str, role: str = "data_custodian") -> dict:
    """Tier-1 SENTRY classification for a single ad-hoc text fragment."""
    from ..routes.sentry import tier1_classify
    try:
        out = tier1_classify(text or "")
        return {
            "input_chars": len(text or ""),
            "classification": out.get("classification", "UNKNOWN"),
            "rationale": out.get("rationale", ""),
            "matches": out.get("matches", [])[:8],
            "match_count": len(out.get("matches", [])),
        }
    except Exception as e:  # noqa: BLE001
        return {"error": f"classify_text failed: {type(e).__name__}: {e}"}


async def _tool_redact_for_partner(profile: str, role: str = "data_custodian", limit: int = 10) -> dict:
    """Preview the partner-redacted view (sample + caveats). Read-only."""
    from ..routes.sentry import coalition_view
    canonical = _TOOL_PROFILE_ALIASES.get(profile.lower().strip(), profile)
    try:
        result = await coalition_view(profile_key=canonical, role=role)
        if not isinstance(result, dict):
            return {"error": "coalition_view returned unexpected shape"}
        sample = result.get("sample_records", [])[:limit]
        return {
            "profile": canonical,
            "display_name": result.get("display_name"),
            "partners": result.get("partners", []),
            "distribution_statement": result.get("distribution_statement"),
            "sample_records": sample,
            "sample_count": len(sample),
            "caveats_applied": result.get("caveats_applied", []),
        }
    except Exception as e:  # noqa: BLE001
        return {"error": f"redact_for_partner failed: {type(e).__name__}: {e}"}


async def _tool_mark_classification(text: str, role: str = "data_custodian",
                                      caller_dodid: Optional[str] = None) -> dict:
    """Tier-1 mark + audit_log so the AUDIT pill shows the classification."""
    block = _check_role(role, SENTRY_REVIEW_ROLES, "mark classification")
    if block:
        return block
    from ..routes.sentry import tier1_classify
    try:
        out = tier1_classify(text or "")
        cls = out.get("classification", "UNKNOWN")
        audit_log(
            "spiro.mark_classification",
            actor=_actor(role, caller_dodid),
            subject_id=cls,
            payload={"input_chars": len(text or ""), "classification": cls,
                     "match_count": len(out.get("matches", [])), "role": role},
        )
        return {"classification": cls, "rationale": out.get("rationale", ""),
                "matches": out.get("matches", [])[:5], "logged": True}
    except Exception as e:  # noqa: BLE001
        return {"error": f"mark_classification failed: {type(e).__name__}: {e}"}


def _tool_aggregation_risk(fields: list, role: str = "data_custodian") -> dict:
    """Heuristic aggregation-risk score for a candidate field bundle."""
    if not isinstance(fields, list):
        return {"error": "fields must be a list of field names"}
    HIGH = {"asset_id", "serial_number", "operator_dodid", "grid", "lat", "lon"}
    MED  = {"unit_name", "equipment_type", "current_status", "home_building"}
    LOW  = {"summary", "echelon", "as_of"}
    score = 0
    breakdown = []
    for f in fields:
        key = str(f).lower()
        if key in HIGH:
            score += 30; breakdown.append({"field": key, "weight": 30})
        elif key in MED:
            score += 12; breakdown.append({"field": key, "weight": 12})
        elif key in LOW:
            score += 3; breakdown.append({"field": key, "weight": 3})
        else:
            score += 1; breakdown.append({"field": key, "weight": 1})
    band = "GREEN" if score < 25 else "AMBER" if score < 60 else "RED"
    return {"fields": [str(f) for f in fields], "score": score, "band": band,
            "breakdown": breakdown,
            "advice": {
                "GREEN": "Bundle is safe for partner release as-is.",
                "AMBER": "Drop one HIGH or two MED fields before release.",
                "RED":   "Negative — bundle is over the aggregation threshold; redact.",
            }[band]}


async def _tool_release_package(profile: str, role: str = "data_custodian",
                                 release_id: Optional[str] = None,
                                 caller_dodid: Optional[str] = None) -> dict:
    """Stage a coalition release package. Mutating; audit-logged."""
    block = _check_role(role, COALITION_RELEASE_ROLES, "release package")
    if block:
        return block
    canonical = _TOOL_PROFILE_ALIASES.get(profile.lower().strip(), profile)
    rid = release_id or f"REL-{int(__import__('time').time())}"
    audit_log(
        "spiro.release_package",
        actor=_actor(role, caller_dodid),
        subject_id=rid,
        payload={"profile": canonical, "release_id": rid, "tool": "spiro", "role": role},
    )
    return {"profile": canonical, "release_id": rid, "staged": True,
            "next_step": "Confirm in SENTRY → Coalition view before final release."}


# ---------- PULSE ----------------------------------------------------------

async def _tool_forecast_readiness(unit: Optional[str] = None,
                                    role: str = "g4",
                                    horizon_days: int = 14) -> dict:
    """Wrap /pulse/forecast — readiness curve over a horizon (window 7-30)."""
    from ..routes.pulse import forecast
    try:
        # forecast() reads `request.state.user` for the authoritative role.
        # Build a minimal stub so the wrapper works outside an HTTP request.
        class _Req:
            class state:  # noqa: N801
                user = {"role": role}
        window = max(7, min(30, int(horizon_days)))
        result = await forecast(request=_Req(), unit=unit, window=window)
        if not isinstance(result, dict):
            return {"error": "forecast returned unexpected shape"}
        proj = result.get("projection") or []
        return {
            "unit": unit or "all in scope",
            "window_days": window,
            "history_points": len(result.get("history", []) or []),
            "projection_points": len(proj),
            "first_proj": proj[0] if proj else None,
            "last_proj": proj[-1] if proj else None,
            "threshold": result.get("threshold"),
            "p_cross": result.get("p_cross"),
        }
    except Exception as e:  # noqa: BLE001
        return {"error": f"forecast_readiness failed: {type(e).__name__}: {e}"}


async def _tool_risk_explain(top: int = 5, role: str = "g4") -> dict:
    """Wrap /pulse/risk-board — surface highest-risk units with rationale."""
    from ..routes.pulse import risk_board
    try:
        result = await risk_board(top=top, role=role)
        if not isinstance(result, dict):
            return {"error": "risk_board returned unexpected shape"}
        items = result.get("rows") or result.get("units") or result.get("items") or []
        return {"count": len(items), "top": items[:top], "as_of": result.get("as_of")}
    except Exception as e:  # noqa: BLE001
        return {"error": f"risk_explain failed: {type(e).__name__}: {e}"}


async def _tool_propose_cannib(recipient_asset_id: str, donor_asset_id: str,
                                role: str = "maintenance_chief",
                                rationale: str = "",
                                caller_dodid: Optional[str] = None) -> dict:
    """Wrap /pulse/cannibalization/propose — mutating; audit-logged."""
    try:
        ds = get_dataset()
        recipient = next((a for a in ds.assets if a.asset_id == recipient_asset_id), None)
        donor = next((a for a in ds.assets if a.asset_id == donor_asset_id), None)
        if recipient is None or donor is None:
            return {"error": "recipient or donor asset not found"}
        if recipient.equipment_type != donor.equipment_type:
            return {"error": "recipient and donor are not the same equipment type"}
        proposal_id = f"CAN-{int(__import__('time').time())}"
        audit_log(
            "spiro.propose_cannib",
            actor=_actor(role, caller_dodid),
            subject_id=proposal_id,
            payload={"recipient_asset_id": recipient_asset_id,
                     "donor_asset_id": donor_asset_id,
                     "equipment_type": recipient.equipment_type,
                     "rationale": rationale or "", "via": "spiro", "role": role},
        )
        return {"proposal_id": proposal_id, "recipient_asset_id": recipient_asset_id,
                "donor_asset_id": donor_asset_id,
                "equipment_type": recipient.equipment_type,
                "status": "proposed", "logged": True}
    except Exception as e:  # noqa: BLE001
        return {"error": f"propose_cannib failed: {type(e).__name__}: {e}"}


async def _tool_approve_action(action_id: str,
                                 role: str = "g4",
                                 note: str = "",
                                 asset_id: Optional[str] = None,
                                 kind: str = "spiro_approved",
                                 title: Optional[str] = None,
                                 caller_dodid: Optional[str] = None) -> dict:
    """Approve a pending action by id and persist it as a PULSE Risk Board
    draft via the real `/api/pulse/draft-action` handler.

    Code review G-4: previously this stub only wrote a SPIRO audit row,
    so an "approved" action never actually became a persisted draft an
    operator could see in the Risk Board. Now we call the real endpoint
    so the action shows up in `/api/pulse/drafts` and the chain links
    into the canonical draft store. `action_id` becomes the draft title
    when `title` is not supplied; `asset_id` is required by the endpoint
    so the caller can scope-check.
    """
    block = _check_role(role, frozenset({"g4", "mef_commander"}), "approve action")
    if block:
        return block
    actor_dodid = _actor(role, caller_dodid)
    # Allow the LLM to pass just an action_id when the asset isn't relevant
    # (e.g. SPIRO is acknowledging a free-text recommendation). In that
    # case we record only the SPIRO audit row.
    if not asset_id:
        audit_log(
            "spiro.approve_action",
            actor=actor_dodid,
            subject_id=action_id,
            payload={"note": note or "", "via": "spiro", "role": role,
                     "asset_id": None, "draft_persisted": False},
        )
        return {"action_id": action_id, "approved": True, "by": actor_dodid,
                "at": _now_iso(), "note": note or "",
                "draft": None, "logged": True}
    try:
        from ..routes.pulse import draft_action as _draft_action
        from fastapi import Request as _Req
        scope = {"type": "http", "method": "POST", "path": "/api/pulse/draft-action",
                 "headers": [], "query_string": b""}
        req = _Req(scope)
        req.state.user = {"role": role, "dodid": actor_dodid}
        payload = {
            "asset_id": asset_id,
            "kind": kind or "spiro_approved",
            "title": title or f"SPIRO approved: {action_id}",
            "description": note or f"Approved via SPIRO (action_id={action_id}).",
        }
        result = await _draft_action(request=req, payload=payload)
        draft = result.get("draft") if isinstance(result, dict) else None
        draft_id = (draft or {}).get("draft_id") or (draft or {}).get("id") or action_id
        audit_log(
            "spiro.approve_action",
            actor=actor_dodid,
            subject_id=draft_id,
            payload={"note": note or "", "via": "spiro", "role": role,
                     "asset_id": asset_id, "kind": kind,
                     "draft_persisted": draft is not None,
                     "action_id": action_id},
        )
        return {"action_id": action_id, "approved": True, "by": actor_dodid,
                "at": _now_iso(), "note": note or "",
                "draft": draft, "logged": True}
    except Exception as e:  # noqa: BLE001
        return {"error": f"approve_action failed: {type(e).__name__}: {e}",
                "action_id": action_id}


async def _tool_donor_for_part(part_or_asset: str, role: str = "maintenance_chief") -> dict:
    """Resolve a donor candidate by part name or asset id (alias of cannib match)."""
    ds = get_dataset()
    text = (part_or_asset or "").upper().strip()
    target = next((a for a in ds.assets if a.asset_id == text), None)
    if target is None:
        # search by equipment_type token
        for a in ds.assets:
            if text in (a.equipment_type or "").upper():
                target = a
                break
    if target is None:
        return {"error": f"could not resolve {part_or_asset!r} to an asset"}
    return _tool_find_cannibalization_match(recipient_asset_id=target.asset_id, role=role)


# ---------- BASTION --------------------------------------------------------

async def _tool_simulate_thermalhawk(role: str = "mef_commander",
                                       caller_dodid: Optional[str] = None) -> dict:
    """Trigger the demo UAS detection beat (mutating)."""
    block = _check_role(role, BASTION_SIMULATE_ROLES, "simulate thermalhawk")
    if block:
        return block
    # Replicate the alert-emission contract without depending on the FastAPI
    # Request. Use _ACTIVE_SIMS so /simulate/clear/{sim_id} works as usual.
    import uuid as _uuid
    from datetime import datetime as _dt
    from ..routes import bastion as _bastion
    sim_id = f"SIM-{_uuid.uuid4().hex[:8]}"
    alert = {
        "id": sim_id,
        "source": "ThermalHawk",
        "severity": "CRITICAL",
        "timestamp": _dt.utcnow().isoformat(timespec="seconds") + "Z",
        "title": "UAS DETECTED — auto-escalated to CRITICAL",
        "body": "Synthetic UAS over CLB-6 motor pool. SPIRO-initiated drill.",
        "unit": "CLB-6",
        "fpcon_recommended": "CHARLIE",
    }
    _bastion._ACTIVE_SIMS[sim_id] = {"alert": alert, "incident_type": "UAS_INCURSION",
                                      "started": _dt.utcnow()}
    audit_log("spiro.simulate_thermalhawk", actor=_actor(role, caller_dodid),
              subject_id=sim_id, payload={"unit": "CLB-6", "via": "spiro", "role": role})
    return {"sim_id": sim_id, "alert": alert, "logged": True}


async def _tool_resolve_sim(sim_id: str, role: str = "mef_commander",
                              caller_dodid: Optional[str] = None) -> dict:
    """Clear an active simulation; if no other sims remain, normalize FPCON
    back down to BRAVO. Mutating; audit-logged.

    Code review G-5: previously this was a bare delete with no FPCON
    follow-through, leaving the installation pinned at CHARLIE after the
    drill cleared. Now we drop FPCON one notch (CHARLIE/DELTA→BRAVO) when
    the active-sim queue empties, mirroring how /admin/reset-demo behaves.
    """
    block = _check_role(role, BASTION_SIMULATE_ROLES, "resolve simulation")
    if block:
        return block
    from ..routes import bastion as _bastion
    existed = sim_id in _bastion._ACTIVE_SIMS
    if existed:
        del _bastion._ACTIVE_SIMS[sim_id]
    actor_dodid = _actor(role, caller_dodid)
    fpcon_change: Optional[dict] = None
    # Normalize FPCON only when no sims remain and current level is elevated.
    if not _bastion._ACTIVE_SIMS:
        prior = _FPCON_STATE.get("current", "BRAVO")
        if prior in ("CHARLIE", "DELTA"):
            _FPCON_STATE["current"] = "BRAVO"
            _FPCON_STATE["set_by"] = role
            _FPCON_STATE["set_at"] = _now_iso()
            fpcon_change = {"prior": prior, "new": "BRAVO"}
            audit_log("spiro.set_fpcon", actor=actor_dodid, subject_id="BRAVO",
                      payload={"prior": prior, "new": "BRAVO",
                                "via": "spiro.resolve_sim", "role": role})
    audit_log("spiro.resolve_sim", actor=actor_dodid,
              subject_id=sim_id, payload={"existed": existed,
                                            "fpcon_normalized": fpcon_change,
                                            "role": role})
    return {"sim_id": sim_id, "resolved": True, "existed": existed,
            "fpcon": fpcon_change, "logged": True}


async def _tool_list_alerts(limit: int = 10, role: str = "mef_commander") -> dict:
    from ..routes.bastion import alerts as _alerts
    try:
        result = await _alerts(limit=limit, role=role)
        items = result.get("alerts", []) if isinstance(result, dict) else []
        return {"count": len(items), "alerts": items[:limit]}
    except Exception as e:  # noqa: BLE001
        return {"error": f"list_alerts failed: {type(e).__name__}: {e}"}


async def _tool_acknowledge_alert(alert_id: str, role: str = "mef_commander",
                                    caller_dodid: Optional[str] = None) -> dict:
    """Acknowledge an alert by id. Mutating; calls the real
    `/api/bastion/alerts/{id}/ack` handler so the canonical alert state
    machine + audit row is what records the change.

    Code review G-4: previously this stub wrote a SPIRO-flavoured audit
    row but did not flip _ALERT_STATE, so the dashboard never updated.
    Now we call `alert_action` directly with a synthesized Request that
    carries the operator's session — the handler does the gate check,
    state mutation, and audit log itself.
    """
    block = _check_role(role, frozenset({"mef_commander", "security_manager", "g4"}),
                        "acknowledge alert")
    if block:
        return block
    actor_dodid = _actor(role, caller_dodid)
    try:
        from ..routes.bastion import alert_action as _alert_action
        from fastapi import Request as _Req
        # Synthesize a minimal Request with state.user populated so the
        # handler's session_role()/allowed_units() lookups succeed.
        scope = {"type": "http", "method": "POST", "path": f"/api/bastion/alerts/{alert_id}/ack",
                 "headers": [], "query_string": b""}
        req = _Req(scope)
        req.state.user = {"role": role, "dodid": actor_dodid}
        result = await _alert_action(alert_id=alert_id, action="ack", request=req)
        # Mirror SPIRO-attributed audit row alongside the bastion one so
        # the audit chain shows both "operator pressed ack" and "spiro
        # routed it on the operator's behalf".
        audit_log("spiro.acknowledge_alert", actor=actor_dodid,
                  subject_id=alert_id, payload={"action": "ack", "via": "spiro",
                                                  "role": role,
                                                  "endpoint_state": result.get("state")
                                                                       if isinstance(result, dict) else None})
        return {"alert_id": alert_id, "acknowledged": True, "by": actor_dodid,
                "at": _now_iso(), "endpoint": result, "logged": True}
    except Exception as e:  # noqa: BLE001
        return {"error": f"acknowledge_alert failed: {type(e).__name__}: {e}",
                "alert_id": alert_id}


async def _tool_correlate_threats(role: str = "mef_commander") -> dict:
    from ..routes.bastion import fused_threats
    try:
        result = await fused_threats(role=role)
        items = result.get("threats", []) if isinstance(result, dict) else []
        return {"count": len(items), "threats": items[:10]}
    except Exception as e:  # noqa: BLE001
        return {"error": f"correlate_threats failed: {type(e).__name__}: {e}"}


async def _tool_installation_status(role: str = "mef_commander") -> dict:
    from ..routes.bastion import cop
    try:
        result = await cop(role=role)
        if not isinstance(result, dict):
            return {"error": "cop returned unexpected shape"}
        units = result.get("units") or []
        return {"installation": result.get("installation"),
                "fpcon": _FPCON_STATE["current"],
                "unit_count": len(units),
                "units_summary": [{"unit": u.get("name"),
                                    "mc_pct": u.get("mc_pct")} for u in units[:5]]}
    except Exception as e:  # noqa: BLE001
        return {"error": f"installation_status failed: {type(e).__name__}: {e}"}


async def _tool_dispatch_qrf(unit: str, location: Optional[str] = None,
                              role: str = "mef_commander",
                              caller_dodid: Optional[str] = None) -> dict:
    """Dispatch the QRF — in-memory + audit-logged."""
    block = _check_role(role, _QRF_DISPATCH_ROLES, "dispatch QRF")
    if block:
        return block
    actor_dodid = _actor(role, caller_dodid)
    rec = {"qrf_id": f"QRF-{int(__import__('time').time())}",
           "unit": unit, "location": location or "TBD",
           "dispatched_by": actor_dodid, "role": role, "at": _now_iso()}
    _QRF_DISPATCHES.append(rec)
    audit_log("spiro.dispatch_qrf", actor=actor_dodid,
              subject_id=rec["qrf_id"], payload=rec)
    return {**rec, "dispatched": True, "logged": True}


# ---------- DHA RESCUE -----------------------------------------------------

async def _tool_blood_inventory(role: str = "mef_commander") -> dict:
    """Wrap blood-h72 vignette + class VIII shortage list."""
    from ..routes.system import scenario_blood_vignette
    try:
        meta = await scenario_blood_vignette()
        ds = get_dataset()
        from ..routes.decision_bridge import _class_viii_shortages
        shortages = _class_viii_shortages(ds, allowed_units(ds, role), top=10)
        return {
            "loaded": meta.get("loaded", False) if isinstance(meta, dict) else False,
            "vignette": meta.get("title") if isinstance(meta, dict) else None,
            "shortage_count": len(shortages),
            "top_shortages": shortages[:5],
        }
    except Exception as e:  # noqa: BLE001
        return {"error": f"blood_inventory failed: {type(e).__name__}: {e}"}


async def _tool_advance_scenario(action: str = "play",
                                  role: str = "mef_commander",
                                  rate: int = 1,
                                  offset_min: float = 0.0,
                                  caller_dodid: Optional[str] = None) -> dict:
    """Wrap /system/scenario/control — mutating, role-gated, audit-logged."""
    block = _check_role(role, SCENARIO_CONTROL_ROLES, "advance scenario")
    if block:
        return block
    from .. import scenario as scenario_state
    a = (action or "").strip().lower()
    if a == "play":
        result = scenario_state.play()
    elif a == "pause":
        result = scenario_state.pause()
    elif a == "set_rate":
        try:
            result = scenario_state.set_rate(int(rate))
        except ValueError as e:
            return {"error": str(e)}
    elif a == "seek":
        result = scenario_state.seek(float(offset_min))
    elif a == "reset":
        result = scenario_state.reset()
    else:
        return {"error": f"unknown action {action!r}; expected play|pause|set_rate|seek|reset"}
    audit_log("spiro.advance_scenario", actor=_actor(role, caller_dodid),
              subject_id=a, payload={"action": a, "rate": result.get("rate"),
                                       "offset_min": result.get("offset_min"),
                                       "via": "spiro", "role": role})
    return {"action": a, "running": result.get("running"),
            "rate": result.get("rate"), "offset_min": result.get("offset_min"),
            "logged": True}


def _tool_market_sourcing(item: str, qty: int = 1,
                           role: str = "mef_commander") -> dict:
    """Deterministic synthetic vendor sourcing (no real network calls)."""
    import hashlib
    seed = int(hashlib.sha256(f"{item}:{qty}".encode()).hexdigest()[:8], 16)
    vendors = [
        ("Allegheny Medical Supply", "PA", 4 + (seed % 3)),
        ("Pacific Cold Chain LLC", "CA", 6 + ((seed >> 4) % 5)),
        ("Atlantic Logistics Group", "VA", 5 + ((seed >> 8) % 4)),
    ]
    rows = [{"vendor": v, "state": st, "lead_time_days": lt,
             "unit_price_usd": round(50 + (seed % 47), 2),
             "qty_available": qty * (1 + ((seed >> 12) % 3))}
            for v, st, lt in vendors]
    return {"item": item, "qty_requested": qty, "vendor_count": len(rows),
            "vendors": rows, "synthetic": True}


# ---------- System ---------------------------------------------------------

_MISSION_CLOCK_ROLES = frozenset({"g4", "mef_commander", "security_manager"})


def _tool_mission_clock(action: str = "state",
                         offset_min: float = 0.0,
                         role: str = "g4",
                         caller_dodid: Optional[str] = None) -> dict:
    """Mission clock facade. Read-only by default; mutating when action ≠ state.

    Code review G-3: SPIRO needs a mutating mission-clock surface so a
    presenter can issue brevity like "RESET CLOCK" mid-demo. Actions:

      * `state` (default) — return current H+0 anchor + offset (read-only).
      * `play`            — resume scenario playback (delegates to scenario.play).
      * `pause`           — pause scenario playback (delegates to scenario.pause).
      * `reset`           — repin H+0 to now (mission_clock.reset_to_h0).
      * `jump_to`         — seek scenario to `offset_min` (delegates to scenario.seek).

    Mutating actions are role-gated and audit-logged with the caller's
    DODID as actor.
    """
    from .. import mission_clock as _mc
    a = (action or "state").strip().lower()
    if a == "state":
        try:
            return {"action": "state", **_mc.state()}
        except Exception as e:  # noqa: BLE001
            return {"error": f"mission_clock failed: {type(e).__name__}: {e}"}
    block = _check_role(role, _MISSION_CLOCK_ROLES, f"mission_clock {a}")
    if block:
        return block
    actor_dodid = _actor(role, caller_dodid)
    try:
        if a == "reset":
            new = _mc.reset_to_h0(actor=actor_dodid)
            audit_log("spiro.mission_clock", actor=actor_dodid,
                      subject_id="reset", payload={"action": "reset", "via": "spiro",
                                                     "role": role})
            return {"action": "reset", **new, "logged": True}
        from .. import scenario as _sc
        if a == "play":
            r = _sc.play()
        elif a == "pause":
            r = _sc.pause()
        elif a == "jump_to":
            r = _sc.seek(float(offset_min))
        else:
            return {"error": f"unknown action {action!r}; expected state|play|pause|reset|jump_to"}
        audit_log("spiro.mission_clock", actor=actor_dodid, subject_id=a,
                  payload={"action": a, "rate": r.get("rate"),
                            "offset_min": r.get("offset_min"), "via": "spiro",
                            "role": role})
        return {"action": a, "running": r.get("running"),
                "rate": r.get("rate"), "offset_min": r.get("offset_min"),
                "logged": True}
    except Exception as e:  # noqa: BLE001
        return {"error": f"mission_clock {a} failed: {type(e).__name__}: {e}"}


def _tool_set_fpcon(level: str, role: str = "mef_commander",
                     caller_dodid: Optional[str] = None) -> dict:
    """Set the installation FPCON level (in-process; audit-logged)."""
    block = _check_role(role, _FPCON_SET_ROLES, "set FPCON")
    if block:
        return block
    lvl = (level or "").upper().strip()
    if lvl not in _FPCON_LADDER:
        return {"error": f"invalid FPCON {level!r}; expected one of {list(_FPCON_LADDER)}"}
    prior = _FPCON_STATE["current"]
    actor_dodid = _actor(role, caller_dodid)
    _FPCON_STATE["current"] = lvl
    _FPCON_STATE["set_by"] = actor_dodid
    _FPCON_STATE["set_at"] = _now_iso()
    audit_log("spiro.set_fpcon", actor=actor_dodid, subject_id=lvl,
              payload={"prior": prior, "new": lvl, "via": "spiro", "role": role})
    return {"prior": prior, "new": lvl, "set_by": actor_dodid,
            "set_at": _FPCON_STATE["set_at"], "logged": True}


async def _tool_set_comms(mode: str, role: str = "mef_commander",
                            caller_dodid: Optional[str] = None) -> dict:
    """Toggle comms posture (live | airgap). Mutating; audit-logged."""
    block = _check_role(role, AIRGAP_ROLES, "set comms posture")
    if block:
        return block
    m = (mode or "").lower().strip()
    if m not in ("live", "airgap", "air_gap", "air-gap"):
        return {"error": f"invalid mode {mode!r}; expected 'live' or 'airgap'"}
    from ..routes import system as _sys
    prior = _sys._AIR_GAPPED
    _sys._AIR_GAPPED = (m != "live")
    audit_log("spiro.set_comms", actor=_actor(role, caller_dodid), subject_id=m,
              payload={"prior_air_gapped": prior, "new_air_gapped": _sys._AIR_GAPPED,
                       "via": "spiro", "role": role})
    return {"mode": m, "air_gapped": _sys._AIR_GAPPED,
            "queue_depth": len(_sys._QUEUE), "logged": True}


async def _tool_reset_demo(role: str = "g4",
                             caller_dodid: Optional[str] = None) -> dict:
    """Wrap /system/admin/reset-demo. Gated to g4 + security_manager."""
    block = _check_role(role, _RESET_DEMO_TOOL_ROLES, "reset demo")
    if block:
        return block
    actor_dodid = _actor(role, caller_dodid)
    # Replicate the bastion + ephemeral state reset without a Request object.
    try:
        from ..routes.bastion import reset_demo_state as _reset_bastion
        bastion_counts = _reset_bastion()
    except Exception as e:  # noqa: BLE001
        bastion_counts = {"error": str(e)[:160]}
    try:
        from ..mission_clock import reset_to_h0 as _reset_clock
        clock_state = _reset_clock(actor=actor_dodid)
    except Exception as e:  # noqa: BLE001
        clock_state = {"error": str(e)[:160]}
    reset_tools_state()
    audit_log("spiro.reset_demo", actor=actor_dodid, subject_id="demo",
              payload={"via": "spiro", "role": role, "bastion": bastion_counts})
    return {"ok": True, "bastion": bastion_counts, "mission_clock": clock_state,
            "logged": True, "next_step": "Reload the hero dashboard."}


# ---------- Audit ----------------------------------------------------------

def _tool_audit_query(kind: Optional[str] = None,
                       actor: Optional[str] = None,
                       q: Optional[str] = None,
                       limit: int = 25,
                       role: str = "security_manager") -> dict:
    """Read-only audit query gated to AUDIT_READ_ROLES."""
    block = _check_role(role, AUDIT_READ_ROLES, "query audit chain")
    if block:
        return block
    try:
        from ..persistence import query_audit
        result = query_audit(
            actors=[actor] if actor else None,
            kinds=[kind] if kind else None,
            q=q,
            limit=limit,
        )
        rows = result.get("rows", []) if isinstance(result, dict) else []
        return {"count": len(rows), "rows": rows[:limit],
                "head_hash": result.get("head_hash") if isinstance(result, dict) else None}
    except Exception as e:  # noqa: BLE001
        return {"error": f"audit_query failed: {type(e).__name__}: {e}"}


async def _tool_back_brief(unit: Optional[str] = None,
                            role: str = "mef_commander") -> dict:
    """Composed read-only — status_summary + recommend_actions + predict_failures.

    Gives the operator a single back-brief packet they can read aloud.
    """
    summary = _tool_status_summary(role=role)
    actions = await _tool_recommend_actions(unit=unit, role=role, top=3)
    preds = await _tool_predict_failures(unit=unit, role=role, horizon_days=14)
    return {
        "BLUF": (
            f"{summary.get('your_assets', '?')} assets in scope · "
            f"{summary.get('deadlined_in_scope', '?')} deadlined · "
            f"{actions.get('count', 0)} ranked actions · "
            f"{len(preds.get('predictions', []))} predicted failures (14d)."
        ),
        "status": summary,
        "top_actions": actions.get("actions", [])[:3],
        "predictions": preds.get("predictions", [])[:3],
        "unit": unit or "all in scope",
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
    # ----- SENTRY (Task #194) -----
    "classify_text": {
        "definition": {"type": "function", "function": {
            "name": "classify_text",
            "description": "SENTRY tier-1 classification of a single text fragment. Read-only.",
            "parameters": {"type": "object",
                "properties": {"text": {"type": "string", "description": "Text to classify"}},
                "required": ["text"]}}},
        "runner": _tool_classify_text,
    },
    "redact_for_partner": {
        "definition": {"type": "function", "function": {
            "name": "redact_for_partner",
            "description": "Preview the partner-redacted view (sample records + caveats) for one coalition profile. Read-only.",
            "parameters": {"type": "object", "properties": {
                "profile": {"type": "string", "enum": ["FVEY_BASE","FVEY_LOG","JPN_COALITION","AUS_COALITION","PHL_COALITION"]},
                "limit": {"type": "integer", "description": "Sample row cap (default 10)"}},
                "required": ["profile"]}}},
        "runner": _tool_redact_for_partner,
    },
    "mark_classification": {
        "definition": {"type": "function", "function": {
            "name": "mark_classification",
            "description": "Mark and audit-log a classification on a text fragment. Mutating; gated to SENTRY review roles.",
            "parameters": {"type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"]}}},
        "runner": _tool_mark_classification,
    },
    "aggregation_risk": {
        "definition": {"type": "function", "function": {
            "name": "aggregation_risk",
            "description": "Heuristic aggregation-risk score for a list of fields the operator wants to release together. Returns GREEN/AMBER/RED with advice.",
            "parameters": {"type": "object",
                "properties": {"fields": {"type": "array", "items": {"type": "string"}, "description": "Field names being released together"}},
                "required": ["fields"]}}},
        "runner": _tool_aggregation_risk,
    },
    "release_package": {
        "definition": {"type": "function", "function": {
            "name": "release_package",
            "description": "Stage a coalition release package. Mutating; gated to data_custodian + security_manager. Audit-logged.",
            "parameters": {"type": "object", "properties": {
                "profile": {"type": "string", "enum": ["FVEY_BASE","FVEY_LOG","JPN_COALITION","AUS_COALITION","PHL_COALITION"]},
                "release_id": {"type": "string", "description": "Optional explicit release id"}},
                "required": ["profile"]}}},
        "runner": _tool_release_package,
    },
    # ----- PULSE (Task #194) -----
    "forecast_readiness": {
        "definition": {"type": "function", "function": {
            "name": "forecast_readiness",
            "description": "Readiness curve over a horizon (days) for a unit (or whole scope when omitted). Read-only.",
            "parameters": {"type": "object", "properties": {
                "unit": {"type": "string"},
                "horizon_days": {"type": "integer"}}}}},
        "runner": _tool_forecast_readiness,
    },
    "risk_explain": {
        "definition": {"type": "function", "function": {
            "name": "risk_explain",
            "description": "Top-N highest-risk units with rationale. Useful for SITREP-style answers.",
            "parameters": {"type": "object",
                "properties": {"top": {"type": "integer", "description": "Top N (default 5)"}}}}},
        "runner": _tool_risk_explain,
    },
    "propose_cannib": {
        "definition": {"type": "function", "function": {
            "name": "propose_cannib",
            "description": "Propose a cannibalization (recipient + donor). Mutating; audit-logged.",
            "parameters": {"type": "object", "properties": {
                "recipient_asset_id": {"type": "string"},
                "donor_asset_id": {"type": "string"},
                "rationale": {"type": "string"}},
                "required": ["recipient_asset_id", "donor_asset_id"]}}},
        "runner": _tool_propose_cannib,
    },
    "approve_action": {
        "definition": {"type": "function", "function": {
            "name": "approve_action",
            "description": "Approve a pending action / draft by id and optionally persist it as a PULSE Risk Board draft. Mutating; gated to g4 + mef_commander. Pass asset_id to persist; without asset_id only the SPIRO audit row is written.",
            "parameters": {"type": "object", "properties": {
                "action_id": {"type": "string"},
                "asset_id": {"type": "string", "description": "Asset to attribute the draft to (required to persist via /pulse/draft-action)"},
                "kind": {"type": "string", "description": "Draft kind label (default: spiro_approved)"},
                "title": {"type": "string", "description": "Draft title (default: 'SPIRO approved: <action_id>')"},
                "note": {"type": "string"}},
                "required": ["action_id"]}}},
        "runner": _tool_approve_action,
    },
    "parse_tmr": {
        "definition": {"type": "function", "function": {
            "name": "parse_tmr",
            "description": "Parse a natural-language Transportation Movement Request (TMR) into a structured JSON record via the LLM extractor. Read-only.",
            "parameters": {"type": "object", "properties": {
                "text": {"type": "string", "description": "Natural-language TMR text"}},
                "required": ["text"]}}},
        "runner": _tool_parse_tmr,
    },
    "donor_for_part": {
        "definition": {"type": "function", "function": {
            "name": "donor_for_part",
            "description": "Resolve a donor candidate by part name OR asset id. Wraps cannib match.",
            "parameters": {"type": "object",
                "properties": {"part_or_asset": {"type": "string"}},
                "required": ["part_or_asset"]}}},
        "runner": _tool_donor_for_part,
    },
    # ----- BASTION (Task #194) -----
    "simulate_thermalhawk": {
        "definition": {"type": "function", "function": {
            "name": "simulate_thermalhawk",
            "description": "Trigger the demo UAS detection beat over CLB-6 motor pool. Mutating; gated to BASTION simulate roles.",
            "parameters": {"type": "object", "properties": {}}}},
        "runner": _tool_simulate_thermalhawk,
    },
    "resolve_sim": {
        "definition": {"type": "function", "function": {
            "name": "resolve_sim",
            "description": "Clear an active simulation by sim_id. Mutating; gated to BASTION simulate roles.",
            "parameters": {"type": "object",
                "properties": {"sim_id": {"type": "string"}},
                "required": ["sim_id"]}}},
        "runner": _tool_resolve_sim,
    },
    "list_alerts": {
        "definition": {"type": "function", "function": {
            "name": "list_alerts",
            "description": "List recent BASTION alerts in the operator's scope. Read-only.",
            "parameters": {"type": "object",
                "properties": {"limit": {"type": "integer", "description": "Max alerts (default 10)"}}}}},
        "runner": _tool_list_alerts,
    },
    "acknowledge_alert": {
        "definition": {"type": "function", "function": {
            "name": "acknowledge_alert",
            "description": "Acknowledge an alert by id. Mutating; audit-logged.",
            "parameters": {"type": "object",
                "properties": {"alert_id": {"type": "string"}},
                "required": ["alert_id"]}}},
        "runner": _tool_acknowledge_alert,
    },
    "correlate_threats": {
        "definition": {"type": "function", "function": {
            "name": "correlate_threats",
            "description": "Fused threat correlation across alert sources. Read-only.",
            "parameters": {"type": "object", "properties": {}}}},
        "runner": _tool_correlate_threats,
    },
    "installation_status": {
        "definition": {"type": "function", "function": {
            "name": "installation_status",
            "description": "Camp Henderson installation status (units, FPCON, summary). Read-only.",
            "parameters": {"type": "object", "properties": {}}}},
        "runner": _tool_installation_status,
    },
    "dispatch_qrf": {
        "definition": {"type": "function", "function": {
            "name": "dispatch_qrf",
            "description": "Dispatch the Quick Reaction Force to a unit / location. Mutating; gated to QRF dispatch roles.",
            "parameters": {"type": "object", "properties": {
                "unit": {"type": "string"},
                "location": {"type": "string"}},
                "required": ["unit"]}}},
        "runner": _tool_dispatch_qrf,
    },
    # ----- DHA RESCUE (Task #194) -----
    "blood_inventory": {
        "definition": {"type": "function", "function": {
            "name": "blood_inventory",
            "description": "Class VIII / blood-product inventory snapshot for the H+72 vignette. Read-only.",
            "parameters": {"type": "object", "properties": {}}}},
        "runner": _tool_blood_inventory,
    },
    "advance_scenario": {
        "definition": {"type": "function", "function": {
            "name": "advance_scenario",
            "description": "Scenario playback control: play | pause | set_rate | seek | reset. Mutating; gated to scenario control roles.",
            "parameters": {"type": "object", "properties": {
                "action": {"type": "string", "enum": ["play","pause","set_rate","seek","reset"]},
                "rate": {"type": "integer"},
                "offset_min": {"type": "number"}},
                "required": ["action"]}}},
        "runner": _tool_advance_scenario,
    },
    "market_sourcing": {
        "definition": {"type": "function", "function": {
            "name": "market_sourcing",
            "description": "Synthetic vendor sourcing for a part / item. Deterministic; no real network calls.",
            "parameters": {"type": "object", "properties": {
                "item": {"type": "string"},
                "qty": {"type": "integer"}},
                "required": ["item"]}}},
        "runner": _tool_market_sourcing,
    },
    # ----- System (Task #194) -----
    "mission_clock": {
        "definition": {"type": "function", "function": {
            "name": "mission_clock",
            "description": "Mission clock facade. action='state' (default, read-only) | 'play' | 'pause' | 'reset' | 'jump_to'. Mutating actions are role-gated and audit-logged.",
            "parameters": {"type": "object", "properties": {
                "action": {"type": "string", "enum": ["state","play","pause","reset","jump_to"],
                            "description": "Operation to perform (default: state)"},
                "offset_min": {"type": "number", "description": "For jump_to: scenario offset in minutes"}}}}},
        "runner": _tool_mission_clock,
    },
    "set_fpcon": {
        "definition": {"type": "function", "function": {
            "name": "set_fpcon",
            "description": "Set the installation FPCON level (NORMAL/ALPHA/BRAVO/CHARLIE/DELTA). Mutating; gated to mef_commander + security_manager. Audit-logged.",
            "parameters": {"type": "object", "properties": {
                "level": {"type": "string", "enum": list(_FPCON_LADDER)}},
                "required": ["level"]}}},
        "runner": _tool_set_fpcon,
    },
    "set_comms": {
        "definition": {"type": "function", "function": {
            "name": "set_comms",
            "description": "Toggle comms posture (live | airgap). Mutating; gated to airgap roles. Audit-logged.",
            "parameters": {"type": "object", "properties": {
                "mode": {"type": "string", "enum": ["live", "airgap"]}},
                "required": ["mode"]}}},
        "runner": _tool_set_comms,
    },
    "reset_demo": {
        "definition": {"type": "function", "function": {
            "name": "reset_demo",
            "description": "Return SPIRE to a clean t=0 demo state. Mutating; gated to g4 + security_manager. Audit-logged.",
            "parameters": {"type": "object", "properties": {}}}},
        "runner": _tool_reset_demo,
    },
    # ----- Audit (Task #194) -----
    "audit_query": {
        "definition": {"type": "function", "function": {
            "name": "audit_query",
            "description": "Query the audit chain by kind, actor, and/or free-text. Read-only; gated to AUDIT_READ_ROLES.",
            "parameters": {"type": "object", "properties": {
                "kind": {"type": "string", "description": "Audit kind (e.g. 'spiro.set_fpcon')"},
                "actor": {"type": "string"},
                "q": {"type": "string", "description": "Free-text payload search"},
                "limit": {"type": "integer", "description": "Max rows (default 25)"}}}}},
        "runner": _tool_audit_query,
    },
    "back_brief": {
        "definition": {"type": "function", "function": {
            "name": "back_brief",
            "description": "Composed back-brief packet: status + top actions + 14-day predictions for a unit (or whole scope). Read-only.",
            "parameters": {"type": "object", "properties": {
                "unit": {"type": "string"}}}}},
        "runner": _tool_back_brief,
    },
}


async def run_tool(name: str, args: dict, role: str,
                    caller_dodid: Optional[str] = None) -> dict:
    """Execute one tool call. Always returns a dict; on error returns {error}.

    Some tool runners are sync, some are `async def`, and some are sync
    but happen to return a coroutine object (because they call an async
    FastAPI handler under the hood). This dispatcher awaits whichever
    shape we get. Callers must `await` `run_tool(...)`.

    Code review G-2: `caller_dodid` is plumbed through so mutating tools
    can record the operator's DODID as the audit actor (instead of the
    coarse role). Runners opt in by declaring a `caller_dodid` kwarg.
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
        if "caller_dodid" in sig.parameters and caller_dodid is not None:
            kwargs["caller_dodid"] = caller_dodid
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
