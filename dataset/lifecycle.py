"""
365-day lifecycle simulator.

For each day in the simulation window, for each asset in the fleet:

  1. Apply calendar context (weekend, field exercise, block leave, workup).
  2. If PMCS is due, open a PMCS SR (scheduled maintenance -- doesn't NMC).
  3. If asset is MC / PMC, it operates per its unit's optempo, accruing hours
     and miles. After operating, a fault-trigger check may fire a corrective
     maintenance SR.
  4. Walk each open SR: advance supply requisitions, transition job status,
     close completed SRs. When the last blocking condition clears, the asset
     returns to MC.
  5. Record a daily readiness snapshot (one row per asset per day).

The output is (sr_list, daily_snapshots, requisition_list). Consistency.py
validates the output; export.py writes it to XLSX.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import List, Optional, Tuple

from config import (
    CALENDAR_EVENTS,
    OPTEMPO,
    PMCS_INTERVALS,
    QC_INSPECTION_CLOSE_CHANCE,
    SIMULATION_START_DATE,
    SIMULATION_DAYS,
    WIP_DAYS_PER_LABOR_HOUR,
)
from defect_codes import sample_defect_code
from echelon import (
    NUMERIC_TO_LABEL as ECHELON_NUMERIC_TO_LABEL,
    LABEL_TO_NUMERIC as ECHELON_LABEL_TO_NUMERIC,
    sample_echelon,
    sample_service_request_type,
)
from faults import FaultEvent, check_for_fault
from priority import format_priority, sample_priority, sample_priority_numeric
from remarks import generate_remark
from supply import (
    PartRequisition,
    advance_requisition,
    create_requisitions_for_sr,
    reset_sequence_counters,
)


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class ServiceRequest:
    sr_number: str
    asset_id: str
    unit_uic: str
    unit_name: str
    equipment_type: str
    tamcn: str
    nsn: str
    serial_number: str
    open_date: date
    close_date: Optional[date] = None
    job_status: str = "OPEN"
    condition: str = "Deadlined"  # Deadlined / Degraded / Minor
    priority: str = "02"
    defect_code_primary: str = ""
    defect_code_secondary: str = ""
    fault_id: str = ""
    fault_component: str = ""
    tm_reference: str = ""
    maintenance_level: str = "Organizational"
    # GCSS-MC schema-parity additions (WP-3, WP-4):
    # - service_request_type mirrors the real export's SERVICE_REQUEST_TYPE
    #   column (~99% "Maintenance - CM"); WP-5 emits this verbatim.
    # - echelon_numeric is the integer form of maintenance_level (1/2/3/4)
    #   the real export ships in ECHELON_OF_MAINT.
    # - deadlined_date is the calendar day the SR was first marked
    #   deadlined (mirrors the real export's DEADLINED_DATE column; null
    #   when the asset never went non-mission-capable for this SR).
    service_request_type: str = "Maintenance - CM"
    echelon_numeric: int = 1
    deadlined_date: Optional[date] = None
    remark_text: str = ""
    source_classification: str = "UNCLASSIFIED"   # the marking the operator put on the record
    detected_classification: str = "UNCLASSIFIED" # what SENTRY thinks it should be
    sensitive_flags: list = field(default_factory=list)
    mechanic_edipi: str = ""
    mechanic_name: str = ""
    labor_hours_est: int = 0
    parts_cost_est: float = 0.0
    parts_cost_actual: float = 0.0
    labor_hours_actual: float = 0.0
    requisitions: list = field(default_factory=list)
    data_quality_flag: str = ""  # "hours_decreased", "serial_tamcn_mismatch", etc.
    evacuated_to: str = ""
    is_pmcs: bool = False


@dataclass
class TMR:
    """Synthetic Transportation Movement Request — what a unit submits to the
    installation movement-control office to move equipment between bases or
    forward to a field-exercise area. Generated to correlate with the calendar
    so reviewers see realistic surge patterns around exercise windows.

    Lightly schema-aligned with the rule-based parser in routes/tmr.py so the
    same downstream validators / approval-chain logic could consume them."""
    tmr_number: str
    submitted_date: date
    scheduled_date: date
    origin: str
    destination: str
    requesting_unit: str
    equipment: list  # list of {type, quantity}
    hazmat: bool
    escort_required: bool
    route: str
    priority: str  # ROUTINE / PRIORITY / URGENT
    status: str    # Draft / Submitted / Approved / Closed
    purpose: str
    point_of_contact: str


@dataclass
class DailySnapshot:
    snapshot_date: date
    asset_id: str
    unit_uic: str
    unit_name: str
    equipment_type: str
    tamcn: str
    serial_number: str
    readiness_code: str         # MC / PMC / NMCM / NMCS
    condition: str              # Deadlined / Degraded / ...
    open_sr_count: int
    days_deadlined: int
    days_since_maintenance: int
    current_hours: float
    current_miles: int
    parts_on_order: int
    location: str
    deployment_status: str


# ---------------------------------------------------------------------------
# Calendar helpers
# ---------------------------------------------------------------------------

def _is_weekend(d: date) -> bool:
    return d.weekday() >= 5


def _build_unit_calendars(units, rng: random.Random) -> dict:
    """Produce per-unit date -> deployment_status overrides.

    Each unit gets 2-3 field exercises and forward-deployed units get a
    deployment workup. Block leave is applied globally.
    """
    calendars: dict = {u.name: {} for u in units}
    start = SIMULATION_START_DATE
    end = start + timedelta(days=SIMULATION_DAYS - 1)

    for u in units:
        count = rng.randint(*CALENDAR_EVENTS["field_exercise_count_per_unit"])
        placed: list = []
        tries = 0
        while len(placed) < count and tries < 60:
            tries += 1
            dur = rng.randint(*CALENDAR_EVENTS["field_exercise_duration_days"])
            offset = rng.randint(14, SIMULATION_DAYS - dur - 14)
            fx_start = start + timedelta(days=offset)
            fx_end = fx_start + timedelta(days=dur)
            if any(fx_start <= p_end and p_start <= fx_end for p_start, p_end in placed):
                continue
            placed.append((fx_start, fx_end))
            d = fx_start
            while d <= fx_end:
                calendars[u.name][d] = "field_exercise"
                d += timedelta(days=1)

        if u.deployment_status == "forward_deployed":
            workup_dur = CALENDAR_EVENTS["deployment_workup_duration_days"]
            offset = rng.randint(60, SIMULATION_DAYS - workup_dur - 30)
            d = start + timedelta(days=offset)
            for _ in range(workup_dur):
                calendars[u.name][d] = "field_exercise"
                d += timedelta(days=1)

    return calendars


def _effective_deployment_status(asset, d: date, calendars: dict) -> str:
    override = calendars.get(asset.unit_name, {}).get(d)
    if override:
        return override
    # Block leave: nobody's in the field
    if CALENDAR_EVENTS["block_leave_start"] <= d <= CALENDAR_EVENTS["block_leave_end"]:
        return "garrison"
    return asset.deployment_status


def _operate_probability(asset, d: date, calendars: dict) -> float:
    base = OPTEMPO[asset.optempo]["operate_prob"]
    if _is_weekend(d):
        base *= CALENDAR_EVENTS["weekend_optempo_modifier"]
    if CALENDAR_EVENTS["block_leave_start"] <= d <= CALENDAR_EVENTS["block_leave_end"]:
        base *= 0.20  # holiday stand-down
    override = calendars.get(asset.unit_name, {}).get(d)
    if override == "field_exercise":
        base = min(1.0, base * 1.4)
    return base


# ---------------------------------------------------------------------------
# SR lifecycle helpers
# ---------------------------------------------------------------------------

_SR_COUNTER = {"n": 0}


def _new_sr_number(asset, d: date) -> str:
    _SR_COUNTER["n"] += 1
    yday = (d - date(d.year, 1, 1)).days + 1
    seq = _SR_COUNTER["n"] % 10000
    return f"{asset.unit_uic}-{d.year % 10}{yday:03d}-{seq:04d}"


def _open_pmcs_sr(asset, d: date, rng: random.Random) -> ServiceRequest:
    tm_ref = "Operator TM / PMCS Checklist"
    raw = rng.choice(_PMCS_REMARKS)
    # Template tokens (e.g. {tm_ref}) only appear in the deferred-deficiency
    # variants. Plain-text remarks pass through unchanged because str.format
    # is a no-op in the absence of braces.
    if "{" in raw:
        try:
            remark = raw.format(tm_ref=tm_ref)
        except (KeyError, IndexError):
            remark = raw
    else:
        remark = raw
    sr = ServiceRequest(
        sr_number=_new_sr_number(asset, d),
        asset_id=asset.asset_id,
        unit_uic=asset.unit_uic,
        unit_name=asset.unit_name,
        equipment_type=asset.equipment_type,
        tamcn=asset.tamcn,
        nsn=asset.nsn,
        serial_number=asset.serial_number,
        open_date=d,
        job_status="COMPLETED",
        condition="Minor",
        # PMCS records use the GCSS-MC SERVICE_REQUEST_TYPE for preventive
        # maintenance and a routine priority. They are excluded from the
        # CM-only real export, but we keep them in the canonical synth
        # corpus for PULSE / MARK consumers.
        priority=format_priority(13),
        defect_code_primary="SCHD",
        defect_code_secondary="PMCS",
        service_request_type="Maintenance - PM",
        echelon_numeric=1,
        maintenance_level="Organizational",
        tm_reference=tm_ref,
        remark_text=remark,
        source_classification="UNCLASSIFIED",
        detected_classification="UNCLASSIFIED",
        labor_hours_est=2,
        labor_hours_actual=round(rng.uniform(1.5, 3.5), 1),
        is_pmcs=True,
    )
    sr.close_date = d
    return sr


# 20+ PMCS remark variants -- mix of clean B-check passes plus deferred-deficiency
# write-ups so SENTRY has texture for "deferred maintenance trending up" stories.
# Deferred entries follow the shop convention "found X, within tolerance per {tm_ref},
# monitoring NLT next PMCS" so consistency.py won't trip them as readiness flags.
_PMCS_REMARKS = [
    # Clean B-check passes (10)
    "Scheduled B-check PMCS. Lubed, cleaned, fluid levels inspected, lamps and safety items verified. No deficiencies noted.",
    "B-check PMCS complete per op TM. All fluid levels nominal, no leaks, lamps functional. Tires checked, pressures adjusted. Veh RTS.",
    "Monthly B-check. Engine bay clean, belts + hoses good, no fluid loss since last PMCS. Safety items ok. PMCS signed off.",
    "Op PMCS per schedule. Found no deficiencies beyond normal wear. Topped off all fluids to mark, recorded hours.",
    "B-check PMCS done. Replaced wiper fluid, topped coolant, tightened battery terminal. No new defects identified.",
    "B-check complete. Walkaround clean, undercarriage clean, exhaust clean. Topped DEF, recorded odometer/hourmeter. RTS.",
    "Monthly PMCS executed by shop. All BII verified IAW DA Form 2404. NMC items: none. PMC items: none. Veh full MC.",
    "B-check by 0431 team. Air filter clean, sediment bowl clean, glow-plug check ok. Veh signed back to operator.",
    "Op-level PMCS, all subsystems pass. Brake pedal travel within limits. Steering linkages tight. Lights all functional.",
    "B-check + lube. Greased zerks per chart, swapped wipers (preventive), nothing elevated. Closed at end of day.",
    # Deferred-deficiency variants -- "found X, within tolerance, monitoring" (10+)
    "PMCS B-check. Found weep at trans pan, within tolerance per {tm_ref}, monitoring NLT next PMCS.",
    "Monthly B-check. Slow seep at front diff seal, drip rate within TM limit, marked for monitor at next interval.",
    "B-check complete. Slight battery cable corrosion noted on neg post, cleaned and dielectric grease applied. Monitor next PMCS.",
    "PMCS done. Brake pad wear at 35% remaining (LF/RF), within tolerance per {tm_ref}; deferred replacement to next B-check window.",
    "B-check. Heat-shield mounting bolt loose, re-torqued to spec. No further wear evident; tagged for monitoring.",
    "Op PMCS. Wiper blade streak observed in arc, residual function acceptable, replacement scheduled NLT next service.",
    "Monthly B-check. Coolant level at min cold mark, topped to full; minor weep at upper hose clamp, within tol, monitoring.",
    "B-check complete. Tire tread at 5/32 LR within deadline limit per {tm_ref}; flagged for replacement at next PMCS interval.",
    "PMCS executed. Steering box drip <1 drop/min, within TM tolerance; marked DR for monitoring rather than corrective action.",
    "B-check. Found minor cracking on serpentine belt face, no chunking, within TM acceptance criteria; deferred to next interval.",
    "Op PMCS. Glow-plug indicator slow to extinguish (~2s over spec), still functional; deferred for harness diagnostic next service.",
    "Monthly B-check by shop. Loose grommet at firewall pass-through, re-seated, monitoring for further movement.",
    "B-check complete. Air-cleaner restriction indicator at 80% of red zone, within tolerance, replacement scheduled at next PMCS.",
    "PMCS B-check. Slight fuel-line dampness at quick-disconnect, no measurable drip, within TM limit, monitoring NLT next service.",
]


def _open_corrective_sr(
    asset,
    fault_event: FaultEvent,
    mechanic,
    current_date: date,
    rng: random.Random,
    roster_seq: int,
) -> Tuple[ServiceRequest, List[PartRequisition]]:
    sr_number = _new_sr_number(asset, current_date)
    remark, flags, ground_truth_cls = generate_remark(
        fault_event, asset, mechanic, current_date, rng, seq=roster_seq,
    )

    # The source marking is what the operator typed. 94% of the time it
    # matches the ground-truth; 6% of the time it's understated (the record
    # was marked UNCLASSIFIED but contains CUI or higher content). That
    # mis-marking is precisely what SENTRY's classification-discrepancy flag
    # detects, so it is intentional data quality for demo.
    if rng.random() < 0.94:
        source_cls = ground_truth_cls
    else:
        source_cls = "UNCLASSIFIED"  # operator under-marked

    # Wider actual variance -- bimodal scrap/reuse effects in real shops.
    parts_cost = fault_event.avg_parts_cost * rng.uniform(0.70, 1.45)
    labor_hours = fault_event.avg_repair_hours * rng.uniform(0.7, 1.5)

    # WP-2: priority now emits the full GCSS-MC string ("06 B-Urgent") and
    # is sampled to match the real export distribution conditioned on the
    # SR's condition impact.
    priority = sample_priority(rng, condition=fault_event.condition_impact)

    # WP-1: defect codes drawn from the real-export vocabulary (FCON.CBB,
    # WPNS.CBB, ELEC.INOP, ...) with component-aware bias and the dirty
    # trailing-period signal SENTRY's ingest adapter must clean.
    defect_primary, defect_secondary, _ = sample_defect_code(
        rng, fault_component=fault_event.component
    )

    # WP-3: ECHELON_OF_MAINT (numeric 1/2/3/4) is sampled from the real
    # distribution biased by the fault's declared maintenance level. The
    # human-readable label is derived from the numeric so the two stay
    # consistent end-to-end.
    echelon_numeric, echelon_label = sample_echelon(
        rng, declared_level=fault_event.maintenance_level
    )

    sr = ServiceRequest(
        sr_number=sr_number,
        asset_id=asset.asset_id,
        unit_uic=asset.unit_uic,
        unit_name=asset.unit_name,
        equipment_type=asset.equipment_type,
        tamcn=asset.tamcn,
        nsn=asset.nsn,
        serial_number=asset.serial_number,
        open_date=current_date,
        condition=fault_event.condition_impact,
        priority=priority,
        defect_code_primary=defect_primary,
        defect_code_secondary=defect_secondary,
        fault_id=fault_event.fault_id,
        fault_component=fault_event.component,
        tm_reference=fault_event.tm_reference,
        maintenance_level=echelon_label,
        service_request_type=sample_service_request_type(rng),
        echelon_numeric=echelon_numeric,
        deadlined_date=current_date if fault_event.condition_impact == "Deadlined" else None,
        remark_text=remark,
        source_classification=source_cls,
        detected_classification=ground_truth_cls,
        sensitive_flags=flags,
        mechanic_edipi=mechanic.edipi,
        mechanic_name=mechanic.display,
        labor_hours_est=fault_event.avg_repair_hours,
        parts_cost_est=round(fault_event.avg_parts_cost, 2),
        parts_cost_actual=round(parts_cost, 2),
        labor_hours_actual=round(labor_hours, 1),
        job_status="WORK IN PROGRESS",
    )

    # For Intermediate / Depot-level repairs, the asset gets evacuated.
    if echelon_label in ("Intermediate", "Depot"):
        sr.job_status = "EVACUATED"
        sr.evacuated_to = _evacuation_target(echelon_label, asset, rng)

    reqs = create_requisitions_for_sr(sr_number, asset, fault_event, current_date, rng)
    sr.requisitions = reqs

    # If parts are required, the SR sits in SHT PART until deliveries land.
    # If no parts are required (labor-only repair), stay in WIP.
    if reqs:
        sr.job_status = "SHT PART"
    else:
        sr.job_status = "WORK IN PROGRESS"
    return sr, reqs


def _evacuation_target(level: str, asset, rng: random.Random) -> str:
    if level == "Depot":
        return rng.choice(["MCLB Albany", "MCLB Barstow", "Red River Army Depot"])
    return rng.choice(["1st Maint Bn IMA", "2d Maint Bn IMA", "3d Maint Bn IMA"])


# ---------------------------------------------------------------------------
# Progress an open SR one day forward
# ---------------------------------------------------------------------------

def _progress_sr(sr: ServiceRequest, asset, today: date, rng: random.Random) -> None:
    if sr.close_date is not None:
        return
    # Evacuated SRs take much longer and close via depot turnaround (modeled
    # as 45-120 day random window).
    if sr.job_status == "EVACUATED":
        eva_age = (today - sr.open_date).days
        if eva_age >= rng.randint(45, 120):
            sr.job_status = "COMPLETED"
            sr.close_date = today
        return

    # Advance requisitions; when all parts received, transition to WIP.
    parts_all_in = True
    for req in sr.requisitions:
        advance_requisition(req, today)
        if not req.is_received or today < req.received_date:
            parts_all_in = False

    if sr.job_status == "SHT PART" and parts_all_in:
        sr.job_status = "WORK IN PROGRESS"
    elif sr.job_status == "WORK IN PROGRESS":
        # Calendar-day burn proportional to labor hours estimate.
        wip_entry = max(
            (r.received_date for r in sr.requisitions if r.is_received),
            default=sr.open_date,
        )
        wip_days = (today - wip_entry).days
        required = max(1, int(sr.labor_hours_est * WIP_DAYS_PER_LABOR_HOUR))
        if wip_days >= required:
            sr.job_status = "QC INSPECTION"
            return
    elif sr.job_status == "QC INSPECTION":
        # QC closes probabilistically (1-2 days typical).
        if rng.random() < QC_INSPECTION_CLOSE_CHANCE:
            sr.job_status = "COMPLETED"
            sr.close_date = today


# ---------------------------------------------------------------------------
# Readiness code derivation
# ---------------------------------------------------------------------------

def _readiness_for_asset(asset) -> Tuple[str, str]:
    """Return (readiness_code, condition) from the asset's open SR list."""
    if not asset.open_srs:
        return "MC", "Mission Capable"
    # If any SR is Deadlined, asset is NMC*. SHT PART indicates NMCS; otherwise NMCM.
    worst = None
    any_nmcs = False
    for sr in asset.open_srs:
        if sr.close_date is not None:
            continue
        if sr.condition == "Deadlined":
            if sr.job_status == "SHT PART" or any(
                not r.is_received for r in sr.requisitions
            ):
                any_nmcs = True
            worst = "Deadlined"
        elif sr.condition == "Degraded" and worst != "Deadlined":
            worst = "Degraded"
    if worst == "Deadlined":
        return ("NMCS" if any_nmcs else "NMCM", "Deadlined")
    if worst == "Degraded":
        return "PMC", "Degraded"
    return "MC", "Minor"


