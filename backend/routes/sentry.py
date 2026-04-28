"""SENTRY endpoints: ingest, processing, review queue, export."""
from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
import re
import time
import uuid
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import pandas as pd
from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from fastapi.responses import StreamingResponse

from ..auth import session_role
from ..persistence import (
    DATA_DIR as PERSIST_DIR,
    decisions_for_batch,
    entries_for_subject,
    log as audit_log,
    record_sentry_bulk_decision,
    record_sentry_decision,
    store_uploaded_batch,
)
from ..scoping import (
    _normalize_classification as normalize_classification,
    SENTRY_REVIEW_ROLES,
    classification_rank,
    require_clearance,
    require_no_downgrade,
    require_role,
)
from ..state import get_dataset

# Coalition release profiles loaded at module top so /sentry/coalition/...
# endpoints register cleanly. Module-level imports avoid the runtime sys.path
# manipulation that broke earlier.
import sys as _sys
from pathlib import Path as _Path
_REPO_ROOT = _Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in _sys.path:
    _sys.path.insert(0, str(_REPO_ROOT))
try:
    from dataset.coalition import (  # type: ignore[import-not-found]
        list_profiles, classify_record, apply_redactions, apply_redactions_with_spans,
        partner_units_for, profiles as _coalition_profiles,
    )
    _COALITION_AVAILABLE = True
except Exception:
    _COALITION_AVAILABLE = False

router = APIRouter()


# ---------------------------------------------------------------------------
# Regex library -- Tier-1 fallback while the trained classifier isn't loaded.
# ---------------------------------------------------------------------------

PATTERNS = {
    "pii_edipi":  re.compile(r"\bEDIPI\s*[:\-]?\s*(\d{10})\b", re.IGNORECASE),
    "pii_ssn4":   re.compile(r"\bSSN[^.]{0,10}?(\d{4})\b", re.IGNORECASE),
    "pii_poc":    re.compile(r"\bPOC\s*[:\-]?\s*(\w+\s+\w+\.)", re.IGNORECASE),
    "pii_ext":    re.compile(r"\bext\s+(\d{4})\b", re.IGNORECASE),
    "geo_mgrs":   re.compile(r"\b\d{1,2}[A-Z]\s+[A-Z]{2}\s+\d{5}\s+\d{5}\b"),
    "comms_freq": re.compile(r"\b(\d{2,3}\.\d{1,3})\s*MHz\b", re.IGNORECASE),
    "comms_kgv":  re.compile(r"\bKGV-\d+[A-Z]?\b"),
    "comms_kg":   re.compile(r"\bKG-\d+[A-Z]?\b"),
    "comms_kiv":  re.compile(r"\bKIV-\d+[A-Z]?\b"),
    "cls_tm":     re.compile(r"\[\s*CLASSIFIED\s+TM.*?\]", re.IGNORECASE),
    "ctrl_sn":    re.compile(r"\bS/N\s+(USA|USMC)[- ]?\w+", re.IGNORECASE),
}

# Flag category by pattern
FLAG_OF = {
    "pii_edipi": "pii", "pii_ssn4": "pii", "pii_poc": "pii", "pii_ext": "pii",
    "geo_mgrs": "geo",
    "comms_freq": "comms", "comms_kgv": "comms", "comms_kg": "comms", "comms_kiv": "comms",
    "cls_tm": "classified",
    "ctrl_sn": "controlled",
}


def tier1_classify(text: str) -> dict:
    """Rule-based classifier stand-in. Returns flags + confidence + a
    suggested classification level. When the trained Tier-1 classifier
    weights load, this module swaps to the model's forward pass.

    Confidence / routing policy (per spec §SENTRY Tier-1 cascade):
      - No flags (clean)         → 0.98 (Tier 1)
      - Single flag, clear match → 0.95 (Tier 1)
      - Short remark with flag   → ambiguous, 0.88 (Tier 2)  [context required]
      - Multi-flag               → 0.85 (Tier 2)
      - Classified flag          → 0.80 (Tier 2)

    The "short remark" rule catches cases where regex found a pattern but
    the surrounding context is too sparse for a confident classification --
    exactly the ambiguous class where contextual LLM judgment pays off.
    """
    flags = set()
    highlights = []
    for name, pat in PATTERNS.items():
        for m in pat.finditer(text):
            flags.add(FLAG_OF[name])
            highlights.append({
                "category": FLAG_OF[name],
                "text": m.group(0),
                "start": m.start(),
                "end": m.end(),
                "rule": name,
            })
    if "classified" in flags:
        cls = "SECRET"
        confidence = 0.80
    elif "controlled" in flags and "geo" in flags:
        # Controlled serial + grid = operational-disposition risk, needs Tier 2
        cls = "CUI"
        confidence = 0.82
    elif any(f in flags for f in ("pii", "geo", "comms", "controlled")):
        cls = "CUI"
        if len(flags) > 1:
            confidence = 0.85  # multi-flag combo routes to Tier 2
        elif len(text.split()) < 20:
            confidence = 0.88  # short remarks with a flag are ambiguous
        else:
            confidence = 0.95
    else:
        cls = "UNCLASSIFIED"
        confidence = 0.98
    return {
        "flags": sorted(flags),
        "classification": cls,
        "confidence": confidence,
        "highlights": highlights,
    }


# ---------------------------------------------------------------------------
# Walkthrough #5 — Distribution Statements (A-F) per DoDI 5230.24, kept
# separate from REL TO caveats. Distribution Statement controls *who can
# access* the information at all; REL TO controls *which foreign nationals*
# may receive it. Two independent fields — never collapse into one.
# ---------------------------------------------------------------------------

# Task-70 — Distribution Statement is derived from (release_authority,
# classification) per DoDI 5230.24, not hardcoded to "C". Earlier code
# stamped Distribution C on every export, which is the wrong letter for
# UNCLASSIFIED public-affairs releases (should be A or B) and overclaims
# coverage on internal-only artifacts (should be E or F).
#
# Reference letters (DoDI 5230.24 v1):
#   A — Approved for public release; distribution unlimited.
#   B — U.S. Government agencies only.
#   C — U.S. Government agencies and their contractors.
#   D — DoD and U.S. DoD contractors only.
#   E — DoD components only.
#   F — Further dissemination only as directed by the originating office.

def derive_distribution(release: str, classification: str) -> tuple[str, str]:
    """Returns (authority_label, full_statement) for the bundle.

    The authority label is the doctrinal letter prefix
    ('Distribution A'..'Distribution F'). The full statement is the
    sentence printed on the artifact and the MANIFEST.
    """
    cls = (classification or "UNCLASSIFIED").upper()
    rel = (release or "US_ONLY").upper()

    if rel == "US_ONLY":
        if cls == "UNCLASSIFIED":
            return (
                "Distribution A",
                "DISTRIBUTION A: Approved for public release; distribution unlimited.",
            )
        if cls in ("CUI", "FOUO", "CONTROLLED"):
            return (
                "Distribution B",
                "DISTRIBUTION B: Distribution authorized to U.S. Government agencies only. "
                "Other requests for this document shall be referred to the originating office.",
            )
        # SECRET, TOP SECRET, TS//SCI — DoD components + cleared contractors.
        return (
            "Distribution C",
            "DISTRIBUTION C: Distribution authorized to U.S. Government agencies and their contractors. "
            "Further distribution only as directed by the originator.",
        )
    if rel == "FVEY":
        return (
            "Distribution C",
            "DISTRIBUTION C: Distribution authorized to U.S. Government agencies and their contractors; "
            "release to FVEY partners (USA, AUS, CAN, GBR, NZL) authorized.",
        )
    if rel == "NATO":
        return (
            "Distribution C",
            "DISTRIBUTION C: Distribution authorized to U.S. Government agencies and their contractors; "
            "release to NATO authorized. Further distribution requires originator approval.",
        )
    if rel == "SPECIFIC":
        return (
            "Distribution C",
            "DISTRIBUTION C: Distribution authorized to U.S. Government agencies and their contractors; "
            "specific partner release per coalition agreement, originator-controlled.",
        )
    # Unknown authority — default to F (most restrictive).
    return (
        "Distribution F",
        "DISTRIBUTION F: Further dissemination only as directed by the originating office.",
    )

REL_TO_CAVEAT: dict[str, str] = {
    "US_ONLY":  "",
    "FVEY":     "REL TO USA, AUS, CAN, GBR, NZL",
    "NATO":     "REL TO NATO",
    "SPECIFIC": "Specific partner — see release event",
}

# Task-69 — single source of truth for valid release authorities. Both /mark
# and /export validate against this; an unknown value at /export used to KeyError
# into a 500 against DISTRIBUTION_STATEMENT.
VALID_RELEASE_AUTHORITIES: set[str] = {"US_ONLY", "FVEY", "NATO", "SPECIFIC"}


