"""
Shared pytest fixtures. A canonical dataset is generated once per test session
(expensive -- 365 days of simulation) and reused by every assertion.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from config import RANDOM_SEED, OUTPUT_TARGETS  # noqa: E402
from fleet import generate_fleet  # noqa: E402
from personnel import generate_personnel  # noqa: E402
from lifecycle import run_simulation  # noqa: E402
from consistency import (  # noqa: E402
    inject_cannibalizations,
    inject_data_quality_defects,
    run_all_checks,
)
from incidents import generate_incidents  # noqa: E402


@pytest.fixture(scope="session")
def canonical():
    """One generation of the full pipeline under RANDOM_SEED."""
    units, assets = generate_fleet(RANDOM_SEED)
    roster = generate_personnel(units, OUTPUT_TARGETS["personnel_count"], RANDOM_SEED)
    srs, snaps, reqs = run_simulation(units, assets, roster, RANDOM_SEED)
    dq = inject_data_quality_defects(srs, snaps, RANDOM_SEED)
    cannib = inject_cannibalizations(srs, assets, RANDOM_SEED)
    incidents = generate_incidents(RANDOM_SEED)
    violations = run_all_checks(srs, assets, snaps, cannib)
    return dict(
        units=units, assets=assets, roster=roster,
        srs=srs, snaps=snaps, reqs=reqs,
        dq=dq, cannib=cannib, incidents=incidents,
        violations=violations,
    )
