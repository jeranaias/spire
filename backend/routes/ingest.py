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

from fastapi import APIRouter, Body, File, Form, HTTPException, Query, Request, UploadFile

from ..integrations.pulse_gcss_ecp_adapter import (
    EXPECTED_HEADER_COLUMNS as ECP_EXPECTED_COLUMNS,
    ParsedAssetRow as ECPParsedAssetRow,
)
from ..integrations.pulse_gcss_ecp_merge import (
    apply_diff,
    compute_diff,
    diff_to_payload,
)
from ..integrations.pulse_gcss_util_adapter import (
    EXPECTED_HEADER_COLUMNS as UTIL_EXPECTED_COLUMNS,
    apply_latest_readings,
)
from ..integrations.sentry_gcss_adapter import (
    EXPECTED_HEADER_COLUMNS as SR_EXPECTED_COLUMNS,
    ingest_sr_header_csv,
)
from ..persistence import log as audit_log
from ..scoping import require_user_role
from ..state import CanonicalDataset, get_dataset, swap_dataset

# UIS pipeline — the new universal ingest path that all routes share.
from ..uis.adapters import get_adapter
from ..uis.pipeline import PipelineRowLimitExceeded, run_pipeline
from ..uis.route_helpers import (
    map_pipeline_report_to_ecp_legacy,
    map_pipeline_report_to_util_legacy,
    to_parsed_asset_rows,
    to_parsed_util_rows,
)


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
            {
                "id": "gcss-mc/sr-header",
                "name": "GCSS-MC SR Header Export",
                "shape": "csv",
                "expected_columns": list(SR_EXPECTED_COLUMNS),
                "writes_to": "service_request_log (dry-run only via this route — full bundle ingest is /api/system/stage-ingest)",
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


def _dataset_state_token(canonical_assets) -> str:
    """A small fingerprint of the canonical asset roster's identity
    set. Used for optimistic-concurrency on apply: dry-run captures
    this, apply checks the current value still matches.

    UIS-25 — without this, two operators applying different files
    in parallel will both swap_dataset() and the second silently
    wipes the first's writes (their diff was computed against a
    pre-state that no longer exists). Returning a stable fingerprint
    lets the apply path 409 if the dataset has moved on since the
    dry-run.

    Cheap: SHA-256 over sorted (asset_id, serial_number, on_hand_qty,
    last_inventory_date) tuples. Sensitive to the columns ECP apply
    actually touches. A 50k-asset roster fingerprints in single-
    digit milliseconds.
    """
    h = hashlib.sha256()
    items = []
    for a in canonical_assets:
        aid = getattr(a, "asset_id", "") or ""
        sn = getattr(a, "serial_number", "") or ""
        oh = str(getattr(a, "on_hand_qty", 0) or 0)
        inv = getattr(a, "last_inventory_date", None)
        inv_s = inv.isoformat() if inv else ""
        items.append(f"{aid}|{sn}|{oh}|{inv_s}")
    items.sort()
    for i in items:
        h.update(i.encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()[:16]


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
    state_token: Optional[str] = Query(
        None,
        description=(
            "Dataset state fingerprint from the prior dry-run. "
            "Required on apply — protects against silent overwrite "
            "when two operators apply concurrently. If the canonical "
            "state has moved since dry-run, apply 409s."
        ),
    ),
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

    # Content-Length pre-check before buffering — UIS-27.
    declared_size = int(request.headers.get("content-length") or 0)
    if declared_size and declared_size > INGEST_FILE_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Declared content-length {declared_size:,} exceeds limit "
                f"{INGEST_FILE_MAX_BYTES:,}. Reject before buffering the upload."
            ),
        )
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
    # UIS pipeline drives the parse — same canonical output, but with
    # automatic encoding detection, smart-quote normalization, and
    # mapping-profile lookup support that the legacy parser didn't
    # have. Output shape converted back to ParsedAssetRow for the
    # diff engine via to_parsed_asset_rows().
    try:
        pipeline_result = run_pipeline(body, get_adapter("gcss-mc/ecp"))
    except PipelineRowLimitExceeded as e:
        raise HTTPException(
            status_code=413,
            detail=f"Row count exceeds pipeline cap {e.limit}. Split the file or raise SPIRE_UIS_MAX_ROWS.",
        )
    rows = to_parsed_asset_rows(pipeline_result)
    legacy_report = map_pipeline_report_to_ecp_legacy(pipeline_result)

    try:
        ds = get_dataset()
        canonical_assets = list(getattr(ds, "assets", []) or [])
    except Exception:
        canonical_assets = []
    diff = compute_diff(rows, canonical_assets)
    current_state_token = _dataset_state_token(canonical_assets)

    # Audit every upload — dry-run included — so the chain has a
    # who-looked-at-what trace independent of whether the operator
    # applied. Auditor can reconstruct intent (someone uploaded a
    # bad file twice and applied neither time = different signal
    # than someone applying once and walking away).
    audit_log(
        kind="ingest.ecp.upload",
        actor=actor_dodid or actor_role or "system",
        subject_id=preview_token,
        payload={
            "source": "gcss-mc/ecp",
            "preview_token": preview_token,
            "state_token": current_state_token,
            "filename": file.filename,
            "actor_role": actor_role,
            "applied": apply,
            "rows_total": pipeline_result.report.rows_total,
            "rows_kept": pipeline_result.report.rows_kept,
            "detected_format": pipeline_result.report.detected_format,
            "detected_encoding": pipeline_result.report.detected_encoding,
            "encoding_low_confidence": pipeline_result.report.encoding_low_confidence,
            "auto_mapper_confidence": pipeline_result.report.auto_mapper_confidence,
            "sanitization_self_hashed": dict(pipeline_result.report.sanitization_self_hashed),
            "diff_counts": diff.counts(),
        },
    )

    if not apply:
        return {
            "report": legacy_report,
            "rows": [_ecp_row_to_dict(r) for r in rows],
            "preview": diff_to_payload(diff),
            "preview_token": preview_token,
            "state_token": current_state_token,
            "merge_target": "asset_roster",
            "applied": False,
            "pipeline_meta": {
                "detected_format": pipeline_result.report.detected_format,
                "detected_encoding": pipeline_result.report.detected_encoding,
                "encoding_low_confidence": pipeline_result.report.encoding_low_confidence,
                "auto_mapper_confidence": pipeline_result.report.auto_mapper_confidence,
                "column_map": pipeline_result.report.column_map,
            },
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
    # UIS-25 — state-token check protects against parallel-apply race.
    # If the canonical state moved since dry-run (another operator
    # applied something between this operator's dry-run and apply),
    # 409 with a clear message rather than silently overwriting
    # their changes.
    if state_token is not None and state_token != current_state_token:
        raise HTTPException(
            status_code=409,
            detail=(
                "Dataset state has changed since your dry-run. Another "
                "operator may have applied changes. Re-run the dry-run "
                "to see the current state, then re-apply. (state_token "
                f"expected={state_token!r}, current={current_state_token!r})"
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

    # RD6c — flag stale assets as needs_verification so the operator
    # surface (`GET /api/ingest/stale`) lists them for review without
    # auto-deleting. Stale = in canonical, not in this file.
    stale_ids = {s.asset_id for s in diff.stale}
    if stale_ids:
        for a in new_assets:
            if getattr(a, "asset_id", "") in stale_ids and hasattr(a, "needs_verification"):
                a.needs_verification = True

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
        "report": legacy_report,
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

    # Content-Length pre-check before buffering — UIS-27.
    declared_size = int(request.headers.get("content-length") or 0)
    if declared_size and declared_size > INGEST_FILE_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Declared content-length {declared_size:,} exceeds limit "
                f"{INGEST_FILE_MAX_BYTES:,}. Reject before buffering the upload."
            ),
        )
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
    try:
        pipeline_result = run_pipeline(body, get_adapter("gcss-mc/util"))
    except PipelineRowLimitExceeded as e:
        raise HTTPException(
            status_code=413,
            detail=f"Row count exceeds pipeline cap {e.limit}. Split the file or raise SPIRE_UIS_MAX_ROWS.",
        )
    rows = to_parsed_util_rows(pipeline_result)
    legacy_report = map_pipeline_report_to_util_legacy(pipeline_result)

    try:
        ds = get_dataset()
        canonical_assets = list(getattr(ds, "assets", []) or [])
    except Exception:
        canonical_assets = []

    # Audit every upload (dry-run + apply, see ECP route comment).
    audit_log(
        kind="ingest.util.upload",
        actor=actor_dodid or actor_role or "system",
        subject_id=preview_token,
        payload={
            "source": "gcss-mc/util",
            "preview_token": preview_token,
            "filename": file.filename,
            "actor_role": actor_role,
            "applied": apply,
            "rows_total": pipeline_result.report.rows_total,
            "rows_kept": pipeline_result.report.rows_kept,
            "detected_format": pipeline_result.report.detected_format,
            "detected_encoding": pipeline_result.report.detected_encoding,
            "encoding_low_confidence": pipeline_result.report.encoding_low_confidence,
            "auto_mapper_confidence": pipeline_result.report.auto_mapper_confidence,
        },
    )

    if not apply:
        # Dry-run preview: show how many rows would match without
        # mutating anything. Shallow-copy assets so apply_latest_readings'
        # in-place writes don't leak into the singleton.
        from copy import copy as _copy
        preview_assets = [_copy(a) for a in canonical_assets]
        _, preview_counts = apply_latest_readings(rows, preview_assets)
        return {
            "report": legacy_report,
            "preview_counts": preview_counts,
            "preview_token": preview_token,
            "merge_target": "asset_current_hours_miles_status",
            "applied": False,
            "pipeline_meta": {
                "detected_format": pipeline_result.report.detected_format,
                "detected_encoding": pipeline_result.report.detected_encoding,
                "encoding_low_confidence": pipeline_result.report.encoding_low_confidence,
                "auto_mapper_confidence": pipeline_result.report.auto_mapper_confidence,
                "column_map": pipeline_result.report.column_map,
            },
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
        "report": legacy_report,
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


# ===========================================================================
# Stale-asset resolution (RD6c)
# ===========================================================================


VALID_STALE_ACTIONS = frozenset({"remove", "confirm", "defer"})


@router.get("/stale")
async def list_stale_assets(request: Request):
    """List canonical assets currently flagged needs_verification."""
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    require_user_role(user, INGEST_ROLES, action="ingest.stale.list")

    try:
        ds = get_dataset()
        assets = list(getattr(ds, "assets", []) or [])
    except Exception:
        assets = []

    stale = [
        {
            "asset_id": getattr(a, "asset_id", ""),
            "serial_number": getattr(a, "serial_number", ""),
            "tamcn": getattr(a, "tamcn", ""),
            "unit_uic": getattr(a, "unit_uic", ""),
            "unit_name": getattr(a, "unit_name", ""),
            "nomenclature": getattr(a, "nomenclature", ""),
            "current_status": getattr(a, "current_status", ""),
        }
        for a in assets
        if getattr(a, "needs_verification", False)
    ]
    return {"stale": stale, "count": len(stale)}


@router.post("/stale/resolve")
async def resolve_stale_assets(
    request: Request,
    payload: dict = Body(...),
):
    """Resolve stale-flagged assets in bulk.

    Body shape::

        {
          "resolutions": [
            {"asset_id": "M-21670-...", "action": "remove",  "note": "EOR'd"},
            {"asset_id": "M-26300-...", "action": "confirm"},
            {"asset_id": "M-22100-...", "action": "defer",   "note": "ECP late"}
          ]
        }

    Actions:
      * `remove`  — drop the asset from the canonical roster
      * `confirm` — clear `needs_verification` (asset is real, file was incomplete)
      * `defer`   — keep flagged; just record the operator note
    """
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    actor_role = require_user_role(user, INGEST_ROLES, action="ingest.stale.resolve")
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None

    resolutions = payload.get("resolutions") if isinstance(payload, dict) else None
    if not isinstance(resolutions, list) or not resolutions:
        raise HTTPException(
            status_code=400,
            detail="Body must contain a non-empty `resolutions` array.",
        )

    try:
        ds = get_dataset()
    except Exception:
        raise HTTPException(status_code=503, detail="Dataset unavailable.")

    by_id = {getattr(a, "asset_id", ""): a for a in (ds.assets or [])}

    counts = {"remove": 0, "confirm": 0, "defer": 0, "not_found": 0, "invalid_action": 0}
    outcomes: List[dict] = []
    to_remove: set = set()

    for res in resolutions:
        if not isinstance(res, dict):
            counts["invalid_action"] += 1
            continue
        asset_id = (res.get("asset_id") or "").strip()
        action = (res.get("action") or "").strip().lower()
        note = (res.get("note") or "").strip()
        if not asset_id or action not in VALID_STALE_ACTIONS:
            counts["invalid_action"] += 1
            outcomes.append({"asset_id": asset_id, "action": action, "outcome": "invalid"})
            continue
        asset = by_id.get(asset_id)
        if asset is None:
            counts["not_found"] += 1
            outcomes.append({"asset_id": asset_id, "action": action, "outcome": "not_found"})
            continue

        if action == "remove":
            to_remove.add(asset_id)
            counts["remove"] += 1
            outcomes.append({"asset_id": asset_id, "action": action, "outcome": "queued_remove"})
        elif action == "confirm":
            if hasattr(asset, "needs_verification"):
                asset.needs_verification = False
            counts["confirm"] += 1
            outcomes.append({"asset_id": asset_id, "action": action, "outcome": "cleared_flag"})
        elif action == "defer":
            counts["defer"] += 1
            outcomes.append({"asset_id": asset_id, "action": action, "outcome": "deferred"})

        audit_log(
            kind="ingest.stale.resolve",
            actor=actor_dodid or actor_role or "system",
            subject_id=asset_id,
            payload={"action": action, "note": note, "actor_role": actor_role},
        )

    if to_remove:
        new_assets = [a for a in ds.assets if getattr(a, "asset_id", "") not in to_remove]
        new_ds = _replace_assets(ds, new_assets)
        swap_dataset(
            new_ds,
            source="ingest.stale.remove",
            ingested_by=actor_dodid or actor_role or "ingest",
            ingest_hash=None,
        )

    return {"counts": counts, "outcomes": outcomes}


# ===========================================================================
# GCSS-MC SR header (RD8) — dry-run analyzer
# ===========================================================================


@router.post("/gcss-mc/sr-header")
async def ingest_gcss_mc_sr_header(
    request: Request,
    file: UploadFile = File(...),
    cm_only: bool = Query(True, description="Filter to Maintenance - CM rows (matches SPIRE's posture)"),
):
    """Upload + parse one GCSS-MC SR header export.

    This route is dry-run only. It runs the existing
    `ingest_sr_header_csv` adapter and returns the IngestReport so
    the operator can sanity-check the file (sanitization warnings,
    schema mismatch, defect-code normalization counts) before pushing
    it through the existing 3-CSV stage-ingest flow at
    /api/system/stage-ingest, which is the canonical write path for a
    full GCSS-MC bundle (header + sr_parts + due_in).

    The choice to keep apply out of /api/ingest/gcss-mc/sr-header
    is deliberate: writing SRs in isolation (without the parts +
    due-in joins) leaves dataset.lifecycle.ServiceRequest with
    half-populated fields, which the PULSE risk model would then
    score against. The single-file analyzer is for "is this file
    sane?"; the full bundle ingest covers actual writes.
    """
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    require_user_role(user, INGEST_ROLES, action="ingest.gcss_mc_sr_header")

    # Content-Length pre-check before buffering — UIS-27.
    declared_size = int(request.headers.get("content-length") or 0)
    if declared_size and declared_size > INGEST_FILE_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Declared content-length {declared_size:,} exceeds limit "
                f"{INGEST_FILE_MAX_BYTES:,}. Reject before buffering the upload."
            ),
        )
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

    report = ingest_sr_header_csv(text, cm_only=cm_only)
    return {
        "report": _sr_report_to_dict(report),
        "preview_rows": [_sr_row_to_dict(r) for r in report.rows[:10]],
        "merge_target": "service_request_log",
        "applied": False,
        "applied_pointer": "/api/system/stage-ingest (full 3-CSV bundle)",
    }


