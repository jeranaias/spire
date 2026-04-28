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
from backend.routes.sentry import (
    _aggregate_sensitive_flags,
    _distribution_reason,
    _select_distribution,
    derive_distribution,
)


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


def test_export_response_distribution_authority_is_content_aware(client):
    """End-to-end: the API response carries a *content-driven* authority
    (Task-172) — the union of sensitive flags across the included records is
    fed to `_select_distribution`, not just the bundle classification with
    an empty flag list. The manifest agrees, surfaces the bare letter, and
    names the dominant evidence in `distribution_reason`."""
    _login(client, "3456789012")
    body, raw = _export_and_download(client, "xlsx", release="US_ONLY")
    flags = body.get("distribution_evidence_flags") or []
    expected_auth, _ = _select_distribution(body["classification"], flags)
    assert body["distribution_authority"] == f"Distribution {expected_auth}"
    assert body["distribution_letter"] == expected_auth
    assert isinstance(body.get("distribution_reason"), str) and body["distribution_reason"]
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        manifest = json.loads(z.read("MANIFEST.json"))
    assert manifest["distribution_authority"] == f"Distribution {expected_auth}"
    assert manifest["distribution_letter"] == expected_auth
    assert manifest["distribution_reason"] == body["distribution_reason"]
    assert manifest["format"] == "xlsx"


# Task-172 — direct unit coverage for the new helpers. The previous
# behavior collapsed every CUI bundle to "Distribution C" because the
# selector was called with an empty flag list; the helpers now derive the
# letter from the union of per-record `sensitive_flags_oracle`.
def test_aggregate_sensitive_flags_unions_across_records():
    records = [
        {"sr_number": "SR-1", "sensitive_flags_oracle": ["pii"]},
        {"sr_number": "SR-2", "sensitive_flags_oracle": ["controlled"]},
        {"sr_number": "SR-3", "sensitive_flags_oracle": []},
        {"sr_number": "SR-4"},  # missing key — must not raise
    ]
    assert _aggregate_sensitive_flags(records) == {"pii", "controlled"}


def test_select_distribution_letter_is_content_aware_for_cui_bundles():
    """A CUI bundle with controlled-item serials lands at B, not C, even
    when the bundle classification alone (cls + []) would have been C."""
    # Pre-Task-172 behavior — empty flag list → C.
    pre, _ = _select_distribution("CUI", [])
    assert pre == "C"
    # Post-Task-172 — content-driven aggregation surfaces "controlled" → B.
    letter_b, _ = _select_distribution("CUI", ["controlled"])
    assert letter_b == "B"
    # PII-only (no operational geo/comms) also lands at B.
    letter_b2, _ = _select_distribution("CUI", ["pii"])
    assert letter_b2 == "B"
    # Operational CUI (geo or comms present) stays at C.
    letter_c, _ = _select_distribution("CUI", ["pii", "geo"])
    assert letter_c == "C"
    # SECRET aggregates up to D regardless of flags.
    letter_d, _ = _select_distribution("SECRET", ["pii", "geo", "comms"])
    assert letter_d == "D"


def test_select_distribution_handles_ts_sci_and_unknown_classes():
    """TS//SCI is more restrictive than plain TOP SECRET — must NOT fall
    through to the permissive default branch (which would return B and
    *broaden* an SCI bundle's distribution to "U.S. Government only").
    Unknown classification strings must fail closed to F per the new
    fail-closed default."""
    # TS_SCI is the normalized class string used by the export path.
    letter_ts_sci, _ = _select_distribution("TS_SCI", [])
    assert letter_ts_sci == "E"
    letter_ts, _ = _select_distribution("TS", ["pii"])
    assert letter_ts == "E"
    letter_top, _ = _select_distribution("TOP_SECRET", ["geo"])
    assert letter_top == "E"
    # Unknown strings must fail closed, not silently broaden.
    letter_unknown, _ = _select_distribution("WHO_KNOWS", ["pii"])
    assert letter_unknown == "F"


def test_distribution_reason_names_dominant_evidence():
    """Reason strings must mirror the selector's branches so they never
    contradict the chosen letter."""
    assert "controlled" in _distribution_reason("CUI", {"controlled", "pii"})
    assert "PII" in _distribution_reason("CUI", {"pii"})
    op = _distribution_reason("CUI", {"geo", "comms"})
    assert "operational" in op and "geo" in op and "comms" in op
    assert "SECRET" in _distribution_reason("SECRET", set())
    assert "TOP SECRET" in _distribution_reason("TOP_SECRET", set())
    assert "public release" in _distribution_reason("UNCLASSIFIED", set())


# ---------------------------------------------------------------------------
# Task #109 — sample-diff diversity
#
# Pre-Task-109 the export's "Before / After · 3 Sample Records" panel just
# took the first three records with any sensitive flag. The canonical dataset
# is heavily PII-skewed (128 PII spans vs. 7 geo / 2 classified / 1
# controlled), so reviewers always saw three PII redactions and assumed the
# rest of the sanitizer's rules had been exercised when in fact they couldn't
# tell. The picker now prefers one representative per rule category before
# backfilling, and the response surfaces missing categories so the panel can
# render an explicit "no <category> redactions in this batch" note.
# ---------------------------------------------------------------------------

