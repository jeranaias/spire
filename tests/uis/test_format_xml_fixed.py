"""XML + fixed-width format tests."""
from __future__ import annotations

import pytest

from backend.uis.formats import (
    FixedWidthColumn,
    FixedWidthSpec,
    detect_format,
    stream_fixed_width,
    stream_rows,
    stream_xml,
)


# ---------------------------------------------------------------------------
# XML detection + parsing
# ---------------------------------------------------------------------------


def test_detect_xml_with_xml_declaration():
    body = b'<?xml version="1.0" encoding="UTF-8"?><Records><Record/></Records>'
    assert detect_format(body) == "xml"


def test_detect_xml_without_declaration():
    body = b"<Records><Record><sr>1</sr></Record></Records>"
    assert detect_format(body) == "xml"


def test_detect_xml_is_not_csv_when_attributes_have_spaces():
    """Edge case: an XML attribute like `name="foo bar"` shouldn't
    push the detector into TSV territory just because the line has
    a space character."""
    body = b'<?xml version="1.0"?><Root><Item id="x y"/></Root>'
    assert detect_format(body) == "xml"


def test_xml_repeated_record_elements():
    body = b"""<?xml version="1.0"?>
    <Records>
        <Record>
            <SR_NUMBER>SR-1</SR_NUMBER>
            <PRIORITY>02</PRIORITY>
        </Record>
        <Record>
            <SR_NUMBER>SR-2</SR_NUMBER>
            <PRIORITY>03</PRIORITY>
        </Record>
    </Records>
    """
    rows = list(stream_xml(body))
    assert len(rows) == 2
    assert rows[0]["SR_NUMBER"] == "SR-1"
    assert rows[0]["PRIORITY"] == "02"
    assert rows[1]["SR_NUMBER"] == "SR-2"


def test_xml_with_namespace_strips_prefix():
    body = b"""<?xml version="1.0"?>
    <ns:Records xmlns:ns="http://niem.gov/example">
        <ns:Record>
            <ns:Field>value-1</ns:Field>
        </ns:Record>
    </ns:Records>
    """
    rows = list(stream_xml(body))
    assert len(rows) == 1
    assert rows[0]["Field"] == "value-1"


def test_xml_record_attributes_become_columns():
    body = b"""<?xml version="1.0"?>
    <Records>
        <Record id="42" status="open">
            <Note>Hello</Note>
        </Record>
    </Records>
    """
    rows = list(stream_xml(body))
    assert rows[0]["@attr_id"] == "42"
    assert rows[0]["@attr_status"] == "open"
    assert rows[0]["Note"] == "Hello"


def test_xml_malformed_returns_empty_stream():
    body = b"<Records><unclosed"
    rows = list(stream_xml(body))
    assert rows == []


def test_xml_through_stream_rows_dispatch():
    body = b"""<?xml version="1.0"?>
    <Records><Record><x>1</x></Record></Records>
    """
    rows = list(stream_rows(body, "xml"))
    assert rows == [{"x": "1"}]


# ---------------------------------------------------------------------------
# Fixed-width
# ---------------------------------------------------------------------------


def test_fixed_width_basic():
    spec = FixedWidthSpec(columns=[
        FixedWidthColumn(name="ASSET_ID", start=0, length=12),
        FixedWidthColumn(name="TAMCN", start=12, length=8),
        FixedWidthColumn(name="STATUS", start=20, length=4),
    ])
    body = (
        b"M21670-MTV  D1196   FMC \n"
        b"M21670-JLTV D1197   NMC \n"
    )
    rows = list(stream_fixed_width(body, spec))
    assert len(rows) == 2
    assert rows[0]["ASSET_ID"] == "M21670-MTV"
    assert rows[0]["TAMCN"] == "D1196"
    assert rows[0]["STATUS"] == "FMC"


def test_fixed_width_strip_modes():
    spec = FixedWidthSpec(columns=[
        FixedWidthColumn(name="A", start=0, length=5, strip="right"),
        FixedWidthColumn(name="B", start=5, length=5, strip="both"),
        FixedWidthColumn(name="C", start=10, length=5, strip="none"),
    ])
    rows = list(stream_fixed_width(b"abc    x   c    \n", spec))
    assert rows[0]["A"] == "abc"   # right-stripped trailing spaces
    assert rows[0]["B"] == "x"      # both-stripped surrounding spaces
    assert rows[0]["C"] == " c   "  # none — full slice preserved


