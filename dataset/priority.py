"""GCSS-MC MASTER_PRIORITY_CODE per MCO 4400.16.

The real export emits priority as a formatted string `"{NN} {BAND}-{LABEL}"`,
e.g. `"06 B-Urgent"`, `"13 C-Routine"`, `"02 A-Critical"`. The numeric band
maps to a 3-tier urgency band (A/B/C) drawn from the FAD (Force Activity
Designator) crossed with the UND (Urgency of Need Designator) per MCO
4400.16:

    01-03  → A-Critical  (Combat Essential, mission impact within 24h)
    04-08  → B-Urgent    (Combat Capable, impact within 7 days)
    09-15  → C-Routine   (Combat Ready, no immediate impact)

The synth dataset previously emitted just the two-digit numeric (`"02"`,
`"05"`, `"10"`); after WP-2 it emits the full string so the GCSS-MC
schema-parity export and SENTRY review queue both display the right text.
"""
from __future__ import annotations

import random
from typing import Tuple

# Numeric → label band derived from the real GCSS-MC export labels (see
# `dataset/data/gcss_real_profile.json`):
#   01-03  → A-Critical
#   04-09  → B-Urgent
#   10-15  → C-Routine
# Note: MCO 4400.16's traditional groupings put 09 in C; the live system
# treats 09 as B-Urgent. We mirror what the real export emits so SENTRY
# parses both safely.
def _band(numeric: int) -> Tuple[str, str]:
    if 1 <= numeric <= 3:
        return "A", "Critical"
    if 4 <= numeric <= 9:
        return "B", "Urgent"
    if 10 <= numeric <= 15:
        return "C", "Routine"
    return "C", "Routine"


def format_priority(numeric: int) -> str:
    band, label = _band(numeric)
    return f"{numeric:02d} {band}-{label}"


# Real-export distribution (top-7 codes account for ~99% of rows). Weights
# total to 1000 so they read as per-mille for easy tuning. Aligned to
# `dataset/data/gcss_real_profile.json` (top values: 06=54%, 05=20%,
# 13=8.7%, 09=6.3%, 12=3.7%, 03=3.5%, 02=2.8%, plus a long tail).
_PRIORITY_WEIGHTS: list[tuple[int, int]] = [
    (6,  543),  # 06 B-Urgent
    (5,  203),  # 05 B-Urgent
    (13,  87),  # 13 C-Routine
    (9,   63),  # 09 B-Urgent
    (12,  37),  # 12 C-Routine
    (3,   35),  # 03 A-Critical
    (2,   28),  # 02 A-Critical
    (14,   3),  # 14 C-Routine
    (7,    1),  # 07 A-Critical (rare)
]

# Condition-aware bias. A "Deadlined" SR should weight A-band; a "Minor"
# SR should weight C-band. Real GCSS-MC operators set priority in tandem
# with deadline state, so this correlates synth output with the field shop's
# behavior.
_CONDITION_BIAS: dict[str, tuple[str, ...]] = {
    "Deadlined": ("A",),
    "Degraded":  ("B",),
    "Minor":     ("C",),
    "Supply":    ("C",),
    "Service":   ("C",),
}


def sample_priority_numeric(
    rng: random.Random,
    condition: str | None = None,
    bias_strength: float = 1.0,
) -> int:
    """Sample a priority numeric (1-15). With probability `bias_strength`,
    restrict the draw to the band consistent with the supplied condition.

    Default 1.0 keeps the consistency-validator (`condition_priority_alignment`)
    bounded — a Deadlined SR that draws into the C-band would log a warning
    and the test caps total warnings at <100. The within-band weights still
    track the real GCSS-MC distribution, so the export's TVD against real
    stays inside WP-2 tolerance.
    """
    bias_bands = _CONDITION_BIAS.get(condition or "", ())
    if bias_bands and rng.random() < bias_strength:
        candidates = [(n, w) for (n, w) in _PRIORITY_WEIGHTS if _band(n)[0] in bias_bands]
        if candidates:
            nums, ws = zip(*candidates)
            return rng.choices(nums, weights=ws)[0]
    nums, ws = zip(*_PRIORITY_WEIGHTS)
    return rng.choices(nums, weights=ws)[0]


def sample_priority(
    rng: random.Random,
    condition: str | None = None,
) -> str:
    """Sample a full GCSS-MC priority string `"06 B-Urgent"`."""
    return format_priority(sample_priority_numeric(rng, condition))


def parse_priority(value: str) -> dict:
    """Parse `"06 B-Urgent"` → `{numeric: 6, band: "B", label: "Urgent",
    full: "06 B-Urgent"}`. Tolerates the bare numeric form (`"06"`) and
    odd whitespace. Returns None on values that don't match either shape."""
    if value is None:
        return None  # type: ignore[return-value]
    v = value.strip()
    if not v:
        return None  # type: ignore[return-value]
    parts = v.split()
    try:
        numeric = int(parts[0])
    except (ValueError, IndexError):
        return None  # type: ignore[return-value]
    if len(parts) < 2:
        band, label = _band(numeric)
        return {"numeric": numeric, "band": band, "label": label, "full": format_priority(numeric)}
    band_label = parts[1]
    if "-" in band_label:
        band, _, label = band_label.partition("-")
    else:
        band, label = _band(numeric)
    return {
        "numeric": numeric,
        "band": band,
        "label": label,
        "full": f"{numeric:02d} {band}-{label}",
    }
