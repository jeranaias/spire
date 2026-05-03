"""LLM-assisted column mapper.

Wraps the deterministic auto-mapper. When the auto-mapper's average
confidence is below a threshold (or there are unmapped canonical
columns), we ask the LLM to propose mappings for the remaining
columns. The LLM call routes through the existing tier-router
(Tier-A RigRun primary → Tier-B local Gemma 4 e2b → Tier-C
deterministic fallback to whatever auto_map produced).

The LLM gets:
  * The list of canonical column names + descriptions
  * The list of unmapped source column names + a few sample row values

It returns:
  * proposed: source_col → canonical_field mappings
  * confidence per field (0..1)
  * reasoning per mapping (short string the operator sees)

The mapper NEVER overwrites a confirmed mapping the auto-mapper
produced. It only fills in gaps.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence, Tuple

from ..adapters.spec import AdapterSpec
from .auto_map import MappingProposal, propose_mapping


log = logging.getLogger(__name__)


# Confidence below which the LLM is invoked. Above this, we trust
# the auto-mapper.
LLM_CONFIDENCE_FLOOR = 0.7


@dataclass
class LlmMappingProposal:
    """Augmented MappingProposal with per-field reasoning."""

    column_map: Dict[str, str] = field(default_factory=dict)
    confidence_per_field: Dict[str, float] = field(default_factory=dict)
    reasoning_per_field: Dict[str, str] = field(default_factory=dict)
    unmapped_canonical: List[str] = field(default_factory=list)
    unmapped_source: List[str] = field(default_factory=list)
    auto_baseline_confidence: float = 0.0
    llm_invoked: bool = False
    llm_failed: bool = False
    llm_failure_reason: Optional[str] = None


# Type alias for an injectable LLM caller. The default in production
# routes through `backend.routes.llm.call_llm_chat`. Tests inject a
# deterministic stub.
LlmCaller = Callable[..., Awaitable[Dict[str, Any]]]


def _redact_sample_rows(
    sample_rows: List[Dict[str, str]],
    adapter: AdapterSpec,
    column_map_so_far: Dict[str, str],
) -> List[Dict[str, str]]:
    """Strip values for source columns whose canonical target is
    declared sensitive on the AdapterSpec.

    The LLM gets to see the COLUMN NAME of every source col so it
    can propose mappings, but the VALUES of columns we already know
    map to sensitive canonical fields are replaced with a fixed
    redaction placeholder. Without this, a pre-sanitization upload
    (operator drops a raw export before running it through their
    sanitization pipeline) would leak clear UICs / serials / SSNs /
    EDIPIs to the upstream LLM service.

    Note: we can only redact columns that the auto-mapper ALREADY
    matched to a sensitive canonical target. Columns the LLM is
    being asked about are by definition unmapped — for those we
    apply heuristic field-name redaction (any source col whose
    canonical-form name matches a known sensitive token like
    SERIAL, UIC, EDIPI, SSN, DODID, NAME) so even unmapped cols
    that LOOK sensitive get redacted.
    """
    if not sample_rows:
        return sample_rows
    sensitive_canonical = {
        c.name for c in adapter.canonical_columns if c.sensitive
    }
    sensitive_sources_via_mapping = {
        src for src, canon in column_map_so_far.items()
        if canon in sensitive_canonical
    }
    # Heuristic redaction for unmapped source cols whose name
    # contains a known sensitive token. False positives (a column
    # genuinely named "name" that's not PII) just lose their
    # sample value — the LLM still sees the column name.
    sensitive_tokens = (
        "ssn", "edipi", "dodid", "serial", "name", "uic", "address",
        "phone", "email", "passport", "license",
    )
    from ..normalize.headers import canonical_header

    def is_heuristically_sensitive(col_name: str) -> bool:
        # Substring match against the canonical-form name catches
        # variants like Address1, AddressLine, FullName, FirstName,
        # serialNum, SerialNumber, etc. The token-set approach only
        # matched whole tokens after underscore-split which missed
        # Address1 tokenizing as {"address1"}.
        canon = canonical_header(col_name).lower()
        return any(tok in canon for tok in sensitive_tokens)

    redacted_rows: List[Dict[str, str]] = []
    for row in sample_rows:
        out: Dict[str, str] = {}
        for src_col, value in row.items():
            if src_col in sensitive_sources_via_mapping or is_heuristically_sensitive(src_col):
                out[src_col] = "<redacted>"
            else:
                out[src_col] = value
        redacted_rows.append(out)
    return redacted_rows


def _build_messages(
    adapter: AdapterSpec,
    unmapped_canonical: List[str],
    unmapped_source: List[str],
    sample_rows: List[Dict[str, str]],
) -> list:
    """Compose the system + user messages for the LLM.

    Kept compact: a 250-token system prompt + a small JSON payload.
    The LLM responds with strict JSON we parse below.
    """
    canonical_descriptions = []
    for c in adapter.canonical_columns:
        if c.name not in unmapped_canonical:
            continue
        line = f"  - {c.name}"
        if c.description:
            line += f": {c.description}"
        if c.type != "str":
            line += f"  [type={c.type}]"
        if c.source_aliases:
            line += f"  (known aliases: {', '.join(c.source_aliases)})"
        canonical_descriptions.append(line)

    sample_text = ""
    if sample_rows:
        # First 3 rows is enough — more inflates token cost without helping.
        for i, row in enumerate(sample_rows[:3]):
            visible = {k: row.get(k, "")[:60] for k in unmapped_source if k in row}
            sample_text += f"  row[{i}]: {json.dumps(visible)}\n"

    system = (
        "You map a source-system CSV column onto a canonical SPIRE schema field. "
        "Output ONLY a JSON object of the form "
        '{"mappings": [{"source": str, "canonical": str, "confidence": float, "reasoning": str}, ...]}. '
        "Each mapping must use a source name from the provided list and a canonical name from the provided list. "
        "Skip uncertain mappings (don't guess); the operator will fill in. "
        "Confidence is 0..1. Reasoning is one short sentence."
    )
    user = (
        f"Adapter: {adapter.id} ({adapter.name})\n"
        f"Target entity: {adapter.target_entity}\n\n"
        f"Unmapped canonical fields:\n"
        + "\n".join(canonical_descriptions)
        + "\n\nUnmapped source columns:\n  "
        + ", ".join(unmapped_source)
        + "\n\nSample row values:\n"
        + (sample_text or "  (no sample rows available)")
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _parse_llm_response(text: str) -> List[Dict[str, Any]]:
    """Extract the mappings array from the LLM's JSON response.

    Tolerant of code-fenced JSON, leading prose, trailing prose.
    Returns an empty list on parse failure.
    """
    if not text:
        return []
    # Strip ``` fences if present
    if "```" in text:
        for part in text.split("```"):
            stripped = part.strip()
            if stripped.startswith("json"):
                stripped = stripped[4:].strip()
            if stripped.startswith("{"):
                try:
                    obj = json.loads(stripped)
                    return list(obj.get("mappings") or [])
                except json.JSONDecodeError:
                    continue
    # Try to find the JSON object inline
    depth = 0
    start = -1
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                blob = text[start : i + 1]
                try:
                    obj = json.loads(blob)
                    return list(obj.get("mappings") or [])
                except json.JSONDecodeError:
                    start = -1
    return []


async def propose_mapping_with_llm(
    source_columns: List[str],
    adapter: AdapterSpec,
    sample_rows: Optional[List[Dict[str, str]]] = None,
    *,
    llm_caller: Optional[LlmCaller] = None,
    auto_map_threshold: float = 0.5,
    confidence_floor: float = LLM_CONFIDENCE_FLOOR,
) -> LlmMappingProposal:
    """Two-stage mapping: auto-map baseline → LLM fills gaps.

    Parameters
    ----------
    source_columns
        Header names from the uploaded file.
    adapter
        Declarative AdapterSpec for the source.
    sample_rows
        Optional first few parsed rows. Improves LLM accuracy for
        numeric vs date vs string columns. Pass None to skip.
    llm_caller
        Injection seam — defaults to `backend.routes.llm.call_llm_chat`
        if None. Tests pass a deterministic stub.
    auto_map_threshold
        Passed through to the deterministic auto-mapper.
    confidence_floor
        Below this average confidence on the auto-baseline, the LLM
        is invoked for the unmapped tail. 1.0 means "always invoke".

    Returns
    -------
    LlmMappingProposal carrying merged mapping, per-field
    confidence, per-field reasoning, and metadata about whether
    the LLM was actually called.
    """
    base = propose_mapping(source_columns, adapter, threshold=auto_map_threshold)

    out = LlmMappingProposal(
        column_map=dict(base.column_map),
        confidence_per_field=dict(base.confidence_per_field),
        unmapped_canonical=list(base.unmapped_canonical),
        unmapped_source=list(base.unmapped_source),
        auto_baseline_confidence=base.average_confidence(),
    )
    # Reasoning for auto-mapped fields stays empty — the operator
    # sees the high confidence and trusts the heuristic.

    # Skip the LLM if the baseline is good enough or there's nothing
    # to map.
    if not base.unmapped_canonical or not base.unmapped_source:
        return out
    if base.average_confidence() >= confidence_floor and not base.unmapped_canonical:
        return out

    # Resolve the LLM caller lazily so this module stays import-safe
    # without hauling in the routes.llm module at import time.
    if llm_caller is None:
        try:
            from ...routes.llm import call_llm_chat
            llm_caller = call_llm_chat
        except ImportError:
            out.llm_failed = True
            out.llm_failure_reason = "llm_caller unavailable"
            return out

    out.llm_invoked = True
    # Redact sensitive cell values before composing the LLM prompt.
    # The LLM sees source-column NAMES and a redaction placeholder
    # for sensitive cells, never clear PII. See _redact_sample_rows
    # for the policy.
    redacted_rows = _redact_sample_rows(
        sample_rows or [],
        adapter,
        column_map_so_far=base.column_map,
    )
    messages = _build_messages(
        adapter,
        unmapped_canonical=out.unmapped_canonical,
        unmapped_source=out.unmapped_source,
        sample_rows=redacted_rows,
    )
    try:
        response = await llm_caller(
            messages=messages,
            temperature=0.0,
            max_tokens=512,
            tier="tier1_cheap",
            call_site="uis.llm_map",
        )
    except Exception as e:  # noqa: BLE001
        log.warning("LLM mapper failed; falling back to auto-map only: %s", e)
        out.llm_failed = True
        out.llm_failure_reason = str(e)[:200]
        return out

    # Extract the assistant content
    text = ""
    if isinstance(response, dict):
        choices = response.get("choices") or []
        if choices:
            msg = (choices[0] or {}).get("message") or {}
            text = (msg.get("content") or "").strip()
    if not text:
        out.llm_failed = True
        out.llm_failure_reason = "empty completion"
        return out

    mappings = _parse_llm_response(text)
    if not mappings:
        out.llm_failed = True
        out.llm_failure_reason = "no parseable mappings"
        return out

    # Merge LLM proposals — but only for unmapped pairs. Don't
    # overwrite anything the auto-mapper already produced.
    canon_field_set = set(out.unmapped_canonical)
    src_col_set = set(out.unmapped_source)
    accepted_canonical: set = set()
    accepted_source: set = set()
    for m in mappings:
        if not isinstance(m, dict):
            continue
        src = (m.get("source") or "").strip()
        canon = (m.get("canonical") or "").strip()
        try:
            confidence = float(m.get("confidence", 0.0))
        except (TypeError, ValueError):
            confidence = 0.0
        reasoning = (m.get("reasoning") or "").strip()[:200]
        if not src or not canon:
            continue
        if src not in src_col_set or canon not in canon_field_set:
            continue
        if src in accepted_source or canon in accepted_canonical:
            continue
        out.column_map[src] = canon
        out.confidence_per_field[canon] = round(max(0.0, min(1.0, confidence)), 3)
        out.reasoning_per_field[canon] = reasoning
        accepted_source.add(src)
        accepted_canonical.add(canon)

    # Recompute unmapped after the LLM pass
    out.unmapped_canonical = [
        c for c in out.unmapped_canonical if c not in accepted_canonical
    ]
    out.unmapped_source = [
        s for s in out.unmapped_source if s not in accepted_source
    ]
    return out


def merge_into_mapping_proposal(
    auto: MappingProposal,
    llm: LlmMappingProposal,
) -> Tuple[Dict[str, str], Dict[str, float], Dict[str, str]]:
    """Combine two proposals — auto wins on overlap.

    Used by callers that want one flat view of the merged mapping
    without caring which stage produced each entry.
    """
    column_map = dict(llm.column_map)
    column_map.update(auto.column_map)
    confidence = dict(llm.confidence_per_field)
    confidence.update(auto.confidence_per_field)
    reasoning = dict(llm.reasoning_per_field)
    return column_map, confidence, reasoning
