"""BASTION endpoints: COP, readiness alerts, incident response, NL TMR."""
from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request

from ..auth import session_role
from ..scoping import (
    allowed_sectors,
    allowed_units,
    filter_buildings,
    filter_perimeter,
)
from ..state import get_dataset, last_day_snapshots
from ..persistence import AuditWriteFailure, log_or_flag as audit_log
from ..timeutil import utcnow

router = APIRouter()


def _jittered_timestamp(base_date, key: str) -> str:
    """Deterministic per-key time offset within the last 12 hours of base_date.

    Gives each alert a distinct plausible timestamp so the feed doesn't read
    as "everything happened at 17:00". Deterministic across restarts because
    the key hash is stable."""
    h = int(hashlib.sha256(key.encode()).hexdigest()[:8], 16)
    minutes_offset = h % (12 * 60)  # 0..719 minutes into the last 12 hours
    t = time(hour=5, minute=0)      # last-12h window starts at 05:00 on base_date
    dt = datetime.combine(base_date, t) + timedelta(minutes=minutes_offset)
    # Walkthrough audit: append 'Z' so the frontend parses as UTC. Without
    # it, `new Date('2026-04-27T02:52:00')` reads as LOCAL time — operators
    # in UTC-7 saw alert timestamps parse 7 hours in the future and the
    # AlertCard mis-flagged them as 'SYNTH'.
    return dt.isoformat(timespec="seconds") + "Z"


# Mission-capable readiness bands, shared across the COP, the alert-fusion
# engine, and the ThermalHawk sim so a unit reads the same condition on
# every surface. RED below the floor; AMBER/warn below the threshold.
MC_RED_FLOOR = 0.60
MC_AMBER_THRESHOLD = 0.70

# Pool of varied readiness-alert title templates so every row doesn't read
# "X readiness below threshold". Picked deterministically per (unit, band).
_READINESS_TITLE_TEMPLATES_HIGH = [
    "{unit} MC below critical floor",
    "{unit} deadlining — MC crossed red threshold",
    "{unit} readiness critical (MC {pct:.0f}%)",
    "{unit} red-condition — {nmcs} NMCS / {total} fleet",
]
_READINESS_TITLE_TEMPLATES_MOD = [
    "{unit} readiness amber — trending down",
    "{unit} degraded — MC {pct:.0f}%, watch list",
    "{unit} below-threshold advisory",
    "{unit} approaching red — {nmcs} NMCS assets",
]


def _readiness_title(unit: str, mc_rate: float, nmcs: int, total: int) -> str:
    pool = _READINESS_TITLE_TEMPLATES_HIGH if mc_rate < MC_RED_FLOOR else _READINESS_TITLE_TEMPLATES_MOD
    idx = int(hashlib.sha256(f"{unit}:rd".encode()).hexdigest(), 16) % len(pool)
    return pool[idx].format(unit=unit, pct=mc_rate * 100, nmcs=nmcs, total=total)

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "dataset" / "data"


def _load_installation() -> dict:
    """Load installation_data.json. Lat/lon is baked into the JSON during
    dataset prep (scripts/bake_latlon.py) via flat-earth projection from the
    installation center; the backend just reads — no runtime MGRS dependency."""
    with open(DATA_DIR / "installation_data.json", encoding="utf-8") as f:
        return json.load(f)


# Pre-computed unit lat/lon for the BASTION COP map. These mirror the
# canonical Okinawa scenario positions (frontend/src/data/okinawa-scenario.ts)
# so a PULSE "show on map" deeplink and the COP marker land on the same point.
# 8 units on Okinawa Honto across real camps; 2d LAAD forward on Miyako and
# 2/14 Marines forward on Ishigaki to visualize the dispersed stand-in-forces
# posture. (lat, lon) — note okinawa-scenario.ts stores [lng, lat].
UNIT_COORDS = {
    "CLB-6":        (26.2542, 127.6817),   # Camp Kinser
    "CLB-1":        (26.2742, 127.7544),   # Camp Foster
    "3d Maint Bn":  (26.2810, 127.7616),   # Camp Foster
    "MALS-31":      (26.3559, 127.7686),   # Kadena AB
    "MWSS-271":     (26.2710, 127.7561),   # MCAS Futenma
    "7th ESB":      (26.4612, 127.8917),   # Camp Hansen
    "3/6 Marines":  (26.5167, 128.0500),   # Camp Schwab
    "2d LAR Bn":    (26.5061, 128.0322),   # Camp Schwab
    "2d LAAD Bn":   (24.7950, 125.3450),   # Miyako (forward)
    "2/14 Marines": (24.4150, 124.1750),   # Ishigaki (forward)
}


