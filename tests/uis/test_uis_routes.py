"""UIS route tests — adapters listing, generic upload, profile CRUD."""
from __future__ import annotations

import os
import tempfile

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def uis_client(monkeypatch, tmp_path):
    """Authenticated, ingest-enabled client with isolated SQLite.

    Same trick as test_profile_store: monkeypatch the persistence
    DB_PATH to a tmp file so each test starts with a clean
    uis_mapping_profiles table without polluting the live DB.
    """
    monkeypatch.setenv("SPIRE_INGEST_ENABLED", "1")
    db_file = tmp_path / "test.sqlite"
    from backend import persistence
    monkeypatch.setattr(persistence, "DB_PATH", db_file)
    monkeypatch.setattr(persistence, "_DB_PASSPHRASE", None)
    persistence.init_db()

    from backend.main import app
    c = TestClient(app)
    # Sign in as security_manager
    r = c.post("/api/auth/login", json={"dodid": "3456789012", "pin": "000000"})
    assert r.status_code == 200, r.text
    return c


def _ecp_csv(*lines):
    header = "TAMCN,NSN,SERIAL_NUMBER,NOMENCLATURE,OWNER_UIC,ALLOWANCE_QTY,ON_HAND_QTY,LAST_INVENTORY_DATE"
    return ("\n".join((header, *lines)) + "\n").encode("utf-8")


# ---------------------------------------------------------------------------
# /api/uis/adapters
# ---------------------------------------------------------------------------


def test_adapters_lists_all_registered(uis_client):
    r = uis_client.get("/api/uis/adapters")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is True
    ids = {a["id"] for a in body["adapters"]}
    assert {"gcss-mc/ecp", "gcss-mc/util", "gcss-mc/sr-header"} <= ids


def test_adapters_carries_canonical_columns(uis_client):
    r = uis_client.get("/api/uis/adapters")
    body = r.json()
    ecp = next(a for a in body["adapters"] if a["id"] == "gcss-mc/ecp")
    field_names = [c["name"] for c in ecp["canonical_columns"]]
    assert "tamcn" in field_names
    assert "serial_number" in field_names
    sensitive = [c["name"] for c in ecp["canonical_columns"] if c["sensitive"]]
    assert sorted(sensitive) == ["owner_uic", "serial_number"]


# ---------------------------------------------------------------------------
# /api/uis/upload (dry-run)
# ---------------------------------------------------------------------------


def test_upload_unknown_adapter_404(uis_client):
    r = uis_client.post(
        "/api/uis/upload?adapter_id=nope",
        files={"file": ("x.csv", b"a,b\n1,2\n", "text/csv")},
    )
    assert r.status_code == 404, r.text


