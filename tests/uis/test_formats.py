"""UIS formats — detect + stream_rows."""
from __future__ import annotations

import json

import pytest

from backend.uis.formats import detect_format, stream_rows


def test_detect_csv():
    head = b"col1,col2,col3\nfoo,bar,baz\n"
    assert detect_format(head) == "csv"


def test_detect_tsv():
    head = b"col1\tcol2\tcol3\nfoo\tbar\tbaz\n"
    assert detect_format(head) == "tsv"


def test_detect_jsonl():
    head = b'{"a": 1, "b": 2}\n{"a": 3, "b": 4}\n'
    assert detect_format(head) == "jsonl"


def test_detect_xlsx_magic():
    # XLSX is a zip; magic bytes are PK\x03\x04
    head = b"PK\x03\x04" + b"\x00" * 100
    assert detect_format(head) == "xlsx"


def test_detect_unknown():
    assert detect_format(b"") == "unknown"
    assert detect_format(b"\x00\x01\x02\x03") == "unknown"


def test_detect_csv_with_bom():
    head = b"\xef\xbb\xbfcol1,col2\nfoo,bar\n"
    # BOM doesn't change format detection
    assert detect_format(head) == "csv"


# ---------------------------------------------------------------------------
# CSV streaming
# ---------------------------------------------------------------------------


def test_stream_csv_rows():
    raw = b"a,b\n1,2\n3,4\n"
    rows = list(stream_rows(raw, "csv"))
    assert rows == [{"a": "1", "b": "2"}, {"a": "3", "b": "4"}]


def test_stream_csv_with_quoted_commas():
    raw = b'name,desc\nfoo,"hello, world"\n'
    rows = list(stream_rows(raw, "csv"))
    assert rows == [{"name": "foo", "desc": "hello, world"}]


def test_stream_csv_with_bom():
    raw = b"\xef\xbb\xbfa,b\n1,2\n"
    rows = list(stream_rows(raw, "csv"))
    assert rows == [{"a": "1", "b": "2"}]


def test_stream_csv_empty_yields_nothing():
    rows = list(stream_rows(b"a,b\n", "csv"))
    assert rows == []


# ---------------------------------------------------------------------------
# TSV streaming
# ---------------------------------------------------------------------------


def test_stream_tsv_rows():
    raw = b"a\tb\n1\t2\n3\t4\n"
    rows = list(stream_rows(raw, "tsv"))
    assert rows == [{"a": "1", "b": "2"}, {"a": "3", "b": "4"}]


# ---------------------------------------------------------------------------
# JSONL streaming
# ---------------------------------------------------------------------------


def test_stream_jsonl_rows():
    raw = b'{"a": 1, "b": "two"}\n{"a": 3, "b": "four"}\n'
    rows = list(stream_rows(raw, "jsonl"))
    assert len(rows) == 2
    assert rows[0]["a"] == "1"
    assert rows[0]["b"] == "two"


def test_stream_jsonl_skips_blank_lines():
    raw = b'\n{"a": 1}\n\n\n{"a": 2}\n'
    rows = list(stream_rows(raw, "jsonl"))
    assert len(rows) == 2


def test_stream_jsonl_skips_unparseable_lines():
    raw = b'{"a": 1}\n{this is not json}\n{"a": 2}\n'
    rows = list(stream_rows(raw, "jsonl"))
    assert len(rows) == 2  # Only the two valid lines


def test_stream_unknown_raises():
    with pytest.raises(ValueError):
        list(stream_rows(b"...", "fixed_width"))


# ---------------------------------------------------------------------------
# XLSX multi-sheet handling (UIS-19)
# ---------------------------------------------------------------------------


def _make_xlsx(sheets: list[tuple[str, list[list]]]) -> bytes:
    """Build an XLSX file in memory with named sheets + rows.

    Each sheet entry is (sheet_name, [[cell, cell, ...], ...]).
    First inner list is the header.
    """
    import io as _io
    import openpyxl  # type: ignore
    wb = openpyxl.Workbook()
    # Drop the default empty sheet, append ours by name
    default = wb.active
    wb.remove(default)
    for name, rows in sheets:
        ws = wb.create_sheet(title=name)
        for row in rows:
            ws.append(row)
    out = _io.BytesIO()
    wb.save(out)
    return out.getvalue()


