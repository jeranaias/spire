"""Build a derived dictionary JSON for the integrations Field Dictionary tab.

The raw GCSS-MC dictionary CSVs live under `tmp/gcss-mc/` (not committed).
This script reads them once, joins each column with the real-data top-3
values from `gcss_real_profile.json`, and writes a self-contained derived
JSON to `dataset/data/gcss_dictionary.json` that the integrations route
can serve in any deploy posture (production never has `tmp/` present).

Usage:
    python -m dataset.scripts.build_gcss_dictionary
"""
from __future__ import annotations

import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = REPO_ROOT / "tmp" / "gcss-mc"
PROFILE_PATH = REPO_ROOT / "dataset" / "data" / "gcss_real_profile.json"
OUT_PATH = REPO_ROOT / "dataset" / "data" / "gcss_dictionary.json"

HEADER_DICT = RAW_DIR / "sr_header_dict.csv"
PARTS_DICT = RAW_DIR / "sr_repair_part_dict.csv"
DUE_IN_DICT = RAW_DIR / "due_in_data_dict.csv"

# Columns SPIRE actively consumes (drives the coverage badge in the UI).
SPIRE_CONSUMED = {
    "header": {
        "SERVICE_REQUEST_TYPE": "ServiceRequest.service_request_type",
        "SR_NUMBER": "ServiceRequest.sr_number",
        "JOB_STATUS_CODE": "ServiceRequest.job_status",
        "DEFECT_CODE": "ServiceRequest.defect_code_primary + defect_code_secondary",
        "PROBLEM_SUMMARY": "ServiceRequest.remark_text (header summary)",
        "DATE_RECEIVED_IN_SHOP": "ServiceRequest.open_date",
        "ECHELON_OF_MAINT": "ServiceRequest.echelon_numeric (+ maintenance_level label)",
        "SERIAL_NUMBER": "ServiceRequest.serial_number",
        "TAMCN": "ServiceRequest.tamcn",
        "DEADLINED_DATE": "ServiceRequest.deadlined_date",
        "MASTER_PRIORITY_CODE": "ServiceRequest.priority",
        "OWNER_UNIT_ADDRESS_CODE": "ServiceRequest.unit_uic (mapped via fleet)",
        "JOB_STATUS_DATE": "ServiceRequest.close_date / status timestamp",
    },
    "parts": {
        "SR_NUMBER": "PartRequisition.sr_number",
        "SERVICE_ACTIVITY": "PartRequisition.service_activity",
        "RNSN": "PartRequisition.nsn",
        "QUANTITY_REQUIRED": "PartRequisition.qty_ordered",
        "PARTS_CHARGE": "PartRequisition.total_cost",
        "DOCUMENT_NUMBER": "PartRequisition.document_number",
    },
    "due_in": {
        "DOC_NBR": "PartRequisition.document_number",
        "DIC": "PartRequisition.dic",
        "NSN_ORDERED": "PartRequisition.nsn",
        "NIIN": "PartRequisition.nsn (last 9 digits)",
        "PRI_CD": "PartRequisition.priority",
        "ESTA": "PartRequisition.ordered_date",
        "MAX_STAT_DT": "PartRequisition.projected_delivery_date",
        "SR_NUMBER": "PartRequisition.sr_number",
        "ITEM_TYPE": "PartRequisition.item_type",
        "DOC_STATUS": "PartRequisition.doc_status",
        "UNIT_PRICE": "PartRequisition.unit_cost",
        "QTY_SHIPPED": "PartRequisition.qty_ordered (best-effort)",
    },
}

# Columns SPIRE has a placeholder for but doesn't fully consume yet.
SPIRE_PARTIAL = {
    "due_in": {
        "RDD_CAL_DT": "lead-time forecast (PULSE consumes derived value)",
        "OST": "Order-to-ship time (lead-time profile)",
        "LRT": "Logistics response time (lead-time profile)",
        "CWT": "Customer wait time (lead-time profile)",
    },
    "parts": {
        "TASK_NUMBER": "rolled into SR-level remarks",
        "ORGANIZATION_CODE": "rolled into unit_uic mapping",
    },
}


