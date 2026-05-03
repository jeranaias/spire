"""SPIRE Internal Data Model (IDM) — canonical entities.

Adapter outputs land here. View consumers read from here. The IDM is
the contract that lets us swap GCSS-MC's ECP for any other "asset
roster" source without touching PULSE.

Design rules:
- One canonical shape per entity. Adapters CONFORM to it; they don't
  invent shape.
- Required vs optional is explicit. `Optional[...]` means "the IDM
  tolerates this missing"; everything else is required at apply time.
- Behavioral state (current_hours, current_status, etc.) lives on
  the entity but is populated by separate adapters (utilization
  extracts) — the contract just declares the field.
- Provenance is NOT stored on the entity itself; it lives in a
  parallel `provenance` table keyed by (entity, id, field). This
  keeps the entity schema lean for the hot read path.

Today the IDM mirrors the existing dataset.fleet / dataset.lifecycle
shapes so the migration path from bespoke adapters is one-for-one.
Future work: factor the dataset module's dataclasses to import from
here, eliminating the schema duplication.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import List, Optional


@dataclass
class Unit:
    """USMC unit (UIC + name + parent)."""

    uic: str
    name: str
    parent: str = ""
    branch: str = "USMC"
    location: str = ""
    deployment_status: str = "garrison"


@dataclass
class Asset:
    """One piece of equipment with a permanent identity.

    Roster fields land from GCSS-MC ECP. Behavioral fields
    (current_*) land from utilization extracts. Behavioral defaults
    are zero/empty so a fresh roster ingest doesn't crash the
    simulator.
    """

    asset_id: str
    tamcn: str
    nsn: str
    serial_number: str
    nomenclature: str
    unit_uic: str
    unit_name: str = ""
    equipment_type: str = ""
    model: str = ""
    fsc: str = ""
    location: str = ""
    optempo: str = "medium"
    deployment_status: str = "garrison"
    fielding_date: Optional[date] = None
    classification_risk: str = "LOW"
    # ECP roster fields
    allowance_qty: int = 0
    on_hand_qty: int = 0
    last_inventory_date: Optional[date] = None
    # Behavioral state (utilization)
    current_hours: float = 0.0
    current_miles: int = 0
    current_status: str = "MC"  # MC | PMC | NMCM | NMCS
    # RD6c — flagged when canonical-asset is absent from the most
    # recent roster file; operator confirms / removes / defers.
    needs_verification: bool = False


@dataclass
class ServiceRequest:
    """One SR record from GCSS-MC."""

    sr_number: str
    asset_id: str
    unit_uic: str
    open_date: date
    service_request_type: str = "Maintenance - CM"
    defect_code_primary: str = ""
    defect_code_secondary: str = ""
    problem_summary: str = ""
    priority: str = "02"
    job_status: str = "OPEN"
    deadlined_date: Optional[date] = None
    job_status_date: Optional[date] = None
    echelon_of_maint: str = "Organizational"
    echelon_numeric: int = 1
    source_classification: str = "UNCLASSIFIED"
    detected_classification: str = "UNCLASSIFIED"


@dataclass
class Personnel:
    """One service member assigned to a unit."""

    edipi: str
    last_name: str
    first_name: str = ""
    rank: str = ""
    billet: str = ""
    unit_uic: str = ""
    branch: str = "USMC"
    clearance: str = "CUI"
    role: str = ""


@dataclass
class Requisition:
    """One open or closed parts requisition tied to an SR."""

    req_id: str
    sr_number: str
    nsn: str
    qty: int = 1
    status: str = "OPEN"
    rdd: Optional[date] = None  # Required Delivery Date
    fund_line: str = ""
    cost_line: str = ""
    last_updated: Optional[date] = None


@dataclass
class TMR:
    """Transportation Movement Request (TPS-D / TC-AIMS-II)."""

    tmr_id: str
    origin_uic: str
    destination_uic: str
    movement_class: str = ""
    pickup_date: Optional[date] = None
    delivery_date: Optional[date] = None
    status: str = "DRAFT"
    payload_summary: str = ""


@dataclass
class IncidentEvent:
    """A discrete event from PACS, SCADA, METOC, or threat sensors."""

    event_id: str
    source: str  # PACS | SCADA | METOC | THERMALHAWK | etc.
    event_type: str
    occurred_at: str  # ISO 8601 timestamp
    severity: str = "INFO"  # CRITICAL | HIGH | MODERATE | LOW | INFO
    location: str = ""
    payload: dict = field(default_factory=dict)


@dataclass
class CRating:
    """Unit C-rating + MET score from DRRS-MC.

    C-rating: C1 (full mission-capable) → C5 (not capable). MET is a
    per-mission-essential-task score 0–100.
    """

    unit_uic: str
    as_of_date: date
    c_rating: str  # "C1" | "C2" | "C3" | "C4" | "C5"
    met_scores: dict = field(default_factory=dict)  # task → score
    operator_assessment: str = ""


@dataclass
class MaintRecord:
    """Aviation maintenance event from ADAMS / OOMA / TAMS."""

    record_id: str
    asset_id: str
    discrepancy: str
    corrective_action: str = ""
    discovered_date: Optional[date] = None
    closed_date: Optional[date] = None
    flight_hours_at_event: float = 0.0
    inspector_edipi: str = ""
