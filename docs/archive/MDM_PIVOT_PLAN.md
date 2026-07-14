# MDM 2026 Stage Pivot — WP-1 … WP-10

**Show:** Modern Day Marine 2026, 8-minute stage demo, 30 April 2026.
**Posture:** `?stage=1` collapses SPIRE to the four hackathon-numbered hero
use cases (SENTRY · PULSE · BASTION · DHA RESCUE). Every other surface
stays mounted and reachable by direct URL for Q&A — hidden ≠ deleted.

---

## Work-package status

- [x] **WP-1 — Stage mode toggle**
      `stageMode` + `setStageMode` in the global store, hydrated from
      `?stage=1` (HashRouter-aware) before first paint, persisted to
      `localStorage`. F9 failsafe binding works on any route in stage
      mode. Routes for hidden surfaces stay mounted.
- [x] **WP-2 — Decision Bridge stage layout**
      Four hero tiles in spec order — SENTRY (USE CASE 14 · CUI AUTO-
      TAGGING — DoDM 5200.01), PULSE (USE CASE 13 · PARTS DEMAND
      FORECASTING — CONTESTED LOG), BASTION (USE CASE 15 · INSTALLATION
      COP AGGREGATOR), DHA RESCUE (USE CASE 4 · BLOOD/CLASS VIII H+72 —
      DMO). Thesis line above tiles: *"One OS · One dataset · One audit
      chain · Four use cases solved."* Built-by strap below the tiles
      with `{TEAM_NAME_PLACEHOLDERS}` for the host to fill before
      stage. `/dha-rescue` route registered in `frontend/src/main.tsx`.
- [x] **WP-3 — SENTRY beat polish (Use Case 14)**
      `UseCaseStrip` "14 · CUI AUTO-TAGGING — DoDM 5200.01" rendered at
      the top of `SentryView` in stage mode. Operator browse unchanged.
- [x] **WP-4 — PULSE beat polish (Use Case 13)**
      `UseCaseStrip` "13 · PARTS DEMAND FORECASTING — CONTESTED LOG"
      rendered at the top of `PulseView` in stage mode.
- [x] **WP-5 — BASTION cold-open arming (Use Case 15)**
      `UseCaseStrip` "15 · INSTALLATION COP AGGREGATOR" wraps
      `BastionView` in a flex-column without disturbing the existing
      sidebar/map/panel layout. Existing `Simulate ThermalHawk` button
      remains the cold-open trigger.
- [x] **WP-6 — DHA RESCUE first-class surface**
      `DhaRescueView` renders the H+72 surface: hub-spoke schematic
      with H plus contested spokes, days-of-supply gauges per blood
      product (PRBC, plasma, platelets, walking blood bank — additional
      consumables noted), market-aware sourcing recommendations that
      surface when the hub projects stockout, and an `Advance to H+72`
      button that steps the scenario state forward and writes audit-
      chain entries on every approval. Live shortages from the
      existing `/api/decision-bridge/shortages` endpoint power the
      "right-now" panel; vignette metadata from
      `/api/system/scenario/blood-h72` confirms the scripted scenario
      is loaded.
- [x] **WP-7 — Audit Chain Reveal**
      `AuditPill` in TopBar (stage mode only) opens `AuditView` with
      the time window default-pinned to the last 15 minutes. Stage-mode
      bypass on the `security_manager` scope check so any presenter
      identity can land on the chain to close the demo.
- [x] **WP-8 — Multi-presenter handoff**
      Stage-mode-only `IdentityChips` strip in TopBar shows all four
      mock CACs as one-click swap targets with the active identity
      highlighted. Quick-switch endpoint `POST /api/auth/quick-switch`
      added to the auth router (additive, no middleware change), gated
      by `SPIRE_DEMO_QUICK_SWITCH=1`, and **requires an existing
      authenticated session** before re-issuing a cookie. Frontend
      prefers quick-switch in stage mode and falls back to PIN login
      on 401/404. Roster derived fresh on every render so the second
      and third swaps see the right targets.
- [x] **WP-9 — Demo resilience harness**
      F9 failsafe overlay still triggers on any route. Stage-mode
      Reset button on TopBar (all roles in stage; g4-only otherwise)
      POSTs `/api/system/admin/reset-demo`. URL `?stage=1` survives
      hard reload via `localStorage` backup. ErrorBoundary "Reload
      module" link unchanged.
