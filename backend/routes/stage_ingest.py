"""Stage live-ingest router.

Exposes:
  * GET  /api/system/dataset-status — empty/populated probe for the
    frontend gate.
  * POST /api/system/stage-ingest   — RBAC-gated 3-CSV ingest
    (header + sr_parts + due_in) that atomically replaces the global
    dataset singleton. Idempotent on the file content (deterministic
    ingest_hash). 60s wall-clock cap returns 504 so the demo can fail
    fast onto the Shift+F8 reset.

Sanitization is enforced upstream by the SENTRY adapter and re-checked
here. This route is additive to the SENTRY upload→batch flow.
"""
from __future__ import annotations

import asyncio
import csv as _csv
import hashlib
import io
import time
from collections import defaultdict
from datetime import date, datetime
from types import SimpleNamespace
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
    swap_dataset,
)

router = APIRouter()


# Mirrors the SENTRY upload gate.
STAGE_INGEST_ROLES = frozenset({"data_custodian", "security_manager"})
STAGE_INGEST_TIMEOUT_S = 60.0
STAGE_INGEST_FILE_MAX_BYTES = 1024 * 1024 * 1024


@router.get("/dataset-status")
async def get_dataset_status() -> dict:
    return dataset_status()


def _hash_files(*payloads: bytes) -> str:
    """SHA-256 over the three uploads in fixed (header, sr_parts, due_in)
    order so byte-identical re-uploads produce the same ingest_hash."""
    h = hashlib.sha256()
    for p in payloads:
        h.update(p)
        h.update(b"\x1e")
    return h.hexdigest()


def _count_csv_rows(text: str) -> int:
    if not text:
        return 0
    lines = [ln for ln in text.splitlines() if ln.strip()]
    return max(0, len(lines) - 1)


def _parse_csv_dicts(text: str, *, label: str) -> list[dict]:
    """Strict CSV parse. Malformed input raises 422 rather than silently
    returning [] — partial datasets break the determinism guarantee."""
    if not text or not text.strip():
        raise HTTPException(
            status_code=422,
            detail=(
                f"{label} CSV is whitespace-only after decode — "
                "expected a header row plus at least one data row."
            ),
        )
    try:
        reader = _csv.DictReader(io.StringIO(text))
        if reader.fieldnames is None or not any(
            (f or "").strip() for f in reader.fieldnames
        ):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{label} CSV has no usable header row. "
                    "Stage-ingest requires a real CSV header."
                ),
            )
        rows = [dict(r) for r in reader if any((v or "").strip() for v in r.values())]
    except HTTPException:
        raise
    except (_csv.Error, ValueError) as exc:
        raise HTTPException(
            status_code=422,
            detail=f"{label} CSV failed to parse: {exc}",
        )
    return rows


def _index_sr_parts(sr_parts_rows: list[dict]) -> dict[str, list[dict]]:
    """Group sr_parts rows by SR_NUMBER for per-SR parts-on-order counts."""
    by_sr: dict[str, list[dict]] = defaultdict(list)
    for r in sr_parts_rows:
        sr_num = (r.get("SR_NUMBER") or "").strip()
        if sr_num:
            by_sr[sr_num].append(r)
    return dict(by_sr)


def _due_in_to_reqs(due_in_rows: list[dict]) -> list:
    """Lift each due_in row to a SimpleNamespace requisition record
    with the real document_number. SimpleNamespace satisfies the
    attribute-access contract downstream consumers expect without
    dragging in the full PartRequisition dataclass."""
    reqs: list = []
    for row in due_in_rows:
        doc = (row.get("DOCUMENT_NUMBER") or "").strip()
        if not doc:
            continue
        try:
            qty = int((row.get("QUANTITY") or "0").strip() or 0)
        except ValueError:
            qty = 0
        try:
            backorder = int((row.get("BACKORDER_QTY") or "0").strip() or 0)
        except ValueError:
            backorder = 0
        try:
            received = int((row.get("RECEIVED_QTY") or "0").strip() or 0)
        except ValueError:
            received = 0
        reqs.append(SimpleNamespace(
            document_number=doc,
            doc_number=doc,            # legacy alias some routes use
            sr_number="",              # joined below if sr_parts maps it
            asset_id="",
            nsn=(row.get("NSN") or "").strip(),
            nomenclature="",
            qty_ordered=qty,
            backorder_qty=backorder,
            received_qty=received,
            unit_cost=0.0,
            priority=(row.get("PRIORITY") or "02").strip() or "02",
            uoi=(row.get("UNIT_OF_ISSUE") or "EA").strip() or "EA",
            supply_path="medium",
            status_history=[],
            current_status=(row.get("STATUS_CODE") or "BB").strip() or "BB",
            doc_status=(row.get("STATUS_CODE") or "DUE_IN").strip() or "DUE_IN",
            status_code=(row.get("STATUS_CODE") or "BB").strip() or "BB",
            ordered_date=None,
            received_date=None,
            projected_delivery_date=None,
            estimated_ship_date=None,
            item_type="I",
            dic="A0A",
            service_activity="Issue from Inventory",
            source="stage-ingest",
        ))
    return reqs