# ---------------------------------------------------------------------------
# COP: units + readiness + pins
# ---------------------------------------------------------------------------

@router.get("/cop")
async def cop(role: Optional[str] = None):
    ds = get_dataset()
    inst = _load_installation()
    last = last_day_snapshots(ds)
    if not last:
        # Stage live-ingest mode (Task #183): empty dataset is a valid
        # state, not an error. Return 200 with an explicit ``empty``
        # flag so the frontend can render the "awaiting GCSS-MC ingest"
        # empty state instead of the 503 toast pattern.
        return {"empty": True, "message": "Awaiting GCSS-MC ingest"}

    allowed = allowed_units(ds, role)
    last_day = last[0].snapshot_date

    # Per-unit readiness
    by_unit_counter: dict = {u.name: Counter() for u in ds.units}
    by_unit_equip: dict = {u.name: Counter() for u in ds.units}
    for s in last:
        by_unit_counter[s.unit_name][s.readiness_code] += 1
        by_unit_equip[s.unit_name][s.equipment_type] += 1

    units_out = []
    for u in ds.units:
        if allowed is not None and u.name not in allowed:
            continue
        c = by_unit_counter[u.name]
        total = sum(c.values())
        mc_rate = c.get("MC", 0) / total if total else 0.0
        lat, lon = UNIT_COORDS.get(u.name, (26.2742, 127.7544))  # default: Camp Foster, Okinawa
        alerts: list[dict] = []
        if mc_rate < MC_RED_FLOOR:
            alerts.append({"kind": "readiness_collapse", "severity": "HIGH"})
        elif mc_rate < MC_AMBER_THRESHOLD:
            alerts.append({"kind": "readiness_warning", "severity": "MODERATE"})

        # Data-integrity flags: SRs with data_quality_flag tied to this unit
        dq_count = sum(
            1 for sr in ds.srs
            if sr.unit_name == u.name and sr.data_quality_flag
        )

        units_out.append({
            "unit": u.name,
            "uic": u.uic,
            "parent": u.parent,
            "location": u.location,
            "home_building": u.home_building,  # canonical mapping unit -> building.id (data, not hardcoded UI)
            "lat": lat,
            "lon": lon,
            "total_equipment": total,
            "mc_rate": round(mc_rate, 3),
            "mc_count": c.get("MC", 0),
            "pmc_count": c.get("PMC", 0),
            "nmcm_count": c.get("NMCM", 0),
            "nmcs_count": c.get("NMCS", 0),
            "equipment_breakdown": dict(by_unit_equip[u.name]),
            "alerts": alerts,
            "data_integrity_flags": dq_count,
        })

    # F2 — installation map scoping. Buildings filtered by occupant-unit
    # affiliation (or shared-infra sector association); ECPs and rally
    # points filtered by sector. Sensitive types (ammunition, ARMS, fuel,
    # hazmat, comms nodes, TOC) and CI/hazmat-flagged buildings are
    # stripped from any non-INSTALLATION_FULL_VIEW_ROLES payload so a
    # battalion-scope CAC isn't handed the OSINT installation product.
    scoped_buildings = filter_buildings(inst["buildings"], ds, role)
    sectors = allowed_sectors(ds, role, inst["buildings"])
    scoped_ecps = filter_perimeter(inst["ecps"], sectors)
    scoped_rps = filter_perimeter(inst.get("rally_points", []), sectors)

    return {
        "installation": inst["installation"],
        "center": {
            "lat": inst["installation"]["center_lat"],
            "lon": inst["installation"]["center_lon"],
        },
        "units": units_out,
        "buildings": scoped_buildings,
        "buildings_count": len(scoped_buildings),
        "ecps": scoped_ecps,
        "rally_points": scoped_rps,
        "response_forces_count": len(inst["response_forces"]),
        "as_of": last_day.isoformat(),
    }