CANONICAL_CATEGORY_ORDER = ["pii", "geo", "comms", "classified", "controlled"]


def test_sample_diffs_cover_every_category_present_in_canonical_dataset(client):
    """The sample picker must surface one diff per rule category that
    actually fired in the batch — not three PII redactions in a row.

    The full canonical dataset (≈6.3k SRs) exercises every sanitizer
    rule (pii / geo / comms / classified / controlled). The picked diffs
    must therefore collectively expose all five so a reviewer scanning
    the panel can see the rules actually ran. Pre-Task-109 the picker
    just took the first three flagged records, which on this dataset
    were all PII.
    """
    _login(client, "3456789012")
    body, _ = _export_and_download(client, "json")

    sample_diffs = body.get("sample_diffs") or []
    assert sample_diffs, "expected at least one sample diff on the canonical dataset"

    # Coverage metadata must be present and well-formed.
    cats = body.get("sample_categories")
    assert cats is not None, "response must surface sample_categories for FE coverage notes"
    assert cats["all"] == CANONICAL_CATEGORY_ORDER
    # present + missing must partition `all` exactly — no overlap, no gaps,
    # so the FE can trust the lists without re-deriving them.
    assert set(cats["present"]).isdisjoint(cats["missing"])
    assert set(cats["present"]) | set(cats["missing"]) == set(cats["all"])

    # On the full canonical dataset every sanitizer rule fires at least
    # once, so the picker is expected to surface all five categories.
    for cat in CANONICAL_CATEGORY_ORDER:
        assert cat in cats["present"], (cat, cats)
    assert cats["missing"] == [], cats

    # Every category reported "present" must actually be backed by a span
    # in one of the picked diffs — otherwise the panel's coverage badges
    # would lie about what the sanitizer did.
    span_categories = {
        sp.get("category")
        for d in sample_diffs
        for sp in (d.get("removed_spans") or [])
    }
    for cat in cats["present"]:
        assert cat in span_categories, (cat, span_categories)

    # Diversity floor: pre-Task-109 the panel surfaced exactly one
    # category (pii). Now we expect every sanitizer rule that fired in
    # the batch to be represented across the picked diffs.
    assert span_categories.issuperset(set(CANONICAL_CATEGORY_ORDER)), span_categories


def test_sample_diffs_emit_missing_note_when_a_category_does_not_fire(client):
    """When a rule category never fires in the batch, the response must
    list it under `sample_categories.missing` so the FE can render an
    explicit "No <category> redactions in this batch" note instead of
    silently omitting it. We force this by exporting from a synthetic
    batch whose remarks only trigger PII patterns.
    """
    from backend.routes.sentry import _BATCHES, _new_batch

    _login(client, "3456789012")

    # PII-only synthetic batch: EDIPI patterns trigger `pii_edipi`, and
    # nothing in these remarks matches the geo / comms / classified /
    # controlled regexes.
    pii_only = [
        {
            "sr_number": f"SR-T109-{i:03d}",
            "asset_id": f"AST-{i:03d}",
            "unit_name": "1st Bn",
            "equipment_type": "MTV",
            "remark": f"POC EDIPI 12345678{i % 10:02d} for parts request.",
            "source_classification": "UNCLASSIFIED",
            "detected_classification_oracle": "UNCLASSIFIED",
            "sensitive_flags_oracle": ["pii"],
            "condition": "Operational",
        }
        for i in range(5)
    ]
    batch = _new_batch(record_source="task109_test", records=pii_only)
    batch_id = batch["batch_id"]
    try:
        r = client.post(
            "/api/sentry/export",
            json={
                "release_authority": "US_ONLY",
                "format": "json",
                "include_audit": True,
                "batch_id": batch_id,
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        cats = body["sample_categories"]
        # Only pii fires; everything else must show up as missing.
        assert cats["present"] == ["pii"], cats
        assert set(cats["missing"]) == {"geo", "comms", "classified", "controlled"}, cats
        # Order is preserved per CATEGORY_ORDER so the FE renders the
        # notes in a stable, doctrinal sequence.
        assert cats["missing"] == ["geo", "comms", "classified", "controlled"]
    finally:
        _BATCHES.pop(batch_id, None)


def test_sample_diffs_backfill_when_few_categories_fire(client):
    """When fewer than 3 categories fire we still want at least 3 sample
    rows so the panel doesn't shrink to a single line. The picker should
    backfill with additional flagged records (PII-heavy on the canonical
    dataset) rather than silently emit a one-row panel."""
    _login(client, "3456789012")
    body, _ = _export_and_download(client, "json")
    diffs = body.get("sample_diffs") or []
    # At minimum the SAMPLE_MIN floor (3) — never the pre-Task-109 single
    # row that a category-only picker would degrade to on a dataset with
    # only one firing category.
    assert len(diffs) >= 3, diffs


def test_sample_diff_sr_numbers_are_unique(client):
    """Belt-and-suspenders: the categorical pass and the backfill pass
    must not pick the same record twice. Duplicate sr_numbers would
    blow up the React `key` and confuse a reviewer comparing rows."""
    _login(client, "3456789012")
    body, _ = _export_and_download(client, "json")
    srs = [d["sr_number"] for d in (body.get("sample_diffs") or [])]
    assert len(srs) == len(set(srs)), srs
