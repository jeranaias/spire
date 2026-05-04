"""Format detect + row-stream.

Each format module exports `detect(head: bytes) -> bool` and
`stream(raw: bytes) -> Iterable[dict]`. The pipeline detects the
format from the first kilobyte, then streams rows as dicts keyed by
header column name.

Today: CSV, TSV, JSONL. XLSX requires `openpyxl` (or similar) — we
land it as a stub that raises NotImplementedError until the dep is
added. PDF-table is intentionally out of scope for Phase 1.
"""
from __future__ import annotations

from .base import DuplicateHeaderError, RowStream, detect_format, stream_rows
from .fixed_width import FixedWidthColumn, FixedWidthSpec, stream_fixed_width
from .x12 import X12Spec, detect_x12, stream_x12
from .xml_format import stream_xml

__all__ = [
    "DuplicateHeaderError",
    "RowStream",
    "detect_format",
    "stream_rows",
    "FixedWidthColumn",
    "FixedWidthSpec",
    "stream_fixed_width",
    "stream_xml",
    "X12Spec",
    "stream_x12",
    "detect_x12",
]
