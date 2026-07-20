"""Naive-UTC clock (WI-11).

The sweep off datetime.utcnow() is only safe if the replacement renders
identically. Every timestamp SPIRE has ever written is naive UTC with a "Z"
appended at the call site; an aware datetime would silently start emitting
"+00:00Z" into the audit chain and break comparisons against stored values.
"""
from __future__ import annotations

import warnings
from datetime import datetime, timedelta, timezone
from pathlib import Path

from backend.timeutil import utcnow

REPO = Path(__file__).resolve().parent.parent


def test_returns_naive_utc():
    now = utcnow()
    assert now.tzinfo is None
    # Same instant as the aware clock, modulo the microseconds between calls.
    assert abs(now - datetime.now(timezone.utc).replace(tzinfo=None)) < timedelta(seconds=2)


def test_renders_byte_identically_to_the_old_call():
    stamp = utcnow().isoformat(timespec="seconds") + "Z"
    assert stamp.endswith("Z") and "+00:00" not in stamp
    assert len(stamp) == len("2026-07-20T00:00:00Z")


def test_comparable_with_stored_naive_datetimes():
    stored = datetime(2026, 7, 20, 12, 0, 0)  # as parsed off disk
    assert utcnow() > stored  # would raise TypeError against an aware value


def test_emits_no_deprecation_warning():
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        utcnow()


def test_backend_has_no_remaining_utcnow_calls():
    offenders = []
    for path in (REPO / "backend").rglob("*.py"):
        if path.name == "timeutil.py":
            continue  # its docstring names the call it replaces
        if "datetime.utcnow(" in path.read_text(encoding="utf-8"):
            offenders.append(str(path.relative_to(REPO)))
    assert not offenders, f"datetime.utcnow() still called in: {offenders}"
