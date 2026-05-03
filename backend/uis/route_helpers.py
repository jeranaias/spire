"""Bridge helpers between UIS pipeline output and legacy adapter shapes.

The diff engine + apply path in `backend/integrations/pulse_gcss_*` were
written against the legacy `ParsedAssetRow` / `ParsedUtilizationRow`
dataclasses. The UIS pipeline produces canonical-row dicts; these
helpers convert dicts → legacy dataclasses so the existing routes can
use `run_pipeline` underneath without touching the diff/apply engines.

When Phase 2 lands the LLM mapper, the diff engine will move to
canonical-dict shape directly and these shims retire.
"""
from __future__ import annotations

from typing import Any, Dict, List

from .pipeline import PipelineResult


def to_parsed_asset_rows(result: PipelineResult) -> List[Any]:
    """Project pipeline output → legacy ParsedAssetRow list.

    Used by the ECP route — the diff engine consumes
    backend.integrations.pulse_gcss_ecp_adapter.ParsedAssetRow.
    """
    # Late-bind so this module stays import-safe if the legacy
    # adapter is ever removed.
    from ..integrations.pulse_gcss_ecp_adapter import ParsedAssetRow

    out: List[ParsedAssetRow] = []
    for idx, row in enumerate(result.rows):
        sanitization = (
            result.sanitization_per_row[idx]
            if idx < len(result.sanitization_per_row) else {}
        )
        warnings_codes = (
            result.warnings_per_row[idx]
            if idx < len(result.warnings_per_row) else []
        )
        parsed = ParsedAssetRow(
            tamcn=row.get("tamcn", "") or "",
            nsn=row.get("nsn", "") or "",
            serial_number=row.get("serial_number", "") or "",
            serial_number_source=sanitization.get("serial_number", "missing"),
            nomenclature=row.get("nomenclature", "") or "",
            owner_uic=row.get("owner_uic", "") or "",
            owner_uic_source=sanitization.get("owner_uic", "missing"),
            allowance_qty=row.get("allowance_qty") or 0,
            on_hand_qty=row.get("on_hand_qty") or 0,
            last_inventory_date=row.get("last_inventory_date"),
            equipment_type="",  # resolved upstream from TAMCN catalog
            _warnings=list(warnings_codes),
        )
        out.append(parsed)
    return out


def to_parsed_util_rows(result: PipelineResult) -> List[Any]:
    """Project pipeline output → legacy ParsedUtilizationRow list."""
    from ..integrations.pulse_gcss_util_adapter import ParsedUtilizationRow

    out: List[ParsedUtilizationRow] = []
    for idx, row in enumerate(result.rows):
        warnings_codes = (
            result.warnings_per_row[idx]
            if idx < len(result.warnings_per_row) else []
        )
        parsed = ParsedUtilizationRow(
            asset_id=row.get("asset_id", "") or "",
            reading_date=row.get("reading_date"),
            total_hours=row.get("current_hours"),
            total_miles=row.get("current_miles"),
            readiness_code=row.get("current_status", "") or "",
            reading_source=row.get("reading_source", "") or "",
            _warnings=list(warnings_codes),
        )
        out.append(parsed)
    return out


def map_pipeline_report_to_ecp_legacy(result: PipelineResult) -> Dict[str, Any]:
    """Project pipeline ParseReport → the legacy ECP report dict the
    /api/ingest/gcss-mc/ecp route returns. Keeps the route's
    JSON-response contract unchanged so frontend code doesn't move."""
    r = result.report
    return {
        "rows_total": r.rows_total,
        "rows_kept": r.rows_kept,
        "rows_with_warnings": r.rows_with_warnings,
        "rows_with_self_hashed_uic": r.sanitization_self_hashed.get("owner_uic", 0),
        "rows_with_self_hashed_serial": r.sanitization_self_hashed.get("serial_number", 0),
        "rows_missing_tamcn": sum(
            1 for w in result.warnings if w.code == "missing_tamcn"
        ),
        "rows_missing_serial": sum(
            1 for w in result.warnings if w.code == "missing_serial"
        ),
        "date_parse_failures": sum(
            1 for w in result.warnings
            if w.code in {"date_oracle_unparseable", "date_unparseable", "date_excel_unparseable"}
        ),
        "header_mismatch": False,  # pipeline auto-maps; mismatch surfaces via unmapped lists
        "header_missing_columns": list(r.unmapped_canonical),
        "header_extra_columns": list(r.unmapped_source),
    }


def map_pipeline_report_to_util_legacy(result: PipelineResult) -> Dict[str, Any]:
    """Project pipeline ParseReport → the legacy UTIL report dict."""
    r = result.report
    invalid_readiness = sum(
        1 for w in result.warnings if w.code == "enum_unknown_value" and w.field == "current_status"
    )
    unknown_source = sum(
        1 for w in result.warnings if w.code == "enum_unknown_value" and w.field == "reading_source"
    )
    return {
        "rows_total": r.rows_total,
        "rows_kept": r.rows_kept,
        "rows_with_warnings": r.rows_with_warnings,
        "rows_missing_asset_id": sum(
            1 for w in result.warnings if w.code == "missing_required" and w.field == "asset_id"
        ),
        "rows_missing_date": sum(
            1 for w in result.warnings if w.code == "missing_required" and w.field == "reading_date"
        ),
        "rows_with_invalid_readiness": invalid_readiness,
        "rows_with_unknown_source": unknown_source,
        "date_parse_failures": sum(
            1 for w in result.warnings if w.code == "date_oracle_unparseable"
        ),
        "numeric_parse_failures": sum(
            1 for w in result.warnings
            if w.code in {"int_unparseable", "float_unparseable"}
        ),
        "header_mismatch": False,
        "header_missing_columns": list(r.unmapped_canonical),
        "header_extra_columns": list(r.unmapped_source),
    }
