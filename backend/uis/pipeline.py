"""Pipeline orchestrator.

`run_pipeline(raw_bytes, adapter)` is the single entry point for the
Universal Ingest Service. It walks every stage:

    bytes
      → decode (encoding detect, BOM strip)
      → normalize (smart quotes, line endings)
      → format detect (csv / tsv / jsonl / xlsx)
      → row stream
      → mapping (profile lookup → auto_map fallback)
      → per-cell transform (date, hash, coerce, enum)
      → row-level + cross-row validation
      → canonical row list

Returns a `PipelineResult` carrying the rows, a parse report, the
column map used, the auto-mapper confidence, and per-row warnings.
The route caller hands this to the diff engine
(`pulse_gcss_ecp_merge.compute_diff`) for the dry-run preview, then
to `apply_diff` + `swap_dataset` for the apply.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from datetime import date, datetime
from itertools import chain as _iter_chain
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional, Tuple


# Soft policy ceiling on rows per pipeline run. UIS-P6.4 made the
# pipeline row-streaming end-to-end so this is no longer an OOM
# guard — it's a sanity check that catches operator errors (a
# 100M-row CSV almost certainly means somebody pointed the
# adapter at the wrong source). Default 5M is well above any
# real GCSS-MC export shape we've seen; raise via env when
# evaluating against larger pulls. Set to 0 to disable.
DEFAULT_MAX_ROWS = 5_000_000


def _max_rows_per_pipeline() -> int:
    """Resolve the row-count soft policy from env. 0 disables the check."""
    raw = (os.environ.get("SPIRE_UIS_MAX_ROWS") or "").strip()
    if not raw:
        return DEFAULT_MAX_ROWS
    try:
        n = int(raw)
        if n < 0:
            return DEFAULT_MAX_ROWS
        return n  # 0 means disabled
    except ValueError:
        return DEFAULT_MAX_ROWS


class PipelineRowLimitExceeded(Exception):
    """Raised when the file has more rows than the pipeline policy cap.

    UIS-P6.4: this is a soft policy check, not an OOM guard. Memory is
    bounded by the row-streaming refactor — the cap exists to catch
    operator errors (wrong source pointed at adapter) before a
    multi-day backfill silently runs.

    Surfaced as HTTP 413 by the route layer so the operator gets a
    clear "file too big — split it or raise SPIRE_UIS_MAX_ROWS".
    """

    def __init__(self, *, limit: int, observed: int):
        self.limit = limit
        self.observed = observed
        super().__init__(
            f"Row count {observed} exceeds pipeline cap {limit}. "
            f"Split the file or raise SPIRE_UIS_MAX_ROWS (set to 0 to disable)."
        )


def required_columns_unmapped(pipeline_result: Any, adapter: Any) -> List[str]:
    """UIS-P4.10 — return the list of canonical columns the
    adapter declares as required but the mapping failed to populate.

    Empty list = apply is safe to proceed (every required field
    has a mapping). Non-empty = apply MUST refuse — applying with
    a missing required field would write half-populated rows that
    later joins / queries would silently misinterpret.

    Common causes:
      - operator uploaded a file shape the adapter doesn't expect
        (auto-mapper couldn't find the source column for a
        required canonical field)
      - saved profile was authored against an older export schema
        where the required field came from a column that's been
        renamed / dropped (UIS-35 surfaces as profile_orphan)
    """
    unmapped = set(getattr(pipeline_result.report, "unmapped_canonical", []) or [])
    required = set(adapter.required_columns()) if hasattr(adapter, "required_columns") else set()
    return sorted(unmapped & required)

from .adapters.spec import AdapterSpec, ColumnSpec, RowConstraint
from .formats import DuplicateHeaderError, detect_format, stream_rows
from .mapping.auto_map import propose_mapping, MappingProposal
from .mapping.profile import MappingProfile
from .normalize import decode_bytes, is_low_confidence_encoding, normalize_text
from .transforms import (
    classify_hashed_field,
    map_enum,
    parse_bool,
    parse_date,
    parse_date_excel,
    parse_date_oracle,
    parse_datetime,
    parse_float,
    parse_int,
)


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------


@dataclass
class RowWarning:
    row_index: int                  # 0-based, header row excluded
    field: str                      # canonical field name
    code: str                       # "date_unparseable", "missing_required", ...
    raw_value: str = ""
    message: str = ""


@dataclass
class ConstraintFailure:
    row_index: int
    constraint_kind: str
    message: str = ""


@dataclass
class ParseReport:
    """Aggregate report on one pipeline run."""

    rows_total: int = 0
    rows_kept: int = 0
    rows_dropped_required_missing: int = 0
    rows_dropped_constraint_failure: int = 0
    rows_with_warnings: int = 0
    detected_format: str = ""
    detected_encoding: str = ""
    # When True, the encoding was guessed (latin-1 last-resort,
    # cp1252 byte-strict pass, or charset_normalizer best-effort).
    # The frontend dropzone surfaces a yellow banner so the operator
    # can verify before applying — silent corruption was the failure
    # mode this guards against (a UTF-16 file decoded as cp1252
    # produces garbage rows that look "valid" but aren't).
    encoding_low_confidence: bool = False
    # Per-stage wall-clock timings in milliseconds. Lets the
    # dropzone render "parsed in 2.3s" and lets operators / oncall
    # spot which stage dominates a slow upload. Stages: decode (
    # bytes → text), detect (format sniff), stream (csv → row dicts),
    # map (auto-mapper), transform (per-cell coercion), validate
    # (constraint checks).
    timings_ms: Dict[str, float] = field(default_factory=dict)
    column_map: Dict[str, str] = field(default_factory=dict)
    auto_mapper_confidence: float = 0.0
    profile_id: Optional[str] = None
    unmapped_canonical: List[str] = field(default_factory=list)
    unmapped_source: List[str] = field(default_factory=list)
    # UIS-35 — when a saved profile references a source column that
    # isn't in the current file (export schema drift, operator
    # renamed a column, or the file came from a different system
    # variant), the mapping silently dropped. We surface those keys
    # so the operator gets a yellow banner: "your profile expected
    # `TAMCN_Code`, this file has `TAMCN` — promote the saved
    # mapping to a profile that matches the new shape."
    profile_orphan_keys: List[str] = field(default_factory=list)
    sanitization_self_hashed: Dict[str, int] = field(default_factory=dict)
    constraint_failures_count: int = 0
    warnings_count: int = 0

    def to_dict(self) -> dict:
        return {
            "rows_total": self.rows_total,
            "rows_kept": self.rows_kept,
            "rows_dropped_required_missing": self.rows_dropped_required_missing,
            "rows_dropped_constraint_failure": self.rows_dropped_constraint_failure,
            "rows_with_warnings": self.rows_with_warnings,
            "detected_format": self.detected_format,
            "detected_encoding": self.detected_encoding,
            "encoding_low_confidence": self.encoding_low_confidence,
            "column_map": dict(self.column_map),
            "auto_mapper_confidence": self.auto_mapper_confidence,
            "profile_id": self.profile_id,
            "unmapped_canonical": list(self.unmapped_canonical),
            "unmapped_source": list(self.unmapped_source),
            "profile_orphan_keys": list(self.profile_orphan_keys),
            "sanitization_self_hashed": dict(self.sanitization_self_hashed),
            "constraint_failures_count": self.constraint_failures_count,
            "warnings_count": self.warnings_count,
            "timings_ms": dict(self.timings_ms),
        }


@dataclass
class PipelineResult:
    rows: List[Dict[str, Any]]
    report: ParseReport
    warnings: List[RowWarning] = field(default_factory=list)
    constraint_failures: List[ConstraintFailure] = field(default_factory=list)
    # Per-row sanitization labels — same row order as `rows`. Each
    # entry is a {field_name: "pre_hashed" | "self_hashed" | "missing"}
    # dict for the sensitive fields on this row. Lets callers (like
    # the legacy ECP route) reconstruct ParsedAssetRow.serial_number_source
    # without re-running the classifier on the post-hashed value.
    sanitization_per_row: List[Dict[str, str]] = field(default_factory=list)
    # Per-row warning labels — same row order as `rows`. Each entry
    # is the list of warning codes that fired for that row (e.g.
    # ["date_oracle_unparseable", "owner_uic_self_hashed"]). Allows
    # the legacy route to populate ParsedAssetRow._warnings.
    warnings_per_row: List[List[str]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Transform dispatch
# ---------------------------------------------------------------------------


# UIS-36 — known cell-transform IDs accepted in MappingProfile.cell_transforms.
# Profile-level transform overrides let one canonical field (e.g.
# `last_inventory_date`) accept different formats from different
# source systems without spawning a parallel adapter. Saved at
# profile create/update time with route-side validation; applied
# per-row inside _coerce_value.
ALLOWED_CELL_TRANSFORMS = frozenset({
    "str", "int", "float", "bool",
    "date", "date_oracle", "date_excel", "datetime", "enum",
})


def _coerce_value(
    raw: str,
    col: ColumnSpec,
    ctx: dict,
    warnings: List[RowWarning],
    row_idx: int,
    *,
    type_override: Optional[str] = None,
) -> Any:
    """Apply the column's declared transform to a raw cell value.

    Returns the coerced value (possibly None for missing/unparseable),
    appending a RowWarning when coercion fails on a non-empty input.

    `type_override` (UIS-36) lets the saved profile substitute a
    different transform for this canonical field (e.g. read
    `last_inventory_date` as `date_excel` instead of the adapter's
    declared `date`). Sensitive + custom_transform paths are NOT
    overridable — those carry security/business logic that must
    stay anchored to the adapter spec.
    """
    if col.custom_transform is not None:
        try:
            return col.custom_transform(raw, ctx)
        except Exception as e:  # noqa: BLE001
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="custom_transform_error",
                raw_value=str(raw)[:200], message=str(e)[:200],
            ))
            return col.default

    if col.sensitive:
        prefix = col.hash_prefix or col.name.upper()
        value, source_label = classify_hashed_field(prefix, raw)
        ctx.setdefault("_sanitization", {})[col.name] = source_label
        return value if value else col.default

    effective_type = type_override or col.type

    if effective_type == "str":
        s = (raw or "").strip()
        return s if s else col.default
    if effective_type == "int":
        v = parse_int(raw)
        if v is None and (raw or "").strip():
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="int_unparseable",
                raw_value=str(raw)[:200],
            ))
        return v if v is not None else col.default
    if effective_type == "float":
        v = parse_float(raw)
        if v is None and (raw or "").strip():
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="float_unparseable",
                raw_value=str(raw)[:200],
            ))
        return v if v is not None else col.default
    if effective_type == "bool":
        v = parse_bool(raw)
        if v is None and (raw or "").strip():
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="bool_unparseable",
                raw_value=str(raw)[:200],
            ))
        return v if v is not None else col.default
    if effective_type == "date":
        v = parse_date(raw)
        if v is None and (raw or "").strip():
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="date_unparseable",
                raw_value=str(raw)[:200],
            ))
        return v if v is not None else col.default
    if effective_type == "date_oracle":
        v = parse_date_oracle(raw)
        if v is None and (raw or "").strip():
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="date_oracle_unparseable",
                raw_value=str(raw)[:200],
            ))
        return v if v is not None else col.default
    if effective_type == "date_excel":
        v = parse_date_excel(raw)
        if v is None and (raw or "").strip():
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="date_excel_unparseable",
                raw_value=str(raw)[:200],
            ))
        return v if v is not None else col.default
    if effective_type == "datetime":
        v = parse_datetime(raw)
        if v is None and (raw or "").strip():
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="datetime_unparseable",
                raw_value=str(raw)[:200],
            ))
        return v if v is not None else col.default
    if effective_type == "enum":
        aliases = col.enum_aliases or {}
        v = map_enum(raw, aliases)
        if v is None:
            return col.default
        # If value isn't in alias values, warn (operator may need to add the alias)
        canonical_set = set(aliases.values()) if aliases else None
        if canonical_set is not None and v not in canonical_set:
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="enum_unknown_value",
                raw_value=str(raw)[:200],
                message=f"value {v!r} not in canonical alias set {sorted(canonical_set)}",
            ))
        return v
    # Fallback: passthrough as string
    return (raw or "").strip() or col.default


# ---------------------------------------------------------------------------
# Constraint checks
# ---------------------------------------------------------------------------


import re as _re_module

# Compiled-regex cache. Constraint patterns are AdapterSpec-static
# but were being re-compiled on every row. For a 50k-row file with
# 5 regex constraints that's 250k recompiles — costs add up. Cache
# is keyed on the literal pattern string; cleared whenever the
# process restarts (which is also when adapter specs reload).
_REGEX_CACHE: Dict[str, "_re_module.Pattern"] = {}


def _compiled(pattern: str) -> "_re_module.Pattern":
    cached = _REGEX_CACHE.get(pattern)
    if cached is not None:
        return cached
    compiled = _re_module.compile(pattern)
    _REGEX_CACHE[pattern] = compiled
    return compiled


def _check_constraint(row: Dict[str, Any], constraint: RowConstraint) -> Optional[str]:
    """Return None if the row passes; an error message if not."""
    kind = constraint.kind
    if kind == "at_least_one_of":
        if not any(row.get(f) not in (None, "", 0) for f in constraint.fields):
            return constraint.message or f"row missing all of {constraint.fields}"
        return None
    if kind == "exactly_one_of":
        present = sum(1 for f in constraint.fields if row.get(f) not in (None, "", 0))
        if present != 1:
            return constraint.message or f"row must have exactly one of {constraint.fields} (had {present})"
        return None
    if kind == "regex":
        v = str(row.get(constraint.fields[0] if constraint.fields else "", ""))
        if constraint.pattern and not _compiled(constraint.pattern).match(v):
            return constraint.message or f"value {v!r} does not match {constraint.pattern!r}"
        return None
    if kind == "range":
        v = row.get(constraint.fields[0] if constraint.fields else "")
        try:
            n = float(v) if v is not None else None
        except (TypeError, ValueError):
            return constraint.message or f"value {v!r} not numeric"
        if n is None:
            return None
        if constraint.min is not None and n < constraint.min:
            return constraint.message or f"value {n} below min {constraint.min}"
        if constraint.max is not None and n > constraint.max:
            return constraint.message or f"value {n} above max {constraint.max}"
        return None
    if kind == "custom":
        if constraint.predicate is not None:
            try:
                ok = bool(constraint.predicate(row))
            except Exception:  # noqa: BLE001
                return constraint.message or "custom predicate raised"
            if not ok:
                return constraint.message or "custom predicate returned False"
        return None
    return constraint.message or f"unknown constraint kind {kind!r}"


# ---------------------------------------------------------------------------
# Streaming primitives (UIS-P6.4)
# ---------------------------------------------------------------------------


@dataclass
class StreamedRow:
    """One row's worth of streaming pipeline output.

    Yielded by :func:`iter_pipeline`. ``canonical_row`` is None when the
    row was dropped (missing required field or constraint failure);
    ``drop_reason`` carries the structured code in that case.
    """

    row_idx: int
    canonical_row: Optional[Dict[str, Any]]
    sanitization: Dict[str, str] = field(default_factory=dict)
    warning_codes: List[str] = field(default_factory=list)
    drop_reason: Optional[str] = None  # "missing_required" | "constraint_failure"


def _decode_and_detect_format(
    raw: bytes,
    adapter: AdapterSpec,
    report: "ParseReport",
    warnings: List["RowWarning"],
    timings: Dict[str, float],
) -> Tuple[Optional[str], Optional[bytes]]:
    """Decode + detect format. Returns (fmt, raw_for_stream) or (None, None)
    if format is unknown (caller should return an empty result).

    Mutates report (encoding, format) and warnings (encoding_low_confidence)
    and timings (decode_ms, detect_ms) in place.
    """
    def _now() -> float:
        return time.perf_counter() * 1000.0

    t0 = _now()
    text, encoding = decode_bytes(raw)
    report.detected_encoding = encoding
    report.encoding_low_confidence = is_low_confidence_encoding(encoding)
    if report.encoding_low_confidence:
        warnings.append(RowWarning(
            row_index=-1,
            field="",
            code="encoding_low_confidence",
            message=f"Decoded as {encoding}; verify the file isn't a wrong-encoding silent corruption.",
        ))
    timings["decode_ms"] = round(_now() - t0, 2)

    t0 = _now()
    adapter_hint = getattr(adapter, "format_hint", None)
    fmt = adapter_hint if adapter_hint else detect_format(raw[:4096])
    report.detected_format = fmt
    timings["detect_ms"] = round(_now() - t0, 2)

    if fmt == "unknown":
        return None, None

    normalized = normalize_text(text)
    if fmt in {"csv", "tsv", "jsonl", "xml", "x12"}:
        raw_for_stream = normalized.encode("utf-8")
    else:
        raw_for_stream = raw
    return fmt, raw_for_stream


def _resolve_column_map(
    source_columns: List[str],
    adapter: AdapterSpec,
    profile: Optional[MappingProfile],
    report: "ParseReport",
    warnings: List["RowWarning"],
) -> Tuple[Dict[str, str], Dict[str, str]]:
    """Given the source-column inventory, resolve the column_map and the
    per-canonical-field cell-transform overrides. Mutates report
    (auto_mapper_confidence, profile_id, profile_orphan_keys,
    column_map, unmapped_canonical, unmapped_source) and warnings in place.

    Returns (column_map, cell_overrides).
    """
    if profile is not None:
        from .normalize.headers import canonical_header
        source_by_canon = {canonical_header(c): c for c in source_columns}
        column_map: Dict[str, str] = {}
        orphan_keys: List[str] = []
        mapped_canonical: set = set()
        for profile_src_key, canonical_field in profile.column_map.items():
            actual_src = source_by_canon.get(canonical_header(profile_src_key))
            if actual_src is not None:
                column_map[actual_src] = canonical_field
                mapped_canonical.add(canonical_field)
            else:
                orphan_keys.append(profile_src_key)
                warnings.append(RowWarning(
                    row_index=-1, field=canonical_field,
                    code="profile_source_orphan",
                    message=(
                        f"Profile {profile.profile_id!r} expects source column "
                        f"{profile_src_key!r}, not found in this file. "
                        f"Canonical field {canonical_field!r} will be unmapped."
                    ),
                ))
        report.profile_id = profile.profile_id
        report.auto_mapper_confidence = profile.confidence
        report.profile_orphan_keys = sorted(orphan_keys)
        report.unmapped_canonical = sorted(
            c.name for c in adapter.canonical_columns
            if c.name not in mapped_canonical
        )
        mapped_source_canon = {canonical_header(s) for s in column_map.keys()}
        report.unmapped_source = sorted(
            c for c in source_columns
            if canonical_header(c) not in mapped_source_canon
        )
    else:
        proposal = propose_mapping(source_columns, adapter)
        column_map = dict(proposal.column_map)
        report.auto_mapper_confidence = proposal.average_confidence()
        report.unmapped_canonical = list(proposal.unmapped_canonical)
        report.unmapped_source = list(proposal.unmapped_source)

    report.column_map = dict(column_map)

    cell_overrides: Dict[str, str] = {}
    if profile is not None:
        for canonical_field, transform_id in (profile.cell_transforms or {}).items():
            if transform_id in ALLOWED_CELL_TRANSFORMS:
                cell_overrides[canonical_field] = transform_id

    return column_map, cell_overrides


def _transform_one_row(
    source_row: Dict[str, str],
    row_idx: int,
    adapter: AdapterSpec,
    column_map: Dict[str, str],
    cell_overrides: Dict[str, str],
    warnings: List["RowWarning"],
    constraint_failures: List["ConstraintFailure"],
    report: "ParseReport",
) -> StreamedRow:
    """Project one source row through column_map, coerce values, check
    constraints. Mutates warnings + constraint_failures + report in place.

    Returns a StreamedRow. canonical_row is None when the row was dropped.
    """
    warnings_before = len(warnings)
    ctx: dict = {"row_idx": row_idx, "filename": None}
    canonical_row: Dict[str, Any] = {}

    for source_col, canonical_field in column_map.items():
        try:
            col_spec = adapter.column(canonical_field)
        except KeyError:
            continue
        raw_value = source_row.get(source_col, "") or ""
        canonical_row[canonical_field] = _coerce_value(
            raw_value, col_spec, ctx, warnings, row_idx,
            type_override=cell_overrides.get(canonical_field),
        )

    for col in adapter.canonical_columns:
        if col.name not in canonical_row:
            canonical_row[col.name] = col.default

    sanitization = dict(ctx.get("_sanitization") or {})
    for field_name, source_label in sanitization.items():
        if source_label == "self_hashed":
            report.sanitization_self_hashed[field_name] = (
                report.sanitization_self_hashed.get(field_name, 0) + 1
            )

    missing_required = [
        c.name for c in adapter.canonical_columns
        if c.required and not canonical_row.get(c.name)
    ]
    if missing_required:
        report.rows_dropped_required_missing += 1
        for f in missing_required:
            warnings.append(RowWarning(
                row_index=row_idx, field=f, code="missing_required",
            ))
        return StreamedRow(
            row_idx=row_idx, canonical_row=None,
            sanitization=sanitization,
            warning_codes=[w.code for w in warnings[warnings_before:]],
            drop_reason="missing_required",
        )

    constraint_violations = []
    for constraint in adapter.constraints:
        err = _check_constraint(canonical_row, constraint)
        if err:
            constraint_violations.append(err)
            constraint_failures.append(ConstraintFailure(
                row_index=row_idx, constraint_kind=constraint.kind, message=err,
            ))
    if constraint_violations:
        report.rows_dropped_constraint_failure += 1
        return StreamedRow(
            row_idx=row_idx, canonical_row=None,
            sanitization=sanitization,
            warning_codes=[w.code for w in warnings[warnings_before:]],
            drop_reason="constraint_failure",
        )

    return StreamedRow(
        row_idx=row_idx, canonical_row=canonical_row,
        sanitization=sanitization,
        warning_codes=[w.code for w in warnings[warnings_before:]],
        drop_reason=None,
    )


def iter_pipeline(
    raw: bytes,
    adapter: AdapterSpec,
    *,
    profile: Optional[MappingProfile] = None,
) -> Iterator[StreamedRow]:
    """Streaming variant of :func:`run_pipeline`.

    Yields one :class:`StreamedRow` per source row, transforming and
    validating each row as it arrives without ever materializing the
    full source-row list. Memory during the row-transform stage is
    bounded by the per-row dict size — independent of input file size.

    Use this when applying a large file via a writer that consumes
    rows incrementally. The diff-engine path still wants the
    materialized list, so :func:`run_pipeline` remains the right
    entry point there.

    The streaming variant deliberately does NOT enforce the row
    policy cap (``SPIRE_UIS_MAX_ROWS``) — streaming consumers are
    expected to have their own per-output bounds. Use
    :func:`run_pipeline` when you want the cap.

    JSONL files trigger a two-pass key-union over the input bytes
    (UIS-37 union semantics preserved). Other formats use a single
    pass with the first row's keys as the source-column inventory.
    """
    report = ParseReport()
    warnings: List[RowWarning] = []
    constraint_failures: List[ConstraintFailure] = []
    timings: Dict[str, float] = {}

    fmt, raw_for_stream = _decode_and_detect_format(raw, adapter, report, warnings, timings)
    if fmt is None or raw_for_stream is None:
        return

    fixed_width_spec = getattr(adapter, "fixed_width_spec", None)
    x12_spec = getattr(adapter, "x12_spec", None)

    if fmt == "jsonl":
        # UIS-37 — JSONL is per-row freeform; a key absent on row 0 may
        # appear on row N. Two-pass over bytes (cheap; bytes already in
        # memory) so the auto-mapper sees the full key universe.
        seen_columns: List[str] = []
        seen_set: set = set()
        try:
            for row in stream_rows(raw_for_stream, fmt, fixed_width_spec=fixed_width_spec, x12_spec=x12_spec):
                for k in row.keys():
                    if k not in seen_set:
                        seen_set.add(k)
                        seen_columns.append(k)
        except Exception:
            return
        source_columns = seen_columns
        if not source_columns:
            return
        column_map, cell_overrides = _resolve_column_map(
            source_columns, adapter, profile, report, warnings,
        )
        for row_idx, source_row in enumerate(stream_rows(
            raw_for_stream, fmt, fixed_width_spec=fixed_width_spec, x12_spec=x12_spec,
        )):
            yield _transform_one_row(
                source_row, row_idx, adapter, column_map, cell_overrides,
                warnings, constraint_failures, report,
            )
        return

    # All other formats: single pass. Peek the first row to discover
    # source columns, then chain it back into the iterator so we don't
    # have to re-stream.
    try:
        stream = stream_rows(
            raw_for_stream, fmt,
            fixed_width_spec=fixed_width_spec, x12_spec=x12_spec,
        )
        first_row = next(stream, None)
    except DuplicateHeaderError:
        return
    except Exception:
        return
    if first_row is None:
        return

    source_columns = list(first_row.keys())
    column_map, cell_overrides = _resolve_column_map(
        source_columns, adapter, profile, report, warnings,
    )
    for row_idx, source_row in enumerate(_iter_chain([first_row], stream)):
        yield _transform_one_row(
            source_row, row_idx, adapter, column_map, cell_overrides,
            warnings, constraint_failures, report,
        )


def run_pipeline(
    raw: bytes,
    adapter: AdapterSpec,
    *,
    profile: Optional[MappingProfile] = None,
) -> PipelineResult:
    """Run the full ingest pipeline.

    Parameters
    ----------
    raw
        File bytes as uploaded.
    adapter
        Declarative AdapterSpec for the source. Determines target
        entity, expected canonical columns, transforms, sensitive
        fields, primary/fallback keys, and constraints.
    profile
        Optional pre-confirmed MappingProfile. When provided, its
        column_map is used and confidence is set to 1.0. When None,
        the auto-mapper proposes a mapping from header similarity.

    Returns
    -------
    PipelineResult with canonical rows, ParseReport, per-row
    warnings, and per-row constraint failures.

    Implementation notes (UIS-P6.4 streaming refactor):
        * Source rows are NOT materialized into an intermediate list.
          Each row flows from the format streamer through transform +
          validate before the next row is read. Memory during the
          row-transform stage is bounded by per-row dict size,
          independent of file size.
        * The materialized output (``canonical_rows``,
          ``sanitization_per_row``, ``warnings_per_row``) is kept for
          callers that want the full set (the diff engine and route
          preview depend on it). Use :func:`iter_pipeline` to avoid
          this last buffer if you have a writer that consumes rows
          incrementally.
        * The row count cap (``SPIRE_UIS_MAX_ROWS``) is now a soft
          policy — set to 0 to disable. It catches operator errors
          (wrong source pointed at the adapter) rather than guarding
          against OOM, which the streaming refactor handles
          structurally.
    """
    report = ParseReport()
    warnings: List[RowWarning] = []
    constraint_failures: List[ConstraintFailure] = []
    timings: Dict[str, float] = {}

    def _now() -> float:
        return time.perf_counter() * 1000.0

    # 1. Decode + format detect (mutates report/warnings/timings).
    fmt, raw_for_stream = _decode_and_detect_format(raw, adapter, report, warnings, timings)
    if fmt is None or raw_for_stream is None:
        report.timings_ms = timings
        return PipelineResult(rows=[], report=report, warnings=warnings, constraint_failures=constraint_failures)

    fixed_width_spec = getattr(adapter, "fixed_width_spec", None)
    x12_spec = getattr(adapter, "x12_spec", None)
    max_rows = _max_rows_per_pipeline()  # 0 disables the cap

    # 2. Resolve source columns. JSONL needs a key-union pre-pass
    #    (UIS-37); other formats use the first row as the header.
    t0 = _now()
    source_columns: List[str] = []
    primed_first_row: Optional[Dict[str, str]] = None

    try:
        if fmt == "jsonl":
            seen_set: set = set()
            for row in stream_rows(
                raw_for_stream, fmt,
                fixed_width_spec=fixed_width_spec, x12_spec=x12_spec,
            ):
                for k in row.keys():
                    if k not in seen_set:
                        seen_set.add(k)
                        source_columns.append(k)
        else:
            stream = stream_rows(
                raw_for_stream, fmt,
                fixed_width_spec=fixed_width_spec, x12_spec=x12_spec,
            )
            primed_first_row = next(stream, None)
            if primed_first_row is not None:
                source_columns = list(primed_first_row.keys())
            # Note: we don't drain the rest here — the transform
            # loop below re-streams (or chains in primed_first_row)
            # so we keep memory bounded.
    except DuplicateHeaderError as e:
        # UIS-34 — distinct warning code so the operator gets actionable
        # detail ("dedup TAMCN in your export") rather than a generic
        # "format_stream_error".
        warnings.append(RowWarning(
            row_index=-1, field="", code="duplicate_header_columns",
            message=str(e)[:300],
        ))
        timings["stream_ms"] = round(_now() - t0, 2)
        report.timings_ms = timings
        return PipelineResult(rows=[], report=report, warnings=warnings, constraint_failures=constraint_failures)
    except Exception as e:  # noqa: BLE001
        warnings.append(RowWarning(
            row_index=-1, field="", code="format_stream_error",
            message=str(e)[:200],
        ))
        timings["stream_ms"] = round(_now() - t0, 2)
        report.timings_ms = timings
        return PipelineResult(rows=[], report=report, warnings=warnings, constraint_failures=constraint_failures)
    timings["stream_ms"] = round(_now() - t0, 2)

    if not source_columns:
        report.timings_ms = timings
        return PipelineResult(rows=[], report=report, warnings=warnings, constraint_failures=constraint_failures)

    # 3. Resolve column mapping (UIS-26 / UIS-35 / UIS-36 logic
    #    extracted to _resolve_column_map).
    t0 = _now()
    column_map, cell_overrides = _resolve_column_map(
        source_columns, adapter, profile, report, warnings,
    )
    timings["map_ms"] = round(_now() - t0, 2)

    # 4. Stream-transform: read rows from the source iterator
    #    one at a time, project + transform + validate per row,
    #    accumulate the materialized output for the diff engine.
    t0 = _now()
    canonical_rows: List[Dict[str, Any]] = []
    sanitization_per_row: List[Dict[str, str]] = []
    warnings_per_row: List[List[str]] = []

    if fmt == "jsonl":
        # Re-stream from byte 0; bytes already in memory so cheap.
        row_iter: Iterable[Dict[str, str]] = stream_rows(
            raw_for_stream, fmt,
            fixed_width_spec=fixed_width_spec, x12_spec=x12_spec,
        )
    else:
        # Chain primed_first_row back into the original iterator so
        # we don't have to re-stream non-JSONL formats. xlsx in
        # particular is expensive to re-open via openpyxl.
        # primed_first_row may be None only when source_columns
        # is empty, which we already short-circuited above.
        row_iter = _iter_chain([primed_first_row] if primed_first_row is not None else [], stream)

    rows_total = 0
    try:
        for row_idx, source_row in enumerate(row_iter):
            if max_rows and row_idx >= max_rows:
                # Soft policy cap exceeded. Streaming consumers don't
                # need this guard; here it catches operator-pointed-
                # at-wrong-source errors.
                raise PipelineRowLimitExceeded(limit=max_rows, observed=row_idx + 1)
            rows_total += 1

            streamed = _transform_one_row(
                source_row, row_idx, adapter, column_map, cell_overrides,
                warnings, constraint_failures, report,
            )
            if streamed.canonical_row is not None:
                canonical_rows.append(streamed.canonical_row)
                sanitization_per_row.append(streamed.sanitization)
                warnings_per_row.append(streamed.warning_codes)
                report.rows_kept += 1
    except PipelineRowLimitExceeded:
        raise
    except DuplicateHeaderError as e:
        warnings.append(RowWarning(
            row_index=-1, field="", code="duplicate_header_columns",
            message=str(e)[:300],
        ))
        timings["transform_ms"] = round(_now() - t0, 2)
        report.timings_ms = timings
        return PipelineResult(rows=[], report=report, warnings=warnings, constraint_failures=constraint_failures)
    except Exception as e:  # noqa: BLE001
        warnings.append(RowWarning(
            row_index=-1, field="", code="format_stream_error",
            message=str(e)[:200],
        ))
        timings["transform_ms"] = round(_now() - t0, 2)
        report.timings_ms = timings
        return PipelineResult(rows=[], report=report, warnings=warnings, constraint_failures=constraint_failures)

    report.rows_total = rows_total
    timings["transform_ms"] = round(_now() - t0, 2)

    # Aggregate warning count: unique row indices that hit at least
    # one warning. Surfaces "X% of rows had something to look at" in
    # the dry-run preview without double-counting per-cell warnings.
    rows_with_warnings = {w.row_index for w in warnings if w.row_index >= 0}
    report.rows_with_warnings = len(rows_with_warnings)
    report.warnings_count = len(warnings)
    report.constraint_failures_count = len(constraint_failures)
    report.timings_ms = timings

    return PipelineResult(
        rows=canonical_rows,
        report=report,
        warnings=warnings,
        constraint_failures=constraint_failures,
        sanitization_per_row=sanitization_per_row,
        warnings_per_row=warnings_per_row,
    )
