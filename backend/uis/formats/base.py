"""Format detection + row-stream dispatch.

`detect_format(head_bytes)` returns one of: "csv" / "tsv" / "jsonl"
/ "xlsx" / "unknown". `stream_rows(raw, format)` yields per-row
dicts (header column name → cell value as string).

The pipeline calls `stream_rows` once per upload and downstream
stages (header normalization, mapping, transforms) consume the row
iterator without needing to know which format it came from.
"""
from __future__ import annotations

import csv
import io
import json
from typing import Dict, Iterable, Iterator


# A RowStream is an iterator of dicts. Each dict has the source
# column names as keys and raw string values. Type coercion happens
# downstream in the transforms layer.
RowStream = Iterator[Dict[str, str]]


def detect_format(head: bytes) -> str:
    """Sniff the first chunk of bytes for the file format.

    Returns one of: "csv", "tsv", "jsonl", "xlsx", "unknown".
    """
    if not head:
        return "unknown"
    # XLSX is a zip; check magic bytes
    if head[:4] == b"PK\x03\x04":
        return "xlsx"
    # JSONL: first non-whitespace byte is `{` and the line parses as JSON
    text_head = head[:4096].decode("utf-8", errors="replace")
    stripped = text_head.lstrip()
    if stripped.startswith("{"):
        first_line = stripped.split("\n", 1)[0]
        try:
            json.loads(first_line)
            return "jsonl"
        except json.JSONDecodeError:
            pass
    # CSV vs TSV — count delimiter occurrences in first line
    first_line = text_head.split("\n", 1)[0]
    tabs = first_line.count("\t")
    commas = first_line.count(",")
    if tabs > commas and tabs >= 2:
        return "tsv"
    if commas >= 1:
        return "csv"
    return "unknown"


def stream_rows(raw: bytes, fmt: str) -> RowStream:
    """Dispatch to the format-specific row streamer."""
    if fmt == "csv":
        return _stream_csv(raw, delimiter=",")
    if fmt == "tsv":
        return _stream_csv(raw, delimiter="\t")
    if fmt == "jsonl":
        return _stream_jsonl(raw)
    if fmt == "xlsx":
        return _stream_xlsx(raw)
    raise ValueError(f"Unknown or unsupported format: {fmt!r}")


# ---------------------------------------------------------------------------
# CSV / TSV
# ---------------------------------------------------------------------------


def _stream_csv(raw: bytes, *, delimiter: str) -> RowStream:
    """Stream CSV/TSV rows. Delegates to Python's stdlib csv module
    after decoding to UTF-8. Caller is responsible for normalizing
    bytes via `backend.uis.normalize.encoding.decode_bytes` first if
    encoding is suspect.
    """
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("cp1252", errors="replace")
    if text.startswith("﻿"):
        text = text[1:]  # strip BOM that survived decode
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    for row in reader:
        # csv.DictReader yields Optional[str] values — coerce to ""
        yield {k: (v if v is not None else "") for k, v in row.items()}


# ---------------------------------------------------------------------------
# JSONL
# ---------------------------------------------------------------------------


def _stream_jsonl(raw: bytes) -> RowStream:
    """One row per line, each line a JSON object."""
    text = raw.decode("utf-8", errors="replace")
    if text.startswith("﻿"):
        text = text[1:]
    for line_idx, line in enumerate(text.splitlines(), start=1):
        s = line.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except json.JSONDecodeError:
            # Skip unparseable lines; the pipeline's validation stage
            # surfaces a per-row warning if this is unexpected.
            continue
        if not isinstance(obj, dict):
            continue
        yield {k: ("" if v is None else str(v)) for k, v in obj.items()}


# ---------------------------------------------------------------------------
# XLSX
# ---------------------------------------------------------------------------


def _stream_xlsx(raw: bytes) -> RowStream:
    """Read the first sheet of an XLSX as rows.

    Requires `openpyxl` — declared as an optional dep so the rest of
    the UIS package stays import-safe on a minimal install. If the
    dep isn't present, callers see a clear error at upload time
    rather than at import time.
    """
    try:
        import openpyxl  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "XLSX ingest requires `openpyxl`. Install it: pip install openpyxl"
        ) from e
    wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    ws = wb.active
    rows = ws.iter_rows(values_only=True)
    try:
        header = list(next(rows))
    except StopIteration:
        return iter([])
    header = [str(h) if h is not None else "" for h in header]
    out = []
    for row in rows:
        d = {}
        for i, cell in enumerate(row):
            key = header[i] if i < len(header) else f"col_{i}"
            if cell is None:
                d[key] = ""
            else:
                d[key] = str(cell)
        out.append(d)
    return iter(out)
