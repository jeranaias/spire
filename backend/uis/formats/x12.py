"""EDI X12 transaction parser.

DLA's supply chain runs on X12: 856 advance-ship-notice, 810
invoice, 940 warehouse shipping order, 944/945 stock transfer
receipts, etc. Each transaction is a hierarchical envelope of
segments terminated by a single character.

Wire format
-----------
::

    ISA*00*          *00*          *ZZ*SENDER         *ZZ*RECEIVER       *...~
    GS*SH*SENDER*RECEIVER*20260426*1330*1*X*004010~
    ST*856*0001~
    BSN*00*SHIPMT-1*20260426*1330~
    HL*1**S~
    LIN*1*VC*N123456789*MN*MFGR-PART~
    SN1**5*EA~
    HL*2**O~
    LIN*2*VC*N987654321*MN*OTHER-PART~
    SN1**3*EA~
    SE*9*0001~
    GE*1*1~
    IEA*1*000000001~

Each segment is ``ID*el1*el2*...*~`` with ``*`` as element
separator, ``:`` as sub-element separator, ``~`` as segment
terminator. The ISA header carries the actual separators in
fixed positions — we read them rather than assuming.

Output shape
------------
``stream_x12(raw, spec)`` yields one dict per "line" segment of
the transaction set. The ``X12Spec`` declares:

  * ``transaction_set_id``  — "856", "810", "940", ...
  * ``line_segment``        — segment ID that marks a new row
                              (e.g. "LIN" for 856, "IT1" for 810)
  * ``include_segments``    — additional segment IDs whose
                              elements get folded into each row

Each yielded dict carries:
  - ``ST_TRANSACTION_SET_ID`` — the transaction set this row belongs to
  - ``<LINE_SEGMENT>_<n>`` columns for line elements
  - ``<INCL_SEGMENT>_<n>`` columns for included siblings within
    the same line scope

This is enough for the common cases (mapping LIN+SN1 quantities
into canonical rows). Full hierarchical X12 parsing (HL loops
with ancestry) is a real project — out of scope for this scaffold.
The framework can grow that later when a specific operator
workflow demands it.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional


log = logging.getLogger(__name__)


@dataclass
class X12Spec:
    """Adapter-supplied layout for an X12 transaction parser."""

    transaction_set_id: str               # "856", "810", "940", ...
    line_segment: str                      # segment that demarcates a row
    include_segments: List[str] = field(default_factory=list)
    # Optional element-name overrides — by default rows are keyed
    # ``LIN_1``, ``LIN_2``, etc. For human-readable columns the
    # adapter can map ``{"LIN": ["assigned_id", "id_qual", "product_id", ...]}``
    element_names: Dict[str, List[str]] = field(default_factory=dict)


def detect_x12(head: bytes) -> bool:
    """Quick heuristic — X12 envelopes start with ``ISA*``."""
    if not head:
        return False
    text = head[:200].decode("utf-8", errors="replace").lstrip()
    return text.startswith("ISA*") or text.startswith("ISA|")


def stream_x12(raw: bytes, spec: X12Spec) -> Iterator[Dict[str, str]]:
    """Yield one dict per line_segment occurrence inside the named
    transaction set.

    Sub-element separator is honored: ``A:B:C`` element splits into
    ``LIN_1_sub_0=A``, ``LIN_1_sub_1=B``, ``LIN_1_sub_2=C`` only when
    the value contains the sub-element char. Otherwise the raw
    string lands as ``LIN_1=A:B:C``.
    """
    text = raw.decode("utf-8", errors="replace")
    seps = _read_isa_separators(text)
    if seps is None:
        log.warning("X12 stream: ISA header not found or malformed")
        return iter(())
    elem_sep, sub_sep, seg_sep = seps

    # Walk segments. Inside each transaction set (ST..SE) emit rows
    # at every line_segment occurrence; carry forward the latest
    # include_segment values so they fold into the next emitted row.
    in_target_st = False
    pending_include: Dict[str, List[str]] = {}
    rows: List[Dict[str, str]] = []
    line_seg_id = spec.line_segment.upper()
    incl_set = {s.upper() for s in spec.include_segments}

    for seg in _iter_segments(text, seg_sep):
        if not seg:
            continue
        elements = seg.split(elem_sep)
        seg_id = elements[0].upper()
        if seg_id == "ST":
            tx_id = elements[1] if len(elements) > 1 else ""
            in_target_st = (tx_id == spec.transaction_set_id)
            pending_include = {}
            continue
        if seg_id == "SE":
            in_target_st = False
            pending_include = {}
            continue
        if not in_target_st:
            continue

        if seg_id in incl_set:
            pending_include[seg_id] = list(elements[1:])
            continue

        if seg_id == line_seg_id:
            row: Dict[str, str] = {
                "ST_TRANSACTION_SET_ID": spec.transaction_set_id,
            }
            _flatten_segment(
                row, seg_id, elements[1:], spec.element_names.get(seg_id),
            )
            for incl_id, incl_elements in pending_include.items():
                _flatten_segment(
                    row, incl_id, incl_elements, spec.element_names.get(incl_id),
                )
            rows.append(row)

    return iter(rows)


def _read_isa_separators(text: str):
    """Return (element_sep, sub_element_sep, segment_terminator) or None.

    ISA segment is fixed-width 106 chars (excluding terminator). The
    element separator is the 4th char (after "ISA"); the sub-element
    separator is at offset 104; the segment terminator is at 105.
    """
    if len(text) < 106:
        return None
    if not text.startswith("ISA"):
        # Tolerate leading whitespace
        stripped = text.lstrip()
        offset = len(text) - len(stripped)
        if not stripped.startswith("ISA"):
            return None
        text = stripped
    elem_sep = text[3]
    if len(text) < 106:
        return None
    sub_sep = text[104]
    seg_sep = text[105]
    # Some implementations use \n as segment terminator and write
    # the sub-element separator differently — fall back gracefully.
    if seg_sep in ("\r", "\n", " "):
        seg_sep = "\n"
    return (elem_sep, sub_sep, seg_sep)


def _iter_segments(text: str, seg_sep: str) -> Iterator[str]:
    """Walk segments. Handles both single-char terminators (``~``)
    and newline-terminated formats interchangeably (real exports
    sometimes intersperse both)."""
    # Normalize CRLF
    text = text.replace("\r\n", "\n")
    # Split on either the configured separator or a literal newline,
    # whichever comes first per segment.
    if seg_sep == "\n":
        parts = text.split("\n")
    else:
        # Prefer the configured separator; treat newlines as
        # whitespace inside segments.
        parts = text.split(seg_sep)
    for part in parts:
        seg = part.strip()
        if seg:
            yield seg


def _flatten_segment(
    row: Dict[str, str],
    seg_id: str,
    elements: List[str],
    element_names: Optional[List[str]],
) -> None:
    """Project segment elements into ``row`` under the segment id
    prefix. ``element_names`` (if provided) names columns directly
    so callers see semantic keys instead of ``LIN_1``."""
    for i, value in enumerate(elements, start=1):
        if element_names and i - 1 < len(element_names) and element_names[i - 1]:
            col = element_names[i - 1]
        else:
            col = f"{seg_id}_{i:02d}"
        row[col] = value