# ---------------------------------------------------------------------------
# Alert feed: readiness + cannibalization + SENTRY classification alerts
# ---------------------------------------------------------------------------

def _compose_raw_alerts(ds) -> list[dict]:
    """Compose the unscoped, sorted raw alert list /alerts serves before
    role-scoping.

    Centralizing the composition lets `alert_action` (task #54) feed the
    EXACT same list the alert universe builder uses, so an id visible in
    /alerts can always be matched on mutation rather than 404-ing on ack.
    """
    out: list[dict] = []
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None

    # Readiness alerts
    last = last_day_snapshots(ds)
    unit_counts: dict = {}
    for s in last:
        uc = unit_counts.setdefault(s.unit_name, Counter())
        uc[s.readiness_code] += 1
    for unit_name, c in unit_counts.items():
        total = sum(c.values())
        if not total:
            continue
        mc_rate = c.get("MC", 0) / total
        if mc_rate < MC_AMBER_THRESHOLD:
            nmcs = c.get("NMCS", 0)
            mc = c.get("MC", 0)
            pmc = c.get("PMC", 0)
            nmcm = c.get("NMCM", 0)
            # Reconcile every number on screen — MC + PMC + NMCM + NMCS == total.
            # The previous body read "32/64 assets · 17 NMCS" and left the
            # reviewer trying to make 32+17 = 64 (it doesn't; the missing 15
            # were PMC + NMCM). One body, one decomposition, every number
            # accounted for. Precision uniform at 1 decimal across the app.
            out.append({
                "id": f"pulse-readiness-{unit_name}",
                "source": "PULSE",
                "severity": "HIGH" if mc_rate < MC_RED_FLOOR else "MODERATE",
                "timestamp": _jittered_timestamp(last_day, f"readiness:{unit_name}"),
                "title": _readiness_title(unit_name, mc_rate, nmcs, total),
                "body": (
                    f"{unit_name} MC {mc_rate*100:.1f}% · "
                    f"{mc} MC / {pmc} PMC / {nmcm} NMCM / {nmcs} NMCS / {total} total"
                ),
                "unit": unit_name,
            })

    # Cannibalization matches.
    #
    # Volume rule: only the 3 most-recent cross-unit cannib events surface
    # as alerts. Single-unit (self) cannibalization is a routine motor-pool
    # transfer that doesn't cross authority boundaries — it's still
    # captured in the cannib log (PULSE → Cannibalization tab + audit
    # chain) but emitting one as a top-of-feed alert just inflates the
    # count without adding signal. Cross-unit cannib IS a coordination
    # signal (parts moving between unit boundaries) so those still emit;
    # capping at 3 keeps the alert lane scannable.
    #
    # Walkthrough timestamp jitter retained — each event gets a plausible
    # per-event time within the working day instead of all rendering as
    # "00:00Z".
    cross_unit_cannibs = [
        ev for ev in sorted(ds.cannib_events, key=lambda e: e.event_date, reverse=True)
        if ev.donor_unit and ev.recipient_unit and ev.donor_unit != ev.recipient_unit
    ][:3]
    for ev in cross_unit_cannibs:
        out.append({
            "id": f"pulse-cannib-{ev.event_id}",
            "source": "PULSE",
            "severity": "MODERATE",
            "scope": "cross_unit",
            "timestamp": _jittered_timestamp(ev.event_date, f"cannib:{ev.event_id}"),
            "title": f"Cannibalization: {ev.recipient_unit} ← {ev.donor_unit}",
            "body": f"{ev.nomenclature} transferred ({ev.asset_pair_body() if hasattr(ev, 'asset_pair_body') else ev.recipient_asset_id + ' from ' + ev.donor_asset_id})",
            "unit": ev.recipient_unit,
        })

    # SENTRY classification discrepancies (from the canonical source/detected split)
    discrepancies = [
        sr for sr in ds.srs
        if not sr.is_pmcs
        and sr.source_classification == "UNCLASSIFIED"
        and sr.detected_classification != "UNCLASSIFIED"
    ][:5]
    for sr in discrepancies:
        out.append({
            "id": f"sentry-mismark-{sr.sr_number}",
            "source": "SENTRY",
            "severity": "MODERATE",
            "timestamp": _jittered_timestamp(sr.open_date, f"mismark:{sr.sr_number}"),
            "title": f"Classification discrepancy: {sr.sr_number}",
            "body": f"Source marking UNCLASSIFIED, SENTRY detected {sr.detected_classification} ({sr.unit_name} / {sr.equipment_type})",
            "unit": sr.unit_name,
        })

    # Sort newest-first
    out.sort(key=lambda a: a["timestamp"], reverse=True)
    return out


