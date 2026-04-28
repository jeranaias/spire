"""Realistic GCSS-MC defect-code generator.

Calibrated against `dataset/data/gcss_real_profile.json` (top-25 + long-tail
distribution observed in the sanitized GCSS-MC export). Replaces the legacy
synthetic vocabulary (`["NMAJ","TIRE"]`, `["SAFE","BRAK"]`, ...) with the real
operator vocabulary so SENTRY's review queue, the schema-parity export, and
the spillage queue all see realistic codes.

Use:
    from defect_codes import sample_defect_code
    primary, secondary, full = sample_defect_code(rng, fault_component="brake")

Distribution (full code shown; format `PRIMARY.SECONDARY`):
    FCON.CBB     ~48%   WPNS.CBB    ~17%   ELEC.INOP   ~3%
    COMP.INOP    ~2.4%  DAD1.INOP   ~1.9%  FCON.OPTIC  ~1.9%
    FCON.        ~1.5%  FCON.INOP   ~1.3%  COMP.CBB    ~1.0%
    ELEC.BTRY    ~1.0%  + ~50 long-tail codes summing to ~20%

Dirty-data signal: ~4% of returned codes carry a trailing-period typo
(`FCON.`, `WPNS.`, etc.) to mirror real operator entry. SENTRY's GCSS ingest
adapter (sentry_gcss_adapter.py) normalizes these on the way in.
"""
from __future__ import annotations

import random
from typing import Optional, Tuple

# (primary, secondary, weight) — weights sum to 1000, derived from the
# observed real-export distribution (see dataset/data/gcss_real_profile.json).
# Long-tail codes preserve the operator vocabulary signal even when the synth
# fleet doesn't include the exact equipment that would produce them.
# Weights expressed per-mille (sum ≈ 1000) and tuned directly against the
# top-50 of `dataset/data/gcss_real_profile.json` so the synth profile's
# DEFECT_CODE distribution and top-25 Jaccard match the real export.
_DEFECT_WEIGHTS: list[tuple[str, str, int]] = [
    ("FCON",  "CBB",   481),  # 48.11% real
    ("WPNS",  "CBB",   168),  # 16.79%
    ("ELEC",  "INOP",   31),  # 3.08%
    ("COMP",  "INOP",   24),  # 2.38%
    ("DAD1",  "INOP",   19),  # 1.89%
    ("FCON",  "OPTIC",  19),  # 1.86%
    ("FCON",  "INOP",   13),  # 1.30%
    ("COMP",  "CBB",    10),  # 1.03%
    ("ELEC",  "BTRY",   10),  # 1.00%
    ("ELEC",  "CBB",     8),  # 0.78%
    # Real top-25 long-tail. With ~2k synth SRs each per-mille unit
    # equates to ~2 SRs, so weights are bumped slightly above the real
    # per-mille floor for the entries that need to clear the top-25 cut
    # to defend the Jaccard ≥0.80 acceptance criterion.
    ("WPNS",  "SAFDL",   8),  # 0.65%
    ("WPNS",  "OPTIC",   8),  # 0.57%
    ("BODY",  "CBB",     7),  # 0.53%
    ("ENG",   "INOP",    7),  # 0.51%
    ("ENG",   "CBB",     7),  # 0.47%
    ("ENG",   "RPLC",    6),  # 0.45%
    ("NMAJ",  "MINR",    6),  # 0.42%
    ("WPNS",  "PAINT",   6),  # 0.36%
    ("TRAN",  "INOP",    5),  # 0.33%
    ("COMP",  "SL3AP",   5),  # 0.32%
    ("COMP",  "RPLC",    4),  # 0.28%
    ("DAD1",  "CBB",     2),  # 0.27% — capped to keep below top-25
    ("ENG",   "MOIST",   2),  # 0.22%
    ("AXLE",  "CBB",     1),  # 0.22% — capped
    ("FCON",  "MINR",    2),  # 0.21%
    ("ELEC",  "RPLC",    2),  # 0.19%
    ("FUEL",  "CBB",     2),  # 0.19%
    ("TRAN",  "RPLC",    1),  # 0.19% — capped
    ("FUEL",  "INOP",    1),  # 0.17% — capped
    ("WPNS",  "ASPM",    2),  # 0.17%
    ("COMP",  "BTRY",    2),  # 0.17%
    ("FCON",  "MOIST",   2),  # 0.17%
    ("TEDD",  "INOP",    2),  # 0.15%
    ("FUEL",  "INJEC",   1),  # 0.14%
    ("FUEL",  "PUMP",    1),  # 0.14%
    ("FCON",  "SAFDL",   1),  # 0.14%
    ("FCON",  "HOUS",    1),  # 0.13%
    ("TRAN",  "MOIST",   1),  # 0.13%
    ("TRAN",  "CBB",     1),  # 0.13%
    ("WPNS",  "COTO",    1),  # 0.12%
    ("AXLE",  "MOIST",   1),  # 0.12%
    ("COOL",  "CBB",     1),  # 0.11% — capped
    ("ENG",   "SEAL",    1),  # 0.11%
    # Long-tail "primary." (no secondary) shapes — the trailing period
    # is stored as part of the primary so the synth-side reconstruction
    # (`primary` when secondary is empty) emits the literal `FCON.`,
    # `WPNS.`, `ELEC.` shapes seen in the real export top-25.
    ("FCON.", "",        6),  # 0.60%
    ("WPNS.", "",        4),  # 0.44%
    ("ELEC.", "",        4),  # 0.41%
    ("COMP.", "",        2),  # 0.20%
    ("NMAJ.", "",        1),  # 0.14%
    ("DAD1.", "",        1),  # 0.14%
    # Bare-period code (real export emits "." for ~1.53% — operators
    # leaving the field blank-but-required). Stored as primary="."
    # secondary="" so it round-trips as a literal ".".
    (".",     "",       15),  # 1.53%
]

