"""
Integrations — adapter-contract surfaces for systems-of-record.

Wave 1 / Task #27 — GCSS-MC reference implementation.

J1 IRONSIDE asked: "Where does this live? GCSS-MC, Palantir, or an Excel
sheet on a corporal's laptop?" This route answers the question for SPIRE's
canonical system of record (Global Combat Support System — Marine Corps)
without pretending the connection is real. Every payload labels itself
REFERENCE IMPLEMENTATION; no live GCSS-MC instance is contacted.

The sample payload is shaped to match the GCSS-MC tables/fields documented
in publicly-available USMC TM/TR materials (see the field-mapping page on
the frontend for the exact source citations). The data is sourced from
the canonical synthetic dataset so the contract roundtrip is provable in
the demo.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Query

from ..state import get_dataset, last_day_snapshots


router = APIRouter()


# ---------------------------------------------------------------------------
# Shape mappers — SPIRE entity → GCSS-MC table row
# ---------------------------------------------------------------------------

def _gcss_readiness_code(spire_code: str) -> str:
    """SPIRE uses MC/PMC/NMCM/NMCS; GCSS-MC's MIMMS readiness column uses
    the same four codes (one of the few one-to-one mappings). Returned
    verbatim for clarity in the example records."""
    return spire_code or "MC"


def _gcss_priority_designator(spire_priority: str) -> str:
    """SPIRE SR priority is "01"/"02"/"03"/"05" (UND); GCSS-MC PD column
    is the same 2-char Force Activity Designator-derived code."""
    return spire_priority or "03"


def _gcss_doc_status(req) -> str:
    """Map the SPIRE PartRequisition.current_status (DLA milestone code:
    BA/BB/BD/BF/D6 etc.) onto the GCSS-MC SUPPLY_STATUS column. They are
    the same DLA standard codes — passed through unchanged."""
    return req.current_status or "BA"


def _asset_master_row(a) -> dict:
    """SPIRE Asset → GCSS-MC EQUIPMENT_MASTER row (TAMCN-keyed)."""
    return {
        # GCSS-MC field names (left) ← SPIRE field names (right)
        "UIC": a.unit_uic,
        "UNIT_NAME": a.unit_name,
        "TAMCN": a.tamcn,
        "NSN": a.nsn,
        "SERIAL_NO": a.serial_number,
        "NOMENCLATURE": a.nomenclature,
        "MODEL": a.model,
        "FSC": a.fsc,
        "EOH_LOC": a.location,
        "FIELD_DATE": a.fielding_date.isoformat() if hasattr(a.fielding_date, "isoformat") else str(a.fielding_date),
        "DEPLOY_STATUS": a.current_deployment_status or a.deployment_status,
    }


def _readiness_status_row(s) -> dict:
    """SPIRE DailySnapshot → GCSS-MC MIMMS_DAILY_READINESS row.

    MIMMS = Marine Corps Integrated Maintenance Management System (the
    readiness sub-component of GCSS-MC)."""
    return {
        "REPORT_DATE": s.snapshot_date.isoformat() if hasattr(s.snapshot_date, "isoformat") else str(s.snapshot_date),
        "UIC": s.unit_uic,
        "SERIAL_NO": s.serial_number,
        "TAMCN": s.tamcn,
        "EOH_STAT": _gcss_readiness_code(s.readiness_code),
        "DEADLINE_DAYS": s.days_deadlined,
        "EOH_HOURS": float(s.current_hours),
        "EOH_MILES": int(s.current_miles),
        "OPEN_DR_COUNT": s.open_sr_count,
        "PARTS_ON_ORDER": s.parts_on_order,
        "EOH_LOC": s.location,
    }


def _service_request_row(sr) -> dict:
    """SPIRE ServiceRequest → GCSS-MC ER (Equipment Repair Order)."""
    return {
        "ERO_NO": sr.sr_number,
        "UIC": sr.unit_uic,
        "SERIAL_NO": sr.serial_number,
        "TAMCN": sr.tamcn,
        "NSN": sr.nsn,
        "PD": _gcss_priority_designator(sr.priority),
        "JOB_STATUS": sr.job_status,
        "DEFECT_CODE": sr.defect_code_primary,
        "TM_REF": sr.tm_reference,
        "MAINT_LEVEL": sr.maintenance_level,
        "OPEN_DATE": sr.open_date.isoformat() if hasattr(sr.open_date, "isoformat") else str(sr.open_date),
        "CLOSE_DATE": (
            sr.close_date.isoformat()
            if sr.close_date and hasattr(sr.close_date, "isoformat")
            else None
        ),
        "DEADLINED": sr.condition == "Deadlined",
    }


def _requisition_row(req) -> dict:
    """SPIRE PartRequisition → GCSS-MC SUPPLY_DOC row."""
    return {
        "DOC_NO": req.document_number,
        "ERO_NO": req.sr_number,
        "NSN": req.nsn,
        "NOMENCLATURE": req.nomenclature,
        "QTY": req.qty_ordered,
        "UOI": req.uoi,
        "PD": _gcss_priority_designator(req.priority),
        "STATUS_CODE": _gcss_doc_status(req),
        "DOC_DATE": (
            req.ordered_date.isoformat()
            if req.ordered_date and hasattr(req.ordered_date, "isoformat")
            else None
        ),
        "RDD": (
            req.received_date.isoformat()
            if req.received_date and hasattr(req.received_date, "isoformat")
            else None
        ),
    }


# ---------------------------------------------------------------------------
# Last-sync ticker — the topbar pill consults this every few seconds.
#
# The connection is intentionally fake. We mint a deterministic recent
# timestamp so the pill reads as "synced 14s ago, 19s ago, ..." across
# polls and never drifts into the future. The endpoint is the single
# source of truth so the integration page and topbar agree.
# ---------------------------------------------------------------------------

def _mock_last_sync(now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    # Deterministic age between 5s and 90s — looks like a polling adapter
    # that runs at a 30s nominal cadence with the usual jitter.
    bucket = (int(now.timestamp()) // 7) % 86  # 0..85
    age_seconds = 5 + bucket
    last_sync_at = now - timedelta(seconds=age_seconds)
    # Stable run-id so a "where did this batch come from" question has an
    # answer in the demo. Hashes the local-day so it rotates daily.
    day_key = now.strftime("%Y-%m-%d")
    run_id = "GCSSMC-" + hashlib.sha256(day_key.encode()).hexdigest()[:10].upper()
    ds = get_dataset()
    return {
        "system": "GCSS-MC",
        "system_long_name": "Global Combat Support System — Marine Corps",
        "environment": "REFERENCE_IMPLEMENTATION",
        # Honest state name — there is no live GCSS-MC link. Anything reading
        # this JSON must not be able to mistake it for a healthy connection.
        # Renamed from the previous "MOCK_OK" which lied at the field level.
        "connection_state": "MOCK_UNCONNECTED",
        "last_sync_at": last_sync_at.isoformat(timespec="seconds"),
        "age_seconds": age_seconds,
        "run_id": run_id,
        "records_pulled": {
            "asset_master": len(ds.assets),
            "readiness_status": len(last_day_snapshots(ds)),
            "service_requests_open": sum(1 for s in ds.srs if s.close_date is None),
            "supply_documents_open": sum(
                1
                for s in ds.srs
                for r in s.requisitions
                if r.received_date is None
            ),
        },
        "next_poll_at": (now + timedelta(seconds=30 - (age_seconds % 30))).isoformat(timespec="seconds"),
        "polling_interval_seconds_nominal": 30,
        "label_warning": (
            "MOCK adapter — no live GCSS-MC connection is in place. "
            "Timestamps and counts are derived from the synthetic SPIRE "
            "dataset to demonstrate the contract roundtrip."
        ),
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/gcss-mc/last-sync")
async def gcss_mc_last_sync():
    """Topbar pill polls this. Mocked but deterministic across polls."""
    return _mock_last_sync()


@router.get("/gcss-mc/sample")
async def gcss_mc_sample(
    limit: int = Query(5, ge=1, le=50, description="Records per table"),
    uic: Optional[str] = Query(None, description="Optional UIC filter"),
):
    """Realistic GCSS-MC-shaped payload sliced from the canonical synthetic
    dataset. Used by the integration page to prove the contract roundtrip.

    The four sub-payloads correspond to the four GCSS-MC tables SPIRE
    consumes:
      - EQUIPMENT_MASTER   (asset identity, TAMCN-keyed)
      - MIMMS_DAILY_READINESS  (per-day readiness rollup)
      - ER (EQUIPMENT_REPAIR_ORDER)  (open / closed maintenance jobs)
      - SUPPLY_DOC  (DLA-routed parts requisitions, milestone-coded)

    A `_mock` block at the top labels the reference posture so a downstream
    consumer can refuse to treat the payload as authoritative.
    """
    ds = get_dataset()

    # Asset slice ----------------------------------------------------------
    assets = ds.assets
    if uic:
        u = uic.upper()
        assets = [a for a in assets if (a.unit_uic or "").upper() == u]
    asset_sample = assets[:limit]
    asset_ids = {a.asset_id for a in asset_sample}

    # Readiness slice (last-day snapshots, scoped to the asset slice) ------
    last_snaps = last_day_snapshots(ds)
    readiness_sample = [s for s in last_snaps if s.asset_id in asset_ids][:limit]

    # Open SR slice (only assets in scope) ---------------------------------
    open_srs = [s for s in ds.srs if s.asset_id in asset_ids and s.close_date is None]
    sr_sample = open_srs[:limit]
    sr_numbers = {s.sr_number for s in sr_sample}

    # Requisitions for the SR sample ---------------------------------------
    req_sample = []
    for s in sr_sample:
        for r in s.requisitions:
            req_sample.append(r)
            if len(req_sample) >= limit * 3:
                break
        if len(req_sample) >= limit * 3:
            break

    # Reverse-mapping reference table — surfaced inline in the payload so
    # an inspector can see exactly how each GCSS-MC field is derived from
    # SPIRE without leaving the response.
    field_mapping = {
        "EQUIPMENT_MASTER": {
            "UIC": "asset.unit_uic",
            "TAMCN": "asset.tamcn",
            "NSN": "asset.nsn",
            "SERIAL_NO": "asset.serial_number",
            "MODEL": "asset.model",
            "FSC": "asset.fsc",
            "EOH_LOC": "asset.location",
            "FIELD_DATE": "asset.fielding_date",
            "DEPLOY_STATUS": "asset.current_deployment_status",
        },
        "MIMMS_DAILY_READINESS": {
            "REPORT_DATE": "snapshot.snapshot_date",
            "UIC": "snapshot.unit_uic",
            "SERIAL_NO": "snapshot.serial_number",
            "TAMCN": "snapshot.tamcn",
            "EOH_STAT": "snapshot.readiness_code (MC/PMC/NMCM/NMCS)",
            "DEADLINE_DAYS": "snapshot.days_deadlined",
            "EOH_HOURS": "snapshot.current_hours",
            "EOH_MILES": "snapshot.current_miles",
            "OPEN_DR_COUNT": "snapshot.open_sr_count",
            "PARTS_ON_ORDER": "snapshot.parts_on_order",
        },
        "EQUIPMENT_REPAIR_ORDER": {
            "ERO_NO": "service_request.sr_number",
            "PD": "service_request.priority (FAD-derived 01..05)",
            "JOB_STATUS": "service_request.job_status",
            "DEFECT_CODE": "service_request.defect_code_primary",
            "TM_REF": "service_request.tm_reference",
            "MAINT_LEVEL": "service_request.maintenance_level",
        },
        "SUPPLY_DOC": {
            "DOC_NO": "part_requisition.document_number",
            "STATUS_CODE": "part_requisition.current_status (DLA milestone code)",
            "RDD": "part_requisition.received_date (Required Delivery Date)",
            "UOI": "part_requisition.uoi (Unit of Issue)",
        },
    }

    return {
        "_mock": {
            "label": "REFERENCE IMPLEMENTATION",
            "warning": (
                "This payload is shaped to match GCSS-MC tables but is "
                "sourced from the SPIRE synthetic dataset. No live GCSS-MC "
                "connection is in place. Do not treat as authoritative."
            ),
            "shape_version": "spire-gcss-mc-adapter/0.1.0",
            "spec_sources": [
                "MCO 4400.150 — Consumer-level Supply Policy (TAMCN/NSN/UIC nomenclature)",
                "GCSS-MC Functional Description (publicly-released USMC training materials)",
                "MIMMS readiness reporting standards (MCO P4790.2)",
                "DLA Milestone Status Codes (MILSTRIP / DLAM 4140.2)",
            ],
            "filters_applied": {"limit": limit, "uic": uic},
            "as_of_dataset_day": (
                last_snaps[0].snapshot_date.isoformat()
                if last_snaps and hasattr(last_snaps[0].snapshot_date, "isoformat")
                else None
            ),
        },
        "field_mapping_reference": field_mapping,
        "EQUIPMENT_MASTER": [_asset_master_row(a) for a in asset_sample],
        "MIMMS_DAILY_READINESS": [_readiness_status_row(s) for s in readiness_sample],
        "EQUIPMENT_REPAIR_ORDER": [_service_request_row(s) for s in sr_sample],
        "SUPPLY_DOC": [_requisition_row(r) for r in req_sample[: limit * 2]],
        "totals_in_canonical_dataset": {
            "EQUIPMENT_MASTER": len(ds.assets),
            "MIMMS_DAILY_READINESS_today": len(last_snaps),
            "EQUIPMENT_REPAIR_ORDER_open": sum(1 for s in ds.srs if s.close_date is None),
            "SUPPLY_DOC_open": sum(
                1 for s in ds.srs for r in s.requisitions if r.received_date is None
            ),
        },
    }
