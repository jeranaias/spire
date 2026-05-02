// CLASSIFICATION: UNCLASSIFIED // FOUO //

# SPIRE Operational Build — trim plan

## Context

SPIRE took first place at MDM 2026 (30 APR). Top judging-panel
feedback: **"looks cluttered."** Real CWO and SSgt operators in
sustained use will hit cognitive overload — every screen tries to be
operationally complete because that's the demo posture, but a Maint
Chief opening PULSE Risk Board to find their three deadlined trucks
shouldn't see the predicted-failure panel + recommend-actions panel
+ cannib matcher all at once.

This plan creates a cleaned-up "operational" build that's the
default for pilot deployments, while preserving the busier "demo"
build for judging panels and stakeholder showcases. Same codebase,
one env flag.

## Strategy: branch + permanent env flag

1. **Branch first.** Work happens on `operational`; `master` keeps
   serving the demo build untouched until we're ready.
2. **Plumb the flag while we're there.** `VITE_SPIRE_BUILD=demo`
   (default for now) vs `VITE_SPIRE_BUILD=operational`. A
   `useBuildMode()` hook reads it; `<DemoOnly>` and
   `<OperationalOnly>` wrappers conditionally render chrome.
3. **Merge back to master with the flag default flipped.**
   `master` ships operational; demo build comes back via build
   arg / Fly secret when we need it. Drift between the two is
   one env var, not a fork.

## Phases

### P1. Branch + flag plumbing (½ day)

- Create branch `operational` (done).
- Add `frontend/.env.example` documenting `VITE_SPIRE_BUILD`.
- New `frontend/src/state/buildMode.ts`:
  - `useBuildMode()` returns `"demo" | "operational"`
  - `<DemoOnly>` / `<OperationalOnly>` wrappers
  - `isDemo()` / `isOperational()` helpers for non-React code
- Read `import.meta.env.VITE_SPIRE_BUILD` at module init; default
  `"demo"` so existing behavior is preserved.
- Backend: equivalent `SPIRE_BUILD` env passed through `/api/system/build-mode`
  so the two stay in sync (e.g. dataset-status copy).

### P2. TopBar diet (½ day)

Today: 8 chips — FPCON / DDIL / Comms / Alerts / Joint COP / Mode
/ Marine Made / version. On a 1366×768 issued laptop that's a
full inch of vertical chrome.

Operational:
- **Keep:** FPCON, Comms state, Alerts badge, identity pill.
- **Move to "+more" popover:** Joint COP shortcut, Mode (full
  vs lite), DDIL state.
- **Demo-only:** Mission Clock H+ countdown, "PRE-CONFLICT"
  phase dropdown, "BASE DEFENSE / Camp Henderson · 2d MLG"
  mission pill, "MARINE MADE" chip.

### P3. Banners + footer chrome (½ day)

- Classification banner: keep the band, swap the *copy*. Operational
  reads "UNCLASSIFIED // FOUO" or whatever the live DoDM 5200.01
  marking actually is. Demo keeps "UNCLASSIFIED // DEMO DATA //
  NOT FOR OPERATIONAL USE".
- StatusFooter: drop "MARINE MADE", "SPIRE V1.0.0-RC1 · MDM 2026",
  "synthetic dataset · seed=42 · deterministic replay" chips.
  Keep audit chain hash, LLM tier, network egress, encryption,
  dataset count, integrity counter.

### P4. Per-tab walkthrough copy strip (1 day)

Every tab today opens with a 2-3 sentence "Walkthrough #X — operator-readable
copy" intro. In operational, those become one short subtitle or
disappear. List of tabs touched:

- SENTRY: MarkTab, ProcessingTab, ReviewQueueTab, ExportTab,
  CoalitionTab, UploadTab
- PULSE: OverviewTab, RiskBoardTab, CannibTab, ForecastTab, ModelTab
- BASTION: top description, alert panel intro
- Admin: AuditView intro, ModelRegistryView intro

Pattern: the *what* the page is for moves to the breadcrumb /
title; the *how* moves to the help overlay (`?` key).

