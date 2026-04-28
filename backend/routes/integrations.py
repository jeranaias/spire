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

import csv
import hashlib
import io
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, Response

from ..integrations.gcss_hash import (
    hash_document_number,
    hash_nsn_ordered,
    hash_owner_unit,
    hash_rnsn,
    hash_serial_number,
    hash_sos,
    hash_sr_number,
    hash_tamcn,
)
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


# ---------------------------------------------------------------------------
# Sibling-system reference adapters — TC-AIMS-II, MIMMS, AESIP/LMP, GFEBS
#
# Task #166. These integration targets are documented as planned source-of-
# record adapters alongside GCSS-MC. The frontend renders an integrations
# subpage for each of them and that subpage needs a sample endpoint to
# poll on its claimed cadence — without one, the page either bypasses the
# DDIL interceptor entirely (no comms-degraded acknowledgement) or it
# fakes a slice client-side (the integrity-of-claims posture this app is
# built around forbids that).
#
# Every endpoint below follows the same contract as `gcss_mc_sample`:
#   * carries a `_mock` block labeled REFERENCE IMPLEMENTATION so a
#     downstream consumer cannot mistake it for a live link
#   * sources its rows from the same canonical synthetic SPIRE dataset
#     (no separate fixture to drift)
#   * routes through the FastAPI app, which means jsonFetch picks it up
#     and the DDIL middleware can intercept / latency-dramatize / deny
# ---------------------------------------------------------------------------

def _ref_mock_block(*, system: str, shape: str, sources: tuple[str, ...]) -> dict:
    """Shared `_mock` block for sibling sample endpoints. Every adapter
    response prints the same posture so a curl reviewer can be sure the
    payload is reference-only no matter which target they hit."""
    return {
        "label": "REFERENCE IMPLEMENTATION",
        "system": system,
        "warning": (
            f"This payload is shaped to match {system} but is sourced from "
            "the SPIRE synthetic dataset. No live connection is in place. "
            "Do not treat as authoritative."
        ),
        "shape_version": shape,
        "spec_sources": list(sources),
    }


@router.get("/tc-aims-ii/sample")
async def tc_aims_ii_sample(
    limit: int = Query(5, ge=1, le=50, description="Movement records per slice"),
):
    """TC-AIMS-II — Transportation Coordinators' Automated Information for
    Movements System II. Joint movement-tracking system for unit moves,
    cargo manifests, and TPFDD execution. Reference adapter emits movement-
    shaped rows derived from SPIRE's deployed/garrison asset state."""
    ds = get_dataset()
    deployed = [a for a in ds.assets if (a.current_deployment_status or "") == "DEPLOYED"]
    sample = deployed[:limit] if deployed else ds.assets[:limit]
    rows = [
        {
            "MOVEMENT_ID": f"TC-{(a.unit_uic or 'XXX')[:6]}-{i:04d}",
            "UIC": a.unit_uic,
            "TAMCN": a.tamcn,
            "SERIAL_NO": a.serial_number,
            "NSN": a.nsn,
            "ORIGIN_GEOLOC": a.location or "GARRISON",
            "DEST_GEOLOC": "DEPLOYED" if (a.current_deployment_status or "") == "DEPLOYED" else "GARRISON",
            "POE": "NORVA",
            "POD": "BAHRAIN",
            "MODE": "SEALIFT",
            "CARGO_CATEGORY": "ROLLING_STOCK",
            "MANIFEST_STATUS": "MANIFESTED" if i % 3 else "STAGED",
            "STATUS_DATE": (datetime.now(timezone.utc) - timedelta(hours=i)).date().isoformat(),
        }
        for i, a in enumerate(sample, start=1)
    ]
    return {
        "_mock": _ref_mock_block(
            system="TC-AIMS-II",
            shape="spire-tc-aims-ii-adapter/0.1.0",
            sources=(
                "USTRANSCOM Joint Deployment Distribution Enterprise documentation",
                "TC-AIMS II User's Manual (publicly-released training materials)",
                "JP 4-09 Distribution Operations (movement-tracking nomenclature)",
            ),
        ),
        "MOVEMENT_RECORDS": rows,
        "totals_in_canonical_dataset": {
            "deployed_assets": len(deployed),
            "garrison_assets": sum(
                1 for a in ds.assets if (a.current_deployment_status or "") != "DEPLOYED"
            ),
        },
    }


