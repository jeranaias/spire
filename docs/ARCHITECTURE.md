# SPIRE Architecture

Single-page summary of the runtime, data flow, and component boundaries.
Read this before touching any subsystem.

## Runtime

SPIRE is a **locally-served web app**. A Python FastAPI backend serves:
- Static React frontend bundles (built by Vite)
- REST endpoints for ingestion, processing, and inference
- Proxies for RigRun (Tier-2 LLM) when in Full Mode

No cloud. No outbound network calls outside the RigRun tunnel. The
backend's outbound-network monitor flags any attempted call that isn't to
the configured RigRun host.

```
+-----------------------+     +-----------------------+
|  React frontend       |     |  FastAPI backend      |
|  (Vite build, served  |<--->|  localhost:8700       |
|   at /)               |     |                       |
|  HashRouter           |     |  /api/*  endpoints    |
|  Zustand store        |     |  /static bundle       |
+-----------------------+     +-----------+-----------+
                                          |
                     +--------------------+--------------------+
                     |                    |                    |
                     v                    v                    v
              +-------------+    +-----------------+   +---------------+
              | SQLite      |    | SENTRY Tier-1   |   | RigRun proxy  |
              | (encrypted  |    | HawkStack       |   | (Full Mode    |
              |  at rest)   |    | classifier      |   |  only)        |
              +-------------+    | PULSE predictor |   +---------------+
                                 | ThermalHawk-Nano|
                                 +-----------------+
```

## Data flow

```
                  User uploads CSV/XLSX
                          |
                          v
                  +-----------------+
                  | Ingestion       |  schema normalize, dedupe, quality
                  | (backend)       |  check
                  +--------+--------+
                           |
                           v
                  +-----------------+
                  | SENTRY          |  Tier-1 classifier (~100K params, CPU)
                  | - Tier 1 cascade|  handles 90%+ on CPU
                  | - Tier 2 LLM    |  Tier-2 RigRun LLM for ambiguous (10%)
                  | - Human review  |
                  +--------+--------+
                           |
                           v
                  +-----------------+
                  | Sanitized       |
                  | dataset +       |  SQLite (encrypted), audit log
                  | audit trail     |
                  +--------+--------+
                           |
             +-------------+-------------+
             |                           |
             v                           v
      +-------------+            +--------------+
      | PULSE       |            | BASTION      |
      | risk score  |            | map overlays |
      | forecast    |            | alert stream |
      | cannib      |            | response     |
      +-------------+            +--------------+
```

## Modules

### Frontend (`frontend/`)
- `src/App.tsx` — Root layout (TopBar + Outlet + StatusFooter)
- `src/main.tsx` — Entry point, HashRouter configuration
- `src/views/` — SENTRY / PULSE / BASTION top-level views
- `src/components/` — Shared TopBar, StatusFooter, ErrorBoundary
- `src/state/store.ts` — Zustand store: role, operating mode, alert counter
- `src/index.css` — Tailwind 4 theme + @theme palette tokens

### Dataset engine (`dataset/`)
- `config.py` — Constants, OPTEMPO tables, sensitivity rules, tuning knobs
- `data/` — JSON ground truth: units, equipment profiles, installation
- `fleet.py` — Asset class + deterministic fleet generation
- `personnel.py` — Synthetic Marine roster
- `faults.py` — Fault triggering (age + post-maintenance modifiers)
- `remarks.py` — Template filler + shop-voice perturbations
- `sensitive.py` — Sensitive-element injection + classification derivation
- `supply.py` — Parts requisition + supply chain progression
- `lifecycle.py` — 365-day simulation loop, SR state machine
- `consistency.py` — 15 cross-record validators + DQ injection + cannib
- `incidents.py` — 100 installation-incident generator for BASTION
- `export.py` — Formatted XLSX writer (GCSS-MC / DRRS-MC look)
- `main.py` — Orchestrator CLI
- `tests/` — pytest suite: consistency, determinism, realism, SENTRY labels

### Models (`models/`)
- `sentry_classifier/build_corpus.py` — 15K labeled remark corpus builder
- `sentry_classifier/train.py` — **TODO** Tier-1 Thornveil training protocol training script
- `pulse_predictor/train.py` — **TODO** 1D-temporal CNN with CWRU option
- `thermalhawk/` — **TODO** HIT-UAV benchmark + fine-tune

### Docs (`docs/`)
- `SPIRE_SPEC_FINAL.md` — product + UI + Q&A
- `MDM_Hackathon_Technical_Specs_v3_FINAL.md` — HawkStack-centric technical
- `ARCHITECTURE.md` — this file
- `API.md` — backend endpoint contract

## Invariants

- **Fleet MC-only average stays in 65-82%**. Tests enforce.
- **Zero consistency-check errors** on canonical run. Tests enforce.
- **Determinism under RANDOM_SEED=42**. Same inputs produce byte-identical outputs. Tests enforce.
- **All sensitive remarks carry ground-truth classification labels** aligned with detection rules. Tests enforce.
- **No outbound network calls** outside the RigRun tunnel. Backend monitor (TBD).
- **No AI attribution anywhere in the repo.** Cardinal rule, never violated.

## Build & test

```bash
# Backend (Python 3.10+)
cd dataset && python -m venv ../.venv && ../.venv/Scripts/python -m pip install -r requirements.txt
cd dataset && python main.py                       # regenerates full dataset
cd dataset && python -m pytest tests/ -v           # runs 12-test suite

# Frontend (Node 22+)
cd frontend && npm install && npm run build        # clean production build
cd frontend && npm run dev                         # hot-reload at :5173
```

## Deployment posture

For the hackathon demo: localhost Python backend + bundled React static assets
served from `/`. Judges see a browser; they never see the engine behind it.

For production (post-hackathon): Electron wrapper for desktop distribution, or
a sysvinit/systemd service on government hardware. Both modes are supported by
the existing module boundaries -- nothing in SENTRY/PULSE/BASTION assumes a
specific runtime.