def test_fixed_width_skip_leading_lines():
    """Banner lines at the top of mainframe exports get skipped."""
    spec = FixedWidthSpec(
        columns=[FixedWidthColumn(name="X", start=0, length=5)],
        skip_leading_lines=2,
    )
    body = (
        b"BANNER1\n"
        b"BANNER2\n"
        b"data1\n"
        b"data2\n"
    )
    rows = list(stream_fixed_width(body, spec))
    assert [r["X"] for r in rows] == ["data1", "data2"]


def test_fixed_width_record_length_mismatch_warns():
    spec = FixedWidthSpec(
        columns=[FixedWidthColumn(name="X", start=0, length=5)],
        record_length=10,
    )
    body = b"shortrec\n"  # length 8, expected 10
    rows = list(stream_fixed_width(body, spec))
    assert "_record_length_mismatch" in rows[0]


def test_fixed_width_skips_blank_lines():
    spec = FixedWidthSpec(columns=[FixedWidthColumn(name="X", start=0, length=3)])
    body = b"abc\n\nxyz\n"
    rows = list(stream_fixed_width(body, spec))
    assert [r["X"] for r in rows] == ["abc", "xyz"]


def test_fixed_width_requires_columns():
    spec = FixedWidthSpec(columns=[])
    with pytest.raises(ValueError, match="at least one column"):
        list(stream_fixed_width(b"data\n", spec))


def test_fixed_width_through_stream_rows_dispatch():
    spec = FixedWidthSpec(columns=[
        FixedWidthColumn(name="A", start=0, length=3),
    ])
    body = b"abc\nxyz\n"
    rows = list(stream_rows(body, "fixed_width", fixed_width_spec=spec))
    assert [r["A"] for r in rows] == ["abc", "xyz"]


def test_fixed_width_through_stream_rows_requires_spec():
    with pytest.raises(ValueError, match="fixed_width_spec"):
        list(stream_rows(b"data\n", "fixed_width"))


# ---------------------------------------------------------------------------
# Adapter format_hint plumbed through pipeline
# ---------------------------------------------------------------------------


def test_pipeline_uses_format_hint_for_fixed_width():
    """An adapter with format_hint='fixed_width' + fixed_width_spec
    drives the pipeline through the fixed-width stream regardless
    of what auto-detection would say."""
    from backend.uis.adapters.spec import AdapterSpec, ColumnSpec
    from backend.uis.pipeline import run_pipeline

    spec = FixedWidthSpec(columns=[
        FixedWidthColumn(name="ASSET_ID", start=0, length=10),
        FixedWidthColumn(name="STATUS", start=10, length=4),
    ])
    adapter = AdapterSpec(
        id="test/legacy-mainframe",
        target_entity="Asset",
        canonical_columns=[
            ColumnSpec("asset_id", required=True, source_aliases=["ASSET_ID"]),
            ColumnSpec("current_status", source_aliases=["STATUS"]),
        ],
        format_hint="fixed_width",
        fixed_width_spec=spec,
    )
    body = (
        b"M21670-001FMC \n"
        b"M21670-002NMC \n"
    )
    result = run_pipeline(body, adapter)
    assert result.report.detected_format == "fixed_width"
    assert result.report.rows_kept == 2
    assert result.rows[0]["asset_id"] == "M21670-001"
    assert result.rows[0]["current_status"] == "FMC"


def test_pipeline_xml_end_to_end():
    """An XML adapter — auto-detection fires, no format_hint needed."""
    from backend.uis.adapters.spec import AdapterSpec, ColumnSpec
    from backend.uis.pipeline import run_pipeline

    adapter = AdapterSpec(
        id="test/sr-niem",
        target_entity="ServiceRequest",
        canonical_columns=[
            ColumnSpec("sr_number", source_aliases=["SR_NUMBER"]),
            ColumnSpec("priority", source_aliases=["PRIORITY"]),
        ],
    )
    body = b"""<?xml version="1.0"?>
    <Records>
        <Record>
            <SR_NUMBER>SR-100</SR_NUMBER>
            <PRIORITY>02</PRIORITY>
        </Record>
        <Record>
            <SR_NUMBER>SR-200</SR_NUMBER>
            <PRIORITY>03</PRIORITY>
        </Record>
    </Records>
    """
    result = run_pipeline(body, adapter)
    assert result.report.detected_format == "xml"
    assert result.report.rows_kept == 2
    assert result.rows[0]["sr_number"] == "SR-100"
    assert result.rows[1]["priority"] == "03"
