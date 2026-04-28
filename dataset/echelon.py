"""GCSS-MC ECHELON_OF_MAINT realignment.

Real export emits ECHELON_OF_MAINT as an integer string (`"1"`, `"2"`, `"3"`,
`"4"`); SPIRE internally tracks the human-readable label
(`"Organizational"`, `"Intermediate"`, `"Depot"`, `"SOR"`). This module
mediates between the two and provides a sampler whose distribution mirrors
the real export.

Distribution (from `dataset/data/gcss_real_profile.json`):
    2  Intermediate    ~55.8%
    3  Depot           ~36.7%
    1  Organizational  ~7.1%
    4  SOR (rare)      ~0.1%
"""
from __future__ import annotations

import random
from typing import Tuple

NUMERIC_TO_LABEL: dict[int, str] = {
    1: "Organizational",
    2: "Intermediate",
    3: "Depot",
    4: "SOR",
}

LABEL_TO_NUMERIC: dict[str, int] = {v: k for k, v in NUMERIC_TO_LABEL.items()}

# Real-export distribution.
_ECHELON_WEIGHTS: list[tuple[int, int]] = [
    (2, 558),
    (3, 367),
    (1,  71),
    (4,   4),
]

# Bias by maintenance_level the fault declared. Org-level faults shouldn't
# all spike to depot; instead, weight slightly toward declared level while
# still respecting the real export's bulk shape.
_LEVEL_BIAS: dict[str, tuple[int, ...]] = {
    "Organizational": (1, 2),
    "Intermediate":   (2, 3),
    "Depot":          (3, 4),
    "SOR":            (4,),
}


def sample_echelon_numeric(
    rng: random.Random,
    declared_level: str | None = None,
    bias_strength: float = 0.05,
) -> int:
    """Sample an ECHELON_OF_MAINT integer (1-4). With probability
    `bias_strength`, restrict to numbers consistent with the declared
    maintenance level; otherwise draw from the real-export distribution."""
    bias = _LEVEL_BIAS.get(declared_level or "")
    if bias and rng.random() < bias_strength:
        candidates = [(n, w) for (n, w) in _ECHELON_WEIGHTS if n in bias]
        if candidates:
            nums, ws = zip(*candidates)
            return rng.choices(nums, weights=ws)[0]
    nums, ws = zip(*_ECHELON_WEIGHTS)
    return rng.choices(nums, weights=ws)[0]


def sample_echelon(
    rng: random.Random,
    declared_level: str | None = None,
) -> Tuple[int, str]:
    """Sample an echelon and return (numeric, label)."""
    n = sample_echelon_numeric(rng, declared_level)
    return n, NUMERIC_TO_LABEL[n]


# SERVICE_REQUEST_TYPE distribution. Real export is essentially 100%
# `Maintenance - CM`, but the schema permits PM and Inspection too. We
# emit the dominant value with rare alternates so the spillage queue has
# nothing to choke on when an unfamiliar value lands.
SERVICE_REQUEST_TYPES: list[tuple[str, int]] = [
    ("Maintenance - CM", 990),
    ("Maintenance - PM",   8),
    ("Inspection",         2),
]


def sample_service_request_type(rng: random.Random) -> str:
    types, ws = zip(*SERVICE_REQUEST_TYPES)
    return rng.choices(types, weights=ws)[0]