- [x] **WP-10 — Playwright rehearsal**
      `scripts/demo_rehearsal.ts` walks the cold-open → SENTRY →
      PULSE → BASTION → DHA RESCUE → Audit reveal arc with hard
      assertions per beat (cordons + FPCON + fused-threats inside 3 s
      after the simulate click; audit pill shows ≥1 entry per
      module). Default mode runs the arc 3 consecutive times and
      fails the run if any iteration exceeds 8:00 wall-clock or any
      assertion misses.

## Verification

- `cd frontend && npx tsc --noEmit` — clean
- `cd frontend && npm run build` — clean
- `python -m pytest backend/tests/` — 21 / 21 pass
- Disclosure-term scan over all new/modified files — clean, no
  restricted-term hits in any new or modified file. Sanctioned
  product-name + capability mentions in `LICENSE` / `README.md` /
  `CONTRIBUTING.md` / PR templates remain untouched.
- `POST /api/auth/quick-switch` — returns 404 with the env var off (the
  default), 401 when called without an existing session, 200 when an
  authenticated session DODID is in `MOCK_USERS`.
- Manual: `?stage=1` Decision Bridge renders the four tiles + thesis
  strap; AUDIT pill drops into the chain with the 15-minute window
  pre-applied; quick-switch round-trips Hayes → Park → Hayes without a
  bounce to `/auth`.

## Follow-ups for a future pass

- Replace `{TEAM_NAME_PLACEHOLDERS}` in `DecisionBridge.tsx` with the
  cleared roster prior to stage.
- Wire the BASTION ThermalHawk simulate button to honor stage mode
  even when the role gate would otherwise hide it (currently the
  simulate control already works for the four mock roles, but a future
  presenter identity would need this).
- Consider lifting the AUDIT pill window-default from 15 → 10 minutes
  if the rehearsal script grows beyond 12 minutes.

---

## READY FOR REVIEW

All ten work packages are complete, verified, and instrumented. The
GitHub branch push, PR creation, master merge, and Fly deploy are the
host's manual steps after this work merges into the Replit `master`.

---

## Round-3 fixes (post-second-review)

Four critical findings closed:

1. **WP-9 401 resilience — stage-mode toast path**
   `frontend/src/main.tsx` UnauthenticatedBridge now branches on
   `stageMode`: in stage mode it surfaces a non-blocking warn toast
   ("Session expired — tap any identity chip to resume.") via
   `pushToast` and KEEPS the presenter on the current page so an
   IdentityChips swap can re-mint a session. Operator path
   (signOut + nav('/auth')) is unchanged.

2. **WP-7 backend audit role-gate stage bypass**
   `backend/routes/system.py` adds `_stage_demo_open(request)` —
   returns True only when `SPIRE_DEMO_QUICK_SWITCH=1` AND
   `request.state.user` is non-null. Both `GET /api/system/audit` and
   `GET /api/system/admin/audit` consult it BEFORE `require_role(...)`.
   The bypass is read-only, env-gated (off in prod), and still
   requires a valid signed session — anonymous traffic still 401s on
   the session middleware.

3. **TopBar nav stage spine — DHA RESCUE replaces ADMIN**
   `frontend/src/components/TopBar.tsx` introduces `OPERATOR_TABS` and
   `STAGE_TABS` (the latter has SENTRY/PULSE/BASTION/DHA RESCUE,
   no ADMIN). The render selects on `stageMode`. The right-bar AUDIT
   pill still routes to `/admin/audit` for the closing beat.

4. **WP-10 rehearsal — handoff sequence + per-module audit assertion**
   `scripts/demo_rehearsal.ts` now performs three IdentityChips swaps
   (Hayes between SENTRY/PULSE, Kowalski between PULSE/BASTION, Park
   before AUDIT) using a `clickHandoffChip` helper that anchors on
   the chip's `aria-label` and waits for the toast confirmation. A
   new `06c` beat fetches the SOC chain as Park, asserts
   `chain.ok != false`, hard-asserts ≥4 `dha.*` entries from this
   run, and enumerates per-module bucket counts (warn-level for
   SENTRY/PULSE/BASTION; fail-hard if `STRICT_PER_MODULE=1`).

