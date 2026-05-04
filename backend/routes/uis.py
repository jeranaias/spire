"""Universal Ingest Service (UIS) — generic routes.

Five endpoints make the UIS operator-grade:

  GET  /api/uis/adapters
      List registered AdapterSpecs the UI can target.

  POST /api/uis/upload
      Generic upload + dry-run preview. Body: file + ?adapter_id=X
      [&profile_id=Y][&apply=1&confirm=Z]. Single code path for ECP /
      UTIL / SR-header / any future adapter.

  POST /api/uis/map
      LLM-assisted column-mapping proposal. Body: file + ?adapter_id=X.
      Returns the auto-baseline + LLM-augmented proposal so the UI's
      column editor can render with confidence scores + reasoning.

  /api/uis/profiles ...
      MappingProfile CRUD: list, fetch, create, update, delete.
      Operator confirms a mapping in the UI → POSTs here → next file
      with same (source_id, unit) auto-applies.

All routes are gated on SPIRE_INGEST_ENABLED + INGEST_ROLES, same as
the existing /api/ingest/* surface.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, File, HTTPException, Query, Request, UploadFile

from ..persistence import log as audit_log
from ..scoping import require_user_role
from ..uis.adapters import ADAPTERS, AdapterSpec, get_adapter
from ..uis.formats import detect_format, stream_rows
from ..uis.mapping import (
    MappingProfile,
    create_profile,
    delete_profile,
    find_profile,
    get_profile,
    list_profiles,
    update_profile,
)
from ..uis.mapping.llm_map import propose_mapping_with_llm
from ..uis.normalize import decode_bytes, normalize_text
from ..uis.pipeline import (
    ALLOWED_CELL_TRANSFORMS,
    PipelineRowLimitExceeded,
    required_columns_unmapped,
    run_pipeline,
)
from ..uis.writers import get_writer, has_writer
from ..uis.audited_swap import audited_swap, set_audit_func as _set_audited_swap_audit
from ..state import get_dataset, swap_dataset

# Wire the audited_swap audit emitter to the persistence audit log
# at module import. Tests override via set_audit_func.
_set_audited_swap_audit(audit_log)


log = logging.getLogger(__name__)

router = APIRouter()


INGEST_ROLES = frozenset({"data_custodian", "security_manager"})
INGEST_FILE_MAX_BYTES = 256 * 1024 * 1024


def _ingest_enabled() -> bool:
    raw = os.environ.get("SPIRE_INGEST_ENABLED", "")
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _require_ingest_enabled():
    if not _ingest_enabled():
        raise HTTPException(
            status_code=503,
            detail=(
                "UIS is disabled on this box. Set SPIRE_INGEST_ENABLED=1 "
                "in the environment and restart the backend to enable it."
            ),
        )


def _file_token(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()[:32]


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _adapter_to_dict(spec: AdapterSpec) -> dict:
    """Serialize an AdapterSpec for the UI."""
    return {
        "id": spec.id,
        "name": spec.name or spec.id,
        "version": spec.version,
        "target_entity": spec.target_entity,
        "description": spec.description,
        "primary_key": list(spec.primary_key),
        "fallback_key": list(spec.fallback_key),
        "auth_roles": list(spec.auth_roles),
        "canonical_columns": [
            {
                "name": c.name,
                "type": c.type,
                "required": c.required,
                "sensitive": c.sensitive,
                "description": c.description,
                "source_aliases": list(c.source_aliases),
                "enum_aliases": dict(c.enum_aliases) if c.enum_aliases else None,
            }
            for c in spec.canonical_columns
        ],
        "constraints": [
            {
                "kind": c.kind,
                "fields": list(c.fields),
                "message": c.message,
            }
            for c in spec.constraints
        ],
    }


# ---------------------------------------------------------------------------
# GET /api/uis/adapters
# ---------------------------------------------------------------------------


@router.get("/adapters")
async def list_uis_adapters(request: Request):
    """List registered AdapterSpecs.

    Open to any authenticated role so the UI can show the operator
    what's available before they upload. The full spec is returned —
    canonical column types, descriptions, source aliases, constraints.
    """
    return {
        "enabled": _ingest_enabled(),
        "adapters": [_adapter_to_dict(spec) for spec in ADAPTERS.values()],
    }


# ---------------------------------------------------------------------------
# POST /api/uis/upload
# ---------------------------------------------------------------------------


@router.post("/upload")
async def uis_upload(
    request: Request,
    file: UploadFile = File(...),
    adapter_id: str = Query(..., description="Registered adapter id, e.g. 'gcss-mc/ecp'"),
    profile_id: Optional[str] = Query(None, description="Confirmed MappingProfile id to apply"),
    apply: bool = Query(False, description="Apply to canonical (default: dry-run only)"),
    confirm: Optional[str] = Query(None, description="preview_token from a prior dry-run"),
    state_token: Optional[str] = Query(
        None,
        description=(
            "Dataset state fingerprint from the prior dry-run. "
            "Required on apply for parallel-apply protection."
        ),
    ),
):
    """Generic UIS upload — drives any adapter through one code path.

    Three modes:

      * Dry-run (default): parse + run pipeline + return canonical rows
        + the parse report + the column map that fired + the
        preview_token + state_token.
      * Apply (``?apply=1&confirm=<token>&state_token=<token>``):
        dispatches through the EntityWriter registered for the
        adapter's id. Validates the confirm token (anti-fat-finger),
        validates state_token (parallel-apply protection), refuses
        when conflicts exist, swaps the dataset, fans out per-row
        audit entries.
      * No-writer adapters (read-only sources): apply returns 501
        with a clear pointer.

    Profile lookup precedence:
      1. ``profile_id`` query arg if supplied
      2. ``find_profile(adapter_id, unit=current_user.unit)`` if any
      3. None (auto-mapper baseline)
    """
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    actor_role = require_user_role(user, INGEST_ROLES, action=f"uis.upload:{adapter_id}")
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None
    actor_unit = (user or {}).get("unit") if isinstance(user, dict) else None

    # Resolve adapter
    try:
        adapter = get_adapter(adapter_id)
    except KeyError:
        raise HTTPException(
            status_code=404,
            detail=f"Unknown adapter {adapter_id!r}. Known: {sorted(ADAPTERS.keys())}",
        )

    # Pre-check Content-Length BEFORE buffering 10GB into memory.
    # The Starlette UploadFile API has already read enough of the
    # request to know its declared size; we trust it and fail-fast.
    declared_size = int(request.headers.get("content-length") or 0)
    if declared_size and declared_size > INGEST_FILE_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Declared content-length {declared_size:,} exceeds limit "
                f"{INGEST_FILE_MAX_BYTES:,}. Reject before buffering the upload."
            ),
        )
    # Read body
    body = await file.read()
    if len(body) > INGEST_FILE_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({len(body):,} bytes); max is {INGEST_FILE_MAX_BYTES:,} bytes.",
        )

    # Resolve mapping profile
    profile: Optional[MappingProfile] = None
    if profile_id:
        profile = get_profile(profile_id)
        if profile is None:
            raise HTTPException(status_code=404, detail=f"profile_id {profile_id!r} not found")
    else:
        # Implicit: most-specific profile for this adapter + caller's unit
        profile = find_profile(source_id=adapter_id, unit=actor_unit)

    # Run pipeline
    preview_token = _file_token(body)
    try:
        pipeline_result = run_pipeline(body, adapter, profile=profile)
    except PipelineRowLimitExceeded as e:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Row count exceeds pipeline cap {e.limit}. Split the file "
                f"or raise SPIRE_UIS_MAX_ROWS."
            ),
        )
    # Phase 3 — when a writer is registered for this adapter, run
    # the dry-run preview now so the response includes a diff +
    # state_token regardless of apply mode. Adapters without a
    # writer skip this step (read-only).
    writer = None
    writer_diff = None
    current_state_token: Optional[str] = None
    try:
        ds = get_dataset()
    except Exception:
        ds = None
    if has_writer(adapter_id):
        writer = get_writer(adapter_id)
        try:
            writer_diff = writer.preview(pipeline_result, ds)
            current_state_token = writer.state_token(ds)
        except Exception as e:  # noqa: BLE001
            log.exception("Writer preview failed for %s", adapter_id)
            raise HTTPException(
                status_code=500,
                detail=f"Writer preview failed: {e}",
            )

    # Audit every upload — dry-run included — so the chain
    # captures who looked at what file when, regardless of whether
    # they applied. Distinct kind so audit filters can separate
    # generic-route uploads from adapter-specific routes.
    audit_log(
        kind="uis.upload",
        actor=actor_dodid or actor_role or "system",
        subject_id=preview_token,
        payload={
            "adapter_id": adapter_id,
            "preview_token": preview_token,
            "state_token": current_state_token,
            "filename": file.filename,
            "actor_role": actor_role,
            "applied": apply,
            "profile_id": profile.profile_id if profile else None,
            "rows_total": pipeline_result.report.rows_total,
            "rows_kept": pipeline_result.report.rows_kept,
            "detected_format": pipeline_result.report.detected_format,
            "detected_encoding": pipeline_result.report.detected_encoding,
            "encoding_low_confidence": pipeline_result.report.encoding_low_confidence,
            "auto_mapper_confidence": pipeline_result.report.auto_mapper_confidence,
            "writer_counts": writer_diff.counts if writer_diff else None,
        },
    )

    payload: Dict[str, Any] = {
        "adapter_id": adapter_id,
        "target_entity": adapter.target_entity,
        "rows_total": pipeline_result.report.rows_total,
        "rows_kept": pipeline_result.report.rows_kept,
        "report": pipeline_result.report.to_dict(),
        "rows": pipeline_result.rows[:50],  # sample only
        "preview_token": preview_token,
        "state_token": current_state_token,
        "applied": False,
        "profile_id": profile.profile_id if profile else None,
        "has_writer": writer is not None,
        "diff": writer_diff.payload if writer_diff else None,
        "diff_counts": writer_diff.counts if writer_diff else None,
    }

    if not apply:
        return payload

    # ---- Apply path ----
    if writer is None:
        raise HTTPException(
            status_code=501,
            detail=(
                f"Adapter {adapter_id!r} has no writer registered — "
                f"dry-run only. Adapters with writers: "
                f"{sorted(_writers_for_adapters())}."
            ),
        )

    if confirm != preview_token:
        raise HTTPException(
            status_code=409,
            detail=(
                "Confirm token mismatch. Re-run the dry-run upload, paste the "
                "returned `preview_token` into ?confirm=<token>, and try again. "
                "This guard prevents fat-finger applies of stale diffs."
            ),
        )

    if state_token is not None and state_token != current_state_token:
        raise HTTPException(
            status_code=409,
            detail=(
                "Dataset state has changed since your dry-run. Another "
                "operator may have applied changes. Re-run the dry-run "
                f"and re-apply. (state_token expected={state_token!r}, "
                f"current={current_state_token!r})"
            ),
        )

    if writer_diff.has_conflicts():
        raise HTTPException(
            status_code=409,
            detail=(
                f"{len(writer_diff.conflicts)} conflict row(s) must be "
                "resolved before apply."
            ),
        )

    # P4.10 — refuse apply when a required canonical field is
    # unmapped. Applying with a missing required field would write
    # half-populated rows that later queries would misinterpret;
    # the operator needs to fix the file shape or update the
    # mapping profile before this can land.
    missing_required = required_columns_unmapped(pipeline_result, adapter)
    if missing_required:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Required canonical fields are unmapped: {missing_required}. "
                "The file is missing source columns for fields the adapter "
                "requires. Re-export with the missing columns, or update the "
                "mapping profile to point them at existing columns."
            ),
        )

    apply_result = writer.apply(writer_diff, ds)
    # P6.10 — two-phase audited swap. attempt entry lands BEFORE
    # the swap, commit entry lands AFTER. Process death between
    # the two leaves an orphaned attempt that find_orphaned_attempts
    # surfaces for operator reconciliation.
    with audited_swap(
        kind="uis.apply",
        actor=actor_dodid or actor_role or "system",
        subject_id=preview_token,
        payload={
            "adapter_id": adapter_id,
            "target_entity": adapter.target_entity,
            "preview_token": preview_token,
            "counts": apply_result.summary_counts,
            "filename": file.filename,
            "actor_role": actor_role,
        },
    ):
        swap_dataset(
            apply_result.new_dataset,
            source=f"uis.{adapter_id}",
            ingested_by=actor_dodid or actor_role or "ingest",
            ingest_hash=preview_token,
        )
    for row_audit in apply_result.audit_rows:
        audit_log(
            kind=row_audit["kind"],
            actor=actor_dodid or actor_role or "system",
            subject_id=row_audit["subject_id"],
            payload={**row_audit["payload"], "preview_token": preview_token},
        )

    return {
        **payload,
        "applied": True,
        "applied_counts": apply_result.summary_counts,
    }


def _writers_for_adapters() -> list:
    """Helper for the 501 message — list known writer adapter_ids."""
    from ..uis.writers import WRITERS
    return list(WRITERS.keys())


# ---------------------------------------------------------------------------
# POST /api/uis/map
# ---------------------------------------------------------------------------


@router.post("/map")
async def uis_propose_mapping(
    request: Request,
    file: UploadFile = File(...),
    adapter_id: str = Query(...),
    use_llm: bool = Query(True, description="Invoke the LLM mapper for unmapped fields"),
):
    """Propose a column mapping for an uploaded file.

    Returns the merged auto + LLM proposal: per-source-column
    canonical assignment, per-field confidence (0..1), per-field
    reasoning when the LLM provided it, and the unmapped tails on
    both sides so the UI's column editor can render them as
    drag-targets.

    Does NOT run the full pipeline — just the header + sample-row
    parse + mapping inference. Cheaper for the operator who just
    wants to set up a profile for a new file shape.
    """
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    actor_role = require_user_role(user, INGEST_ROLES, action=f"uis.map:{adapter_id}")
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None

    try:
        adapter = get_adapter(adapter_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown adapter {adapter_id!r}")

    declared_size = int(request.headers.get("content-length") or 0)
    if declared_size and declared_size > INGEST_FILE_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Declared content-length {declared_size:,} exceeds limit "
                f"{INGEST_FILE_MAX_BYTES:,}."
            ),
        )
    body = await file.read()
    if len(body) > INGEST_FILE_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({len(body):,} bytes); max is {INGEST_FILE_MAX_BYTES:,} bytes.",
        )

    # Decode + detect format + sample first 5 rows
    text, encoding = decode_bytes(body)
    fmt = detect_format(body[:4096])
    if fmt == "unknown":
        raise HTTPException(
            status_code=400,
            detail="Could not detect format. Supported: csv / tsv / jsonl / xlsx.",
        )
    text = normalize_text(text)
    raw_for_stream = text.encode("utf-8") if fmt in {"csv", "tsv", "jsonl"} else body
    try:
        rows = list(stream_rows(raw_for_stream, fmt))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Stream error: {e}")
    preview_token = _file_token(body)
    if not rows:
        # UIS-33 — even the empty-file path gets an audit entry. The
        # LLM mapper isn't invoked here, but the operator's intent
        # ("look at this file") is still a recorded event.
        audit_log(
            kind="uis.map",
            actor=actor_dodid or actor_role or "system",
            subject_id=preview_token,
            payload={
                "adapter_id": adapter_id,
                "filename": file.filename,
                "actor_role": actor_role,
                "use_llm": use_llm,
                "llm_invoked": False,
                "detected_format": fmt,
                "detected_encoding": encoding,
                "source_columns_count": 0,
                "rows_sampled": 0,
            },
        )
        return {
            "adapter_id": adapter_id,
            "detected_format": fmt,
            "detected_encoding": encoding,
            "source_columns": [],
            "column_map": {},
            "confidence_per_field": {},
            "reasoning_per_field": {},
            "unmapped_canonical": [c.name for c in adapter.canonical_columns],
            "unmapped_source": [],
            "llm_invoked": False,
        }

    source_columns = list(rows[0].keys())
    sample_rows = rows[:5]

    if use_llm:
        proposal = await propose_mapping_with_llm(
            source_columns, adapter, sample_rows=sample_rows,
        )
        # UIS-33 — audit captures the LLM call. Sample rows are
        # PII-sanitized before the LLM sees them (UIS-17), but the
        # LLM is still an external dependency that touched the file
        # — the audit chain needs to know who, what, when.
        audit_log(
            kind="uis.map",
            actor=actor_dodid or actor_role or "system",
            subject_id=preview_token,
            payload={
                "adapter_id": adapter_id,
                "filename": file.filename,
                "actor_role": actor_role,
                "use_llm": True,
                "llm_invoked": proposal.llm_invoked,
                "llm_failed": proposal.llm_failed,
                "llm_failure_reason": proposal.llm_failure_reason,
                "detected_format": fmt,
                "detected_encoding": encoding,
                "source_columns_count": len(source_columns),
                "rows_sampled": len(sample_rows),
                "auto_baseline_confidence": round(proposal.auto_baseline_confidence, 3),
            },
        )
        return {
            "adapter_id": adapter_id,
            "detected_format": fmt,
            "detected_encoding": encoding,
            "source_columns": source_columns,
            "column_map": dict(proposal.column_map),
            "confidence_per_field": dict(proposal.confidence_per_field),
            "reasoning_per_field": dict(proposal.reasoning_per_field),
            "unmapped_canonical": list(proposal.unmapped_canonical),
            "unmapped_source": list(proposal.unmapped_source),
            "llm_invoked": proposal.llm_invoked,
            "llm_failed": proposal.llm_failed,
            "llm_failure_reason": proposal.llm_failure_reason,
            "auto_baseline_confidence": round(proposal.auto_baseline_confidence, 3),
        }
    # Deterministic-only path
    from ..uis.mapping.auto_map import propose_mapping
    auto = propose_mapping(source_columns, adapter)
    audit_log(
        kind="uis.map",
        actor=actor_dodid or actor_role or "system",
        subject_id=preview_token,
        payload={
            "adapter_id": adapter_id,
            "filename": file.filename,
            "actor_role": actor_role,
            "use_llm": False,
            "llm_invoked": False,
            "detected_format": fmt,
            "detected_encoding": encoding,
            "source_columns_count": len(source_columns),
            "rows_sampled": 0,
            "auto_baseline_confidence": round(auto.average_confidence(), 3),
        },
    )
    return {
        "adapter_id": adapter_id,
        "detected_format": fmt,
        "detected_encoding": encoding,
        "source_columns": source_columns,
        "column_map": dict(auto.column_map),
        "confidence_per_field": dict(auto.confidence_per_field),
        "reasoning_per_field": {},
        "unmapped_canonical": list(auto.unmapped_canonical),
        "unmapped_source": list(auto.unmapped_source),
        "llm_invoked": False,
        "auto_baseline_confidence": round(auto.average_confidence(), 3),
    }


# ---------------------------------------------------------------------------
# /api/uis/profiles ...
# ---------------------------------------------------------------------------


def _profile_to_dict(p: MappingProfile) -> dict:
    return p.to_dict()


def _validate_cell_transforms(
    cell_transforms: Any,
    canonical_fields: set,
) -> Dict[str, str]:
    """UIS-36 — validate the optional cell_transforms dict.

    Each key must be a known canonical field on the adapter; each
    value must be a recognized transform id. Returns the cleaned
    dict (empty when not provided). Raises HTTPException(400) on
    any violation so a malformed POST/PUT is rejected before the
    profile lands in SQLite — saved garbage is much harder to
    diagnose than a 400 at the boundary.
    """
    if cell_transforms is None or cell_transforms == {}:
        return {}
    if not isinstance(cell_transforms, dict):
        raise HTTPException(
            status_code=400,
            detail="cell_transforms must be a dict of canonical_field → transform_id",
        )
    bad_fields = [
        k for k in cell_transforms.keys() if k not in canonical_fields
    ]
    if bad_fields:
        raise HTTPException(
            status_code=400,
            detail=(
                f"cell_transforms keys not in adapter spec: {sorted(bad_fields)}. "
                f"Each key must be a canonical field name."
            ),
        )
    bad_ids = [
        v for v in cell_transforms.values()
        if v not in ALLOWED_CELL_TRANSFORMS
    ]
    if bad_ids:
        raise HTTPException(
            status_code=400,
            detail=(
                f"cell_transforms ids not recognized: {sorted(set(bad_ids))}. "
                f"Allowed: {sorted(ALLOWED_CELL_TRANSFORMS)}."
            ),
        )
    return {str(k): str(v) for k, v in cell_transforms.items()}


@router.get("/profiles")
async def uis_list_profiles(
    request: Request,
    source_id: Optional[str] = Query(None),
):
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    require_user_role(user, INGEST_ROLES, action="uis.profiles.list")
    profiles = list_profiles(source_id=source_id)
    return {"profiles": [_profile_to_dict(p) for p in profiles]}


@router.get("/profiles/{profile_id:path}")
async def uis_get_profile(profile_id: str, request: Request):
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    require_user_role(user, INGEST_ROLES, action=f"uis.profiles.get:{profile_id}")
    p = get_profile(profile_id)
    if p is None:
        raise HTTPException(status_code=404, detail=f"profile {profile_id!r} not found")
    return _profile_to_dict(p)


@router.post("/profiles")
async def uis_create_profile(request: Request, payload: dict = Body(...)):
    """Create a new MappingProfile.

    Body shape::
        {
          "profile_id": "3d-mlr/gcss-mc-ecp/v2026-04",
          "source_id": "gcss-mc/ecp",
          "unit": "3d MLR",            // optional
          "source_version": "2026-04", // optional
          "column_map": { "TAMCN_Code": "tamcn", ... },
          "operator_notes": "...",
          "confirm": true              // sets confirmed_at
        }

    Validates: adapter_id is registered, every canonical_field in
    column_map exists on the spec, no duplicate canonical-field
    targets.
    """
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    require_user_role(user, INGEST_ROLES, action="uis.profiles.create")
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None

    profile_id = (payload.get("profile_id") or "").strip()
    source_id = (payload.get("source_id") or "").strip()
    column_map = payload.get("column_map") or {}
    if not profile_id or not source_id or not isinstance(column_map, dict):
        raise HTTPException(
            status_code=400,
            detail="profile_id, source_id, and column_map (dict) are required.",
        )
    try:
        adapter = get_adapter(source_id)
    except KeyError:
        raise HTTPException(status_code=400, detail=f"Unknown source_id {source_id!r}")
    canonical_fields = set(adapter.field_names())
    # Reject empty source-side keys outright — they silently drop at
    # apply (dict.get on "") and the operator gets no signal.
    empty_keys = [k for k in column_map.keys() if not str(k).strip()]
    if empty_keys:
        raise HTTPException(
            status_code=400,
            detail="column_map has empty source-side keys; every key must be a non-blank source column name.",
        )
    # Reject empty / non-string canonical targets too.
    empty_targets = [
        f"{k!r}" for k, v in column_map.items() if not str(v).strip()
    ]
    if empty_targets:
        raise HTTPException(
            status_code=400,
            detail=f"column_map has empty canonical targets for keys {empty_targets}.",
        )
    bad_targets = [v for v in column_map.values() if v not in canonical_fields]
    if bad_targets:
        raise HTTPException(
            status_code=400,
            detail=f"column_map targets not in adapter spec: {sorted(set(bad_targets))}",
        )
    target_counts: Dict[str, int] = {}
    for v in column_map.values():
        target_counts[v] = target_counts.get(v, 0) + 1
    dupes = [k for k, v in target_counts.items() if v > 1]
    if dupes:
        raise HTTPException(
            status_code=400,
            detail=f"column_map has duplicate canonical targets: {sorted(dupes)}",
        )

    cell_transforms = _validate_cell_transforms(
        payload.get("cell_transforms"), canonical_fields,
    )

    confirmed_at = _utc_iso() if payload.get("confirm") else None
    profile = MappingProfile(
        profile_id=profile_id,
        source_id=source_id,
        unit=(payload.get("unit") or None) or None,
        source_version=(payload.get("source_version") or None) or None,
        column_map={str(k): str(v) for k, v in column_map.items()},
        cell_transforms=cell_transforms,
        operator_notes=(payload.get("operator_notes") or "").strip(),
        created_by=actor_dodid or "",
        created_at=_utc_iso(),
        confirmed_at=confirmed_at,
        confidence=1.0 if confirmed_at else 0.5,
    )
    try:
        create_profile(profile)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=409, detail=f"Could not create profile: {e}")

    audit_log(
        kind="uis.profiles.create",
        actor=actor_dodid or "system",
        subject_id=profile_id,
        payload={
            "source_id": source_id,
            "unit": profile.unit,
            "confirmed": bool(confirmed_at),
            "column_map_size": len(profile.column_map),
        },
    )
    return _profile_to_dict(profile)


@router.put("/profiles/{profile_id:path}")
async def uis_update_profile(profile_id: str, request: Request, payload: dict = Body(...)):
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    require_user_role(user, INGEST_ROLES, action=f"uis.profiles.update:{profile_id}")
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None

    existing = get_profile(profile_id)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"profile {profile_id!r} not found")

    column_map = payload.get("column_map", existing.column_map)
    if not isinstance(column_map, dict):
        raise HTTPException(status_code=400, detail="column_map must be a dict")
    try:
        adapter = get_adapter(existing.source_id)
    except KeyError:
        raise HTTPException(status_code=500, detail="adapter for stored profile no longer registered")
    # UIS-32 — mirror the same validation gauntlet as create_profile.
    # Without it, a clean POSTed profile could be PUT into an invalid
    # state (empty keys silently drop at apply, duplicate targets
    # produce a "last write wins" surprise on the canonical row).
    empty_keys = [k for k in column_map.keys() if not str(k).strip()]
    if empty_keys:
        raise HTTPException(
            status_code=400,
            detail="column_map has empty source-side keys; every key must be a non-blank source column name.",
        )
    empty_targets = [
        f"{k!r}" for k, v in column_map.items() if not str(v).strip()
    ]
    if empty_targets:
        raise HTTPException(
            status_code=400,
            detail=f"column_map has empty canonical targets for keys {empty_targets}.",
        )
    canonical_fields = set(adapter.field_names())
    bad_targets = [v for v in column_map.values() if v not in canonical_fields]
    if bad_targets:
        raise HTTPException(
            status_code=400,
            detail=f"column_map targets not in adapter spec: {sorted(set(bad_targets))}",
        )
    target_counts: Dict[str, int] = {}
    for v in column_map.values():
        target_counts[v] = target_counts.get(v, 0) + 1
    dupes = [k for k, v in target_counts.items() if v > 1]
    if dupes:
        raise HTTPException(
            status_code=400,
            detail=f"column_map has duplicate canonical targets: {sorted(dupes)}",
        )

    if "cell_transforms" in payload:
        existing.cell_transforms = _validate_cell_transforms(
            payload.get("cell_transforms"), canonical_fields,
        )

    existing.column_map = {str(k): str(v) for k, v in column_map.items()}
    if "operator_notes" in payload:
        existing.operator_notes = (payload.get("operator_notes") or "").strip()
    if "unit" in payload:
        existing.unit = (payload.get("unit") or None) or None
    if "source_version" in payload:
        existing.source_version = (payload.get("source_version") or None) or None
    if payload.get("confirm"):
        existing.confirmed_at = _utc_iso()
        existing.confidence = 1.0

    update_profile(existing)
    audit_log(
        kind="uis.profiles.update",
        actor=actor_dodid or "system",
        subject_id=profile_id,
        payload={"confirmed": bool(existing.confirmed_at)},
    )
    return _profile_to_dict(existing)


@router.delete("/profiles/{profile_id:path}")
async def uis_delete_profile(profile_id: str, request: Request):
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    require_user_role(user, INGEST_ROLES, action=f"uis.profiles.delete:{profile_id}")
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None

    if not delete_profile(profile_id):
        raise HTTPException(status_code=404, detail=f"profile {profile_id!r} not found")

    audit_log(
        kind="uis.profiles.delete",
        actor=actor_dodid or "system",
        subject_id=profile_id,
    )
    return {"deleted": True, "profile_id": profile_id}