@router.get("/mimms/sample")
async def mimms_sample(
    limit: int = Query(5, ge=1, le=50, description="Daily readiness rows per slice"),
):
    """MIMMS — Marine Corps Integrated Maintenance Management System.
    The readiness sub-component of GCSS-MC, called out separately here
    because PM IRONSIDE evaluators have asked about it on its own. Slices
    the per-day readiness rollup from the same canonical dataset."""
    ds = get_dataset()
    snaps = last_day_snapshots(ds)[:limit]
    rows = [_readiness_status_row(s) for s in snaps]
    return {
        "_mock": _ref_mock_block(
            system="MIMMS",
            shape="spire-mimms-adapter/0.1.0",
            sources=(
                "MCO P4790.2 — MIMMS readiness reporting standards",
                "USMC EOH_STAT code set (MC / PMC / NMCM / NMCS)",
            ),
        ),
        "MIMMS_DAILY_READINESS": rows,
        "totals_in_canonical_dataset": {
            "MIMMS_DAILY_READINESS_today": len(last_day_snapshots(ds)),
        },
    }


@router.get("/aesip-lmp/sample")
async def aesip_lmp_sample(
    limit: int = Query(5, ge=1, le=50, description="Material-master rows per slice"),
):
    """AESIP / LMP — Army Enterprise Systems Integration Program is the
    hub the Army's Logistics Modernization Program (LMP) projects through.
    SPIRE consumes AESIP material-master and order-status feeds as a
    parallel adapter to GCSS-MC for joint readiness rollups. Reference
    payload is sourced from the same synthetic dataset for now."""
    ds = get_dataset()
    sample_assets = ds.assets[:limit]
    rows = [
        {
            "MATERIAL_NUMBER": a.nsn,
            "PLANT": (a.unit_uic or "USA0")[:4],
            "DESCRIPTION": a.nomenclature,
            "MATERIAL_TYPE": "FERT",
            "BASE_UOM": "EA",
            "STORAGE_LOCATION": a.location or "MAIN",
            "VALUATION_CLASS": "3001",
            "STOCK_TYPE": "UNRESTRICTED",
            "QTY_ON_HAND": 1,
            "READINESS_LINK_TAMCN": a.tamcn,
        }
        for a in sample_assets
    ]
    open_orders = [
        {
            "PO_NUMBER": (req.document_number or "")[:14],
            "MATERIAL_NUMBER": req.nsn,
            "QTY": req.qty_ordered,
            "DLA_STATUS_CODE": req.current_status,
            "RDD": (
                req.received_date.isoformat()
                if req.received_date and hasattr(req.received_date, "isoformat")
                else None
            ),
        }
        for s in ds.srs
        for req in s.requisitions
        if req.received_date is None
    ][: limit * 2]
    return {
        "_mock": _ref_mock_block(
            system="AESIP / LMP",
            shape="spire-aesip-lmp-adapter/0.1.0",
            sources=(
                "AR 700-127 Integrated Logistics Support",
                "LMP Functional Description (publicly-released Army training materials)",
                "SAP ERP material-master conventions (FERT / ROH / HAWA)",
            ),
        ),
        "MATERIAL_MASTER": rows,
        "PURCHASE_ORDERS_OPEN": open_orders,
        "totals_in_canonical_dataset": {
            "MATERIAL_MASTER": len(ds.assets),
            "PURCHASE_ORDERS_OPEN": sum(
                1 for s in ds.srs for r in s.requisitions if r.received_date is None
            ),
        },
    }


