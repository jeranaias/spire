"""BASTION endpoints: COP, alerts, response, ThermalHawk sim, NL TMR."""
from __future__ import annotations

import hashlib
import json
import uuid
from collections import Counter
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException

from ..scoping import allowed_units
from ..state import get_dataset, last_day_snapshots
from .streams import all_streams
from ..fusion import fuse_alerts

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
    pool = _READINESS_TITLE_TEMPLATES_HIGH if mc_rate < 0.60 else _READINESS_TITLE_TEMPLATES_MOD
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
        raise HTTPException(status_code=503, detail="dataset empty")

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
        if mc_rate < 0.60:
            alerts.append({"kind": "readiness_collapse", "severity": "HIGH"})
        elif mc_rate < 0.70:
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

    return {
        "installation": inst["installation"],
        "center": {
            "lat": inst["installation"]["center_lat"],
            "lon": inst["installation"]["center_lon"],
        },
        "units": units_out,
        "buildings": inst["buildings"],
        "buildings_count": len(inst["buildings"]),
        "ecps": inst["ecps"],
        "rally_points": inst.get("rally_points", []),
        "response_forces_count": len(inst["response_forces"]),
        "as_of": last_day.isoformat(),
    }


# ---------------------------------------------------------------------------
# Alert feed: unified stream from SENTRY + PULSE + BASTION + ThermalHawk
# ---------------------------------------------------------------------------

@router.get("/alerts")
async def alerts(limit: int = 30, role: Optional[str] = None):
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None
    out: list[dict] = []

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
        if mc_rate < 0.70:
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
                "severity": "HIGH" if mc_rate < 0.60 else "MODERATE",
                "timestamp": _jittered_timestamp(last_day, f"readiness:{unit_name}"),
                "title": _readiness_title(unit_name, mc_rate, nmcs, total),
                "body": (
                    f"{unit_name} MC {mc_rate*100:.1f}% · "
                    f"{mc} MC / {pmc} PMC / {nmcm} NMCM / {nmcs} NMCS / {total} total"
                ),
                "unit": unit_name,
            })

    # Cannibalization matches.
    # Severity heuristic — single-unit cannibalization (donor and recipient
    # are the same unit) is INFO with a "self" badge; cross-unit is MODERATE
    # because parts leaving one unit's fleet for another's is a maintenance
    # signal worth a yellow stripe. Reviewer caught all-INFO under-weighting
    # cross-unit. Walkthrough also caught all 6 cannib rows displaying as
    # "00:00Z" because event_date is a date (not datetime); apply the same
    # _jittered_timestamp the readiness rows use so each event gets a
    # plausible per-event time within the working day.
    for ev in sorted(ds.cannib_events, key=lambda e: e.event_date, reverse=True):
        cross_unit = ev.donor_unit and ev.recipient_unit and ev.donor_unit != ev.recipient_unit
        out.append({
            "id": f"pulse-cannib-{ev.event_id}",
            "source": "PULSE",
            "severity": "MODERATE" if cross_unit else "INFO",
            "scope": "cross_unit" if cross_unit else "self",
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

    # Apply role scoping AFTER sim prepend so incident alerts honour the
    # operator's authorization (Maintenance Chief only sees sims for their
    # unit; Data Custodian sees none).
    if allowed is not None:
        filtered: list[dict] = []
        for a in out:
            unit = a.get("unit")
            if unit is None or unit in allowed:
                filtered.append(a)
        out = filtered

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


@router.post("/alerts/{alert_id}/{action}")
async def alert_action(alert_id: str, action: str):
    """ack / snooze / resolve / unack a single alert.

    The handler is intentionally tolerant of unknown ids — synthetic alerts
    regenerate their ids on every poll for some sources, so we accept any
    id and keep state keyed by it. Unknown actions return 400."""
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
    else:
        raise HTTPException(status_code=400, detail=f"unknown action: {action}")
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
        if mc_rate < 0.70:
            nmcs = c.get("NMCS", 0)
            out.append({
                "id": f"pulse-readiness-{unit_name}",
                "source": "PULSE",
                "severity": "HIGH" if mc_rate < 0.60 else "MODERATE",
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


@router.post("/simulate/thermalhawk-detection")
async def simulate_thermalhawk_detection(payload: Optional[dict] = None):
    """Kicks off the scripted demo beat: drone detected over CLB-6 motor pool
    with ThermalHawk-Nano; auto-correlates with PULSE's CLB-6 readiness
    state; escalates to CRITICAL; emits response checklist."""
    payload = payload or {}
    target_unit = payload.get("unit", "CLB-6")

    ds = get_dataset()
    inst = _load_installation()

    # Find the target motor pool building
    motor_pool = next(
        (b for b in inst["buildings"] if target_unit in b.get("name", "") and b["type"] == "motor_pool"),
        None,
    )
    if motor_pool is None:
        motor_pool = inst["buildings"][3]  # fallback to CLB-6 MP

    # PULSE correlation: what % of unit's operational vehicles are in this facility?
    asset_count_in_unit = sum(
        1 for a in ds.assets if a.unit_name == target_unit
    )
    asset_pct_in_mp = 0.60  # spec states 60%

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
            f"operational vehicles ({int(asset_count_in_unit * asset_pct_in_mp)} assets)."
        ),
        "unit": target_unit,
        "location": motor_pool["name"],
        "grid": motor_pool["grid"],
        "correlated_with": [
            {"source": "PULSE", "note": f"{target_unit} was already at amber readiness prior to detection"},
        ],
        "fpcon_recommended": "CHARLIE",
        "model_info": {
            "model": "ThermalHawk-Nano v2 (v2)",
            "parameters": 1_770_000,
            "architecture": "Thornveil proprietary architecture + Thornveil neck + Thornveil detection head",
            "training": "Thornveil training protocol on Anti-UAV410",
            "deployment_target": "Hailo-8 edge accelerator (~$80 USD per node)",
        },
        "response_available": True,
    }

    _ACTIVE_SIMS[sim_id] = {
        "alert": alert,
        "incident_type": "UAS_INCURSION",
        "started": now,
    }

    return {
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


@router.post("/simulate/clear/{sim_id}")
async def clear_simulation(sim_id: str):
    if sim_id in _ACTIVE_SIMS:
        del _ACTIVE_SIMS[sim_id]
    return {"ok": True}


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
async def nl_query(payload: dict):
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
    grounding = _build_grounding_context(role=payload.get("role"))
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
        )
        usage = result.get("usage") or {}
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