def _scope_alerts(out: list[dict], allowed: Optional[set[str]]) -> list[dict]:
    """Apply role scoping the same way /alerts does: unit=None alerts
    (base-wide streams) stay visible, unit-bearing alerts only if in
    scope. `allowed=None` means unrestricted (no filter)."""
    if allowed is None:
        return out
    return [a for a in out if a.get("unit") is None or a.get("unit") in allowed]


@router.get("/alerts")
async def alerts(limit: int = 30, role: Optional[str] = None):
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    out = _compose_raw_alerts(ds)
    out = _scope_alerts(out, allowed)

    # Apply per-alert state (ack / snooze / resolve) so the front-end can
    # render canonical groups + drop resolved rows. Snoozes auto-expire
    # via _is_snoozed; resolves remove the row from the response entirely
    # so the count drops only when the operator says it does.
    visible: list[dict] = []
    for a in out:
        st = _ALERT_STATE.get(a["id"])
        if st and st.get("status") == "resolved":
            continue
        # Walkthrough audit: a row could be left tagged 'snoozed' indefinitely
        # because the snoozed-status check above didn't consult snooze_until.
        # Drop the state when the snooze window has lapsed so the row reads
        # as active again instead of pretending the operator silenced it.
        if st and st.get("status") == "snoozed" and not _is_snoozed(st):
            st = None
        if st:
            a = {**a, "_state": st}
        visible.append(a)

    # Severity breakdown — exposed so the TopBar badge can show the live
    # tooltip "30 open alerts (HIGH: x, MODERATE: y, INFO: z)" without
    # the front-end having to reduce the array client-side.
    sev_counts: dict[str, int] = {}
    for a in visible:
        sev_counts[a["severity"]] = sev_counts.get(a["severity"], 0) + 1

    return {
        "alerts": visible[:limit],
        "total": len(visible),
        "severity_counts": sev_counts,
    }


# ---------------------------------------------------------------------------
# Per-alert state — ack / snooze / resolve
#
# In-memory store keyed by alert_id. A real deployment would persist to the
# audit log; for the demo we keep state for the life of the process so the
# operator's clicks survive role swaps + remounts. The /alerts response
# bakes the per-alert state into the payload so the front-end never has to
# infer it.
# ---------------------------------------------------------------------------

_ALERT_STATE: dict[str, dict] = {}


def _is_snoozed(state: dict) -> bool:
    if state.get("status") != "snoozed":
        return False
    until = state.get("snooze_until")
    if not until:
        return False
    try:
        return datetime.fromisoformat(until.replace("Z", "")) > utcnow()
    except Exception:
        return False


def _collect_alert_universe(ds, allowed: Optional[set[str]] = None) -> dict[str, dict]:
    """Build the id → alert dict for every alert this operator could
    legitimately have seen in /alerts. Used by `alert_action` to:
      (a) reject unknown ids with 404 instead of silently growing
          _ALERT_STATE (closes critique F3), and
      (b) look up the owning unit so the cross-tenant scope check can
          decide between 403 OutOfScope and a successful mutation.

    Raw alerts are always indexed unscoped — that way a restricted
    operator's URL-hack against another battalion's id falls into the
    explicit 403 OutOfScope branch (with audit row) rather than 404,
    which makes the spoof attempt visible in the chain.
    """
    universe: dict[str, dict] = {}

    # Raw alerts — full unscoped index so cross-tenant probes land in
    # the 403 OutOfScope branch with an audit row, not in 404.
    composed_unscoped = _compose_raw_alerts(ds)
    for a in composed_unscoped:
        aid = a.get("id")
        if not aid:
            continue
        universe[aid] = {"id": aid, "unit": a.get("unit"), "source": a.get("source")}

    return universe


