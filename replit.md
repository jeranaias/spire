# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## MARLOG — Marine Logistics Calculator

Offline-capable Marine Corps sustainment planning tool aligned to MCWP 4-11 doctrine.
Supports Class I (subsistence), Class III(P) (POL/power), Class V (ammo, weapon-driven), Class VIII (medical),
Class IX (repair parts). Calculates Days of Supply per unit (climate × tempo × personnel × days),
flags deficiencies (red <2 DOS, amber <5, green ≥5), schedules resupply events, and simulates
sync with SPIRE (Master Data Management) including a real outbox queue, per-record push results,
and catalog reconciliation report.

A "Push to SPIRE as PR" feature opens a real GitHub pull request against the SPIRE master-data
repository from three planning surfaces: the standalone Calculator (an ad-hoc requirements bill),
a Unit detail page (current on-hand supply snapshot), and a Schedule page (comms-denied resupply
schedule). Each push commits a JSON payload under `proposals/marlog/<kind>/<branch>.json` to a
new branch and opens a PR titled with the source label. The shared `/spire-prs` page lists all
MARLOG-opened PRs with live state (open/merged/closed) refreshed against GitHub on demand.
Repo coords come from env vars `SPIRE_GITHUB_REPO_OWNER`, `SPIRE_GITHUB_REPO_NAME`, and
optional `SPIRE_GITHUB_BASE_BRANCH` (default `main`); the GitHub API token is fetched from the
Replit GitHub connector. When the env vars are unset the button still renders but the dialog
shows "SPIRE repo not configured" and submission is disabled — no silent fallback.

Class V (Ammunition) uses doctrinal weapon-system-driven burn rates (Σ weapon_qty × per-weapon DODIC rate)
across three postures: combat_load (total issue target), assault (daily high-intensity), sustain (daily
steady-state). Each unit has GCE/Non-GCE classification. Weapon systems have per-DODIC rates for both GCE
and Non-GCE configurations. The frontend "Class V / Weapons" tab allows posture/GCE toggle, weapon
assignment management, and combat load gap visualization. Weapon assignments can also be configured
during unit creation (`/units/new`, staged locally then POSTed after the unit exists) and edited inline
on the dedicated unit edit page (`/units/:id/edit`, immediate-save via the weapons API).

Artifacts:
- `artifacts/logistics` — React + Vite frontend (path `/`), TanStack Query offlineFirst caching,
  sidebar navigation: Dashboard / Units / Calculator / Sync. Command-center dark UI (navy-black canvas, cyan accent, Space Mono headers).
  Public read-only share view at `/s/:shareToken` (no sidebar) lets receiving units open a
  published pre-coordinated schedule and download the same client-side PDF for offline handoff
  via the shared `<ScheduleView shareMode />` component and `lib/schedule-pdf.ts`
  (`downloadSchedulePdf`). The `Email` action on the schedule page opens a `mailto:` draft via
  `buildScheduleMailtoUrl`; recipients are pre-filled from the receiving unit's
  `distroEmails` array (S-4, supporting battalion, logistics POCs, etc.), edited on the
  unit edit page (`/units/:id/edit` → "Schedule Distribution List" textarea).
