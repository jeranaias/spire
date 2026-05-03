"""Enum aliasing.

Real exports use casual variants of canonical enum values
("MC" / "mc" / "M.C." / "Mission Capable" all → "MC"). The pipeline
applies the alias map declared on the ColumnSpec; values not in the
map pass through unchanged with a warning.
"""
from __future__ import annotations

from typing import Optional


def map_enum(raw: str, aliases: dict, *, case_insensitive: bool = True) -> Optional[str]:
    """Map a raw value through an alias dict to a canonical enum.

    Returns the canonical value, or the raw value if it isn't in
    the alias map (caller can decide to warn vs. drop).
    """
    if raw is None:
        return None
    s = raw.strip()
    if not s:
        return None
    if case_insensitive:
        # Build a case-insensitive view of the alias map
        ci = {k.lower(): v for k, v in aliases.items()}
        return ci.get(s.lower(), s)
    return aliases.get(s, s)