def test_upload_dry_run_returns_preview(uis_client):
    body = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    r = uis_client.post(
        "/api/uis/upload?adapter_id=gcss-mc/ecp",
        files={"file": ("ecp.csv", body, "text/csv")},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["adapter_id"] == "gcss-mc/ecp"
    assert out["rows_kept"] == 1
    assert out["report"]["detected_format"] == "csv"
    assert out["applied"] is False
    assert isinstance(out["preview_token"], str)
    assert out["profile_id"] is None  # no profile saved yet


def test_upload_apply_routes_to_adapter_specific_endpoint(uis_client):
    """/api/uis/upload?apply=1 currently 400s with a redirect message
    pointing at the adapter-specific apply route."""
    body = _ecp_csv()
    r = uis_client.post(
        "/api/uis/upload?adapter_id=gcss-mc/ecp&apply=1",
        files={"file": ("ecp.csv", body, "text/csv")},
    )
    assert r.status_code == 400, r.text
    assert "/api/ingest/" in r.text


def test_upload_503_when_disabled(monkeypatch, tmp_path):
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
    r = c.post(
        "/api/uis/upload?adapter_id=gcss-mc/ecp",
        files={"file": ("x.csv", b"a\n1\n", "text/csv")},
    )
    assert r.status_code == 503


# ---------------------------------------------------------------------------
# /api/uis/map
# ---------------------------------------------------------------------------


def test_map_returns_proposal_without_llm(uis_client):
    body = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    r = uis_client.post(
        "/api/uis/map?adapter_id=gcss-mc/ecp&use_llm=false",
        files={"file": ("ecp.csv", body, "text/csv")},
    )
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["adapter_id"] == "gcss-mc/ecp"
    assert out["detected_format"] == "csv"
    assert out["llm_invoked"] is False
    assert "TAMCN" in out["source_columns"]
    assert out["column_map"]["TAMCN"] == "tamcn"
    # Auto-baseline catches the canonical-form headers at 1.0
    assert out["auto_baseline_confidence"] >= 0.95


def test_map_unknown_format_400(uis_client):
    r = uis_client.post(
        "/api/uis/map?adapter_id=gcss-mc/ecp&use_llm=false",
        files={"file": ("garbage.bin", b"\x00\x01\x02\x03", "application/octet-stream")},
    )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# /api/uis/profiles CRUD
# ---------------------------------------------------------------------------


def _profile_payload(profile_id="3d-mlr/gcss-mc-ecp/v1", confirm=True):
    return {
        "profile_id": profile_id,
        "source_id": "gcss-mc/ecp",
        "unit": "3d MLR",
        "source_version": "2026-04",
        "column_map": {
            "TAMCN_Code": "tamcn",
            "SerialNum": "serial_number",
        },
        "operator_notes": "tested profile",
        "confirm": confirm,
    }


def test_create_profile_success(uis_client):
    r = uis_client.post("/api/uis/profiles", json=_profile_payload())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["profile_id"] == "3d-mlr/gcss-mc-ecp/v1"
    assert body["confirmed_at"] is not None  # confirm=True


def test_create_profile_rejects_unknown_canonical_target(uis_client):
    payload = _profile_payload()
    payload["column_map"]["BadCol"] = "nonexistent_field"
    r = uis_client.post("/api/uis/profiles", json=payload)
    assert r.status_code == 400, r.text
    assert "not in adapter spec" in r.text


def test_create_profile_rejects_duplicate_canonical_targets(uis_client):
    payload = _profile_payload()
    payload["column_map"]["AnotherCol"] = "tamcn"  # tamcn already taken
    r = uis_client.post("/api/uis/profiles", json=payload)
    assert r.status_code == 400, r.text
    assert "duplicate" in r.text


def test_create_profile_rejects_unknown_source_id(uis_client):
    payload = _profile_payload()
    payload["source_id"] = "nope"
    r = uis_client.post("/api/uis/profiles", json=payload)
    assert r.status_code == 400, r.text


def test_create_then_get_profile(uis_client):
    uis_client.post("/api/uis/profiles", json=_profile_payload())
    r = uis_client.get("/api/uis/profiles/3d-mlr/gcss-mc-ecp/v1")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["unit"] == "3d MLR"


def test_list_profiles_filter_by_source(uis_client):
    uis_client.post("/api/uis/profiles", json=_profile_payload(profile_id="a/v1"))
    uis_client.post(
        "/api/uis/profiles",
        json={**_profile_payload(profile_id="b/v1"), "source_id": "gcss-mc/util",
              "column_map": {"asset_id": "asset_id"}},
    )
    r = uis_client.get("/api/uis/profiles?source_id=gcss-mc/ecp")
    body = r.json()
    profile_ids = {p["profile_id"] for p in body["profiles"]}
    assert "a/v1" in profile_ids
    assert "b/v1" not in profile_ids


def test_update_profile(uis_client):
    uis_client.post("/api/uis/profiles", json=_profile_payload())
    r = uis_client.put(
        "/api/uis/profiles/3d-mlr/gcss-mc-ecp/v1",
        json={
            "column_map": {"TAMCN_Code": "tamcn", "SerialNum": "serial_number", "Description": "nomenclature"},
            "operator_notes": "updated notes",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "Description" in body["column_map"]
    assert body["operator_notes"] == "updated notes"


def test_update_profile_404(uis_client):
    r = uis_client.put("/api/uis/profiles/ghost", json={"column_map": {}})
    assert r.status_code == 404


def test_delete_profile(uis_client):
    uis_client.post("/api/uis/profiles", json=_profile_payload())
    r = uis_client.delete("/api/uis/profiles/3d-mlr/gcss-mc-ecp/v1")
    assert r.status_code == 200, r.text
    # Subsequent get → 404
    r = uis_client.get("/api/uis/profiles/3d-mlr/gcss-mc-ecp/v1")
    assert r.status_code == 404


def test_delete_profile_404(uis_client):
    r = uis_client.delete("/api/uis/profiles/ghost")
    assert r.status_code == 404


def test_upload_writes_audit_entry_on_dry_run(uis_client):
    """Every upload (dry-run included) writes one audit entry. Lets
    the auditor reconstruct who-looked-at-what without
    requiring an apply."""
    body = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    r = uis_client.post(
        "/api/uis/upload?adapter_id=gcss-mc/ecp",
        files={"file": ("ecp.csv", body, "text/csv")},
    )
    assert r.status_code == 200, r.text

    # Inspect the audit chain — the recent entry should be a
    # uis.upload kind tied to the file's preview_token.
    from backend.persistence import recent_entries
    entries = recent_entries(limit=10, include_payload=True)
    upload_entry = next((e for e in entries if e["kind"] == "uis.upload"), None)
    assert upload_entry is not None, f"audit log: {entries}"
    assert upload_entry["subject_id"] == r.json()["preview_token"]


def test_role_gate_denies_g4(monkeypatch, tmp_path):
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
    r = c.get("/api/uis/profiles")
    assert r.status_code == 403
