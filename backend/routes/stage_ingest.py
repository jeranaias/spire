"""Task #183 — stage live-ingest mode.

This router exposes the two surfaces the demo presenter needs to drive
the on-stage GCSS-MC ingest:

  * ``GET  /api/system/dataset-status`` — public read; returns
    ``{empty, source, ingested_at, counts, ...}`` so the frontend can
    branch between hydrated dashboards and the "awaiting GCSS-MC ingest"
    empty state without sniffing 503s on every domain endpoint.
  * ``POST /api/system/stage-ingest`` — gated to ``data_custodian`` and
    ``security_manager``; accepts the three-CSV sanitized GCSS-MC export
    (``header``, ``sr_parts``, ``due_in``), parses the header CSV via the
    existing ``backend.integrations.sentry_gcss_adapter``, lifts the
    parsed rows into a fresh ``CanonicalDataset``, and atomically swaps
    the global singleton via ``state.swap_dataset()``.

Hard constraints (carried from the task spec):

  * idempotent — same three files in, same ``ingest_hash`` and same
    downstream counts;
  * 60s hard timeout on the whole ingest, 504 on overrun (so the demo
    fails fast and the failsafe Shift+F8 / F9 can take over);
  * never modify ``backend/auth.py``;
  * never log raw PII — the adapter rejects un-hashed sensitive fields
    upstream of this router via the SENTRY upload sanitization gate;
    we re-enforce here for defense in depth.

The ingest path is *additive* to the SENTRY upload→batch flow from
Task #177 — that path stays exactly as it was. This route owns the
"replace the global dataset" semantic the SENTRY upload deliberately
does not have.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import time
from collections import Counter
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, File, HTTPException, Request, UploadFile

from ..integrations.sentry_gcss_adapter import (
    EXPECTED_HEADER_COLUMNS,
    IngestReport,
    ingest_sr_header_csv,
)
from ..scoping import require_user_role
from ..state import (
    CanonicalDataset,
    dataset_status,
    get_dataset,
    swap_dataset,
)

router = APIRouter()


# Roles allowed to drive the stage ingest. Mirrors the SENTRY upload gate
# (data custodian + security manager) — the same two cert holders who
# already have authority to land sanitized data into SPIRE.
STAGE_INGEST_ROLES = frozenset({"data_custodian", "security_manager"})

# Hard wall-clock cap on the whole ingest. The task spec calls for
# <30s on the demo box with a 60s abort. We enforce 60s here so a
# pathological CSV doesn't strand the presenter mid-keynote.
STAGE_INGEST_TIMEOUT_S = 60.0

# Per-file byte cap. The real export is ~50-80 MB across the three
# files; 200 MB per file leaves headroom without giving an attacker
# unbounded memory.
STAGE_INGEST_FILE_MAX_BYTES = 200 * 1024 * 1024


# ---------------------------------------------------------------------------
# GET /dataset-status — public read used by the frontend gate
# ---------------------------------------------------------------------------

@router.get("/dataset-status")
async def get_dataset_status() -> dict:
    """Return the current dataset shape + provenance.

    Frontend polls this on app boot and after every Shift+F8 / stage
    ingest to decide whether to render the "awaiting GCSS-MC ingest"
    empty state or the populated dashboards.
    """
    return dataset_status()


# ---------------------------------------------------------------------------
# POST /stage-ingest — drag-drop hydration
# ---------------------------------------------------------------------------

def _hash_files(*payloads: bytes) -> str:
    """Stable sha256 over the concatenation of the three uploaded payloads.

    Order matters (header → sr_parts → due_in) so we get the same
    ``ingest_hash`` for byte-identical re-uploads of the same export
    even if the multipart upload arrives in a different field order.
    The truncation (16 hex chars / 64 bits) is plenty for a deterministic
    handle on the wire — collisions on a hand-curated three-CSV bundle
    are not the threat model.
    """
    h = hashlib.sha256()
    for p in payloads:
        h.update(p)
        h.update(b"\x1e")  # ASCII Record Separator between files
    return h.hexdigest()[:16]


def _build_dataset_from_report(
    report: IngestReport,
    *,
    sr_parts_csv: str,
    due_in_csv: str,
    seed: int,
) -> CanonicalDataset:
    """Lift an ingest report (+ the two sibling CSVs) into a fresh
    ``CanonicalDataset`` shaped just enough for the dashboards to render.

    Stage live-ingest is a "show real document numbers / serial hashes /
    defect codes / backlog" experience, NOT a full simulator regenerator
    — we don't synthesize snapshots, MTBF curves, or readiness scoring
    from the GCSS-MC export. The endpoints that depend on snapshots
    (``/pulse/fleet-overview``, ``/bastion/cop``) will keep returning
    their ``empty: true`` payload after a stage ingest because there
    are still zero snapshots; the views that read SRs / requisitions
    (DECISION BRIDGE, SENTRY) light up with the real export data.

    That trade-off matches the task's framing — the value of stage
    live-ingest is "the synthetic veil drops and *real records* appear",
    not "the entire dataset including unmodelled snapshot timeseries
    materializes from three CSVs".
    """
    # Lazy imports of the dataclass shapes used by the simulator. We
    # only need ServiceRequest + Unit; Asset is intentionally NOT
    # constructed here because its dataclass requires ~15 fields the
    # GCSS-MC export does not carry (location, optempo, fielding_date,
    # initial_hours, ...). The frontend's "is there data?" check uses
    # ds.srs anyway, so synthesizing skeletal Asset rows would buy
    # nothing and risk drift with the simulator's real Asset shape.
    from lifecycle import ServiceRequest as SR  # type: ignore[import-not-found]
    from fleet import Unit  # type: ignore[import-not-found]

    srs = []
    seen_units: set[str] = set()
    seen_assets: set[str] = set()
    for r in report.rows:
        unit_uic = r.unit_uic_hashed or "OWNER_UNIT_unknown"
        unit_name = unit_uic[:24] if unit_uic else "UNKNOWN"
        asset_id = r.serial_number or f"ASSET-{r.sr_number[:12]}"
        try:
            sr_obj = SR(
                sr_number=r.sr_number,
                asset_id=asset_id,
                unit_uic=unit_uic,
                unit_name=unit_name,
                equipment_type=r.tamcn or "UNKNOWN",
                tamcn=r.tamcn or "",
                nsn="",
                serial_number=r.serial_number,
                open_date=r.open_date or date.today(),
                close_date=r.job_status_date,
                job_status="Closed" if r.job_status_date else "Active",
                condition="Deadlined" if r.deadlined_date else "Operational",
                priority=r.priority or "02",
                defect_code_primary=r.defect_code_primary or "",
                defect_code_secondary=r.defect_code_secondary or "",
                fault_id="",
                fault_component=(
                    f"{r.defect_code_primary}.{r.defect_code_secondary}"
                    if r.defect_code_secondary
                    else r.defect_code_primary
                ),
                tm_reference="",
                maintenance_level=str(r.echelon_numeric or ""),
                service_request_type=r.service_request_type or "Maintenance - CM",
                echelon_numeric=r.echelon_numeric or 1,
                deadlined_date=r.deadlined_date,
                remark_text=r.problem_summary or "",
                source_classification="UNCLASSIFIED",
                detected_classification="UNCLASSIFIED",
                sensitive_flags=[],
                data_quality_flag="warnings_present" if r._warnings else "",
                is_pmcs="PM" in (r.service_request_type or "").upper(),
            )
        except Exception:
            # Skip rows the dataclass can't accept rather than 500ing
            # the entire ingest. Provenance still lives on the report.
            continue
        srs.append(sr_obj)
        seen_units.add(unit_uic)
        seen_assets.add(asset_id)

    # Synthesize one minimal Unit per UIC observed in the export. Empty
    # ``equipment_counts`` is acceptable — downstream consumers all use
    # ``.get(equipment, 0)`` semantics and tolerate empty dicts.
    units: list = []
    for uic in sorted(seen_units):
        try:
            units.append(Unit(
                uic=uic,
                name=uic[:24] or "UNKNOWN",
                parent="MLG",
                location="",
                optempo="STANDARD",
                deployment_status="GARRISON",
                equipment_counts={},
            ))
        except Exception:
            # Permissive fallback for any future schema drift.
            continue

    # Asset / requisition objects are out of scope for stage ingest —
    # see comment above. Surface raw upload counts via the response
    # payload so the operator can see the files landed without us
    # fabricating skeletal Asset records.
    assets: list = []
    reqs: list = []

    return CanonicalDataset(
        units=units,
        assets=assets,
        roster=[],
        srs=srs,
        snapshots=[],            # see docstring — stage ingest doesn't synthesize timeseries
        reqs=reqs,
        cannib_events=[],
        incidents=[],
        tmrs=[],
        dq_defects={},
        violations=[],
        generated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
        seed=seed,
    )


def _safe_decode(raw: bytes, *, label: str) -> str:
    try:
        return raw.decode("utf-8-sig", errors="replace")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=422,
            detail=f"{label}: could not decode as UTF-8 ({exc})",
        )


def _validate_size(raw: bytes, *, label: str) -> None:
    if len(raw) > STAGE_INGEST_FILE_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"{label} is {len(raw):,} bytes — over the "
                f"{STAGE_INGEST_FILE_MAX_BYTES:,}-byte stage-ingest cap. "
                "Split the file or use the streaming SENTRY upload."
            ),
        )


def _check_header_schema(text: str) -> None:
    """Reject up front if the header CSV doesn't carry enough of the
    canonical 12 columns. Faster than letting the adapter walk the file
    and emit a schema_warning."""
    first_line = (text.splitlines()[0] if text else "").strip()
    cols = {
        c.strip().strip('"').upper()
        for c in first_line.split(",")
        if c.strip()
    }
    overlap = cols & set(EXPECTED_HEADER_COLUMNS)
    if len(overlap) < 9:
        raise HTTPException(
            status_code=422,
            detail=(
                f"header.csv schema mismatch — only {len(overlap)} of "
                f"{len(EXPECTED_HEADER_COLUMNS)} expected GCSS-MC columns "
                "matched. Confirm the file is the sanitized SR-header "
                "export, not a generic CSV."
            ),
        )


async def _run_ingest_with_timeout(
    header_text: str,
    *,
    sr_parts_csv: str,
    due_in_csv: str,
    seed: int,
) -> tuple[IngestReport, CanonicalDataset, float]:
    """Run the parser + dataset build under the 60s hard cap.

    The adapter is sync CPU-bound, so we offload to a thread executor
    and wrap the future in ``asyncio.wait_for`` to enforce the wall.
    """
    loop = asyncio.get_running_loop()
    started = time.monotonic()

    def _do_parse() -> tuple[IngestReport, CanonicalDataset]:
        report = ingest_sr_header_csv(header_text, cm_only=True)
        # Defense-in-depth: block un-sanitized clear sensitive fields,
        # mirroring the SENTRY upload gate. The stage-ingest path runs
        # on a sanitized export only — never the raw GCSS-MC pull.
        if report.unsanitized_field_counts:
            offenders = ", ".join(
                f"{k}={v}"
                for k, v in sorted(report.unsanitized_field_counts.items())
                if v
            )
            raise HTTPException(
                status_code=400,
                detail=(
                    "Sanitization gate: header.csv contained un-hashed "
                    f"sensitive fields ({offenders}). The stage-ingest "
                    "path requires the sanitized GCSS-MC export."
                ),
            )
        ds = _build_dataset_from_report(
            report,
            sr_parts_csv=sr_parts_csv,
            due_in_csv=due_in_csv,
            seed=seed,
        )
        return report, ds

    try:
        report, ds = await asyncio.wait_for(
            loop.run_in_executor(None, _do_parse),
            timeout=STAGE_INGEST_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=(
                f"stage-ingest exceeded the {STAGE_INGEST_TIMEOUT_S:.0f}s "
                "wall-clock cap. Use Shift+F8 to restore the seed-42 "
                "baseline and retry with a smaller export."
            ),
        )
    elapsed = time.monotonic() - started
    return report, ds, elapsed


@router.post("/stage-ingest")
async def stage_ingest(
    request: Request,
    header: UploadFile = File(...),
    sr_parts: UploadFile = File(...),
    due_in: UploadFile = File(...),
) -> dict:
    """Hydrate the global ``_DATASET`` from the three sanitized GCSS-MC CSVs.

    Returns:
        ``{ok: true, ingest_hash, counts, elapsed_ms, source_files,
            schema_warnings, ingest_report}``
    """
    user = getattr(request.state, "user", None)
    actor_role = require_user_role(
        user, STAGE_INGEST_ROLES, action="system.stage_ingest",
    )
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None

    header_bytes = await header.read()
    sr_parts_bytes = await sr_parts.read()
    due_in_bytes = await due_in.read()

    for raw, label in (
        (header_bytes, "header"),
        (sr_parts_bytes, "sr_parts"),
        (due_in_bytes, "due_in"),
    ):
        if not raw:
            raise HTTPException(
                status_code=422,
                detail=f"{label} upload is empty — expected a non-zero CSV.",
            )
        _validate_size(raw, label=label)

    header_text = _safe_decode(header_bytes, label="header")
    sr_parts_text = _safe_decode(sr_parts_bytes, label="sr_parts")
    due_in_text = _safe_decode(due_in_bytes, label="due_in")

    _check_header_schema(header_text)

    ingest_hash = _hash_files(header_bytes, sr_parts_bytes, due_in_bytes)

    try:
        report, new_ds, elapsed = await _run_ingest_with_timeout(
            header_text,
            sr_parts_csv=sr_parts_text,
            due_in_csv=due_in_text,
            seed=42,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=422,
            detail=f"stage-ingest parser failed: {exc}",
        )

    swap_dataset(
        new_ds,
        source="stage-ingest",
        ingested_by=actor_dodid or actor_role,
        ingest_hash=ingest_hash,
    )

    return {
        "ok": True,
        "ingest_hash": ingest_hash,
        "elapsed_ms": int(elapsed * 1000),
        "actor": {"role": actor_role, "dodid": actor_dodid},
        "source_files": {
            "header": {"name": header.filename, "bytes": len(header_bytes)},
            "sr_parts": {"name": sr_parts.filename, "bytes": len(sr_parts_bytes)},
            "due_in": {"name": due_in.filename, "bytes": len(due_in_bytes)},
        },
        "counts": {
            "units": len(new_ds.units),
            "assets": len(new_ds.assets),
            "srs": len(new_ds.srs),
            "snapshots": len(new_ds.snapshots),
            "incidents": len(new_ds.incidents),
            "requisitions": len(new_ds.reqs),
        },
        "ingest_report": {
            "rows_total": report.rows_total,
            "rows_kept": report.rows_kept,
            "rows_filtered_pmcs": report.rows_filtered_pmcs,
            "rows_with_warnings": report.rows_with_warnings,
            "schema_warnings": list(report.schema_warnings),
            "defect_code_trailing_period_normalized":
                report.defect_code_trailing_period_normalized,
            "date_parse_failures": report.date_parse_failures,
        },
    }
