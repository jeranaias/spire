"""Naive-UTC clock.

``datetime.utcnow()`` is deprecated and slated for removal, but the obvious
replacement is not a drop-in: ``datetime.now(timezone.utc)`` returns an
*aware* datetime, so ``isoformat()`` grows a ``+00:00`` suffix and comparisons
against the naive datetimes stored throughout SPIRE raise TypeError. Both
would be silent breakage - timestamps that render differently in the audit
chain, or a comparison that blows up on a code path nobody exercises often.

:func:`utcnow` is the exact behaviour of the deprecated call: the current UTC
instant, tzinfo stripped. Every timestamp SPIRE writes is UTC by convention
and the "Z" suffix is appended at the call site.

New code that is not bound by an existing on-disk format should prefer an
aware ``datetime.now(timezone.utc)``.
"""
from __future__ import annotations

from datetime import datetime, timezone

__all__ = ["utcnow"]


def utcnow() -> datetime:
    """Current UTC time as a naive datetime."""
    return datetime.now(timezone.utc).replace(tzinfo=None)