# ---------------------------------------------------------------------------
# Daily loop
# ---------------------------------------------------------------------------

def run_simulation(units, assets, roster, seed: int):
    """Execute the 365-day simulation. Returns (srs, snapshots, requisitions).

    Fully idempotent: all module-level counters are reset up front, and the
    assets passed in are restored to simulation-start state (hours / miles
    roll back to initial, SR history cleared, PMCS jitter re-drawn).
    """
    rng = random.Random(seed + 2)
    reset_sequence_counters()
    _SR_COUNTER["n"] = 0

    # Restore each asset to start-of-simulation state so callers can re-run
    # in the same process without surprising cross-run contamination.
    jitter_rng = random.Random(seed + 7)
    for a in assets:
        a.current_hours = a.initial_hours
        a.current_miles = a.initial_miles
        a.current_status = "MC"
        a.current_deployment_status = a.deployment_status
        a.days_in_current_status = 0
        a.days_nmc_last_12mo = 0
        a.nmc_events_last_12mo = 0
        a.open_srs = []
        a.maintenance_history = []
        a.pmcs_due_date = SIMULATION_START_DATE + timedelta(
            days=jitter_rng.randint(0, PMCS_INTERVALS["B_CHECK"] - 1),
        )
        a.last_maintenance_date = SIMULATION_START_DATE
        a.days_since_last_maintenance = 0
        a.hours_today = 0.0
        a.miles_today = 0

    calendars = _build_unit_calendars(units, rng)
    all_srs: List[ServiceRequest] = []
    all_reqs: List[PartRequisition] = []
    snapshots: List[DailySnapshot] = []
    mechanic_seq = 0

    start = SIMULATION_START_DATE
    for day_idx in range(SIMULATION_DAYS):
        today = start + timedelta(days=day_idx)

        for asset in assets:
            # Today's effective deployment posture (canonical is preserved on
            # asset.deployment_status; the daily override lives on current_*).
            asset.current_deployment_status = _effective_deployment_status(asset, today, calendars)

            # Reset today's operating deltas.
            asset.hours_today = 0.0
            asset.miles_today = 0

            # ---- PMCS due? Generate a PMCS SR (closes same day). PMCS only
            # runs on weekdays outside block leave; if overdue on a weekend,
            # it slips to the next business day automatically via this check.
            if asset.pmcs_due_date <= today and not _is_weekend(today):
                in_block_leave = (
                    CALENDAR_EVENTS["block_leave_start"] <= today <= CALENDAR_EVENTS["block_leave_end"]
                )
                if not in_block_leave:
                    pmcs = _open_pmcs_sr(asset, today, rng)
                    all_srs.append(pmcs)
                    asset.maintenance_history.append(pmcs)
                    asset.last_maintenance_date = today
                    asset.pmcs_due_date = today + timedelta(days=PMCS_INTERVALS["B_CHECK"])

            # ---- Operate? ----
            readiness_code, _ = _readiness_for_asset(asset)
            if readiness_code in ("MC", "PMC"):
                if rng.random() < _operate_probability(asset, today, calendars):
                    lo_hr, hi_hr = OPTEMPO[asset.optempo]["hours_per_day"]
                    lo_mi, hi_mi = OPTEMPO[asset.optempo]["miles_per_day"]
                    asset.hours_today = rng.uniform(lo_hr, hi_hr)
                    asset.miles_today = rng.uniform(lo_mi, hi_mi)
                    asset.current_hours += asset.hours_today
                    asset.current_miles += int(asset.miles_today)

                    # Fault check
                    fault = check_for_fault(asset, today, rng)
                    if fault:
                        # Pick a mechanic from the unit's roster.
                        in_unit = [m for m in roster if m.unit_name == asset.unit_name]
                        mechanic = rng.choice(in_unit) if in_unit else rng.choice(roster)
                        mechanic_seq += 1
                        sr, reqs = _open_corrective_sr(asset, fault, mechanic, today, rng, mechanic_seq)
                        asset.open_srs.append(sr)
                        asset.maintenance_history.append(sr)
                        all_srs.append(sr)
                        all_reqs.extend(reqs)

            # ---- Progress open SRs ----
            for sr in list(asset.open_srs):
                _progress_sr(sr, asset, today, rng)
                if sr.close_date is not None:
                    asset.open_srs.remove(sr)
                    asset.last_maintenance_date = sr.close_date

            # ---- Daily book-keeping ----
            asset.days_since_last_maintenance = (today - asset.last_maintenance_date).days
            readiness_code, condition = _readiness_for_asset(asset)
            if readiness_code == asset.current_status:
                asset.days_in_current_status += 1
            else:
                asset.days_in_current_status = 1
            asset.current_status = readiness_code

            parts_on_order = sum(
                1
                for sr in asset.open_srs
                for req in sr.requisitions
                if not req.is_received or today < req.received_date
            )

            snapshots.append(DailySnapshot(
                snapshot_date=today,
                asset_id=asset.asset_id,
                unit_uic=asset.unit_uic,
                unit_name=asset.unit_name,
                equipment_type=asset.equipment_type,
                tamcn=asset.tamcn,
                serial_number=asset.serial_number,
                readiness_code=readiness_code,
                condition=condition,
                open_sr_count=len(asset.open_srs),
                days_deadlined=asset.days_in_current_status if readiness_code.startswith("NMC") else 0,
                days_since_maintenance=asset.days_since_last_maintenance,
                current_hours=round(asset.current_hours, 1),
                current_miles=asset.current_miles,
                parts_on_order=parts_on_order,
                location=asset.location,
                deployment_status=asset.current_deployment_status,
            ))

    return all_srs, snapshots, all_reqs


