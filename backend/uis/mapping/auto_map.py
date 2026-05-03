"""Name-similarity auto-mapper.

Given a list of source column names + a target AdapterSpec, propose
a mapping. Each canonical column gets the source column with the
highest Jaccard token-set similarity, above a threshold. Below the
threshold the canonical column is left unmapped — the LLM mapper or
the operator fills in.

This is the deterministic baseline. The LLM mapper (Phase 2) wraps
this and only consults the LLM when the heuristic lands below a
configurable confidence floor.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from ..adapters.spec import AdapterSpec
from ..normalize.headers import canonical_header, header_token_set, jaccard_similarity


# Default similarity threshold below which a column is left
# unmapped. Tuned empirically — Jaccard 0.5 means at least half of
# the unioned tokens overlap, which catches "service_request_number"
# vs "SR_NUM" but lets clearly-different columns ("notes" vs
# "tamcn") fall through to operator review.
DEFAULT_THRESHOLD = 0.5


@dataclass
class MappingProposal:
    """Proposed projection: source-col → canonical-field."""

    column_map: Dict[str, str] = field(default_factory=dict)
    confidence_per_field: Dict[str, float] = field(default_factory=dict)
    unmapped_canonical: List[str] = field(default_factory=list)
    unmapped_source: List[str] = field(default_factory=list)

    def average_confidence(self) -> float:
        if not self.confidence_per_field:
            return 0.0
        return sum(self.confidence_per_field.values()) / len(self.confidence_per_field)


def propose_mapping(
    source_columns: List[str],
    adapter: AdapterSpec,
    *,
    threshold: float = DEFAULT_THRESHOLD,
) -> MappingProposal:
    """Propose source-col → canonical-field via two-stage match.

    Stage 1: each canonical column with `source_aliases` claims the
    first source column that exact-canonical-form-matches one of
    its aliases (confidence 1.0). Stage 2: greedy Jaccard
    similarity for any remaining canonical columns.

    Greedy stage-2: each canonical column claims its highest-
    similarity unclaimed source column above the threshold. Ties
    resolve in canonical-column order (declared order on the
    AdapterSpec).
    """
    src_keys = [canonical_header(c) for c in source_columns]
    src_tokens = [header_token_set(c) for c in source_columns]
    canon_cols = adapter.canonical_columns
    canon_tokens = [header_token_set(c.name) for c in canon_cols]

    proposal = MappingProposal()
    claimed_src: set = set()
    claimed_canon: set = set()

    # Stage 1: source_aliases exact match (case-insensitive via
    # canonical-form key)
    for ci, col in enumerate(canon_cols):
        if not col.source_aliases:
            continue
        alias_keys = {canonical_header(a) for a in col.source_aliases}
        for si in range(len(source_columns)):
            if si in claimed_src:
                continue
            if src_keys[si] in alias_keys:
                claimed_src.add(si)
                claimed_canon.add(ci)
                proposal.column_map[source_columns[si]] = col.name
                proposal.confidence_per_field[col.name] = 1.0
                break

    # Stage 2: greedy similarity match for remaining canonical cols
    for ci, col in enumerate(canon_cols):
        if ci in claimed_canon:
            continue
        best_idx: Optional[int] = None
        best_score = 0.0
        for si in range(len(source_columns)):
            if si in claimed_src:
                continue
            score = jaccard_similarity(canon_tokens[ci], src_tokens[si])
            if score > best_score:
                best_score = score
                best_idx = si
        if best_idx is not None and best_score >= threshold:
            claimed_src.add(best_idx)
            proposal.column_map[source_columns[best_idx]] = col.name
            proposal.confidence_per_field[col.name] = round(best_score, 3)
        else:
            proposal.unmapped_canonical.append(col.name)

    proposal.unmapped_source = [
        source_columns[si] for si in range(len(source_columns))
        if si not in claimed_src
    ]
    return proposal
