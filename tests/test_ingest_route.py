"""Smoke tests for the /api/ingest router.

Covers the feature-flag gate (default-off → 503), the open status
probe, and an enabled-flag round trip through the ECP adapter.
"""
from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client_disabled(monkeypatch):
    """Client with SPIRE_INGEST_ENABLED unset + signed-in security_manager.

    All `/api` routes require auth (session middleware), so even the
    open status probe needs a signed-in cookie. The disabled case is
    asserted by the 503 from inside the route handler, not by an
    unauthenticated 401.
    """
    monkeypatch.delenv("SPIRE_INGEST_ENABLED", raising=False)
    from backend.main import app
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"dodid": "3456789012", "pin": "000000"})
    assert r.status_code == 200, r.text
    return c


@pytest.fixture
def client_enabled(monkeypatch):
    """Client with SPIRE_INGEST_ENABLED=1 + an authenticated session.

    The auth session is bypassed by directly setting the cookie that
    the session middleware reads. We sign in as a data_custodian DODID
    so the RBAC gate passes.
    """
    monkeypatch.setenv("SPIRE_INGEST_ENABLED", "1")
    from backend.main import app
    c = TestClient(app)
    # Sign in as CWO3 Park (security_manager). Park is the only seeded
    # MOCK_USER who matches INGEST_ROLES; data_custodian doesn't have a
    # demo persona, but the role is left in the scope set so a real
    # pilot deployment can grant it without code changes.
    r = c.post("/api/auth/login", json={"dodid": "3456789012", "pin": "000000"})
    assert r.status_code == 200, r.text
    return c


def test_status_visible_when_disabled(client_disabled):
    """The status probe surfaces the disabled state without leaking it
    behind an extra 503. Useful so the frontend can render the
    "ingest is disabled — ask your data custodian" affordance."""
    r = client_disabled.get("/api/ingest/status")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is False
    assert any(a["id"] == "gcss-mc/ecp" for a in body["adapters"])


def test_ecp_upload_503_when_disabled(client_disabled):
    """Default-off: write endpoint returns 503 with operator-readable hint."""
    r = client_disabled.post(
        "/api/ingest/gcss-mc/ecp",
        files={"file": ("ecp.csv", b"TAMCN\nD1196\n", "text/csv")},
    )
    assert r.status_code == 503, r.text
    assert "SPIRE_INGEST_ENABLED" in r.text


def test_ecp_upload_round_trip(client_enabled):
    """Enabled + authenticated: upload + parse returns the report."""
    header = ",".join((
        "TAMCN", "NSN", "SERIAL_NUMBER", "NOMENCLATURE",
        "OWNER_UIC", "ALLOWANCE_QTY", "ON_HAND_QTY", "LAST_INVENTORY_DATE",
    ))
    body = (
        header + "\n"
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26\n"
    ).encode("utf-8")
    r = client_enabled.post(
        "/api/ingest/gcss-mc/ecp",
        files={"file": ("ecp.csv", body, "text/csv")},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["report"]["rows_kept"] == 1
    assert out["report"]["header_mismatch"] is False
    assert len(out["rows"]) == 1
    row = out["rows"][0]
    assert row["tamcn"] == "D1196"
    assert row["allowance_qty"] == 15
    assert row["on_hand_qty"] == 12
    # Both serial + UIC came pre-hashed in this fixture
    assert row["serial_number_source"] == "pre_hashed"
    assert row["owner_uic_source"] == "pre_hashed"
    assert out["applied"] is False  # Dry-run only — RD5 wires the merge


def test_ecp_upload_blocks_non_utf8(client_enabled):
    """Latin-1 garbage should 400, not 500."""
    body = b"\xff\xfe\xfd"
    r = client_enabled.post(
        "/api/ingest/gcss-mc/ecp",
        files={"file": ("ecp.bin", body, "application/octet-stream")},
    )
    assert r.status_code == 400, r.text
    assert "UTF-8" in r.text


def test_ecp_upload_role_gate(monkeypatch):
    """Mef commander (not data_custodian/security_manager) gets 403."""
    monkeypatch.setenv("SPIRE_INGEST_ENABLED", "1")
    from backend.main import app
    c = TestClient(app)
    # GySgt Reyes (g4) — not in INGEST_ROLES.
    r = c.post("/api/auth/login", json={"dodid": "1234567890", "pin": "000000"})
    assert r.status_code == 200, r.text
    header = ",".join((
        "TAMCN", "NSN", "SERIAL_NUMBER", "NOMENCLATURE",
        "OWNER_UIC", "ALLOWANCE_QTY", "ON_HAND_QTY", "LAST_INVENTORY_DATE",
    ))
    body = (header + "\n").encode("utf-8")
    r = c.post(
        "/api/ingest/gcss-mc/ecp",
        files={"file": ("ecp.csv", body, "text/csv")},
    )
    assert r.status_code == 403, r.text


def _ecp_csv(*lines: str) -> bytes:
    """Build an ECP CSV body with the canonical header."""
    header = ",".join((
        "TAMCN", "NSN", "SERIAL_NUMBER", "NOMENCLATURE",
        "OWNER_UIC", "ALLOWANCE_QTY", "ON_HAND_QTY", "LAST_INVENTORY_DATE",
    ))
    return ("\n".join((header, *lines)) + "\n").encode("utf-8")


def test_ecp_dry_run_returns_preview_token(client_enabled):
    """Dry-run includes a `preview_token` for use on apply."""
    body = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    r = client_enabled.post(
        "/api/ingest/gcss-mc/ecp",
        files={"file": ("ecp.csv", body, "text/csv")},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["applied"] is False
    assert isinstance(out.get("preview_token"), str)
    assert len(out["preview_token"]) == 32  # SHA-256 truncated


def test_ecp_apply_requires_confirm_token(client_enabled):
    """`?apply=1` without a confirm token → 409."""
    body = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    r = client_enabled.post(
        "/api/ingest/gcss-mc/ecp?apply=1",
        files={"file": ("ecp.csv", body, "text/csv")},
    )
    assert r.status_code == 409, r.text
    assert "Confirm token mismatch" in r.text


def test_ecp_apply_with_stale_token_409(client_enabled):
    """Wrong token is also 409."""
    body = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    r = client_enabled.post(
        "/api/ingest/gcss-mc/ecp?apply=1&confirm=" + ("0" * 32),
        files={"file": ("ecp.csv", body, "text/csv")},
    )
    assert r.status_code == 409, r.text


def test_ecp_apply_round_trip(client_enabled):
    """Dry-run → grab token → apply → response says applied=true with counts."""
    body = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    r1 = client_enabled.post(
        "/api/ingest/gcss-mc/ecp",
        files={"file": ("ecp.csv", body, "text/csv")},
    )
    assert r1.status_code == 200, r1.text
    token = r1.json()["preview_token"]

    r2 = client_enabled.post(
        f"/api/ingest/gcss-mc/ecp?apply=1&confirm={token}",
        files={"file": ("ecp.csv", body, "text/csv")},
    )
    assert r2.status_code == 200, r2.text
    out = r2.json()
    assert out["applied"] is True
    assert "applied_counts" in out
    assert out["applied_counts"]["new"] >= 0
    assert out["applied_counts"]["matched_changed"] >= 0
