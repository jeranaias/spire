"""
Per-query context assembly for Gemma 4 calls.

When the LLM is used for cross-module reasoning, natural-language queries, or
contextual disambiguation, this module builds the MINIMAL context payload
that answers the question. We do not "stuff the whole dataset" into every
prompt -- at 512K context that's technically possible, but the latency is
42s at 128K and 66s at 200K per the RigRun measurements. Live demos stay
live only when context stays under ~20K tokens.

Query types implemented:

  pulse_explain       Explain a PULSE risk score in natural language.
                      Context: asset history + fleet baselines for that
                      equipment type. ~3-5K tokens.

  sentry_ambiguous    Tier-2 classification for a low-confidence SENTRY
                      record. Context: the record + surrounding batch
                      summary + classification guide excerpt. ~2-4K tokens.

  bastion_query       Watch-officer asks the COP a question. Context: the
                      installation knowledge base + active alerts + top
                      readiness risks. ~10-15K tokens.

  cross_module        Explore relationships across SENTRY+PULSE+BASTION.
                      Context: aggregated summaries across all three. ~15-20K
                      tokens.

  tmr_parse           Parse a TMR free-text request. Context: TMR schema +
                      movement policy + known installations. ~3K tokens.
"""
from __future__ import annotations

from datetime import timedelta
from statistics import mean
from typing import Any

from .state import CanonicalDataset, get_dataset


# Rough token-budget per query. Used only for documentation / warning.
TOKEN_BUDGET = {
    "pulse_explain": 5_000,
    "sentry_ambiguous": 4_000,
    "bastion_query": 15_000,
    "cross_module": 20_000,
    "tmr_parse": 3_000,
}


