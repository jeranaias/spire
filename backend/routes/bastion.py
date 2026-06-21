"""BASTION endpoints: COP, alerts, response, ThermalHawk sim, NL TMR."""
from __future__ import annotations

import hashlib
import json
import time as _time
import uuid
from collections import Counter
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request

from ..auth import session_role
from ..scoping import (
    BASTION_SIMULATE_ROLES,
    allowed_sectors,
    allowed_units,
    filter_buildings,
    filter_perimeter,
    require_role,
)
from ..state import get_dataset, last_day_snapshots
from .streams import all_streams
from ..fusion import fuse_alerts
from ..persistence import log as audit_log

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


# Pre-computed unit lat/lon for the BASTION COP map. These are the fictional
# Camp Henderson coordinates from installation_data.json, offset per unit so
# each unit's pin sits over its own sector of the installation.
# Base: 34.658 N, -77.398 W (center)
UNIT_COORDS = {
    # Walkthrough caught three units (3/6 Marines, MWSS-271, 2/14 Marines)
    # collapsing to the default fallback lat/lon (34.658, -77.398) because
    # the dict still keyed legacy names (MWSS-372, 5/11 Marines, 2d Tank Bn).
    # Result: the Lejeune dot stack — three pins at identical coords with
    # overlapping labels. All 10 canonical unit names now have unique
    # coords spread across the Camp Henderson area so each marker reads on
    # its own.
    "CLB-6":        (34.6690, -77.4210),   # CLB-6 motor pool NW
    "CLB-1":        (34.6510, -77.4050),   # SW sector
    "3d Maint Bn":  (34.6700, -77.3750),   # NE forward
    "3/6 Marines":  (34.6480, -77.4170),   # SW infantry quad
    "2d LAR Bn":    (34.6550, -77.4150),   # West LAR lanes
    "MALS-31":      (34.6700, -77.3820),   # airfield N
    "MWSS-271":     (34.6610, -77.3680),   # E airfield support
    "2d LAAD Bn":   (34.6670, -77.3900),   # LAAD TOC
    "2/14 Marines": (34.6450, -77.3900),   # S artillery area
    "7th ESB":      (34.6630, -77.4240),   # W engineer workshop
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
        lat, lon = UNIT_COORDS.get(u.name, (34.658, -77.398))
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
# Alert feed: unified stream from SENTRY + PULSE + BASTION + ThermalHawk
# ---------------------------------------------------------------------------

def _compose_raw_alerts(ds) -> list[dict]:
    """Compose the unscoped, sorted, sim-prepended raw alert list /alerts
    serves before role-scoping and before fusion.

    Centralizing the composition lets `alert_action` (task #54) feed the
    EXACT same list to `fuse_alerts` so fused IDs visible in the feed
    can be matched on mutation — otherwise an operator who sees a
    `FUS-MGATE-*` row in /alerts would 404 on ack because the universe
    builder fed fusion a different input order. Also has the side-effect
    of expiring sims older than SIM_TTL — kept inside the composer so
    /alerts and the universe builder agree on which sims still exist.
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

    # Multi-stream feeds (gate access, utilities, weather)
    out.extend(all_streams(ds))

    # Sort newest-first
    out.sort(key=lambda a: a["timestamp"], reverse=True)

    # Prepend any active BASTION incidents from the sim queue.
    # Expire sims older than SIM_TTL so a ThermalHawk trigger doesn't stick in
    # the feed as 11 identical CRITICAL rows for an hour.
    now = datetime.utcnow()
    expired: list[str] = []
    for sim_id, sim in _ACTIVE_SIMS.items():
        if now - sim["started"] > SIM_TTL:
            expired.append(sim_id)
            continue
        out.insert(0, sim["alert"])
    for sid in expired:
        del _ACTIVE_SIMS[sid]
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

    # GC-4: run sensor fusion on the post-scoped alert window. Fused threats
    # are prepended above the raw alerts so an operator sees "the chain"
    # before the individual events. Same TTL semantics as raw alerts via
    # the fused_id stability — re-running fusion on the same chain emits
    # the same id, so poll-based callers don't get dupes.
    fused = fuse_alerts(out, window_minutes=60)
    fused_records = [t.to_alert_dict() for t in fused]

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
        "fused_threats": fused_records,
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
        return datetime.fromisoformat(until.replace("Z", "")) > datetime.utcnow()
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

    Fused threats, however, are computed by /alerts on the SCOPED list
    (so `FUS-MGATE-...` ids depend on which alerts the operator could
    see). We therefore re-run fusion on the same scoped+composed list
    /alerts feeds it — `_compose_raw_alerts` followed by `_scope_alerts`
    with the operator's allowed_units. Without this the universe builder
    fed fusion a different input order and an operator could see a
    fused row in /alerts but 404 on ack.
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

    # Fused threats — must mirror /alerts exactly so feed-visible fused
    # IDs are actionable. /alerts fuses AFTER scoping; do the same here.
    try:
        scoped = _scope_alerts(composed_unscoped, allowed)
        for t in fuse_alerts(scoped, window_minutes=60):
            d = t.to_alert_dict()
            universe[d["id"]] = {"id": d["id"], "unit": d.get("unit"), "source": "FUSION"}
    except Exception:
        # Fusion is best-effort; an exception here must never make a
        # legitimate raw-alert mutation 404 because a fusion bug threw.
        pass

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

    # Universe is built with the operator's scope so fused threat ids
    # match the ones /alerts surfaced to them. Raw-alert ids are still
    # full-universe so cross-tenant probes 403 with an audit row instead
    # of 404 silently.
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

    now = datetime.utcnow()
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


@router.get("/fused-threats")
async def fused_threats(role: Optional[str] = None):
    """Return the current fused-threat list independently. Useful for the
    BASTION fused-threats panel that polls more aggressively than the full
    alert stream."""
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None
    out: list[dict] = []

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
            out.append({
                "id": f"pulse-readiness-{unit_name}",
                "source": "PULSE",
                "severity": "HIGH" if mc_rate < MC_RED_FLOOR else "MODERATE",
                "timestamp": _jittered_timestamp(last_day, f"readiness:{unit_name}"),
                "title": _readiness_title(unit_name, mc_rate, nmcs, total),
                "body": f"{unit_name} MC rate {mc_rate:.1%}",
                "unit": unit_name,
            })
    out.extend(all_streams(ds))
    now = datetime.utcnow()
    for sim_id, sim in _ACTIVE_SIMS.items():
        if now - sim["started"] <= SIM_TTL:
            out.insert(0, sim["alert"])

    if allowed is not None:
        out = [a for a in out if a.get("unit") is None or a.get("unit") in allowed]

    fused = fuse_alerts(out, window_minutes=60)
    return {"fused_threats": [t.to_alert_dict() for t in fused]}


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


# ---------------------------------------------------------------------------
# ThermalHawk simulation — the demo's wow finish
# ---------------------------------------------------------------------------

_ACTIVE_SIMS: dict = {}
# Sims expire from the alert feed after this window, preventing duplicate
# "UAS DETECTED — CRITICAL" rows from piling up on the 5-second poll.
SIM_TTL = timedelta(minutes=30)


def _build_thermalhawk_model_info() -> dict:
    """Public model card for the BASTION sim alert.

    Capability + outcome only — no architecture mechanism, no training
    methodology, no internal codenames. Mechanism details stay with
    Thornveil's private ML package per LICENSE.md §2 / §4.

    Three load states the chrome reflects honestly:
      - live              — Thornveil-licensed inference active
      - weights_present   — proprietary weights deployed; inference
                            disabled in this public build
      - rule_based_sim    — no weights; scripted alert path

    Finding F5 split: the operator response panel only renders `note`
    (operator-facing copy). Vendor licensing / contact strings are now
    namespaced under `admin_note` + the existing `license` / `contact`
    keys so the admin model registry can surface them, but the Marine
    in the response panel sees plain operator copy — no vendor email,
    no license clause, no "available under separate license".
    """
    from ..model_hooks import STATE as MS
    base = {
        "model": "ThermalHawk (Thornveil)",
        "capability": "thermal infrared drone detection",
        "deployment_target": "edge accelerator",
        # license + contact are admin-registry fields — surfaced by
        # /admin model surfaces, suppressed by the operator panel.
        "license": "Thornveil proprietary — see LICENSE.md §2",
        "contact": "jesse@thornveil.ai",
    }
    if MS.thermalhawk_model is not None:
        base["load_state"] = "live"
    elif MS.thermalhawk_path:
        base["load_state"] = "weights_present"
        # Operator copy on the response panel.
        base["note"] = "Live thermal inference disabled in this build."
        # Admin-only context for the model registry.
        base["admin_note"] = (
            "Thornveil-licensed weights deployed; "
            "live inference disabled in this public build."
        )
    else:
        base["load_state"] = "rule_based_sim"
        # Operator copy: short, plain, actionable (no vendor email,
        # no separate-license language).
        base["note"] = (
            "Scripted incident profile — live thermal inference "
            "model not deployed in this build."
        )
        # Admin-only context for the model registry / licensing review.
        base["admin_note"] = (
            "Scripted sim — Thornveil ThermalHawk inference is "
            "available under separate license (jesse@thornveil.ai)."
        )
    return base


@router.post("/simulate/thermalhawk-detection")
async def simulate_thermalhawk_detection(
    request: Request, payload: Optional[dict] = None
):
    """Kicks off the scripted demo beat: drone detected over the operator's
    motor pool with ThermalHawk-Nano; auto-correlates with PULSE's readiness
    state; escalates to CRITICAL; emits response checklist.

    Authorization (task #54 / critique F1):
      * Role-gated to `mef_commander`, `security_manager`, `g4` — the
        same set the FE Sim Controls pill is shown to (BastionView.tsx
        L674). Maintenance Chief and Data Custodian get 403.
      * `target_unit` is derived from the operator's authenticated
        identity, NOT the request body. Prior behaviour trusted
        `payload.unit` and let any session escalate FPCON CHARLIE on any
        unit's motor pool. We still accept the field on the wire for
        backward-compat with the FE button (which doesn't send one), but
        we ignore it for routing and emit an audit row if it disagrees
        with the derived unit so cross-tenant probes are observable.

    Round-4 hardening also writes a `bastion.thermalhawk_simulate`
    audit row keyed on sim_id so the SOC AUDIT pill reflects every
    invocation alongside the SENTRY/PULSE/DHA per-module rows.
    """
    payload = payload or {}
    user = getattr(request.state, "user", None) or {}
    actor_role = session_role(request) or user.get("role")
    require_role(actor_role, BASTION_SIMULATE_ROLES, "bastion.simulate_thermalhawk")

    ds = get_dataset()
    inst = _load_installation()

    ds_unit_names = {u.name for u in ds.units}
    allowed = allowed_units(ds, actor_role)
    user_unit = user.get("unit")
    # Derive target unit from operator identity. Order:
    #   1. User's home unit if it's a leaf BASTION unit AND in scope.
    #   2. "CLB-6" (canonical demo target) if in scope. Catches identities
    #      whose home unit is a parent command or a non-dataset unit
    #      (e.g. Reyes/Kowalski "CLB-Det", Hayes "III MEF").
    #   3. Lowest-name unit in scope (deterministic) if CLB-6 is filtered out.
    #   4. "CLB-6" as a final fallback when no scope is computed.
    if user_unit in ds_unit_names and (allowed is None or user_unit in allowed):
        target_unit = user_unit
    elif allowed is None or "CLB-6" in allowed:
        target_unit = "CLB-6"
    elif allowed:
        target_unit = sorted(allowed)[0]
    else:
        target_unit = "CLB-6"

    # If the caller tried to spoof a different unit on the wire, surface
    # it in the audit chain. Not a 403 (the role gate already passed and
    # the derived unit is authoritative); the audit row is the forensic
    # breadcrumb that says "they asked for X, we routed to Y".
    requested_unit = payload.get("unit")
    if requested_unit and requested_unit != target_unit:
        try:
            audit_log(
                "bastion_simulate_unit_override",
                actor=actor_role or "unknown",
                subject_id=target_unit,
                payload={
                    "action": "bastion.simulate_thermalhawk",
                    "requested_unit": requested_unit,
                    "routed_to_unit": target_unit,
                    "user_dodid": user.get("dodid"),
                    "user_role": actor_role,
                    "decision": "override",
                    "reason": "wire_supplied_unit_ignored",
                    "surface": "backend",
                },
            )
        except Exception:
            pass

    # Find the target motor pool building. Walkthrough audit: prior fallback
    # was inst['buildings'][3] (positional, brittle). If buildings get
    # reordered the fallback could land on a barracks. Look up by the
    # canonical unit -> home_building edge from the dataset, then by any
    # motor_pool, and only fall back to the first building if neither
    # exists (dataset would be malformed).
    motor_pool = next(
        (b for b in inst["buildings"] if target_unit in b.get("name", "") and b["type"] == "motor_pool"),
        None,
    )
    if motor_pool is None:
        unit_obj = next((u for u in ds.units if u.name == target_unit), None)
        home_id = unit_obj.home_building if unit_obj else None
        if home_id:
            motor_pool = next((b for b in inst["buildings"] if b.get("id") == home_id), None)
    if motor_pool is None:
        motor_pool = next((b for b in inst["buildings"] if b.get("type") == "motor_pool"), None)
    if motor_pool is None:
        motor_pool = inst["buildings"][0]

    # PULSE correlation: read the unit's actual end-of-day MC state so the
    # 'amber readiness prior to detection' note is honest. Walkthrough
    # audit: prior text claimed amber regardless of the unit's real state
    # — would read 'amber' for a unit running 96% MC.
    from collections import Counter as _C
    last = last_day_snapshots(ds)
    unit_snaps = [s for s in last if s.unit_name == target_unit]
    unit_counts = _C(s.readiness_code for s in unit_snaps)
    unit_total = sum(unit_counts.values())
    unit_mc = unit_counts.get("MC", 0)
    unit_mc_rate = (unit_mc / unit_total) if unit_total else None
    if unit_mc_rate is None:
        readiness_note = (
            f"{target_unit} readiness prior to detection: dataset has no end-of-day snapshot."
        )
    elif unit_mc_rate < MC_RED_FLOOR:
        readiness_note = (
            f"{target_unit} was already RED ({unit_mc_rate*100:.1f}% MC, "
            f"below the {MC_RED_FLOOR*100:.0f}% floor) "
            f"prior to detection — UAS over the motor pool compounds an existing readiness gap."
        )
    elif unit_mc_rate < MC_AMBER_THRESHOLD:
        readiness_note = (
            f"{target_unit} was AMBER ({unit_mc_rate*100:.1f}% MC, "
            f"below the {MC_AMBER_THRESHOLD*100:.0f}% threshold) "
            f"prior to detection."
        )
    else:
        readiness_note = (
            f"{target_unit} was GREEN ({unit_mc_rate*100:.1f}% MC) prior to detection — "
            f"a UAS strike on the motor pool would directly degrade an otherwise nominal unit."
        )

    # Walkthrough audit: prior body said 'operational vehicles' but the
    # count multiplied total fleet (including NMC) by 60%, which over-
    # counts. Use MC + PMC for the 'operational' base so the number
    # actually maps to vehicles that could roll out tonight.
    operational_count = sum(unit_counts.get(k, 0) for k in ("MC", "PMC"))
    asset_pct_in_mp = 0.60  # spec states 60% of an MTVR-sized unit's fleet stages in the motor pool

    sim_id = f"SIM-{uuid.uuid4().hex[:8]}"
    now = datetime.utcnow()

    alert = {
        "id": sim_id,
        "source": "ThermalHawk",
        "severity": "CRITICAL",
        "timestamp": now.isoformat(timespec="seconds") + "Z",
        "title": "UAS DETECTED — auto-escalated to CRITICAL",
        "body": (
            f"Small UAS detected by ThermalHawk-Nano over {motor_pool['name']} "
            f"({motor_pool['grid']}). Altitude ~200ft AGL, heading east. "
            f"Auto-correlated: facility contains ~{asset_pct_in_mp*100:.0f}% of {target_unit}'s "
            f"operational vehicles ({int(operational_count * asset_pct_in_mp)} assets)."
        ),
        "unit": target_unit,
        "location": motor_pool["name"],
        "grid": motor_pool["grid"],
        "correlated_with": [
            {"source": "PULSE", "note": readiness_note},
        ],
        "fpcon_recommended": "CHARLIE",
        # Walkthrough audit: model_info was hardcoded prose. When
        # SPIRE_THERMALHAWK_WEIGHTS is set and the .pt file is on disk,
        # source the metadata from model_hooks.STATE so the alert
        # advertises whichever model the deploy actually has —
        # 'rule-based fallback' otherwise.
        "model_info": _build_thermalhawk_model_info(),
        "response_available": True,
    }

    _ACTIVE_SIMS[sim_id] = {
        "alert": alert,
        "incident_type": "UAS_INCURSION",
        "started": now,
    }

    # When Thornveil-licensed inference is enabled (private package
    # installed + weights deployed), the alert advertises the real
    # outcome via load_state="live". Public builds always run the
    # scripted alert path — no mechanism disclosure.

    response = {
        "sim_id": sim_id,
        "alert": alert,
        "checklist": _response_checklist_for("UAS_INCURSION", "CRITICAL", location=motor_pool["name"]),
        "cordon_zones": [
            {"radius_m": 300, "label": "Inner cordon — evacuate, secure"},
            {"radius_m": 500, "label": "Outer cordon — restrict access"},
            {"radius_m": 1000, "label": "Awareness zone — alert"},
        ],
        "response_forces_dispatched": ["WATCHDOG-3", "RAIDER-1", "IRONHORSE-2 (standby)"],
    }

    # Hash-chain the BASTION simulate event so the AUDIT closing beat can
    # show a `bastion.thermalhawk_simulate` entry alongside SENTRY,
    # PULSE, and DHA writes. Anchored to the sim_id as the subject so
    # subsequent /simulate/clear/{sim_id} requests refer to the same
    # subject in the chain.
    audit_log(
        "bastion.thermalhawk_simulate",
        actor=session_role(request) or "unknown",
        subject_id=sim_id,
        payload={
            "unit": target_unit,
            "incident_type": "UAS_INCURSION",
            "severity": "CRITICAL",
            "location": motor_pool.get("name"),
            "cordon_zones_m": [c["radius_m"] for c in response["cordon_zones"]],
            "readiness_note": readiness_note,
        },
    )

    return response


@router.post("/simulate/clear/{sim_id}")
async def clear_simulation(sim_id: str):
    if sim_id in _ACTIVE_SIMS:
        del _ACTIVE_SIMS[sim_id]
    return {"ok": True}


def reset_demo_state() -> dict:
    """Wipe all ephemeral BASTION scenario state back to t=0.

    Called by the system-level `reset-demo` endpoint between Shark Tank
    runs. Safe to call repeatedly (idempotent) — each call returns counts
    of what was cleared.
    """
    cleared_alerts = len(_ALERT_STATE)
    cleared_sims = len(_ACTIVE_SIMS)
    _ALERT_STATE.clear()
    _ACTIVE_SIMS.clear()
    return {
        "alert_states_cleared": cleared_alerts,
        "active_sims_cleared": cleared_sims,
    }


# ---------------------------------------------------------------------------
# ThermalHawk live video feed
# ---------------------------------------------------------------------------

@router.get("/thermalhawk/feed")
async def thermalhawk_feed(frame: int = 0):
    """Live thermal feed endpoint — gated behind a Thornveil license.

    Public builds return 503. Production deploys with Thornveil's
    private ML package installed serve a per-frame inference payload.
    Mechanism is not exposed in this repo."""
    try:
        from thornveil_ml.thermal_feed import get_thermal_frame_with_detections  # type: ignore
    except Exception:
        raise HTTPException(
            status_code=503,
            detail="ThermalHawk live feed requires the Thornveil ML package (license: jesse@thornveil.ai).",
        )
    payload = get_thermal_frame_with_detections(frame_idx=int(frame))
    if payload is None:
        raise HTTPException(status_code=503, detail="ThermalHawk model not loaded.")
    return payload


@router.get("/thermalhawk/feed/info")
async def thermalhawk_feed_info():
    """Public-facing live-feed metadata. Capability + license boundary
    only — no source-dataset specifics, no threshold tuning, no model
    architecture. Production deploys with the Thornveil ML package
    installed surface the richer detail privately."""
    from ..model_hooks import STATE as MS
    try:
        from thornveil_ml.thermal_feed import (  # type: ignore
            list_frames as _list_antiuav_frames,
            BUNDLED_FRAMES_DIR as _BUNDLED_FRAMES_DIR,
        )
    except Exception:
        return {
            "model_loaded": False,
            "available": False,
            "license": "Thornveil proprietary — see LICENSE.md §2",
            "contact": "jesse@thornveil.ai",
        }
    frames = _list_antiuav_frames()
    return {
        "model_loaded": MS.thermalhawk_model is not None,
        "available": True,
        "frame_count_in_loop": len(frames) if frames else None,
        "model_metadata": MS.thermalhawk_metadata,
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

    if _ACTIVE_SIMS:
        lines.append("")
        lines.append(f"Active simulated incidents: {len(_ACTIVE_SIMS)}")

    return "\n".join(lines)
