"""
Singleton dataset cache. Loaded once at FastAPI startup.

For a hackathon we run the dataset engine in-process at boot rather than
parsing the XLSX files — gives us live Python objects at zero I/O cost.
Regeneration under RANDOM_SEED = 42 produces the canonical dataset every
time.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "dataset"))

from config import (  # noqa: E402
    OUTPUT_TARGETS,
    RANDOM_SEED,
    SIMULATION_DAYS,
    SIMULATION_START_DATE,
)
from fleet import generate_fleet  # noqa: E402
from personnel import generate_personnel  # noqa: E402
from lifecycle import run_simulation  # noqa: E402
from consistency import (  # noqa: E402
    inject_cannibalizations,
    inject_data_quality_defects,
    run_all_checks,
)
from incidents import generate_incidents  # noqa: E402


@dataclass
class CanonicalDataset:
    """The canonical SPIRE dataset, held in memory for the lifetime of the
    FastAPI process. Every endpoint reads from here."""

    units: list = field(default_factory=list)
    assets: list = field(default_factory=list)
    roster: list = field(default_factory=list)
    srs: list = field(default_factory=list)
    snapshots: list = field(default_factory=list)
    reqs: list = field(default_factory=list)
    cannib_events: list = field(default_factory=list)
    incidents: list = field(default_factory=list)
    dq_defects: dict = field(default_factory=dict)
    violations: list = field(default_factory=list)
    generated_at: str = ""
    seed: int = RANDOM_SEED

    # Derived indexes, built lazily
    _by_asset_id: Optional[dict] = None
    _by_unit_name: Optional[dict] = None
    _snapshots_by_asset_date: Optional[dict] = None
    _incidents_by_id: Optional[dict] = None

    def asset(self, asset_id: str):
        if self._by_asset_id is None:
            self._by_asset_id = {a.asset_id: a for a in self.assets}
        return self._by_asset_id.get(asset_id)

    def unit(self, unit_name: str):
        if self._by_unit_name is None:
            self._by_unit_name = {u.name: u for u in self.units}
        return self._by_unit_name.get(unit_name)

    def incident(self, incident_id: str):
        if self._incidents_by_id is None:
            self._incidents_by_id = {i.incident_number: i for i in self.incidents}
        return self._incidents_by_id.get(incident_id)


_DATASET: Optional[CanonicalDataset] = None


def load_dataset(*, seed: int = RANDOM_SEED) -> CanonicalDataset:
    """Generate (or regenerate) the canonical dataset under the given seed."""
    global _DATASET
    from datetime import datetime

    units, assets = generate_fleet(seed)
    roster = generate_personnel(units, OUTPUT_TARGETS["personnel_count"], seed)
    srs, snapshots, reqs = run_simulation(units, assets, roster, seed)
    dq = inject_data_quality_defects(srs, snapshots, seed)
    cannib = inject_cannibalizations(srs, assets, seed)
    incidents = generate_incidents(seed)
    violations = run_all_checks(srs, assets, snapshots, cannib)

    _DATASET = CanonicalDataset(
        units=units,
        assets=assets,
        roster=roster,
        srs=srs,
        snapshots=snapshots,
        reqs=reqs,
        cannib_events=cannib,
        incidents=incidents,
        dq_defects=dq,
        violations=violations,
        generated_at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
        seed=seed,
    )
    return _DATASET


def get_dataset() -> CanonicalDataset:
    """Return the loaded dataset. Raises if not loaded."""
    if _DATASET is None:
        raise RuntimeError("Dataset not loaded — call load_dataset() first")
    return _DATASET


# Last-day snapshot helpers -----------------------------------------------

def last_day_snapshots(ds: CanonicalDataset) -> list:
    """Return the set of snapshots on the final simulation day — the state
    an operator logging in would see as 'current'."""
    if not ds.snapshots:
        return []
    last_day = ds.snapshots[-1].snapshot_date
    return [s for s in ds.snapshots if s.snapshot_date == last_day]


def snapshots_for_asset(ds: CanonicalDataset, asset_id: str) -> list:
    return [s for s in ds.snapshots if s.asset_id == asset_id]


def snapshots_for_unit(ds: CanonicalDataset, unit_name: str) -> list:
    return [s for s in ds.snapshots if s.unit_name == unit_name]


def srs_for_asset(ds: CanonicalDataset, asset_id: str) -> list:
    return [s for s in ds.srs if s.asset_id == asset_id]


def open_srs_for_asset(ds: CanonicalDataset, asset_id: str) -> list:
    return [s for s in ds.srs if s.asset_id == asset_id and s.close_date is None]
