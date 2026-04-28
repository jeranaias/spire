"""
Per-asset Bill of Materials (BOM) augmentation.

The cannibalization donor pool needs to know whether a candidate hull
*physically carries* the recipient's needed NSN as an installed,
serviceable component — not just whether it shares an equipment_type.
The prior proxy (same equipment_type → assumed compatible) is wrong for
real fleets where two JLTVs of different sub-variants may not share the
same parts.

This module is the runtime augmentation layer. It is intentionally NOT
inside `dataset/` (project rule: do not modify the canonical dataset
package); instead, it is built at import time from
`dataset/data/equipment_profiles.json` so it stays in lock-step with the
canonical parts catalog without mutating it.

Per-asset variation
-------------------
For each equipment_type we derive a master parts catalog from the
`parts_needed` lists of every fault profile. Parts are split into two
classes:

  * **Core** parts: the first NSN in each fault's `parts_needed` block.
    These are always installed on every hull of the equipment_type
    (they are the part the failure mode is *named after*).
  * **Sub-variant optional** parts: every other NSN. These are present
    on ~80% of hulls, deterministically gated on
    `sha256(asset_id|nsn)` so the same asset always reports the same
    BOM across boots.

This gives the donor matcher a real "this hull has the part installed"
predicate that varies between hulls of the same equipment_type, which
is the realism the equipment_type proxy was missing.

Serviceability
--------------
A part is unserviceable on a given hull if the fault class associated
with the part is currently failing on that hull (i.e. the hull has an
open SR whose normalized fault component matches). The recipient's
needed-part fault class never makes its own donor copy
"strippable" — that asset's copy of the part is the failing one.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterable, Optional

_DATASET_DATA = Path(__file__).resolve().parent.parent / "dataset" / "data"


# ---------------------------------------------------------------------------
# Internal: load equipment profiles once, derive a master parts catalog per
# equipment_type. Both helpers are lru_cached so the work is paid for on
# first request and re-used for every donor-pool build after that.
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _equipment_profiles() -> dict:
    path = _DATASET_DATA / "equipment_profiles.json"
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _normalize_component(c: str) -> str:
    """Mirror of pulse._normalize_component — kept local so importing
    `bom` does not pull the route module's heavy dependency tree."""
    lc = (c or "").lower()
    if any(k in lc for k in ("starter", "alternator", "injector", "fuel", "turbo", "head", "valve")):
        return "engine"
    if any(k in lc for k in ("transmission", "transfer", "diff", "drive", "shaft")):
        return "drivetrain"
    if any(k in lc for k in ("brake", "rotor", "caliper", "pad")):
        return "brake"
    if any(k in lc for k in ("battery", "harness", "ecm", "relay", "wiring")):
        return "electrical"
    if any(k in lc for k in ("hydraul", "pump", "cylinder", "hose")):
        return "hydraulic"
    if any(k in lc for k in ("track", "road wheel", "torsion")):
        return "track"
    if any(k in lc for k in ("antenna", "aesa", "transmit")):
        return "antenna"
    if any(k in lc for k in ("tire", "ctis", "wheel")):
        return "tire"
    return c or "subsystem"


def _slot_label(fault: dict, part: dict) -> str:
    """Human-readable sub-component slot label for the donor card.

    e.g. "Right rear hub assembly" — derived from the fault description
    where available, or `<Component> — <Part>` as a fallback.
    """
    desc = (fault.get("description") or "").strip()
    if desc:
        return desc
    component = (fault.get("component") or "subsystem").strip()
    part_name = (part.get("nomenclature") or "component").strip()
    return f"{component.title()} — {part_name}"


@dataclass(frozen=True)
class CatalogEntry:
    nsn: str
    nomenclature: str
    slot: str
    fault_component: str
    fault_class: str
    is_core: bool


