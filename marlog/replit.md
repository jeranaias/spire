# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## MARLOG — Marine Logistics Calculator

Offline-capable Marine Corps sustainment planning tool aligned to MCWP 4-11 doctrine.
Supports Class I (subsistence), Class III(P) (POL/power), Class V (ammo), Class VIII (medical),
Class IX (repair parts). Calculates Days of Supply per unit (climate × tempo × personnel × days),
flags deficiencies (red <2 DOS, amber <5, green ≥5), schedules resupply events, and simulates
sync with SPIRE (Master Data Management) including a real outbox queue, per-record push results,
and catalog reconciliation report.

Artifacts:
- `artifacts/logistics` — React + Vite frontend (path `/`), TanStack Query offlineFirst caching,
  sidebar navigation: Dashboard / Units / Calculator / Sync. Command-center dark UI (navy-black canvas, cyan accent, Space Mono headers).
- `artifacts/api-server` — Express 5 API at `/api`, routes: units, supply, resupply, calculate,
  catalog, dashboard (summary/deficiencies/forecast/activity), sync. Centralized error handler
  maps Zod errors → 400 and Postgres FK/unique violations → 409.
- `lib/db` — Drizzle schemas: units, catalog_items, supply_entries, resupply_events,
  activity, sync_state, sync_outbox, sync_runs.
- `lib/api-spec` — OpenAPI YAML, single source of truth (Orval codegen).
- `scripts/src/seed.ts` — seeds 4 units + 17 catalog items + supply/resupply/activity/sync rows.
  Run with `pnpm --filter @workspace/scripts run seed`.

Logistics constants live in `artifacts/api-server/src/lib/logistics.ts`
(climate/tempo multipliers, status thresholds, readiness weighting).

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

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
