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
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Callable, Dict, List, Optional


# Hard cap on rows per pipeline run. Default 500k — a full-MEF ECP
# is ~50k assets so this is 10x headroom. Override via env for
# scaled-up deployments. The cap is enforced at the row-stream
# stage so we don't materialize a multi-million-row CSV in RAM
# and OOM the box.
DEFAULT_MAX_ROWS = 500_000


def _max_rows_per_pipeline() -> int:
    raw = (os.environ.get("SPIRE_UIS_MAX_ROWS") or "").strip()
    if not raw:
        return DEFAULT_MAX_ROWS
    try:
        n = int(raw)
        return n if n > 0 else DEFAULT_MAX_ROWS
    except ValueError:
        return DEFAULT_MAX_ROWS


class PipelineRowLimitExceeded(Exception):
    """Raised when the file has more rows than the pipeline cap.

    Surfaced as HTTP 413 by the route layer so the operator gets a
    clear "file too big — split it or raise SPIRE_UIS_MAX_ROWS".
    """

    def __init__(self, *, limit: int, observed: int):
        self.limit = limit
        self.observed = observed
        super().__init__(
            f"Row count {observed} exceeds pipeline cap {limit}. "
            f"Split the file or raise SPIRE_UIS_MAX_ROWS."
        )

from .adapters.spec import AdapterSpec, ColumnSpec, RowConstraint
from .formats import detect_format, stream_rows
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
    column_map: Dict[str, str] = field(default_factory=dict)
    auto_mapper_confidence: float = 0.0
    profile_id: Optional[str] = None
    unmapped_canonical: List[str] = field(default_factory=list)
    unmapped_source: List[str] = field(default_factory=list)
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
            "sanitization_self_hashed": dict(self.sanitization_self_hashed),
            "constraint_failures_count": self.constraint_failures_count,
            "warnings_count": self.warnings_count,
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