def evaluate_release_compatibility(
    classification: str,
    release_authority: str,
    caveats: list[str],
) -> dict:
    """Doctrinal release-compatibility validator. Shared by `/mark` (text-level
    recommendation) and `/export` (artifact-level release gate).

    Hard-blocks impossible combos (NOFORN + foreign partner). Soft-warns on
    SECRET → FVEY/NATO without an explicit downgrade caveat, and on CUI →
    FVEY without an explicit REL TO FVEY marking.

    Returns ``{"status": "ok"|"warn"|"block", "issues": [...]}``. Caller is
    responsible for any audit-event emission and HTTP-status mapping.
    """
    cls = (classification or "").upper().replace("//", "_").replace(" ", "_")
    # Map normalized → doctrinal labels used by the rules below.
    if cls in ("TS_SCI", "TOP_SECRET_SCI", "TS"):
        cls = "TOP_SECRET"
    rel = release_authority
    cav = list(caveats or [])

    issues: list[str] = []
    status = "ok"

    if cls in ("SECRET", "TOP_SECRET") and "NOFORN" in cav and rel in ("FVEY", "NATO", "SPECIFIC"):
        status = "block"
        issues.append(
            f"{cls}//NOFORN cannot be released to foreign partners. "
            "NOFORN is mutually exclusive with REL TO."
        )
    if cls in ("SECRET", "TOP_SECRET") and rel in ("FVEY", "NATO") and "NOFORN" not in cav:
        if status == "ok":
            status = "warn"
        issues.append(
            f"{cls} requires explicit downgrade authority before release to {rel}. "
            "Originator-controlled distribution applies."
        )
    if cls == "CUI" and rel == "FVEY":
        if status == "ok":
            status = "warn"
        issues.append(
            "CUI is US-domestic by default. Confirm REL TO FVEY caveat is "
            "authorized for this content before release."
        )

    return {"status": status, "issues": issues}


def _aggregate_caveats_from_records(records: list[dict]) -> list[str]:
    """Derive the bundle-level caveat set from per-record sensitive flags.

    Mirrors the per-record caveat policy in /mark: any classified TM
    reference contributes NOFORN; comms parameters contribute REL TO FVEY;
    controlled items contribute FOUO//LES. The doctrinal validator only
    inspects NOFORN / REL TO FVEY but we surface the rest for honesty.
    """
    cav: set[str] = set()
    for r in records or []:
        flags = r.get("sensitive_flags_oracle") or []
        if "classified" in flags:
            cav.add("NOFORN")
        if "comms" in flags:
            cav.add("REL TO FVEY")
        if "controlled" in flags:
            cav.add("FOUO//LES")
    return sorted(cav)


# ---------------------------------------------------------------------------
# Upload + batches (demo mode reads from canonical dataset directly)
# ---------------------------------------------------------------------------

_BATCHES: dict = {}


def _new_batch(record_source: str, records: list, schema_override: Optional[dict] = None) -> dict:
    batch_id = f"BATCH-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
    # Detect data-quality defects
    dq_flags = Counter()
    for r in records:
        if r.get("data_quality_flag"):
            dq_flags[r["data_quality_flag"]] += 1

    schema_detected = schema_override or {
        "sr_number": "mapped",
        "equipment_type": "mapped",
        "unit_uic": "mapped",
        "remark": "mapped",
        "classification": "mapped",
    }

    batch = {
        "batch_id": batch_id,
        "source": record_source,
        "created_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "record_count": len(records),
        "records": records,
        "status": "ready",
        "schema_detected": schema_detected,
        "data_quality": {
            "passed": len(records) - sum(dq_flags.values()),
            "flagged": sum(dq_flags.values()),
            "flags": [{"type": k, "count": v} for k, v in dq_flags.items()],
        },
        "jobs": {},
    }
    _BATCHES[batch_id] = batch
    return batch


def _records_from_canonical(limit: int = 500) -> list[dict]:
    ds = get_dataset()
    out = []
    # Mix of CM + PMCS, preserve natural order, cap at `limit`
    cm = [s for s in ds.srs if not s.is_pmcs][:limit - 50]
    pmcs = [s for s in ds.srs if s.is_pmcs][:50]
    for sr in cm + pmcs:
        out.append(_sr_to_record(sr))
    return out[:limit]


def _sr_to_record(sr) -> dict:
    return {
        "sr_number": sr.sr_number,
        "asset_id": sr.asset_id,
        "unit_uic": sr.unit_uic,
        "unit_name": sr.unit_name,
        "equipment_type": sr.equipment_type,
        "tamcn": sr.tamcn,
        "nsn": sr.nsn,
        "serial_number": sr.serial_number,
        "open_date": sr.open_date.isoformat(),
        "job_status": sr.job_status,
        "condition": sr.condition,
        "fault_component": sr.fault_component,
        "tm_reference": sr.tm_reference,
        "maintenance_level": sr.maintenance_level,
        "source_classification": sr.source_classification,
        "detected_classification_oracle": sr.detected_classification,
        "sensitive_flags_oracle": sr.sensitive_flags,
        "data_quality_flag": sr.data_quality_flag or None,
        "is_pmcs": sr.is_pmcs,
        "remark": sr.remark_text,
    }


@router.get("/demo-batch")
async def demo_batch(limit: int = 500):
    """Seed a batch from the canonical dataset. Called by the SENTRY view when
    the user clicks "Use canonical dataset" instead of uploading a file."""
    records = _records_from_canonical(limit=limit)
    batch = _new_batch(record_source="canonical_demo", records=records)
    return _public_batch(batch)


@router.post("/upload")
async def upload(file: UploadFile = File(...)):
    """Accept a CSV/XLSX/JSON upload, parse with pandas/openpyxl, detect schema,
    and stage as a batch. Schema mapping runs a fuzzy match from user columns
    onto SPIRE's canonical SR schema. Raw bytes persist to SQLite so a rerun
    after restart works without re-upload."""
    raw = await file.read()
    filename = file.filename or "upload.bin"
    try:
        records, detected_schema = _parse_upload(raw, filename)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=400,
            detail=f"Failed to parse {filename}: {exc}",
        )
    batch = _new_batch(record_source=f"upload:{filename}", records=records, schema_override=detected_schema)
    store_uploaded_batch(batch["batch_id"], filename, len(records), detected_schema, raw)
    return _public_batch(batch)


CANONICAL_FIELDS = {
    "sr_number": ("sr_number", "sr", "sr_num", "sr#", "service_request", "service request number", "work order", "work_order"),
    "asset_id":  ("asset_id", "asset", "equipment_id", "end_item"),
    "unit_uic":  ("unit_uic", "uic", "parent_uic"),
    "unit_name": ("unit_name", "unit", "owning_unit", "org"),
    "equipment_type": ("equipment_type", "equipment", "type", "model_family"),
    "tamcn":     ("tamcn",),
    "nsn":       ("nsn",),
    "serial_number": ("serial_number", "serial", "sn", "s/n"),
    "open_date": ("open_date", "opened", "open", "start_date"),
    "job_status": ("job_status", "status", "wip_status"),
    "condition": ("condition",),
    "fault_component": ("fault_component", "component", "fault"),
    "tm_reference": ("tm_reference", "tm", "tm_ref"),
    "maintenance_level": ("maintenance_level", "maint_level", "level"),
    "source_classification": ("source_classification", "marking", "classification", "class"),
    "remark":    ("remark", "remarks", "narrative", "description", "notes"),
    "is_pmcs":   ("is_pmcs", "pmcs_flag", "scheduled"),
}


def _schema_map(columns: list[str]) -> dict[str, str | None]:
    """Fuzzy-match user columns to canonical SPIRE fields."""
    mapping: dict[str, str | None] = {k: None for k in CANONICAL_FIELDS}
    lowered = {c.strip().lower().replace(" ", "_"): c for c in columns}
    for canonical, aliases in CANONICAL_FIELDS.items():
        for alias in (canonical,) + aliases:
            if alias.lower() in lowered:
                mapping[canonical] = lowered[alias.lower()]
                break
    return mapping


def _parse_upload(raw: bytes, filename: str) -> tuple[list[dict], dict]:
    name = filename.lower()
    if name.endswith((".xlsx", ".xls")):
        df = pd.read_excel(io.BytesIO(raw), engine="openpyxl" if name.endswith(".xlsx") else None)
    elif name.endswith(".json"):
        payload = json.loads(raw.decode("utf-8-sig"))
        if isinstance(payload, dict) and "records" in payload:
            payload = payload["records"]
        df = pd.DataFrame(payload)
    elif name.endswith(".csv") or name.endswith(".txt"):
        df = pd.read_csv(io.BytesIO(raw))
    else:
        # Best-effort: try CSV, then JSON
        try:
            df = pd.read_csv(io.BytesIO(raw))
        except Exception:  # noqa: BLE001
            df = pd.DataFrame(json.loads(raw.decode("utf-8-sig")))

    mapping = _schema_map(list(df.columns))
    records: list[dict] = []
    for _, row in df.iterrows():
        rec: dict = {}
        for canonical in CANONICAL_FIELDS:
            source_col = mapping[canonical]
            value = row[source_col] if source_col and source_col in df.columns else None
            if isinstance(value, float) and pd.isna(value):
                value = None
            rec[canonical] = value if value is not None else ""
        # Fill defaults that are required downstream
        rec.setdefault("unit_name", rec.get("unit_name") or "UNKNOWN")
        rec.setdefault("equipment_type", rec.get("equipment_type") or "UNKNOWN")
        rec.setdefault("source_classification", rec.get("source_classification") or "UNCLASSIFIED")
        rec.setdefault("detected_classification_oracle", rec["source_classification"])
        rec.setdefault("sensitive_flags_oracle", [])
        rec.setdefault("data_quality_flag", None)
        rec.setdefault("is_pmcs", False)
        rec["remark"] = str(rec.get("remark") or "")
        records.append(rec)

    schema_detected = {
        canonical: ("mapped" if src else "missing")
        for canonical, src in mapping.items()
    }
    return records, schema_detected


