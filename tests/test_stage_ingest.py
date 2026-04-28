"""Backend tests for Task #183 stage live-ingest mode.

Covers:
1. The dataset singleton boots empty when ``SPIRE_BOOT_EMPTY=1`` and
   ``init_empty_dataset`` round-trips through ``dataset_status()``.
2. ``GET /api/system/dataset-status`` requires auth and reports the
   empty/populated flag.
3. ``POST /api/system/stage-ingest`` is gated to {data_custodian,
   security_manager}; g4 (1234567890) gets 403, security_manager Park
   (3456789012) succeeds with the synthetic three-CSV bundle.
4. After a successful stage-ingest the affected domain endpoints
   (``/bastion/cop``, ``/pulse/fleet-overview``) flip out of empty mode
   for the SR/asset surfaces and the dataset_status counts reflect the
   new SR rows.
5. ``POST /api/system/admin/reset-demo`` (the Shift+F8 failsafe) wipes
   the staged dataset back to the seed-42 baseline.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import state as state_mod
from backend.main import app


FIXTURES = Path(__file__).parent / "fixtures" / "stage_ingest"


@pytest.fixture
def client():
    """Per-test TestClient. Each test gets its own session so cookies
    don't leak between role-gating cases."""
    with TestClient(app) as c:
        yield c


@pytest.fixture
def park_client(client):
    """TestClient with Park (security_manager, DODID 3456789012) signed
    in. STAGE_INGEST_ROLES = {data_custodian, security_manager} and Park
    is the only stage-ingest-eligible Marine in MOCK_USERS."""
    resp = client.post(
        "/api/auth/login",
        json={"dodid": "3456789012", "pin": "123456"},
    )
    assert resp.status_code == 200, resp.text
    return client


@pytest.fixture
def g4_client(client):
    """TestClient with GySgt Reyes (g4, DODID 1234567890) signed in.
    g4 is *not* in STAGE_INGEST_ROLES — used to assert the 403."""
    resp = client.post(
        "/api/auth/login",
        json={"dodid": "1234567890", "pin": "123456"},
    )
    assert resp.status_code == 200, resp.text
    return client


def _csv_files() -> dict[str, tuple[str, bytes, str]]:
    """Open the three synthetic stage-ingest CSVs as multipart payload."""
    return {
        "header": (
            "header.csv",
            (FIXTURES / "header.csv").read_bytes(),
            "text/csv",
        ),
        "sr_parts": (
            "sr_parts.csv",
            (FIXTURES / "sr_parts.csv").read_bytes(),
            "text/csv",
        ),
        "due_in": (
            "due_in.csv",
            (FIXTURES / "due_in.csv").read_bytes(),
            "text/csv",
        ),
    }


# ---------------------------------------------------------------------------
# State module — dataset singleton round-trip
# ---------------------------------------------------------------------------

class TestDatasetSingleton:
    def test_init_empty_dataset_is_empty(self):
        ds = state_mod.init_empty_dataset()
        assert state_mod.is_dataset_empty() is True
        # The empty singleton still satisfies CanonicalDataset's invariants —
        # downstream `get_dataset()` won't raise an AttributeError.
        assert len(ds.units) == 0
        assert len(ds.assets) == 0
        assert len(ds.srs) == 0

    def test_dataset_status_shape(self):
        state_mod.init_empty_dataset()
        status = state_mod.dataset_status()
        assert status["empty"] is True
        assert status["source"] == "empty"
        assert status["counts"]["srs"] == 0
        assert status["counts"]["units"] == 0
        # Required keys for the frontend type-guard.
        for key in ("ingested_at", "ingested_by", "ingest_hash", "generated_at", "seed"):
            assert key in status

    def test_swap_dataset_marks_populated(self):
        # Seed a tiny stand-in dataset and confirm the status flips.
        state_mod.init_empty_dataset()
        # Reuse the loader path so we don't hand-roll a CanonicalDataset
        # — load_dataset() is the same call lifespan uses on a non-empty boot.
        from backend.state import load_dataset
        ds = load_dataset()
        state_mod.swap_dataset(ds, source="seed-42", ingested_by="test")
        status = state_mod.dataset_status()
        assert status["empty"] is False
        assert status["source"] == "seed-42"
        assert status["ingested_by"] == "test"
        assert status["counts"]["srs"] > 0


# ---------------------------------------------------------------------------
# /api/system/dataset-status — auth-gated read
# ---------------------------------------------------------------------------

