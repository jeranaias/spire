"""Egress posture is visible in /api/system/status (WI-3).

Assessors should be able to read whether the watchdog denies or merely records
off the StatusFooter, without asking anyone.
"""
from __future__ import annotations

from backend import network_monitor, security_posture
from backend.routes.system import _network_egress_summary


def test_mode_is_monitor_by_default(monkeypatch):
    monkeypatch.delenv("SPIRE_EGRESS_ENFORCE", raising=False)
    assert network_monitor.mode() == "monitor"
    assert _network_egress_summary()["mode"] == "monitor"


def test_mode_is_enforce_when_enforcing(monkeypatch):
    monkeypatch.setenv("SPIRE_EGRESS_ENFORCE", "1")
    assert network_monitor.mode() == "enforce"
    summary = _network_egress_summary()
    assert summary["mode"] == "enforce"
    assert summary["armed"] is True


def test_csp_drops_the_cdn_when_egress_is_enforced(monkeypatch):
    monkeypatch.delenv("SPIRE_TILE_ORIGIN", raising=False)
    monkeypatch.delenv("SPIRE_EGRESS_ENFORCE", raising=False)
    assert "cartocdn" in security_posture._csp_value()
    monkeypatch.setenv("SPIRE_EGRESS_ENFORCE", "1")
    csp = security_posture._csp_value()
    assert "cartocdn" not in csp
    # Same-origin sources must survive the tightening.
    assert "connect-src 'self'" in csp and "img-src 'self' data: blob:" in csp
