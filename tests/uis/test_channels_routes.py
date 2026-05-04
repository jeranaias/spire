"""Channel CRUD + on-demand poll route tests."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def channels_client(monkeypatch, tmp_path):
    """Authenticated, ingest-enabled test client with isolated SQLite."""
    monkeypatch.setenv("SPIRE_INGEST_ENABLED", "1")
    db_file = tmp_path / "test.sqlite"
    from backend import persistence
    monkeypatch.setattr(persistence, "DB_PATH", db_file)
    monkeypatch.setattr(persistence, "_DB_PASSPHRASE", None)
    persistence.init_db()

    # Reset canonical singleton between tests
    from backend import state
    state.init_empty_dataset()

    from backend.main import app
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"dodid": "3456789012", "pin": "000000"})
    assert r.status_code == 200, r.text
    return c


def _fs_payload(tmp_path, **overrides):
    base = {
        "channel_id": "intake/airgap",
        "channel_type": "filesystem",
        "adapter_id": "gcss-mc/ecp",
        "config": {
            "root": str(tmp_path / "intake"),
            "glob": "*.csv",
            "stability_seconds": 0,
        },
        "enabled": True,
        "poll_interval_seconds": 60,
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


def test_create_channel_persists_and_returns_config(channels_client, tmp_path):
    r = channels_client.post("/api/uis/channels", json=_fs_payload(tmp_path))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["channel_id"] == "intake/airgap"
    assert body["channel_type"] == "filesystem"
    assert body["enabled"] is True
    # GET round-trip
    r = channels_client.get("/api/uis/channels/intake/airgap")
    assert r.status_code == 200
    assert r.json()["channel_type"] == "filesystem"


def test_create_rejects_unknown_channel_type(channels_client, tmp_path):
    bad = _fs_payload(tmp_path, channel_type="kafka_topic")
    r = channels_client.post("/api/uis/channels", json=bad)
    assert r.status_code == 400
    assert "channel_type must be" in r.text


def test_create_rejects_unknown_adapter(channels_client, tmp_path):
    bad = _fs_payload(tmp_path, adapter_id="nonexistent")
    r = channels_client.post("/api/uis/channels", json=bad)
    assert r.status_code == 400
    assert "not registered" in r.text


def test_create_rejects_missing_required_config_keys(channels_client, tmp_path):
    bad = _fs_payload(tmp_path)
    bad["config"] = {}  # missing root
    r = channels_client.post("/api/uis/channels", json=bad)
    assert r.status_code == 400
    assert "config missing required keys" in r.text


def test_create_rejects_secret_in_config(channels_client, tmp_path):
    """Belt-and-suspenders — refuse a literal `password` field even
    if the operator made a mistake. Force them to use *_env."""
    bad = {
        "channel_id": "test/sftp",
        "channel_type": "sftp",
        "adapter_id": "gcss-mc/ecp",
        "config": {
            "host": "sftp.example.mil",
            "username": "spire",
            "base_path": "/exports",
            "password": "leakedSecret",  # forbidden
        },
    }
    r = channels_client.post("/api/uis/channels", json=bad)
    assert r.status_code == 400
    assert "secret-shaped keys" in r.text


def test_create_rejects_zero_poll_interval(channels_client, tmp_path):
    bad = _fs_payload(tmp_path, poll_interval_seconds=0)
    r = channels_client.post("/api/uis/channels", json=bad)
    assert r.status_code == 400


def test_list_channels(channels_client, tmp_path):
    channels_client.post("/api/uis/channels", json=_fs_payload(tmp_path))
    channels_client.post("/api/uis/channels", json=_fs_payload(
        tmp_path, channel_id="intake/share-a",
    ))
    r = channels_client.get("/api/uis/channels")
    assert r.status_code == 200
    ids = sorted(c["channel_id"] for c in r.json()["channels"])
    assert ids == ["intake/airgap", "intake/share-a"]


def test_update_channel(channels_client, tmp_path):
    channels_client.post("/api/uis/channels", json=_fs_payload(tmp_path))
    payload = _fs_payload(tmp_path, enabled=False, poll_interval_seconds=900)
    r = channels_client.put("/api/uis/channels/intake/airgap", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is False
    assert body["poll_interval_seconds"] == 900


def test_update_unknown_404(channels_client, tmp_path):
    r = channels_client.put("/api/uis/channels/ghost", json=_fs_payload(tmp_path))
    assert r.status_code == 404


def test_delete_channel(channels_client, tmp_path):
    channels_client.post("/api/uis/channels", json=_fs_payload(tmp_path))
    r = channels_client.delete("/api/uis/channels/intake/airgap")
    assert r.status_code == 200
    assert r.json()["deleted"] is True
    r = channels_client.get("/api/uis/channels/intake/airgap")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


def test_health_endpoint_reflects_directory_state(channels_client, tmp_path):
    channels_client.post("/api/uis/channels", json=_fs_payload(tmp_path))
    r = channels_client.get("/api/uis/channels/intake/airgap/health")
    assert r.status_code == 200
    body = r.json()
    assert body["reachable"] is True
    assert body["channel_type"] == "filesystem"
    assert body["pending_count"] == 0


# ---------------------------------------------------------------------------
# On-demand poll
# ---------------------------------------------------------------------------


def test_poll_endpoint_processes_file_end_to_end(channels_client, tmp_path):
    """Drop a clean ECP file in the channel's incoming/, hit the
    poll endpoint, expect status=applied + diff_counts populated."""
    channels_client.post("/api/uis/channels", json=_fs_payload(tmp_path))

    incoming = tmp_path / "intake" / "incoming"
    body = (
        b"TAMCN,NSN,SERIAL_NUMBER,NOMENCLATURE,OWNER_UIC,"
        b"ALLOWANCE_QTY,ON_HAND_QTY,LAST_INVENTORY_DATE\n"
        b"D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,"
        b"owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26\n"
    )
    (incoming / "ecp.csv").write_bytes(body)

    r = channels_client.post("/api/uis/channels/intake/airgap/poll")
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["pending_count"] == 1
    assert out["counts"]["applied"] == 1
    file_outcome = out["files"][0]
    assert file_outcome["status"] == "applied"
    assert file_outcome["diff_counts"]["new"] == 1
    assert file_outcome["sha256"]


def test_poll_endpoint_quarantines_duplicate_header_file(channels_client, tmp_path):
    channels_client.post("/api/uis/channels", json=_fs_payload(tmp_path))
    incoming = tmp_path / "intake" / "incoming"
    bad = (
        b"TAMCN,NSN,TAMCN,NOMENCLATURE,OWNER_UIC,SERIAL_NUMBER,"
        b"ALLOWANCE_QTY,ON_HAND_QTY,LAST_INVENTORY_DATE\n"
        b"D1196,2320-01-540-2480,DUP,JLTV,"
        b"owner_uic_zZyYxXwWvVuUtTsSrRqQ,owner_serial_aBcDeFgHiJkLmNoPqRsT,"
        b"15,12,12-MAR-26\n"
    )
    (incoming / "bad.csv").write_bytes(bad)
    r = channels_client.post("/api/uis/channels/intake/airgap/poll")
    assert r.status_code == 200
    out = r.json()
    assert out["counts"]["quarantined"] == 1
    file_outcome = out["files"][0]
    assert file_outcome["status"] == "quarantined"
    assert "duplicate_header_columns" in file_outcome["error"]
    # Sidecar exists in quarantine/
    quarantine = tmp_path / "intake" / "quarantine"
    assert any(f.name.endswith(".reason.txt") for f in quarantine.iterdir())


def test_poll_disabled_channel_returns_409(channels_client, tmp_path):
    channels_client.post("/api/uis/channels", json=_fs_payload(tmp_path, enabled=False))
    r = channels_client.post("/api/uis/channels/intake/airgap/poll")
    assert r.status_code == 409
    assert "disabled" in r.text


# ---------------------------------------------------------------------------
# 503 + role gates
# ---------------------------------------------------------------------------


def test_channels_routes_503_when_ingest_disabled(monkeypatch, tmp_path):
    monkeypatch.delenv("SPIRE_INGEST_ENABLED", raising=False)
    db_file = tmp_path / "x.sqlite"
    from backend import persistence
    monkeypatch.setattr(persistence, "DB_PATH", db_file)
    monkeypatch.setattr(persistence, "_DB_PASSPHRASE", None)
    persistence.init_db()
    from backend.main import app
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"dodid": "3456789012", "pin": "000000"})
    assert r.status_code == 200
    r = c.get("/api/uis/channels")
    assert r.status_code == 503


def test_channels_routes_role_gated(monkeypatch, tmp_path):
    monkeypatch.setenv("SPIRE_INGEST_ENABLED", "1")
    db_file = tmp_path / "x.sqlite"
    from backend import persistence
    monkeypatch.setattr(persistence, "DB_PATH", db_file)
    monkeypatch.setattr(persistence, "_DB_PASSPHRASE", None)
    persistence.init_db()
    from backend.main import app
    c = TestClient(app)
    # GySgt Reyes (g4) — not in INGEST_ROLES
    r = c.post("/api/auth/login", json={"dodid": "1234567890", "pin": "000000"})
    assert r.status_code == 200
    r = c.get("/api/uis/channels")
    assert r.status_code == 403