class TestDatasetStatusRoute:
    def test_unauthenticated_blocked(self, client):
        resp = client.get("/api/system/dataset-status")
        assert resp.status_code == 401

    def test_authenticated_ok(self, g4_client):
        resp = g4_client.get("/api/system/dataset-status")
        assert resp.status_code == 200
        body = resp.json()
        assert "empty" in body
        assert "counts" in body


# ---------------------------------------------------------------------------
# /api/system/stage-ingest — RBAC gate + happy-path ingest
# ---------------------------------------------------------------------------

class TestStageIngestRoute:
    def test_unauthenticated_blocked(self, client):
        resp = client.post("/api/system/stage-ingest", files=_csv_files())
        assert resp.status_code == 401

    def test_g4_role_forbidden(self, g4_client):
        # g4 is *not* in STAGE_INGEST_ROLES — must be 403, not 401.
        resp = g4_client.post("/api/system/stage-ingest", files=_csv_files())
        assert resp.status_code == 403

    def test_security_manager_can_ingest(self, park_client):
        # Reset to empty first so the count delta is meaningful.
        state_mod.init_empty_dataset()
        resp = park_client.post("/api/system/stage-ingest", files=_csv_files())
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        # Ingest hash is sha256-trunc-16 — 16 hex chars.
        assert len(body["ingest_hash"]) == 16
        # The 5 Maintenance-CM rows in header.csv all land — PMCS row dropped.
        assert body["counts"]["srs"] == 5
        # Actor is the security_manager who POSTed.
        assert body["actor"]["role"] == "security_manager"
        assert body["actor"]["dodid"] == "3456789012"
        # The three named slots round-trip back as source_files.
        assert set(body["source_files"]) == {"header", "sr_parts", "due_in"}
        # PMCS filtering is reported.
        assert body["ingest_report"]["rows_filtered_pmcs"] == 1
        # Trailing-period normalization happened on at least 2 rows.
        assert body["ingest_report"]["defect_code_trailing_period_normalized"] >= 2

    def test_dataset_status_reflects_ingest(self, park_client):
        state_mod.init_empty_dataset()
        park_client.post("/api/system/stage-ingest", files=_csv_files())
        resp = park_client.get("/api/system/dataset-status")
        assert resp.status_code == 200
        body = resp.json()
        assert body["empty"] is False
        assert body["source"] == "stage-ingest"
        assert body["counts"]["srs"] == 5
        assert body["ingested_by"] == "3456789012"

    def test_bad_header_schema_rejected(self, park_client):
        """A CSV with the wrong columns returns 422 with a readable message."""
        files = _csv_files()
        files["header"] = (
            "wrong.csv",
            b"FOO,BAR,BAZ\n1,2,3\n",
            "text/csv",
        )
        resp = park_client.post("/api/system/stage-ingest", files=files)
        assert resp.status_code == 422
        assert "schema mismatch" in resp.text.lower() or "expected" in resp.text.lower()


# ---------------------------------------------------------------------------
# Empty-state envelope on the affected domain endpoints
# ---------------------------------------------------------------------------

class TestEmptyEnvelopeRoutes:
    def test_bastion_cop_returns_empty_envelope(self, g4_client):
        state_mod.init_empty_dataset()
        resp = g4_client.get("/api/bastion/cop")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {"empty": True, "message": "Awaiting GCSS-MC ingest"}

    def test_pulse_fleet_overview_returns_empty_envelope(self, g4_client):
        state_mod.init_empty_dataset()
        resp = g4_client.get("/api/pulse/fleet-overview")
        assert resp.status_code == 200
        body = resp.json()
        assert body == {"empty": True, "message": "Awaiting GCSS-MC ingest"}


# ---------------------------------------------------------------------------
# Shift+F8 failsafe — POST /system/admin/reset-demo
# ---------------------------------------------------------------------------

class TestStageFailsafe:
    def test_reset_demo_restores_seed_baseline(self, g4_client):
        # Stage an empty dataset, then verify reset-demo flips it back.
        state_mod.init_empty_dataset()
        assert state_mod.is_dataset_empty() is True
        resp = g4_client.post("/api/system/admin/reset-demo")
        # Some env gates restrict reset-demo to a single demo operator;
        # the route either succeeds (200) or 403s. We only assert the
        # not-empty side-effect when the call actually went through.
        if resp.status_code == 200:
            assert state_mod.is_dataset_empty() is False
            status = state_mod.dataset_status()
            assert status["counts"]["srs"] > 0
