"""Type-coercion transforms (str → int / float / bool).

All return None on missing or unparseable input. The caller bumps
the per-row warning counter.
"""
from __future__ import annotations

from typing import Optional


_NULL_SENTINELS = frozenset({"", "null", "(null)", "n/a", "na", "none"})

_TRUE_LITERALS = frozenset({"1", "true", "yes", "y", "on", "t"})
_FALSE_LITERALS = frozenset({"0", "false", "no", "n", "off", "f"})


def _is_null(s: str) -> bool:
    return s.strip().lower() in _NULL_SENTINELS


def parse_int(raw: str) -> Optional[int]:
    """Tolerant int parser. Accepts thousand separators, scientific
    notation, decimal-as-int (truncates)."""
    if raw is None:
        return None
    s = raw.strip()
    if _is_null(s):
        return None
    s = s.replace(",", "")  # thousand separators
    # plain int
    try:
        return int(s)
    except ValueError:
        pass
    # decimal or scientific → truncate
    try:
        return int(float(s))
    except ValueError:
        return None


def parse_float(raw: str) -> Optional[float]:
    """Tolerant float parser. Accepts thousand separators and
    scientific notation."""
    if raw is None:
        return None
    s = raw.strip()
    if _is_null(s):
        return None
    s = s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def parse_bool(raw: str) -> Optional[bool]:
    """Tolerant bool parser. Accepts 1/yes/y/on/t (true) or
    0/no/n/off/f (false). Returns None for anything else."""
    if raw is None:
        return None
    s = raw.strip().lower()
    if _is_null(s):
        return None
    if s in _TRUE_LITERALS:
        return True
    if s in _FALSE_LITERALS:
        return False
    return None
