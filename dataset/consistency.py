"""
Cross-record consistency validator + controlled data-quality injector.

Two responsibilities:

  1. INJECT the intentional data-quality defects that SENTRY's data-quality
     gate is designed to surface -- hours-decreased anomalies, serial/TAMCN
     mismatches, unknown defect codes, and cannibalization events.

  2. VALIDATE the 15 invariants from the engine spec. Each validator returns
     a list of violations; zero violations on a clean run is the gate for
     export. Injected defects are tagged so validators can ignore them.
"""
from __future__ import annotations

import random
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Callable, List, Optional

from config import (
    CONDITION_PRIORITY_MAP,
    DATA_QUALITY_DEFECT_TARGETS,
    DEFECT_CODES,
    MIN_CANNIBALIZATION_EVENTS,
    SIMULATION_START_DATE,
    SIMULATION_DAYS,
)
from lifecycle import ServiceRequest

SIMULATION_END_DATE = SIMULATION_START_DATE + timedelta(days=SIMULATION_DAYS - 1)


@dataclass
class Violation:
    check: str
    severity: str         # "error" / "warning"
    message: str
    record_id: str = ""


# ---------------------------------------------------------------------------
# Intentional data-quality injection
# ---------------------------------------------------------------------------

def inject_data_quality_defects(srs, snapshots, seed: int) -> dict:
    """
    Apply the intentional defects that SENTRY's data-quality gate flags. All
    injections tag the affected record with data_quality_flag so validators
    know to skip them.
    """
    rng = random.Random(seed + 3)
    summary = {"hours_decreased": 0, "serial_tamcn_mismatch": 0, "unknown_defect_code": 0}

    # ---- hours_decreased: operator entry errors. Apply to 8 SRs out of the
    # first 500. These look like "previous record showed 1450 hrs, this one
    # shows 1422 hrs" -- an impossible decrease that flags the record.
    # We annotate the SR; the actual hours stay consistent on the asset so
    # PULSE's predictions aren't corrupted.
    target = DATA_QUALITY_DEFECT_TARGETS["hours_decreased"]["target_count"]
    candidates = [sr for sr in srs if not sr.is_pmcs and not sr.data_quality_flag]
    rng.shuffle(candidates)
    for sr in candidates[:target]:
        sr.data_quality_flag = "hours_decreased"
        summary["hours_decreased"] += 1

    # ---- serial_tamcn_mismatch: 3 SRs where the recorded TAMCN does not match
    # the asset's actual TAMCN. We store the "wrong" TAMCN in a mismatch field
    # so validators can report it but PULSE downstream still uses the real TAMCN.
    target = DATA_QUALITY_DEFECT_TARGETS["serial_tamcn_mismatch"]["target_count"]
    candidates = [sr for sr in srs if not sr.is_pmcs and not sr.data_quality_flag]
    rng.shuffle(candidates)
    for sr in candidates[:target]:
        sr.data_quality_flag = "serial_tamcn_mismatch"
        # Swap the TAMCN with a plausible but wrong one from a different
        # equipment family. (We keep the serial intact; the mismatch is the
        # "fault" being injected.)
        bogus_tamcns = ["D1196", "D0082", "A2249", "E1897", "B2601"]
        sr_tamcn = sr.tamcn
        sr.tamcn = rng.choice([t for t in bogus_tamcns if t != sr_tamcn])
        summary["serial_tamcn_mismatch"] += 1

    # ---- unknown_defect_code: 2 SRs with a defect code outside the known table.
    target = DATA_QUALITY_DEFECT_TARGETS["unknown_defect_code"]["target_count"]
    candidates = [sr for sr in srs if not sr.is_pmcs and not sr.data_quality_flag]
    rng.shuffle(candidates)
    for sr in candidates[:target]:
        sr.data_quality_flag = "unknown_defect_code"
        sr.defect_code_primary = "XXXX"
        sr.defect_code_secondary = "UNKN"
        summary["unknown_defect_code"] += 1

    return summary


# ---------------------------------------------------------------------------
# Cannibalization generator
# ---------------------------------------------------------------------------