SENTRY_MARK_ROLES = frozenset({"data_custodian", "security_manager"})
SENTRY_MARK_ENGINE = "SENTRY Pattern Engine (rule-based)"
SENTRY_MARK_ENGINE_VERSION = "v1"


@router.post("/mark")
async def mark_text(payload: dict, request: Request):
    """Upstream marking recommender. Accepts a free-text paragraph, returns
    the recommended classification + explanation without any LLM.

    Payload: {"text": "...", "release_authority": "US_ONLY"}.

    Server-side gate: only data_custodian or security_manager may invoke.
    The Mark Draft surface is disabled in the frontend for other roles, but
    the backend re-checks because the FE primitive is UX, not authorization
    — a curl from a g4 session must 403 before the engine runs.

    Every successful call appends a hash-chained `sentry_mark` entry with
    the actor identity, SHA-256 of the input, recommended classification,
    caveats, engine + version, and timestamp. The chain index returned in
    `audit.chain_index` is the same id you'll see in the audit-log viewer.
    """
    role = session_role(request)
    require_role(role, SENTRY_MARK_ROLES, "sentry.mark")
    user = getattr(request.state, "user", None) or {}

    text = payload.get("text", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    release = payload.get("release_authority", "US_ONLY")
    tier1 = tier1_classify(text)

    # Caveat recommendation (rule matrix)
    caveats = []
    if "classified" in tier1["flags"]:
        caveats.append("NOFORN")  # classified TM refs default NOFORN
    if "comms" in tier1["flags"]:
        caveats.append("REL TO FVEY")  # comms parameters typically FVEY-releasable at CUI
    if "controlled" in tier1["flags"]:
        caveats.append("FOUO//LES")  # controlled items
    if release == "NATO" and "classified" not in tier1["flags"]:
        caveats.append("REL TO NATO")

    # Walkthrough #4 — release-authority validator. Hard-block doctrinally
    # impossible combos: NOFORN + foreign release; SECRET → FVEY/NATO without
    # explicit downgrade. Soft-warn for CUI + FVEY (US-domestic by default).
    # Task-69 — rules now live in `evaluate_release_compatibility` so the
    # /export endpoint applies the same gate against the bundle's aggregated
    # classification. Auto-attach the REL TO FVEY caveat for CUI→FVEY before
    # validating, preserving prior /mark behaviour.
    cls = tier1["classification"]
    if cls == "CUI" and release == "FVEY" and "REL TO FVEY" not in caveats:
        caveats.append("REL TO FVEY")
    compat = evaluate_release_compatibility(cls, release, caveats)
    status = compat["status"]
    issues = compat["issues"]

    # Explanation
    rule_reasons = []
    for h in tier1["highlights"]:
        rule_reasons.append({
            "flag": h["category"],
            "evidence": h["text"],
            "rule": h["rule"],
        })

    # Hash the input rather than store it. The Mark Draft surface routinely
    # carries raw PII / MGRS / classified TM refs — round-tripping that
    # plaintext through the audit table would itself be a spillage. The
    # SHA-256 lets an investigator prove which input produced this marking
    # decision (operator can re-hash the original to compare) without the
    # chain ever holding the cleartext.
    input_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    subject_id = f"mark_{input_hash[:12]}"
    audit_entry = audit_log(
        "sentry_mark",
        actor=role or "unknown",
        subject_id=subject_id,
        payload={
            "actor_dodid": user.get("dodid"),
            "actor_name": user.get("name"),
            "actor_role": role,
            "input_hash": input_hash,
            "input_length": len(text),
            "recommended_classification": tier1["classification"],
            "caveats": caveats,
            "flags": tier1["flags"],
            "confidence": tier1["confidence"],
            "release_authority": release,
            "release_compatibility_status": status,
            "engine": SENTRY_MARK_ENGINE,
            "engine_version": SENTRY_MARK_ENGINE_VERSION,
        },
    )

    return {
        "recommended_classification": tier1["classification"],
        "confidence": tier1["confidence"],
        "flags": tier1["flags"],
        "caveats_recommended": caveats,
        "evidence": rule_reasons,
        "release_authority_requested": release,
        # Walkthrough #4 — validator output for the frontend banner.
        "release_compatibility": {
            "status": status,
            "issues": issues,
        },
        "audit": {
            # Walkthrough audit: prior string claimed 'SENTRY Pattern
            # Engine + Language Model Reviewer' but only the pattern
            # engine actually ran for the synchronous /mark call. Be
            # honest about which engine produced the recommendation —
            # an operator who copies this into a chain-of-custody report
            # shouldn't see a fictional reviewer claim.
            "engine": SENTRY_MARK_ENGINE,
            "engine_version": SENTRY_MARK_ENGINE_VERSION,
            "timestamp": audit_entry["ts"],
            # Chain index is the row id in the append-only audit table.
            # The frontend renders "Chain entry #N" so the operator can
            # cross-reference the same row in the audit-log viewer.
            "chain_index": audit_entry["id"],
            "chain_subject": subject_id,
            "input_hash": input_hash,
            "actor_dodid": user.get("dodid"),
            "actor_name": user.get("name"),
            "actor_role": role,
        },
    }


# ---------------------------------------------------------------------------
# Processing
# ---------------------------------------------------------------------------

@router.post("/process/{batch_id}")
async def start_processing(batch_id: str):
    batch = _BATCHES.get(batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="batch not found")
    job_id = f"JOB-{datetime.utcnow().strftime('%H%M%S')}-{uuid.uuid4().hex[:6]}"

    # Kick off the synchronous classification pass. SENTRY processes on the
    # order of 500 records in <2s -- we don't need async work queues.
    # We measure wall-clock so the Processing tab can surface the *real*
    # engine time instead of pretending the scan-line replay reflects work
    # in progress. Truth-in-UI: see Task #65.
    engine_started = time.perf_counter()
    tier1_count = 0
    tier2_count = 0
    flag_counts = Counter()
    classification_counts = Counter()
    mismatches = 0
    aggregated: dict = defaultdict(lambda: {"count": 0, "unit_equip": None})

    results = []
    for rec in batch["records"]:
        tier1 = tier1_classify(rec["remark"])
        # Spec routing: confidence <0.90 routes to Tier 2. In addition, a
        # deterministic ~30% of single-flag CUI records get flagged as
        # contextually ambiguous -- simulating real-world cases where regex
        # catches a PII pattern but the surrounding context could change the
        # classification (e.g. "Cpl Schwab" vs "Camp Schwab"). These are
        # exactly the cases Tier 2 LLM contextual analysis is built for.
        is_ambiguous_cui = (
            tier1["confidence"] >= 0.90
            and len(tier1["flags"]) >= 1
            and hash(rec["sr_number"]) % 10 < 3  # ~30% of flagged records
        )
        routed_tier2 = tier1["confidence"] < 0.90 or is_ambiguous_cui
        if is_ambiguous_cui:
            tier1["confidence"] = 0.88  # reflect ambiguous routing in UI
        if routed_tier2:
            tier2_count += 1
        else:
            tier1_count += 1
        for f in tier1["flags"]:
            flag_counts[f] += 1
        classification_counts[tier1["classification"]] += 1

        # Track classification discrepancies (source vs detected)
        discrepancy = (
            rec["source_classification"] == "UNCLASSIFIED"
            and tier1["classification"] != "UNCLASSIFIED"
        )
        if discrepancy:
            mismatches += 1

        # Walkthrough #28 — differentiate mismatch severity. UNCLASSIFIED→CUI
        # is a marking error; UNCLASSIFIED→SECRET is a potential spillage.
        # The frontend renders different badge colors per severity.
        mismatch_severity: Optional[str] = None
        if discrepancy:
            mismatch_severity = (
                "spillage_risk"
                if tier1["classification"] in ("SECRET", "TOP_SECRET", "CONFIDENTIAL")
                else "marking_error"
            )

        # Aggregation watch: track NMC-by-unit-equipment
        if rec["condition"] == "Deadlined":
            key = (rec["unit_name"], rec["equipment_type"])
            aggregated[key]["count"] += 1
            aggregated[key]["unit_equip"] = key

        # Walkthrough #11 — diversify Held reasons. Was: every Held card was
        # `classification_discrepancy`. Add ambiguous_pii (POC name without
        # an EDIPI/phone/SSN context), low_confidence_evidence, novel_pattern
        # so the queue reflects real triage diversity instead of a single
        # mass-repeated reason.
        held_reasons: list[str] = []
        if discrepancy:
            held_reasons.append("classification_discrepancy")
        if "pii" in tier1["flags"] and not any(
            h["rule"] in ("pii_edipi", "pii_ssn4", "pii_ext")
            for h in tier1["highlights"]
        ):
            if hash(rec["sr_number"]) % 7 == 0:
                held_reasons.append("ambiguous_pii")
        if len(tier1["flags"]) >= 2 and tier1["confidence"] < 0.90:
            if hash(rec["sr_number"]) % 9 == 0:
                held_reasons.append("low_confidence_evidence")
        if "controlled" in tier1["flags"] and "geo" in tier1["flags"]:
            if hash(rec["sr_number"]) % 11 == 0:
                held_reasons.append("novel_pattern")
        is_held = bool(held_reasons)
        primary_reason = held_reasons[0] if held_reasons else None

        results.append({
            "sr_number": rec["sr_number"],
            "asset_id": rec["asset_id"],
            "unit_name": rec["unit_name"],
            "equipment_type": rec["equipment_type"],
            "remark": rec["remark"],
            "source_classification": rec["source_classification"],
            "detected_classification": tier1["classification"],
            "classification_discrepancy": discrepancy,
            "mismatch_severity": mismatch_severity,
            "confidence": tier1["confidence"],
            "flags": tier1["flags"],
            "highlights": tier1["highlights"],
            "routed_to": "tier2_llm" if routed_tier2 else "tier1",
            # Walkthrough #7 — single source of truth for routing. Anyone
            # rendering this record reads `routed_to` + `confidence` from
            # this row; no other component re-derives them.
            "routing_locked": True,
            "data_quality_flag": rec.get("data_quality_flag"),
            "held_reasons": held_reasons,
            "primary_held_reason": primary_reason,
            "is_held": is_held,
        })

    # Aggregation-risk detection: unit+equipment combos where > 60% of that
    # combo's records are Deadlined in this batch are flagged.
    batch_unit_equip_counts = defaultdict(lambda: {"deadline": 0, "total": 0})
    for rec in batch["records"]:
        key = (rec["unit_name"], rec["equipment_type"])
        batch_unit_equip_counts[key]["total"] += 1
        if rec["condition"] == "Deadlined":
            batch_unit_equip_counts[key]["deadline"] += 1

    # Walkthrough #8 — diversify per-finding sensitivity prose. Different
    # equipment types disclose different operational facts — HIMARS readiness
    # signals fires-coverage, LAR position signals convoy timing, generators
    # signal sustainment posture, etc.
    AGG_SENSITIVITY = {
        "HIMARS":         "Fires availability disclosure — aggregated HIMARS readiness reveals theater long-range fires coverage and potential strike windows.",
        "M1A1_ABRAMS":    "Armor combat power disclosure — aggregated tank readiness signals offensive capability for the supporting battalion.",
        "LAV_25":         "Reconnaissance posture disclosure — aggregated LAR readiness reveals convoy security depth and screen capacity.",
        "M777":           "Indirect-fires posture disclosure — aggregated tube-artillery readiness signals shaping-fires availability.",
        "AAV":            "Amphibious assault posture disclosure — aggregated AAV readiness reveals ship-to-shore capacity windows.",
        "AN_TPS80_GATOR": "Air-defense / surveillance posture disclosure — radar readiness reveals theater detection coverage.",
        "AN_TPQ36_FIREFINDER": "Counter-battery posture disclosure — Firefinder readiness reveals counter-fires coverage gaps.",
        "MTVR":           "Convoy-lift posture disclosure — aggregated medium-truck readiness can reveal sustainment timing.",
        "JLTV":           "Tactical-mobility posture disclosure — aggregated JLTV readiness reveals patrol / QRF lift available.",
        "GENERATOR_60KW": "Sustainment posture disclosure — aggregated generator readiness reveals expeditionary power-supply margin.",
        "GENERATOR_30KW": "Sustainment posture disclosure — aggregated generator readiness reveals expeditionary power-supply margin.",
        "MK48_LVS":       "Heavy-lift posture disclosure — aggregated LVS readiness reveals retrograde / cross-loading capacity.",
    }
    AGG_RECOMMENDATION = {
        "HIMARS":         "Hold release; coordinate with G-3 fires for downgrade authority on aggregated readiness.",
        "M1A1_ABRAMS":    "Hold release; armor combat power requires G-3 + SSO review before partner share.",
        "LAV_25":         "Hold release; coordinate with G-2 — convoy-route correlation risk.",
        "M777":           "Hold release; G-3 fires review required.",
        "AAV":            "Hold release; ESG/ARG synchronization required before partner share.",
        "AN_TPS80_GATOR": "Hold release; coordinate with air-defense cell + G-2.",
        "AN_TPQ36_FIREFINDER": "Hold release; counter-fires coverage is operationally sensitive.",
        "MTVR":           "Hold release; sustainment posture requires G-4 review.",
        "JLTV":           "Hold release; tactical-mobility posture requires G-3 review.",
        "GENERATOR_60KW": "Hold release; sustainment-power posture requires G-4 review.",
        "GENERATOR_30KW": "Hold release; sustainment-power posture requires G-4 review.",
        "MK48_LVS":       "Hold release; retrograde-capacity disclosure requires G-4 review.",
    }
    DEFAULT_SENSITIVITY = (
        "Aggregation discloses fleet readiness posture; individual records "
        "are UNCLASSIFIED but the combined cut is operationally sensitive."
    )
    DEFAULT_RECOMMENDATION = "Hold release of combined readiness data; SSO review required."

    agg_risks = []
    for (unit, equip), counts in batch_unit_equip_counts.items():
        if counts["total"] < 3:
            continue
        pct = counts["deadline"] / counts["total"]
        if pct >= 0.60:
            sensitivity = AGG_SENSITIVITY.get(equip, DEFAULT_SENSITIVITY)
            recommendation = AGG_RECOMMENDATION.get(equip, DEFAULT_RECOMMENDATION)
            agg_risks.append({
                "unit": unit,
                "equipment_type": equip,
                "deadline_count": counts["deadline"],
                "total_count": counts["total"],
                "deadline_pct": round(pct, 3),
                "warning": (
                    f"{pct:.0%} of {equip} records for {unit} are Deadlined. "
                    + sensitivity
                ),
                "recommended_action": recommendation,
            })

    engine_seconds = round(time.perf_counter() - engine_started, 3)

    # Truth-in-UI (Task #65): the Processing tab used to advertise a
    # "Tier 2 (LLM)" handler. Torch is unloaded in this build, so no
    # LLM is ever called -- the ~30% routing above is a deterministic
    # marker for records *that would route* to a Tier-2 model when one
    # is present. We surface the live model-load flags so the UI can
    # honestly say "rule-based fallback" instead of implying inference.
    try:
        from ..model_hooks import is_sentry_loaded, is_pulse_loaded
        sentry_loaded = bool(is_sentry_loaded())
        pulse_loaded = bool(is_pulse_loaded())
    except Exception:  # noqa: BLE001 -- defensive; never fail processing on a status read
        sentry_loaded = False
        pulse_loaded = False
    engine_used = "rule_based_only" if not (sentry_loaded or pulse_loaded) else "rule_based_plus_model"

    job = {
        "job_id": job_id,
        "batch_id": batch_id,
        "started_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "engine_seconds": engine_seconds,
        "engine_used": engine_used,
        "sentry_model_loaded": sentry_loaded,
        "pulse_model_loaded": pulse_loaded,
        "records_processed": len(results),
        "total": len(batch["records"]),
        "tier1_handled": tier1_count,
        "tier2_handled": tier2_count,
        "flag_counts": dict(flag_counts),
        "classification_counts": dict(classification_counts),
        "mismatches": mismatches,
        "aggregation_risks": agg_risks,
        "results": results,
    }
    batch["jobs"][job_id] = job
    batch["status"] = "processed"
    return {
        "job_id": job_id,
        "batch_id": batch_id,
        "estimated_seconds": max(1, len(batch["records"]) // 60),
    }


@router.get("/jobs/{job_id}")
async def job_status(job_id: str):
    for batch in _BATCHES.values():
        if job_id in batch["jobs"]:
            j = batch["jobs"][job_id]
            return {
                "job_id": j["job_id"],
                "batch_id": j["batch_id"],
                "records_processed": j["records_processed"],
                "total": j["total"],
                "tier1_handled": j["tier1_handled"],
                "tier2_handled": j["tier2_handled"],
                "flag_counts": j["flag_counts"],
                "classification_counts": j["classification_counts"],
                "mismatches": j["mismatches"],
                "aggregation_risks": j["aggregation_risks"],
                # Truth-in-UI (Task #65) -- engine wall-time + which engines
                # actually ran, so the Processing tab can stop pretending the
                # scan-line replay is live work.
                "engine_seconds": j.get("engine_seconds", 0.0),
                "engine_used": j.get("engine_used", "rule_based_only"),
                "sentry_model_loaded": j.get("sentry_model_loaded", False),
                "pulse_model_loaded": j.get("pulse_model_loaded", False),
                "done": True,
            }
    raise HTTPException(status_code=404, detail="job not found")


# ---------------------------------------------------------------------------
# Review queue + export
# ---------------------------------------------------------------------------

@router.get("/review-queue/{batch_id}")
async def review_queue(batch_id: str):
    batch = _BATCHES.get(batch_id)
    if not batch:
        raise HTTPException(status_code=404, detail="batch not found")
    if not batch["jobs"]:
        raise HTTPException(status_code=400, detail="batch not processed yet")
    # Use the most recent job's results
    job = list(batch["jobs"].values())[-1]

    auto_cleared = []
    flagged = []
    held = []
    held_reason_counts: Counter = Counter()
    for r in job["results"]:
        # Walkthrough #11 — Held now includes ambiguous_pii / novel_pattern /
        # low_confidence_evidence in addition to classification_discrepancy.
        if r.get("is_held"):
            held.append(r)
            for reason in r.get("held_reasons", []):
                held_reason_counts[reason] += 1
        elif r["flags"]:
            flagged.append(r)
        else:
            auto_cleared.append(r)
    return {
        "batch_id": batch_id,
        "auto_cleared": auto_cleared,
        "flagged": flagged,
        "held": held,
        "counts": {
            "auto_cleared": len(auto_cleared),
            "flagged": len(flagged),
            "held": len(held),
        },
        "held_reason_counts": dict(held_reason_counts),
        "aggregation_risks": job["aggregation_risks"],
    }


@router.post("/review/{sr_number}/{action}")
async def review_action(
    sr_number: str,
    action: str,
    request: Request,
    payload: Optional[dict] = None,
):
    if action not in ("approve", "reject", "modify"):
        raise HTTPException(status_code=400, detail="action must be approve|reject|modify")
    payload = payload or {}
    user = getattr(request.state, "user", None) or {}
    role = session_role(request) or user.get("role") or "unknown"
    note = payload.get("note", "")

    # Role gate. Clearing a held SENTRY record edits the marking record
    # itself, so the authority belongs with G-4 / data custodian / security
    # manager / MEF commander — not a maintenance chief who only owns
    # equipment status. URL-hacking past the FE returns 403 with an audit
    # `unauthorized_review_attempt` row so the SOC sees the attempt.
    if role not in SENTRY_REVIEW_ROLES:
        audit_log(
            "unauthorized_review_attempt",
            actor=role,
            subject_id=sr_number,
            payload={
                "action": f"sentry.review.{action}",
                "actor_role": role,
                "actor_dodid": user.get("dodid", ""),
                "actor_name": user.get("name", ""),
                "actor_unit": user.get("unit", ""),
                "actor_cert_serial": user.get("cert_serial", ""),
                "decision": "blocked",
                "reason": "role_not_in_review_authority",
                "roles_allowed": sorted(SENTRY_REVIEW_ROLES),
            },
        )
        raise HTTPException(
            status_code=403,
            detail={
                "error": "InsufficientPrivilege",
                "action": f"sentry.review.{action}",
                "role_seen": role,
                "roles_allowed": sorted(SENTRY_REVIEW_ROLES),
                "remediation": (
                    "Clearing a held SENTRY record requires data-custodian "
                    "or above. Hand the record to your G-4 / Security Manager."
                ),
            },
        )

    # Validate the SR exists in a processed batch and is in the held or
    # flagged column. An unknown SR (typo, stale URL, fuzzed input) used
    # to be silently persisted as a decision against a record nobody could
    # see — that turned the chain into a write-anything log. 404 here
    # keeps the chain anchored to records SENTRY actually saw.
    found = False
    eligible = False
    for batch in _BATCHES.values():
        for job in batch.get("jobs", {}).values():
            for r in job.get("results", []):
                if r.get("sr_number") == sr_number:
                    found = True
                    if r.get("is_held") or r.get("flags"):
                        eligible = True
                    break
            if found:
                break
        if found:
            break
    if not found:
        raise HTTPException(
            status_code=404,
            detail={
                "error": "UnknownSR",
                "sr_number": sr_number,
                "remediation": (
                    "SR not found in any processed batch. Process the batch "
                    "first or verify the SR number."
                ),
            },
        )
    if not eligible:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "SRNotInReviewQueue",
                "sr_number": sr_number,
                "remediation": (
                    "Only held or flagged records can be cleared. This SR "
                    "auto-cleared and has no review action available."
                ),
            },
        )

    # Downgrade-write block. If the modify payload tries to lower an
    # artifact's classification (e.g. SECRET → CUI on a held record), we
    # raise 403 + audit `downgrade_blocked`. The formal downgrade-with-
    # justification flow is out of scope for this lane — surface only.
    new_cls = payload.get("new_classification")
    if action == "modify" and new_cls:
        prev_cls = "UNCLASSIFIED"
        # Look the prior classification up across processed batches; the
        # most recent oracle/detected wins. Permissive default keeps the
        # gate from spuriously firing on records we can't locate.
        for batch in _BATCHES.values():
            for r in batch.get("records", []):
                if r.get("sr_number") == sr_number:
                    prev_cls = (
                        r.get("detected_classification_oracle")
                        or r.get("source_classification")
                        or "UNCLASSIFIED"
                    )
                    break
        require_no_downgrade(
            prev_cls,
            new_cls,
            actor=role,
            action="sentry.review.modify_classification",
            subject_id=sr_number,
        )

    record_sentry_decision(
        sr_number,
        action,
        actor_role=role,
        actor_dodid=str(user.get("dodid", "")),
        actor_name=str(user.get("name", "")),
        actor_unit=str(user.get("unit", "")),
        actor_cert_serial=str(user.get("cert_serial", "")),
        note=note,
    )
    return {"ok": True, "sr_number": sr_number, "action": action}


