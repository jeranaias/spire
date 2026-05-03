"""Encoding + text normalization.

Real-world exports arrive with:
  * UTF-8 BOM at the start (Windows Excel-saved CSVs)
  * UTF-8 with no BOM (POSIX tooling)
  * Latin-1 / cp1252 (older Windows)
  * Smart quotes ` " " ' ' ` instead of straight quotes
  * Mixed line endings (CRLF / LF / CR)

`decode_bytes` returns clean UTF-8 text. `normalize_text` flattens
the cosmetic noise so downstream parsers see a single representation.
"""
from __future__ import annotations

from typing import Optional


# Single-pass decode without external chardet dep. Tries UTF-8 first
# (the dominant case on modern exports), then cp1252 (Windows
# default), then Latin-1 (will always succeed). Returns the decoded
# text plus the encoding name so the audit log knows what the file
# was.
def decode_bytes(raw: bytes) -> tuple[str, str]:
    """Decode raw bytes to text. Strips a leading UTF-8 BOM.

    Returns ``(text, encoding_name)``.
    """
    # Strip BOM
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
        encoding = "utf-8-sig"
    else:
        encoding = "utf-8"
    try:
        return raw.decode("utf-8"), encoding
    except UnicodeDecodeError:
        pass
    try:
        return raw.decode("cp1252"), "cp1252"
    except UnicodeDecodeError:
        pass
    return raw.decode("latin-1", errors="replace"), "latin-1"


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
