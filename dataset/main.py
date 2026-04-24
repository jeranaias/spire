"""
Canonical dataset generator entry point.

Usage:
    python main.py            # run the full pipeline, write all 6 XLSX files
    python main.py --quick    # same but skips XLSX export (returns in-memory dataset for testing)
    python main.py --seed 99  # override the default seed

Reproducibility: with the default seed 42, every run produces byte-identical
records (aside from the generated_at timestamp in metadata).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

from config import OUTPUT_TARGETS, RANDOM_SEED
from consistency import (
    inject_cannibalizations,
    inject_data_quality_defects,
    report_violations,
    run_all_checks,
)
from export import export_all, OUT_DIR
from fleet import generate_fleet
from incidents import generate_incidents
from lifecycle import run_simulation
from personnel import generate_personnel


BANNER = """
================================================================================
  SPIRE synthetic dataset generator
  Contested Logistics. Local Intelligence.
================================================================================
"""


def _stopwatch(label: str):
    start = time.perf_counter()
    print(f"  {label} ", end="", flush=True)
    def stop():
        elapsed = time.perf_counter() - start
        print(f"-- {elapsed:>6.2f}s")
    return stop


def main(seed: int = RANDOM_SEED, quick: bool = False) -> dict:
    print(BANNER)
    print(f"Seed: {seed}    Quick mode: {quick}")

    stop = _stopwatch("Generating fleet")
    units, assets = generate_fleet(seed)
    stop()
    print(f"    {len(units)} units, {len(assets)} assets")

    stop = _stopwatch("Generating personnel")
    roster = generate_personnel(units, OUTPUT_TARGETS["personnel_count"], seed)
    stop()
    print(f"    {len(roster)} Marines across unit rosters")

    stop = _stopwatch("Simulating 365 days")
    srs, snaps, reqs = run_simulation(units, assets, roster, seed)
    stop()
    print(f"    {len(srs):,} SRs / {len(snaps):,} daily snapshots / {len(reqs):,} requisitions")

    stop = _stopwatch("Injecting data-quality defects")
    dq = inject_data_quality_defects(srs, snaps, seed)
    stop()
    print(f"    {dq}")

    stop = _stopwatch("Injecting cannibalization events")
    cans = inject_cannibalizations(srs, assets, seed)
    stop()
    print(f"    {len(cans)} cannibalization events (min target {5})")

    stop = _stopwatch("Generating incidents")
    incidents = generate_incidents(seed, OUTPUT_TARGETS["incident_count"])
    stop()
    print(f"    {len(incidents)} installation incidents")

    stop = _stopwatch("Running consistency checks")
    violations = run_all_checks(srs, assets, snaps, cans)
    stop()
    errs = sum(1 for v in violations if v.severity == "error")
    warns = len(violations) - errs
    print(f"    {errs} errors, {warns} warnings")
    if errs > 0 or warns > 0:
        report_violations(violations)

    run_stats = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "random_seed": seed,
        "simulation_days": 365,
        "units": len(units),
        "assets": len(assets),
        "personnel": len(roster),
        "service_requests": len(srs),
        "cm_service_requests": sum(1 for s in srs if not s.is_pmcs),
        "pmcs_service_requests": sum(1 for s in srs if s.is_pmcs),
        "daily_snapshots": len(snaps),
        "part_requisitions": len(reqs),
        "cannibalization_events": len(cans),
        "incidents": len(incidents),
        "consistency_errors": errs,
        "consistency_warnings": warns,
        "data_quality_defects_injected": dq,
    }

    if quick:
        print("\nQuick mode -- skipping XLSX export.")
        return run_stats

    stop = _stopwatch("Exporting XLSX files")
    paths = export_all(
        units=units, assets=assets, roster=roster,
        srs=srs, snapshots=snaps, reqs=reqs,
        incidents=incidents, cannib_events=cans,
        violations=violations, run_stats=run_stats,
    )
    stop()
    for name, p in paths.items():
        size = p.stat().st_size / 1024
        print(f"    {name:<10} -> {p.relative_to(OUT_DIR.parent)}  ({size:,.1f} KB)")

    # Also dump a JSON manifest for downstream tooling
    manifest_path = OUT_DIR / "manifest.json"
    manifest = {
        "run_stats": run_stats,
        "files": {name: str(p.relative_to(OUT_DIR.parent)) for name, p in paths.items()},
    }
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"    manifest  -> data/out/manifest.json")

    print(f"\n  Output directory: {OUT_DIR.resolve()}")
    print("\nDone.")
    return run_stats


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SPIRE canonical dataset generator")
    parser.add_argument("--seed", type=int, default=RANDOM_SEED, help="Random seed")
    parser.add_argument("--quick", action="store_true", help="Skip XLSX export")
    args = parser.parse_args()
    stats = main(seed=args.seed, quick=args.quick)
    sys.exit(0 if stats.get("consistency_errors", 0) == 0 else 1)
