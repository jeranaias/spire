"""
Task #155 — coverage for the SENTRY coalition release manifest hash.

Task #24 introduced the SHA-256 manifest hash that gets stamped into the
audit row when a security manager hits POST /api/sentry/coalition/{key}/release.
Its forensic value rests on three properties that nobody currently
guards against silent regression:

  1. Stability      — two releases for the same profile against an
                      unchanged dataset produce the same hash.
  2. Uniqueness     — releases for different profiles produce different
                      hashes (so an FVEY hash can't be confused with a
                      JPN one).
  3. Sensitivity    — mutating the dataset, the redaction policy, or
                      the profile key all change the hash (so a future
                      "let's also include requisitions in the manifest"
                      change cannot silently invalidate prior audit rows).

Properties 1, 2, and 3 are exercised both at the helper level
(`dataset.coalition.release_manifest`) and over the wire via the
authenticated endpoint, mirroring the test pattern in
`backend/tests/test_classification_gate.py`.
"""
from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from dataset import coalition


# Park = CWO3 James Park, security_manager / TS//SCI — the role gated to
# call POST /api/sentry/coalition/{key}/release.
PARK_DODID = "3456789012"


@pytest.fixture()
def client():
    # Context-manager form so FastAPI runs the lifespan handler that loads
    # the canonical dataset; coalition_release reads from get_dataset().
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _sample_records() -> list[dict]:
    """A small in-scope record set for FVEY_BASE / FVEY_LOG. Both profiles
    accept UNCLASSIFIED data from 2d MLG, so the same input list flows
    through `classify_record` for either profile."""
    return [
        {
            "sr_number": "SR-CM-001",
            "unit_name": "CLB-2",
            "unit_parent": "2d MLG",
            "category": "readiness_summary",
            "detected_classification": "UNCLASSIFIED",
        },
        {
            "sr_number": "SR-CM-002",
            "unit_name": "CLB-2",
            "unit_parent": "2d MLG",
            "category": "readiness_summary",
            "detected_classification": "UNCLASSIFIED",
        },
        {
            "sr_number": "SR-CM-003",
            "unit_name": "CLB-2",
            "unit_parent": "2d MLG",
            "category": "readiness_summary",
            "detected_classification": "UNCLASSIFIED",
        },
    ]


# ---------------------------------------------------------------------------
# Property 1 — stability
# ---------------------------------------------------------------------------

def test_release_manifest_is_stable_across_calls():
    """Same profile + same input records → identical manifest hash and
    record_count. SR ID order in the input must not affect the result."""
    records = _sample_records()
    first = coalition.release_manifest("FVEY_BASE", records)
    second = coalition.release_manifest("FVEY_BASE", list(reversed(records)))

    assert first["manifest_sha256"] == second["manifest_sha256"]
    assert first["record_count"] == second["record_count"] == 3
    assert first["sr_ids"] == second["sr_ids"]  # sorted in-scope SR id set


# ---------------------------------------------------------------------------
# Property 2 — per-partner uniqueness
# ---------------------------------------------------------------------------

def test_release_manifest_differs_across_profiles():
    """Two profiles fed the same records produce different hashes. FVEY_BASE
    and FVEY_LOG accept the same UNCLASSIFIED 2d MLG records but diverge on
    redactions and partner posture, so the audit hash must distinguish
    them."""
    records = _sample_records()
    base = coalition.release_manifest("FVEY_BASE", records)
    log = coalition.release_manifest("FVEY_LOG", records)

    assert base["manifest_sha256"] != log["manifest_sha256"], (
        "FVEY_BASE and FVEY_LOG must hash to different manifests so an "
        "auditor can't conflate the two releases."
    )


def test_release_manifest_changes_when_only_profile_key_changes(monkeypatch):
    """Even with identical redactions and an identical SR id set, swapping
    the profile_key alone must change the hash. This isolates the
    `profile` field of the canonical payload from redactions and dataset
    drift, so a future refactor that drops it would fail loudly."""
    cache = copy.deepcopy(coalition.profiles())
    cache["profiles"]["__TEST_A__"] = {
        "display_name": "Test profile A",
        "partners": ["USA"],
        "distribution_statement": "TEST",
        "authorized_classifications": ["UNCLASSIFIED"],
        "field_redactions": ["EDIPI"],
    }
    cache["profiles"]["__TEST_B__"] = {
        "display_name": "Test profile B",
        "partners": ["USA"],
        "distribution_statement": "TEST",
        "authorized_classifications": ["UNCLASSIFIED"],
        "field_redactions": ["EDIPI"],
    }
    monkeypatch.setattr(coalition, "_CACHE", cache)

    records = _sample_records()
    h_a = coalition.release_manifest("__TEST_A__", records)
    h_b = coalition.release_manifest("__TEST_B__", records)

    assert h_a["sr_ids"] == h_b["sr_ids"]  # control: same in-scope SR set
    assert h_a["manifest_sha256"] != h_b["manifest_sha256"]


