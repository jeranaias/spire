"""Top-level shim re-exporting the canonical adapter from
``backend.integrations.sentry_gcss_adapter`` so callers (tests, scripts,
notebooks) can import either path."""

from backend.integrations.sentry_gcss_adapter import *  # noqa: F401,F403
from backend.integrations.sentry_gcss_adapter import (  # noqa: F401
    EXPECTED_HEADER_COLUMNS,
    IngestReport,
    ParsedSrHeader,
    classify_serial_number,
    classify_sr_number,
    classify_tamcn,
    classify_uic_source,
    ingest_sr_header_csv,
    normalize_defect_code,
    normalize_echelon,
    normalize_priority,
    parse_header_row,
    parse_oracle_date,
    report_to_dict,
)
