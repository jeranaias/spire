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

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

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


def release_manifest(profile_key: str, records: Iterable[dict]) -> dict:
    """Walk ``records`` through ``classify_record`` for ``profile_key`` and
    compute a stable SHA-256 over the sorted in-scope SR ID set + the
    profile's redaction policy + the profile key itself.

    Returns a dict shaped::

        {"manifest_sha256": str, "record_count": int, "sr_ids": [str, ...]}

    The hash is the proof artefact that gets stored in the audit row so an
    investigator can later prove *what* shipped, not just *that* something
    did. Two releases for the same profile against an unchanged dataset
    must produce the same hash; mutating the dataset, the profile's
    redactions, or the profile key all change the hash. Records without
    an ``sr_number`` are ignored — they're outside the SR-shaped manifest.
    """
    all_profiles = profiles()["profiles"]
    p = all_profiles.get(profile_key, {}) or {}
    redactions = sorted(p.get("field_redactions", []))
    sr_ids: list[str] = []
    for rec in records:
        decision = classify_record(profile_key, rec)
        if not decision.allowed:
            continue
        sr_id = rec.get("sr_number") or rec.get("sr_id")
        if sr_id:
            sr_ids.append(str(sr_id))
    sr_ids.sort()
    canonical = json.dumps(
        {"profile": profile_key, "redactions": redactions, "sr_ids": sr_ids},
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return {
        "manifest_sha256": digest,
        "record_count": len(sr_ids),
        "sr_ids": sr_ids,
    }


def apply_redactions(record: dict, redactions: list[str]) -> dict:
    """Return a new record dict with the requested fields redacted/generalized."""
    out, _spans = apply_redactions_with_spans(record, redactions)
    return out


def apply_redactions_with_spans(
    record: dict, redactions: list[str]
) -> tuple[dict, list[dict]]:
    """Like apply_redactions, but also returns a per-field diff list so the
    Coalition preview can render inline `<mark>` highlights showing the
    operator exactly what was generalised or stripped from the partner-visible
    record. Spans format: ``[{field, before, after, kind}]``.

    Note: ``before`` strings here are surfaced ONLY in the live-preview path;
    the audited release manifest never carries them across the wire.
    """
    out = dict(record)
    spans: list[dict] = []

    def _add(field_name: str, before, after, kind: str):
        # Skip no-op spans (e.g. POC_PHONE on a remark with no phone digits).
        if before == after:
            return
        spans.append({
            "field": field_name,
            "before": before,
            "after": after,
            "kind": kind,
        })

    # Pass 1: EDIPI replacement (must run before POC_PHONE so the phone regex
    # doesn't sweep up 10-digit EDIPI strings inside remark text).
    if "EDIPI" in redactions:
        if "edipi" in out:
            before = out["edipi"]
            out["edipi"] = "[REDACTED]"
            _add("edipi", before, out["edipi"], "EDIPI")
        # Also strip "EDIPI <10 digits>" out of any string fields so the
        # remark preview doesn't carry a Marine's lookup key.
        for key in ("poc", "poc_phone", "remark"):
            if key in out and isinstance(out[key], str):
                before = out[key]
                after = re.sub(r"EDIPI\s*\d{10}", "EDIPI [REDACTED]", before)
                if after != before:
                    out[key] = after
                    _add(key, before, after, "EDIPI")

    for field in redactions:
        rule = profiles()["redaction_rules"].get(field)
        if rule is None:
            continue
        if field == "EDIPI":
            continue  # Already handled in Pass 1.
        elif field == "POC_PHONE":
            for key in ("poc", "poc_phone", "remark"):
                if key in out and isinstance(out[key], str):
                    before = out[key]
                    after = re.sub(r"\d{3}[-.]?\d{3}[-.]?\d{4}", "[PHONE REDACTED]", before)
                    out[key] = after
                    _add(key, before, after, "POC_PHONE")
        elif field == "billet_nickname":
            for key in ("poc", "remark"):
                if key in out and isinstance(out[key], str):
                    before = out[key]
                    after = re.sub(r"\s*\([^)]*\)", "", before)
                    out[key] = after
                    _add(key, before, after, "billet_nickname")
        elif field == "serial_number":
            # Walkthrough #2 — serial_number redaction must also strip
            # serials from the remark text. Earlier code only replaced
            # `out["serial_number"]`, leaving "S/N USMC-12345" visible
            # in the partner remark while showing a "SERIAL × REDACTED"
            # badge. Now both surfaces are redacted in lockstep.
            if "serial_number" in out:
                before = out["serial_number"]
                out["serial_number"] = "[SERIAL REDACTED]"
                _add("serial_number", before, out["serial_number"], "serial_number")
            for key in ("remark", "poc"):
                if key in out and isinstance(out[key], str):
                    before = out[key]
                    after = re.sub(
                        r"S/N\s+(USA|USMC[A-Z\-]*)[-\s]?[\w-]+",
                        "[SERIAL REDACTED]",
                        before,
                    )
                    if after != before:
                        out[key] = after
                        _add(key, before, after, "serial_number")
        elif field == "tm_reference":
            # Walkthrough #2 — tm_reference redaction must also strip TM
            # numbers inline in remarks. "Replaced both batteries per TM
            # 9-2320-391-10" should become "...per [TM REFERENCE REDACTED]".
            if "tm_reference" in out:
                before = out["tm_reference"]
                out["tm_reference"] = "[TM REFERENCE REDACTED]"
                _add("tm_reference", before, out["tm_reference"], "tm_reference")
            for key in ("remark", "poc"):
                if key in out and isinstance(out[key], str):
                    before = out[key]
                    after = re.sub(
                        r"\[\s*CLASSIFIED\s+TM[^\]]*\]",
                        "[TM REFERENCE REDACTED]",
                        before,
                        flags=re.IGNORECASE,
                    )
                    after = re.sub(
                        r"TM\s+\d+(?:-\d+){2,4}[A-Z]?(?:-[A-Z0-9]+)?",
                        "[TM REFERENCE REDACTED]",
                        after,
                    )
                    if after != before:
                        out[key] = after
                        _add(key, before, after, "tm_reference")
        elif field == "fault_component" and "fault_component" in out:
            before = out["fault_component"]
            after = _generalize_component(before)
            out["fault_component"] = after
            _add("fault_component", before, after, "fault_component")
        elif field == "supply_path" and "supply_path" in out:
            before = out["supply_path"]
            out["supply_path"] = "MILSTRIP"
            _add("supply_path", before, out["supply_path"], "supply_path")
    return out, spans


_COMPONENT_FAMILIES = {
    "drivetrain":   ["output shaft", "input shaft", "differential", "driveshaft", "transmission",
                     "transfer case", "axle"],
    "engine":       ["starter", "alternator", "injector", "turbo", "cylinder head", "piston", "valve",
                     "engine", "block", "manifold", "cam", "crank"],
    "brake":        ["caliper", "pad set", "master cylinder", "abs module", "brake"],
    "electrical":   ["battery", "harness", "ecm", "relay", "solenoid", "wiring", "ground strap",
                     "alternator harness", "fuse panel"],
    "hydraulic":    ["pump", "reservoir", "hose", "cylinder", "hydraulic"],
    "armament":     ["sight", "barrel", "bolt", "feed tray", "bolt carrier", "trigger group"],
    "cooling":      ["radiator", "coolant", "water pump", "thermostat", "fan clutch", "intercooler",
                     "heater core", "coolant hose", "cooling"],
    "tire":         ["tire", "wheel", "rim", "stem", "valve core", "lug", "wheel hub"],
    "corrosion":    ["rust", "pitting", "corrosion", "scale", "oxidation", "coating loss"],
    "rotor":        ["rotor head", "rotor", "swashplate", "tail rotor", "blade grip", "main blade", "pitch link"],
    "launcher":     ["launch tube", "elevation actuator", "azimuth motor", "launcher"],
    "fire_control": ["fire control", "fire_control", "ballistic computer", "laser rangefinder", "thermal channel",
                     "gunner sight", "commander sight", "stabilizer"],
}

# Match priority: try the more specific families before the broad ones so e.g.
# 'rotor head' falls into 'rotor' instead of being caught by another family
# that happens to share a substring. Iteration order is insertion order in
# Python 3.7+, so we explicitly enumerate the priority sequence here.
_FAMILY_PRIORITY = [
    "rotor",       # before brake (which also has 'rotor' in some pads)
    "fire_control",
    "launcher",
    "drivetrain",
    "engine",
    "cooling",
    "electrical",
    "hydraulic",
    "armament",
    "brake",
    "tire",
    "corrosion",
]


def _generalize_component(c: str) -> str:
    lc = c.lower()
    for family in _FAMILY_PRIORITY:
        for p in _COMPONENT_FAMILIES.get(family, []):
            if p in lc:
                return family
    return "subsystem"


def partner_units_for(profile_key: str) -> list[dict]:
    """Return coalition partner units surfaced on the coalition tab for a profile."""
    p = profiles()["profiles"].get(profile_key, {})
    return p.get("partner_units", [])
