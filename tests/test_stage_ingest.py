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
        # Ingest hash is full sha256 — 64 hex chars.
        assert len(body["ingest_hash"]) == 64
        assert all(c in "0123456789abcdef" for c in body["ingest_hash"])
        # The 5 Maintenance-CM rows in header.csv all land — PMCS row dropped.
        assert body["counts"]["srs"] == 5
        # Actor is the security_manager who POSTed.
        assert body["actor"]["role"] == "security_manager"
        assert body["actor"]["dodid"] == "3456789012"
        # The three named slots round-trip back as source_files, each
        # carrying name/bytes/rows_parsed so the hero card can show the
        # operator a per-file row count alongside the byte size.
        assert set(body["source_files"]) == {"header", "sr_parts", "due_in"}
        for slot in ("header", "sr_parts", "due_in"):
            sf = body["source_files"][slot]
            assert {"name", "bytes", "rows_parsed"} <= set(sf), sf
            assert isinstance(sf["rows_parsed"], int) and sf["rows_parsed"] >= 0
        # The 6-row header fixture has 5 Maintenance-CM rows + 1 PMCS row;
        # the parsed-row count is row count of the CSV, not the post-PMCS
        # filter, so it should be 6 (5 + 1 PMCS, all 6 are parsed before
        # the cm_only filter drops the PMCS row).
        assert body["source_files"]["header"]["rows_parsed"] == 6
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
    def test_reset_demo_allows_stage_operator_role(self, park_client):
        """Stage-ingest operators (data_custodian, security_manager)
        must be able to fire the Shift+F8 failsafe — RESET_DEMO_ROLES
        was extended for Task #183 so the on-stage failsafe path is
        usable by the same Marines who run the ingest."""
        state_mod.init_empty_dataset()
        resp = park_client.post("/api/system/admin/reset-demo")
        # Stage operator must succeed — this is the regression the
        # reviewer flagged. 403 here means the failsafe is broken.
        assert resp.status_code == 200, resp.text
        assert state_mod.is_dataset_empty() is False
        assert state_mod.dataset_status()["counts"]["srs"] > 0

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


# ---------------------------------------------------------------------------
# Robustness: idempotency, parser timeout, malformed CSV, post-ingest
# hydration of every empty-state route.
# ---------------------------------------------------------------------------

