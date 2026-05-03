"""Canonical-entity registry + source-of-truth precedence rules.

When two adapters propose conflicting values for the same canonical
field, the registry decides who wins. The losing value is preserved
in the provenance log so the operator can review.
"""
from __future__ import annotations

from typing import Dict, List, Type

from .schema import (
    Asset,
    CRating,
    IncidentEvent,
    MaintRecord,
    Personnel,
    Requisition,
    ServiceRequest,
    TMR,
    Unit,
)


# Map canonical-entity name → dataclass type. Adapter specs declare
# `target_entity="Asset"`; the pipeline looks the type up here.
IDM_ENTITIES: Dict[str, Type] = {
    "Unit": Unit,
    "Asset": Asset,
    "ServiceRequest": ServiceRequest,
    "Personnel": Personnel,
    "Requisition": Requisition,
    "TMR": TMR,
    "IncidentEvent": IncidentEvent,
    "CRating": CRating,
    "MaintRecord": MaintRecord,
}


# Source-of-truth precedence per (entity, field). Adapters identify
# themselves by their `id` (e.g. "gcss-mc/ecp"). Highest-priority
# adapter for that field wins on conflict.
#
# Rule of thumb: the system that *originates* the field wins. UTIL
# wins for current_hours/miles because that's what UTIL is for. ECP
# wins for allowance_qty because that's the roster's job. Manual
# entry never wins automatically — the operator confirms via the
# stale-resolution flow.
PRECEDENCE: Dict[str, Dict[str, List[str]]] = {
    "Asset": {
        "asset_id":           ["gcss-mc/ecp"],
        "tamcn":              ["gcss-mc/ecp", "miles"],
        "nsn":                ["gcss-mc/ecp"],
        "serial_number":      ["gcss-mc/ecp"],
        "nomenclature":       ["gcss-mc/ecp"],
        "unit_uic":           ["gcss-mc/ecp", "miles"],
        "unit_name":          ["miles", "gcss-mc/ecp"],
        "allowance_qty":      ["gcss-mc/ecp"],
        "on_hand_qty":        ["gcss-mc/ecp"],
        "last_inventory_date": ["gcss-mc/ecp"],
        "current_hours":      ["gcss-mc/util"],
        "current_miles":      ["gcss-mc/util"],
        "current_status":     ["gcss-mc/util", "drrs-mc"],
        "fielding_date":      ["gcss-mc/ecp", "miles"],
    },
    "ServiceRequest": {
        "sr_number":               ["gcss-mc/sr-header"],
        "asset_id":                ["gcss-mc/sr-header"],
        "unit_uic":                ["gcss-mc/sr-header"],
        "open_date":               ["gcss-mc/sr-header"],
        "service_request_type":    ["gcss-mc/sr-header"],
        "defect_code_primary":     ["gcss-mc/sr-header"],
        "defect_code_secondary":   ["gcss-mc/sr-header"],
        "problem_summary":         ["gcss-mc/sr-header"],
        "priority":                ["gcss-mc/sr-header"],
        "deadlined_date":          ["gcss-mc/sr-header"],
        "job_status_date":         ["gcss-mc/sr-header"],
        "echelon_of_maint":        ["gcss-mc/sr-header"],
        "source_classification":   ["gcss-mc/sr-header"],
        "detected_classification": ["sentry/classifier"],
    },
    "Personnel": {
        "edipi":      ["deers", "miles"],
        "last_name":  ["deers", "miles"],
        "first_name": ["deers", "miles"],
        "rank":       ["deers", "miles"],
        "billet":     ["miles", "deers"],
        "unit_uic":   ["miles", "deers"],
        "clearance":  ["deers"],
        "role":       ["miles", "manual"],
    },
    "CRating": {
        "c_rating":             ["drrs-mc"],
        "met_scores":           ["drrs-mc"],
        "operator_assessment":  ["drrs-mc"],
    },
    "TMR": {
        "tmr_id":          ["tps-d"],
        "origin_uic":      ["tps-d"],
        "destination_uic": ["tps-d"],
        "pickup_date":     ["tps-d"],
        "delivery_date":   ["tps-d"],
        "status":          ["tps-d"],
    },
    "IncidentEvent": {
        # IncidentEvents are partitioned by source — no real
        # conflict between PACS/SCADA/METOC since they each emit
        # disjoint event types. The `source` field on the entity is
        # itself the precedence key.
    },
    "MaintRecord": {
        "record_id":               ["adams", "ooma", "tams"],
        "asset_id":                ["adams", "ooma", "tams"],
        "discrepancy":             ["adams", "ooma", "tams"],
        "corrective_action":       ["adams", "ooma", "tams"],
        "flight_hours_at_event":   ["adams", "ooma", "tams"],
    },
    "Requisition": {
        "req_id":     ["gcss-mc/sr-parts"],
        "sr_number":  ["gcss-mc/sr-parts"],
        "nsn":        ["gcss-mc/sr-parts"],
        "qty":        ["gcss-mc/sr-parts"],
        "status":     ["gcss-mc/sr-parts"],
        "rdd":        ["gcss-mc/sr-parts"],
        "fund_line":  ["gcss-mc/sr-parts", "mipr"],
        "cost_line":  ["gcss-mc/sr-parts", "mipr"],
    },
    "Unit": {
        "uic":               ["deers", "gcss-mc/ecp"],
        "name":              ["deers", "miles"],
        "parent":            ["deers", "miles"],
        "deployment_status": ["miles", "manual"],
    },
}


def get_entity(name: str):
    """Return the dataclass type for a canonical entity name."""
    if name not in IDM_ENTITIES:
        raise KeyError(
            f"Unknown canonical entity: {name!r}. "
            f"Known: {sorted(IDM_ENTITIES.keys())}"
        )
    return IDM_ENTITIES[name]


def precedence_for(entity: str, fieldname: str) -> List[str]:
    """Return the ordered list of source-ids that win on this field.

    Empty list means no precedence rule is set yet — the pipeline
    falls back to last-write-wins and surfaces the conflict in the
    diff so the operator can pick.
    """
    return PRECEDENCE.get(entity, {}).get(fieldname, [])


def adapter_wins(entity: str, fieldname: str, source_a: str, source_b: str) -> str:
    """Given two source ids, return whichever wins per the precedence
    table. Falls back to source_a (last-write-wins) when neither
    source is in the table for this field."""
    rank = precedence_for(entity, fieldname)
    if not rank:
        return source_a
    a_rank = rank.index(source_a) if source_a in rank else len(rank)
    b_rank = rank.index(source_b) if source_b in rank else len(rank)
    return source_a if a_rank <= b_rank else source_b
