# Stage Rehearsal — Live-Ingest Mode (Task #183)

This document walks the SPIRE stage operator through the **live-ingest
rehearsal**: booting empty, hydrating from the three sanitized GCSS-MC
CSVs in front of an audience, and recovering with the failsafe if the
demo collapses mid-pitch.

## Why live-ingest mode exists

The default SPIRE boot loads a deterministic seed-42 dataset (10 units,
352 assets, 6,320 SRs). It is convincing and fast, but it is also
unmistakably synthetic. **Stage live-ingest mode** drops the synthetic
veil for a critical 90-second window of the demo: the operator drags
the *real* sanitized export onto DECISION BRIDGE, the dashboards light
up with *real* document numbers, *real* defect codes, and *real*
serial-hash strings — then the pitch continues.

> Hydration scope: stage live-ingest hydrates **every top-level surface**
> — DECISION BRIDGE, BASTION, PULSE, and SENTRY — by attaching a
> today-only synthesized `DailySnapshot` block to the parsed SR /
> requisition / asset records. The `_build_dataset_from_report` helper
> in `backend/routes/stage_ingest.py` constructs `ds.snapshots` and
> populates `ds.assets` with full attribute-access records so the
> downstream PULSE risk surfaces and the BASTION COP have something to
> read against. The "Awaiting GCSS-MC ingest" placeholder disappears
> from every view within one `useDatasetStatus` poll (≤5 s) of a
> successful ingest. **The historical multi-month snapshot timeseries
> is *not* materialized** — those rows remain seed-42 in the populated
> baseline; what stage live-ingest replaces is the *current-day* SR /
> requisition / asset slice, which is what the demo narrative ("real
> records appear") actually requires.

## Pre-flight (T-30 min before demo)

1. Confirm the three sanitized CSVs are in your stage kit:
   - `hashed_header.csv` (12 columns, ~ a few thousand rows)
   - `hashed_sr_parts.csv` (6 columns)
   - `hashed_due_in.csv`   (82 columns)
2. **Never** check the raw GCSS-MC pull into the repo. The `tests/`
   fixtures under `tests/fixtures/stage_ingest/` are 6-row synthetic
   stand-ins for CI; the real sanitized export lives only in your
   `~/spire-stage-kit/` directory.
3. Verify your sign-in cert. Stage-ingest is gated to two roles:
   `data_custodian` and `security_manager`. In `MOCK_USERS`, only
   CWO3 James Park (DODID `3456789012`, role `security_manager`) is
   eligible. Have his cert selected on the auth screen before walking
   on stage.
4. Set the boot flag on the stage machine:
   ```bash
   export SPIRE_BOOT_EMPTY=1
   ```
   This causes `backend.main.lifespan` to skip `load_dataset()`. Every
   dashboard renders the placeholder until the operator hydrates.
5. Run a dry rehearsal: bring the stack up, sign in as Park, navigate
   to DECISION BRIDGE, drop the three CSVs, and verify the SR count in
   the success banner matches your `wc -l` of the header.

## Walkthrough — on-stage flow (90 seconds)

| Beat | Time | Action | What the audience sees |
| --- | --- | --- | --- |
| 1 | T+0s | Sign in as Park | Auth → DECISION BRIDGE empty hero card |
| 2 | T+10s | "We boot SPIRE empty — no synthetic data, nothing to hide." | Three empty drop slots + "Awaiting GCSS-MC ingest" |
| 3 | T+20s | Drag `hashed_header.csv` onto slot 1 | Slot turns green; filename + size shown |
| 4 | T+25s | Drag `hashed_sr_parts.csv` onto slot 2 | Slot 2 green; submit button enables |
| 5 | T+30s | Drag `hashed_due_in.csv` onto slot 3 | Slot 3 green |
| 6 | T+35s | Click "Hydrate SPIRE" | Progress bar fills 33% → 66% → 90% (parsing → validating → hydrating) with per-file row counts displayed when complete |
| 7 | T+45s | Wait for "Ingest Complete" badge | SR count + ingest-hash + elapsed shown |
| 8 | T+50s | Tile grid lights up with real records | DECISION BRIDGE shows live SR rows |
| 9 | T+60s | Navigate to SENTRY → Review Queue | Real document numbers / defect codes appear |
| 10 | T+90s | Continue with the rest of the demo | — |

## Failsafe — Shift+F8

If the live ingest fails mid-stage (bad CSV, schema drift, network
hiccup), or if you need to re-run the demo from a clean state:

1. **Anywhere in the app**, press **Shift+F8** (capture-phase, no input
   focus). The hotkey is wired in `frontend/src/App.tsx::useStageResetHotkey`
   and posts to `/api/system/admin/reset-demo`.
2. The toast `Failsafe — restored seed-42 baseline` confirms the
   rebuild. The seed-42 dataset is loaded back into the singleton, the
   "Awaiting GCSS-MC ingest" placeholders disappear, and every
   dashboard reverts to the deterministic synthetic baseline.
3. The audience does not see a confirmation modal — the reset is
   instant and idempotent. (The other failsafe, **Shift+F9**, drops to
   the *recorded* video backup; that is the next step if the live
   stack itself is hung.)

## Backend contract (for engineers)

- `SPIRE_BOOT_EMPTY` — env flag, accepts `1` / `true` / `yes` / `on`
  (case-insensitive). When set, `lifespan` skips `load_dataset()` and
  the dataset singleton boots empty.
- `GET /api/system/dataset-status` — auth-gated read; returns
  `{empty, source, ingested_at, ingested_by, ingest_hash, counts, …}`.
  Polled every 5s by the frontend `useDatasetStatus` hook.
- `POST /api/system/stage-ingest` — gated to
  `{data_custodian, security_manager}`. Accepts a multipart upload
  with three named fields: `header`, `sr_parts`, `due_in`. Each file is
  capped at 200 MB; the entire ingest is wrapped in a 60s wall-clock
  timeout. Returns `{ok, ingest_hash, elapsed_ms, actor, source_files,
  counts, ingest_report}`.
- `POST /api/system/admin/reset-demo` — extended in Task #183 to also
  rehydrate the dataset singleton from the seed-42 baseline.
- Empty-state envelope — `/api/bastion/cop`, `/api/pulse/fleet-overview`,
  and `/api/pulse/model-card` return `{empty: true, message: "Awaiting
  GCSS-MC ingest"}` instead of 503-ing or returning a populated
  payload while the dataset is empty. Frontend type-guard:
  `isEmptyEnvelope` in `frontend/src/api.ts`.

## Test coverage

- `tests/test_stage_ingest.py` — 13 backend tests (singleton lifecycle,
  RBAC, schema gate, sanitization gate, empty-envelope contract,
  failsafe).
- `tests/playwright/stage_ingest.spec.ts` — 7 end-to-end specs
  (hero card render, slot validation, hydrate flow, three placeholder
  views, Shift+F8 toast).
- `tests/fixtures/stage_ingest/{header,sr_parts,due_in}.csv` —
  synthetic 6-row CSVs that match the sanitized export schema.
  **These are stand-ins** — never replace them with the real export.

## Troubleshooting

| Symptom | Diagnosis | Fix |
| --- | --- | --- |
| Hero card never renders | `SPIRE_BOOT_EMPTY` not set on the stage machine | `export SPIRE_BOOT_EMPTY=1` and restart the backend |
| Submit button stays disabled | One slot still shows red ✗ | Check the slot's error text — usually "is not a CSV" or "is empty" |
| 403 on stage-ingest POST | Signed in as g4 / maintenance_chief / mef_commander | Sign in as Park (security_manager) |
| 422 with "schema mismatch" | The header CSV is missing too many of the 12 expected columns | Confirm the file is `hashed_header.csv`, not a generic CSV |
| 400 with "Sanitization gate" | The header carries un-hashed sensitive fields | Re-export through the SENTRY upload sanitizer first |
| 504 with "exceeded 60s" | The export is too large for the stage-ingest path | Press Shift+F8 and use the streaming SENTRY upload path |
| Tile grid still shows "Awaiting GCSS-MC ingest" after hydrate | The dataset-status poll hasn't ticked yet | Wait 5s; or alt-tab the window to force a focus-refresh |