- `artifacts/api-server` — Express 5 API at `/api`, routes: units, supply, resupply, calculate,
  catalog, dashboard (summary/deficiencies/forecast/activity, plus `class/:supplyClass`
  drill-down used by the dashboard's clickable Class Breakdown rows → `/classes/:supplyClass`),
  sync. Centralized error handler maps Zod errors → 400 and Postgres FK/unique violations → 409.
  Background schedulers: auto-sync (`startAutoSyncScheduler`) and a weekly
  comms-hygiene email (`startCommsHygieneScheduler` in
  `src/lib/comms-hygiene.ts`) that re-runs the shared `runDistroAudit`
  (`src/lib/distro-audit.ts`, also backing `GET /dashboard/distro-audit`)
  and emails a digest of flagged units — with `/units/:id/edit` deep links —
  to the regiment S-6 via SMTP. Suppressed when zero malformed entries.
  Every scheduled or on-demand run is persisted to the
  `comms_hygiene_runs` table (timestamp, audit counts, recipients, outcome,
  SMTP error if any) so the dashboard's "Last digest" line and the
  collapsible "Recent digest runs" history both survive API restarts. The
  history list is exposed at `GET /dashboard/comms-hygiene-runs?limit=N`
  (newest first, capped at 200). The dashboard also surfaces a footnote
  underneath the recent-runs panel showing total stored row count and the
  projected expiry of the oldest row, backed by
  `GET /dashboard/comms-hygiene-stats` so planners can see the prune
  policy is working. The same footnote also exposes an inline "Edit"
  control that lets planners override `COMMS_HYGIENE_RETENTION_DAYS` at
  runtime without restarting the API — the override is persisted in the
  single-row `comms_hygiene_settings` table and read on every prune tick
  and stats request, with a "Reset" button to clear it and fall back to
  the env default. Backed by `GET` and `PUT
  /dashboard/comms-hygiene-settings`; every change writes an
  `activity` row of kind `comms_hygiene_retention_changed` for audit.
  Configured via env vars: `COMMS_HYGIENE_ENABLED`, `COMMS_HYGIENE_TO`,
  `COMMS_HYGIENE_CC`, `COMMS_HYGIENE_INTERVAL_HOURS` (default 168 = weekly),
  `COMMS_HYGIENE_RETENTION_DAYS` (default 180; daily sweep deletes
  `comms_hygiene_runs` rows older than this so the audit table can't grow
  without bound — set to 0 to disable. The DB-backed override above wins
  when set. Sweep runs even when the digest scheduler itself is disabled,
  since manual "Send Digest Now" still appends rows.), `COMMS_HYGIENE_FROM`,
  `MARLOG_PUBLIC_BASE_URL`, plus
  standard SMTP vars (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`,
  `SMTP_PASS`). When SMTP is unconfigured the digest is logged instead of sent.
- `lib/db` — Drizzle schemas: units, catalog_items, catalog_item_deletions
  (snapshot table backing the catalog delete undo window), supply_entries,
  resupply_events, activity, sync_state, sync_outbox, sync_runs,
  weapon_systems, weapon_dodic_rates, unit_weapons, comms_hygiene_runs
  (audit trail for the comms-hygiene digest scheduler), comms_hygiene_settings
  (single-row table storing the in-app retention override).
- `lib/api-spec` — OpenAPI YAML, single source of truth (Orval codegen).
  Audited (Task #175): all 58 spec operations have a 1:1 matching Express
  handler, and every endpoint cross-reference inside `description:` text
  resolves to a real operation. Intentional REST gaps (no `DELETE
  /resupply/{eventId}` — cancellation is `PATCH status: "cancelled"`; no
  `POST /catalog/items` collection — items are seeded or auto-created via
  `POST /units/{unitId}/supply` custom-item path; no list/create/delete on
  weapon DODIC rates — seed-only matrix; no row-scoped `GET /sync/outbox/{id}`
  — list payload is complete; no `PATCH`/`DELETE` on baselines or published
  schedules — both are immutable / append-only audit records) are now
  documented in the relevant operation's `description:` so they aren't
  mistaken for missing endpoints.
- `scripts/src/seed.ts` — seeds 9 units + 26 catalog items + 11 weapon systems + 13 DODIC rate rows
  + unit weapon assignments + supply/resupply/activity/sync rows.
  Run with `pnpm --filter @workspace/scripts run seed`.

Logistics constants live in `artifacts/api-server/src/lib/logistics.ts`
(climate/tempo multipliers, status thresholds, readiness weighting).

## Deployment

- `Dockerfile` — multi-stage Node 24 + pnpm with two targets:
  `marlog-api` (Express runtime, port 3000) and `marlog-web` (nginx serving
  the Vite SPA and proxying `/api`, port 80). Build context is trimmed by
  `.dockerignore`.
- `docker-compose.yml` — local stand-up: `marlog-api`, `marlog-web`,
  `marlog-db` (Postgres 16). UI on http://localhost:8080.
- `deploy/nginx.conf` — baked into `marlog-web`. Upstream `marlog-api:3000`,
  SPA history fallback, long cache for `/assets`, `/healthz` for orchestrators.
- `fly.marlog.toml` — Fly.io companion to SPIRE's `fly.toml`. Two-app deploy
  (`marlog-api` + `marlog-web`); see `deploy/FLY_DEPLOY.md` for the full
  procedure.
- `.github/workflows/ci.yml` — `pnpm install --frozen-lockfile` →
  `pnpm run build`, then builds both Docker images. Vite build needs `PORT`
  and `BASE_PATH` (set in workflow env and Dockerfile).

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/api-server run test` — run API unit + integration tests (vitest, hits the dev DB; `pnpm --filter @workspace/db run push` first if the schema is stale)

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