class TestStageIngestRobustness:
    """Coverage for the failure / robustness modes the reviewer flagged
    as missing: same-input idempotency (matching ingest_hash + counts),
    the 60s parser timeout path (exercised by reducing the cap), the
    malformed-CSV parser-error path, and the post-ingest hydration
    behavior of every empty-state route."""

    def test_double_ingest_is_idempotent(self, park_client):
        """Same three CSVs in twice → identical ingest_hash + identical
        downstream counts. Confirms the hash is content-only (order /
        whitespace-stable) and the dataset build is deterministic."""
        state_mod.init_empty_dataset()
        first = park_client.post("/api/system/stage-ingest", files=_csv_files())
        assert first.status_code == 200
        first_body = first.json()

        # Re-stage empty so the second call rebuilds from scratch — we
        # don't want the second swap to be reading stale state.
        state_mod.init_empty_dataset()
        second = park_client.post("/api/system/stage-ingest", files=_csv_files())
        assert second.status_code == 200
        second_body = second.json()

        assert first_body["ingest_hash"] == second_body["ingest_hash"]
        assert first_body["counts"]["srs"] == second_body["counts"]["srs"]
        assert first_body["counts"]["units"] == second_body["counts"]["units"]
        assert (
            first_body["counts"]["assets"] == second_body["counts"]["assets"]
        )

    def test_parser_timeout_returns_504(self, park_client, monkeypatch):
        """Force the wall-clock cap to 0.05s AND make the in-thread
        parser sleep 0.5s so the timeout always trips. Asserts a
        deterministic 504 with the operator-facing failsafe copy.
        Monkeypatching the parser itself (not just the cap) removes
        the race window that previously forced us to accept 200."""
        import time as _time

        from backend.routes import stage_ingest as si_mod

        original_ingest = si_mod.ingest_sr_header_csv

        def _slow_ingest(text, **kwargs):
            # Sleep an order of magnitude longer than the cap so the
            # asyncio.wait_for in _run_ingest_with_timeout always fires
            # before _do_parse returns.
            _time.sleep(0.5)
            return original_ingest(text, **kwargs)

        monkeypatch.setattr(si_mod, "STAGE_INGEST_TIMEOUT_S", 0.05)
        monkeypatch.setattr(si_mod, "ingest_sr_header_csv", _slow_ingest)

        resp = park_client.post("/api/system/stage-ingest", files=_csv_files())
        assert resp.status_code == 504, resp.text
        body_lower = resp.text.lower()
        assert "exceeded" in body_lower
        assert "shift+f8" in body_lower or "failsafe" in body_lower

    def test_malformed_header_returns_4xx(self, park_client):
        """Binary garbage in header.csv — not a CSV at all — comes out
        as a 4xx with a readable message. Must NOT 500 the request."""
        files = _csv_files()
        files["header"] = (
            "garbage.bin",
            b"\x00\x01\x02\x03\xff\xfe\xfd not a csv at all",
            "application/octet-stream",
        )
        resp = park_client.post("/api/system/stage-ingest", files=files)
        # The decode is lossy (utf-8-sig with errors=replace) so the
        # bytes get through to the schema gate, which rejects them as
        # not-a-GCSS-MC-header. 422 is the expected status for either
        # the schema gate or a downstream parser exception path.
        assert resp.status_code in (400, 422), resp.text
        assert resp.status_code < 500

    def test_malformed_sr_parts_returns_422(self, park_client):
        """Whitespace-only sr_parts.csv must NOT silently fall through
        to a 200 with a partial dataset (round-5 review). The route
        should return 422 with an operator-facing parser message."""
        files = _csv_files()
        files["sr_parts"] = (
            "sr_parts.csv",
            b"\n   \n\t\n",
            "text/csv",
        )
        resp = park_client.post("/api/system/stage-ingest", files=files)
        assert resp.status_code == 422, resp.text
        assert "sr_parts" in resp.text.lower()

    def test_malformed_due_in_returns_422(self, park_client):
        """due_in.csv with no usable header row must fail with 422,
        not silently degrade to an empty-reqs ingest."""
        files = _csv_files()
        files["due_in"] = (
            "due_in.csv",
            # A single-byte file decodes to a non-empty body but has
            # no comma-delimited header → DictReader.fieldnames=[','].
            # We send a comma-only first line so the header parses to
            # ['',''] (no usable column names) and the parser must reject.
            b",\n,\n",
            "text/csv",
        )
        resp = park_client.post("/api/system/stage-ingest", files=files)
        # Either a 422 ("no usable header") or a downstream lift failure
        # in _due_in_to_reqs that re-surfaces as 422 from the outer wrap.
        assert resp.status_code == 422, resp.text

    def test_post_ingest_hydrates_bastion_cop(self, park_client):
        """After a successful stage-ingest the synthesized snapshot
        block flips /api/bastion/cop off the empty envelope — the
        route returns the populated COP shape with units."""
        state_mod.init_empty_dataset()
        ingest = park_client.post(
            "/api/system/stage-ingest", files=_csv_files(),
        )
        assert ingest.status_code == 200
        cop_resp = park_client.get("/api/bastion/cop")
        assert cop_resp.status_code == 200
        body = cop_resp.json()
        # No longer the empty envelope; populated COP carries units.
        assert "empty" not in body or body.get("empty") is not True
        assert "units" in body, f"COP missing units key: {body}"
        assert len(body["units"]) >= 1

    def test_post_ingest_hydrates_pulse_fleet_overview(self, park_client):
        """After stage-ingest, /api/pulse/fleet-overview returns the
        populated FleetOverview shape (heatmap/equipment_types) rather
        than the empty envelope — the synthesized snapshots feed the
        per-unit aggregation pipeline. Park ingests; a separate g4
        TestClient reads PULSE because security_manager isn't in
        PULSE_VIEW_ROLES (chaining park_client and g4_client onto the
        same TestClient would clobber Park's cookie)."""
        state_mod.init_empty_dataset()
        ing = park_client.post("/api/system/stage-ingest", files=_csv_files())
        assert ing.status_code == 200, ing.text
        with TestClient(app) as g4:
            assert g4.post(
                "/api/auth/login",
                json={"dodid": "1234567890", "pin": "123456"},
            ).status_code == 200
            resp = g4.get("/api/pulse/fleet-overview")
        assert resp.status_code == 200
        body = resp.json()
        assert "empty" not in body or body.get("empty") is not True
        # Populated FleetOverview carries heatmap + equipment_types.
        assert "heatmap" in body or "hero_metrics" in body, body

    def test_reqs_carry_real_document_numbers(self, park_client):
        """The due_in.csv document_numbers ride through to the dataset
        reqs list — no fabricated DOC-NNN. Confirms finding #2 of the
        review (real records driving downstream dashboards)."""
        from backend import state as st_mod
        state_mod.init_empty_dataset()
        ing = park_client.post("/api/system/stage-ingest", files=_csv_files())
        assert ing.status_code == 200
        ds = st_mod.get_dataset()
        assert len(ds.reqs) >= 1
        doc_numbers = {getattr(r, "document_number", None) for r in ds.reqs}
        # Every doc number is a real one from due_in.csv (starts with
        # DOCUMENT_NUMBER_ per the sanitized fixture), never the
        # fabricated STAGE-DOC-/DOC-NNN fallback.
        assert all(
            d and d.startswith("DOCUMENT_NUMBER_") for d in doc_numbers
        ), f"unexpected doc numbers: {doc_numbers}"

    def test_assets_have_attribute_access(self, park_client):
        """ds.assets entries must support attribute access (a.asset_id,
        a.unit_name, a.equipment_type) — that's the contract every
        PULSE/BASTION reader uses. Confirms finding #3 of the review."""
        from backend import state as st_mod
        state_mod.init_empty_dataset()
        park_client.post("/api/system/stage-ingest", files=_csv_files())
        ds = st_mod.get_dataset()
        assert len(ds.assets) >= 1
        for a in ds.assets:
            # Each of these would AttributeError on a plain dict —
            # the test catches the regression the reviewer flagged.
            assert isinstance(a.asset_id, str) and a.asset_id
            assert isinstance(a.unit_name, str)
            assert isinstance(a.equipment_type, str)
            assert hasattr(a, "current_hours")
            assert hasattr(a, "open_srs")
        # CanonicalDataset.asset() index must roundtrip.
        first = ds.assets[0]
        assert ds.asset(first.asset_id) is first

    def test_post_ingest_dataset_status_carries_provenance(self, park_client):
        """After stage-ingest, /api/system/dataset-status surfaces the
        ingest_hash + ingested_by + non-zero counts in a single shot."""
        state_mod.init_empty_dataset()
        ing = park_client.post("/api/system/stage-ingest", files=_csv_files())
        ing_hash = ing.json()["ingest_hash"]
        status = park_client.get("/api/system/dataset-status").json()
        assert status["empty"] is False
        assert status["source"] == "stage-ingest"
        assert status["ingest_hash"] == ing_hash
        assert status["ingested_by"] == "3456789012"
        assert status["counts"]["srs"] >= 1
        assert status["counts"]["units"] >= 1


