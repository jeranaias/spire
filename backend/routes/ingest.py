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

import hashlib
import os
from datetime import date
from typing import Any, List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile

from ..integrations.pulse_gcss_ecp_adapter import (
    EXPECTED_HEADER_COLUMNS as ECP_EXPECTED_COLUMNS,
    IngestReport as ECPIngestReport,
    ParsedAssetRow as ECPParsedAssetRow,
    parse_ecp,
)
from ..integrations.pulse_gcss_ecp_merge import (
    apply_diff,
    compute_diff,
    diff_to_payload,
)
from ..integrations.pulse_gcss_util_adapter import (
    EXPECTED_HEADER_COLUMNS as UTIL_EXPECTED_COLUMNS,
    apply_latest_readings,
    parse_util,
)
from ..persistence import log as audit_log
from ..scoping import require_user_role
from ..state import CanonicalDataset, get_dataset, swap_dataset


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
            {
                "id": "gcss-mc/util",
                "name": "GCSS-MC Utilization Extract",
                "shape": "csv",
                "expected_columns": list(UTIL_EXPECTED_COLUMNS),
                "writes_to": "asset_current_hours_miles_status",
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


def _file_token(body: bytes) -> str:
    """SHA-256 of the uploaded file body. Used as a confirm-token so
    `apply=1` only proceeds against the exact same bytes the operator
    saw on dry-run. Stale-diff applies fail with 409."""
    return hashlib.sha256(body).hexdigest()[:32]


def _ecp_row_to_asset(row: ECPParsedAssetRow) -> Any:
    """Build a `dataset.fleet.Asset` from one parsed ECP row.

    Only the roster + ECP-only fields are populated; behavioral state
    (current_hours, current_miles, current_status, etc.) defaults to
    the same `__post_init__` values the synthetic generator uses, so a
    real-data new asset slots into the simulator without crashing it.
    Lifecycle data is filled by later joins (utilization extracts,
    SR streams).
    """
    # Late-bind the import so the route file isn't tied to the dataset
    # package at module load time.
    from dataset.fleet import Asset
    from datetime import date as _date

    asset_id = f"new-{row.tamcn}-{row.serial_number[-8:] or 'unknown'}"
    return Asset(
        asset_id=asset_id,
        equipment_type=row.equipment_type or row.tamcn,  # resolved upstream when registry lands
        tamcn=row.tamcn,
        nsn=row.nsn,
        serial_number=row.serial_number,
        nomenclature=row.nomenclature,
        model="",
        fsc=(row.nsn.split("-")[0] if row.nsn else ""),
        unit_uic=row.owner_uic,
        unit_name="",  # resolved at next reconciliation pass
        unit_parent="",
        location="",
        optempo="medium",
        deployment_status="garrison",
        fielding_date=row.last_inventory_date or _date.today(),
        initial_hours=0.0,
        initial_miles=0,
        classification_risk="LOW",
        allowance_qty=row.allowance_qty,
        on_hand_qty=row.on_hand_qty,
        last_inventory_date=row.last_inventory_date,
    )


@router.post("/gcss-mc/ecp")
async def ingest_gcss_mc_ecp(
    request: Request,
    file: UploadFile = File(...),
    apply: bool = Query(False, description="Apply the diff to the canonical dataset (default: dry-run)"),
    confirm: Optional[str] = Query(None, description="Preview token from a prior dry-run (required when apply=true)"),
):
    """Upload + parse one GCSS-MC Equipment Custodian Report.

    Two modes:

    * Dry-run (default) — parse + compute diff, return preview with a
      `preview_token` the operator can resend on apply.
    * Apply (`?apply=true&confirm=<token>`) — verify the token matches
      the file body, mutate the canonical dataset (matched-row updates
      + new-row appends), atomic swap the singleton, write one
      `ingest.ecp.apply.row` audit entry per change plus a summary
      `ingest.ecp.apply` entry. Stale + conflict rows are NOT
      auto-resolved.
    """
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    actor_role = require_user_role(user, INGEST_ROLES, action="ingest.gcss_mc_ecp")
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None

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

    preview_token = _file_token(body)
    rows, report = parse_ecp(text)

    try:
        ds = get_dataset()
        canonical_assets = list(getattr(ds, "assets", []) or [])
    except Exception:
        canonical_assets = []
    diff = compute_diff(rows, canonical_assets)

    if not apply:
        return {
            "report": _ecp_report_to_dict(report),
            "rows": [_ecp_row_to_dict(r) for r in rows],
            "preview": diff_to_payload(diff),
            "preview_token": preview_token,
            "merge_target": "asset_roster",
            "applied": False,
        }

    # ---- Apply path ----
    if confirm != preview_token:
        raise HTTPException(
            status_code=409,
            detail=(
                "Confirm token mismatch. Re-run the dry-run upload, paste the "
                "returned `preview_token` into ?confirm=<token>, and try again. "
                "This guard prevents fat-finger applies of stale diffs."
            ),
        )
    if diff.conflicts:
        raise HTTPException(
            status_code=409,
            detail=(
                f"{len(diff.conflicts)} conflict row(s) must be resolved before "
                "apply. Each conflict is a parsed row that matched multiple "
                "canonical assets; the operator picks the winner."
            ),
        )

    # Build the new asset list (pure function — no swap yet)
    new_assets = apply_diff(diff, canonical_assets, asset_factory=_ecp_row_to_asset)

    # Construct the new CanonicalDataset by cloning the singleton with
    # the asset list replaced. Other collections (snapshots, srs, etc.)
    # are passed through unchanged — ECP only touches the roster.
    new_ds = _replace_assets(ds, new_assets)

    swap_dataset(
        new_ds,
        source="ingest.ecp",
        ingested_by=actor_dodid or actor_role or "ingest",
        ingest_hash=preview_token,
    )

    # Audit chain: one summary entry plus per-row entries (capped so a
    # 5,000-row file doesn't write 5,000 chain entries — capping keeps
    # the chain inspectable without losing the summary numbers).
    counts = diff.counts()
    audit_log(
        kind="ingest.ecp.apply",
        actor=actor_dodid or actor_role or "system",
        subject_id=preview_token,
        payload={
            "source": "gcss-mc/ecp",
            "preview_token": preview_token,
            "counts": counts,
            "filename": file.filename,
            "actor_role": actor_role,
        },
    )
    for matched in diff.matched[:200]:
        audit_log(
            kind="ingest.ecp.apply.row",
            actor=actor_dodid or actor_role or "system",
            subject_id=matched.asset_id,
            payload={
                "match_method": matched.match_method,
                "changes": [
                    {"field": c.field, "before": c.before, "after": _serialize_for_audit(c.after)}
                    for c in matched.changes
                ],
                "preview_token": preview_token,
            },
        )

    return {
        "report": _ecp_report_to_dict(report),
        "preview": diff_to_payload(diff),
        "preview_token": preview_token,
        "merge_target": "asset_roster",
        "applied": True,
        "applied_counts": counts,
    }


def _serialize_for_audit(value: Any) -> Any:
    """Coerce a FieldChange.after into something the audit canonicalizer
    accepts. Dates → ISO strings; everything else passes through."""
    if isinstance(value, date):
        return value.isoformat()
    return value


def _replace_assets(ds: CanonicalDataset, new_assets: List[Any]) -> CanonicalDataset:
    """Return a CanonicalDataset clone with `assets` replaced.

    CanonicalDataset is a dataclass so dataclasses.replace would work,
    but we hand-roll the clone to avoid pulling the dataclasses dep
    just for one call site. Also lets us bump generated_at to mark the
    swap.
    """
    return CanonicalDataset(
        units=ds.units,
        assets=new_assets,
        roster=ds.roster,
        srs=ds.srs,
        snapshots=ds.snapshots,
        reqs=ds.reqs,
        cannib_events=ds.cannib_events,
        incidents=ds.incidents,
        tmrs=ds.tmrs,
        dq_defects=ds.dq_defects,
        violations=ds.violations,
        generated_at=ds.generated_at,
        seed=ds.seed,
    )


# ===========================================================================
# GCSS-MC Utilization extract (RD7)
# ===========================================================================


@router.post("/gcss-mc/util")
async def ingest_gcss_mc_util(
    request: Request,
    file: UploadFile = File(...),
    apply: bool = Query(False, description="Apply latest readings to canonical assets (default: dry-run)"),
    confirm: Optional[str] = Query(None, description="Preview token from a prior dry-run"),
):
    """Upload + parse one GCSS-MC utilization extract.

    Same dry-run / apply pattern as the ECP route. The merge target
    here is each Asset's `current_hours / current_miles /
    current_status` — latest reading per asset wins. Stale readings
    against assets that no longer exist in the canonical roster are
    surfaced via `applied_counts.unmatched_rows` so the operator can
    track upstream feed drift.
    """
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    actor_role = require_user_role(user, INGEST_ROLES, action="ingest.gcss_mc_util")
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None

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

    preview_token = _file_token(body)
    rows, report = parse_util(text)

    try:
        ds = get_dataset()
        canonical_assets = list(getattr(ds, "assets", []) or [])
    except Exception:
        canonical_assets = []

    if not apply:
        # Dry-run preview: show how many rows would match without
        # mutating anything. We pass a copy of the asset list to
        # apply_latest_readings to compute counts; the in-place
        # mutation is harmless on the copy because the route doesn't
        # use those copies after.
        # Only the count summary is returned — full mutation happens
        # on apply.
        from copy import copy as _copy
        preview_assets = [_copy(a) for a in canonical_assets]
        _, preview_counts = apply_latest_readings(rows, preview_assets)
        return {
            "report": _util_report_to_dict(report),
            "preview_counts": preview_counts,
            "preview_token": preview_token,
            "merge_target": "asset_current_hours_miles_status",
            "applied": False,
        }

    if confirm != preview_token:
        raise HTTPException(
            status_code=409,
            detail=(
                "Confirm token mismatch. Re-run the dry-run upload, paste the "
                "returned `preview_token` into ?confirm=<token>, and try again."
            ),
        )

    updated_assets, applied_counts = apply_latest_readings(rows, canonical_assets)
    new_ds = _replace_assets(ds, updated_assets)
    swap_dataset(
        new_ds,
        source="ingest.util",
        ingested_by=actor_dodid or actor_role or "ingest",
        ingest_hash=preview_token,
    )

    audit_log(
        kind="ingest.util.apply",
        actor=actor_dodid or actor_role or "system",
        subject_id=preview_token,
        payload={
            "source": "gcss-mc/util",
            "preview_token": preview_token,
            "applied_counts": applied_counts,
            "filename": file.filename,
            "actor_role": actor_role,
        },
    )

    return {
        "report": _util_report_to_dict(report),
        "preview_token": preview_token,
        "merge_target": "asset_current_hours_miles_status",
        "applied": True,
        "applied_counts": applied_counts,
    }


def _util_report_to_dict(report) -> dict:
    return {
        "rows_total": report.rows_total,
        "rows_kept": report.rows_kept,
        "rows_with_warnings": report.rows_with_warnings,
        "rows_missing_asset_id": report.rows_missing_asset_id,
        "rows_missing_date": report.rows_missing_date,
        "rows_with_invalid_readiness": report.rows_with_invalid_readiness,
        "rows_with_unknown_source": report.rows_with_unknown_source,
        "date_parse_failures": report.date_parse_failures,
        "numeric_parse_failures": report.numeric_parse_failures,
        "header_mismatch": report.header_mismatch,
        "header_missing_columns": list(report.header_missing_columns),
        "header_extra_columns": list(report.header_extra_columns),
    }
