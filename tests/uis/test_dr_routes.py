"""DR / backup REST-route tests (UIS-P6.6).

These exercise the HTTP surface (``/api/system/dr/*``) end-to-end
through a TestClient: the ``security_manager`` role gate, the
path-traversal guard, the destructive-restore confirm token, and a
create -> list -> verify happy path. The DR primitives themselves are
covered at the library level in ``test_dr.py``; this file covers the
web layer that wraps them.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


# DODIDs from backend.auth MOCK_USERS_BY_DODID.
SECURITY_MANAGER_DODID = "3456789012"  # CWO3 James Park
COMMANDER_DODID = "4567890123"         # MajGen Hayes (mef_commander)


@pytest.fixture
def dr_runtime(monkeypatch, tmp_path):
    """Isolated runtime + backup dir so DR routes never touch the real
    runtime/ tree. Mirrors the ``isolated_runtime`` fixture in
    test_dr.py but also points ``SPIRE_BACKUP_DIR`` at a temp dir."""
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    backups = tmp_path / "backups"
    db_file = runtime / "spire.db"
    enc_file = runtime / "spire.db.enc"

    monkeypatch.setenv("SPIRE_RUNTIME_DIR", str(runtime))
    monkeypatch.setenv("SPIRE_BACKUP_DIR", str(backups))

    from backend import persistence
    monkeypatch.setattr(persistence, "DATA_DIR", runtime)
    monkeypatch.setattr(persistence, "DB_PATH", db_file)
    monkeypatch.setattr(persistence, "DB_ENCRYPTED_PATH", enc_file)
    monkeypatch.setattr(persistence, "_DB_PASSPHRASE", None)
    persistence.init_db()

    return {"runtime": runtime, "backups": backups}


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "000000"})
    assert r.status_code == 200, r.text


@pytest.fixture
def sm_client(dr_runtime):
    """Authenticated client logged in as security_manager."""
    from backend.main import app
    c = TestClient(app)
    _login(c, SECURITY_MANAGER_DODID)
    return c


# ---------------------------------------------------------------------------
# Role gate
# ---------------------------------------------------------------------------


def test_backup_requires_security_manager(dr_runtime):
    from backend.main import app
    c = TestClient(app)
    _login(c, COMMANDER_DODID)
    r = c.post("/api/system/dr/backup", json={})
    assert r.status_code == 403, r.text


def test_backups_list_requires_security_manager(dr_runtime):
    from backend.main import app
    c = TestClient(app)
    _login(c, COMMANDER_DODID)
    r = c.get("/api/system/dr/backups")
    assert r.status_code == 403, r.text


# ---------------------------------------------------------------------------
# Happy path: create -> list -> verify
# ---------------------------------------------------------------------------


def test_create_list_verify_round_trip(sm_client):
    r = sm_client.post("/api/system/dr/backup", json={"label": "route test"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    archive_path = body["archive_path"]
    assert body["archive_name"].startswith("backup_")

    r = sm_client.get("/api/system/dr/backups")
    assert r.status_code == 200, r.text
    paths = [a["archive_path"] for a in r.json()["archives"]]
    assert any(p.endswith(body["archive_name"]) for p in paths)

    r = sm_client.post("/api/system/dr/verify", json={"archive_path": archive_path})
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True


# ---------------------------------------------------------------------------
# Guards: path traversal + confirm token
# ---------------------------------------------------------------------------


def test_verify_rejects_path_outside_backup_dir(sm_client, tmp_path):
    outside = tmp_path / "evil.tar.gz"
    outside.write_bytes(b"not a real archive")
    r = sm_client.post("/api/system/dr/verify", json={"archive_path": str(outside)})
    assert r.status_code == 400, r.text
    assert "reside inside" in r.json()["detail"]


def test_verify_requires_archive_path(sm_client):
    r = sm_client.post("/api/system/dr/verify", json={})
    assert r.status_code == 400, r.text


def test_restore_requires_confirm_token(sm_client):
    r = sm_client.post("/api/system/dr/backup", json={})
    assert r.status_code == 200, r.text
    archive_path = r.json()["archive_path"]

    # Missing confirm token -> 400, no restore performed.
    r = sm_client.post("/api/system/dr/restore", json={"archive_path": archive_path})
    assert r.status_code == 400, r.text
    assert "RESTORE" in r.json()["detail"]


def test_restore_rejects_path_outside_backup_dir(sm_client, tmp_path):
    outside = tmp_path / "evil.tar.gz"
    outside.write_bytes(b"not a real archive")
    r = sm_client.post(
        "/api/system/dr/restore",
        json={"archive_path": str(outside), "confirm": "RESTORE"},
    )
    assert r.status_code == 400, r.text
    assert "reside inside" in r.json()["detail"]