@router.get("/gfebs/sample")
async def gfebs_sample(
    limit: int = Query(5, ge=1, le=50, description="Funding-line rows per slice"),
):
    """GFEBS — General Fund Enterprise Business System. Army's general-
    fund financial system (SAP). SPIRE's planned read of GFEBS is the
    funding-line / commitment / obligation view that lets a J4 see whether
    the parts a deadlined asset needs are funded as well as ordered.
    Reference payload uses the synthetic requisition stream."""
    ds = get_dataset()
    open_reqs = [
        r for s in ds.srs for r in s.requisitions if r.received_date is None
    ][: limit * 3]
    rows = []
    for i, r in enumerate(open_reqs, start=1):
        unit_cost = float(getattr(r, "unit_cost", 0.0) or 0.0)
        qty = int(getattr(r, "qty_ordered", 1) or 1)
        commit = round(unit_cost * qty, 2)
        rows.append(
            {
                "DOC_NO": r.document_number,
                "FUND": "97-2026/2027",
                "FUNDS_CENTER": (r.sr_number or "FCXXX")[:8],
                "FUNCTIONAL_AREA": "121A",
                "COMMITMENT_ITEM": "2620",
                "WBS_ELEMENT": f"WBS-{i:05d}",
                "OBLIGATION_USD": commit,
                "DISBURSEMENT_USD": 0.0 if i % 4 else commit,
                "POSTING_DATE": (
                    r.ordered_date.isoformat()
                    if r.ordered_date and hasattr(r.ordered_date, "isoformat")
                    else None
                ),
            }
        )
    return {
        "_mock": _ref_mock_block(
            system="GFEBS",
            shape="spire-gfebs-adapter/0.1.0",
            sources=(
                "DFAS / OUSD(C) DoD Financial Management Regulation Vol 6A",
                "GFEBS Functional Reference Guide (publicly-released Army materials)",
                "Standard Financial Information Structure (SFIS) accounting strings",
            ),
        ),
        "FUNDING_LINES_OPEN": rows,
        "totals_in_canonical_dataset": {
            "FUNDING_LINES_OPEN": len(open_reqs),
            "FUNDING_LINES_OBLIGATED_USD": round(
                sum(r["OBLIGATION_USD"] for r in rows), 2
            ),
        },
    }


# ---------------------------------------------------------------------------
# T6 — GCSS-MC export adapter
#
# Emit the synthetic dataset back out in the *exact* shape of the real
# GCSS-MC sanitized exports SPIRE was schema-aligned against. Three CSVs:
#   - SR header  (12 columns, DD-MON-YY dates, hashed UICs)
#   - SR repair parts  (6 columns)
#   - Due-In         (subset of the 95 columns, the ones SPIRE actually
#                     populates — see `gcss_dictionary.json`)
# Plus a JSON dictionary endpoint that backs the Field Dictionary tab.
# ---------------------------------------------------------------------------

# 12 columns of the real SR header export, in canonical order.
_GCSS_HEADER_COLUMNS: tuple[str, ...] = (
    "SERVICE_REQUEST_TYPE",
    "SR_NUMBER",
    "DEFECT_CODE",
    "PROBLEM_SUMMARY",
    "DATE_RECEIVED_IN_SHOP",
    "ECHELON_OF_MAINT",
    "SERIAL_NUMBER",
    "TAMCN",
    "DEADLINED_DATE",
    "MASTER_PRIORITY_CODE",
    "OWNER_UNIT_ADDRESS_CODE",
    "JOB_STATUS_DATE",
)

# 6 columns of the real SR repair parts export.
_GCSS_PARTS_COLUMNS: tuple[str, ...] = (
    "SR_NUMBER",
    "SERVICE_ACTIVITY",
    "RNSN",
    "QUANTITY_REQUIRED",
    "PARTS_CHARGE",
    "DOCUMENT_NUMBER",
)