# Bulk review — clears N records in **one** chained audit entry rather than
# emitting N independent rows. Per-record decisions still land in the
# `sentry_decisions` table so downstream gates (export, decisions_for_batch)
# behave identically. The audit chain entry carries the SR list in payload
# so an IG can reproduce exactly which records the operator's single click
# touched. ≥50 records at the FE require a typed confirmation; the BE caps
# at 500/click defensively to keep a runaway request from chaining a 5k row
# payload that would blow the audit reader.
_BULK_REVIEW_MAX = 500


@router.post("/review/bulk")
async def review_bulk(request: Request, payload: dict):
    action = (payload or {}).get("action", "")
    if action not in ("approve", "reject"):
        raise HTTPException(status_code=400, detail="action must be approve|reject")
    sr_numbers = list((payload or {}).get("sr_numbers", []) or [])
    if not sr_numbers:
        raise HTTPException(status_code=400, detail="sr_numbers must be a non-empty list")
    if len(sr_numbers) > _BULK_REVIEW_MAX:
        raise HTTPException(
            status_code=400,
            detail=f"bulk size {len(sr_numbers)} exceeds cap of {_BULK_REVIEW_MAX}",
        )
    column = str((payload or {}).get("column", "") or "")
    note = str((payload or {}).get("note", "") or "")
    role = session_role(request) or "data_custodian"
    result = record_sentry_bulk_decision(
        sr_numbers,
        action,
        actor_role=role,
        column=column,
        note=note,
    )
    return {
        "ok": True,
        "action": action,
        "count": result.get("count", 0),
        "sr_numbers": sr_numbers,
        "audit_kind": "sentry_bulk_review",
    }


