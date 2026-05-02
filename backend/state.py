"""
Singleton dataset cache. Loaded once at FastAPI startup.

For a hackathon we run the dataset engine in-process at boot rather than
parsing the XLSX files — gives us live Python objects at zero I/O cost.
Regeneration under RANDOM_SEED = 42 produces the canonical dataset every
time.

Task #183 (stage live-ingest mode): when ``SPIRE_BOOT_EMPTY=1`` is set
the lifespan skips ``load_dataset()`` and the singleton starts as an
empty ``CanonicalDataset`` (zero units/assets/srs/snapshots/...). The
``swap_dataset()`` helper atomically replaces the singleton from inside
the stage-ingest route, and ``dataset_status()`` exposes the current
shape so the frontend can branch between hydrated dashboards and the
"awaiting GCSS-MC ingest" empty state.
"""
from __future__ import annotations

import sys
import threading
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
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
from lifecycle import run_simulation, generate_tmrs  # noqa: E402
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
    tmrs: list = field(default_factory=list)
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


# Module-level singleton + provenance metadata. The singleton is *never*
# None after import: ``init_empty_dataset()`` runs at module import so
# every caller of ``get_dataset()`` gets a valid, possibly-empty object.
# That removes a class of latent NoneType bugs across the routes.
_DATASET_LOCK = threading.Lock()
_DATASET: Optional[CanonicalDataset] = None
_DATASET_META: dict = {
    "source": "uninitialized",      # "seed-42" | "stage-ingest" | "empty"
    "ingested_at": None,             # ISO-8601 string or None
    "ingested_by": None,             # actor DODID or None
    "ingest_hash": None,             # sha256 trunc-16 of the source bytes
}


def _utc_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def init_empty_dataset() -> CanonicalDataset:
    """Initialize ``_DATASET`` to an explicit zero-state ``CanonicalDataset``.

    Used by:
      • module import (so the singleton is never None);
      • the lifespan when ``SPIRE_BOOT_EMPTY=1`` (stage live-ingest mode).
    """
    global _DATASET
    with _DATASET_LOCK:
        _DATASET = CanonicalDataset(
            units=[], assets=[], roster=[], srs=[], snapshots=[], reqs=[],
            cannib_events=[], incidents=[], tmrs=[], dq_defects={},
            violations=[],
            generated_at=_utc_iso(),
            seed=RANDOM_SEED,
        )
        _DATASET_META.update({
            "source": "empty",
            "ingested_at": None,
            "ingested_by": None,
            "ingest_hash": None,
        })
    return _DATASET


# Pickle cache for the deterministic seed=42 dataset. Generation chews
# 1-2s on shared CPU (most of it lifecycle.run_simulation across 128k
# snapshots); pickling lands at ~30 MB on disk and reloads in <100 ms.
# Cache is scoped per-seed and invalidates on any source-file mtime
# change so a dataset-engine edit always regenerates.
import hashlib  # noqa: E402
import os  # noqa: E402
import pickle  # noqa: E402
import time as _time  # noqa: E402

_DATASET_CACHE_DIR = ROOT / ".cache" / "dataset"


def _dataset_source_fingerprint() -> str:
    """SHA-1 over (sorted) mtimes of every dataset/*.py module so a
    code edit transparently invalidates the pickle. Cheap — stat'ing
    20-ish files takes microseconds vs the 1-2 s of full regeneration.
    """
    h = hashlib.sha1()
    dataset_dir = ROOT / "dataset"
    for p in sorted(dataset_dir.glob("**/*.py")):
        try:
            mt = int(p.stat().st_mtime)
        except OSError:
            continue
        h.update(p.relative_to(dataset_dir).as_posix().encode("utf-8"))
        h.update(b":")
        h.update(str(mt).encode("ascii"))
        h.update(b"\n")
    return h.hexdigest()[:16]


def _cache_path_for(seed: int) -> Path:
    return _DATASET_CACHE_DIR / f"seed-{seed}-{_dataset_source_fingerprint()}.pickle"


def _load_dataset_from_cache(seed: int) -> Optional[CanonicalDataset]:
    cache = _cache_path_for(seed)
    if not cache.exists():
        return None
    try:
        t0 = _time.perf_counter()
        with cache.open("rb") as f:
            ds = pickle.load(f)
        dt_ms = (_time.perf_counter() - t0) * 1000
        if not isinstance(ds, CanonicalDataset):
            return None
        # Stamp the load duration onto the dataset so /api/system/status
        # can report whether this boot hit the cache.
        print(f"[SPIRE]   pickle hit · {cache.name} loaded in {dt_ms:.0f} ms")
        return ds
    except Exception as e:  # noqa: BLE001
        # Pickle corruption or schema drift — silently regenerate.
        print(f"[SPIRE]   pickle miss · {cache.name}: {type(e).__name__}: {e}")
        return None