def _audit_blocked_alert_action(
    *, actor_role: Optional[str], user: Optional[dict],
    alert_id: str, alert_unit: Optional[str], action: str,
    allowed_set: Optional[set[str]],
) -> None:
    """Append a `bastion_alert_action_blocked` row so cross-tenant
    write attempts surface in the audit chain. Best-effort — never let
    audit failures mask the 403."""
    try:
        audit_log(
            "bastion_alert_action_blocked",
            actor=actor_role or "unknown",
            subject_id=alert_id,
            payload={
                "action": f"bastion.alert.{action}",
                "alert_id": alert_id,
                "alert_unit": alert_unit,
                "user_dodid": (user or {}).get("dodid"),
                "user_role": (user or {}).get("role"),
                "user_unit": (user or {}).get("unit"),
                "allowed_units": sorted(allowed_set) if allowed_set else None,
                "decision": "blocked",
                "reason": "out_of_scope",
                "surface": "backend",
            },
        )
    except AuditWriteFailure:
        # Event profile: a denial nobody can prove happened is not one the
        # enforcing build records as handled.
        raise
    except Exception:
        pass


@router.post("/alerts/{alert_id}/{action}")
async def alert_action(alert_id: str, action: str, request: Request):
    """ack / snooze / resolve / unack a single alert.

    Authorization (task #54 / critique F1):
      * Unknown alert ids return 404 instead of growing _ALERT_STATE
        without bound (also closes the unbounded-memory finding F3).
      * The operator's role-scoped `allowed_units` must cover the alert's
        owning unit. Restricted roles (maintenance_chief, g4) cannot
        silently resolve another battalion's readiness alert. Unrestricted
        roles (mef_commander, security_manager, data_custodian) pass.
      * Base-wide alerts (unit=None — gate / utility / weather streams)
        are actionable only by unrestricted roles for the same reason —
        a single battalion's chief shouldn't be silencing installation
        utility advisories.
      * Cross-tenant denials are appended to the audit chain so an
        investigator can see who probed.
    """
    if action not in ("ack", "snooze", "resolve", "unack"):
        raise HTTPException(status_code=400, detail=f"unknown action: {action}")

    user = getattr(request.state, "user", None) or {}
    actor_role = session_role(request) or user.get("role")
    ds = get_dataset()
    allowed = allowed_units(ds, actor_role)

    # Raw-alert ids are indexed full-universe so cross-tenant probes 403
    # with an audit row instead of 404 silently.
    universe = _collect_alert_universe(ds, allowed=allowed)
    alert = universe.get(alert_id)
    if alert is None:
        # Unknown id — refuse to grow _ALERT_STATE. Mention the id in
        # the body so a developer can correlate; nothing sensitive in it.
        raise HTTPException(status_code=404, detail=f"unknown alert id: {alert_id}")
    alert_unit = alert.get("unit")
    if allowed is not None:
        # Restricted role: alert must have a unit AND that unit must be
        # in scope. Base-wide (unit=None) alerts deny for restricted roles.
        if alert_unit is None or alert_unit not in allowed:
            _audit_blocked_alert_action(
                actor_role=actor_role, user=user, alert_id=alert_id,
                alert_unit=alert_unit, action=action, allowed_set=allowed,
            )
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "OutOfScope",
                    "action": f"bastion.alert.{action}",
                    "alert_id": alert_id,
                    "alert_unit": alert_unit,
                    "user_role": actor_role,
                    "allowed_units": sorted(allowed),
                },
            )

    now = utcnow()
    if action == "ack":
        _ALERT_STATE[alert_id] = {
            "status": "acknowledged",
            "at": now.isoformat(timespec="seconds") + "Z",
        }
    elif action == "snooze":
        until = now + timedelta(hours=1)
        _ALERT_STATE[alert_id] = {
            "status": "snoozed",
            "at": now.isoformat(timespec="seconds") + "Z",
            "snooze_until": until.isoformat(timespec="seconds") + "Z",
        }
    elif action == "resolve":
        _ALERT_STATE[alert_id] = {
            "status": "resolved",
            "at": now.isoformat(timespec="seconds") + "Z",
        }
    elif action == "unack":
        _ALERT_STATE.pop(alert_id, None)
    return {"ok": True, "alert_id": alert_id, "state": _ALERT_STATE.get(alert_id)}