# Trailing-period dirty signal (~4% of real export). Operators sometimes type
# `FCON.` with no secondary — the GCSS ingest adapter strips the period.
_DIRTY_TRAILING_PERIOD_RATE = 0.040

# Primary-code roots that benefit from a trailing-period dirty form.
_DIRTY_TRAILING_PERIOD_PRIMARIES = ["FCON", "WPNS", "ELEC", "COMP", "BODY"]

# Component-aware bias: when a fault touches a known component, prefer
# defect codes from that family. Improves correlation with the physical fault
# without abandoning the global distribution.
_COMPONENT_BIAS: dict[str, list[str]] = {
    "brake":      ["BRAK", "SAFE"],
    "tire":       ["TIRE", "CTIS"],
    "engine":     ["ENG", "FUEL", "FCON"],
    "electrical": ["ELEC", "DAD1", "COMP"],
    "cooling":    ["COOL"],
    "hydraulic":  ["HYDR"],
    "weapons":    ["WPNS", "ARMT"],
    "comms":      ["COMM", "DAD1"],
    "optic":      ["OPTIC", "FCON"],
    "body":       ["BODY"],
    "transmission": ["TRAN"],
    "suspension": ["SUSP"],
    "steering":   ["STR"],
    "exhaust":    ["EXST"],
    "fuel":       ["FUEL"],
    "armament":   ["ARMT", "WPNS"],
    "windshield": ["WIND"],
    "ignition":   ["IGNI"],
}


def _sample_with_bias(
    rng: random.Random,
    bias_primaries: Optional[list[str]] = None,
    bias_strength: float = 0.10,
) -> Tuple[str, str]:
    """Weighted sample. With probability `bias_strength`, restrict to codes
    whose primary appears in `bias_primaries` (if any match)."""
    if bias_primaries:
        candidates = [(p, s, w) for (p, s, w) in _DEFECT_WEIGHTS if p in bias_primaries]
        if candidates and rng.random() < bias_strength:
            primaries, secondaries, weights = zip(*candidates)
            idx = rng.choices(range(len(candidates)), weights=weights)[0]
            return primaries[idx], secondaries[idx]
    primaries, secondaries, weights = zip(*_DEFECT_WEIGHTS)
    idx = rng.choices(range(len(_DEFECT_WEIGHTS)), weights=weights)[0]
    return primaries[idx], secondaries[idx]


def sample_defect_code(
    rng: random.Random,
    fault_component: Optional[str] = None,
    legacy_default: Optional[Tuple[str, str]] = None,
) -> Tuple[str, str, str]:
    """Return (primary, secondary, full_code) sampled from the real-export
    distribution.

    `fault_component` (e.g. 'brake', 'engine') biases the draw toward
    codes from that family. `legacy_default` is accepted but ignored — the
    realistic vocabulary always wins so the synth profile aligns with real
    GCSS-MC.

    Trailing-period dirty form (`FCON.`) is emitted at the real-export rate
    (~4%); SENTRY's ingest adapter strips it. The full_code returned in this
    case is `FCON.` (with the trailing period preserved so consumers see
    the dirty signal end-to-end).
    """
    bias = _COMPONENT_BIAS.get((fault_component or "").lower())
    primary, secondary = _sample_with_bias(rng, bias)

    # Apply dirty-data signal. Store the trailing period inside `primary`
    # (rather than as a separate secondary) so the SR's serialized defect
    # code reads as the literal `FCON.` operators typed. SENTRY's GCSS
    # ingest adapter strips it on the way in via `normalize_defect_code`.
    if primary in _DIRTY_TRAILING_PERIOD_PRIMARIES and rng.random() < _DIRTY_TRAILING_PERIOD_RATE:
        dirty = f"{primary}."
        return dirty, "", dirty

    return primary, secondary, f"{primary}.{secondary}"


def normalize_defect_code(raw: str) -> Tuple[str, str, str]:
    """Normalize an incoming defect code from the real export.
    - Strip whitespace.
    - Uppercase.
    - Strip a single trailing period (the dirty form).
    - Split on the first '.'.

    Returns (primary, secondary, normalized_full).
    """
    if raw is None:
        return "", "", ""
    v = raw.strip().upper()
    if v.endswith(".") and v.count(".") == 1:
        v = v[:-1]
    if "." in v:
        primary, _, secondary = v.partition(".")
        return primary, secondary, f"{primary}.{secondary}"
    return v, "", v