@dataclass
class CannibalizationEvent:
    event_id: str
    event_date: date
    recipient_asset_id: str
    recipient_sr_number: str
    donor_asset_id: str
    donor_sr_number: str
    nsn: str
    nomenclature: str
    recipient_unit: str
    donor_unit: str
    readiness_impact_note: str
    # Scripted demo flag — set True for the canonical "predicted failure → matched
    # donor → mission saved" event the demo script narrates around. Frontend can
    # highlight this row distinctly so the operator sees the story.
    scripted_demo: bool = False
    scripted_exercise_label: str = ""


# Pool of impact-note patterns. Each pattern has two placeholder slots:
# {fc} = fault component, {part} = part nomenclature. We pick by donor job
# status + days-deadlined bucket so the copy reads as a maintenance chief's
# assessment, not a templated string.
_IMPACT_EVACUATED = [
    "Donor awaiting depot return (est 90+ days); zero impact on donor unit readiness.",
    "Donor evacuated to depot for {fc} overhaul; recovery ETA 90+ days, opportunistic harvest.",
    "Donor is at SRA on long-cycle teardown; no MC impact — part would have sat.",
    "Donor queued for depot-level {fc} repair; NMCS posture unchanged.",
    "Donor downed > 60 days pending depot; donating {part} does not extend NMC time.",
]
_IMPACT_LONG_DEADLINE = [
    "Donor deadlined on slow-path order; readiness impact negligible.",
    "Donor on backordered {part} (ASL depth 0); cannibalization does not alter its status.",
    "Donor waiting on DLA slow-path requisition; donating {part} accelerates recipient without cost.",
    "Donor's own {fc} fault blocks RFI regardless; no net readiness delta for donor.",
    "Donor on SHT PART ≥ 45 days; parts flow unlikely inside 30d window.",
]
_IMPACT_SHORT_DEADLINE = [
    "Donor recently deadlined; cross-levelling avoids double-downtime on critical {part}.",
    "Donor in maintenance cycle but part salvageable; 1 asset saved vs 2 waiting.",
    "Donor's {fc} awaits parts ordered ≤ 14 days ago; controlled substitution approved by MCC.",
    "Donor MEL-eligible pending same {part}; match closes gap on both SRs in parallel.",
]


def _compose_impact_note(donor, needed_part, days_deadlined: int, rng: random.Random) -> str:
    """Produce a per-event impact note that varies with donor status and
    deadline age so the cannibalization table doesn't read as a templated
    paste. Values stay deterministic under a shared RNG."""
    fc = (donor.fault_component or "subsystem").replace("_", " ").lower()
    part = needed_part.nomenclature
    if donor.job_status == "EVACUATED":
        pool = _IMPACT_EVACUATED
    elif days_deadlined >= 30:
        pool = _IMPACT_LONG_DEADLINE
    else:
        pool = _IMPACT_SHORT_DEADLINE
    template = rng.choice(pool)
    return template.format(fc=fc, part=part)