### P5. ProcessingTab honesty pass v2 (½ day)

Today: scanline animation + animated record cards = pure theater.
The engine ran synchronously on the backend; we're animating
post-hoc. Operationally, swap for:
- Real progress bar tied to the actual job status
- Final result table with sortable columns
- Same engine timing + tier counters above

Demo build keeps the scanline (it photographs better in 30-second
demo videos).

### P6. MarkTab clutter (½ day)

- 3 sample chips ("Motor pool fault remark" / "Radar fault
  (classified TM)" / "Deployed convoy brief") → demo-only.
- Operational: "Recent drafts" panel populated from
  localStorage history (the Recent Attestations panel already
  built).
- Bulk CSV drop stays — operationally useful.
- Tier-2 explainer panel stays.

### P7. SPIRO panel slim (½ day)

- 5 example prompts → behind `?` toggle in panel header,
  dismissed once per session.
- Strip "Tell SPIRO what you want. SPIRO plans; you approve
  before anything runs." intro — once an operator's used it,
  it's noise.
- Cost / latency / tier chip stays — operators want to see what
  each call cost.

### P8. BASTION map default (½ day)

- Threat rings (DF-21D / YJ-12) default **off**. Toggle in the
  layer controls.
- ThermalHawk sim button → toolbox menu, not always-visible.
- Marker drawer: collapse "Symbology" + "Position" sections by
  default; readiness/PULSE summary is the headline.

### P9. PULSE per-role panel collapse (1 day)

Default-collapsed panels per role:
- **Maint Chief:** Risk Board only (their unit). "+ Predicted
  failures (11 flagged)" / "+ Recommend actions" as expanders.
- **G-4:** Risk Board + Forecast. Recommend Actions
  collapsed-but-loaded.
- **MEF Commander:** all expanded.
- **Data Custodian:** PULSE not their primary view; minimal.

State persists per DODID in localStorage.

### P10. Density toggle (½ day)

Footer toggle: **Compact / Standard / Briefing**.
- Compact: half the vertical padding → ~2× SR rows on screen.
- Standard: today's spacing.
- Briefing: 1.4× font, projector-friendly.

Persists per DODID. Operational default: Standard. Demo /
briefing default: Briefing.

### P11. Tooltip + label noise sweep (½ day)

- Drop redundant tooltip copy ("Click to do X" when button
  text is "X").
- Strip "Walkthrough #N audit" / "Task-NN fix" prose visible
  in operator-facing copy.
- Pure prose pass; should remove ~200 LOC of demo verbiage
  without any logic change.

### P12. Verification (½ day)

Playwright run that screenshots every view in both modes:
- demo (`VITE_SPIRE_BUILD=demo`)
- operational (`VITE_SPIRE_BUILD=operational`)

Side-by-side check confirms no operationally-critical content
got hidden by mistake.

### P13. Merge + flag default flip (¼ day)

- Merge `operational` to `master`.
- Default `VITE_SPIRE_BUILD=operational` everywhere.
- Fly secret: leave operational on the live `spire-mdm.fly.dev`.
- Build arg / preview path lets demo nights flip back to demo
  without redeploying code.

## Total

≈ 6 working days.

## What absolutely stays (regulatory + workflow load-bearing)

- Classification banner (DoDM 5200.01 — non-negotiable)
- FPCON indicator
- Audit chain hash chip (provenance)
- Tier-2 grounding paragraphs (the work product)
- Distribution Statement / REL TO on every marking
- LLM tier indicator (`LLM · 26B / E4B / RULE`)
- All workflows themselves
- Role scoping
- Audit-log viewer
- All ingest paths (Decision Bridge, GCSS-MC export upload)

## What we get out of this

- Cleaner first impression for the next pilot CWO.
- Single codebase, one env var to switch posture.
- Demo build still available — judging panels and flag-officer
  briefings keep the polish.
- ~30% less visual noise on every screen.
- Lower cognitive load for sustained operator use (the actual
  pilot win condition).

// CLASSIFICATION: UNCLASSIFIED // FOUO //
