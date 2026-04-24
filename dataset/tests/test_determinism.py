"""Re-running the pipeline with the same seed must produce identical outputs.
If this test fails, something is using a non-seeded RNG or a stateful global
that isn't being reset."""
from __future__ import annotations

import hashlib
import json

from config import RANDOM_SEED, OUTPUT_TARGETS
from fleet import generate_fleet
from personnel import generate_personnel
from lifecycle import run_simulation
from consistency import inject_cannibalizations, inject_data_quality_defects


def _fingerprint(srs, snaps, reqs) -> str:
    """Deterministic digest of the canonical records."""
    parts = []
    for sr in srs[:200]:  # sample -- full file would be huge
        parts.append(f"{sr.sr_number}|{sr.open_date}|{sr.job_status}|{sr.labor_hours_actual}|{sr.parts_cost_actual}|{sr.remark_text[:80]}")
    for s in snaps[::500]:  # every 500th snapshot
        parts.append(f"{s.snapshot_date}|{s.asset_id}|{s.readiness_code}|{s.current_hours}|{s.current_miles}")
    for r in reqs[:100]:
        parts.append(f"{r.document_number}|{r.nsn}|{r.supply_path}|{r.received_date}")
    digest = hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()
    return digest


def _generate():
    units, assets = generate_fleet(RANDOM_SEED)
    roster = generate_personnel(units, OUTPUT_TARGETS["personnel_count"], RANDOM_SEED)
    srs, snaps, reqs = run_simulation(units, assets, roster, RANDOM_SEED)
    inject_data_quality_defects(srs, snaps, RANDOM_SEED)
    inject_cannibalizations(srs, assets, RANDOM_SEED)
    return _fingerprint(srs, snaps, reqs)


def test_seed_produces_identical_output():
    first = _generate()
    second = _generate()
    assert first == second, (
        f"Seed {RANDOM_SEED} produced different outputs across runs:\n"
        f"  run 1: {first}\n  run 2: {second}\n"
        "Something is using an unseeded RNG or a non-reset global."
    )
