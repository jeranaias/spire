# Stage Rehearsal — Playwright End-to-End

`scripts/demo_rehearsal.ts` walks the four-use-case stage flow exactly
as a presenter would: cert sign-in → tile click → handoff → propose /
release / simulate / approve → AUDIT reveal. Each iteration writes
real audit rows to the live backend and fails loudly if any beat drifts.

## How to run

```bash
# Backend on :8000, Frontend on :5000 (workflows already configured).
ITERATIONS=3 npx tsx scripts/demo_rehearsal.ts
```

Environment knobs (see the script header for the full list):

- `ITERATIONS` — number of consecutive rehearsals (default 3).
- `PER_RUN_BUDGET_MS` — fail an iteration that exceeds this; default
  480000 (8 min). Task #30 acceptance is "≥1 iteration under 480s".
- `THERMAL_BUDGET_MS` — bound on the BASTION simulate fanout; default
  8000 (cold-mount BastionView lands in the 4–6s range on first
  iteration; a tighter budget produced false negatives even when the
  audit row was correctly written).
- `BACKEND` / `FRONTEND_URL` — override the targets if running against
  non-default ports.
- `HEADLESS=0` to watch the run in a real browser.

Playwright Chromium must be present:
`PLAYWRIGHT_BROWSERS_PATH=/home/runner/workspace/.cache/ms-playwright npx playwright install chromium`.

## What each iteration proves

20 strict beats per iteration; any failure aborts the iteration and
marks the run RED. The closing `06c` beat enforces that **each of
sentry / pulse / bastion / dha** wrote ≥1 fresh audit row from THIS
iteration (filtered by run-start timestamp), so a silent no-op
anywhere in the chain fails the rehearsal — not just a missing toast.

## Latest run (round-4 stabilization, 2026-04-28)

```
=== Stage rehearsal report ===
  ✓ iter 1: 12.3s (20 beats)
         01 · Boot stage Decision Surface (Reyes · g4)            2.46s
         01b · Snapshot audit count (pre)                         0.05s
         02 · Open SENTRY (USE CASE 14)                           0.63s
         02b · Return to bridge                                   0.27s
         02h · HANDOFF → Kowalski (maintenance_chief)             0.29s
         03 · Open PULSE (USE CASE 13)                            0.47s
         03b · Return to bridge                                   0.26s
         03h · HANDOFF → Hayes (mef_commander)                    0.31s
         04 · Open BASTION (USE CASE 15) + simulate ThermalHawk   2.77s
         04b · Return to bridge                                   0.29s
         05 · Open DHA RESCUE (USE CASE 4)                        1.04s
         05b · Advance to H+24 (writes audit row)                 1.02s
         05c · Advance to H+48                                    0.53s
         05d · Advance to H+72 + approve sourcing                 1.17s
         05e · PULSE cannibalization propose → audit (as Hayes)   0.07s
         05h · HANDOFF → Park (security_manager)                  0.38s
         05i · SENTRY coalition release (FVEY_BASE, as Park)      0.06s
         06 · Open AUDIT pill                                     0.17s
         06b · Audit count delta ≥7                               0.04s
         06c · Per-module audit kinds (sentry/pulse/bastion/dha)  0.05s
  ✓ iter 2: 10.5s (20 beats)
  ✓ iter 3: 10.8s (20 beats)

per-module audit rows from THIS run (per iteration):
  iter 1: sentry=1 pulse=1 bastion=1 dha=4
  iter 2: sentry=2 pulse=2 bastion=1 dha=8   (cumulative across iters)
  iter 3: sentry=2 pulse=2 bastion=1 dha=8

Result: 3/3 iterations within budget (480s).
```

Worst beat: BASTION simulate at ~4.3s on cold-mount iterations (the
remount of `BastionView` triggers a /alerts + /cop + /fused-threats
poll triplet before the click registers). Comfortably under the
THERMAL_BUDGET_MS=8000 cap.

## Common drift modes the rehearsal catches

| Symptom in script | Real bug it surfaces |
|-------------------|----------------------|
| `Sign in` button missing | AuthView submit button text changed |
| Onboarding modal intercepts click | Backend onboarding pref not seeded for this DODID |
| `Open audit chain` pill not found | StageCluster aria-label drift |
| `expected ≥7 new audit rows … got N` | A use-case audit write silently dropped |
| `bastion=0` in 06c bucketing | Sim Controls click swallowed (overlay, role gate, listener race) |
| `cannibalization GET … needs=0` | PULSE recipient/donor matcher regression or scope filter too tight |

If a beat fails, look at the emitted error message — it includes both
the FE selector context (Playwright's "locator resolved to" trace) and
the server-side counters (audit deltas, top-level keys of empty API
responses) so the next agent can root-cause without re-reading the
whole script.
