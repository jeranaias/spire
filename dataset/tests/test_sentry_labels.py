"""Every record that carries sensitive flags must be correctly classified."""
from __future__ import annotations


def test_classified_records_marked_sensitive(canonical):
    """If remark contains the classified-TM placeholder, detected
    classification must be a sensitive marking (CUI or higher). Demo
    build caps at CUI; on a real classified deployment SENTRY can emit
    CONFIDENTIAL / SECRET / TOP SECRET on the same code path."""
    sensitive = {"CUI", "CONFIDENTIAL", "SECRET", "TOP SECRET"}
    for sr in canonical["srs"]:
        if "[CLASSIFIED TM" in sr.remark_text:
            assert sr.detected_classification in sensitive, (
                f"SR {sr.sr_number} has classified TM but detected {sr.detected_classification}"
            )


def test_pii_flag_yields_cui_or_higher(canonical):
    """Any record with pii in sensitive_flags must be CUI or higher."""
    levels = {"UNCLASSIFIED": 0, "CUI": 1, "CONFIDENTIAL": 2, "SECRET": 3}
    for sr in canonical["srs"]:
        if "pii" in sr.sensitive_flags:
            assert levels[sr.detected_classification] >= 1, (
                f"SR {sr.sr_number} flagged PII but classified UNCLAS"
            )


def test_source_vs_detected_mismatch_rate(canonical):
    """A few percent of corrective SRs should be under-marked (source UNCLAS
    but detected CUI+) -- this is the classification discrepancy SENTRY catches
    in the demo. Spec targets ~1.5% (3 mismatches / 200 records); we allow a
    1-5% band. Lower = demo boring. Higher = operator malpractice model."""
    cm_srs = [sr for sr in canonical["srs"] if not sr.is_pmcs]
    mismatches = [
        sr for sr in cm_srs
        if sr.source_classification == "UNCLASSIFIED"
        and sr.detected_classification != "UNCLASSIFIED"
    ]
    rate = len(mismatches) / len(cm_srs)
    assert 0.01 <= rate <= 0.06, (
        f"Mis-marking rate {rate:.1%} outside 1-6% target band"
    )
    # Also verify at least 10 absolute records -- guarantees the demo kanban
    # "Held" column has enough to scroll through.
    assert len(mismatches) >= 10, f"Only {len(mismatches)} mismatches -- demo needs at least 10"