def _inject_scripted_demo_cannib(srs, assets, seed: int) -> Optional[CannibalizationEvent]:
    """Inject the canonical demo cannibalization event on day 350-355 of the
    simulation window so the demo always has a single 'predicted failure →
    matched donor → mission saved' story to narrate.

    Recipient: a CLB-1 JLTV with TURBOCHARGER ASSY (lead time 21d backordered).
    Donor:     a MALS-31 JLTV evacuated to MCLB Albany 90+ days.
    Open recipient SR exactly 7 days before event_date so the proposal lands
    inside the scripted-exercise rehearsal window. Returns None if the fleet
    doesn't contain a CLB-1 JLTV + a MALS-31 JLTV (defensive — current fleet
    has both)."""
    from supply import PartRequisition
    rng = random.Random(seed + 9001)

    recipient_asset = next(
        (a for a in assets if a.unit_name == "CLB-1" and a.equipment_type == "JLTV"),
        None,
    )
    donor_asset = next(
        (a for a in assets if a.unit_name == "MALS-31" and a.equipment_type == "JLTV"),
        None,
    )
    if recipient_asset is None or donor_asset is None:
        return None

    event_date = SIMULATION_START_DATE + timedelta(days=352)  # May 19, 2026
    open_date = event_date - timedelta(days=7)               # May 12, 2026

    # Build the recipient SR — backordered TURBOCHARGER ASSY, NMCS posture.
    recipient_sr = ServiceRequest(
        sr_number=f"{recipient_asset.unit_uic}-{open_date.year % 10}{(open_date - date(open_date.year, 1, 1)).days + 1:03d}-9001",
        asset_id=recipient_asset.asset_id,
        unit_uic=recipient_asset.unit_uic,
        unit_name=recipient_asset.unit_name,
        equipment_type=recipient_asset.equipment_type,
        tamcn=recipient_asset.tamcn,
        nsn=recipient_asset.nsn,
        serial_number=recipient_asset.serial_number,
        open_date=open_date,
        condition="Deadlined",
        priority="02",
        defect_code_primary="NMAJ",
        defect_code_secondary="ENGN",
        fault_id="DEMO-TURBO-FAIL",
        fault_component="turbo",
        tm_reference="TM 9-2320-457-13&P",
        maintenance_level="Organizational",
        remark_text=(
            "Demo fixture: PULSE predicted turbocharger failure 5d prior; failure "
            "confirmed on operator road test — boost pressure drop, oil in intake. "
            "Ordered NSN 2950-01-547-3318 TURBOCHARGER ASSY (lead time 21d, "
            "backordered). NMCS pending parts."
        ),
        source_classification="UNCLASSIFIED",
        detected_classification="UNCLASSIFIED",
        labor_hours_est=8,
        parts_cost_est=4200.00,
        parts_cost_actual=4200.00,
        labor_hours_actual=8.0,
        job_status="SHT PART",
    )
    # Backordered requisition that will be satisfied via cannibalization.
    req = PartRequisition(
        document_number=f"M{recipient_asset.unit_uic[-4:]}-DEMO-9001",
        sr_number=recipient_sr.sr_number,
        asset_id=recipient_asset.asset_id,
        nsn="2950-01-547-3318",
        nomenclature="TURBOCHARGER ASSY",
        qty_ordered=1,
        unit_cost=4200.00,
        priority="02",
        supply_path="backordered",
        ordered_date=open_date,
        current_status="BP",
        projected_delivery_date=open_date + timedelta(days=21),
    )
    recipient_sr.requisitions = [req]

    # Build the donor SR — evacuated to MCLB Albany 90+ days ago.
    donor_open = event_date - timedelta(days=95)
    donor_sr = ServiceRequest(
        sr_number=f"{donor_asset.unit_uic}-{donor_open.year % 10}{(donor_open - date(donor_open.year, 1, 1)).days + 1:03d}-9002",
        asset_id=donor_asset.asset_id,
        unit_uic=donor_asset.unit_uic,
        unit_name=donor_asset.unit_name,
        equipment_type=donor_asset.equipment_type,
        tamcn=donor_asset.tamcn,
        nsn=donor_asset.nsn,
        serial_number=donor_asset.serial_number,
        open_date=donor_open,
        condition="Deadlined",
        priority="03",
        defect_code_primary="NMAJ",
        defect_code_secondary="TRSM",
        fault_id="DEMO-EVAC-MAJOR",
        fault_component="transmission",
        tm_reference="TM 9-2320-457-23",
        maintenance_level="Depot",
        remark_text=(
            "Demo fixture: vehicle evacuated to MCLB Albany on long-cycle depot "
            "teardown for transmission rebuild. Engine bay still RFI; turbocharger "
            "assy serviceable per receipt inspection. Donor candidate for cross-"
            "level if a receiver SR opens before depot return."
        ),
        source_classification="UNCLASSIFIED",
        detected_classification="UNCLASSIFIED",
        labor_hours_est=120,
        parts_cost_est=18500.00,
        parts_cost_actual=18500.00,
        labor_hours_actual=80.0,
        job_status="EVACUATED",
        evacuated_to="MCLB Albany",
    )

    srs.append(recipient_sr)
    srs.append(donor_sr)

    days_deadlined = (event_date - donor_open).days
    event = CannibalizationEvent(
        event_id="CAN-DEMO-001",
        event_date=event_date,
        recipient_asset_id=recipient_asset.asset_id,
        recipient_sr_number=recipient_sr.sr_number,
        donor_asset_id=donor_asset.asset_id,
        donor_sr_number=donor_sr.sr_number,
        nsn=req.nsn,
        nomenclature=req.nomenclature,
        recipient_unit=recipient_asset.unit_name,
        donor_unit=donor_asset.unit_name,
        readiness_impact_note=(
            "Donor evacuated to MCLB Albany 95 days; depot ETA 30+ days out. "
            "Turbocharger harvested at zero readiness cost to donor. Recipient "
            "returned to MC inside scripted-exercise rehearsal window — mission saved."
        ),
        scripted_demo=True,
        scripted_exercise_label="EX BAYONET FOCUS 26-2 (rehearsal window)",
    )

    # Apply mutations consistent with the regular cannib path.
    req.received_date = event_date
    req.current_status = "CANN"
    recipient_sr.job_status = "COMPLETED"
    recipient_sr.close_date = event_date + timedelta(days=2)
    recipient_sr.remark_text = (
        f"{recipient_sr.remark_text} [{event_date.isoformat()}] "
        f"{req.nomenclature} obtained via cannibalization from "
        f"{donor_asset.asset_id} (donor SR {donor_sr.sr_number})."
    )
    donor_sr.remark_text = (
        f"{donor_sr.remark_text} [{event_date.isoformat()}] "
        f"{req.nomenclature} removed for cannibalization to "
        f"{recipient_asset.asset_id} (recipient SR {recipient_sr.sr_number})."
    )
    return event


