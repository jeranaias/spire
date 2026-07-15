"""Sanitization-at-the-boundary hashing.

Sensitive fields (UICs, serial numbers, EDIPIs, SR numbers) get
hashed at the normalize stage so the canonical dataset never holds
clear values. The transform classifies whether the input is
already pre-hashed (file arrived sanitized — preferred) or clear
(SPIRE self-hashes as defense-in-depth, audit logs the event).
"""
from __future__ import annotations

import re
from typing import Tuple

from ...deid import digest_hex20


_NULL_SENTINELS = frozenset({"", "null", "(null)", "n/a", "na", "none"})

# A pre-hashed identifier looks like `<PREFIX>_<base64url-or-hex-suffix>`
# where the suffix is at least 20 chars. SPIRE-emitted exports use
# uppercase prefix + hex; real GCSS-MC sanitizers use lowercase prefix
# + base64url. We accept either.
_PRE_HASHED_RE = re.compile(r"^[A-Za-z_]+_[A-Za-z0-9_\-]{20,}$")


def _is_null(s: str) -> bool:
    return s.strip().lower() in _NULL_SENTINELS


def classify_hashed_field(prefix: str, raw: str) -> Tuple[str, str]:
    """Return ``(value_to_keep, source_label)``.

    `source_label` is one of:
      * "missing"      — field empty or null sentinel
      * "pre_hashed"   — input already in canonical hashed form
      * "self_hashed"  — input was clear; SPIRE hashed it as
                        defense-in-depth
    """
    if raw is None:
        return "", "missing"
    s = raw.strip()
    if _is_null(s):
        return "", "missing"
    if _PRE_HASHED_RE.match(s):
        return s, "pre_hashed"
    return f"{prefix}_{digest_hex20(s)}", "self_hashed"


def hash_field(prefix: str, raw: str) -> str:
    """Force-hash a value (clear or pre-hashed) under the given prefix.

    Useful for reseeding a sanitized export to a different prefix or
    salt without involving the classifier branch.
    """
    if raw is None or _is_null(raw or ""):
        return ""
    return f"{prefix}_{digest_hex20(raw)}"
