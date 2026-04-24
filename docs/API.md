# SPIRE Backend API (v0 contract)

FastAPI server, `localhost:8700`. All endpoints under `/api`. Built tomorrow
(24 APR) after the dataset + UI land. This document locks the interface so
backend and frontend can develop in parallel without drift.

## Conventions

- All responses are JSON.
- Timestamps are ISO-8601 UTC unless explicitly labeled `local_time`.
- Error format: `{"error": "<short>", "detail": "<long>", "trace_id": "<uuid>"}`.
- Pagination via `?limit=N&cursor=<opaque>` when applicable.
- Authentication: **none for hackathon**; single-user local app. Post-hackathon: CAC session cookie.

## Ingestion

### `POST /api/ingest/upload`

Uploads a CSV/XLSX/JSON file. Returns a batch ID the UI uses to poll progress.

Request: `multipart/form-data` with `file`.
Response: `{"batch_id": "BATCH-2026-04-28-001", "record_count": 500, "schema_detected": {...}}`.

### `GET /api/ingest/batches/{batch_id}`

Batch state and schema mapping.

Response:
```json
{
  "batch_id": "BATCH-2026-04-28-001",
  "status": "ready|processing|complete|failed",
  "record_count": 500,
  "schema_detected": {"record_id": "mapped", "equipment": "mapped", "..."},
  "data_quality": {
    "passed": 487,
    "flagged": 13,
    "flags": [{"type": "hours_decreased", "count": 8}, ...]
  }
}
```

### `POST /api/ingest/batches/{batch_id}/process`

Kicks off SENTRY classification.

Response: `{"job_id": "JOB-...", "estimated_seconds": 12}`.

## SENTRY

### `GET /api/sentry/jobs/{job_id}`

Live processing status -- polled by the Processing View for the animation.

Response:
```json
{
  "job_id": "JOB-...",
  "records_processed": 347,
  "total": 500,
  "tier1_handled": 312,
  "tier2_handled": 35,
  "flagged_counts": {"pii": 41, "geo": 23, "comms": 12, "classified": 8, "multi": 7},
  "current_record": {
    "record_id": "SR-...", "flags": ["pii", "geo"], "confidence": 0.87
  }
}
```

### `GET /api/sentry/review-queue/{batch_id}`

Three-column kanban data.

Response:
```json
{
  "auto_cleared": [...records with confidence > 0.95, no flags...],
  "flagged": [...records with flags and tier1 confidence > 0.9...],
  "held": [...classification discrepancies, low confidence, aggregation risk...]
}
```

### `POST /api/sentry/review/{record_id}/approve` / `/reject` / `/modify`

Operator decisions. Each action logged to the append-only audit chain.

### `POST /api/sentry/export`

Build the sanitized dataset + redaction report + audit log.

Request: `{"release_authority": "FVEY|NATO|US|SPECIFIC_PARTNER", "format": "xlsx|csv|json"}`.
Response: `{"download_url": "/api/sentry/download/...", "expires_at": "..."}`.

## PULSE

### `GET /api/pulse/fleet-overview`

Heatmap data: rows=units, cols=equipment types, cells=MC rate.

Response:
```json
{
  "hero_metrics": {
    "fleet_mc_rate": 0.742, "fleet_mc_delta_7d": -0.021,
    "critical_assets": 12, "critical_delta": 3,
    "parts_on_order": 47, "parts_delta_7d": -5,
    "avg_days_nmc": 23.4, "avg_days_nmc_delta": 1.2
  },
  "heatmap": [
    {"unit": "CLB-6", "rates": {"JLTV": 0.58, "MTVR_CARGO": 0.73, ...}}
  ],
  "alerts": [...latest readiness/cannib/mismatch alerts...]
}
```

### `GET /api/pulse/risk-board`

Top-N assets by risk score.

Response:
```json
{
  "assets": [
    {
      "asset_id": "M21670-JLTV-001",
      "risk_score": 84, "equipment_type": "JLTV", "unit": "CLB-6",
      "primary_factor": "Transmission fault 2x in 90 days",
      "predicted_failure": "TRANS failure within 14 days",
      "confidence": 0.76,
      "last_maintenance_days": 47
    }, ...
  ]
}
```

### `GET /api/pulse/assets/{asset_id}`

Equipment deep-dive: maintenance timeline, fault chart, risk trend, forecast.

### `GET /api/pulse/cannibalization`

Needs + donors board for smart canibbalization.

### `GET /api/pulse/forecast?unit={unit_name}&window=14`

Readiness forecast line chart data.

### `POST /api/pulse/feedback/{prediction_id}`

Operator feedback: `{"correct": true|false}`. Written to DPO training queue.

## BASTION

### `GET /api/bastion/cop`

Initial COP state -- units, readiness halos, data-integrity pins.

Response:
```json
{
  "installation": "Camp Henderson",
  "center": {"lat": 34.658, "lon": -77.398},
  "units": [
    {
      "unit": "CLB-6", "lat": ..., "lon": ..., "mc_rate": 0.58,
      "total_equipment": 70, "alerts": ["readiness_drop"], "integrity_flags": []
    }
  ],
  "supply_routes": [...optional AIS/road routes...],
  "active_incidents": []
}
```

### `GET /api/bastion/alerts/stream`

Server-sent events stream of correlated alerts (SENTRY, PULSE, BASTION, ThermalHawk).

### `POST /api/bastion/simulate/thermalhawk-detection`

Fires the demo's drone-over-motor-pool event.

### `GET /api/bastion/incidents/{incident_id}/response`

Auto-generated response checklist.

## RigRun proxy

### `POST /api/llm/chat`

Natural language query routed through RigRun's safety proxy. Disabled in
Lite Mode; returns 503 with `{"error": "llm_unavailable", "mode": "lite"}`.

## System

### `GET /api/system/status`

Mode (full/lite), RigRun reachability, model health, last dataset hash.

### `GET /api/system/audit`

Audit trail (Security Manager role only).

### `POST /api/system/secure-wipe`

Destructive. Confirmation token required. Wipes all local SPIRE state.