def _sr_report_to_dict(report) -> dict:
    return {
        "rows_total": report.rows_total,
        "rows_kept": report.rows_kept,
        "rows_filtered_pmcs": report.rows_filtered_pmcs,
        "rows_with_warnings": report.rows_with_warnings,
        "defect_code_trailing_period_normalized": report.defect_code_trailing_period_normalized,
        "date_parse_failures": report.date_parse_failures,
        "unsanitized_field_counts": dict(report.unsanitized_field_counts or {}),
        "schema_warnings": list(report.schema_warnings or []),
    }


def _sr_row_to_dict(row) -> dict:
    return {
        "sr_number": getattr(row, "sr_number", ""),
        "service_request_type": getattr(row, "service_request_type", ""),
        "defect_code_primary": getattr(row, "defect_code_primary", ""),
        "defect_code_secondary": getattr(row, "defect_code_secondary", ""),
        "problem_summary": (getattr(row, "problem_summary", "") or "")[:200],
        "echelon_of_maint": getattr(row, "echelon_of_maint", ""),
        "tamcn": getattr(row, "tamcn", ""),
        "priority": getattr(row, "priority", ""),
        "unit_uic_hashed": getattr(row, "unit_uic_hashed", ""),
        "unit_uic_source": getattr(row, "unit_uic_source", ""),
        "warnings": list(getattr(row, "_warnings", []) or []),
    }