# ---------------------------------------------------------------------------
# TMR (Transportation Movement Request) generator
# ---------------------------------------------------------------------------

# Canonical USMC installations the dataset's units actually live around. Pulled
# from routes/tmr.py:KNOWN_LOCATIONS so origins/destinations match what the
# parser recognises. Origins are weighted toward the home installations of the
# units in the synthetic fleet.
_TMR_INSTALLATIONS = [
    "Camp Lejeune, NC",
    "Camp Pendleton, CA",
    "Camp Geiger, NC",
    "MCAS Cherry Point, NC",
    "MCAS Beaufort, SC",
    "MCAS Yuma, AZ",
    "MCLB Albany, GA",
    "MCLB Barstow, CA",
    "MCAGCC 29 Palms, CA",
    "Camp Henderson (synthetic)",
]

_TMR_EQUIP_POOLS = {
    "wheeled_logistics": ["JLTV", "MTVR_CARGO", "LVSR", "TRAILER_M1095"],
    "armor":             ["M1A1_ABRAMS", "M88A2_RECOVERY", "LAV_25"],
    "aviation_support":  ["MEP_803A", "ROWPU", "TRAILER_M1095"],
    "fires":             ["HIMARS", "MTVR_CARGO", "TRAILER_M1095"],
    "radar":             ["AN_TPS80_GATOR", "AN_TPQ36_FIREFINDER", "MEP_803A"],
}

