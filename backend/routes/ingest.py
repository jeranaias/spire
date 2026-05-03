"""Real-data ingest router (RD-track).

Mounts adapters from `backend.integrations.*` behind authenticated,
feature-flag-gated routes. Each adapter parses its own source-of-record
file format into SPIRE-native rows; this router is the operator's entry
point for "drop a file, see what would land".

The router is gated on `SPIRE_INGEST_ENABLED=1` (env var). When the flag
is unset (the default for both demo and pilot builds), the router still
mounts but every endpoint returns 503 with a clear error so the surface
is visible to operators (and to integration tests) without being live.

A pilot operator turns ingest on by:
  1. Setting `SPIRE_INGEST_ENABLED=1` on the box (Fly secret /
     docker-compose env)
  2. Restarting the backend
  3. Uploading a CSV via /api/ingest/gcss-mc/ecp

Each route is RBAC-scoped to data_custodian + security_manager: the
people authorized to bring real data into the system. Other roles see
403 (out of scope).
"""
from __future__ import annotations

import os
from typing import List

from fastapi import APIRouter, File, HTTPException, Request, UploadFile

from ..integrations.pulse_gcss_ecp_adapter import (
    EXPECTED_HEADER_COLUMNS as ECP_EXPECTED_COLUMNS,
    IngestReport as ECPIngestReport,
    ParsedAssetRow as ECPParsedAssetRow,
    parse_ecp,
)
from ..integrations.pulse_gcss_ecp_merge import compute_diff, diff_to_payload
from ..scoping import require_user_role
from ..state import get_dataset


router = APIRouter()


INGEST_ROLES = frozenset({"data_custodian", "security_manager"})
INGEST_FILE_MAX_BYTES = 256 * 1024 * 1024  # 256 MB — covers full-MEF ECP exports


def _ingest_enabled() -> bool:
    """Feature flag — default off so the route ships dormant."""
    raw = os.environ.get("SPIRE_INGEST_ENABLED", "")
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _require_ingest_enabled():
    if not _ingest_enabled():
        raise HTTPException(
            status_code=503,
            detail=(
                "Ingest is disabled on this box. Set SPIRE_INGEST_ENABLED=1 "
                "in the environment and restart the backend to enable it. "
                "This is the default for fresh installs — flip it on once "
                "the operator is ready to bring real GCSS-MC exports into "
                "the system."
            ),
        )


@router.get("/status")
async def ingest_status(request: Request):
    """Cheap probe: is the ingest router live, and which adapters are mounted?

    Authenticated to any role so the frontend can render the right
    affordance ("Ingest is disabled — ask your data custodian to flip
    SPIRE_INGEST_ENABLED" vs "Drop file here") without leaking
    role-scoped state.
    """
    return {
        "enabled": _ingest_enabled(),
        "adapters": [
            {
                "id": "gcss-mc/ecp",
                "name": "GCSS-MC Equipment Custodian Report",
                "shape": "csv",
                "expected_columns": list(ECP_EXPECTED_COLUMNS),
                "writes_to": "asset_roster",
                "auth_roles": sorted(INGEST_ROLES),
            },
        ],
    }


def _ecp_row_to_dict(row: ECPParsedAssetRow) -> dict:
    """Serialize one parsed row for the JSON response.

    Drops the `_warnings` list off the row payload (the report carries
    aggregate warning counts) but keeps the `*_source` provenance
    fields so the operator can spot a file that had to be self-hashed
    at ingest time and pull the upstream feed back in line.
    """
    return {
        "tamcn": row.tamcn,
        "nsn": row.nsn,
        "serial_number": row.serial_number,
        "serial_number_source": row.serial_number_source,
        "nomenclature": row.nomenclature,
        "owner_uic": row.owner_uic,
        "owner_uic_source": row.owner_uic_source,
        "allowance_qty": row.allowance_qty,
        "on_hand_qty": row.on_hand_qty,
        "last_inventory_date": row.last_inventory_date.isoformat() if row.last_inventory_date else None,
        "warnings": list(row._warnings),
    }


def _ecp_report_to_dict(report: ECPIngestReport) -> dict:
    return {
        "rows_total": report.rows_total,
        "rows_kept": report.rows_kept,
        "rows_with_warnings": report.rows_with_warnings,
        "rows_with_self_hashed_uic": report.rows_with_self_hashed_uic,
        "rows_with_self_hashed_serial": report.rows_with_self_hashed_serial,
        "rows_missing_tamcn": report.rows_missing_tamcn,
        "rows_missing_serial": report.rows_missing_serial,
        "date_parse_failures": report.date_parse_failures,
        "header_mismatch": report.header_mismatch,
        "header_missing_columns": list(report.header_missing_columns),
        "header_extra_columns": list(report.header_extra_columns),
    }


@router.post("/gcss-mc/ecp")
async def ingest_gcss_mc_ecp(request: Request, file: UploadFile = File(...)):
    """Upload + parse one GCSS-MC Equipment Custodian Report.

    Returns the IngestReport plus the parsed rows. Does NOT yet merge
    into the canonical dataset — that's the next RD step (RD-5 in the
    plan: dry-run preview vs apply). For now this surface lets the
    operator see "what would land" against their real ECP file before
    we wire the merge.
    """
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    require_user_role(user, INGEST_ROLES, action="ingest.gcss_mc_ecp")

    body = await file.read()
    if len(body) > INGEST_FILE_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({len(body):,} bytes); max is {INGEST_FILE_MAX_BYTES:,} bytes.",
        )
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as e:
        raise HTTPException(
            status_code=400,
            detail=f"File must be UTF-8 text (CSV). Decode failed at byte {e.start}.",
        )

    rows, report = parse_ecp(text)

    # Dry-run merge preview (RD5). compute_diff matches rows against the
    # canonical dataset's asset roster and surfaces new/updated/stale/
    # conflict counts plus a sample list per bucket. The actual write
    # path lands in a follow-up — for now this lets the operator see
    # exactly what would change before they decide to apply.
    try:
        ds = get_dataset()
        canonical_assets = list(getattr(ds, "assets", []) or [])
    except Exception:
        # Empty/empty-envelope dataset — surface zero canonical assets;
        # the diff will report every parsed row as "new".
        canonical_assets = []
    diff = compute_diff(rows, canonical_assets)

    return {
        "report": _ecp_report_to_dict(report),
        "rows": [_ecp_row_to_dict(r) for r in rows],
        "preview": diff_to_payload(diff),
        "merge_target": "asset_roster",
        "applied": False,
    }
