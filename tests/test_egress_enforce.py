"""Egress monitor enforce mode (P1-5)."""
from __future__ import annotations

import pytest

from backend import network_monitor as nm


def test_disallowed_egress_raises_when_enforcing(monkeypatch):
    monkeypatch.setattr(nm, "_is_allowed", lambda h, p: False)
    monkeypatch.setenv("SPIRE_EGRESS_ENFORCE", "1")
    called = {"orig": False}
    monkeypatch.setattr(nm, "_ORIGINAL_CREATE_CONNECTION", lambda *a, **k: called.__setitem__("orig", True))
    with pytest.raises(nm.EgressBlocked):
        nm._patched_create_connection(("evil.example.com", 443))
    assert called["orig"] is False  # blocked before the connection opened


def test_disallowed_egress_logs_only_by_default(monkeypatch):
    monkeypatch.setattr(nm, "_is_allowed", lambda h, p: False)
    monkeypatch.delenv("SPIRE_EGRESS_ENFORCE", raising=False)
    sentinel = object()
    monkeypatch.setattr(nm, "_ORIGINAL_CREATE_CONNECTION", lambda *a, **k: sentinel)
    # No raise; connection proceeds (audited, not blocked).
    assert nm._patched_create_connection(("evil.example.com", 443)) is sentinel


def test_allowed_egress_passes_even_when_enforcing(monkeypatch):
    monkeypatch.setattr(nm, "_is_allowed", lambda h, p: True)
    monkeypatch.setenv("SPIRE_EGRESS_ENFORCE", "1")
    sentinel = object()
    monkeypatch.setattr(nm, "_ORIGINAL_CREATE_CONNECTION", lambda *a, **k: sentinel)
    assert nm._patched_create_connection(("127.0.0.1", 8095)) is sentinel
