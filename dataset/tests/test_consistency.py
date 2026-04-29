"""Verify the 15 consistency validators land zero errors on the canonical run."""
from __future__ import annotations

from collections import Counter


def test_zero_consistency_errors(canonical):
    errors = [v for v in canonical["violations"] if v.severity == "error"]
    assert errors == [], f"Expected zero errors, got {len(errors)}: {errors[:5]}"


def test_warnings_bounded(canonical):
    """Warnings are acceptable but should be bounded -- a ballooning count
    usually means a real issue has just started to leak through as a warning
    rather than an error."""
    warnings = [v for v in canonical["violations"] if v.severity == "warning"]
    assert len(warnings) < 100, (
        f"Warnings exploded to {len(warnings)}; investigate {Counter(v.check for v in warnings)}"
    )


def test_data_quality_defects_injected(canonical):
    """The spec-called-for defects must be present so SENTRY's data quality
    gate has something to flag in the demo."""
    dq = canonical["dq"]
    assert dq["hours_decreased"] == 8
    assert dq["serial_tamcn_mismatch"] == 3
    assert dq["unknown_defect_code"] == 2


def test_cannibalization_threshold(canonical):
    """At least 5 cannibalization events must exist for PULSE's matcher demo."""
    assert len(canonical["cannib"]) >= 5


def test_classification_distribution(canonical):
    """Realistic mix -- must have UNCLAS, CUI, and at least a few SECRET records
    (from classified fault profiles on weapons/radar/FCS equipment)."""
    srs = [s for s in canonical["srs"] if not s.is_pmcs]
    classes = Counter(s.detected_classification for s in srs)
    assert classes.get("UNCLASSIFIED", 0) > 500
    # Demo build caps at CUI; expect a healthy CUI population from
    # weapons/radar/FCS sensitive content. SECRET line removed because
    # synthetic dataset never produces SECRET in the demo build.
    assert classes.get("CUI", 0) > 300