def test_xlsx_single_sheet_round_trip():
    raw = _make_xlsx([
        ("Sheet1", [
            ["TAMCN", "NSN"],
            ["D1196", "2320-01-540-2480"],
            ["D0082", "2320-01-440-1234"],
        ]),
    ])
    rows = list(stream_rows(raw, "xlsx"))
    assert len(rows) == 2
    assert rows[0]["TAMCN"] == "D1196"


def test_xlsx_picks_largest_sheet_when_data_on_non_default():
    """Multi-sheet workbook with data on a non-default sheet —
    earlier code only read wb.active and silently missed everything."""
    raw = _make_xlsx([
        ("Notes", [["readme"], ["see Data sheet"]]),  # 1 data row
        ("Data", [
            ["TAMCN", "NSN", "SERIAL_NUMBER"],
            ["D1196", "NSN1", "S1"],
            ["D0082", "NSN2", "S2"],
            ["D1196", "NSN3", "S3"],
        ]),  # 3 data rows — should win
        ("Empty", []),
    ])
    rows = list(stream_rows(raw, "xlsx"))
    assert len(rows) == 3
    assert rows[0]["TAMCN"] == "D1196"
    assert rows[2]["SERIAL_NUMBER"] == "S3"


def test_xlsx_empty_workbook_yields_nothing():
    raw = _make_xlsx([("Empty", [])])
    rows = list(stream_rows(raw, "xlsx"))
    assert rows == []


def test_detect_csv_with_oracle_comment_header():
    """Oracle SQL*Plus spool exports prefix a `# Generated ...` line.
    Earlier the first-line comma count would be zero so the file
    fell through to 'unknown' and the rest of the pipeline silently
    refused to parse it."""
    head = b"# Generated 2026-04-26 by SQLPlus 19.10\n# Comment line 2\n\nTAMCN,NSN,SERIAL\nD1196,foo,bar\n"
    assert detect_format(head) == "csv"


def test_detect_tsv_with_oracle_comment_header():
    head = b"# Generated 2026-04-26\nCOL1\tCOL2\nfoo\tbar\n"
    assert detect_format(head) == "tsv"


def test_detect_2col_tsv():
    """A legitimate 2-column TSV ('ID\\tValue') has 1 tab on the
    header. Old threshold required ≥2 tabs and would misdetect
    as CSV-with-zero-commas → 'unknown'."""
    head = b"ID\tVALUE\n1\tfoo\n2\tbar\n"
    assert detect_format(head) == "tsv"


def test_detect_european_excel_semicolon_csv():
    """European Excel uses `;` as field delimiter (because `,` is
    decimal separator). Treat as CSV — the standard csv module
    parses it fine if the user passes the right delimiter; for
    autodetect we surface "csv"."""
    head = b"TAMCN;NSN;SERIAL\nD1196;foo;bar\n"
    assert detect_format(head) == "csv"


def test_csv_streamer_skips_comment_lines():
    raw = b"# Generated 2026-04-26\nTAMCN,NSN\nD1196,2320-01-540\n# trailing comment\nD0082,2320-01-440\n"
    rows = list(stream_rows(raw, "csv"))
    assert len(rows) == 2
    assert rows[0]["TAMCN"] == "D1196"
    assert rows[1]["TAMCN"] == "D0082"


def test_csv_streamer_skips_blank_lines_above_header():
    raw = b"\n\n\nTAMCN,NSN\nD1196,foo\n"
    rows = list(stream_rows(raw, "csv"))
    assert len(rows) == 1


def test_xlsx_format_detect_via_magic_bytes():
    """The PK\\x03\\x04 zip magic is what we sniff. Ensure
    actual openpyxl-generated XLSX hits the xlsx branch."""
    raw = _make_xlsx([("Sheet1", [["A"], ["1"]])])
    assert detect_format(raw[:64]) == "xlsx"