_TMR_PURPOSES = [
    "Pre-exercise equipment positioning",
    "Post-exercise retrograde",
    "Combined Arms Exercise (CAX) lift",
    "Depot-level evacuation to MCLB",
    "Inter-MEF cross-deck for combined exercise",
    "Field-training rotation",
    "Range support package movement",
    "Operational Readiness Inspection lift",
]

_TMR_ROUTES = [
    "I-95 S → US-17 W → installation main gate",
    "I-40 W → US-70 E → installation ECP-1",
    "I-10 E → AZ-95 N → installation ECP-2",
    "I-15 N → CA-247 → MCAGCC main",
    "I-95 N → US-17 N → MCB main gate",
    "Convoy serial split — admin lead via I-95, tactical via SR-50",
]


def _generate_tmrs(units, calendars, seed: int) -> List[TMR]:
    """Emit ~30 TMRs across the 365-day window, correlated with field-exercise
    dates from the unit calendars. ~70% of TMRs land in a window 3-7 days
    before/after a unit's exercise event so the BASTION TMR feed shows the
    realistic 'surge before exercise, retrograde after' pattern.
    """
    rng = random.Random(seed + 11)
    tmrs: List[TMR] = []

    # Build a (unit, exercise_start, exercise_end) list from the calendars.
    exercises: list[tuple] = []
    for u in units:
        cal = calendars.get(u.name, {})
        if not cal:
            continue
        # Collapse contiguous field_exercise days into windows.
        days = sorted(d for d, status in cal.items() if status == "field_exercise")
        if not days:
            continue
        run_start = days[0]
        prev = days[0]
        for d in days[1:]:
            if (d - prev).days > 1:
                exercises.append((u, run_start, prev))
                run_start = d
            prev = d
        exercises.append((u, run_start, prev))

    target_total = 30
    seq = 1

    # ~70% exercise-correlated TMRs.
    correlated_target = int(target_total * 0.7)
    if exercises:
        for _ in range(correlated_target):
            unit, fx_start, fx_end = rng.choice(exercises)
            # Pre-exercise lift OR post-exercise retrograde.
            is_pre = rng.random() < 0.6
            if is_pre:
                offset = rng.randint(3, 7)
                scheduled = fx_start - timedelta(days=offset)
                purpose = rng.choice([
                    "Pre-exercise equipment positioning",
                    "Field-training rotation",
                    "Range support package movement",
                ])
                origin = unit.location if unit.location in _TMR_INSTALLATIONS else _TMR_INSTALLATIONS[0]
                destination = "Camp Henderson (synthetic)"
            else:
                offset = rng.randint(2, 6)
                scheduled = fx_end + timedelta(days=offset)
                purpose = "Post-exercise retrograde"
                origin = "Camp Henderson (synthetic)"
                destination = unit.location if unit.location in _TMR_INSTALLATIONS else _TMR_INSTALLATIONS[0]
            submitted = scheduled - timedelta(days=rng.randint(3, 14))
            tmrs.append(_make_tmr(seq, unit, origin, destination, submitted, scheduled, purpose, rng))
            seq += 1

    # Remaining ~30% routine non-correlated TMRs (depot evac, inter-MEF, etc.)
    # We deliberately steer the last few into the most-recent 21-day window so
    # the panel always shows a healthy mix of Approved / Submitted / Draft TMRs
    # alongside the historical Closed log.
    today_idx = SIMULATION_DAYS - 1
    while len(tmrs) < target_total:
        unit = rng.choice(units)
        slots_remaining = target_total - len(tmrs)
        if slots_remaining <= 4:
            # Recent + future bias: scheduled within the last 21d window or
            # near-future so status comes back as Submitted/Approved/Draft.
            day_offset = rng.randint(today_idx - 14, today_idx + 14)
            scheduled = SIMULATION_START_DATE + timedelta(days=day_offset)
        else:
            scheduled = SIMULATION_START_DATE + timedelta(days=rng.randint(20, SIMULATION_DAYS - 10))
        submitted = scheduled - timedelta(days=rng.randint(5, 21))
        # Bias toward depot evacuation routes.
        if rng.random() < 0.5:
            origin = unit.location if unit.location in _TMR_INSTALLATIONS else "Camp Lejeune, NC"
            destination = rng.choice(["MCLB Albany, GA", "MCLB Barstow, CA"])
            purpose = "Depot-level evacuation to MCLB"
        else:
            origin = unit.location if unit.location in _TMR_INSTALLATIONS else "Camp Lejeune, NC"
            destination = rng.choice([loc for loc in _TMR_INSTALLATIONS if loc != origin])
            purpose = rng.choice([
                "Inter-MEF cross-deck for combined exercise",
                "Operational Readiness Inspection lift",
                "Combined Arms Exercise (CAX) lift",
            ])
        tmrs.append(_make_tmr(seq, unit, origin, destination, submitted, scheduled, purpose, rng))
        seq += 1

    tmrs.sort(key=lambda t: t.submitted_date)
    return tmrs