# ---------------------------------------------------------------------------
# Incident response — auto-generated checklist for an incident
# ---------------------------------------------------------------------------

def _response_checklist_for(incident_type: str, severity: str, *, location: Optional[str] = None) -> dict:
    base = {
        "UAS_INCURSION": {
            "title": "UAS INCIDENT RESPONSE",
            "immediate": [
                "Alert: Giant Voice installation notification",
                "Dispatch: PMO to location for visual confirmation",
                "Restrict: Lock down nearest ECPs",
                "Protect: Secure critical equipment in affected facility",
                "Report: Notify Regional C-UAS coordinator",
            ],
            "followon": [
                "Request EOD standby if UAS lands/crashes",
                "Preserve CCTV footage",
                "Notify NCIS for investigation",
                "Conduct airspace deconfliction with local tower",
            ],
            "notifications": [
                {"who": "Installation CO", "draft_ready": True},
                {"who": "PMO Watch Commander", "draft_ready": True},
                {"who": "Regional C-UAS", "draft_ready": True},
            ],
        },
        "READINESS_DROP": {
            "title": "READINESS ALERT RESPONSE",
            "immediate": [
                "Notify MLG G-4 (auto-drafted message ready)",
                "Execute cannibalization if match available (zero readiness impact)",
                "Escalate critical assets to priority maintenance",
                "Request parts expedite for NMCS vehicles",
                "Update DRRS-MC to reflect projected readiness",
            ],
            "followon": [
                "Confirm parts ETA with SSA and DLA",
                "Brief MEF G-4 if threshold breach imminent",
            ],
            "notifications": [
                {"who": "MLG G-4", "draft_ready": True},
                {"who": "Unit Motor T Chief", "draft_ready": True},
            ],
        },
        "DEFAULT": {
            "title": "INCIDENT RESPONSE",
            "immediate": [
                "Assess scene, confirm initial report",
                "Dispatch nearest available response force",
                "Notify watch officer and installation CO",
                "Establish cordon if required",
            ],
            "followon": [
                "Document timeline",
                "Preserve evidence",
                "Submit incident report",
            ],
            "notifications": [{"who": "Installation CO", "draft_ready": True}],
        },
    }
    return base.get(incident_type, base["DEFAULT"])


@router.get("/incidents/{incident_id}/response")
async def incident_response(incident_id: str):
    ds = get_dataset()
    incident = ds.incident(incident_id)
    if incident is None:
        raise HTTPException(status_code=404, detail="incident not found")
    checklist = _response_checklist_for(incident.type, incident.severity, location=incident.location_building)
    return {
        "incident_number": incident.incident_number,
        "type": incident.type,
        "severity": incident.severity,
        "location": incident.location_building,
        "location_grid": incident.location_grid,
        "fpcon_at_time": incident.fpcon_at_time,
        "fpcon_change": incident.fpcon_change,
        "initial_report": incident.initial_report,
        "checklist": checklist,
        "response_force_assigned": incident.response_force,
        "estimated_response_minutes": incident.response_time_minutes,
    }


@router.get("/incidents")
async def list_incidents(limit: int = 50):
    ds = get_dataset()
    out = []
    for i in list(ds.incidents)[-limit:]:
        out.append({
            "incident_number": i.incident_number,
            "date_time": i.date_time.isoformat(),
            "type": i.type,
            "severity": i.severity,
            "location": i.location_building,
            "grid": i.location_grid,
            "response_force": i.response_force,
            "casualties": i.casualties,
            "damage_usd": i.property_damage_usd,
        })
    return {"incidents": out}


def reset_demo_state() -> dict:
    """Wipe all ephemeral BASTION scenario state back to t=0.

    Called by the system-level `reset-demo` endpoint between Shark Tank
    runs. Safe to call repeatedly (idempotent) — each call returns counts
    of what was cleared.
    """
    cleared_alerts = len(_ALERT_STATE)
    _ALERT_STATE.clear()
    return {
        "alert_states_cleared": cleared_alerts,
        "active_sims_cleared": 0,
    }


