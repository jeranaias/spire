"""
Supply-chain simulator -- generates parts requisitions tied to each Service
Request and walks them through a realistic status progression. The resulting
records feed both the MPR export (supply status columns) and BASTION's "parts
on order" hero metric.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import List, Optional

from config import BACKORDER_RATE, SUPPLY_PATHS, SUPPLY_STATUS_CODES
from dic import sample_supply_tags


@dataclass
class PartRequisition:
    document_number: str
    sr_number: str
    asset_id: str
    nsn: str
    nomenclature: str
    qty_ordered: int
    unit_cost: float
    priority: str
    uoi: str = "EA"
    supply_path: str = "medium"
    # status timeline
    status_history: list = field(default_factory=list)  # list of (status_code, date)
    current_status: str = "BA"
    ordered_date: Optional[date] = None
    # Set when the D6 milestone actually advances under advance_requisition,
    # NOT at creation. Stays None until the part is physically received.
    received_date: Optional[date] = None
    # The projected delivery date derived from the supply path -- always
    # known at creation, used by PULSE for "expected arrival" displays.
    projected_delivery_date: Optional[date] = None
    estimated_ship_date: Optional[date] = None
    # GCSS-MC supply schema tagging (WP-4 / WP-5):
    # - item_type: "I" (inventory) or "SECREP" (secondary reparable).
    # - dic: Document Identifier Code (A0A / A01 / A2A / A21).
    # - service_activity: "Issue from Inventory" / "SECREP Exchange" / etc.
    # - doc_status: "Complete" / "Cancelled" (due-in row close-out state).
    item_type: str = "I"
    dic: str = "A0A"
    service_activity: str = "Issue from Inventory"
    doc_status: str = "Complete"

    @property
    def total_cost(self) -> float:
        return round(self.unit_cost * self.qty_ordered, 2)

    @property
    def is_received(self) -> bool:
        return self.received_date is not None


def _julian(d: date) -> str:
    """Julian day-of-year as 4 digits: YDDD (year last digit + day-of-year)."""
    yday = (d - date(d.year, 1, 1)).days + 1
    return f"{d.year % 10}{yday:03d}"


_SEQ_COUNTERS: dict = {}


def _next_sequence(unit_aac: str) -> int:
    """Maintain per-unit requisition sequence numbers for realistic doc nums."""
    _SEQ_COUNTERS[unit_aac] = _SEQ_COUNTERS.get(unit_aac, 0) + 1
    return _SEQ_COUNTERS[unit_aac]


def _path_for_part(part_cost: float, rng: random.Random) -> str:
    """Choose a supply path based on cost + randomness. A small fraction of
    orders backorder regardless of cost (supply chain is inherently noisy)."""
    if rng.random() < BACKORDER_RATE:
        return "backordered"
    if part_cost < 500:
        return "fast"
    if part_cost < 5000:
        return "medium"
    return "slow"


def _priority_for_condition(condition: str) -> str:
    """Return a GCSS-MC priority string ("06 B-Urgent") matching the SR
    condition. Mirrors lifecycle.py so a requisition's priority lines up
    with its parent SR's priority band."""
    return {
        "Deadlined": "02 A-Critical",
        "Degraded":  "05 B-Urgent",
        "Minor":     "13 C-Routine",
        "Supply":    "13 C-Routine",
        "Service":   "13 C-Routine",
    }.get(condition, "13 C-Routine")