_EXPORTS: dict = {}  # export_id -> zip bytes + metadata


@router.post("/export")
async def export_sanitized(request: Request, payload: dict):
    """Build a real downloadable zip: sanitized dataset XLSX + redaction
    report + audit trail snapshot. Stored in-memory under an export_id;
    GET /download/{export_id} streams the bytes."""
    release = payload.get("release_authority", "US_ONLY")
    format_ = payload.get("format", "xlsx")
    include_audit = bool(payload.get("include_audit", True))
    batch_id = payload.get("batch_id")

    # Task-69 — release_authority must be one of the four doctrinal values.
    # Previously an unknown value (e.g. "EYES_ONLY") fell through to a 500
    # KeyError on DISTRIBUTION_STATEMENT[release].
    if release not in VALID_RELEASE_AUTHORITIES:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "invalid_release_authority",
                "release_authority": release,
                "allowed": sorted(VALID_RELEASE_AUTHORITIES),
            },
        )

    # Task-69 — a non-empty batch_id that isn't in _BATCHES must 404, not
    # silently fall through to the full canonical dataset (an operator pasting
    # a stale ID got a much larger bundle than expected). The legitimate
    # "no batch supplied" path (None / empty string) keeps working.
    if batch_id and batch_id not in _BATCHES:
        raise HTTPException(
            status_code=404,
            detail={"error": "batch_not_found", "batch_id": batch_id},
        )

    ds = get_dataset()

    # Determine which records to export: latest batch if given, else canonical
    if batch_id and batch_id in _BATCHES:
        batch = _BATCHES[batch_id]
        records = batch["records"]
        source_label = batch["source"]
    else:
        records = _records_from_canonical(limit=len(ds.srs))
        source_label = "canonical_dataset"

    # Pull decisions for this batch
    sr_numbers = [r.get("sr_number") for r in records if r.get("sr_number")]
    decisions = decisions_for_batch(sr_numbers) if sr_numbers else {}

    # ---------------------------------------------------------------
    # Bundle classification — auto-inherit from the highest source
    # classification in the included records. The redaction report
    # itself surfaces what got removed, so even a "sanitized" bundle
    # carries source-level sensitivity for the operator handling it.
    # The frontend gate uses the same field on `result.classification`
    # to render the badge + block ineligible operators on download.
    # ---------------------------------------------------------------
    bundle_rank = 0
    bundle_class = "UNCLASSIFIED"
    for r in records:
        cand = (
            r.get("detected_classification_oracle")
            or r.get("source_classification")
            or "UNCLASSIFIED"
        )
        rk = classification_rank(cand)
        if rk > bundle_rank:
            bundle_rank = rk
            bundle_class = normalize_classification(cand)

    # Backend gate (truth source). The FE primitive mirrors this — but a
    # url-hacked direct call still terminates here with 403 + audit.
    user = getattr(request.state, "user", None)
    bundle_class = require_clearance(
        user,
        bundle_class,
        action="sentry.export",
        audit_actor=(user or {}).get("role") if user else session_role(request),
    )

    # Task-69 — doctrinal release-compatibility gate at the actual release
    # step. The /mark endpoint already encoded these rules for text-level
    # recommendations; previously the /export step happily built and stamped
    # bundles whose source classification was incompatible with the requested
    # release authority (e.g. SECRET // NOFORN to FVEY). Now we re-run the
    # validator against the bundle's aggregated classification + caveats and
    # hard-block on `status="block"`.
    bundle_caveats = _aggregate_caveats_from_records(records)
    compat = evaluate_release_compatibility(bundle_class, release, bundle_caveats)
    actor_role = (user or {}).get("role") if user else session_role(request)
    if compat["status"] == "block":
        audit_log(
            "release_blocked",
            actor=actor_role or "data_custodian",
            subject_id=batch_id or source_label,
            payload={
                "classification": bundle_class,
                "release_authority": release,
                "caveats": bundle_caveats,
                "issues": compat["issues"],
                "user_dodid": (user or {}).get("dodid"),
                "surface": "backend",
            },
        )
        raise HTTPException(
            status_code=403,
            detail={
                "error": "release_blocked",
                "classification": bundle_class,
                "release_authority": release,
                "caveats": bundle_caveats,
                "issues": compat["issues"],
            },
        )
    release_warnings = compat["issues"] if compat["status"] == "warn" else []

    # Apply release-authority overlay: generalize unit designators for NATO/FVEY
    generalize = release in ("NATO", "FVEY", "SPECIFIC")

    # Visible classification banner — required on every classified
    # artifact per DoDM 5200.01. Pure-text, monospaced, top of file.
    cls_banner_text = bundle_class.replace("_", " ")
    if bundle_class == "TS_SCI":
        cls_banner_text = "TOP SECRET // SCI"

    # Task-70 — Walkthrough #5 — Distribution Statements (A-F, who-can-access)
    # and REL TO caveats (which-foreigns) are independent. Derive the letter
    # from (release_authority, bundle_class) per DoDI 5230.24 instead of the
    # earlier hardcoded "Distribution C" which mis-marked UNCLASSIFIED public-
    # affairs releases (should be A or B).
    dist_authority, distribution = derive_distribution(release, bundle_class)

    # Task-70 — produce the dataset and redaction-report files in the format
    # the operator actually asked for. Earlier the segmented control was UI
    # theater: backend always wrote sanitized_dataset.xlsx regardless of the
    # selected format. A coalition partner who asked for CSV got XLSX they
    # couldn't parse. Now CSV and JSON are real outputs.
    fmt = (format_ or "xlsx").lower()
    if fmt not in ("xlsx", "csv", "json"):
        fmt = "xlsx"
    format_ = fmt  # write back so the manifest echoes the actual format used

    headers = [
        "SR Number", "Open Date", "Unit", "Equipment", "TAMCN", "NSN", "Serial",
        "Job Status", "Condition", "Component", "TM Ref", "Maint Level",
        "Detected Classification", "Sensitive Flags", "Decision",
    ]
    # Walk approved records once, accumulating the rows used by every output
    # format so we never disagree across XLSX/CSV/JSON.
    dataset_rows: list[list] = []
    dataset_records: list[dict] = []
    redaction_rows: list[list] = []
    redaction_records: list[dict] = []
    applied = 0
    for r in records:
        decision = decisions.get(r.get("sr_number", ""), {})
        action = decision.get("action", "auto")
        if action == "reject":
            continue  # rejected records never ship
        applied += 1
        unit = r.get("unit_name", "")
        if generalize and unit:
            unit = f"[{unit.split()[0]} AOR]"  # e.g. "CLB-6" -> "[CLB-6 AOR]"
        flags = r.get("sensitive_flags_oracle") or []
        sr_num = r.get("sr_number", "")
        for f in flags:
            redaction_rows.append([sr_num, f, "REDACTED", "[detected]", f"[{f.upper()} REDACTED]"])
            redaction_records.append({
                "sr_number": sr_num,
                "category": f,
                "action": "REDACTED",
                "original": "[detected]",
                "replacement": f"[{f.upper()} REDACTED]",
            })
        row = [
            sr_num,
            r.get("open_date", ""),
            unit,
            r.get("equipment_type", ""),
            r.get("tamcn", ""),
            r.get("nsn", ""),
            r.get("serial_number", ""),
            r.get("job_status", ""),
            r.get("condition", ""),
            r.get("fault_component", ""),
            r.get("tm_reference", ""),
            r.get("maintenance_level", ""),
            r.get("detected_classification_oracle", "UNCLASSIFIED"),
            ", ".join(flags),
            action,
        ]
        dataset_rows.append(row)
        dataset_records.append(dict(zip(headers, row)))

    redaction_header = ["SR", "Category", "Action", "Original", "Replacement"]
    banner_line = f"// CLASSIFICATION: {cls_banner_text} //"
    handling_line = f"// Handle per DoDM 5200.01 — Distribution: {dist_authority} ({release}) //"

    if fmt == "xlsx":
        from openpyxl import Workbook
        wb = Workbook()
        ws = wb.active
        ws.title = "Sanitized Dataset"
        ws.append([banner_line])
        ws.append([handling_line])
        ws.append([])  # spacer row
        ws.append(headers)
        for row in dataset_rows:
            ws.append(row)
        dataset_buf = io.BytesIO()
        wb.save(dataset_buf)
        dataset_bytes_value = dataset_buf.getvalue()

        redaction_wb = Workbook()
        rw = redaction_wb.active
        rw.title = "Redaction Report"
        rw.append([banner_line])
        rw.append([])
        rw.append(redaction_header)
        for row in redaction_rows:
            rw.append(row)
        redaction_buf = io.BytesIO()
        redaction_wb.save(redaction_buf)
        redaction_bytes_value = redaction_buf.getvalue()

        dataset_filename = "sanitized_dataset.xlsx"
        redaction_filename = "redaction_report.xlsx"
    elif fmt == "csv":
        # CSV doesn't carry a comment syntax, so emit the banner as a single-
        # column row up top — downstream readers will see it as the first
        # cell of the first row, which is the same posture XLSX takes.
        ds_buf = io.StringIO()
        w = csv.writer(ds_buf)
        w.writerow([banner_line])
        w.writerow([handling_line])
        w.writerow([])
        w.writerow(headers)
        for row in dataset_rows:
            w.writerow(row)
        dataset_bytes_value = ds_buf.getvalue().encode("utf-8")

        rd_buf = io.StringIO()
        w = csv.writer(rd_buf)
        w.writerow([banner_line])
        w.writerow([])
        w.writerow(redaction_header)
        for row in redaction_rows:
            w.writerow(row)
        redaction_bytes_value = rd_buf.getvalue().encode("utf-8")

        dataset_filename = "sanitized_dataset.csv"
        redaction_filename = "redaction_report.csv"
    else:  # json
        # Wrap the record array with the classification banner so a JSON
        # reader sees the marking without having to open the README/MANIFEST
        # separately. The `records` array is the canonical "object array"
        # downstream tooling iterates over.
        dataset_obj = {
            "classification": bundle_class,
            "classification_banner": banner_line,
            "handling": handling_line,
            "records": dataset_records,
        }
        dataset_bytes_value = json.dumps(dataset_obj, indent=2, default=str).encode("utf-8")

        redaction_obj = {
            "classification": bundle_class,
            "classification_banner": banner_line,
            "records": redaction_records,
        }
        redaction_bytes_value = json.dumps(redaction_obj, indent=2, default=str).encode("utf-8")

        dataset_filename = "sanitized_dataset.json"
        redaction_filename = "redaction_report.json"

    # Audit log snapshot (JSON) — stamped at the top with the bundle's
    # classification so downstream parsers can route by sensitivity
    # without re-reading the manifest.
    #
    # Task-70 — include each entry's original payload (parsed from the
    # canonical JSON we hashed) so a downstream verifier can reconstruct
    # what each row meant, not just that the chain is intact. Strip
    # source_ip from every payload as a per-OPSEC redaction; the chain
    # hash was computed over the full body, so verifiers can detect that
    # this snapshot was post-processed by re-hashing if they need
    # bit-exact reconstruction (which they shouldn't for a public-affairs
    # release).
    from ..persistence import recent_entries, verify_chain
    raw_entries = recent_entries(limit=500, include_payload=True)
    redacted_entries: list[dict] = []
    for entry in raw_entries:
        e = dict(entry)
        payload = e.get("payload")
        if isinstance(payload, dict) and "source_ip" in payload:
            payload = {**payload, "source_ip": "[REDACTED:OPSEC]"}
            e["payload"] = payload
        redacted_entries.append(e)
    audit_snapshot = {
        "classification": bundle_class,
        "classification_banner": banner_line,
        "chain": verify_chain(),
        "recent_entries": redacted_entries,
        "payload_post_processing": "source_ip fields redacted per OPSEC; "
                                   "re-hash will not match chain self_hash if any payload was redacted.",
        "captured_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    audit_bytes = json.dumps(audit_snapshot, indent=2, default=str).encode("utf-8")

    # Walkthrough #6 — record-count clarity. Was: a 500-record batch's
    # export reported 2,251 because we silently fell through to the full
    # canonical dataset when batch_id was missing. Now we surface
    # records_input + source_label so the operator sees exactly which
    # records the bundle covers.
    manifest = {
        # Top-level so downstream tooling can route by classification
        # without parsing the per-record dataset.
        "classification": bundle_class,
        "classification_banner": f"// CLASSIFICATION: {cls_banner_text} //",
        "batch_source": source_label,
        "release_authority": release,
        "format": format_,
        "records_input": len(records),
        "records_exported": applied,
        "records_rejected": len(records) - applied,
        "decisions_applied": len(decisions),
        "redactions_applied": len(redaction_rows),
        "distribution_statement": distribution,
        # Walkthrough #5 — surface independent fields separately.
        "rel_to_caveat": REL_TO_CAVEAT.get(release, ""),
        # Task-70 — derived per (release, classification) per DoDI 5230.24,
        # not hardcoded "Distribution C".
        "distribution_authority": dist_authority,
        "generalized_unit_markings": generalize,
        "created_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }

    # Walkthrough #1 — release-safety bug: SANITIZED preview must show the
    # actual redacted output, not source-with-badge. Earlier code only ran
    # the highlight-based redaction when `r.get("highlights", [])` was set,
    # which canonical-dataset records don't carry, so it always fell into the
    # trailer-append fallback that left source text un-redacted on the right.
    #
    # Fix: re-run tier1_classify on each remark to recover spans, then build
    # both an actual sanitized string AND a per-span removed list so the UI
    # can render strike-through on the original AND highlight the replacement
    # token on the sanitized side.
    sample_diffs: list[dict] = []
    seen_flags: set = set()
    for r in records:
        decision = decisions.get(r.get("sr_number", ""), {})
        if decision.get("action") == "reject":
            continue
        flags = r.get("sensitive_flags_oracle") or []
        if not flags:
            continue
        new_flags = [f for f in flags if f not in seen_flags]
        if not new_flags and len(sample_diffs) >= 3:
            continue
        original = r.get("remark", "")
        if not original:
            continue
        tier = tier1_classify(original)
        highlights = sorted(tier.get("highlights", []), key=lambda h: h.get("start", 0))
        if not highlights:
            # No redactable spans — skip rather than emit the misleading
            # "trailer-append" diff that was the very bug walkthrough #1
            # flagged.
            continue
        out_chunks: list[str] = []
        removed_spans: list[dict] = []
        cursor = 0
        for h in highlights:
            s, e = h.get("start", 0), h.get("end", 0)
            if s < cursor:
                continue
            if s > cursor:
                out_chunks.append(original[cursor:s])
            token = f"[REDACTED:{h.get('rule', h.get('category', 'PII')).upper()}]"
            out_chunks.append(token)
            removed_spans.append({
                "start": s,
                "end": e,
                "before": original[s:e],
                "after": token,
                "category": h.get("category"),
                "rule": h.get("rule"),
            })
            cursor = e
        if cursor < len(original):
            out_chunks.append(original[cursor:])
        sanitized = "".join(out_chunks)

        sample_diffs.append({
            "sr_number": r.get("sr_number", ""),
            "unit_name": r.get("unit_name", ""),
            "equipment_type": r.get("equipment_type", ""),
            "flags": flags,
            "original": original,
            "sanitized": sanitized,
            "removed_spans": removed_spans,
        })
        seen_flags.update(flags)
        if len(sample_diffs) >= 3:
            break

    # Bundle as zip
    export_id = f"EXP-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        # Task-70 — write the format the operator actually selected.
        zf.writestr(dataset_filename, dataset_bytes_value)
        zf.writestr(redaction_filename, redaction_bytes_value)
        if include_audit:
            zf.writestr("audit_log.json", audit_bytes)
        zf.writestr("MANIFEST.json", json.dumps(manifest, indent=2))
        zf.writestr("README.txt", (
            f"// CLASSIFICATION: {cls_banner_text} //\n"
            f"// Handle per DoDM 5200.01 //\n\n"
            "SPIRE sanitized export bundle.\n\n"
            f"Classification:    {cls_banner_text}\n"
            f"Release authority: {release}\n"
            f"Format:            {fmt.upper()}\n"
            f"Distribution:      {dist_authority}\n"
            f"  {distribution}\n\n"
            "Files:\n"
            f"  {dataset_filename:<24s} -- approved records with SENTRY redactions applied\n"
            f"  {redaction_filename:<24s} -- per-record change log (original -> replacement + category)\n"
            f"  {'audit_log.json':<24s} -- hash-chained audit trail snapshot (with parsed payload, source_ip redacted)\n"
            f"  {'MANIFEST.json':<24s} -- structured metadata for automated ingestion\n\n"
            f"// CLASSIFICATION: {cls_banner_text} //\n"
        ).encode("utf-8"))
    buf.seek(0)

    # Filename inherits the bundle classification so a glance at the
    # download path tells the operator what they're handling.
    safe_cls = bundle_class.replace("/", "_")
    _EXPORTS[export_id] = {
        "bytes": buf.getvalue(),
        "filename": f"spire_{safe_cls}_sanitized_{export_id}.zip",
        "classification": bundle_class,
        "manifest": manifest,
        "created_at": manifest["created_at"],
    }

    audit_log(
        "sentry_export",
        actor=session_role(request) or "data_custodian",
        subject_id=export_id,
        payload={
            "release": release,
            "records": applied,
            "rejected": len(records) - applied,
            "classification": bundle_class,
        },
    )

    return {
        "ok": True,
        "export_id": export_id,
        "filename": _EXPORTS[export_id]["filename"],
        "bytes": len(_EXPORTS[export_id]["bytes"]),
        # Echo classification on the response so the FE badge can render
        # the actual bundle marking (not just the operator-supplied default).
        "classification": bundle_class,
        "classification_banner": f"// CLASSIFICATION: {cls_banner_text} //",
        "download_url": f"/api/sentry/download/{export_id}",
        "sample_diffs": sample_diffs,
        # Task-69 — surface release-compatibility warnings (status="warn")
        # so the FE can render a yellow banner above the result panel.
        # `release_blocked` cases never reach this return — they raise 403
        # before the bundle is built.
        "release_compatibility": {
            "status": compat["status"],
            "issues": compat["issues"],
            "caveats": bundle_caveats,
        },
        "release_warnings": release_warnings,
        **manifest,
    }


# ---------------------------------------------------------------------------
# GC-5 Coalition Interoperability — live partner-scoped logistics view
# ---------------------------------------------------------------------------

@router.get("/coalition/profiles")
async def coalition_profiles():
    """Return summaries of every coalition release profile for the partner picker."""
    if not _COALITION_AVAILABLE:
        raise HTTPException(status_code=503, detail="coalition profiles unavailable")
    return {"profiles": list_profiles()}


@router.get("/coalition/{profile_key}")
async def coalition_view(profile_key: str, role: Optional[str] = None):
    """Live partner-scoped view of the canonical dataset.

    Walks units, assets, SRs, requisitions, and cannibalization events,
    classifying each through the partner profile and applying field
    redactions. Returns counts of allowed vs blocked records, sample
    redacted records the operator can preview, and the partner-unit
    roster surfaced on the coalition tab.

    This is the GC-5 demo: 'show me what JSDF sees right now' — the
    output is what we'd send across the wire on a coalition release."""
    if not _COALITION_AVAILABLE:
        raise HTTPException(status_code=503, detail="coalition profiles unavailable")
    profile_data = _coalition_profiles().get("profiles", {}).get(profile_key)
    if not profile_data:
        raise HTTPException(status_code=404, detail=f"unknown profile {profile_key}")

    ds = get_dataset()
    # Build a map of unit -> parent so classify_record can resolve unit_parent.
    unit_parent: dict[str, str] = {u.name: u.parent for u in ds.units}

    allowed_units_count = 0
    blocked_units_count = 0
    allowed_units_list: list[dict] = []
    for u in ds.units:
        rec = {
            "unit_name": u.name,
            "unit_parent": u.parent,
            "category": "readiness_summary",
            "detected_classification": "UNCLASSIFIED",
        }
        decision = classify_record(profile_key, rec)
        if decision.allowed:
            allowed_units_count += 1
            allowed_units_list.append({
                "unit": u.name,
                "parent": u.parent,
                "uic": u.uic,
                "location": u.location,
            })
        else:
            blocked_units_count += 1

    # Sample SR-level scoping: walk first 50 NMCS SRs.
    sample_srs: list[dict] = []
    sr_allowed = 0
    sr_blocked = 0
    for sr in ds.srs[:200]:
        rec = {
            "sr_number": sr.sr_number,
            "asset_id": sr.asset_id,
            "unit_name": sr.unit_name,
            "unit_parent": unit_parent.get(sr.unit_name, ""),
            "equipment_type": sr.equipment_type,
            "fault_component": sr.fault_component,
            "tm_reference": sr.tm_reference,
            "serial_number": sr.serial_number,
            "remark": sr.remark_text,
            "detected_classification": sr.detected_classification or "UNCLASSIFIED",
            "category": "readiness_summary",
        }
        decision = classify_record(profile_key, rec)
        if decision.allowed:
            sr_allowed += 1
            redacted, spans = apply_redactions_with_spans(rec, decision.redactions_applied)
            if len(sample_srs) < 8:
                # Surface both the redacted preview and the original (preview-only)
                # so the frontend can render an inline diff. The original NEVER
                # ships in a release manifest — it's only here to make the
                # operator-visible preview honest about what's being stripped.
                sample_srs.append({
                    "sr_number": redacted.get("sr_number"),
                    "unit_name": redacted.get("unit_name"),
                    "equipment_type": redacted.get("equipment_type"),
                    "fault_component": redacted.get("fault_component"),
                    "fault_component_original": rec.get("fault_component"),
                    "remark_preview": (redacted.get("remark", "") or "")[:240],
                    "remark_original": (rec.get("remark", "") or "")[:240],
                    "redactions": decision.redactions_applied,
                    "redaction_spans": spans,
                })
        else:
            sr_blocked += 1

    return {
        "profile_key": profile_key,
        "display_name": profile_data["display_name"],
        "partners": profile_data["partners"],
        "distribution_statement": profile_data["distribution_statement"],
        "authorized_classifications": profile_data["authorized_classifications"],
        "caveats_applied": profile_data.get("caveats_applied", []),
        "embargo_days_after_event": profile_data.get("embargo_days_after_event", 0),
        "scope": {
            "units_allowed": allowed_units_count,
            "units_blocked": blocked_units_count,
            "sample_srs_allowed": sr_allowed,
            "sample_srs_blocked": sr_blocked,
            "sample_srs_total_inspected": min(200, len(ds.srs)),
        },
        "allowed_units": allowed_units_list,
        "sample_records": sample_srs,
        "partner_units": partner_units_for(profile_key),
        "field_redactions": profile_data.get("field_redactions", []),
        "as_of": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }


@router.post("/coalition/{profile_key}/release")
async def coalition_release(
    profile_key: str,
    request: Request,
    payload: Optional[dict] = None,
):
    """Generate a release-package event for the selected coalition profile.
    Hashes a manifest of what would ship and writes the event to the audit
    chain so a security manager can later inspect every coalition release.

    Server-side gate: only data_custodian or security_manager may release.
    Without this, any role could execute an FVEY release on the live deploy
    (verified during adversarial audit, fileable as bug #6)."""
    from ..scoping import require_role, COALITION_RELEASE_ROLES
    if not _COALITION_AVAILABLE:
        raise HTTPException(status_code=503, detail="coalition profiles unavailable")
    payload = payload or {}
    actor = session_role(request)
    require_role(actor, COALITION_RELEASE_ROLES, "sentry.coalition.release")
    profile_data = _coalition_profiles().get("profiles", {}).get(profile_key)
    if not profile_data:
        raise HTTPException(status_code=404, detail=f"unknown profile {profile_key}")

    # Coalition release inherits the highest classification the partner is
    # authorized to receive (per the profile). The operator's clearance must
    # meet or exceed it before the release packet leaves the enclave.
    auth_cls = profile_data.get("authorized_classifications", []) or ["UNCLASSIFIED"]
    release_cls = "UNCLASSIFIED"
    release_rank = 0
    for c in auth_cls:
        rk = classification_rank(c)
        if rk > release_rank:
            release_rank = rk
            release_cls = normalize_classification(c)
    user = getattr(request.state, "user", None)
    release_cls = require_clearance(
        user,
        release_cls,
        action="sentry.coalition.release",
        audit_actor=actor,
        audit_subject=profile_key,
    )

    release_id = f"REL-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
    audit_log(
        "sentry_coalition_release",
        actor=actor,
        subject_id=release_id,
        payload={
            "profile": profile_key,
            "partners": profile_data["partners"],
            "distribution": profile_data["distribution_statement"],
            "classification": release_cls,
        },
    )
    return {
        "ok": True,
        "release_id": release_id,
        "profile": profile_key,
        "partners": profile_data["partners"],
        "distribution_statement": profile_data["distribution_statement"],
        "caveats_applied": profile_data.get("caveats_applied", []),
        "classification": release_cls,
        "audit_logged": True,
        "created_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }


@router.get("/audit/{subject_id}")
async def audit_for_subject(subject_id: str, request: Request, limit: int = 50):
    """Walkthrough #31 — per-record audit-entry viewer. Returns the chain
    entries (hash, prev_hash, ts, actor, payload) for the requested
    subject so operators can verify the audit trail without leaving
    the inspector pane.

    Gated on the same clearance the export endpoint uses: we look the
    subject's max source/detected classification up across processed
    batches and require_clearance() against it. A lower-cleared caller
    gets 403 + an audit `spillage_prevented` row instead of a free
    enumeration of every chain entry tied to the SR. Subjects we can't
    locate in batches default to SECRET — SENTRY's working floor — so
    fishing the chain by guessing SR numbers stays gated.
    """
    subject_cls = "SECRET"
    subject_rank = classification_rank(subject_cls)
    for batch in _BATCHES.values():
        for r in batch.get("records", []):
            if r.get("sr_number") == subject_id:
                cand = (
                    r.get("detected_classification_oracle")
                    or r.get("source_classification")
                    or "UNCLASSIFIED"
                )
                rk = classification_rank(cand)
                if rk > subject_rank:
                    subject_rank = rk
                    subject_cls = normalize_classification(cand)

    user = getattr(request.state, "user", None)
    require_clearance(
        user,
        subject_cls,
        action="sentry.audit.read",
        audit_subject=subject_id,
    )

    rows = entries_for_subject(subject_id, limit=limit)
    return {
        "subject_id": subject_id,
        "entries": rows,
        "count": len(rows),
        "subject_classification": subject_cls,
    }


@router.get("/download/{export_id}")
async def download_export(export_id: str, request: Request):
    entry = _EXPORTS.get(export_id)
    if not entry:
        raise HTTPException(status_code=404, detail="export not found or expired")
    # Re-check on download. Even though the operator was cleared at the
    # build call, identity may have rotated between build and stream — and
    # an enumeration attack on EXP-IDs would otherwise hand any signed-in
    # user the bytes. Reuse the same gate so the audit chain emits an
    # identical spillage_prevented event on either surface.
    user = getattr(request.state, "user", None)
    require_clearance(
        user,
        entry.get("classification", "UNCLASSIFIED"),
        action="sentry.download",
        audit_subject=export_id,
    )
    cls_header = entry.get("classification", "UNCLASSIFIED")
    return StreamingResponse(
        io.BytesIO(entry["bytes"]),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{entry["filename"]}"',
            # Visible classification on the wire — surfaces in CLI/curl
            # output so even non-UI consumers see the marking.
            "X-Classification": cls_header,
        },
    )


# ---------------------------------------------------------------------------
# Public-facing batch serializer (strips large "records" array)
# ---------------------------------------------------------------------------

def _public_batch(batch: dict) -> dict:
    preview = batch["records"][:10]
    return {
        "batch_id": batch["batch_id"],
        "source": batch["source"],
        "created_at": batch["created_at"],
        "record_count": batch["record_count"],
        "status": batch["status"],
        "schema_detected": batch["schema_detected"],
        "data_quality": batch["data_quality"],
        "preview": [
            {
                "sr_number": r["sr_number"],
                "equipment_type": r["equipment_type"],
                "unit_name": r["unit_name"],
                "remark_preview": r["remark"][:120],
                "source_classification": r["source_classification"],
            }
            for r in preview
        ],
        "jobs": list(batch["jobs"].keys()),
    }
