"""
Coalition release profile loader + scoping helpers.

Backs GC-5: the SENTRY coalition tab renders a live-data view scoped to a
selected partner profile (FVEY_BASE, FVEY_LOG, JPN_COALITION, AUS_COALITION,
PHL_COALITION). The backend /sentry/coalition/{profile} endpoint uses
`scope_record_for_profile` + `apply_redactions` to transform the canonical
dataset per the partner's authorization matrix.

Profiles are authored in data/coalition_profiles.json so the release posture
is inspectable. Production would load these from a signed policy store.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

DATA_PATH = Path(__file__).parent / "data" / "coalition_profiles.json"
_CACHE: Optional[dict] = None


def profiles() -> dict:
    global _CACHE
    if _CACHE is None:
        with open(DATA_PATH, encoding="utf-8") as f:
            _CACHE = json.load(f)
    return _CACHE


def list_profiles() -> list[dict]:
    """Return a summary of every profile for the partner picker."""
    out = []
    for key, p in profiles()["profiles"].items():
        out.append({
            "key": key,
            "display_name": p["display_name"],
            "partners": p["partners"],
            "distribution": p["distribution_statement"],
            "embargo_days": p.get("embargo_days_after_event", 0),
        })
    return out


@dataclass(frozen=True)
class ReleaseDecision:
    allowed: bool
    reason: str
    redactions_applied: list[str]


def classify_record(profile_key: str, record: dict) -> ReleaseDecision:
    """Decide whether `record` can be released under `profile_key`. If yes,
    return the list of redactions the caller should apply."""
    all_profiles = profiles()["profiles"]
    if profile_key not in all_profiles:
        return ReleaseDecision(False, f"unknown profile {profile_key}", [])
    p = all_profiles[profile_key]

    classification = record.get("detected_classification") or record.get("source_classification") or "UNCLASSIFIED"
    if classification not in p["authorized_classifications"]:
        return ReleaseDecision(False, f"classification {classification} exceeds profile ceiling", [])

    unit = record.get("unit_name") or record.get("unit")
    unit_parent = record.get("unit_parent")
    if "authorized_unit_parents" in p and unit_parent and unit_parent not in p["authorized_unit_parents"]:
        return ReleaseDecision(False, f"unit_parent {unit_parent} not in release scope", [])

    category = record.get("category")
    if "authorized_categories" in p and category and category not in p["authorized_categories"]:
        return ReleaseDecision(False, f"category {category} not in release scope", [])

    return ReleaseDecision(True, "allowed", list(p.get("field_redactions", [])))


def apply_redactions(record: dict, redactions: list[str]) -> dict:
    """Return a new record dict with the requested fields redacted/generalized."""
    out = dict(record)
    for field in redactions:
        rule = profiles()["redaction_rules"].get(field)
        if rule is None:
            continue
        if field == "EDIPI" and "edipi" in out:
            out["edipi"] = "[REDACTED]"
        elif field == "POC_PHONE":
            for key in ("poc", "poc_phone", "remark"):
                if key in out and isinstance(out[key], str):
                    out[key] = re.sub(r"\d{3}[-.]?\d{3}[-.]?\d{4}", "[PHONE REDACTED]", out[key])
        elif field == "billet_nickname":
            for key in ("poc", "remark"):
                if key in out and isinstance(out[key], str):
                    out[key] = re.sub(r"\s*\([^)]*\)", "", out[key])
        elif field == "serial_number" and "serial_number" in out:
            out["serial_number"] = "[SERIAL REDACTED]"
        elif field == "tm_reference" and "tm_reference" in out:
            out["tm_reference"] = "[TM REFERENCE REDACTED]"
        elif field == "fault_component" and "fault_component" in out:
            out["fault_component"] = _generalize_component(out["fault_component"])
        elif field == "supply_path" and "supply_path" in out:
            out["supply_path"] = "MILSTRIP"
    return out


_COMPONENT_FAMILIES = {
    "drivetrain": ["output shaft", "input shaft", "differential", "driveshaft", "transmission"],
    "engine":     ["starter", "alternator", "injector", "turbo", "cylinder head", "piston", "valve"],
    "brake":      ["caliper", "rotor", "pad set", "master cylinder", "abs module"],
    "electrical": ["battery", "harness", "ecm", "relay", "solenoid"],
    "hydraulic":  ["pump", "reservoir", "hose", "cylinder"],
    "armament":   ["sight", "barrel", "bolt", "feed tray"],
}


def _generalize_component(c: str) -> str:
    lc = c.lower()
    for family, parts in _COMPONENT_FAMILIES.items():
        if any(p in lc for p in parts):
            return family
    return "subsystem"


def partner_units_for(profile_key: str) -> list[dict]:
    """Return coalition partner units surfaced on the coalition tab for a profile."""
    p = profiles()["profiles"].get(profile_key, {})
    return p.get("partner_units", [])