def _build_dataset_from_report(
    report: IngestReport,
    *,
    sr_parts_csv: str,
    due_in_csv: str,
    seed: int,
) -> CanonicalDataset:
    """Lift the ingest report and sibling CSVs into a CanonicalDataset.

    Builds SR/Unit per header row plus a today-only DailySnapshot per
    asset (FMC/NMCS/NMCM driven by deadline + parts-on-order counts),
    enough for DECISION BRIDGE/SENTRY/BASTION/PULSE to render against
    real records. The 14-day timeseries / cannibalization graphs that
    the simulator ships are deliberately not reconstructed here.
    """
    from lifecycle import ServiceRequest as SR, DailySnapshot  # type: ignore[import-not-found]
    from fleet import Unit  # type: ignore[import-not-found]

    parts_count = _count_csv_rows(sr_parts_csv)
    due_in_count = _count_csv_rows(due_in_csv)
    sr_parts_rows = _parse_csv_dicts(sr_parts_csv, label="sr_parts")
    due_in_rows = _parse_csv_dicts(due_in_csv, label="due_in")
    parts_by_sr = _index_sr_parts(sr_parts_rows)

    srs = []
    seen_units: set[str] = set()
    asset_meta: dict = {}
    latest_open: Optional[date] = None
    # Per-bucket lift-step drop counters; surfaced in the response.
    skip_counts = {"srs": 0, "units": 0, "snapshots": 0}
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
            skip_counts["srs"] += 1
            continue
        srs.append(sr_obj)
        seen_units.add(unit_uic)
        # Most-recent SR drives readiness so the snapshot reflects
        # current open work, not a stale closed SR.
        prior = asset_meta.get(asset_id)
        sr_open = sr_obj.open_date or date.today()
        if prior is None or sr_open >= prior["open_date"]:
            asset_meta[asset_id] = {
                "asset_id": asset_id,
                "unit_uic": unit_uic,
                "unit_name": unit_name,
                "equipment_type": sr_obj.equipment_type,
                "tamcn": sr_obj.tamcn,
                "serial_number": sr_obj.serial_number or "",
                "condition": sr_obj.condition,
                "job_status": sr_obj.job_status,
                "deadlined": sr_obj.deadlined_date is not None,
                "open_date": sr_open,
                "sr_numbers": list(prior["sr_numbers"]) if prior else [],
            }
        asset_meta[asset_id]["sr_numbers"].append(sr_obj.sr_number)
        if latest_open is None or sr_open > latest_open:
            latest_open = sr_open

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
            skip_counts["units"] += 1
            continue

    # Snapshot anchored to most recent open_date; parts_on_order is
    # the real sr_parts count joined by SR_NUMBER, not synthesized.
    snapshot_date = latest_open or date.today()
    snapshots: list = []
    for meta in asset_meta.values():
        if meta["job_status"] == "Closed" and not meta["deadlined"]:
            readiness = "FMC"
            condition = "Operational"
        elif meta["deadlined"]:
            asset_parts = sum(
                len(parts_by_sr.get(srn, [])) for srn in meta["sr_numbers"]
            )
            readiness = "NMCS" if asset_parts > 0 else "NMCM"
            condition = "Deadlined"
        else:
            readiness = "PMC"
            condition = "Degraded"
        asset_parts = sum(
            len(parts_by_sr.get(srn, [])) for srn in meta["sr_numbers"]
        )
        try:
            snapshots.append(DailySnapshot(
                snapshot_date=snapshot_date,
                asset_id=meta["asset_id"],
                unit_uic=meta["unit_uic"],
                unit_name=meta["unit_name"],
                equipment_type=meta["equipment_type"],
                tamcn=meta["tamcn"],
                serial_number=meta["serial_number"],
                readiness_code=readiness,
                condition=condition,
                open_sr_count=len(meta["sr_numbers"]),
                days_deadlined=0,
                days_since_maintenance=0,
                current_hours=0.0,
                current_miles=0,
                parts_on_order=asset_parts,
                location="",
                deployment_status="GARRISON",
            ))
        except Exception:
            skip_counts["snapshots"] += 1
            continue

    # Real document_numbers when parseable; count-based placeholders
    # only if the parse yielded nothing usable.
    reqs: list = _due_in_to_reqs(due_in_rows)
    if not reqs and due_in_count > 0:
        reqs = [
            SimpleNamespace(
                document_number=f"STAGE-DOC-{i:08d}",
                doc_number=f"STAGE-DOC-{i:08d}",
                status_code="DUE_IN",
                current_status="BB",
                doc_status="DUE_IN",
                source="stage-ingest",
                nsn="",
                qty_ordered=0,
                priority="02",
            )
            for i in range(due_in_count)
        ]

    # SimpleNamespace assets satisfy the attribute-access contract
    # without requiring the Asset dataclass's 15+ simulator-only fields.
    assets: list = [
        SimpleNamespace(
            asset_id=meta["asset_id"],
            equipment_type=meta["equipment_type"],
            tamcn=meta["tamcn"],
            nsn="",
            serial_number=meta["serial_number"],
            nomenclature=meta["equipment_type"],
            model="",
            fsc="",
            unit_uic=meta["unit_uic"],
            unit_name=meta["unit_name"],
            unit_parent="MLG",
            location="",
            optempo="STANDARD",
            deployment_status="GARRISON",
            current_deployment_status="GARRISON",
            fielding_date=None,
            initial_hours=0.0,
            initial_miles=0,
            classification_risk="UNCLASSIFIED",
            current_hours=0.0,
            current_miles=0,
            current_status=(
                "NMCS" if meta["deadlined"] else
                ("FMC" if meta["job_status"] == "Closed" else "PMC")
            ),
            days_in_current_status=0,
            days_nmc_last_12mo=0,
            nmc_events_last_12mo=0,
            open_srs=list(meta["sr_numbers"]),
            maintenance_history=[],
            pmcs_due_date=None,
            last_maintenance_date=None,
            days_since_last_maintenance=0,
            hours_today=0.0,
            miles_today=0,
        )
        for meta in asset_meta.values()
    ]

    ds = CanonicalDataset(
        units=units,
        assets=assets,
        roster=[],
        srs=srs,
        snapshots=snapshots,
        reqs=reqs,
        cannib_events=[],
        incidents=[],
        tmrs=[],
        dq_defects={},
        violations=[],
        generated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
        seed=seed,
    )
    setattr(ds, "_stage_ingest_skip_counts", skip_counts)
    return ds


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
    """Reject up front if header.csv doesn't carry enough canonical columns."""
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
    """Run parser + dataset build under the 60s wall via thread executor."""
    loop = asyncio.get_running_loop()
    started = time.monotonic()

    def _do_parse() -> tuple[IngestReport, CanonicalDataset]:
        report = ingest_sr_header_csv(header_text, cm_only=True)
        # Mirrors SENTRY upload gate: stage-ingest must be sanitized export.
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
    """Hydrate the global dataset from the three sanitized GCSS-MC CSVs."""
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

    header_rows = _count_csv_rows(header_text)
    sr_parts_rows = _count_csv_rows(sr_parts_text)
    due_in_rows = _count_csv_rows(due_in_text)

    return {
        "ok": True,
        "ingest_hash": ingest_hash,
        "elapsed_ms": int(elapsed * 1000),
        "actor": {"role": actor_role, "dodid": actor_dodid},
        "source_files": {
            "header": {
                "name": header.filename,
                "bytes": len(header_bytes),
                "rows_parsed": header_rows,
            },
            "sr_parts": {
                "name": sr_parts.filename,
                "bytes": len(sr_parts_bytes),
                "rows_parsed": sr_parts_rows,
            },
            "due_in": {
                "name": due_in.filename,
                "bytes": len(due_in_bytes),
                "rows_parsed": due_in_rows,
            },
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
            "skipped_rows": getattr(new_ds, "_stage_ingest_skip_counts", {
                "srs": 0, "units": 0, "snapshots": 0,
            }),
        },
    }
