"""
Mission clock — a single source of truth for "time since H+0" used by the
demo scenario timeline, the BASTION map HUD, and the reset-to-clean-demo
affordance.

This module is intentionally minimal. Wave-1 task B4 (mission clock +
scenario timeline) extends this with the scripted scenario engine; the
A5 reset task introduced the module so it has a clock to reset.

Contract:
- Mission clock is a wall-clock UTC timestamp recording the last "H+0"
  pin. Elapsed time is `now - h0_at`.
- `reset_to_h0()` re-pins H+0 to the current wall-clock moment and
  returns the new pin. Idempotent.
- `current_offset_seconds()` returns the elapsed seconds since the
  last H+0 pin (>= 0).
- `state()` returns the JSON-serialisable view used by the reset summary
  and any future `/api/system/mission-clock` endpoint B4 introduces.

Thread-safety is intentional but coarse: a single module-level RLock
guards reads + writes. The demo is single-presenter so contention is
nil; the lock exists so a future multi-tab dashboard doesn't read a
half-updated state.
"""
from __future__ import annotations

import threading
from datetime import datetime
from typing import Optional


_LOCK = threading.RLock()
# Initialised at module import — equivalent to "H+0 is when the process
# started". The first reset pins it to a known moment.
_H0_AT: datetime = datetime.utcnow()
_LAST_RESET_BY: Optional[str] = None


def reset_to_h0(actor: Optional[str] = None) -> dict:
    """Pin H+0 to the current wall-clock moment. Returns the new state."""
    global _H0_AT, _LAST_RESET_BY
    with _LOCK:
        _H0_AT = datetime.utcnow()
        _LAST_RESET_BY = actor
        return _state_locked()


def current_offset_seconds() -> int:
    """Seconds elapsed since the last H+0 pin. Always >= 0."""
    with _LOCK:
        delta = datetime.utcnow() - _H0_AT
        return max(0, int(delta.total_seconds()))


def state() -> dict:
    with _LOCK:
        return _state_locked()


def _state_locked() -> dict:
    return {
        "h0_at": _H0_AT.isoformat(timespec="seconds") + "Z",
        "offset_seconds": max(0, int((datetime.utcnow() - _H0_AT).total_seconds())),
        "last_reset_by": _LAST_RESET_BY,
    }