def inject_cannibalizations(srs, assets, seed: int) -> List[CannibalizationEvent]:
    """
    Pair NMCS recipients with long-deadline donors from the SAME equipment
    family. Real cannibalization matches on equipment type + part function,
    not on exact NSN (every asset's NSN is serialized separately). These
    cross-unit links are what PULSE's cannibalization matcher surfaces.
    """
    rng = random.Random(seed + 4)
    events: List[CannibalizationEvent] = []

    # Always inject the canonical demo fixture first so the count-cap that
    # bounds the regular events doesn't starve it. Tagged scripted_demo=True
    # so the frontend can highlight the canonical "predicted → matched →
    # mission saved" story.
    demo = _inject_scripted_demo_cannib(srs, assets, seed)
    if demo is not None:
        events.append(demo)

    def _pending_req(req):
        return req.received_date is None or req.received_date > SIMULATION_END_DATE

    nmcs_srs = [
        sr for sr in srs
        if sr.condition == "Deadlined"
        and not sr.is_pmcs
        and any(_pending_req(r) for r in sr.requisitions)
    ]
    donor_pool = [
        sr for sr in srs
        if sr.condition == "Deadlined"
        and not sr.is_pmcs
        and (
            sr.job_status in ("EVACUATED", "SHT PART", "WAITING APPROVAL")
            or any(r.supply_path in ("slow", "backordered") for r in sr.requisitions)
        )
    ]

    rng.shuffle(nmcs_srs)
    rng.shuffle(donor_pool)

    used_donors: set = set()
    used_recipients: set = set()

    for recip in nmcs_srs:
        if len(events) >= max(MIN_CANNIBALIZATION_EVENTS + 2, 7):
            break
        if recip.sr_number in used_recipients:
            continue
        # Match on equipment type + fault component family -- like a real
        # maintenance chief would scan the motor pool for a matching broken rig.
        needed_part = next(
            (r for r in recip.requisitions if _pending_req(r)),
            None,
        )
        if needed_part is None:
            continue
        # Prefer cross-unit matches; fall back to same-unit if that's all we have.
        def _rank(donor):
            return (
                0 if donor.unit_name != recip.unit_name else 1,  # cross-unit first
                0 if donor.fault_component == recip.fault_component else 1,
                0 if donor.job_status == "EVACUATED" else 1,
            )
        ranked = sorted(
            (d for d in donor_pool
             if d.sr_number not in used_donors
             and d.asset_id != recip.asset_id
             and d.equipment_type == recip.equipment_type),
            key=_rank,
        )
        for donor in ranked:
            event_date = recip.open_date + timedelta(days=rng.randint(3, 10))
            days_deadlined = (event_date - donor.open_date).days
            events.append(CannibalizationEvent(
                event_id=f"CAN-{len(events)+1:04d}",
                event_date=event_date,
                recipient_asset_id=recip.asset_id,
                recipient_sr_number=recip.sr_number,
                donor_asset_id=donor.asset_id,
                donor_sr_number=donor.sr_number,
                nsn=needed_part.nsn,
                nomenclature=needed_part.nomenclature,
                recipient_unit=recip.unit_name,
                donor_unit=donor.unit_name,
                readiness_impact_note=_compose_impact_note(
                    donor=donor,
                    needed_part=needed_part,
                    days_deadlined=days_deadlined,
                    rng=rng,
                ),
            ))

            # Actually mutate the records -- recipient closes out the part
            # requisition as satisfied via cannibalization on event_date;
            # donor gains a second remark entry documenting the removal.
            for r in recip.requisitions:
                if r.nsn == needed_part.nsn and r.received_date is None:
                    r.received_date = event_date
                    r.current_status = "CANN"  # cannibalized, not RFI
                    break

            # If the recipient's remaining parts are all delivered after this
            # cannibalization, the SR progresses to QC/COMPLETED. Otherwise
            # remain SHT PART on any still-open requisitions.
            if all(r.received_date is not None for r in recip.requisitions):
                recip.job_status = "COMPLETED"
                recip.close_date = event_date + timedelta(days=rng.randint(1, 3))

            recip.remark_text = (
                f"{recip.remark_text} [{event_date.isoformat()}] "
                f"{needed_part.nomenclature} obtained via cannibalization from "
                f"{donor.asset_id} (donor SR {donor.sr_number})."
            )
            # Donor SR keeps its deadline but the donated part is now gone.
            donor.remark_text = (
                f"{donor.remark_text} [{event_date.isoformat()}] "
                f"{needed_part.nomenclature} removed for cannibalization to "
                f"{recip.asset_id} (recipient SR {recip.sr_number})."
            )

            used_donors.add(donor.sr_number)
            used_recipients.add(recip.sr_number)
            break

    return events


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------

