# MARLOG — Marine Logistics Calculator

**A sibling module under [SPIRE](https://github.com/jeranaias/spire) (MDM 2026 / MARCORLOGCOM CDAO).**

MARLOG is an offline-capable Marine Corps sustainment-planning tool aligned to
MCWP 4-11 doctrine. It covers the five sustainment classes a planner touches
most during a planning cycle and produces a Days-of-Supply (DOS) estimate per
unit that accounts for climate, operational tempo, personnel count, and planning
horizon.

---

## Doctrinal scope

| Class | Category | Notes |
|-------|----------|-------|
| Class I | Subsistence | Rations planning |
| Class III(P) | POL / power | Packaged petroleum products |
| Class V | Ammunition | Consumption-rate based |
| Class VIII | Medical | Basic medical supplies |
| Class IX | Repair parts | Forecast tracked separately |

Status thresholds follow MCWP 4-11 guidance:
- **Red** — < 2 DOS (critical deficiency)
- **Amber** — < 5 DOS (watch)
- **Green** — ≥ 5 DOS (adequate)

---

## Relationship to SPIRE

MARLOG is dropped into SPIRE as a self-contained sibling module (`marlog/` at
the SPIRE repo root). It does **not** port onto SPIRE's Python/FastAPI backend
or share its database. MARLOG's Sync surface pushes sustainment outbox records
into SPIRE's Master Data Management (MDM) ingest API over HTTP — the target is
configured via `SPIRE_MDM_URL` (see *Environment variables* below) and defaults
to a local SPIRE backend at `http://localhost:8000` for development. Records
that fail to push (network error, validation rejection, etc.) stay queued in
the outbox and surface as failed entries on the Sync page so the planner can
retry or dismiss them. Shared auth, shared DB, and Docker bundling remain
follow-up work documented in the PR description.

---

## Artifact layout

```
marlog/
├── artifacts/
│   ├── logistics/          # React + Vite frontend (preview path: /)
│   └── api-server/         # Express 5 API (preview path: /api)
├── lib/
│   ├── db/                 # Drizzle ORM schemas (PostgreSQL)
│   └── api-spec/           # OpenAPI YAML — single source of truth (Orval codegen)
├── scripts/
│   └── src/seed.ts         # Seed script — 4 units, 17 catalog items, supply/sync rows
├── package.json            # pnpm workspace root
├── pnpm-workspace.yaml     # Workspace + catalog config
└── README.md               # This file
```

### Frontend — `artifacts/logistics`

React 19 + Vite 7 single-page app. Uses TanStack Query with `offlineFirst`
network mode so the planner can work without a live API. Navigation:

- **Dashboard** — fleet readiness summary, deficiency counts, activity feed
- **Units** — per-unit readiness cards with DOS status badges
- **Calculator** — interactive DOS calculator (climate × tempo × personnel × days)
- **Sync** — SPIRE MDM sync surface: outbox queue, push results, catalog reconciliation report

Design: command-center dark UI (navy-black canvas, cyan accent, Space Mono headers).

### API server — `artifacts/api-server`

Express 5 REST API. Routes: `units`, `supply`, `resupply`, `calculate`,
`catalog`, `dashboard` (summary / deficiencies / forecast / activity), `sync`.
Centralized error handler maps Zod validation errors → 400 and Postgres FK /
unique violations → 409.

Logistics constants (climate/tempo multipliers, status thresholds, readiness
weighting) live in `artifacts/api-server/src/lib/logistics.ts`.

### Database — `lib/db`

Drizzle ORM schemas targeting PostgreSQL. Tables: `units`, `catalog_items`,
`supply_entries`, `resupply_events`, `activity`, `sync_state`, `sync_outbox`,
`sync_runs`.

### API spec — `lib/api-spec`

OpenAPI 3 YAML. Run Orval codegen (`pnpm --filter @workspace/api-spec run codegen`)
to regenerate typed React Query hooks and Zod schemas from the spec.

---

## Quick start

**Prerequisites:** Node.js 24+, pnpm 9+, PostgreSQL (or `DATABASE_URL` pointing
at an existing instance).

```bash
# 1. Install dependencies
pnpm install

# 2. Push the DB schema (first time only)
pnpm --filter @workspace/db run push

# 3. Seed reference data
pnpm --filter @workspace/scripts run seed

# 4. Start the API server
pnpm --filter @workspace/api-server run dev

# 5. Start the frontend (separate terminal)
pnpm --filter @workspace/logistics run dev
```

### Environment variables

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `DATABASE_URL` | yes | — | PostgreSQL connection string used by `@workspace/db`. |
| `PORT` | yes | — | Port the API server binds to. |
| `SPIRE_MDM_URL` | no | `http://localhost:8000` | Base URL of the SPIRE backend that MARLOG's sync surface pushes to. The Sync page POSTs each outbox record to `${SPIRE_MDM_URL}/api/mdm/ingest` and reconciles the local catalog against `${SPIRE_MDM_URL}/api/mdm/catalog`. Override this in production to point at the deployed SPIRE instance (for example, `https://spire.example.gov`). When SPIRE is unreachable, records remain in the outbox marked `failed` (with the underlying error surfaced in the Sync page's Last Sync Result and Pending Outbox panels) and `/api/sync/status` returns `connected: false` so callers can detect the outage. |
| `LOG_LEVEL` | no | `info` | Pino log level for the API server. |

### Build

```bash
pnpm run build        # typecheck + build all packages
pnpm run typecheck    # typecheck only (no emit)
```

### Regenerate API client

```bash
pnpm --filter @workspace/api-spec run codegen
```

### Push DB schema changes (dev only)

```bash
pnpm --filter @workspace/db run push
```

---

## Stack

| Layer | Technology |
|-------|-----------|
| Monorepo | pnpm workspaces |
| Node.js | 24 |
| TypeScript | 5.9 (strict) |
| Frontend | React 19 + Vite 7 |
| API | Express 5 |
| Database | PostgreSQL + Drizzle ORM |
| Validation | Zod v4, drizzle-zod |
| API codegen | Orval (from OpenAPI spec) |
| Build | esbuild (CJS bundle) |

---

## Deployment

MARLOG ships with a multi-stage `Dockerfile` (Node 24 + pnpm) exposing two
build targets — `marlog-api` (Express runtime) and `marlog-web` (nginx
serving the SPA and proxying `/api`). The root `docker-compose.yml` brings
both services up alongside Postgres for local stand-up, and
`fly.marlog.toml` is the Fly.io companion config that deploys MARLOG
alongside SPIRE's main app. CI in `.github/workflows/ci.yml` runs
`pnpm run build` and builds both images on every push.

See [`deploy/FLY_DEPLOY.md`](deploy/FLY_DEPLOY.md) for the full procedure.

```bash
# Local stand-up (UI on http://localhost:8080)
docker compose up --build
```

---

## License

MARLOG is contributed to SPIRE as a government work product (MDM 2026,
MARCORLOGCOM AI Forum Hackathon, 27–30 April 2026, on duty time by uniformed
USMC personnel). See `LICENSE.md` for the full IP notice governing SPIRE
contributions, including the Thornveil LLC pre-existing IP boundary.

---

## Security

See `SECURITY.md` for the vulnerability reporting path. Do not open public
GitHub issues for security vulnerabilities.