@lru_cache(maxsize=None)
def _catalog_for(equipment_type: str) -> tuple[CatalogEntry, ...]:
    """Master BOM catalog for an equipment_type.

    Deduplicated by NSN: the *first* fault that lists a given NSN owns
    the slot label and the is_core flag (where the NSN is the lead part
    of *that* fault).
    """
    profiles = _equipment_profiles()
    profile = profiles.get(equipment_type)
    if not profile:
        return ()
    seen: set[str] = set()
    catalog: list[CatalogEntry] = []
    for fault in profile.get("faults", []):
        parts = fault.get("parts_needed") or []
        for idx, part in enumerate(parts):
            nsn = part.get("nsn")
            if not nsn or nsn in seen:
                continue
            seen.add(nsn)
            catalog.append(CatalogEntry(
                nsn=nsn,
                nomenclature=part.get("nomenclature", ""),
                slot=_slot_label(fault, part),
                fault_component=fault.get("component") or "",
                fault_class=_normalize_component(fault.get("component") or ""),
                is_core=(idx == 0),
            ))
    return tuple(catalog)


# ---------------------------------------------------------------------------
# Per-asset install gate (sub-variant variation)
# ---------------------------------------------------------------------------

# Optional (non-core) parts are present on this fraction of hulls. Tuned so
# that the donor pool stays meaningful (most hulls still carry the part)
# while leaving a visible slice of donors filtered out by sub-variant.
_OPTIONAL_INSTALL_RATE = 0.80


def _hash_unit(asset_id: str, nsn: str) -> float:
    h = hashlib.sha256(f"{asset_id}|{nsn}".encode()).digest()
    return ((h[0] << 8) | h[1]) / 65535.0


def _is_installed(asset_id: str, nsn: str, is_core: bool) -> bool:
    if is_core:
        return True
    return _hash_unit(asset_id, nsn) < _OPTIONAL_INSTALL_RATE


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class InstalledComponent:
    """One NSN that physically lives on this hull."""
    nsn: str
    nomenclature: str
    slot: str
    fault_component: str
    fault_class: str
    serviceable: bool
    is_core: bool


def asset_bom(
    asset,
    open_fault_classes: Optional[Iterable[str]] = None,
) -> list[InstalledComponent]:
    """Return the asset's installed component list.

    `open_fault_classes` is the set of normalized fault classes currently
    open on this hull (typically derived once from `ds.srs` by the
    caller). Components whose fault_class is in that set are flagged
    unserviceable.
    """
    open_set = set(open_fault_classes or ())
    out: list[InstalledComponent] = []
    for entry in _catalog_for(asset.equipment_type):
        if not _is_installed(asset.asset_id, entry.nsn, entry.is_core):
            continue
        out.append(InstalledComponent(
            nsn=entry.nsn,
            nomenclature=entry.nomenclature,
            slot=entry.slot,
            fault_component=entry.fault_component,
            fault_class=entry.fault_class,
            serviceable=entry.fault_class not in open_set,
            is_core=entry.is_core,
        ))
    return out


def asset_carries_nsn_serviceable(
    asset,
    nsn: str,
    open_fault_classes: Optional[Iterable[str]] = None,
) -> tuple[bool, Optional[str]]:
    """Fast lookup used by the cannibalization donor matcher.

    Returns ``(True, slot_label)`` if the asset has the NSN installed
    AND the matching fault class is not currently failing on this hull.
    Returns ``(False, None)`` otherwise — caller should reject the
    donor.
    """
    open_set = set(open_fault_classes or ())
    for entry in _catalog_for(asset.equipment_type):
        if entry.nsn != nsn:
            continue
        if not _is_installed(asset.asset_id, nsn, entry.is_core):
            return False, None
        if entry.fault_class in open_set:
            return False, None
        return True, entry.slot
    return False, None


def equipment_type_carries_nsn(equipment_type: str, nsn: str) -> bool:
    """True if an equipment_type's parts catalog lists the NSN at all.

    Used by the propose endpoint to short-circuit before checking the
    per-asset install gate (saves the hash for the common-case reject).
    """
    return any(e.nsn == nsn for e in _catalog_for(equipment_type))