# Full 82-column due-in export shape (matches the real GCSS-MC sanitized
# export header row exactly). SPIRE only populates the ~12 columns it
# actually consumes; the remaining columns are emitted as empty strings
# so the schema is byte-stable for downstream tooling that pre-allocates
# columns.
_GCSS_DUE_IN_COLUMNS: tuple[str, ...] = (
    "DOC_NBR",
    "DIC",
    "NSN_ORDERED",
    "PRI_CD",
    "PURPOSE_CD",
    "ESTABLISHED_DT",
    "MAX_STAT_DT",
    "SUPP_ADD",
    "SR_NUMBER",
    "ADVICE_CODE",
    "ITEM_TYPE",
    "RCVR_CD",
    "CEC",
    "SAC",
    "SOS",
    "UNIT_PRICE",
    "STATUS_QTY",
    "REMAIN_DUE_RULE",
    "DOC_STATUS",
    "RULE_ASSIGNED",
    "BO_QTY_FIRST",
    "BO_QTY_LAST",
    "QTY_PEND_SHIP",
    "BM_QTY",
    "BZ_BV_QTY",
    "BG_QTY",
    "BJ_QTY",
    "QTY_CANCELLED",
    "D9_QTY",
    "QTY_SHIPPED",
    "QTY_RECEIVED",
    "DRA_QTY",
    "COR_QTY",
    "DRB_QTY",
    "DRF_QTY",
    "MAX_DT_EST",
    "MIN_BO_DT",
    "MAX_BO_DT",
    "MIN_BA_DT",
    "MAX_BA_DT",
    "MIN_BM_DT",
    "MAX_BM_DT",
    "MIN_BJ_DT",
    "MAX_BJ_DT",
    "MIN_BG_DT",
    "MAX_BG_DT",
    "MIN_CANC_DT",
    "MAX_CANC_DT",
    "MIN_AS1_DT",
    "MAX_AS1_DT",
    "MIN_D6_DT",
    "MAX_D6_DT",
    "MIN_DRA_DT",
    "MAX_DRA_DT",
    "MIN_COR_DT",
    "MAX_COR_DT",
    "MIN_DRB_DT",
    "MAX_DRB_DT",
    "MIN_DRF_DT",
    "MAX_DRF_DT",
    "MIN_D9_DT",
    "MAX_D9_DT",
    "ESTABLISHED_TO_MRO",
    "MRO_TO_SHIP",
    "OST",
    "LRT",
    "CWT",
    "DOC_FY",
    "FY_QTR",
    "DOC_FY_QTR",
    "SIGNAL_CD",
    "APPROVED_DT",
    "FY_MTH",
    "CONDITION_CODE",
    "TASK_NBR",
    "RDD_CAL_DT",
    "RDD_CAL_DT_CURATED",
    "RDD_DAYS_FROM_BASE",
    "RDD_DAYS_FROM_TODAY",
    "RDD_MEANING",
    "RDD_ERROR",
    "CURATED_RDD_MEANING",
)

_MONTH_NAMES = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")


def _to_oracle_date(d: Any) -> str:
    """Format a `date`/`datetime`/None as Oracle DD-MON-YY ("12-MAR-26")."""
    if not d:
        return ""
    try:
        day = d.day
        mon = _MONTH_NAMES[d.month - 1]
        yr = d.year % 100
        return f"{day:02d}-{mon}-{yr:02d}"
    except Exception:
        return ""


def _defect_code_full(sr) -> str:
    """`FCON.CBB`, or `FCON.` for the trailing-period dirty signal, or
    `FCON` if no secondary."""
    a = (getattr(sr, "defect_code_primary", "") or "").strip()
    b = (getattr(sr, "defect_code_secondary", "") or "").strip()
    if not a and not b:
        return ""
    if not b:
        return a
    return f"{a}.{b}"


def _problem_summary(sr) -> str:
    """Use the SR remark text if present, otherwise compose a terse
    summary from defect code + maintenance level."""
    text = (getattr(sr, "remark_text", "") or "").strip()
    if text:
        # Strip newlines so the CSV stays single-line per row.
        return " ".join(text.split())[:250]
    primary = getattr(sr, "defect_code_primary", "") or ""
    return f"{primary} fault — {getattr(sr, 'maintenance_level', '')}"


def _service_activity(req) -> str:
    """Map PartRequisition to a real-export SERVICE_ACTIVITY label."""
    sa = getattr(req, "service_activity", None)
    if sa:
        return sa
    return "Issue from Inventory"


def _row_for_header(sr) -> Dict[str, Any]:
    return {
        "SERVICE_REQUEST_TYPE": getattr(sr, "service_request_type", "Maintenance - CM"),
        "SR_NUMBER": hash_sr_number(sr.sr_number),
        "DEFECT_CODE": _defect_code_full(sr),
        "PROBLEM_SUMMARY": _problem_summary(sr),
        "DATE_RECEIVED_IN_SHOP": _to_oracle_date(sr.open_date),
        "ECHELON_OF_MAINT": getattr(sr, "echelon_numeric", "") or "",
        "SERIAL_NUMBER": hash_serial_number(sr.serial_number),
        "TAMCN": hash_tamcn(sr.tamcn),
        "DEADLINED_DATE": _to_oracle_date(getattr(sr, "deadlined_date", None)),
        "MASTER_PRIORITY_CODE": sr.priority,
        "OWNER_UNIT_ADDRESS_CODE": hash_owner_unit(sr.unit_uic),
        "JOB_STATUS_DATE": _to_oracle_date(sr.close_date or sr.open_date),
    }


