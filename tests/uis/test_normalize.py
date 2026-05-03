"""UIS normalize — encoding + headers."""
from __future__ import annotations

from backend.uis.normalize.encoding import (
    decode_bytes,
    is_low_confidence_encoding,
    normalize_text,
)
from backend.uis.normalize.headers import (
    canonical_header,
    header_token_set,
    jaccard_similarity,
)


# ---------------------------------------------------------------------------
# Encoding
# ---------------------------------------------------------------------------


def test_decode_strips_utf8_bom():
    raw = b"\xef\xbb\xbfTAMCN,SR_NUMBER\n"
    text, enc = decode_bytes(raw)
    assert not text.startswith("﻿")
    assert text == "TAMCN,SR_NUMBER\n"
    assert enc == "utf-8-sig"


def test_decode_plain_utf8():
    text, enc = decode_bytes(b"hello world")
    assert text == "hello world"
    assert enc == "utf-8"


def test_decode_falls_back_to_cp1252():
    # Smart quote in cp1252 is 0x93/0x94; not valid UTF-8
    raw = b"col1,col2\n\x93value\x94,foo\n"
    text, enc = decode_bytes(raw)
    assert "col1" in text
    assert enc in {"cp1252", "latin-1?"} or enc.startswith("charset_normalizer:")


def test_decode_utf16_le_with_bom():
    """Excel "Save as Unicode" emits UTF-16 LE with BOM. Without
    explicit handling our old chain silently fell through to
    cp1252 / latin-1 producing garbage."""
    raw = "TAMCN,SR_NUMBER\nD1196,12345\n".encode("utf-16-le")
    raw_with_bom = b"\xff\xfe" + raw
    text, enc = decode_bytes(raw_with_bom)
    assert text == "TAMCN,SR_NUMBER\nD1196,12345\n"
    assert enc == "utf-16-le"


def test_decode_utf16_be_with_bom():
    raw = "TAMCN\nD1196\n".encode("utf-16-be")
    raw_with_bom = b"\xfe\xff" + raw
    text, enc = decode_bytes(raw_with_bom)
    assert text == "TAMCN\nD1196\n"
    assert enc == "utf-16-be"


def test_decode_utf16_le_without_bom():
    """Some exports drop the BOM. Heuristic catches the
    every-other-byte-zero pattern."""
    raw = "TAMCN,SR_NUMBER\nD1196,12345\n".encode("utf-16-le")
    text, enc = decode_bytes(raw)
    assert text == "TAMCN,SR_NUMBER\nD1196,12345\n"
    assert enc == "utf-16-le"


def test_low_confidence_label_for_latin1_fallback():
    """When latin-1 fires, we tag with `?` so the pipeline can warn.
    This is the primary fix: latin-1 silently succeeds on every
    byte stream so without an explicit signal a UTF-16 file would
    decode as gibberish with no error."""
    # Construct bytes that look like none of the strict encodings
    # but still trigger the latin-1 last-resort branch. \x81 is
    # undefined in cp1252.
    raw = b"\x81\x82\x83\x84"
    text, enc = decode_bytes(raw)
    # Either charset_normalizer (if installed) wins, or latin-1?
    # fires. Both surface as low-confidence.
    assert is_low_confidence_encoding(enc)


def test_is_low_confidence_helper():
    assert is_low_confidence_encoding("latin-1?") is True
    assert is_low_confidence_encoding("cp1252") is True
    assert is_low_confidence_encoding("charset_normalizer:big5") is True
    assert is_low_confidence_encoding("utf-8") is False
    assert is_low_confidence_encoding("utf-8-sig") is False
    assert is_low_confidence_encoding("utf-16-le") is False
    assert is_low_confidence_encoding("utf-16-be") is False


def test_normalize_smart_quotes():
    s = "He said “hello” to her’s"
    out = normalize_text(s)
    assert "“" not in out and "”" not in out
    assert "'" in out and '"' in out


def test_normalize_line_endings():
    s = "a\r\nb\rc\n"
    out = normalize_text(s)
    assert out == "a\nb\nc\n"


def test_normalize_idempotent():
    s = "hello world\n"
    assert normalize_text(s) == s
    assert normalize_text(normalize_text(s)) == s


# ---------------------------------------------------------------------------
# Header canonicalization
# ---------------------------------------------------------------------------


def test_canonical_header_collapses_variants():
    variants = [
        "SR_NUMBER",
        "sr_number",
        "Sr Number",
        "SR-NUMBER",
        "sr.number",
    ]
    canons = {canonical_header(v) for v in variants}
    assert canons == {"SR_NUMBER"}


def test_canonical_header_camel_case():
    assert canonical_header("ServiceRequestNumber") == "SERVICE_REQUEST_NUMBER"
    assert canonical_header("serviceRequest") == "SERVICE_REQUEST"
    assert canonical_header("XMLParser") == "XML_PARSER"


def test_canonical_header_strips_punctuation():
    assert canonical_header("sr#") == "SR"
    assert canonical_header("col 1!") == "COL_1"


def test_canonical_header_empty():
    assert canonical_header("") == ""
    assert canonical_header(None) == ""


# ---------------------------------------------------------------------------
# Header token sets + Jaccard
# ---------------------------------------------------------------------------


def test_token_set_handles_abbreviation_pairs():
    sr = header_token_set("SR_NUMBER")
    full = header_token_set("ServiceRequestNumber")
    # Both should land overlapping tokens via the abbreviation map
    assert "service" in sr or "sr" in full


def test_token_set_handles_plurals():
    s = header_token_set("hours")
    assert "hour" in s or "hours" in s


def test_jaccard_identity():
    assert jaccard_similarity({"a", "b"}, {"a", "b"}) == 1.0


def test_jaccard_disjoint():
    assert jaccard_similarity({"a"}, {"b"}) == 0.0


def test_jaccard_partial_overlap():
    score = jaccard_similarity({"a", "b", "c"}, {"a", "b", "d"})
    assert 0.0 < score < 1.0