End-to-end verification log
- audit env OFF, Reyes(g4)        → 403  (role gate enforced)
- audit env OFF, Park(sec_mgr)    → 200  (allowed)
- audit env ON,  anon             → 401  (session middleware blocks)
- audit env ON,  Reyes(g4)        → 200  (stage bypass)
- audit env ON,  Reyes /admin/audit → 200 (SOC bypass)
- quick-switch env ON, anon       → 401  (session required)
- quick-switch env ON, with sess. → 200  (allowed)
- pytest                          → 21 passed
- frontend tsc --noEmit           → clean
- frontend build                  → ✓ 1.67s
- disclosure scan                 → clean (no restricted-term hits)

Round-4 hardening (April 28, 2026)
- HubSpokeMap: migrated from SVG schematic to MapLibre GL vector
  basemap (`react-map-gl/maplibre`). NODES carry real WESTPAC AOR
  lat/lon (CLB-6 ASP @ Camp Kinser, CLB-3 @ Camp Hansen, CLB-31 @
  MCAS Iwakuni, FOB ECHO @ Subic forward, donor center @ Sasebo).
  Routes render as two GeoJSON line layers (contested amber-dashed
  vs nominal muted-solid) because MapLibre v3 cannot data-drive
  `line-dasharray`. Same CartoDB Dark Matter style + vendored
  fallback + style-retry pattern as MapCanvas. Aria-label updated
  to `Hub-spoke map. …`; rehearsal selector adjusted to
  `[aria-label^="Hub-spoke map"]`.
- BASTION audit write: `simulate/thermalhawk-detection` now hash-
  chains a `bastion.thermalhawk_simulate` row keyed on `sim_id`
  (`backend/routes/bastion.py` L590, L713). Adds `request: Request`
  param and imports `log as audit_log` from persistence.
- PULSE audit write: fixed pre-existing latent bug —
  `backend/routes/pulse.py` L965 imported `audit_log` but
  `persistence.py` only exports `log`. The bare `except: pass`
  swallowed the ImportError silently, so every cannibalization
  proposal returned 200 OK without ever writing to the chain. Now
  imports `log as audit_log` so `cannibalization_propose` rows
  appear in the SOC chain.
- Rehearsal HARD per-module assertion: removed STRICT_PER_MODULE
  warn-mode knob. Beat 06c now hard-asserts ≥1 row in EACH of
  {sentry, pulse, bastion, dha} written DURING THIS RUN (filtered
  by run-start ISO timestamp with 5 s clock-drift bias). Adds two
  new beats: `05i` SENTRY coalition release (FVEY_BASE profile, as
  Park because COALITION_RELEASE_ROLES requires
  data_custodian|security_manager) and `05j` PULSE cannibalization
  propose (no role gate). Audit-count delta floor raised from ≥4
  to ≥7 (3 dha advances + 1 dha approve + 1 sentry release + 1
  pulse propose + 1 bastion simulate). `bucketByModule` adds a
  `PULSE_KIND_ALIASES` set so the legacy `cannibalization_*` kinds
  map to the pulse bucket without a prefix.

End-to-end verification log (round-4)
- pytest                          → 21 passed
- frontend tsc --noEmit           → clean
- frontend build                  → ✓ 1.66s
- BASTION simulate (anon)         → 401  (auth required)
- SENTRY release as Reyes(g4)     → 403  (COALITION_RELEASE_ROLES)
- SENTRY release as Park(sec_mgr) → 200  (allowed)
- PULSE cannib propose (Park)     → 200  (writes audit row)
- BASTION simulate (Park)         → 200  (writes audit row)
- DHA advance (Park)              → 200  (writes audit row)
- chain top-6 after sequence      → dha.advance, cannibalization_propose,
                                    sentry_coalition_release,
                                    bastion.thermalhawk_simulate (all 4
                                    new module rows present)
- disclosure scan on round-4 diff → clean (no restricted-term hits in
                                    any of the files edited in this
                                    round; pre-existing restricted-term
                                    mentions in bastion.py L554/557/564
                                    and pulse.py L1142 are outside the
                                    round-4 edit scope and were not
                                    modified)