def _row_for_parts(req) -> Dict[str, Any]:
    return {
        "SR_NUMBER": hash_sr_number(req.sr_number),
        "SERVICE_ACTIVITY": _service_activity(req),
        "RNSN": hash_rnsn(req.nsn),
        "QUANTITY_REQUIRED": req.qty_ordered,
        "PARTS_CHARGE": float(getattr(req, "total_cost", 0.0) or 0.0),
        "DOCUMENT_NUMBER": hash_document_number(req.document_number),
    }


def _row_for_due_in(req) -> Dict[str, Any]:
    """Populate the 12 due-in columns SPIRE actually models. The other 70
    are emitted as empty strings so the on-the-wire row preserves the
    full real-export schema width and column order. Downstream tooling
    that pre-allocates columns can rely on byte-stable headers regardless
    of which fields SPIRE chooses to fill."""
    received = getattr(req, "received_date", None)
    ordered = getattr(req, "ordered_date", None)
    fy = ordered.year if ordered else ""
    fy_qtr = ""
    fy_mth = ""
    doc_fy_qtr = ""
    if ordered:
        # USG fiscal year starts Oct 1. FY26 = Oct 2025 - Sep 2026.
        fy_year = ordered.year + 1 if ordered.month >= 10 else ordered.year
        fy = fy_year
        # Quarter 1 = Oct-Dec, Q2 = Jan-Mar, Q3 = Apr-Jun, Q4 = Jul-Sep.
        m = ordered.month
        if m >= 10:
            q = 1
        elif m <= 3:
            q = 2
        elif m <= 6:
            q = 3
        else:
            q = 4
        fy_qtr = f"Q{q}"
        doc_fy_qtr = f"FY{fy_year % 100:02d}-Q{q}"
        fy_mth = f"{fy_year % 100:02d}-{_MONTH_NAMES[m - 1]}"
    return {
        # SPIRE-populated columns (12 of 82):
        "DOC_NBR": hash_document_number(req.document_number),
        "DIC": getattr(req, "dic", "") or "",
        "NSN_ORDERED": hash_nsn_ordered(req.nsn),
        "PRI_CD": req.priority,
        "ESTABLISHED_DT": _to_oracle_date(ordered),
        "MAX_STAT_DT": _to_oracle_date(req.projected_delivery_date),
        "SR_NUMBER": hash_sr_number(req.sr_number),
        "SOS": hash_sos(getattr(req, "service_activity", "") or ""),
        "ITEM_TYPE": getattr(req, "item_type", "I"),
        "DOC_STATUS": getattr(req, "doc_status", "") or "",
        "UNIT_PRICE": float(getattr(req, "unit_cost", 0.0) or 0.0),
        "QTY_SHIPPED": req.qty_ordered if received else 0,
        "QTY_RECEIVED": req.qty_ordered if received else 0,
        # Light-touch derived bookkeeping (kept here so the byte shape
        # stays useful to downstream tools, not just empty padding):
        "DOC_FY": fy,
        "FY_QTR": fy_qtr,
        "DOC_FY_QTR": doc_fy_qtr,
        "FY_MTH": fy_mth,
        "APPROVED_DT": _to_oracle_date(ordered),
        "MAX_DT_EST": _to_oracle_date(req.projected_delivery_date),
        # Remaining 63 columns implicitly default to "" via _csv_response.
    }


def _csv_response(columns: tuple[str, ...], rows: List[Dict[str, Any]], filename: str) -> Response:
    """Build a CSV response that mirrors the real GCSS-MC export shape.

    Real `hashed_header.csv` ships an unquoted header row and only quotes
    body values when the value contains a comma, quote, or newline (i.e.
    `csv.QUOTE_MINIMAL` semantics). Switching to QUOTE_MINIMAL makes
    `curl ... | head -1` byte-equal to the real header.
    """
    buf = io.StringIO()
    # `lineterminator="\n"` matches the real export's Unix line endings
    # (Python's csv default of `\r\n` would break byte-for-byte parity).
    writer = csv.DictWriter(
        buf,
        fieldnames=list(columns),
        quoting=csv.QUOTE_MINIMAL,
        lineterminator="\n",
    )
    writer.writeheader()
    for r in rows:
        writer.writerow({c: r.get(c, "") for c in columns})
    return Response(
        content=buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-Spire-Adapter": "gcss-mc-export/0.1.0",
            "X-Spire-Mock": "REFERENCE_IMPLEMENTATION",
        },
    )