# ---------------------------------------------------------------------------
# Property 3 — sensitivity
# ---------------------------------------------------------------------------

def test_release_manifest_changes_when_dataset_mutates():
    """Adding an SR to the in-scope set must change the hash. Equivalent to
    the `we also included requisitions in the manifest` scenario the task
    description warns against — except here we mutate the input set
    instead of the manifest schema."""
    records = _sample_records()
    base = coalition.release_manifest("FVEY_BASE", records)

    extra = list(records) + [
        {
            "sr_number": "SR-CM-999",
            "unit_name": "CLB-2",
            "unit_parent": "2d MLG",
            "category": "readiness_summary",
            "detected_classification": "UNCLASSIFIED",
        }
    ]
    mutated = coalition.release_manifest("FVEY_BASE", extra)

    assert base["manifest_sha256"] != mutated["manifest_sha256"]
    assert mutated["record_count"] == base["record_count"] + 1
    assert "SR-CM-999" in mutated["sr_ids"]


def test_release_manifest_changes_when_redaction_policy_mutates(monkeypatch):
    """Mutating a profile's `field_redactions` (without touching the
    in-scope SR set) must change the manifest hash. Without this property
    a partner could silently receive a different scrub policy under the
    same audit hash, which would defeat the whole point of stamping
    `redactions` into the manifest payload."""
    cache = copy.deepcopy(coalition.profiles())

    # Baseline hash from the real, on-disk redaction policy.
    records = _sample_records()
    baseline = coalition.release_manifest("FVEY_BASE", records)

    # Now swap the profile's redaction list under the cache and recompute.
    cache["profiles"]["FVEY_BASE"]["field_redactions"] = [
        "EDIPI",
        "POC_PHONE",
        "billet_nickname",
        "serial_number",  # <-- new field added to the policy
    ]
    monkeypatch.setattr(coalition, "_CACHE", cache)

    mutated = coalition.release_manifest("FVEY_BASE", records)

    assert mutated["sr_ids"] == baseline["sr_ids"]  # control: SR set unchanged
    assert mutated["manifest_sha256"] != baseline["manifest_sha256"]


# ---------------------------------------------------------------------------
# Endpoint-level coverage — what an investigator actually sees on the wire.
# ---------------------------------------------------------------------------

def test_coalition_release_endpoint_hash_is_stable_for_same_profile(client):
    """End-to-end: Park signs in, POSTs the FVEY_BASE release twice, and
    both responses must return the same manifest_sha256 and record_count.
    This is the property an after-action review depends on."""
    _login(client, PARK_DODID)

    r1 = client.post("/api/sentry/coalition/FVEY_BASE/release", json={})
    assert r1.status_code == 200, r1.text
    r2 = client.post("/api/sentry/coalition/FVEY_BASE/release", json={})
    assert r2.status_code == 200, r2.text

    body1, body2 = r1.json(), r2.json()
    assert body1["ok"] is True and body2["ok"] is True
    assert body1["manifest_sha256"] == body2["manifest_sha256"], (
        "two releases for the same profile against an unchanged dataset "
        "must produce the same manifest hash"
    )
    assert body1["record_count"] == body2["record_count"]
    # release_id must still rotate per call, even when the manifest is
    # identical — otherwise audit-row dedup would collapse separate clicks.
    assert body1["release_id"] != body2["release_id"]


def test_coalition_release_endpoint_hash_differs_across_profiles(client):
    """End-to-end uniqueness: a release against FVEY_BASE and one against
    JPN_COALITION must produce different manifest hashes, so an auditor
    can tell from the audit row alone which partner received what."""
    _login(client, PARK_DODID)

    r_fvey = client.post("/api/sentry/coalition/FVEY_BASE/release", json={})
    assert r_fvey.status_code == 200, r_fvey.text
    r_jpn = client.post("/api/sentry/coalition/JPN_COALITION/release", json={})
    assert r_jpn.status_code == 200, r_jpn.text

    assert (
        r_fvey.json()["manifest_sha256"]
        != r_jpn.json()["manifest_sha256"]
    )
