# Changelog — MARLOG

All notable changes go here. Format: keep-a-changelog. Date format: YYYY-MM-DD.

---

## [Unreleased]

## [0.1.0] · 2026-04-28 · Initial drop into SPIRE

### Added

- **MARLOG module** — offline-capable Marine Corps sustainment-planning tool
  aligned to MCWP 4-11, contributed to SPIRE as a sibling module under
  `marlog/`.
- **`artifacts/logistics`** — React 19 + Vite 7 frontend. Sidebar navigation:
  Dashboard / Units / Calculator / Sync. Command-center dark UI (navy-black
  canvas, cyan accent, Space Mono headers). TanStack Query offlineFirst caching
  for edge / disconnected operations.
- **`artifacts/api-server`** — Express 5 REST API. Routes: `units`, `supply`,
  `resupply`, `calculate`, `catalog`, `dashboard` (summary / deficiencies /
  forecast / activity), `sync`. Centralized Zod + Postgres error handler.
- **`lib/db`** — Drizzle ORM schemas targeting PostgreSQL. Tables: `units`,
  `catalog_items`, `supply_entries`, `resupply_events`, `activity`,
  `sync_state`, `sync_outbox`, `sync_runs`.
- **`lib/api-spec`** — OpenAPI 3 YAML, single source of truth. Orval codegen
  produces typed React Query hooks and Zod schemas.
- **`scripts/src/seed.ts`** — Seeds 4 units, 17 catalog items, and
  representative supply / resupply / activity / sync rows for development and
  demo use.
- **Doctrinal coverage** — Class I (subsistence), Class III(P) (POL/power),
  Class V (ammo), Class VIII (medical), Class IX (repair parts). DOS thresholds:
  Red < 2, Amber < 5, Green ≥ 5.
- **Sync simulation** — outbox queue with per-record push results and a catalog
  reconciliation report, simulating MDM integration with SPIRE.
- **Project-level docs** — `README.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `LICENSE.md`, `CHANGELOG.md` aligned to SPIRE contribution conventions.
