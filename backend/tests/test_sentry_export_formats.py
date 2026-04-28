"""
Task-70 — lock in the SENTRY export format contract and Distribution
Statement derivation.

Before this task, the segmented control on the Export tab was theater:
the backend always wrote ``sanitized_dataset.xlsx`` regardless of the
``format`` field, and every release authority (US_ONLY / FVEY / NATO /
SPECIFIC) hardcoded "Distribution C" — the wrong DoDI 5230.24 letter
for sanitized public-affairs (A or B) releases. The audit-log snapshot
inside the bundle also stripped the per-event ``payload`` field, so a
downstream verifier could check the chain hash but couldn't reconstruct
what each row meant.

These tests lock in:

* CSV/JSON/XLSX selections each produce the matching dataset and
  redaction-report files inside the bundle (no XLSX fall-through).
* The audit_log.json snapshot includes every entry's ``payload`` (with
  ``source_ip`` redacted per OPSEC).
* The Distribution Statement / Authority is derived from
  (release_authority, classification) per DoDI 5230.24, not hardcoded.
"""
from __future__ import annotations

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.routes.sentry import derive_distribution


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _export_and_download(client: TestClient, fmt: str, release: str = "US_ONLY") -> tuple[dict, bytes]:
    r = client.post(
        "/api/sentry/export",
        json={
            "release_authority": release,
            "format": fmt,
            "include_audit": True,
            "batch_id": None,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    d = client.get(body["download_url"])
    assert d.status_code == 200, d.text
    return body, d.content


@pytest.mark.parametrize("fmt,ext", [("xlsx", ".xlsx"), ("csv", ".csv"), ("json", ".json")])
def test_export_actually_writes_requested_format(client, fmt, ext):
    """The dataset and redaction-report files in the bundle must carry
    the extension the operator selected — not silently fall through to
    XLSX."""
    _login(client, "3456789012")  # security_manager (TS//SCI)
    body, raw = _export_and_download(client, fmt)
    assert body["format"] == fmt

    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        names = set(z.namelist())
        assert f"sanitized_dataset{ext}" in names, names
        assert f"redaction_report{ext}" in names, names
        # No stale XLSX should appear when a non-xlsx format was selected.
        if fmt != "xlsx":
            assert "sanitized_dataset.xlsx" not in names
            assert "redaction_report.xlsx" not in names


def test_csv_export_is_real_csv_with_classification_banner(client):
    _login(client, "3456789012")
    _, raw = _export_and_download(client, "csv")
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        body = z.read("sanitized_dataset.csv").decode("utf-8")
    # Banner first, then the real header row appears further down.
    assert "CLASSIFICATION" in body
    assert "SR Number" in body


def test_json_export_is_parseable_object_array(client):
    _login(client, "3456789012")
    _, raw = _export_and_download(client, "json")
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        obj = json.loads(z.read("sanitized_dataset.json"))
    assert isinstance(obj, dict)
    assert "records" in obj and isinstance(obj["records"], list)
    assert obj.get("classification_banner", "").startswith("// CLASSIFICATION:")


def test_audit_log_snapshot_includes_payload_with_source_ip_redacted(client):
    """The bundled audit_log.json must carry each entry's payload so a
    downstream verifier can reconstruct what the row meant — but with
    source_ip redacted per OPSEC."""
    _login(client, "3456789012")
    _, raw = _export_and_download(client, "json")
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        audit = json.loads(z.read("audit_log.json"))

    entries = audit["recent_entries"]
    assert entries, "expected audit entries"
    # Every entry must have a payload key (dict, possibly empty).
    assert all("payload" in e for e in entries), "audit snapshot stripped payloads"
    # source_ip, if present anywhere, must be the OPSEC redaction marker.
    for e in entries:
        p = e.get("payload") or {}
        if isinstance(p, dict) and "source_ip" in p:
            assert p["source_ip"] == "[REDACTED:OPSEC]"


def test_distribution_authority_derived_per_release_and_classification():
    """Doctrinal letter must shift with the source classification, not
    stay pinned at C. Locks the DoDI 5230.24 mapping in code."""
    cases = [
        ("US_ONLY", "UNCLASSIFIED", "Distribution A"),
        ("US_ONLY", "CUI", "Distribution B"),
        ("US_ONLY", "FOUO", "Distribution B"),
        ("US_ONLY", "SECRET", "Distribution C"),
        ("US_ONLY", "TS_SCI", "Distribution C"),
        ("FVEY", "SECRET", "Distribution C"),
        ("NATO", "SECRET", "Distribution C"),
        ("SPECIFIC", "SECRET", "Distribution C"),
        ("UNKNOWN", "SECRET", "Distribution F"),
    ]
    for rel, cls, expected_auth in cases:
        auth, stmt = derive_distribution(rel, cls)
        assert auth == expected_auth, (rel, cls, auth)
        # Statement letter must match the authority letter.
        assert stmt.startswith(f"DISTRIBUTION {expected_auth.split()[-1]}:"), stmt


def test_export_response_distribution_authority_matches_derivation(client):
    """End-to-end: the API response carries the derived authority, not
    hardcoded 'Distribution C', and the manifest agrees."""
    _login(client, "3456789012")
    body, raw = _export_and_download(client, "xlsx", release="US_ONLY")
    auth, _ = derive_distribution("US_ONLY", body["classification"])
    assert body["distribution_authority"] == auth
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        manifest = json.loads(z.read("MANIFEST.json"))
    assert manifest["distribution_authority"] == auth
    assert manifest["format"] == "xlsx"
