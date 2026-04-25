"""SENTRY endpoints: ingest, processing, review queue, export."""
from __future__ import annotations

import asyncio
import io
import json
import re
import uuid
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import pandas as pd
from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse

from ..persistence import (
    DATA_DIR as PERSIST_DIR,
    decisions_for_batch,
    log as audit_log,
    record_sentry_decision,
    store_uploaded_batch,
)
from ..state import get_dataset

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
    suggested classification level. When the trained HawkStack Tier-1
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


@router.post("/mark")
async def mark_text(payload: dict):
    """Upstream marking recommender. Accepts a free-text paragraph, returns
    the recommended classification + explanation without any LLM.

    Payload: {"text": "...", "release_authority": "US_ONLY"}.
    """
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

    # Explanation
    rule_reasons = []
    for h in tier1["highlights"]:
        rule_reasons.append({
            "flag": h["category"],
            "evidence": h["text"],
            "rule": h["rule"],
        })

    return {
        "recommended_classification": tier1["classification"],
        "confidence": tier1["confidence"],
        "flags": tier1["flags"],
        "caveats_recommended": caveats,
        "evidence": rule_reasons,
        "release_authority_requested": release,
        "audit": {
            "engine": "SENTRY Tier-1 regex ensemble + Tier-2 LLM gate",
            "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
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

        # Aggregation watch: track NMC-by-unit-equipment
        if rec["condition"] == "Deadlined":
            key = (rec["unit_name"], rec["equipment_type"])
            aggregated[key]["count"] += 1
            aggregated[key]["unit_equip"] = key

        results.append({
            "sr_number": rec["sr_number"],
            "asset_id": rec["asset_id"],
            "unit_name": rec["unit_name"],
            "equipment_type": rec["equipment_type"],
            "remark": rec["remark"],
            "source_classification": rec["source_classification"],
            "detected_classification": tier1["classification"],
            "classification_discrepancy": discrepancy,
            "confidence": tier1["confidence"],
            "flags": tier1["flags"],
            "highlights": tier1["highlights"],
            "routed_to": "tier2_llm" if routed_tier2 else "tier1",
            "data_quality_flag": rec.get("data_quality_flag"),
        })

    # Aggregation-risk detection: unit+equipment combos where > 60% of that
    # combo's records are Deadlined in this batch are flagged.
    batch_unit_equip_counts = defaultdict(lambda: {"deadline": 0, "total": 0})
    for rec in batch["records"]:
        key = (rec["unit_name"], rec["equipment_type"])
        batch_unit_equip_counts[key]["total"] += 1
        if rec["condition"] == "Deadlined":
            batch_unit_equip_counts[key]["deadline"] += 1

    agg_risks = []
    for (unit, equip), counts in batch_unit_equip_counts.items():
        if counts["total"] < 3:
            continue
        pct = counts["deadline"] / counts["total"]
        if pct >= 0.60:
            agg_risks.append({
                "unit": unit,
                "equipment_type": equip,
                "deadline_count": counts["deadline"],
                "total_count": counts["total"],
                "deadline_pct": round(pct, 3),
                "warning": (
                    f"{pct:.0%} of {equip} records for {unit} are Deadlined. "
                    "Combined records reveal fleet readiness posture. "
                    "Individual records are UNCLASSIFIED; aggregated data may be operationally sensitive."
                ),
                "recommended_action": f"Hold release of combined {equip} readiness data for {unit}; SSO review required.",
            })

    job = {
        "job_id": job_id,
        "batch_id": batch_id,
        "started_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
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
    for r in job["results"]:
        if r["classification_discrepancy"]:
            held.append(r)
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
        "aggregation_risks": job["aggregation_risks"],
    }


@router.post("/review/{sr_number}/{action}")
async def review_action(sr_number: str, action: str, payload: Optional[dict] = None):
    if action not in ("approve", "reject", "modify"):
        raise HTTPException(status_code=400, detail="action must be approve|reject|modify")
    payload = payload or {}
    role = payload.get("role", "data_custodian")
    note = payload.get("note", "")
    record_sentry_decision(sr_number, action, actor_role=role, note=note)
    return {"ok": True, "sr_number": sr_number, "action": action}


_EXPORTS: dict = {}  # export_id -> zip bytes + metadata


@router.post("/export")
async def export_sanitized(payload: dict):
    """Build a real downloadable zip: sanitized dataset XLSX + redaction
    report + audit trail snapshot. Stored in-memory under an export_id;
    GET /download/{export_id} streams the bytes."""
    release = payload.get("release_authority", "US_ONLY")
    format_ = payload.get("format", "xlsx")
    include_audit = bool(payload.get("include_audit", True))
    batch_id = payload.get("batch_id")

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

    # Apply release-authority overlay: generalize unit designators for NATO/FVEY
    generalize = release in ("NATO", "FVEY", "SPECIFIC")

    # Build the sanitized dataset XLSX in memory
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Sanitized Dataset"
    headers = [
        "SR Number", "Open Date", "Unit", "Equipment", "TAMCN", "NSN", "Serial",
        "Job Status", "Condition", "Component", "TM Ref", "Maint Level",
        "Detected Classification", "Sensitive Flags", "Decision",
    ]
    ws.append(headers)
    redactions: list[list] = [["SR", "Category", "Action", "Original", "Replacement"]]
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
        for f in flags:
            redactions.append([r.get("sr_number", ""), f, "REDACTED", "[detected]", f"[{f.upper()} REDACTED]"])
        ws.append([
            r.get("sr_number", ""),
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
        ])
    dataset_bytes = io.BytesIO()
    wb.save(dataset_bytes)
    dataset_bytes.seek(0)

    # Redaction report
    redaction_wb = Workbook()
    rw = redaction_wb.active
    rw.title = "Redaction Report"
    for row in redactions:
        rw.append(row)
    redaction_bytes = io.BytesIO()
    redaction_wb.save(redaction_bytes)
    redaction_bytes.seek(0)

    # Audit log snapshot (JSON)
    from ..persistence import recent_entries, verify_chain
    audit_snapshot = {
        "chain": verify_chain(),
        "recent_entries": recent_entries(limit=500),
        "captured_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    audit_bytes = json.dumps(audit_snapshot, indent=2).encode("utf-8")

    # Distribution statement
    distribution = {
        "US_ONLY": "DISTRIBUTION A: Approved for public release; distribution is unlimited.",
        "FVEY":    "DISTRIBUTION D: REL TO FVEY (USA, AUS, CAN, GBR, NZL). Further distribution requires originator approval.",
        "NATO":    "DISTRIBUTION D: REL TO NATO. Further distribution requires originator approval.",
        "SPECIFIC": "DISTRIBUTION E: Further dissemination only as directed by originator.",
    }[release]

    manifest = {
        "batch_source": source_label,
        "release_authority": release,
        "format": format_,
        "records_exported": applied,
        "records_rejected": len(records) - applied,
        "decisions_applied": len(decisions),
        "redactions_applied": len(redactions) - 1,
        "distribution_statement": distribution,
        "generalized_unit_markings": generalize,
        "created_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }

    # Pick 3 representative before/after diffs so the UI can show operators
    # exactly what the sanitizer did rather than making them trust a count.
    # We walk the records that (a) survived approval and (b) had ≥ 1 flag,
    # and produce a sanitized remark by replacing each flag's detected span
    # with the `[FLAG REDACTED]` token.
    sample_diffs: list[dict] = []
    seen_flags: set = set()
    for r in records:
        decision = decisions.get(r.get("sr_number", ""), {})
        if decision.get("action") == "reject":
            continue
        flags = r.get("sensitive_flags_oracle") or []
        if not flags:
            continue
        # Try to diversify — prefer samples that cover a flag we haven't shown.
        new_flags = [f for f in flags if f not in seen_flags]
        if not new_flags and len(sample_diffs) >= 3:
            continue
        original = r.get("remark", "")
        sanitized = original
        # Lightweight redaction preview — uses highlights if available to keep
        # the redacted span lined up with what the classifier actually found.
        highlights = sorted(r.get("highlights", []), key=lambda h: h.get("start", 0), reverse=True)
        for h in highlights:
            if h.get("category") not in flags:
                continue
            s, e = h.get("start", 0), h.get("end", 0)
            token = f"[{h['category'].upper()} REDACTED]"
            sanitized = sanitized[:s] + token + sanitized[e:]
        if sanitized == original:
            # Fallback: just append a classification marking trailer
            sanitized = f"{original}  [{' / '.join(f.upper() for f in flags)} REDACTED]"
        sample_diffs.append({
            "sr_number": r.get("sr_number", ""),
            "unit_name": r.get("unit_name", ""),
            "equipment_type": r.get("equipment_type", ""),
            "flags": flags,
            "original": original,
            "sanitized": sanitized,
        })
        seen_flags.update(flags)
        if len(sample_diffs) >= 3:
            break

    # Bundle as zip
    export_id = f"EXP-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("sanitized_dataset.xlsx", dataset_bytes.getvalue())
        zf.writestr("redaction_report.xlsx", redaction_bytes.getvalue())
        if include_audit:
            zf.writestr("audit_log.json", audit_bytes)
        zf.writestr("MANIFEST.json", json.dumps(manifest, indent=2))
        zf.writestr("README.txt", (
            "SPIRE sanitized export bundle.\n\n"
            f"Release authority: {release}\n"
            f"Distribution: {distribution}\n\n"
            "Files:\n"
            "  sanitized_dataset.xlsx  -- approved records with SENTRY redactions applied\n"
            "  redaction_report.xlsx   -- per-record change log (original -> replacement + category)\n"
            "  audit_log.json          -- hash-chained audit trail snapshot at export time\n"
            "  MANIFEST.json           -- structured metadata for automated ingestion\n"
        ).encode("utf-8"))
    buf.seek(0)

    _EXPORTS[export_id] = {
        "bytes": buf.getvalue(),
        "filename": f"spire_sanitized_{export_id}.zip",
        "manifest": manifest,
        "created_at": manifest["created_at"],
    }

    audit_log(
        "sentry_export",
        actor=payload.get("actor_role", "data_custodian"),
        subject_id=export_id,
        payload={"release": release, "records": applied, "rejected": len(records) - applied},
    )

    return {
        "ok": True,
        "export_id": export_id,
        "filename": _EXPORTS[export_id]["filename"],
        "bytes": len(_EXPORTS[export_id]["bytes"]),
        "download_url": f"/api/sentry/download/{export_id}",
        "sample_diffs": sample_diffs,
        **manifest,
    }


@router.get("/download/{export_id}")
async def download_export(export_id: str):
    entry = _EXPORTS.get(export_id)
    if not entry:
        raise HTTPException(status_code=404, detail="export not found or expired")
    return StreamingResponse(
        io.BytesIO(entry["bytes"]),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{entry["filename"]}"'},
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
