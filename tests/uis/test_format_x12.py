"""EDI X12 format tests."""
from __future__ import annotations

import pytest

from backend.uis.formats import (
    X12Spec,
    detect_format,
    detect_x12,
    stream_rows,
    stream_x12,
)


# ---------------------------------------------------------------------------
# Helper: build a minimal X12 856 envelope
# ---------------------------------------------------------------------------


def _x12_856(*, line_segments_per_st: int = 2, num_st_blocks: int = 1) -> bytes:
    """Build an ISA/GS/ST...SE/GE/IEA envelope with a configurable
    number of LIN/SN1 line pairs in one or more transaction sets."""
    # ISA must be exactly 106 chars + segment terminator
    isa = (
        "ISA*00*          *00*          "
        "*ZZ*SENDER         *ZZ*RECEIVER       "
        "*260426*1330*U*00401*000000001*0*P*:~"
    )
    assert len(isa) == 106, f"ISA wrong length {len(isa)} (spec: 106 incl. terminator)"
    parts = [isa]
    parts.append("GS*SH*SENDER*RECEIVER*20260426*1330*1*X*004010~")
    for st_idx in range(num_st_blocks):
        parts.append(f"ST*856*{st_idx + 1:04d}~")
        parts.append(f"BSN*00*SHIPMT-{st_idx + 1}*20260426*1330~")
        parts.append("HL*1**S~")
        for i in range(line_segments_per_st):
            parts.append(f"LIN*{i + 1}*VC*N12345678{i}*MN*MFGR-PART-{i}~")
            parts.append(f"SN1**{(i + 1) * 5}*EA~")
        parts.append("SE*9*0001~")
    parts.append("GE*1*1~")
    parts.append("IEA*1*000000001~")
    return "".join(parts).encode("utf-8")


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


def test_detect_x12_recognizes_isa_header():
    body = _x12_856()
    assert detect_x12(body) is True
    assert detect_format(body) == "x12"


def test_detect_x12_negative_on_csv():
    assert detect_x12(b"col1,col2\n1,2\n") is False


# ---------------------------------------------------------------------------
# stream_x12 — basic 856
# ---------------------------------------------------------------------------


def test_stream_x12_yields_one_row_per_line_segment():
    spec = X12Spec(
        transaction_set_id="856",
        line_segment="LIN",
        include_segments=["BSN"],
    )
    body = _x12_856(line_segments_per_st=3)
    rows = list(stream_x12(body, spec))
    assert len(rows) == 3
    # Each row tagged with the transaction set
    for r in rows:
        assert r["ST_TRANSACTION_SET_ID"] == "856"
    # LIN elements appear positionally
    assert rows[0]["LIN_01"] == "1"     # assigned line number
    assert rows[0]["LIN_03"] == "N123456780"
    assert rows[1]["LIN_03"] == "N123456781"


def test_stream_x12_includes_sibling_segments():
    spec = X12Spec(
        transaction_set_id="856",
        line_segment="LIN",
        include_segments=["BSN", "SN1"],
    )
    body = _x12_856(line_segments_per_st=2)
    rows = list(stream_x12(body, spec))
    # BSN_02 is the shipment id from the same transaction set
    assert rows[0]["BSN_02"] == "SHIPMT-1"
    assert rows[1]["BSN_02"] == "SHIPMT-1"


def test_stream_x12_filters_to_transaction_set():
    """An envelope can carry multiple ST blocks. Spec for 856 must
    skip non-856 blocks even if they share segment ids."""
    # Build a 2-ST envelope where the second is 810
    body = _x12_856(line_segments_per_st=2, num_st_blocks=1)
    body_text = body.decode("utf-8")
    # Append an 810 block before the GE/IEA close
    insert_at = body_text.find("GE*1*1~")
    extra = (
        "ST*810*0002~"
        "BIG*20260426*INV-1*20260426*PO-1~"
        "IT1*1*5*EA*100*PE*VC*N12345678X~"
        "SE*4*0002~"
    )
    new_body = (body_text[:insert_at] + extra + body_text[insert_at:]).encode("utf-8")

    spec_856 = X12Spec(transaction_set_id="856", line_segment="LIN")
    rows_856 = list(stream_x12(new_body, spec_856))
    # 856 sees only its 2 LIN rows; ignores the 810's IT1
    assert len(rows_856) == 2

    spec_810 = X12Spec(transaction_set_id="810", line_segment="IT1")
    rows_810 = list(stream_x12(new_body, spec_810))
    assert len(rows_810) == 1
    assert rows_810[0]["ST_TRANSACTION_SET_ID"] == "810"
    # IT1*1*5*EA*100*PE*VC*N12345678X — IT1_06 = "VC", IT1_07 = "N12345678X"
    assert rows_810[0]["IT1_06"] == "VC"
    assert rows_810[0]["IT1_07"] == "N12345678X"


def test_stream_x12_element_names_overrides_default_keys():
    """Adapters can name elements semantically instead of positional."""
    spec = X12Spec(
        transaction_set_id="856",
        line_segment="LIN",
        element_names={
            "LIN": ["assigned_id", "id_qual_1", "product_id_1", "id_qual_2", "product_id_2"],
        },
    )
    rows = list(stream_x12(_x12_856(line_segments_per_st=1), spec))
    assert rows[0]["assigned_id"] == "1"
    assert rows[0]["product_id_1"] == "N123456780"
    assert rows[0]["product_id_2"] == "MFGR-PART-0"


def test_stream_x12_returns_empty_on_missing_isa():
    spec = X12Spec(transaction_set_id="856", line_segment="LIN")
    rows = list(stream_x12(b"not an x12 file", spec))
    assert rows == []


# ---------------------------------------------------------------------------
# Dispatch through stream_rows + pipeline
# ---------------------------------------------------------------------------


def test_stream_rows_x12_dispatch_requires_spec():
    body = _x12_856()
    with pytest.raises(ValueError, match="x12_spec"):
        list(stream_rows(body, "x12"))


def test_stream_rows_x12_round_trip():
    spec = X12Spec(transaction_set_id="856", line_segment="LIN")
    rows = list(stream_rows(_x12_856(line_segments_per_st=2), "x12", x12_spec=spec))
    assert len(rows) == 2


def test_pipeline_dispatches_to_x12_via_format_hint():
    """End-to-end through the pipeline. format_hint forces the
    x12 path; fixed_width_spec is irrelevant when x12_spec is the
    one passed."""
    from backend.uis.adapters.spec import AdapterSpec, ColumnSpec
    from backend.uis.pipeline import run_pipeline

    spec = X12Spec(
        transaction_set_id="856",
        line_segment="LIN",
        element_names={
            "LIN": ["assigned_id", "_q1", "product_id", "_q2", "_p2"],
        },
    )
    adapter = AdapterSpec(
        id="test/dla-856",
        target_entity="Asset",  # simplification — real DLA adapter would
                                  # target a Requisition entity
        canonical_columns=[
            ColumnSpec("asset_id", source_aliases=["product_id"]),
        ],
        format_hint="x12",
        x12_spec=spec,
    )
    body = _x12_856(line_segments_per_st=2)
    result = run_pipeline(body, adapter)
    assert result.report.detected_format == "x12"
    assert result.report.rows_kept == 2
    asset_ids = sorted(r["asset_id"] for r in result.rows)
    assert asset_ids == ["N123456780", "N123456781"]