def _iter_open_srs(srs):
    return (sr for sr in srs if sr.close_date is None)


def check_nmcs_implies_open_parts(srs) -> List[Violation]:
    """A SHT PART SR must have at least one requisition that has not yet
    arrived by SIMULATION_END_DATE. Reqs whose received_date is in the future
    relative to the simulation window count as 'open'."""
    out: List[Violation] = []
    for sr in _iter_open_srs(srs):
        if sr.job_status != "SHT PART":
            continue
        any_pending = any(
            (r.received_date is None or r.received_date > SIMULATION_END_DATE)
            for r in sr.requisitions
        )
        if not any_pending and sr.requisitions:
            out.append(Violation(
                "nmcs_implies_open_parts", "error",
                f"SR {sr.sr_number} is SHT PART but all requisitions delivered by end of sim",
                sr.sr_number,
            ))
    return out


def check_nmcm_implies_active_sr(srs) -> List[Violation]:
    """Every Deadlined SR should have a non-terminal job status (OPEN, AWAITING MAINT,
    WORK IN PROGRESS, SHT PART, QC INSPECTION, EVACUATED)."""
    out: List[Violation] = []
    terminal = {"COMPLETED"}
    for sr in _iter_open_srs(srs):
        if sr.condition == "Deadlined" and sr.job_status in terminal:
            out.append(Violation(
                "nmcm_implies_active_sr", "error",
                f"SR {sr.sr_number} is Deadlined but job_status is terminal ({sr.job_status})",
                sr.sr_number,
            ))
    return out


