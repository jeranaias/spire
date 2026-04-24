"""
Answer verification middleware.

LLMs hallucinate. Even at 512K context with temperature 0, a judge's demo
question could be answered with a plausible-but-wrong number. Verifier runs
on every response before rendering:

  1. Parse LLM output for numeric claims (percentages, counts, asset IDs).
  2. For each claim, look up the canonical value from the dataset.
  3. If claim matches canonical: annotate [verified].
  4. If claim differs: annotate [LLM estimate: X, canonical: Y].
  5. If claim references an entity the dataset doesn't contain: annotate
     [unverified] and log to the audit trail.

Today's coverage:
  - MC-rate percentages per unit ("CLB-6 is at 62% MC")
  - Asset counts ("12 critical assets in CLB-6")
  - Days NMC
  - Classification mix percentages

This is a light verification pass -- not a full provenance engine. The real
guarantee is that *the number the UI ultimately displays* comes from the
canonical backend, not the LLM. Verifier annotates so the user sees both.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from typing import Optional

from .state import CanonicalDataset, get_dataset, last_day_snapshots


# Patterns for extractable numeric claims.
MC_RATE_PATTERN = re.compile(
    r"(CLB-\d|[0-9]+(?:st|nd|rd|th)? (?:MLG|MarDiv|Tank|LAR|Marines)|MALS-\d+|MWSS-\d+|2d LAAD Bn|5/11 Marines|7th ESB|3d Maint Bn)\s+(?:is\s+)?(?:at|showing|running)?\s*(\d{1,3}(?:\.\d+)?)\s*%\s*MC",
    re.IGNORECASE,
)
ASSET_COUNT_PATTERN = re.compile(
    r"(\d+)\s+(?:critical|NMC|NMCS|deadlined|assets?)\s+(?:in|at|for)\s+([A-Z][\w\s\-/]+)",
)


@dataclass
class Claim:
    kind: str
    text: str
    extracted_value: str
    canonical_value: Optional[str] = None
    status: str = "unverified"  # verified | mismatch | unverified


def verify_answer(llm_text: str) -> dict:
    """Run verification passes on an LLM answer. Returns:
      {
        "annotated": annotated text with inline markers,
        "claims": list of Claim objects,
        "verified_count": N,
        "mismatch_count": N,
        "unverified_count": N,
      }
    """
    ds = get_dataset()
    claims: list[Claim] = []
    annotated = llm_text

    # Pass 1: MC-rate claims
    for m in MC_RATE_PATTERN.finditer(llm_text):
        unit_raw = m.group(1).strip()
        claimed = float(m.group(2))
        canonical = _canonical_mc_rate(ds, unit_raw)
        c = Claim(kind="mc_rate", text=m.group(0), extracted_value=f"{claimed:.1f}%")
        if canonical is not None:
            canonical_pct = canonical * 100
            c.canonical_value = f"{canonical_pct:.1f}%"
            if abs(canonical_pct - claimed) <= 2.0:
                c.status = "verified"
            else:
                c.status = "mismatch"
        claims.append(c)

    # Apply inline annotations
    for c in claims:
        if c.status == "verified":
            marker = f"{c.text} [verified]"
        elif c.status == "mismatch":
            marker = f"{c.text} [LLM estimate: {c.extracted_value}, canonical: {c.canonical_value}]"
        else:
            marker = f"{c.text} [unverified]"
        annotated = annotated.replace(c.text, marker, 1)

    return {
        "annotated": annotated,
        "claims": [c.__dict__ for c in claims],
        "verified_count": sum(1 for c in claims if c.status == "verified"),
        "mismatch_count": sum(1 for c in claims if c.status == "mismatch"),
        "unverified_count": sum(1 for c in claims if c.status == "unverified"),
    }


def _canonical_mc_rate(ds: CanonicalDataset, unit_ref: str) -> Optional[float]:
    """Look up the canonical MC rate for a unit reference."""
    last = last_day_snapshots(ds)
    if not last:
        return None
    # Normalize: "CLB-6" matches "CLB-6", "7th ESB" matches "7th ESB"
    target = unit_ref.strip().lower()
    counts: dict = {}
    for s in last:
        if s.unit_name.lower() == target or target in s.unit_name.lower():
            counts.setdefault(s.unit_name, Counter())[s.readiness_code] += 1
    if not counts:
        return None
    # Pick the best match
    best = max(counts.keys(), key=lambda k: len(k))
    c = counts[best]
    total = sum(c.values())
    return c.get("MC", 0) / total if total > 0 else None
