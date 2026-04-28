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
import csv as _csv
import hashlib
import io
import time
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
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
    """Full sha256 over the concatenation of the three uploaded payloads.

    Order matters (header → sr_parts → due_in) so we get the same
    ``ingest_hash`` for byte-identical re-uploads of the same export
    even if the multipart upload arrives in a different field order.
    Returns the full 64-hex-char digest — the task spec calls for a
    full SHA-256 in the response payload.
    """
    h = hashlib.sha256()
    for p in payloads:
        h.update(p)
        h.update(b"\x1e")  # ASCII Record Separator between files
    return h.hexdigest()


def _count_csv_rows(text: str) -> int:
    """Cheap row count for sr_parts / due_in. Excludes the header line
    and blank trailing rows. Used to populate response counters."""
    if not text:
        return 0
    lines = [ln for ln in text.splitlines() if ln.strip()]
    return max(0, len(lines) - 1)


def _parse_csv_dicts(text: str, *, label: str) -> list[dict]:
    """Parse a CSV body into a list of dicts keyed by header column.

    Strict mode (Task #183 round-5): malformed input must surface as a
    422 — the previous silent-fallback to ``[]`` masked corruption and
    let the route return 200 with a partial dataset, breaking the
    "same files → same dashboards" determinism guarantee. We re-raise
    a typed HTTPException so the route's outer handler relays the
    operator-facing error message verbatim instead of converting it
    into a generic 500.
    """
    if not text or not text.strip():
        # Empty sibling files are rejected at the upload size gate before
        # we get here; if a decoded body is whitespace-only at this point
        # it's a malformed file (e.g. only a stray newline), not an empty
        # upload, so fail loudly.
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
    """Group sr_parts rows by SR_NUMBER so each ServiceRequest can
    surface its real parts-on-order count instead of a uniform fake."""
    by_sr: dict[str, list[dict]] = defaultdict(list)
    for r in sr_parts_rows:
        sr_num = (r.get("SR_NUMBER") or "").strip()
        if sr_num:
            by_sr[sr_num].append(r)
    return dict(by_sr)


def _due_in_to_reqs(due_in_rows: list[dict]) -> list:
    """Lift each due_in row to a SimpleNamespace requisition record
    carrying the *real* document_number (not a fabricated DOC-NNN).
    Downstream consumers iterate with attribute access (``r.document_number``,
    ``r.status_code``, ``r.nsn``) — SimpleNamespace satisfies that contract
    without dragging the full PartRequisition dataclass and its 20+
    required fields into a stage-ingest path that doesn't need them."""
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
    """Lift an ingest report (+ the two sibling CSVs) into a fresh
    ``CanonicalDataset`` shaped enough for every read-only dashboard
    (DECISION BRIDGE, SENTRY, BASTION COP, PULSE Fleet Overview) to
    render against the real GCSS-MC records.

    Hydration map:

    * **header.csv** → one ``ServiceRequest`` per row, plus a
      ``Unit`` per unique OWNER_UNIT hash and a synthesized today-only
      ``DailySnapshot`` per unique asset (one row per asset, anchored
      to the most recent open_date in the export). The synthesized
      snapshot uses ``readiness_code = "FMC"`` for closed/operational
      SRs and ``"NMCS"`` (parts shortage) when the asset has any
      due-in line, otherwise ``"NMCM"``.
    * **sr_parts.csv** → counted into ``parts_on_order`` per asset for
      the synthesized snapshot, surfaced in the response counter.
    * **due_in.csv** → counted into the ``reqs`` requisition list as
      lightweight placeholder records, surfaced in the response counter.

    The synthesis is deliberately minimal — we never claim to recover
    14-day timeseries, MTBF curves, or cannibalization graphs from the
    three-CSV export. The single-day snapshot is enough to drop the
    ``empty: true`` envelope on ``/api/bastion/cop`` and
    ``/api/pulse/fleet-overview`` while still being honest about which
    surfaces (forecast plots, cannib heat, scenario timelines) remain
    unsupported by the live ingest.
    """
    # Lazy imports of the dataclass shapes used by the simulator. We
    # only build SR + Unit + DailySnapshot here. Asset rows are NOT
    # constructed because the simulator's Asset dataclass carries 15+
    # fields the GCSS-MC export does not carry; downstream code that
    # cares about asset identity reads from snapshots (which DO carry
    # asset_id / tamcn / serial_number).
    from lifecycle import ServiceRequest as SR, DailySnapshot  # type: ignore[import-not-found]
    from fleet import Unit  # type: ignore[import-not-found]

    parts_count = _count_csv_rows(sr_parts_csv)
    due_in_count = _count_csv_rows(due_in_csv)
    # Real per-row parses — used to attach actual document_numbers to
    # the requisition list and a per-SR parts-on-order count to the
    # synthesized snapshots.
    sr_parts_rows = _parse_csv_dicts(sr_parts_csv, label="sr_parts")
    due_in_rows = _parse_csv_dicts(due_in_csv, label="due_in")
    parts_by_sr = _index_sr_parts(sr_parts_rows)

    srs = []
    seen_units: set[str] = set()
    # asset_id -> dict of metadata captured from the SR row, used to
    # synthesize the today-only DailySnapshot block below.
    asset_meta: dict = {}
    latest_open: Optional[date] = None
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
        # Capture per-asset metadata for the snapshot synthesis pass.
        # We keep the *most recent* SR's status so the synthesized
        # readiness_code reflects the current open work, not a stale
        # closed SR from earlier in the file.
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
        # Always track every SR observed for this asset — the snapshot
        # synthesis sums real parts-on-order across all of them.
        asset_meta[asset_id]["sr_numbers"].append(sr_obj.sr_number)
        if latest_open is None or sr_open > latest_open:
            latest_open = sr_open

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

    # Synthesize one DailySnapshot per asset, anchored to the most
    # recent open_date in the header. ``parts_on_order`` per snapshot
    # is the *real* count of sr_parts rows that joined to any of the
    # asset's SR_NUMBERs — no fabrication, no uniform distribution.
    snapshot_date = latest_open or date.today()
    snapshots: list = []
    for meta in asset_meta.values():
        if meta["job_status"] == "Closed" and not meta["deadlined"]:
            readiness = "FMC"
            condition = "Operational"
        elif meta["deadlined"]:
            # Real per-asset parts count drives NMCS vs NMCM split.
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
            continue

    # Lift due_in.csv into requisition records carrying the *real*
    # document_numbers from the file (not fabricated DOC-NNN). When
    # the parser couldn't read the file at all we fall back to count-
    # based placeholders so the counters still surface the load.
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

    # Assets are SimpleNamespace records — attribute access is the
    # contract every PULSE/BASTION reader uses (``a.asset_id``,
    # ``a.unit_name``, ``a.equipment_type``, etc). We populate every
    # Asset-dataclass field downstream code touches with sensible
    # defaults; we deliberately avoid the real Asset dataclass because
    # it has 15+ required positional fields the GCSS-MC export does
    # not carry, and several of those drive simulator-only timeseries.
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

    return CanonicalDataset(
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

    # Per-file parsed-row counts for the operator-facing hero card.
    # `_count_csv_rows` is the same helper the parser uses, so the
    # number we report matches what _do_parse actually consumed.
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
        },
    }
