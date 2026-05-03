"""Encoding + text normalization.

Real-world exports arrive with:
  * UTF-8 BOM at the start (Windows Excel-saved CSVs)
  * UTF-8 with no BOM (POSIX tooling)
  * UTF-16 BOM (Windows "Save as Unicode")
  * Latin-1 / cp1252 (older Windows)
  * Smart quotes ` " " ' ' ` instead of straight quotes
  * Mixed line endings (CRLF / LF / CR)

`decode_bytes` returns clean UTF-8 text + the encoding label. Falls
back through a defined chain and surfaces a `low_confidence` flag
when we had to guess (so the pipeline can warn the operator instead
of silently producing corrupted text — latin-1 is byte-mappable and
NEVER fails to decode, so a UTF-16 file would slip through as
gibberish without an explicit guard).

`normalize_text` flattens the cosmetic noise so downstream parsers
see a single representation.
"""
from __future__ import annotations

from typing import Optional, Tuple


# UTF-16 BOMs land at offsets 0–1. Excel "Save as Unicode" emits
# UTF-16 LE (0xFF 0xFE).
_UTF16_LE_BOM = b"\xff\xfe"
_UTF16_BE_BOM = b"\xfe\xff"
_UTF8_BOM = b"\xef\xbb\xbf"


def _looks_like_utf16(raw: bytes) -> bool:
    """Heuristic for UTF-16 LE without a BOM.

    UTF-16 LE Latin text has every other byte = 0x00. Sample the
    first 256 bytes; if more than 30% are zero AND we see ASCII
    chars in the odd positions, treat as UTF-16 LE.
    """
    head = raw[:256]
    if not head:
        return False
    zeros = head.count(b"\x00")
    if zeros < len(head) * 0.30:
        return False
    # Spot-check: do odd positions look like printable ASCII?
    ascii_in_odds = sum(
        1 for i in range(0, len(head), 2)
        if 0x20 <= head[i] < 0x7F
    )
    return ascii_in_odds > len(head) * 0.20


def decode_bytes(raw: bytes) -> Tuple[str, str]:
    """Decode raw bytes to text. Strips BOMs.

    Returns ``(text, encoding_name)`` where encoding_name is one of:
        "utf-8-sig"   — UTF-8 with BOM stripped
        "utf-8"       — clean UTF-8
        "utf-16-le"   — UTF-16 little-endian
        "utf-16-be"   — UTF-16 big-endian
        "cp1252"      — Windows-1252 fallback
        "charset_normalizer:<n>" — best-effort guess via lib
        "latin-1?"    — latin-1 last-resort with `?` suffix to
                        signal *this is not trustworthy* (latin-1
                        always succeeds byte-by-byte, so callers
                        seeing this label must surface a warning).

    The pipeline layer reads the trailing "?" to bump
    encoding_low_confidence in the report.
    """
    # 1. UTF-16 BOMs (must check before UTF-8 because they share
    #    overlapping prefix bytes only on UTF-16-LE 0xFF 0xFE).
    if raw.startswith(_UTF16_LE_BOM):
        try:
            return raw[2:].decode("utf-16-le"), "utf-16-le"
        except UnicodeDecodeError:
            pass
    if raw.startswith(_UTF16_BE_BOM):
        try:
            return raw[2:].decode("utf-16-be"), "utf-16-be"
        except UnicodeDecodeError:
            pass

    # 2. UTF-8 BOM
    if raw.startswith(_UTF8_BOM):
        return raw[3:].decode("utf-8", errors="replace"), "utf-8-sig"

    # 3. UTF-16 without BOM (heuristic on null-byte density).
    #    MUST run before UTF-8 — a UTF-16 LE file decodes as
    #    valid UTF-8 (NUL bytes are valid UTF-8 codepoints), so
    #    skipping straight to UTF-8 silently produces a string
    #    full of `\x00` interspersed with ASCII chars and no error.
    if _looks_like_utf16(raw):
        try:
            return raw.decode("utf-16-le"), "utf-16-le"
        except UnicodeDecodeError:
            try:
                return raw.decode("utf-16-be"), "utf-16-be"
            except UnicodeDecodeError:
                pass

    # 4. Plain UTF-8
    try:
        return raw.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        pass

    # 5. cp1252 — strict (raises on undefined byte 0x81/0x8D/0x8F/etc.)
    try:
        return raw.decode("cp1252"), "cp1252"
    except UnicodeDecodeError:
        pass

    # 6. charset_normalizer if available — properly probability-ranked
    try:
        from charset_normalizer import from_bytes  # type: ignore
        result = from_bytes(raw).best()
        if result is not None and result.encoding:
            return str(result), f"charset_normalizer:{result.encoding}"
    except ImportError:
        pass

    # 7. Last resort: latin-1 with explicit `?` label so the pipeline
    #    surfaces a low-confidence warning. Latin-1 always succeeds
    #    byte-by-byte; without this label a UTF-16 file would parse
    #    as gibberish and downstream see no error.
    return raw.decode("latin-1", errors="replace"), "latin-1?"


def is_low_confidence_encoding(label: str) -> bool:
    """The pipeline checks this and bumps a per-file warning when
    the encoding is a guess (cp1252 fallback or latin-1 last-resort)."""
    return label.endswith("?") or label.startswith("charset_normalizer:") or label == "cp1252"


# Mapping of cosmetic Unicode characters to ASCII equivalents. The
# transforms below stay tolerant of the originals (the parsers don't
# choke on smart quotes), but normalizing once means downstream
# string comparison logic ("=" vs "≠") stays straightforward.
_SMART_REPLACEMENTS = {
    "‘": "'",   # left single quote
    "’": "'",   # right single quote
    "“": '"',   # left double quote
    "”": '"',   # right double quote
    "–": "-",   # en dash
    "—": "-",   # em dash
    " ": " ",   # non-breaking space
    "​": "",    # zero-width space
    "﻿": "",    # BOM in middle of string
}


def normalize_text(text: str) -> str:
    """Apply cosmetic normalization: smart quotes, dashes, NBSP, line
    endings. Idempotent — a normalized string normalizes to itself.
    """
    for src, dst in _SMART_REPLACEMENTS.items():
        text = text.replace(src, dst)
    # Normalize line endings to \n
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text