def _tokenish(text: str) -> int:
    """Rough token estimator -- 1 token per 4 chars, standard English approx."""
    return max(1, len(text) // 4)


def build_context(query_type: str, params: dict | None = None) -> dict:
    """Returns (messages, metadata). Caller passes messages to the LLM
    client; metadata records what went into the context for auditing."""
    ds = get_dataset()
    params = params or {}

    if query_type == "pulse_explain":
        return _pulse_explain_context(ds, params)
    if query_type == "sentry_ambiguous":
        return _sentry_ambiguous_context(ds, params)
    if query_type == "bastion_query":
        return _bastion_query_context(ds, params)
    if query_type == "cross_module":
        return _cross_module_context(ds, params)
    if query_type == "tmr_parse":
        return _tmr_parse_context(ds, params)
    raise ValueError(f"unknown query_type: {query_type}")


# ---------------------------------------------------------------------------
# Query-type builders
# ---------------------------------------------------------------------------

def _pulse_explain_context(ds: CanonicalDataset, params: dict) -> dict:
    """Context for 'why is this asset's risk score 84?' natural language."""
    asset_id = params.get("asset_id")
    if not asset_id:
        raise ValueError("asset_id required")
    asset = ds.asset(asset_id)
    if not asset:
        raise ValueError(f"asset {asset_id} not found")

    # Compact maintenance history
    history_lines = []
    for sr in sorted([s for s in ds.srs if s.asset_id == asset_id], key=lambda s: s.open_date):
        status = "PMCS" if sr.is_pmcs else f"{sr.condition}/{sr.fault_component}"
        history_lines.append(
            f"{sr.open_date.isoformat()} {sr.sr_number} {status} hours={sr.labor_hours_actual} cost=${sr.parts_cost_actual}"
        )

    # Fleet-average fault rate for this equipment type
    fleet_faults = [
        sr for sr in ds.srs
        if not sr.is_pmcs and sr.equipment_type == asset.equipment_type
    ]
    baseline = f"Fleet total {len(fleet_faults)} CM faults across all {asset.equipment_type} assets."

    system = (
        "You are PULSE, a predictive-maintenance reasoning engine for USMC ground vehicles. "
        "Given an asset's maintenance history and its risk score breakdown, explain the "
        "score in 3-4 sentences using specific evidence from the record. Avoid speculation."
    )
    user = (
        f"Asset: {asset_id} ({asset.equipment_type}, {asset.unit_name})\n"
        f"Current hours: {asset.current_hours:.0f}\n"
        f"Current miles: {asset.current_miles}\n"
        f"Days since last maintenance: {asset.days_since_last_maintenance}\n\n"
        f"Maintenance history ({len(history_lines)} events):\n"
        + "\n".join(history_lines[-30:])  # cap to last 30 events
        + f"\n\nFleet baseline: {baseline}\n"
        + "\nQuestion: "
        + params.get("question", "Explain this asset's risk profile.")
    )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    return {
        "messages": messages,
        "metadata": {
            "query_type": "pulse_explain",
            "asset_id": asset_id,
            "approx_tokens": _tokenish(system + user),
        },
    }


def _sentry_ambiguous_context(ds: CanonicalDataset, params: dict) -> dict:
    """Tier-2 context for a record Tier-1 couldn't classify confidently."""
    record_text = params.get("text", "")
    tier1_flags = params.get("flags", [])
    batch_summary = params.get("batch_summary", "")

    system = (
        "You are SENTRY Tier 2, a contextual classification assistant for USMC logistics data. "
        "Classify a record per DoDM 5200.01 as one of UNCLASSIFIED, CUI, CONFIDENTIAL, or SECRET, "
        "and recommend handling caveats (NOFORN, FVEY, REL TO NATO). Return a JSON object with "
        "{classification, caveats, confidence, reasoning}."
    )
    user = (
        f"Tier-1 regex flags detected: {tier1_flags}\n\n"
        f"Record: \"{record_text}\"\n\n"
        f"Batch context: {batch_summary}\n\n"
        "Classify and explain."
    )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    return {
        "messages": messages,
        "metadata": {
            "query_type": "sentry_ambiguous",
            "approx_tokens": _tokenish(system + user),
        },
    }


def _bastion_query_context(ds: CanonicalDataset, params: dict) -> dict:
    """Watch-officer NL queries against the COP + alert state."""
    question = params.get("question", "")
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None

    # Units + readiness snapshot
    unit_blurbs = []
    from collections import Counter
    last_snaps = [s for s in ds.snapshots if s.snapshot_date == last_day]
    by_unit = {}
    for s in last_snaps:
        by_unit.setdefault(s.unit_name, Counter())[s.readiness_code] += 1
    for u_name, c in by_unit.items():
        total = sum(c.values())
        mc = c.get("MC", 0)
        unit_blurbs.append(
            f"{u_name}: {mc}/{total} MC ({mc/max(total,1):.0%}), "
            f"{c.get('PMC',0)} PMC, {c.get('NMCM',0) + c.get('NMCS',0)} NMC"
        )

    # Recent incidents
    incident_blurbs = []
    for i in ds.incidents[-6:]:
        incident_blurbs.append(
            f"{i.date_time.date().isoformat()} {i.type}/{i.severity} at {i.location_building}: {i.initial_report[:120]}"
        )

    system = (
        "You are BASTION's natural-language interface. A watch officer is asking questions "
        "against the live common operating picture. Answer concisely using ONLY the context provided. "
        "If the question requires data not in context, say so -- do not speculate."
    )
    user = (
        "Fleet readiness (today):\n" + "\n".join(unit_blurbs) + "\n\n"
        "Recent installation incidents:\n" + "\n".join(incident_blurbs) + "\n\n"
        f"Question: {question}"
    )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    return {
        "messages": messages,
        "metadata": {
            "query_type": "bastion_query",
            "approx_tokens": _tokenish(system + user),
        },
    }


def _cross_module_context(ds: CanonicalDataset, params: dict) -> dict:
    """Cross-module correlation: 'what's the relationship between data quality
    issues and readiness drops' type questions."""
    question = params.get("question", "Correlate across modules.")

    from collections import Counter
    # Aggregate one-line summaries from each module
    dq_count = sum(1 for sr in ds.srs if sr.data_quality_flag)
    classification_mix = Counter(sr.detected_classification for sr in ds.srs if not sr.is_pmcs)
    mismarks = sum(
        1 for sr in ds.srs
        if not sr.is_pmcs and sr.source_classification == "UNCLASSIFIED" and sr.detected_classification != "UNCLASSIFIED"
    )
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None
    last = [s for s in ds.snapshots if s.snapshot_date == last_day]
    mc_rate = sum(1 for s in last if s.readiness_code == "MC") / max(len(last), 1)

    system = (
        "You are SPIRE, a cross-module reasoning assistant integrating SENTRY (data sanitization), "
        "PULSE (predictive maintenance), and BASTION (operations). Identify correlations, "
        "patterns, or operational risks across the three modules based on the aggregate context."
    )
    user = (
        f"Module summaries:\n\n"
        f"SENTRY: {sum(1 for sr in ds.srs if not sr.is_pmcs)} CM records, classification mix {dict(classification_mix)}, "
        f"{mismarks} source-vs-detected mismarks, {dq_count} data-quality flagged records.\n\n"
        f"PULSE: Fleet MC rate {mc_rate:.1%}, {len(ds.cannib_events)} cannibalization events across "
        f"{len(ds.units)} units. {sum(1 for s in last if s.readiness_code.startswith('NMC'))} assets currently NMC.\n\n"
        f"BASTION: {len(ds.incidents)} installation incidents over 12 months. "
        f"{sum(1 for i in ds.incidents if i.severity in ('HIGH', 'CRITICAL'))} HIGH/CRITICAL severity.\n\n"
        f"Question: {question}"
    )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    return {
        "messages": messages,
        "metadata": {
            "query_type": "cross_module",
            "approx_tokens": _tokenish(system + user),
        },
    }


def _tmr_parse_context(ds: CanonicalDataset, params: dict) -> dict:
    """Structured TMR parsing. Rule parser handles this today offline;
    this context is used only when the rule parser returns ambiguous results
    and we want LLM-backed structured extraction via JSON mode."""
    text = params.get("text", "")
    schema = {
        "type": "object",
        "properties": {
            "origin": {"type": "string"},
            "destination": {"type": "string"},
            "equipment": {
                "type": "array",
                "items": {"type": "object", "properties": {
                    "type": {"type": "string"}, "quantity": {"type": "integer"},
                }}
            },
            "scheduled_date": {"type": "string"},
            "hazmat": {"type": "boolean"},
            "escort_required": {"type": "boolean"},
            "priority": {"type": "string", "enum": ["ROUTINE", "PRIORITY", "URGENT"]},
        },
    }
    system = (
        "You parse USMC Transportation Movement Request (TMR) free text into structured JSON "
        "following the schema. Extract only what is in the text; use null for unspecified fields."
    )
    user = (
        f"Schema: {schema}\n\nTMR text: \"{text}\"\n\nReturn a JSON object following the schema."
    )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    return {
        "messages": messages,
        "metadata": {
            "query_type": "tmr_parse",
            "approx_tokens": _tokenish(system + user),
        },
    }
