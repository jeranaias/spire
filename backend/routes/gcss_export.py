"""GCSS-MC schema-parity CSV exports (WP-5).

Three endpoints emit the canonical SPIRE dataset back out in the exact
on-the-wire shape of the real GCSS-MC sanitized export:

  * ``GET /api/gcss/export/sr_header.csv``   (12 columns)
  * ``GET /api/gcss/export/sr_parts.csv``    (6 columns)
  * ``GET /api/gcss/export/due_in.csv``      (82 columns)

Sensitive identifiers are hashed via the deterministic cross-export
cache in ``backend.integrations.gcss_hash`` so the same source value
appears identically across all three exports (e.g. ``SR_NUMBER`` joins
header rows to parts rows to due-in rows).

The 12 / 6 / 82 column counts and ordering match
``tmp/gcss-mc/hashed_header.csv``, ``hashed_sr_parts.csv``, and
``hashed_due_in.csv`` byte-for-byte at the header row. The
schema-alignment work order text references "67-column due-in", which
predates the actual export shipped with the demo file; the production
file ships 82 columns and the export here mirrors that observed shape
verbatim.
"""
from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, Query

from .integrations import (
    _GCSS_DUE_IN_COLUMNS,
    _GCSS_HEADER_COLUMNS,
    _GCSS_PARTS_COLUMNS,
    _csv_response,
    _row_for_due_in,
    _row_for_header,
    _row_for_parts,
)
from ..state import get_dataset


router = APIRouter()


@router.get("/sr_header.csv")
async def export_sr_header(
    limit: int = Query(500, ge=1, le=10000),
    cm_only: bool = Query(True),
):
    ds = get_dataset()
    rows: List[Dict[str, Any]] = []
    for sr in ds.srs:
        if cm_only and "CM" not in (getattr(sr, "service_request_type", "") or "").upper():
            continue
        rows.append(_row_for_header(sr))
        if len(rows) >= limit:
            break
    return _csv_response(_GCSS_HEADER_COLUMNS, rows, "spire_sr_header.csv")


@router.get("/sr_parts.csv")
async def export_sr_parts(
    limit: int = Query(500, ge=1, le=10000),
):
    ds = get_dataset()
    rows: List[Dict[str, Any]] = []
    for sr in ds.srs:
        for req in getattr(sr, "requisitions", []) or []:
            rows.append(_row_for_parts(req))
            if len(rows) >= limit:
                break
        if len(rows) >= limit:
            break
    return _csv_response(_GCSS_PARTS_COLUMNS, rows, "spire_sr_parts.csv")


@router.get("/due_in.csv")
async def export_due_in(
    limit: int = Query(500, ge=1, le=10000),
    open_only: bool = Query(True),
):
    ds = get_dataset()
    rows: List[Dict[str, Any]] = []
    for sr in ds.srs:
        for req in getattr(sr, "requisitions", []) or []:
            if open_only and getattr(req, "received_date", None):
                continue
            rows.append(_row_for_due_in(req))
            if len(rows) >= limit:
                break
        if len(rows) >= limit:
            break
    return _csv_response(_GCSS_DUE_IN_COLUMNS, rows, "spire_due_in.csv")