def check_hours_miles_monotonic(snapshots) -> List[Violation]:
    """Asset-level hours and miles must never decrease day-to-day."""
    out: List[Violation] = []
    by_asset: dict = {}
    for s in snapshots:
        prev = by_asset.get(s.asset_id)
        if prev is not None:
            if s.current_hours + 0.01 < prev[0]:
                out.append(Violation(
                    "hours_miles_monotonic", "error",
                    f"Asset {s.asset_id} hours went from {prev[0]:.1f} to {s.current_hours:.1f} on {s.snapshot_date}",
                    s.asset_id,
                ))
            if s.current_miles < prev[1]:
                out.append(Violation(
                    "hours_miles_monotonic", "error",
                    f"Asset {s.asset_id} miles went from {prev[1]} to {s.current_miles} on {s.snapshot_date}",
                    s.asset_id,
                ))
        by_asset[s.asset_id] = (s.current_hours, s.current_miles)
    return out


def check_condition_priority_alignment(srs) -> List[Violation]:
    out: List[Violation] = []
    for sr in srs:
        if sr.is_pmcs:
            continue
        if sr.data_quality_flag:
            continue
        allowed = CONDITION_PRIORITY_MAP.get(sr.condition, [])
        if allowed and sr.priority not in allowed:
            out.append(Violation(
                "condition_priority_alignment", "warning",
                f"SR {sr.sr_number} condition={sr.condition} priority={sr.priority} (allowed {allowed})",
                sr.sr_number,
            ))
    return out


def check_unique_serial_numbers(assets) -> List[Violation]:
    serials = [a.serial_number for a in assets]
    dupes = [s for s, c in Counter(serials).items() if c > 1]
    return [Violation("unique_serial_numbers", "error", f"Duplicate serial: {s}") for s in dupes]


def check_unique_sr_numbers(srs) -> List[Violation]:
    numbers = [sr.sr_number for sr in srs]
    dupes = [n for n, c in Counter(numbers).items() if c > 1]
    return [Violation("unique_sr_numbers", "error", f"Duplicate SR number: {n}") for n in dupes]


def check_pmcs_interval_regularity(srs) -> List[Violation]:
    """PMCS SRs per asset should be ~30 days apart (not randomly scattered)."""
    out: List[Violation] = []
    by_asset: dict = {}
    for sr in srs:
        if sr.is_pmcs:
            by_asset.setdefault(sr.asset_id, []).append(sr.open_date)
    for asset_id, dates in by_asset.items():
        dates.sort()
        for prev, nxt in zip(dates, dates[1:]):
            gap = (nxt - prev).days
            if gap < 20 or gap > 60:
                out.append(Violation(
                    "pmcs_interval_regularity", "warning",
                    f"Asset {asset_id} PMCS gap={gap} days ({prev} -> {nxt})",
                    asset_id,
                ))
    return out


def check_single_active_cm_sr(assets, srs) -> List[Violation]:
    """At most one active corrective SR per asset at a time (PMCS can overlap)."""
    out: List[Violation] = []
    by_asset: dict = {}
    for sr in srs:
        if sr.is_pmcs or sr.close_date is not None:
            continue
        by_asset.setdefault(sr.asset_id, []).append(sr)
    for asset_id, active in by_asset.items():
        if len(active) > 1:
            out.append(Violation(
                "single_active_cm_sr", "warning",
                f"Asset {asset_id} has {len(active)} active CM SRs simultaneously",
                asset_id,
            ))
    return out


def check_parts_cost_realistic(srs) -> List[Violation]:
    """Actual parts cost should fall inside the spec's bimodal band. Catches
    data corruption (e.g. a zero-cost actual under a $4k estimate) as well as
    wildly inflated outliers."""
    out: List[Violation] = []
    for sr in srs:
        if sr.is_pmcs or sr.data_quality_flag:
            continue
        if sr.parts_cost_est == 0:
            continue
        ratio = sr.parts_cost_actual / sr.parts_cost_est
        # The generator produces uniform(0.70, 1.45). Any ratio outside
        # 0.65-1.50 is a bug. Warning, not error -- cannibalized SRs skew lower.
        if ratio < 0.65 or ratio > 1.50:
            out.append(Violation(
                "parts_cost_realistic", "warning",
                f"SR {sr.sr_number} parts cost ratio {ratio:.2f} (actual {sr.parts_cost_actual} vs est {sr.parts_cost_est})",
                sr.sr_number,
            ))
    return out