def _save_dataset_to_cache(seed: int, ds: CanonicalDataset) -> None:
    try:
        _DATASET_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache = _cache_path_for(seed)
        # Atomic write — pickle to a sibling temp file then rename, so a
        # killed process mid-write never leaves a partial cache.
        tmp = cache.with_suffix(cache.suffix + ".tmp")
        with tmp.open("wb") as f:
            pickle.dump(ds, f, protocol=pickle.HIGHEST_PROTOCOL)
        tmp.replace(cache)
        size_mb = cache.stat().st_size / (1024 * 1024)
        print(f"[SPIRE]   pickle saved · {cache.name} ({size_mb:.1f} MB)")
        # Garbage-collect older caches so we don't accumulate one per
        # source-file edit. Keep the 3 most recent for quick rollback.
        siblings = sorted(
            _DATASET_CACHE_DIR.glob(f"seed-{seed}-*.pickle"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for stale in siblings[3:]:
            try:
                stale.unlink()
            except OSError:
                pass
    except Exception as e:  # noqa: BLE001
        # Cache write failure is never fatal — we ran fresh, that's
        # the source of truth. Surface it once at boot.
        print(f"[SPIRE]   pickle save failed: {type(e).__name__}: {e}")


def load_dataset(*, seed: int = RANDOM_SEED) -> CanonicalDataset:
    """Generate (or regenerate) the canonical dataset under the given seed.

    Cold-start cache: if a pickle exists for this (seed, source-mtime)
    pair we load it (<100 ms). Otherwise we regenerate (~1-2 s) and
    write a fresh pickle for the next boot. ``SPIRE_DATASET_NO_CACHE=1``
    forces regeneration — useful when iterating on the dataset engine
    and the mtime fingerprint hasn't changed (e.g. a JSON-only data
    file edit that the fingerprint doesn't see).
    """
    global _DATASET

    no_cache = (os.environ.get("SPIRE_DATASET_NO_CACHE") or "").strip().lower() in ("1", "true", "yes")
    if not no_cache:
        cached = _load_dataset_from_cache(seed)
        if cached is not None:
            with _DATASET_LOCK:
                _DATASET = cached
                _DATASET_META.update({
                    "source": f"seed-{seed}-pickle",
                    "ingested_at": cached.generated_at,
                    "ingested_by": "lifespan-pickle",
                    "ingest_hash": None,
                })
            return _DATASET

    units, assets = generate_fleet(seed)
    roster = generate_personnel(units, OUTPUT_TARGETS["personnel_count"], seed)
    srs, snapshots, reqs = run_simulation(units, assets, roster, seed)
    dq = inject_data_quality_defects(srs, snapshots, seed)
    cannib = inject_cannibalizations(srs, assets, seed)
    incidents = generate_incidents(seed, roster=roster, units=units)
    tmrs = generate_tmrs(units, seed)
    violations = run_all_checks(srs, assets, snapshots, cannib)

    new_ds = CanonicalDataset(
        units=units,
        assets=assets,
        roster=roster,
        srs=srs,
        snapshots=snapshots,
        reqs=reqs,
        cannib_events=cannib,
        incidents=incidents,
        tmrs=tmrs,
        dq_defects=dq,
        violations=violations,
        generated_at=_utc_iso(),
        seed=seed,
    )
    with _DATASET_LOCK:
        _DATASET = new_ds
        _DATASET_META.update({
            "source": f"seed-{seed}",
            "ingested_at": new_ds.generated_at,
            "ingested_by": "lifespan",
            "ingest_hash": None,
        })
    if not no_cache:
        _save_dataset_to_cache(seed, new_ds)
    return _DATASET


def swap_dataset(
    new: CanonicalDataset,
    *,
    source: str,
    ingested_by: Optional[str] = None,
    ingest_hash: Optional[str] = None,
) -> CanonicalDataset:
    """Atomically replace the singleton dataset under the module lock.

    Used by the stage-ingest route after parsing the GCSS-MC export so
    every downstream reader of ``get_dataset()`` flips to the real data
    on the next call without a race window.
    """
    global _DATASET
    with _DATASET_LOCK:
        _DATASET = new
        _DATASET_META.update({
            "source": source,
            "ingested_at": _utc_iso(),
            "ingested_by": ingested_by,
            "ingest_hash": ingest_hash,
        })
    return _DATASET


def get_dataset() -> CanonicalDataset:
    """Return the loaded dataset. Always returns a valid object (possibly
    empty) after module import — never raises NoneType errors."""
    if _DATASET is None:
        # Defensive: should never happen because ``init_empty_dataset``
        # runs at module import. Fall back rather than 500 the request.
        return init_empty_dataset()
    return _DATASET


def is_dataset_empty(ds: Optional[CanonicalDataset] = None) -> bool:
    """True iff the dataset carries no SRs and no snapshots — the signal
    SPIRE uses to decide between "render dashboards" and "render the
    awaiting-GCSS-MC-ingest empty state"."""
    target = ds if ds is not None else _DATASET
    if target is None:
        return True
    return not target.srs and not target.snapshots


def dataset_status() -> dict:
    """Public, JSON-shaped descriptor of the current dataset. Returned by
    ``GET /api/system/dataset-status`` and used by the frontend to gate
    between the hydrated dashboards and the stage-ingest hero."""
    ds = get_dataset()
    return {
        "empty": is_dataset_empty(ds),
        "source": _DATASET_META.get("source"),
        "ingested_at": _DATASET_META.get("ingested_at"),
        "ingested_by": _DATASET_META.get("ingested_by"),
        "ingest_hash": _DATASET_META.get("ingest_hash"),
        "counts": {
            "units": len(ds.units),
            "assets": len(ds.assets),
            "srs": len(ds.srs),
            "snapshots": len(ds.snapshots),
            "incidents": len(ds.incidents),
            "requisitions": len(ds.reqs),
        },
        "generated_at": ds.generated_at,
        "seed": ds.seed,
    }


# Initialize the singleton at module import so callers of ``get_dataset()``
# never see ``None``. The lifespan in ``backend/main.py`` decides whether
# to overlay seed-42 data (default) or leave this empty (SPIRE_BOOT_EMPTY).
init_empty_dataset()


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
