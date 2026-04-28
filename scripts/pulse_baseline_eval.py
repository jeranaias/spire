"""Reproduce the published PULSE-Risk holdout MAE + baseline diff.

This script is the source-of-truth for the accuracy numbers cited on
slide 5 of the pitch deck (`frontend/src/views/pitch/slides.ts`) and
shown in the model-card miniature (`frontend/src/views/pitch/PitchVisual.tsx`).
It is intentionally standalone so the baseline rule, the frozen holdout
window, and the bootstrap CI methodology can all be re-derived in one
deterministic run, without booting the whole FastAPI server.

What it does:

  1. Loads the canonical SPIRE synthetic dataset (RANDOM_SEED=42).
  2. Fixes the val/test boundary at the published 70/15/15 time-split.
  3. Builds the snapshot-time evaluation pairs at the val/test boundary
     (one row per asset; label = "did this asset go NMC inside the next
     30 days?").
  4. Computes holdout MAE for:
        * PULSE-Risk (continuous probability in [0,1])
        * FY24 G-4 SOP heuristic baseline
          ("predict NMC iff today's readiness code starts with NMC")
  5. Bootstraps a 95% CI for each (1000 resamples, seed=42, percentile
     method).
  6. Prints a markdown block ready to paste into the model card and
     emits the slide-ready one-liner.

Run:
    python -m scripts.pulse_baseline_eval

The same numbers are reachable at runtime via GET /api/pulse/model-card
(see `holdout_mae` in the response body).
"""
from __future__ import annotations

from datetime import timedelta

from backend.routes.pulse import (
    _build_eval_pairs,
    _holdout_mae,
)
from backend.state import load_dataset


BASELINE_NAME = "FY24 G-4 SOP heuristic"
BASELINE_RULE = "predict NMC iff today's readiness code starts with 'NMC'"


def main() -> int:
    ds = load_dataset()
    if not ds.snapshots:
        print("ERROR: dataset has no snapshots — cannot evaluate.")
        return 1

    first_day = ds.snapshots[0].snapshot_date
    last_day = ds.snapshots[-1].snapshot_date
    total_days = (last_day - first_day).days + 1
    train_end = first_day + timedelta(days=int(total_days * 0.70))
    val_end = first_day + timedelta(days=int(total_days * 0.85))
    holdout_start = val_end + timedelta(days=1)

    pairs = _build_eval_pairs(ds, val_end)
    n = len(pairs)
    n_pos = sum(1 for p in pairs if p["label"] == 1)

    model_mae = _holdout_mae(pairs, "model_prob")
    sop_mae = _holdout_mae(pairs, "sop_prob")

    rel_improvement_pct = (
        (sop_mae["mae"] - model_mae["mae"]) / sop_mae["mae"] * 100.0
        if sop_mae["mae"] > 0
        else 0.0
    )

    print()
    print("=" * 72)
    print("PULSE-Risk · holdout MAE evaluation")
    print("=" * 72)
    print(f"Synthetic dataset boot seed:       42")
    print(f"Bootstrap seed / iterations:       42 / 1000 (percentile method)")
    print(f"Frozen holdout window:             {holdout_start.isoformat()} → {last_day.isoformat()}")
    print(f"Asset pool (n at val/test edge):   {n}")
    print(f"Positive class rate (any-NMC@30d): {n_pos / n:.3f}" if n else "Positive class rate: n/a")
    print(f"Baseline:                          {BASELINE_NAME}")
    print(f"Baseline rule:                     {BASELINE_RULE}")
    print()
    print(f"PULSE-Risk MAE: {model_mae['mae']:.4f} "
          f"(95% CI {model_mae['ci_lower_95']:.4f} – {model_mae['ci_upper_95']:.4f})")
    print(f"Baseline MAE:   {sop_mae['mae']:.4f} "
          f"(95% CI {sop_mae['ci_lower_95']:.4f} – {sop_mae['ci_upper_95']:.4f})")
    print(f"Relative MAE improvement vs baseline: {rel_improvement_pct:+.1f}%")
    print()
    print("--- markdown for the model card -----------------------------------")
    print(f"| Metric | PULSE-Risk | {BASELINE_NAME} |")
    print(f"|---|---|---|")
    print(
        f"| Holdout MAE | {model_mae['mae']:.4f} "
        f"(95% CI {model_mae['ci_lower_95']:.4f}–{model_mae['ci_upper_95']:.4f}) "
        f"| {sop_mae['mae']:.4f} "
        f"(95% CI {sop_mae['ci_lower_95']:.4f}–{sop_mae['ci_upper_95']:.4f}) |"
    )
    print(f"| Window | {holdout_start.isoformat()} → {last_day.isoformat()} | same |")
    print(f"| Asset pool | n = {n} | same |")
    print(f"| Relative improvement | {rel_improvement_pct:+.1f}% | — |")
    print()
    print("--- one-liner for slide 5 -----------------------------------------")
    print(
        f"PULSE-Risk MAE {model_mae['mae']:.3f} vs {BASELINE_NAME} {sop_mae['mae']:.3f} "
        f"({rel_improvement_pct:+.1f}%) on holdout {holdout_start.isoformat()}–{last_day.isoformat()} "
        f"(n={n}, 95% CI bootstrap @ seed=42)."
    )
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