def create_requisitions_for_sr(
    sr_number: str,
    asset,
    fault_event,
    sr_date: date,
    rng: random.Random,
) -> List[PartRequisition]:
    """Build the full requisition list for a Service Request."""
    requisitions: List[PartRequisition] = []
    priority = _priority_for_condition(fault_event.condition_impact)

    for part in fault_event.parts_needed:
        path = _path_for_part(part["cost"], rng)
        doc_num = f"{asset.unit_uic}-{_julian(sr_date)}-{_next_sequence(asset.unit_uic):04d}"

        # WP-4 / WP-5: stamp GCSS-MC supply schema tags (item_type, dic,
        # service_activity, doc_status) consistently per requisition. The
        # tag draws are correlated (SECREP -> A2A/A21, etc.) so the synth
        # supply traffic mirrors the real-export distribution.
        tags = sample_supply_tags(rng, part_cost=part["cost"], supply_path=path)
        req = PartRequisition(
            document_number=doc_num,
            sr_number=sr_number,
            asset_id=asset.asset_id,
            nsn=part["nsn"],
            nomenclature=part["nomenclature"],
            qty_ordered=part["qty"],
            unit_cost=part["cost"],
            priority=priority,
            supply_path=path,
            ordered_date=sr_date,
            item_type=tags["item_type"],
            dic=tags["dic"],
            service_activity=tags["service_activity"],
            doc_status=tags["doc_status"],
        )

        # Compute the planned status timeline with gamma-distributed per-step
        # jitter so a cohort of same-path orders doesn't arrive on identical
        # calendar days. The mean stays at the spec's integer value; variance
        # comes from multiplicative noise.
        jittered_offsets = _jitter_path_offsets(SUPPLY_PATHS[path], rng)
        for (code, _base_offset), offset in zip(SUPPLY_PATHS[path], jittered_offsets):
            req.status_history.append((code, sr_date + timedelta(days=offset)))

        # Projected delivery is the planned D6 step (always known at creation);
        # received_date stays None until advance_requisition confirms delivery.
        for code, step_date in req.status_history:
            if code == "D6":
                req.projected_delivery_date = step_date
            if code == "AE":
                req.estimated_ship_date = step_date

        requisitions.append(req)

    return requisitions


def _jitter_path_offsets(path_steps: list, rng: random.Random) -> list:
    """
    Gamma-like per-step noise: each planned step gets multiplied by a random
    factor with mean 1.0. The returned offsets are monotonic -- a step never
    lands before the previous one. This replaces the old integer determinism
    where every 'fast' path hit D6 on exactly day 6.
    """
    out = []
    prev = -1
    for _code, base_offset in path_steps:
        if base_offset == 0:
            offset = 0
        else:
            # Lognormal-ish noise via uniform on log scale, clamped reasonable.
            factor = rng.uniform(0.75, 1.30) if base_offset <= 10 else rng.uniform(0.85, 1.25)
            offset = max(prev + 1, int(round(base_offset * factor)))
        out.append(offset)
        prev = offset
    return out


def advance_requisition(req: PartRequisition, today: date) -> bool:
    """Update the current_status to reflect the most recent past milestone.
    Sets received_date on the calendar day the D6 milestone first lands.
    Returns True if the status changed this call."""
    new_status = req.current_status
    for code, step_date in req.status_history:
        if step_date <= today:
            new_status = code
    changed = new_status != req.current_status
    req.current_status = new_status
    if new_status == "D6" and req.received_date is None:
        # Find the actual D6 date from history so ordering is deterministic.
        for code, step_date in req.status_history:
            if code == "D6":
                req.received_date = step_date
                break
    return changed


def describe(req: PartRequisition) -> str:
    return (
        f"{req.document_number} {req.nsn} x{req.qty_ordered} "
        f"path={req.supply_path} status={req.current_status} "
        f"(received={req.received_date})"
    )


def reset_sequence_counters() -> None:
    _SEQ_COUNTERS.clear()


if __name__ == "__main__":
    import datetime as dt
    from config import RANDOM_SEED
    from fleet import generate_fleet
    from faults import check_for_fault

    rng = random.Random(RANDOM_SEED)
    units, assets = generate_fleet(RANDOM_SEED)
    sample = 0
    for a in assets[:150]:
        a.current_miles = 20000
        a.miles_today = 80
        a.hours_today = 6
        a.days_since_last_maintenance = 120
        fe = check_for_fault(a, dt.date(2025, 7, 4), rng)
        if not fe:
            continue
        reqs = create_requisitions_for_sr("SR-TEST-0001", a, fe, dt.date(2025, 7, 4), rng)
        for r in reqs:
            advance_requisition(r, dt.date(2025, 8, 15))
            print(f"  [{a.equipment_type}] {describe(r)}")
        sample += 1
        if sample >= 3:
            break
