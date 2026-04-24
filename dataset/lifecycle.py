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
from faults import FaultEvent, check_for_fault
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


def _open_pmcs_sr(asset, d: date) -> ServiceRequest:
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
        job_status="WORK IN PROGRESS",
        condition="Minor",
        priority="10",
        defect_code_primary="SCHD",
        defect_code_secondary="PMCS",
        tm_reference="Operator TM / PMCS Checklist",
        remark_text="Scheduled B-check PMCS. Lubed, cleaned, fluid levels inspected, lamps and safety items verified. No deficiencies noted.",
        source_classification="UNCLASSIFIED",
        detected_classification="UNCLASSIFIED",
        labor_hours_est=2,
        labor_hours_actual=round(random_pmcs_hours(), 1),
        is_pmcs=True,
    )
    # PMCS closes same day (non-NMC) — represent that by setting close_date.
    sr.close_date = d
    sr.job_status = "COMPLETED"
    return sr


def random_pmcs_hours() -> float:
    return random.Random().uniform(1.5, 3.5)


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

    parts_cost = fault_event.avg_parts_cost * rng.uniform(0.85, 1.15)
    labor_hours = fault_event.avg_repair_hours * rng.uniform(0.8, 1.3)

    priority = {
        "Deadlined": rng.choice(["02", "03"]),
        "Degraded":  rng.choice(["05", "06"]),
        "Minor":     rng.choice(["10", "13"]),
        "Supply":    "10",
        "Service":   rng.choice(["10", "13"]),
    }.get(fault_event.condition_impact, "10")

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
        defect_code_primary=fault_event.defect_code[0],
        defect_code_secondary=fault_event.defect_code[1],
        fault_id=fault_event.fault_id,
        fault_component=fault_event.component,
        tm_reference=fault_event.tm_reference,
        maintenance_level=fault_event.maintenance_level,
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
    if fault_event.maintenance_level in ("Intermediate", "Depot"):
        sr.job_status = "EVACUATED"
        sr.evacuated_to = _evacuation_target(fault_event.maintenance_level, asset, rng)

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
    """Execute the 365-day simulation. Returns (srs, snapshots, requisitions)."""
    rng = random.Random(seed + 2)
    reset_sequence_counters()
    _SR_COUNTER["n"] = 0

    calendars = _build_unit_calendars(units, rng)
    all_srs: List[ServiceRequest] = []
    all_reqs: List[PartRequisition] = []
    snapshots: List[DailySnapshot] = []
    mechanic_seq = 0

    start = SIMULATION_START_DATE
    for day_idx in range(SIMULATION_DAYS):
        today = start + timedelta(days=day_idx)

        for asset in assets:
            # Calendar-driven deployment status (overrides the static default).
            asset.deployment_status = _effective_deployment_status(asset, today, calendars)

            # Reset today's operating deltas.
            asset.hours_today = 0.0
            asset.miles_today = 0

            # ---- PMCS due? Generate a PMCS SR (closes same day) ----
            if asset.pmcs_due_date <= today:
                pmcs = _open_pmcs_sr(asset, today)
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
            if readiness_code.startswith("NMC"):
                asset.days_in_current_status += 1 if asset.current_status == readiness_code else 1
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
                deployment_status=asset.deployment_status,
            ))

    return all_srs, snapshots, all_reqs


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