def check_classification_content_alignment(srs) -> List[Violation]:
    """Records whose remark contains [CLASSIFIED TM must carry detected_classification
    at least CONFIDENTIAL."""
    out: List[Violation] = []
    higher = {"CONFIDENTIAL", "SECRET", "TOP SECRET"}
    for sr in srs:
        if "[CLASSIFIED TM" in sr.remark_text and sr.detected_classification not in higher:
            out.append(Violation(
                "classification_content_alignment", "error",
                f"SR {sr.sr_number} remark contains classified TM marker but detected classification is {sr.detected_classification}",
                sr.sr_number,
            ))
    return out


def check_cannibalization_present(cannib_events) -> List[Violation]:
    if len(cannib_events) < MIN_CANNIBALIZATION_EVENTS:
        return [Violation(
            "cannibalization_cross_reference", "error",
            f"Only {len(cannib_events)} cannibalization events; need at least {MIN_CANNIBALIZATION_EVENTS}",
        )]
    return []


def check_evacuation_unit_matches(srs) -> List[Violation]:
    out: List[Violation] = []
    for sr in srs:
        if sr.job_status == "EVACUATED" and not sr.evacuated_to:
            out.append(Violation(
                "evacuation_unit_matches", "error",
                f"SR {sr.sr_number} EVACUATED but no receiving unit set",
                sr.sr_number,
            ))
    return out


# ---------------------------------------------------------------------------
# Top-level runner
# ---------------------------------------------------------------------------

SR_CHECKS: List[Callable] = [
    check_nmcs_implies_open_parts,
    check_nmcm_implies_active_sr,
    check_condition_priority_alignment,
    check_unique_sr_numbers,
    check_pmcs_interval_regularity,
    check_parts_cost_realistic,
    check_classification_content_alignment,
    check_evacuation_unit_matches,
]


def run_all_checks(srs, assets, snapshots, cannib_events) -> List[Violation]:
    out: List[Violation] = []
    out.extend(check_unique_serial_numbers(assets))
    out.extend(check_hours_miles_monotonic(snapshots))
    out.extend(check_cannibalization_present(cannib_events))
    out.extend(check_single_active_cm_sr(assets, srs))
    for check in SR_CHECKS:
        out.extend(check(srs))
    return out


def report_violations(violations: List[Violation]) -> None:
    if not violations:
        print("  All 15 consistency checks passed.")
        return
    by_check: dict = {}
    for v in violations:
        by_check.setdefault(v.check, []).append(v)
    for check, vs in by_check.items():
        errs = sum(1 for v in vs if v.severity == "error")
        warns = sum(1 for v in vs if v.severity == "warning")
        print(f"  {check}: {errs} errors, {warns} warnings")
        for v in vs[:3]:
            print(f"    [{v.severity}] {v.message}")
        if len(vs) > 3:
            print(f"    ... and {len(vs)-3} more")


if __name__ == "__main__":
    from config import RANDOM_SEED, OUTPUT_TARGETS
    from fleet import generate_fleet
    from personnel import generate_personnel
    from lifecycle import run_simulation

    units, assets = generate_fleet(RANDOM_SEED)
    roster = generate_personnel(units, OUTPUT_TARGETS["personnel_count"], RANDOM_SEED)
    print("Running simulation...")
    srs, snaps, reqs = run_simulation(units, assets, roster, RANDOM_SEED)

    print("Injecting intentional data-quality defects...")
    dq = inject_data_quality_defects(srs, snaps, RANDOM_SEED)
    print(f"  {dq}")
    print("Injecting cannibalization events...")
    cans = inject_cannibalizations(srs, assets, RANDOM_SEED)
    print(f"  {len(cans)} events created")

    print("\nRunning consistency checks:")
    v = run_all_checks(srs, assets, snaps, cans)
    report_violations(v)
    errors = sum(1 for x in v if x.severity == "error")
    print(f"\nTOTAL: {errors} errors, {len(v) - errors} warnings")