def _coverage(section: str, column: str) -> Dict[str, str]:
    if column in SPIRE_CONSUMED.get(section, {}):
        return {
            "level": "consumed",
            "spire_field": SPIRE_CONSUMED[section][column],
            "badge": "green",
            "label": "Consumed",
        }
    if column in SPIRE_PARTIAL.get(section, {}):
        return {
            "level": "partial",
            "spire_field": SPIRE_PARTIAL[section][column],
            "badge": "amber",
            "label": "Partial",
        }
    return {"level": "dropped", "spire_field": "", "badge": "red", "label": "Dropped"}


def _load_profile() -> Dict[str, Any]:
    if not PROFILE_PATH.exists():
        sys.stderr.write(
            f"WARN: profile not found at {PROFILE_PATH}; coverage table will lack top-3 values\n"
        )
        return {}
    with PROFILE_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def _real_top_n(profile: Dict[str, Any], section: str, column: str, n: int = 3) -> List[Dict[str, Any]]:
    section_map = {"header": "header", "parts": "parts", "due_in": "due_in"}
    section_data = profile.get(section_map.get(section, section), {})
    fields = section_data.get("fields", {})
    field = fields.get(column)
    if not isinstance(field, dict):
        return []
    top = field.get("top_values", [])
    return top[:n]


def _read_dict_csv(path: Path, name_col: str = "COLUMN_NAME") -> List[Dict[str, str]]:
    rows: List[Dict[str, str]] = []
    if not path.exists():
        return rows
    with path.open("r", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append({k: (v or "").strip() for k, v in row.items()})
    return rows


def build() -> Dict[str, Any]:
    profile = _load_profile()

    sections: List[Dict[str, Any]] = []

    header_rows = _read_dict_csv(HEADER_DICT)
    sections.append({
        "id": "header",
        "title": "SR Header",
        "source_csv": "sr_header_dict.csv",
        "row_count_real_export": (profile.get("header", {}) or {}).get("row_count", 0),
        "columns": [
            {
                "column": r.get("COLUMN_NAME", ""),
                "data_type": r.get("DATA_TYPE", ""),
                "nullable": (r.get("NULLABLE", "") or "").upper().startswith("Y"),
                "comment": r.get("COMMENTS", ""),
                "real_top_3": _real_top_n(profile, "header", r.get("COLUMN_NAME", "")),
                "coverage": _coverage("header", r.get("COLUMN_NAME", "")),
            }
            for r in header_rows
        ],
    })

    parts_rows = _read_dict_csv(PARTS_DICT)
    sections.append({
        "id": "parts",
        "title": "SR Repair Parts",
        "source_csv": "sr_repair_part_dict.csv",
        "row_count_real_export": (profile.get("parts", {}) or {}).get("row_count", 0),
        "columns": [
            {
                "column": r.get("COLUMN_NAME", ""),
                "data_type": r.get("DATA_TYPE", ""),
                "nullable": (r.get("NULLABLE", "") or "").upper().startswith("Y"),
                "comment": r.get("COMMENTS", ""),
                "real_top_3": _real_top_n(profile, "parts", r.get("COLUMN_NAME", "")),
                "coverage": _coverage("parts", r.get("COLUMN_NAME", "")),
            }
            for r in parts_rows
        ],
    })

    # Due-in dict has a different shape: just `Column,Comment`.
    due_rows = _read_dict_csv(DUE_IN_DICT)
    sections.append({
        "id": "due_in",
        "title": "Due-In",
        "source_csv": "due_in_data_dict.csv",
        "row_count_real_export": (profile.get("due_in", {}) or {}).get("row_count", 0),
        "columns": [
            {
                "column": r.get("Column", ""),
                "data_type": "—",
                "nullable": True,
                "comment": r.get("Comment", ""),
                "real_top_3": _real_top_n(profile, "due_in", r.get("Column", "")),
                "coverage": _coverage("due_in", r.get("Column", "")),
            }
            for r in due_rows
        ],
    })

    return {
        "_meta": {
            "source": "GCSS-MC sanitized data dictionary CSVs",
            "generated_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z",
            "real_profile": str(PROFILE_PATH.relative_to(REPO_ROOT)),
        },
        "sections": sections,
    }


def main() -> int:
    out = build()
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, sort_keys=False)
    n = sum(len(s["columns"]) for s in out["sections"])
    sys.stdout.write(f"Wrote {n} columns across {len(out['sections'])} sections to {OUT_PATH}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