def _coerce_value(raw: str, col: ColumnSpec, ctx: dict, warnings: List[RowWarning], row_idx: int) -> Any:
    """Apply the column's declared transform to a raw cell value.

    Returns the coerced value (possibly None for missing/unparseable),
    appending a RowWarning when coercion fails on a non-empty input.
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

    if col.type == "str":
        s = (raw or "").strip()
        return s if s else col.default
    if col.type == "int":
        v = parse_int(raw)
        if v is None and (raw or "").strip():
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="int_unparseable",
                raw_value=str(raw)[:200],
            ))
        return v if v is not None else col.default
    if col.type == "float":
        v = parse_float(raw)
        if v is None and (raw or "").strip():
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="float_unparseable",
                raw_value=str(raw)[:200],
            ))
        return v if v is not None else col.default
    if col.type == "bool":
        v = parse_bool(raw)
        if v is None and (raw or "").strip():
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="bool_unparseable",
                raw_value=str(raw)[:200],
            ))
        return v if v is not None else col.default
    if col.type == "date":
        v = parse_date(raw)
        if v is None and (raw or "").strip():
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="date_unparseable",
                raw_value=str(raw)[:200],
            ))
        return v if v is not None else col.default
    if col.type == "date_oracle":
        v = parse_date_oracle(raw)
        if v is None and (raw or "").strip():
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="date_oracle_unparseable",
                raw_value=str(raw)[:200],
            ))
        return v if v is not None else col.default
    if col.type == "date_excel":
        v = parse_date_excel(raw)
        if v is None and (raw or "").strip():
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="date_excel_unparseable",
                raw_value=str(raw)[:200],
            ))
        return v if v is not None else col.default
    if col.type == "datetime":
        v = parse_datetime(raw)
        if v is None and (raw or "").strip():
            warnings.append(RowWarning(
                row_index=row_idx, field=col.name, code="datetime_unparseable",
                raw_value=str(raw)[:200],
            ))
        return v if v is not None else col.default
    if col.type == "enum":
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
# Public entrypoint
# ---------------------------------------------------------------------------


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
    """
    report = ParseReport()
    warnings: List[RowWarning] = []
    constraint_failures: List[ConstraintFailure] = []

    # 1. Decode + format detect
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
    fmt = detect_format(raw[:4096])
    report.detected_format = fmt

    if fmt == "unknown":
        return PipelineResult(rows=[], report=report, warnings=warnings, constraint_failures=constraint_failures)

    # Re-encode normalized text into bytes for stream_rows
    normalized = normalize_text(text)
    if fmt in {"csv", "tsv", "jsonl"}:
        raw_for_stream = normalized.encode("utf-8")
    else:
        # XLSX is binary; pass through original
        raw_for_stream = raw

    # 2. Stream rows. Walk the iterator manually so we can short-
    #    circuit on the row cap before materializing more memory
    #    than the pipeline budget allows. The cap protects against
    #    OOM on very large uploads — a 10M-row CSV at ~200 bytes/row
    #    is 2GB of dict objects in Python; we'd rather reject early
    #    with 413 than tip the whole backend over.
    max_rows = _max_rows_per_pipeline()
    source_rows: List[Dict[str, str]] = []
    try:
        stream = stream_rows(raw_for_stream, fmt)
        for row in stream:
            source_rows.append(row)
            if len(source_rows) > max_rows:
                # Drain & raise — the route catches this and 413s.
                raise PipelineRowLimitExceeded(limit=max_rows, observed=max_rows + 1)
    except PipelineRowLimitExceeded:
        raise
    except Exception as e:  # noqa: BLE001
        warnings.append(RowWarning(
            row_index=-1, field="", code="format_stream_error",
            message=str(e)[:200],
        ))
        return PipelineResult(rows=[], report=report, warnings=warnings, constraint_failures=constraint_failures)

    report.rows_total = len(source_rows)
    if not source_rows:
        return PipelineResult(rows=[], report=report, warnings=warnings, constraint_failures=constraint_failures)

    # 3. Determine column mapping
    source_columns = list(source_rows[0].keys())
    if profile is not None:
        # UIS-26 — match profile keys against source columns using
        # canonical-form comparison so a profile saved with "TAMCN"
        # still matches a file whose header is "tamcn" (or vice
        # versa, or "Tamcn", or "TAMCN_Code" if that variant was
        # also confirmed). Look up by canonical key, store the
        # ACTUAL source-column name in the effective column_map
        # so downstream stages still index source_row correctly.
        from .normalize.headers import canonical_header
        source_by_canon = {canonical_header(c): c for c in source_columns}
        column_map = {}
        for profile_src_key, canonical_field in profile.column_map.items():
            actual_src = source_by_canon.get(canonical_header(profile_src_key))
            if actual_src is not None:
                column_map[actual_src] = canonical_field
        report.profile_id = profile.profile_id
        report.auto_mapper_confidence = profile.confidence
    else:
        proposal = propose_mapping(source_columns, adapter)
        column_map = dict(proposal.column_map)
        report.auto_mapper_confidence = proposal.average_confidence()
        report.unmapped_canonical = list(proposal.unmapped_canonical)
        report.unmapped_source = list(proposal.unmapped_source)

    report.column_map = dict(column_map)

    # 4. Per-row project + transform + validate
    canonical_rows: List[Dict[str, Any]] = []
    sanitization_per_row: List[Dict[str, str]] = []
    warnings_per_row: List[List[str]] = []
    for row_idx, source_row in enumerate(source_rows):
        ctx: dict = {"row_idx": row_idx, "filename": None}
        warnings_before = len(warnings)
        canonical_row: Dict[str, Any] = {}
        for source_col, canonical_field in column_map.items():
            try:
                col_spec = adapter.column(canonical_field)
            except KeyError:
                # mapping references a field not on the spec — skip
                continue
            raw_value = source_row.get(source_col, "") or ""
            canonical_row[canonical_field] = _coerce_value(
                raw_value, col_spec, ctx, warnings, row_idx,
            )

        # Defaults for unmapped canonical columns
        for col in adapter.canonical_columns:
            if col.name not in canonical_row:
                canonical_row[col.name] = col.default

        # Sanitization counts (aggregate) + per-row labels (parallel
        # to the row list so callers like the legacy route handler
        # can reconstruct ParsedAssetRow.serial_number_source).
        sanitization = dict(ctx.get("_sanitization") or {})
        for field_name, source_label in sanitization.items():
            if source_label == "self_hashed":
                report.sanitization_self_hashed[field_name] = (
                    report.sanitization_self_hashed.get(field_name, 0) + 1
                )

        # 5. Required-field check
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
            continue

        # 6. Cross-field constraints
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
            continue

        canonical_rows.append(canonical_row)
        sanitization_per_row.append(sanitization)
        warnings_per_row.append([w.code for w in warnings[warnings_before:]])
        report.rows_kept += 1

    # Aggregate warning count: unique row indices that hit at least
    # one warning. Surfaces "X% of rows had something to look at" in
    # the dry-run preview without double-counting per-cell warnings.
    rows_with_warnings = {w.row_index for w in warnings if w.row_index >= 0}
    report.rows_with_warnings = len(rows_with_warnings)
    report.warnings_count = len(warnings)
    report.constraint_failures_count = len(constraint_failures)

    return PipelineResult(
        rows=canonical_rows,
        report=report,
        warnings=warnings,
        constraint_failures=constraint_failures,
        sanitization_per_row=sanitization_per_row,
        warnings_per_row=warnings_per_row,
    )