# ---------------------------------------------------------------------------
# TMR list — surfaces the canonical synthetic TMR dataset for the BASTION TMR
# panel. Distinct from the NL TMR parser at /nl-query, which still consumes
# free-text operator input and routes to the rule-based / LLM extractor.
# ---------------------------------------------------------------------------

@router.get("/tmrs")
async def list_tmrs(limit: int = 50, status: Optional[str] = None,
                    role: Optional[str] = None):
    """Return the synthetic TMR records generated alongside the rest of the
    canonical dataset. Filtered by `status` if supplied (Draft/Submitted/
    Approved/Closed). Role-scoped via the standard allowed_units gate so a
    Maintenance Chief only sees their unit's submissions."""
    ds = get_dataset()
    tmrs = list(getattr(ds, "tmrs", []) or [])
    allowed = allowed_units(ds, role)
    if allowed is not None:
        tmrs = [t for t in tmrs if t.requesting_unit in allowed]
    if status:
        tmrs = [t for t in tmrs if t.status.lower() == status.lower()]

    # Most recent first, capped at `limit`.
    tmrs.sort(key=lambda t: t.submitted_date, reverse=True)
    out = []
    for t in tmrs[:limit]:
        out.append({
            "tmr_number": t.tmr_number,
            "submitted_date": t.submitted_date.isoformat(),
            "scheduled_date": t.scheduled_date.isoformat(),
            "origin": t.origin,
            "destination": t.destination,
            "requesting_unit": t.requesting_unit,
            "equipment": t.equipment,
            "hazmat": t.hazmat,
            "escort_required": t.escort_required,
            "route": t.route,
            "priority": t.priority,
            "status": t.status,
            "purpose": t.purpose,
            "point_of_contact": t.point_of_contact,
        })
    return {"tmrs": out, "total": len(tmrs)}


# ---------------------------------------------------------------------------
# NL TMR — Easter egg in the BASTION NL bar
# ---------------------------------------------------------------------------

from .tmr import parse_tmr_text, parse_tmr_text_llm  # noqa: E402
from .llm import call_llm_chat  # noqa: E402