def _make_tmr(seq: int, unit, origin: str, destination: str, submitted: date,
              scheduled: date, purpose: str, rng: random.Random) -> TMR:
    # Equipment pool by unit profile.
    if "Tank" in unit.name or "LAR" in unit.name:
        pool = _TMR_EQUIP_POOLS["armor"]
    elif "Marines" in unit.name or "11" in unit.name:
        pool = _TMR_EQUIP_POOLS["fires"]
    elif "MALS" in unit.name or "MWSS" in unit.name:
        pool = _TMR_EQUIP_POOLS["aviation_support"]
    elif "LAAD" in unit.name:
        pool = _TMR_EQUIP_POOLS["radar"]
    else:
        pool = _TMR_EQUIP_POOLS["wheeled_logistics"]

    n_types = rng.randint(1, 3)
    chosen = rng.sample(pool, min(n_types, len(pool)))
    equipment = [{"type": t, "quantity": rng.randint(1, 6)} for t in chosen]

    hazmat = any(e["type"] in ("HIMARS", "M1A1_ABRAMS", "MEP_803A") for e in equipment) or rng.random() < 0.20
    priority = rng.choices(["ROUTINE", "PRIORITY", "URGENT"], weights=[0.75, 0.20, 0.05])[0]

    # Status biased by submitted-vs-scheduled timing relative to "today" — the
    # last simulated day. We bucket against scheduled_date so the panel always
    # shows a healthy mix of in-flight TMRs (Draft/Submitted/Approved) on top of
    # completed history. The 14-day band is the "recent" window.
    today = SIMULATION_START_DATE + timedelta(days=SIMULATION_DAYS - 1)
    if scheduled > today:
        status = rng.choices(["Draft", "Submitted", "Approved"], weights=[0.2, 0.4, 0.4])[0]
    elif scheduled >= today - timedelta(days=14):
        status = rng.choices(["Approved", "Closed"], weights=[0.4, 0.6])[0]
    else:
        status = "Closed"

    poc = f"S-4 dispatch · {unit.name} · ext {rng.randint(4000, 4999)}"
    route = rng.choice(_TMR_ROUTES)
    yday = (submitted - date(submitted.year, 1, 1)).days + 1
    tmr_number = f"TMR-{submitted.year % 100:02d}{yday:03d}-{seq:04d}"
    return TMR(
        tmr_number=tmr_number,
        submitted_date=submitted,
        scheduled_date=scheduled,
        origin=origin,
        destination=destination,
        requesting_unit=unit.name,
        equipment=equipment,
        hazmat=hazmat,
        escort_required=hazmat,
        route=route,
        priority=priority,
        status=status,
        purpose=purpose,
        point_of_contact=poc,
    )


