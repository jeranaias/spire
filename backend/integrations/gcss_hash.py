"""Deterministic field hashing for the GCSS-MC schema-parity exports.

The real GCSS-MC sanitized export hashes sensitive identifiers as
``<lowercase_field_prefix>_<base64url-20>``. The same source value must
hash identically across the SR header, SR parts, and due-in exports so
joins on ``SR_NUMBER`` / ``DOCUMENT_NUMBER`` / ``NSN_ORDERED`` work.

Hashing algorithm: SHA-256 of the UTF-8 encoded clear value, taken as
raw bytes, base64url-encoded, padding stripped, then truncated to 20
chars. The first 15 bytes of the digest yield exactly 20 base64url
characters (no padding to strip). The cache is process-scoped so the
same SR_NUMBER returned in three different exports lands at the same
hashed value.

Already-hashed inputs are detected (lowercase or uppercase prefix +
20+ alnum/_/- suffix) and returned unchanged so the helper is
idempotent under re-export.
"""
from __future__ import annotations

import base64
import hashlib
import re
from typing import Dict


_PREHASHED_LOWER = re.compile(r"^[a-z_]+_[A-Za-z0-9_\-]{20,}$")
_PREHASHED_UPPER = re.compile(r"^[A-Z_]+_[A-Za-z0-9_\-]{20,}$")


_CACHE: Dict[str, str] = {}


def _digest20(value: str) -> str:
    raw = hashlib.sha256(value.encode("utf-8")).digest()[:15]
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def hash_field(prefix: str, raw: str) -> str:
    """Return ``<prefix>_<digest20>`` for ``raw``, with a per-process cache.

    ``prefix`` should be the lowercase field name (e.g. ``sr_number``,
    ``serial_number``, ``tamcn``, ``owner_unit_address_code``,
    ``nsn_ordered``, ``rnsn``, ``document_number``, ``sos``). Empty
    inputs return ``""``. Already-hashed inputs are returned unchanged.
    """
    s = (raw or "").strip()
    if not s:
        return ""
    if _PREHASHED_LOWER.match(s) or _PREHASHED_UPPER.match(s):
        return s
    cache_key = f"{prefix}::{s}"
    cached = _CACHE.get(cache_key)
    if cached is not None:
        return cached
    out = f"{prefix}_{_digest20(s)}"
    _CACHE[cache_key] = out
    return out


def looks_hashed(raw: str) -> bool:
    """True iff ``raw`` matches the canonical pre-hashed shape used by
    either the real GCSS-MC export (lowercase prefix) or the SPIRE
    self-emitted export (uppercase prefix)."""
    s = (raw or "").strip()
    if not s:
        return False
    return bool(_PREHASHED_LOWER.match(s) or _PREHASHED_UPPER.match(s))


def hash_sr_number(raw: str) -> str:
    return hash_field("sr_number", raw)


def hash_serial_number(raw: str) -> str:
    return hash_field("serial_number", raw)


def hash_tamcn(raw: str) -> str:
    return hash_field("tamcn", raw)


def hash_owner_unit(raw: str) -> str:
    return hash_field("owner_unit_address_code", raw)


def hash_nsn_ordered(raw: str) -> str:
    return hash_field("nsn_ordered", raw)


def hash_rnsn(raw: str) -> str:
    return hash_field("rnsn", raw)


def hash_document_number(raw: str) -> str:
    return hash_field("document_number", raw)


def hash_sos(raw: str) -> str:
    return hash_field("sos", raw)


def reset_cache() -> None:
    """Clear the deterministic cache. For tests only."""
    _CACHE.clear()