# Export endpoints live in `backend/routes/gcss_export.py` and are mounted
# at /api/gcss/export/ (canonical) and /api/integrations/gcss-mc/export/
# (alias) by `backend/main.py`. The shared row helpers and column
# constants above are imported from there.


@router.get("/gcss-mc/coverage-summary")
async def gcss_mc_coverage_summary():
    """Lightweight summary of how much of the 163-column GCSS-MC schema
    SPIRE actually consumes vs. drops. Backs the Field Dictionary tab's
    header pills and the overview hero card."""
    dict_path = Path(__file__).resolve().parents[2] / "dataset" / "data" / "gcss_dictionary.json"
    if not dict_path.exists():
        raise HTTPException(
            status_code=503,
            detail="gcss_dictionary.json not present — run "
            "`python -m dataset.scripts.build_gcss_dictionary` to regenerate.",
        )
    with dict_path.open("r", encoding="utf-8") as f:
        d = json.load(f)
    sections_summary = []
    grand_total = 0
    grand_consumed = 0
    grand_partial = 0
    for s in d.get("sections", []):
        cov_counts = {"consumed": 0, "partial": 0, "dropped": 0}
        for c in s.get("columns", []):
            lvl = (c.get("coverage", {}) or {}).get("level", "dropped")
            cov_counts[lvl] = cov_counts.get(lvl, 0) + 1
        total = sum(cov_counts.values())
        sections_summary.append({
            "id": s.get("id"),
            "title": s.get("title"),
            "total_columns": total,
            "consumed": cov_counts["consumed"],
            "partial": cov_counts["partial"],
            "dropped": cov_counts["dropped"],
            "row_count_real_export": s.get("row_count_real_export", 0),
        })
        grand_total += total
        grand_consumed += cov_counts["consumed"]
        grand_partial += cov_counts["partial"]
    return {
        "generated_at": d.get("_meta", {}).get("generated_at"),
        "totals": {
            "columns": grand_total,
            "consumed": grand_consumed,
            "partial": grand_partial,
            "dropped": grand_total - grand_consumed - grand_partial,
            "consumed_pct": round(100.0 * grand_consumed / grand_total, 1) if grand_total else 0.0,
        },
        "sections": sections_summary,
    }


@router.get("/gcss-mc/dictionary")
async def gcss_mc_dictionary(
    section: Optional[str] = Query(None, description="header|parts|due_in (optional filter)"),
):
    """Serve the derived GCSS-MC field dictionary. Backs the Field
    Dictionary tab on the Integrations page."""
    dict_path = Path(__file__).resolve().parents[2] / "dataset" / "data" / "gcss_dictionary.json"
    if not dict_path.exists():
        raise HTTPException(
            status_code=503,
            detail="gcss_dictionary.json not present — run "
            "`python -m dataset.scripts.build_gcss_dictionary` to regenerate.",
        )
    with dict_path.open("r", encoding="utf-8") as f:
        d = json.load(f)
    if section:
        wanted = section.lower()
        d = {
            "_meta": d.get("_meta", {}),
            "sections": [s for s in d.get("sections", []) if s.get("id") == wanted],
        }
    return JSONResponse(content=d)


# WP-8 acceptance: the Field Dictionary UI links here so a reviewer can
# open the full schema fidelity report inline. Served as text/markdown so
# a curl recipe in DDIL still works and the browser can pretty-print via
# the Markdown viewer extension or the user's editor of choice.
@router.get("/gcss-mc/fidelity-report")
async def gcss_mc_fidelity_report():
    report_path = (
        Path(__file__).resolve().parents[2] / "docs" / "gcss_fidelity_report.md"
    )
    if not report_path.exists():
        raise HTTPException(
            status_code=503,
            detail="gcss_fidelity_report.md not present — run "
            "`python -m dataset.scripts.generate_fidelity_report` to regenerate.",
        )
    md = report_path.read_text(encoding="utf-8")
    return Response(content=md, media_type="text/markdown; charset=utf-8")
