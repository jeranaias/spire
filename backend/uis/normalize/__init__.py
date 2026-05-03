"""Cross-format normalization helpers.

Encoding detection, BOM strip, smart-quote normalization,
line-ending fixing, and header-name canonicalization. Run once per
file at the top of the pipeline so downstream transforms see a
consistent representation regardless of source format.
"""
from __future__ import annotations

from .encoding import decode_bytes, is_low_confidence_encoding, normalize_text
from .headers import canonical_header, header_token_set

__all__ = [
    "canonical_header",
    "decode_bytes",
    "header_token_set",
    "is_low_confidence_encoding",
    "normalize_text",
]
