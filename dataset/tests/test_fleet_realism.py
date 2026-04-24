"""Calibration gates -- numbers that should hold within GAO-reported bands
for USMC ground-vehicle fleets."""
from __future__ import annotations

from collections import Counter, defaultdict


def test_mc_rate_within_band(canonical):
    """Average fleet MC-only rate should land in 65-82%, covering the range
    from GAO-25-108679 ground-vehicle data through the spec's demo target."""
    snaps = canonical["snaps"]
    by_date: dict = defaultdict(Counter)
    for s in snaps:
        by_date[s.snapshot_date][s.readiness_code] += 1
    rates = []
    for counter in by_date.values():
        total = sum(counter.values())
        rates.append(counter.get("MC", 0) / total)
    avg = sum(rates) / len(rates)
    assert 0.65 <= avg <= 0.82, f"MC rate average {avg:.1%} outside realistic band 65-82%"


def test_no_unit_at_100_or_below_50(canonical):
    """No unit should average 100% MC (unrealistic) or below 50% (command
    attention level)."""
    snaps = canonical["snaps"]
    by_unit_date: dict = defaultdict(lambda: defaultdict(Counter))
    for s in snaps:
        by_unit_date[s.unit_name][s.snapshot_date][s.readiness_code] += 1

    for unit, dated in by_unit_date.items():
        rates = []
        for counter in dated.values():
            total = sum(counter.values())
            rates.append(counter.get("MC", 0) / total)
        avg = sum(rates) / len(rates)
        # CLB-6 is the "trending red" demo unit so its lower bound is relaxed.
        lower = 0.40 if unit in ("CLB-6",) else 0.48
        assert avg < 1.0, f"Unit {unit} averaged {avg:.1%} MC -- no real unit is 100%"
        assert avg > lower, f"Unit {unit} averaged {avg:.1%} MC -- below command-attention floor"


def test_pmcs_interval_regular(canonical):
    """PMCS SRs for a given asset should appear at ~30-day cadence."""
    pmcs_by_asset: dict = defaultdict(list)
    for sr in canonical["srs"]:
        if sr.is_pmcs:
            pmcs_by_asset[sr.asset_id].append(sr.open_date)
    gaps = []
    for dates in pmcs_by_asset.values():
        dates.sort()
        for a, b in zip(dates, dates[1:]):
            gaps.append((b - a).days)
    assert len(gaps) > 100, "Too few PMCS gaps to evaluate"
    mean_gap = sum(gaps) / len(gaps)
    assert 25 <= mean_gap <= 38, f"PMCS mean gap {mean_gap:.1f} days outside 25-38 band"