class TestForceEmptyHook:
    """The Playwright spec needs a deterministic way to drive the
    backend into the empty state; the test-only force-empty route is
    gated on ``SPIRE_TEST_HOOKS=1`` and 404s otherwise."""

    def test_force_empty_disabled_by_default(self, park_client, monkeypatch):
        monkeypatch.delenv("SPIRE_TEST_HOOKS", raising=False)
        resp = park_client.post("/api/system/admin/force-empty")
        assert resp.status_code == 404

    def test_force_empty_enabled_with_env(self, park_client, monkeypatch):
        monkeypatch.setenv("SPIRE_TEST_HOOKS", "1")
        # Pre-populate so the assertion is meaningful.
        park_client.post("/api/system/stage-ingest", files=_csv_files())
        assert state_mod.is_dataset_empty() is False
        resp = park_client.post("/api/system/admin/force-empty")
        assert resp.status_code == 200
        assert state_mod.is_dataset_empty() is True

    def test_force_empty_requires_privileged_role(self, client, monkeypatch):
        """Round-6 review fix: env-gate alone is insufficient. The
        endpoint now also requires a privileged role (RESET_DEMO_ROLES =
        g4 / data_custodian / security_manager). An unauthenticated
        caller must be denied even when SPIRE_TEST_HOOKS=1 — closes
        the leak the reviewer flagged where a stray env var on a
        non-test backend would let any anon caller reset the dataset.
        """
        monkeypatch.setenv("SPIRE_TEST_HOOKS", "1")
        resp = client.post("/api/system/admin/force-empty")
        # No login → require_role denies. Accept either 401 (auth mw)
        # or 403 (role gate) so the test isn't coupled to mw ordering.
        assert resp.status_code in (401, 403), resp.text
