# SPIRE Models

Weights are NOT committed to this repo (`.gitignore`d). Reference copies live in the HawkStack monorepo's GH200 archive.

## BASTION — ThermalHawk-Nano v2 (Supernova)

**Status:** ✅ Trained. Ready for inference.
**Params:** 1.77M (1.39M deploy via structural reparameterization)
**Performance:** 82.95% mAP@50, 0.5795 SA on Anti-UAV410

- `D:\projects\hawkstack\gh200_archive\thermalhawk-nano\runs\supernova_410\best.pt` — Gen-3 EMA (primary)
- `D:\projects\hawkstack\gh200_archive\thermalhawk-nano\runs\supernova_410\epoch_{14,19,24,29,34,39}.pt` — epoch snapshots
- `D:\projects\hawkstack\gh200_archive\thermalhawk-nano\runs\ablation_no_kd\best.pt` — no-distillation ablation
- `D:\projects\hawkstack\gh200_archive\tmp_checkpoints\thermalhawk_wem_best.pt` (4.4M) — WEM variant
- Source/eval: `D:\projects\thermalhawk\`

## PULSE — equipment failure predictor

**Status:** ⏳ Fine-tune from ECG zoo. Base arch exists; no equipment-telemetry variant yet.
**Target params:** ~8K (per spec). Seed models are 24K–116K.
**Architecture:** MIT-BIH 1D temporal CNN, 3 parallel convolution branches (kernel 3/7/15).

Seed candidates in `D:\projects\hawkstack\gh200_archive\tmp_checkpoints\`:

- `ecg_Nano_best.pt` (80K) — good starting seed
- `ecg_Ultra_best.pt` (72K), `ecg_v2_Ultra_best.pt` / `ecg_v3_Ultra_best.pt` / `ecg_v4_Ultra_best.pt` (24–32K) — smaller-footprint variants
- `ecg_Micro_best.pt` (84K)
- `ecg_proto20k_best.pt` (72K) — prototype-based classifier
- `ecg_5c_combined_best.pt` (72K), `ecg_hybrid_best.pt` (48K), `ecg_mf_best.pt` (72K)
- Ladder recipe: `D:\projects\hawkstack\hawkstack\cli\ladder.py` (supports `--domain ecg`)

Fine-tuning protocol: cyclic-restart SGDR (per HawkStack methodology). 50-100 epochs per cycle, fresh optimizer per cycle.

## SENTRY — Tier-1 text sensitivity classifier

**Status:** ❌ Not trained. Only from-scratch training task for SPIRE.
**Target params:** ~100K
**Architecture:** 1D text CNN or BiLSTM, SGDR-trained
**Train by:** 26 APR 2026 to preserve Thornveil IP status per LICENSE §2.2.

Training corpus: synthesize from `dataset/sensitive.py` rules covering PII, MGRS grid coordinates, COMSEC/frequency references, and classified TM markings. Balance: ~50% clean, ~50% mixed (one or more sensitive categories per record).

Labels: multi-label classification across {PII, GEO, COMMS, CLASSIFIED, CLEAN} + confidence. Records with confidence <90% or class=AMBIGUOUS route to Tier-2 (RigRun LLM).

## Why weights aren't in this repo

1. Re-downloading from the monorepo is fast and avoids duplication.
2. Git histories get ugly with large binaries.
3. The IP carve-out in `LICENSE.md` depends on training provenance; keeping weights in their source repo makes provenance easier to document.
