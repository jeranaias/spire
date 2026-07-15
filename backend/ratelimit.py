"""Lightweight in-process rate limiting (P2-2).

A sliding-window counter keyed by an arbitrary string (typically
``"<bucket>:<client-ip>"``). Used to throttle the auth brute-force surface;
the same helper can gate expensive endpoints (LLM, export). In-process scope —
a multi-worker deploy would move the store to Redis, but for the single-process
pilot box this defangs credential-stuffing and floods without a dependency.
"""
from __future__ import annotations

import threading
from time import time
from typing import Dict, List

_LOCK = threading.Lock()
_HITS: Dict[str, List[float]] = {}


def allow(key: str, max_hits: int, window_s: float) -> bool:
    """Record a hit against ``key``. Return True if it's within the limit for
    the trailing ``window_s`` seconds, False if the caller is over the limit."""
    now = time()
    cutoff = now - window_s
    with _LOCK:
        times = _HITS.setdefault(key, [])
        times[:] = [t for t in times if t > cutoff]
        if len(times) >= max_hits:
            return False
        times.append(now)
        return True


def reset() -> None:
    """Clear all counters (tests)."""
    with _LOCK:
        _HITS.clear()