@router.post("/nl-query")
async def nl_query(request: Request, payload: dict):
    """Natural-language query entry point. Detects intent (TMR submission vs
    general question) and routes appropriately:
      - TMR triggers → LLM-backed structured extraction (Gemma4 via RigRun
        proxy), with rule-based fallback if the proxy is unreachable
      - Everything else → LLM general-purpose answer with a defense-context
        system prompt, also with rule-based fallback
    """
    text = payload.get("text", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")

    lower = text.lower()
    tmr_triggers = ("tmr", "submit movement", "move ", "transport ", "convoy ", "movement request")
    if any(t in lower for t in tmr_triggers):
        return {
            "intent": "tmr_submission",
            "result": await parse_tmr_text_llm(text),
        }

    # General-purpose NL query path. We ground the LLM with a snapshot of
    # what the operator can already see on screen — top alerts, fleet
    # readiness, deadlined assets in scope — so the model never says
    # "no data available for CLB-6" while CLB-6 data is on screen next
    # to the input.
    grounding = _build_grounding_context(role=session_role(request))
    try:
        sys_prompt = (
            "You are SPIRO, the operator-assistant aspect of SPIRE. The operator is a Marine "
            "using SPIRE during a 30-day pilot of the synthetic Camp Henderson installation. "
            "Synthetic dataset: 10 units (CLB-6, 3/6 Marines, 2d LAR Bn, MALS-31, MWSS-271, "
            "2d LAAD Bn, 2/14 Marines, 7th ESB, 3d Maint Bn, CLB-1), 350 assets, 6,332 service "
            "requests over 365 days. The CURRENT_OPERATIONAL_PICTURE block below is what the "
            "operator can see on screen right now. Use it. Never claim data is unavailable "
            "when it's literally in this block. Answer in 2-4 sentences max. Be authoritative; "
            "no hedging. Cite the specific number, asset id, or unit name. Never speculate "
            "about real-world classified data — this is a synthetic environment."
        )
        result = await call_llm_chat(
            messages=[
                {"role": "system", "content": sys_prompt},
                {"role": "system", "content": f"CURRENT_OPERATIONAL_PICTURE:\n{grounding}"},
                {"role": "user", "content": text},
            ],
            temperature=0.2,
            max_tokens=400,
            # Direct prose answer over the COP — tier1 SLM is sufficient.
            # If accuracy lags we'll bump to mid via the model ladder.
            tier="tier1_small",
            call_site="bastion_general_query",
        )
        usage = result.get("usage") or {}
        economics = result.get("economics") or {}
        return {
            "intent": "general_query",
            "result": {
                "answer": (result.get("content") or "").strip(),
                # Operator never sees these — they live under _meta for the
                # admin/audit surfaces only. Walkthrough caught the prior
                # version leaking `engine: Gemma4 via RigRun proxy · 234 tokens`
                # into the chat bubble; that's developer telemetry, not a
                # command-tool answer.
                "_meta": {
                    "engine": "Gemma4 via RigRun proxy",
                    "tokens_used": usage.get("total_tokens"),
                    "grounded": True,
                    "economics": economics or None,
                },
            },
        }
    except Exception as e:  # noqa: BLE001
        return {
            "intent": "general_query",
            "result": {
                "answer": "Language-model gate unavailable right now. Try a structured query (e.g. 'submit TMR from Lejeune to Geiger, 5 MTVRs, Wednesday') or refresh in a minute.",
                "_meta": {"engine": f"unavailable ({type(e).__name__})"},
            },
        }


def _build_grounding_context(role: str | None) -> str:
    """Snapshot of the operational picture the LLM should ground its answers
    against. Mirrors the canonical readiness counter used by /api/bastion/cop
    and /api/bastion/alerts so the LLM can never disagree with what the
    operator sees on screen.

    Walkthrough caught: prior version computed MC% as (total-deadlined)/total,
    counting PMC as MC. SPIRO then echoed e.g. "CLB-6 90.0% (63/70)" while
    the map and alert stream showed 55.7% (39/70). Source of truth is the
    end-of-day snapshot's readiness_code (MC / PMC / NMCM / NMCS) — strict-MC
    only counts MC.
    """
    from collections import Counter
    from ..state import get_dataset, last_day_snapshots
    from ..scoping import allowed_units
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    last = last_day_snapshots(ds)
    if not last:
        return "Operational picture unavailable (canonical dataset is empty)."
    in_scope = last if allowed is None else [s for s in last if s.unit_name in allowed]

    by_unit: dict[str, Counter] = {}
    for s in in_scope:
        by_unit.setdefault(s.unit_name, Counter())[s.readiness_code] += 1

    lines: list[str] = []
    lines.append(
        f"Role scope: {role or 'unrestricted'} · {len(in_scope)} assets visible "
        f"(end-of-day {last[0].snapshot_date.isoformat()} canonical snapshot)"
    )
    lines.append("")
    lines.append("Per-unit readiness (strict MC = readiness_code == 'MC'; PMC is partial, NOT MC):")
    for unit_name, c in sorted(by_unit.items()):
        total = sum(c.values())
        mc = c.get("MC", 0)
        pmc = c.get("PMC", 0)
        nmcm = c.get("NMCM", 0)
        nmcs = c.get("NMCS", 0)
        mc_pct = (mc / total * 100) if total else 0.0
        lines.append(
            f"  - {unit_name}: MC {mc_pct:.1f}% · {mc} MC / {pmc} PMC / {nmcm} NMCM / {nmcs} NMCS · {total} total"
        )
    lines.append("")

    deadlined_snaps = [s for s in in_scope if s.readiness_code in ("NMCM", "NMCS")][:8]
    if deadlined_snaps:
        lines.append("Deadlined examples in scope (top 8):")
        for s in deadlined_snaps:
            lines.append(
                f"  - {s.asset_id} · {s.equipment_type} · {s.unit_name} · status={s.readiness_code}"
            )
    else:
        lines.append("No currently deadlined assets in scope.")

    return "\n".join(lines)
