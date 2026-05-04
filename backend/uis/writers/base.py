"""EntityWriter protocol — generic apply path for any adapter.

A writer is the canonical-side counterpart to an ``AdapterSpec``.
Where the adapter teaches the pipeline how to *parse* a source, the
writer teaches the route how to *merge* parsed canonical rows into
the live dataset.

Contract
--------
Three methods, all pure (no audit-log side effects, no swap).
The HTTP route owns the side effects so writers stay testable in
isolation and re-usable from non-HTTP channels (SFTP poll, email
intake, etc.).

  state_token(dataset) -> str
      Stable fingerprint over the slice this writer touches. Used
      for optimistic-concurrency on apply: dry-run captures it,
      apply 409s if the slice has moved.

  preview(rows, dataset) -> WriterDiff
      Compute the diff against the current dataset. The diff has
      counts (matched/new/stale/conflicts/unchanged), JSON-shaped
      payload for the dropzone, and per-bucket lists callers can
      walk to emit per-row audit entries.

  apply(diff, dataset) -> (new_dataset, summary_counts, audit_rows)
      Return a NEW CanonicalDataset (singleton swap is the route's
      job) plus the audit entries the route should fan out. Apply
      MUST be a pure function of (diff, dataset) — no global state.

Registry
--------
Writers register against an ``adapter_id`` (not target_entity)
because multiple adapters can target the same entity with different
merge semantics. ECP touches roster fields; UTIL touches utilization
fields; both are ``Asset`` writers but with disjoint logic. The
route looks up ``get_writer(adapter.id)``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Protocol, Tuple, runtime_checkable


@dataclass
class WriterDiff:
    """Generic diff shape returned by ``EntityWriter.preview``.

    The fields mirror the existing ECP merge engine so per-writer
    diff types can implement this protocol with minimal adaptation.
    """

    # Aggregate counts: {"matched_changed": N, "new": N, "unchanged": N,
    # "stale": N, "conflicts": N}. Routes serialize this directly to
    # the dropzone preview.
    counts: Dict[str, int] = field(default_factory=dict)

    # JSON-shaped representation of the diff for the UI. Each writer
    # produces this through its existing diff_to_payload() helper or
    # equivalent. Routes pass this through unchanged.
    payload: Dict[str, Any] = field(default_factory=dict)

    # Per-bucket lists. Generic ``Any`` because each writer carries
    # its own diff-row shape (MatchedRow vs MatchedSR vs MatchedRating).
    # Routes treat them opaquely except for length checks (e.g.
    # "block apply if conflicts > 0").
    matched: List[Any] = field(default_factory=list)
    new: List[Any] = field(default_factory=list)
    stale: List[Any] = field(default_factory=list)
    conflicts: List[Any] = field(default_factory=list)
    unchanged: List[Any] = field(default_factory=list)

    # Carrier for the engine-native diff so writers can pass their
    # full diff object to apply() without losing type info. The
    # apply() method casts it back to its native type. Routes never
    # touch this field.
    native: Any = None

    def has_conflicts(self) -> bool:
        return bool(self.conflicts)


@dataclass
class WriterApplyResult:
    """Return shape for ``EntityWriter.apply``.

    ``new_dataset`` is the full ``CanonicalDataset`` the route will
    hand to ``swap_dataset``. ``audit_rows`` is a list of per-row
    audit payloads the route will fan out (each payload is a dict
    of {kind, subject_id, payload}; the route adds ``actor``).
    """

    new_dataset: Any
    summary_counts: Dict[str, int] = field(default_factory=dict)
    audit_rows: List[Dict[str, Any]] = field(default_factory=list)


@runtime_checkable
class EntityWriter(Protocol):
    """Per-adapter writer. Everything routes need from a writer.

    Implementations are typically dataclasses with an ``adapter_id``
    attribute and stateless methods. Writers hold no mutable state
    so two requests can run concurrently against different writers
    without locking.
    """

    adapter_id: str            # "gcss-mc/ecp", "gcss-mc/sr-header", ...
    target_entity: str         # "Asset", "ServiceRequest", "CRating", ...

    def state_token(self, dataset: Any) -> str: ...

    def preview(
        self,
        pipeline_result: Any,
        dataset: Any,
    ) -> WriterDiff:
        """Compute the diff. ``pipeline_result`` is a ``PipelineResult``
        carrying canonical rows plus per-row sanitization labels and
        warnings the writer may need (e.g. to reconstruct
        ParsedAssetRow.serial_number_source for the legacy diff
        engine)."""
        ...

    def apply(
        self,
        diff: WriterDiff,
        dataset: Any,
    ) -> WriterApplyResult: ...


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


WRITERS: Dict[str, EntityWriter] = {}


def register_writer(writer: EntityWriter) -> EntityWriter:
    """Register a writer against its ``adapter_id``.

    Re-registering an existing adapter_id is allowed (tests do this
    to swap implementations) and overwrites the prior entry.
    """
    if not getattr(writer, "adapter_id", ""):
        raise ValueError("EntityWriter must declare a non-empty adapter_id")
    WRITERS[writer.adapter_id] = writer
    return writer


def get_writer(adapter_id: str) -> EntityWriter:
    """Look up the writer for an adapter. Raises KeyError if none."""
    if adapter_id not in WRITERS:
        raise KeyError(
            f"No writer registered for adapter_id {adapter_id!r}. "
            f"Known: {sorted(WRITERS.keys())}"
        )
    return WRITERS[adapter_id]


def has_writer(adapter_id: str) -> bool:
    return adapter_id in WRITERS
