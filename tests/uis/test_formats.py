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
