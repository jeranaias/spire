# PULSE-Risk · Holdout MAE Model Card

This document is the human-readable companion to the live model card at
`/api/pulse/model-card` (`holdout_mae` block) and the canonical detail
page at `/#/admin/models/pulse-risk-scorer`.

It exists so the accuracy claim on slide 5 of the pitch deck has a single,
named, reproducible source — not a number invented for the deck.

> **Reproduce these numbers:** `python -m scripts.pulse_baseline_eval`
>
> The script boots the canonical SPIRE synthetic dataset under
> `RANDOM_SEED=42`, recomputes the eval pairs at the published val/test
> boundary, runs MAE + bootstrap CI for the model and the SOP baseline,
> and prints both the markdown table below and the slide-5 one-liner.

---

## Baseline rule (named, documented, reproducible)

| Field | Value |
|---|---|
| Name | **FY24 G-4 SOP heuristic** |
| Rule | Predict `NMC` iff today's readiness code starts with `NMC`. |
| Source | FY24 standing rule encoded into the `pred_sop` predictor in `backend/routes/pulse.py::_build_eval_pairs`. |
| Why this baseline | This is the rule a Marine Corps J-4 actually follows today. The earlier "GCSS-MC rules-of-thumb" framing was unrecognised by the customer; this rule the customer would acknowledge as the standing comparator. |
| Failure mode | Strict 0/1 binary predictor. Captures auto-correlation in NMC state but blind to PMC drift and chronic-fault MC assets — the signals PULSE-Risk is built to surface. |

A second baseline (the prior-year contractor's PWS §4.2 deliverable,
`predict NMC if days_deadlined > 7`) is also computed in the same eval
harness and exposed in the model card's `baselines` array, but the
**FY24 G-4 SOP heuristic** is the one we cite on stage because it's the
rule actually in use.

---

## Frozen holdout window

| Field | Value |
|---|---|
| Window start | **2026-03-04** |
| Window end | **2026-04-26** |
| Window length | 54 days (trailing 15% of the 12-month synthetic simulation) |
| Asset pool n | **352** assets with a snapshot at the val/test boundary AND ≥1 snapshot inside the holdout window |
| Unit scope | Full SPIRE synthetic fleet under `RANDOM_SEED=42` |
| Evaluation horizon | 30 days from each prediction's snapshot time |
| Label definition | `y = 1` iff any snapshot in `(val_end, val_end + 30d]` carries a readiness code starting with `NMC`, else `0` |
| Time-leakage discipline | Predictions use snapshot-time features only (no future state); SR-history features are bounded to the 90 days ending at `val_end`. |
| Known limitation | Per-asset history is shared across train / val / test because the readiness signal is auto-correlated. Tracked as `#LIM-3` on `/admin/models/pulse-risk-scorer`; next iteration uses leave-one-asset-out CV. |

The window is **frozen** in code: it is derived from the synthetic
dataset's 70 / 15 / 15 time-split and re-derives bit-identically on
every run because the dataset is deterministic. Changing it requires
a deliberate edit to `backend/routes/pulse.py::_compute_model_card`.

---

## Holdout MAE result (current)

Re-derived from the script above, written into the live model card.

| Metric | PULSE-Risk (rule_based_v1) | FY24 G-4 SOP heuristic |
|---|---|---|
| Holdout MAE | **0.1773** (95% CI 0.1482 – 0.2091) | **0.1136** (95% CI 0.0795 – 0.1506) |
| Window | 2026-03-04 → 2026-04-26 | same |
| Asset pool | n = 352 | same |
| Bootstrap | 1000 resamples, percentile method, seed=42 | same |
| Relative MAE vs baseline | **−56.1%** (model under-performs SOP) | — |

### What this number means

For every asset in the pool we compare its prediction to the actual
NMC outcome over the next 30 days. PULSE-Risk emits a continuous
probability in `[0, 1]`; the SOP heuristic emits `0` or `1`. MAE is
the mean absolute distance between prediction and label.

For the binary SOP this is just the misclassification rate
(`1 − accuracy`). For PULSE-Risk it captures both **discrimination**
(did we get the direction right?) and **calibration** (did we hedge
appropriately?) — a confidently-wrong probability is penalised more
than a hedged-wrong one.

### Why the rule-based fallback currently loses on MAE

The PULSE engine is currently in `rule_based_v1` fallback (no torch
weights loaded). The rule-based scorer hedges — it emits, e.g.,
`prob = 0.32` on a chronic-fault MC asset because the future-30-day
NMC outcome there is genuinely uncertain. On any case where SOP
happens to be correct (label = 0, prediction = 0), SOP contributes
zero to its MAE while PULSE still contributes 0.32. Across hundreds
of mostly-MC assets these calibration penalties accumulate.

Notably, PULSE-Risk currently leads SOP on **classification accuracy**
(see `baselines` array in the model card) — it catches the chronic-
fault MC assets that SOP misses by definition. The two metrics
disagree because they reward different things. Both are reported.

The trained-weights swap (lane: `torch_v0` in
`dataset/data/model_registry.json`, env-var-gated by
`SPIRE_PULSE_WEIGHTS`) is the planned win. When that lands the swap
flips a single env var and these numbers re-derive on the same eval
harness — both this document AND the slide-5 cite must be updated in
the same change.

---

## Where the numbers are wired

| Surface | Source | Notes |
|---|---|---|
| Live API | `GET /api/pulse/model-card` (`holdout_mae`) | Cached for the lifetime of the process; pass `?refresh=true` to recompute. |
| Reproducibility script | `scripts/pulse_baseline_eval.py` | Standalone — boots the dataset and prints the markdown table + the slide one-liner. |
| Pitch slide 5 | `frontend/src/views/pitch/slides.ts` (id `tech-depth`) | One-line cite with baseline + window + n + CI seed. |
| Pitch visual (model card miniature) | `frontend/src/views/pitch/PitchVisual.tsx` (`ModelCard`) | Renders `holdout MAE 0.177` and `vs SOP base −56%` rows. |
| Canonical detail page | `/#/admin/models/pulse-risk-scorer` | Model registry entry pulled from `dataset/data/model_registry.json`. |
| Test coverage | `backend/tests/test_pulse_model_card.py::test_model_card_holdout_mae_*` | Asserts shape, determinism, and that the baseline row is the FY24 G-4 SOP heuristic. |
