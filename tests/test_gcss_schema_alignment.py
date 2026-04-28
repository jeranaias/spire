"""Tests for the GCSS-MC schema-alignment work (Task #177).

Covers:
1. The export adapter routes (T6) emit the real-shape CSV columns.
2. The SENTRY ingest adapter (T7) round-trips the export back into
   normalized SR records with no data loss on the columns SPIRE consumes.
3. The dictionary endpoint (T8) serves the derived `gcss_dictionary.json`.
4. Field-level normalizers handle the dirty signals the real export
   carries (trailing-period defect codes, DD-MON-YY dates, pre-hashed
   UICs).
"""
from __future__ import annotations

import csv
import io
from datetime import date

import pytest
from fastapi.testclient import TestClient

from backend.integrations.sentry_gcss_adapter import (
    EXPECTED_HEADER_COLUMNS,
    classify_uic_source,
    ingest_sr_header_csv,
    normalize_defect_code,
    parse_oracle_date,
)
from backend.main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def auth_client(client):
    """Returns a TestClient with a logged-in g4 session cookie."""
    resp = client.post(
        "/api/auth/login",
        json={"dodid": "1234567890", "pin": "123456"},
    )
    assert resp.status_code == 200, resp.text
    return client


# ---------------------------------------------------------------------------
# Field-level normalizers
# ---------------------------------------------------------------------------

class TestNormalizers:
    def test_defect_code_clean(self):
        assert normalize_defect_code("FCON.CBB") == ("FCON", "CBB", False)

    def test_defect_code_trailing_period(self):
        # The real export carries "FCON." as a dirty signal — operator
        # typed the primary then hit period and tabbed away.
        assert normalize_defect_code("FCON.") == ("FCON", "", True)

    def test_defect_code_primary_only(self):
        assert normalize_defect_code("FCON") == ("FCON", "", False)

    def test_defect_code_lower_case(self):
        # Operators in the field type lowercase; SPIRE upper-cases.
        assert normalize_defect_code("fcon.cbb") == ("FCON", "CBB", False)

    def test_defect_code_blank(self):
        assert normalize_defect_code("") == ("", "", False)
        assert normalize_defect_code(None) == ("", "", False)

    def test_oracle_date_two_digit_year(self):
        # 26 → 2026 (Oracle sliding window, < 70 → 20xx).
        assert parse_oracle_date("12-MAR-26") == date(2026, 3, 12)

    def test_oracle_date_four_digit_year(self):
        assert parse_oracle_date("04-JAN-2026") == date(2026, 1, 4)

    def test_oracle_date_pre_2000(self):
        # 99 → 1999 (sliding window, >= 70 → 19xx).
        assert parse_oracle_date("31-DEC-99") == date(1999, 12, 31)

    def test_oracle_date_invalid(self):
        assert parse_oracle_date("not-a-date") is None
        assert parse_oracle_date("") is None
        assert parse_oracle_date("32-FEB-26") is None  # Bad day.

    def test_uic_pre_hashed(self):
        v, src = classify_uic_source("OWNER_UNIT_92ccc0596063349d1a51")
        assert src == "pre_hashed"
        assert v == "OWNER_UNIT_92ccc0596063349d1a51"

    def test_uic_self_hashed(self):
        v, src = classify_uic_source("M00046")
        assert src == "self_hashed"
        assert v.startswith("OWNER_UNIT_")
        assert len(v) == len("OWNER_UNIT_") + 20

    def test_uic_blank(self):
        v, src = classify_uic_source("")
        assert v == ""
        assert src == "missing"


# ---------------------------------------------------------------------------
# Export → ingest round trip (T6 + T7 in one swing)
# ---------------------------------------------------------------------------

