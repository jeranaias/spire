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
    received_date: Optional[date] = None
    estimated_ship_date: Optional[date] = None

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
    return {
        "Deadlined": "02",
        "Degraded": "05",
        "Minor": "10",
        "Supply": "10",
        "Service": "13",
    }.get(condition, "10")


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
        )

        # Pre-compute the full status timeline (deterministic per path).
        for code, offset in SUPPLY_PATHS[path]:
            req.status_history.append((code, sr_date + timedelta(days=offset)))

        # Last D6 step is the received date.
        if req.status_history and req.status_history[-1][0] == "D6":
            req.received_date = req.status_history[-1][1]
        # Estimated ship date = AE step if present.
        for code, step_date in req.status_history:
            if code == "AE":
                req.estimated_ship_date = step_date
                break

        requisitions.append(req)

    return requisitions


def advance_requisition(req: PartRequisition, today: date) -> bool:
    """Update the current_status to reflect the most recent past milestone.
    Returns True if the status changed this call."""
    new_status = req.current_status
    for code, step_date in req.status_history:
        if step_date <= today:
            new_status = code
    changed = new_status != req.current_status
    req.current_status = new_status
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
