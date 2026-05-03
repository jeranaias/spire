"""Header-name canonicalization.

Real exports use stylistic variations of the same logical column:

    "SR_NUMBER"   "sr_number"   "Sr Number"   "ServiceRequestNumber"
                  "SR-NUMBER"   "sr#"         "service_request_number"

`canonical_header` reduces all of those to a single uppercase
underscore form (`SR_NUMBER`). `header_token_set` produces a
bag-of-tokens for similarity scoring against the canonical column
names declared in an AdapterSpec.

Lossy normalizations (e.g. dropping `#` or pluralization) are
intentional: we trade some collisions for fuzzy matching that hits
real-world variation. The mapping profile is the operator's chance
to override anything ambiguous.
"""
from __future__ import annotations

import re
from typing import List, Set


# Strip everything but letters and digits, then lowercase. Used as
# the comparison key for fuzzy header matching.
_NON_ALNUM = re.compile(r"[^A-Za-z0-9]+")

# Convert camelCase / PascalCase to snake_case before alnum-stripping.
_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])")

# Common header-noise tokens that don't disambiguate anything in
# practice. Removed from token sets so "service_request_number" and
# "ServiceRequestNumber" land on the same key.
_NOISE_TOKENS = frozenset({"the", "a", "an", "of", "for", "in", "on"})


def canonical_header(raw: str) -> str:
    """Reduce a raw column name to its canonical form.

    "SR Number"            → "SR_NUMBER"
    "service_request_num"  → "SERVICE_REQUEST_NUM"
    "ServiceRequestNumber" → "SERVICE_REQUEST_NUMBER"
    "sr#"                  → "SR"
    """
    if raw is None:
        return ""
    s = str(raw).strip()
    if not s:
        return ""
    # Insert underscore at camelCase / PascalCase boundaries
    s = _CAMEL_BOUNDARY.sub("_", s)
    # Replace runs of non-alnum with a single underscore
    s = _NON_ALNUM.sub("_", s)
    s = s.strip("_")
    return s.upper()


def header_token_set(raw: str) -> Set[str]:
    """Bag-of-tokens of a header name, lowercased + denoised.

    Used by name-similarity auto-mapper for fuzzy matching against
    canonical column names. "ServiceRequestNumber" and "sr_num" both
    contain "sr" / "number" tokens (after morphology) so they cluster.
    """
    canon = canonical_header(raw).lower()
    tokens = {t for t in canon.split("_") if t and t not in _NOISE_TOKENS}
    # Cheap morphology: trim trailing 's' for plural-singular
    # collapse (rows / row, hours / hour). This is intentionally
    # lossy and good enough for header matching.
    expanded: Set[str] = set()
    for t in tokens:
        expanded.add(t)
        if len(t) > 3 and t.endswith("s"):
            expanded.add(t[:-1])
    # Common abbreviations expand both ways: SR <-> service_request,
    # NSN <-> national_stock_number, etc. Only the common ones for
    # the USMC logistics domain.
    abbrev_pairs = {
        "sr": "service_request",
        "nsn": "national_stock_number",
        "tamcn": "tamcn",  # already canonical
        "uic": "unit_identification_code",
        "edipi": "edipi",
        "nmc": "non_mission_capable",
        "mc": "mission_capable",
        "qty": "quantity",
        "num": "number",
        "no": "number",
        "dt": "date",
    }
    for short, long in abbrev_pairs.items():
        if short in expanded:
            expanded.update(long.split("_"))
        long_tokens = set(long.split("_"))
        if long_tokens.issubset(expanded):
            expanded.add(short)
    return expanded


def jaccard_similarity(a: Set[str], b: Set[str]) -> float:
    """Jaccard index between two token sets — len(a∩b) / len(a∪b)."""
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)