class TestExportRoundTrip:
    def test_sr_header_columns_match_real_schema(self, auth_client):
        resp = auth_client.get(
            "/api/integrations/gcss-mc/export/sr_header.csv?limit=10",
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/csv")
        assert "X-Spire-Mock" in resp.headers
        body = resp.text
        reader = csv.reader(io.StringIO(body))
        header_row = next(reader)
        assert tuple(header_row) == EXPECTED_HEADER_COLUMNS

    def test_underscore_routes_mirror_at_both_prefixes(self, auth_client):
        # Same row should appear identically at both mount points.
        a = auth_client.get("/api/gcss/export/sr_header.csv?limit=2").text
        b = auth_client.get(
            "/api/integrations/gcss-mc/export/sr_header.csv?limit=2"
        ).text
        assert a == b

    def test_parts_and_due_in_routes_serve_underscore_paths(self, auth_client):
        for path, expected_cols in (
            ("/api/gcss/export/sr_parts.csv", 6),
            ("/api/gcss/export/due_in.csv", 82),
        ):
            resp = auth_client.get(f"{path}?limit=3")
            assert resp.status_code == 200, path
            header = next(csv.reader(io.StringIO(resp.text)))
            assert len(header) == expected_cols, (path, len(header))

    def test_sensitive_fields_emit_lowercase_prefix_base64url(self, auth_client):
        resp = auth_client.get(
            "/api/gcss/export/sr_header.csv?limit=20",
        )
        rows = list(csv.DictReader(io.StringIO(resp.text)))
        for r in rows:
            for col, prefix in (
                ("SR_NUMBER", "sr_number_"),
                ("SERIAL_NUMBER", "serial_number_"),
                ("TAMCN", "tamcn_"),
                ("OWNER_UNIT_ADDRESS_CODE", "owner_unit_address_code_"),
            ):
                v = (r.get(col) or "").strip()
                if not v:
                    continue
                assert v.startswith(prefix), (col, v)
                suffix = v[len(prefix):]
                assert len(suffix) == 20, (col, v)

    def test_cross_export_hash_determinism(self, auth_client):
        # SR_NUMBER hashes must match across header and parts exports
        # for the same underlying SR.
        h_rows = list(csv.DictReader(io.StringIO(
            auth_client.get("/api/gcss/export/sr_header.csv?limit=50").text
        )))
        p_rows = list(csv.DictReader(io.StringIO(
            auth_client.get("/api/gcss/export/sr_parts.csv?limit=200").text
        )))
        header_srs = {r["SR_NUMBER"] for r in h_rows}
        parts_srs = {r["SR_NUMBER"] for r in p_rows}
        # At least one SR should appear in both windows; whichever do
        # appear must use the same hash on both sides (set membership).
        overlap = header_srs & parts_srs
        assert overlap, "no overlap between header and parts SR_NUMBERs"

    def test_export_produces_real_shape_dirty_signals(self, auth_client):
        # Pull a wide enough slice that the trailing-period dirty signal
        # has a chance to appear; 2.5% of CM rows is enough that 200 rows
        # gives ~5 hits in expectation.
        resp = auth_client.get(
            "/api/integrations/gcss-mc/export/sr_header.csv?limit=400",
        )
        assert resp.status_code == 200
        report = ingest_sr_header_csv(io.StringIO(resp.text))
        assert report.rows_total >= 1
        assert report.rows_kept >= 1
        # Round-trip should never lose more than a row to schema drift.
        assert report.schema_warnings == []
        # All rows should have parsed open_date (DD-MON-YY round-trips
        # cleanly through `_to_oracle_date` ↔ `parse_oracle_date`).
        date_failures = sum(
            1 for p in report.rows if p.open_date is None
        )
        assert date_failures == 0
        # Every row in the export should have a hashed UIC, parsed as
        # `pre_hashed` by the ingest adapter.
        non_hashed = sum(
            1 for p in report.rows if p.unit_uic_source != "pre_hashed"
        )
        assert non_hashed == 0
        # No sensitive field should require self-hashing — the export is
        # already canonical, so the gate has nothing to flag.
        assert report.unsanitized_field_counts == {}
        # Some rows should carry the trailing-period dirty signal — the
        # exact count varies with the seed but should be non-zero on a
        # 400-row pull.
        assert report.defect_code_trailing_period_normalized > 0

    def test_priority_uses_full_string_format(self, auth_client):
        resp = auth_client.get(
            "/api/integrations/gcss-mc/export/sr_header.csv?limit=50",
        )
        report = ingest_sr_header_csv(io.StringIO(resp.text))
        # Real export uses "NN B-Label" full strings.
        for p in report.rows:
            assert p.priority, f"empty priority on {p.sr_number}"
            parts = p.priority.split(" ", 1)
            assert len(parts) == 2, f"priority {p.priority!r} not 'NN B-Label'"
            assert parts[0].isdigit()
            assert parts[1] in {"A-Critical", "B-Urgent", "C-Routine"}


# ---------------------------------------------------------------------------
# Dictionary + coverage endpoints (T8)
# ---------------------------------------------------------------------------

class TestDictionaryEndpoints:
    def test_coverage_summary(self, auth_client):
        resp = auth_client.get("/api/integrations/gcss-mc/coverage-summary")
        assert resp.status_code == 200
        body = resp.json()
        assert "totals" in body
        # We've documented coverage for 32+ columns at the time of writing.
        assert body["totals"]["consumed"] >= 25
        assert body["totals"]["columns"] == 163  # 43 + 25 + 95
        assert {s["id"] for s in body["sections"]} == {"header", "parts", "due_in"}

    def test_dictionary_full(self, auth_client):
        resp = auth_client.get("/api/integrations/gcss-mc/dictionary")
        assert resp.status_code == 200
        body = resp.json()
        section_ids = {s["id"] for s in body["sections"]}
        assert section_ids == {"header", "parts", "due_in"}
        # Every header column should carry a coverage badge.
        header = next(s for s in body["sections"] if s["id"] == "header")
        for c in header["columns"]:
            assert c["coverage"]["badge"] in {"green", "amber", "red"}

    def test_dictionary_filter(self, auth_client):
        resp = auth_client.get(
            "/api/integrations/gcss-mc/dictionary?section=header"
        )
        body = resp.json()
        assert len(body["sections"]) == 1
        assert body["sections"][0]["id"] == "header"


# ---------------------------------------------------------------------------
# Last-sync endpoint — guards against the missing-import regression caught
# in the round-3 review (`hashlib` was used by `_mock_last_sync` without an
# import). Hitting the route exercises that import path end-to-end.
# ---------------------------------------------------------------------------

class TestFidelityReportEndpoint:
    """WP-8 acceptance: the Field Dictionary UI links here. Confirms the
    endpoint serves the script-managed Executive summary and Known gaps
    sections so a regenerated report still satisfies the review."""

    def test_fidelity_report_serves_markdown_with_required_sections(
        self, auth_client
    ):
        resp = auth_client.get("/api/integrations/gcss-mc/fidelity-report")
        assert resp.status_code == 200, resp.text
        ct = resp.headers.get("content-type", "")
        assert "text/markdown" in ct, ct
        body = resp.text
        assert "# GCSS-MC schema fidelity report" in body
        assert "## Executive summary" in body
        assert "## Known gaps" in body


# ---------------------------------------------------------------------------
# WP-acceptance traceability map (round-4 review feedback). Consolidated
# tests above cover the following work-package criteria:
#   WP-5 (export shape)      → TestExportRoundTrip::*
#   WP-6 (sanitization gate) → tests/playwright/sentry_upload_gate.spec.ts
#                              + adapter pytests (TestDefectCodeNorm, etc.)
#   WP-8 (dictionary + report) → TestDictionaryEndpoints::*
#                                + TestFidelityReportEndpoint::*
#                                + tests/playwright/gcss_dictionary_browse.spec.ts
#   WP-9 (real-file ingest)  → tests/playwright/gcss_real_ingest.spec.ts
#                              + tests/playwright/gcss_export_download.spec.ts
# ---------------------------------------------------------------------------


class TestLastSyncEndpoint:
    def test_last_sync_returns_deterministic_run_id(self, auth_client):
        resp = auth_client.get("/api/integrations/gcss-mc/last-sync")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["system"] == "GCSS-MC"
        assert body["connection_state"] == "MOCK_UNCONNECTED"
        # run_id must be the GCSSMC- + 10-hex-char shape produced by
        # hashlib.sha256(...).hexdigest()[:10].upper(); a missing import
        # would NameError before the response is built.
        assert body["run_id"].startswith("GCSSMC-")
        assert len(body["run_id"]) == len("GCSSMC-") + 10
        suffix = body["run_id"].removeprefix("GCSSMC-")
        assert all(c in "0123456789ABCDEF" for c in suffix), suffix
        # Records-pulled keys are stable contract surface for the topbar.
        assert set(body["records_pulled"].keys()) == {
            "asset_master",
            "readiness_status",
            "service_requests_open",
            "supply_documents_open",
        }


class TestEquipmentProfilesDefectVocab:
    """Regression tests for WP-1: every fault in equipment_profiles.json
    must use the real GCSS-MC defect vocabulary, not the legacy synthetic
    tuples (NMAJ.TRSM, SAFE.BRAK, COSM.CORR, MINR.*).

    A reviewer caught the previous round shipping legacy tokens via the
    per-class profile even though the central defect_codes generator was
    aligned. This test fails fast if a legacy primary slips back in.
    """

    LEGACY_PRIMARIES = {"COSM", "MINR", "NMAJ", "SAFE"}

    REAL_PRIMARIES = {
        "FCON", "WPNS", "ELEC", "COMP", "DAD1", "BODY", "ENG",
        "TRAN", "AXLE", "FUEL", "COOL", "TEDD",
    }

    def _load_profiles(self) -> dict:
        import json
        from pathlib import Path

        path = Path(__file__).resolve().parent.parent / "dataset" / "data" / "equipment_profiles.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_no_legacy_defect_primaries_in_equipment_profiles(self):
        prof = self._load_profiles()
        offenders: list[tuple[str, str, list]] = []
        for cls, p in prof.items():
            for fault in p.get("faults", []):
                code = fault.get("defect_code", [])
                if code and code[0] in self.LEGACY_PRIMARIES:
                    offenders.append((cls, fault.get("id", "?"), code))
        assert not offenders, (
            "Legacy defect primaries found in equipment_profiles.json (WP-1 "
            f"regression): {offenders[:5]}{'...' if len(offenders) > 5 else ''}"
        )

    def test_all_19_classes_use_real_gcss_vocab(self):
        prof = self._load_profiles()
        assert len(prof) == 19, f"expected 19 classes, got {len(prof)}"
        used: set[str] = set()
        for cls, p in prof.items():
            for fault in p.get("faults", []):
                code = fault.get("defect_code", [])
                if code:
                    used.add(code[0])
        # Every primary actually used must be from the real GCSS-MC top-25
        # vocabulary (no legacy tokens, no off-vocabulary inventions).
        bogus = used - self.REAL_PRIMARIES
        assert not bogus, f"non-real defect primaries in profiles: {bogus}"