def generate_tmrs(units, seed: int, calendars: Optional[dict] = None) -> List[TMR]:
    """Public entry point used by main.py + backend state.py.

    If `calendars` isn't supplied (testing scenarios), build one from the unit
    list so exercise-correlation still works.
    """
    rng = random.Random(seed + 2)
    if calendars is None:
        calendars = _build_unit_calendars(units, rng)
    return _generate_tmrs(units, calendars, seed)


if __name__ == "__main__":
    from config import RANDOM_SEED, OUTPUT_TARGETS
    from fleet import generate_fleet
    from personnel import generate_personnel

    units, assets = generate_fleet(RANDOM_SEED)
    roster = generate_personnel(units, OUTPUT_TARGETS["personnel_count"], RANDOM_SEED)

    print(f"Simulating {SIMULATION_DAYS} days over {len(assets)} assets...")
    srs, snaps, reqs = run_simulation(units, assets, roster, RANDOM_SEED)
    print(f"\n  Service Requests generated: {len(srs):,}")
    print(f"  Daily snapshots:            {len(snaps):,}")
    print(f"  Part requisitions:          {len(reqs):,}")

    # Quick quality signals
    from collections import Counter
    status_mix = Counter(sr.job_status for sr in srs if not sr.is_pmcs)
    cls_mix = Counter(sr.detected_classification for sr in srs if not sr.is_pmcs)
    print(f"\n  CM SR job status mix: {dict(status_mix)}")
    print(f"  CM SR classification mix: {dict(cls_mix)}")

    mc_snaps = [s for s in snaps if s.snapshot_date == snaps[-1].snapshot_date]
    from collections import Counter as C
    last_day = C(s.readiness_code for s in mc_snaps)
    print(f"\n  Fleet readiness on last day: {dict(last_day)}")
    mc_rate = last_day["MC"] / sum(last_day.values()) * 100
    print(f"  Fleet MC rate (last day): {mc_rate:.1f}%")
