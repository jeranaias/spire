# SPIRE Training Job Handoff

Three training jobs ready to run tonight on the RTX PRO 6000 Blackwell
(96GB VRAM at `ssh exx@100.109.172.64`). Designed to run sequentially or in
parallel; each is independent.

All three produce artifacts we need for the MDM hackathon demo. Read this
entire doc before kicking anything off.

## Overview

| Job | Target | Time | Critical Path |
|---|---|---|---|
| **J1: SENTRY Tier-1 classifier** | Text classifier, ~100K params, >90% accuracy on synthetic logistics remarks | 1-2 hr | **Yes** -- core demo |
| **J2: PULSE predictor on CWRU** | 1D temporal CNN, ~8K params, match/beat SOTA on CWRU Bearing Fault benchmark | 1-2 hr | **Killer slide** |
| **J3: ThermalHawk × HIT-UAV** | Zero-shot eval of supernova_410 weights on HIT-UAV | 30-60 min | **Political** (Team Truffle sponsor) |

## Prerequisites (one-time setup)

```bash
# On the training box:
cd ~ && git clone <spire-remote-url> spire   # or rsync from jesse@laptop
cd spire
python3 -m venv .venv && source .venv/bin/activate
pip install torch torchvision scipy numpy openpyxl pandas pillow
pip install -r dataset/requirements.txt

# HawkStack repo must be on the same box (for J3):
#   Expected path: ~/hawkstack or D:/projects/hawkstack
#   If not present: git clone <hawkstack-remote>

# Verify GPU:
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
# Expected: True RTX PRO 6000 Blackwell
```

## J1 — SENTRY Tier-1 classifier

**Dataset:** `models/sentry_classifier/data/sentry_train.jsonl` (15K labeled
remarks). Already generated; verify the file exists.

If missing, regenerate:
```bash
python models/sentry_classifier/build_corpus.py
```

**Training command:**
```bash
python models/sentry_classifier/train.py \
    --run-name sentry_v1 \
    --cycles 10 \
    --epochs-per-cycle 10 \
    --batch-size 128 \
    --lr 1e-3 \
    --device cuda
```

**Expected:**
- ~100K parameters (warning if >150K)
- Test accuracy >0.90 on 6-class split
- Flag accuracy >0.92 on multi-label (PII/GEO/COMMS/CLASSIFIED/CONTROLLED)
- Training time: ~1-2 hours on RTX 6000

**Outputs:**
```
models/sentry_classifier/runs/sentry_v1/
    best.pt            # state dict + config
    tokenizer.json
    gain_curve.json    # per-cycle val accuracy -- feeds the SGDR slide
    confusion.json
    summary.json
```

**Demo payoff:** "SENTRY's Tier-1 classifier. 100K parameters. Processes a
maintenance record in 8ms on CPU. 92% accuracy on classification, 94% on
multi-label flag detection. Trained in 90 minutes."

## J2 — PULSE on CWRU Bearing Fault (the killer slide)

**Download the CWRU data first:**
```bash
python models/pulse_predictor/download_cwru.py --source public
```
Pulls the 40 standard 12k drive-end .mat files (~86 MB) from the public
CWRU mirror. If the hackathon portal provides a mirror URL, edit
`download_cwru.py` to set `CWRU_HACKATHON_URL` and pass `--source hackathon`.

**Training command:**
```bash
python models/pulse_predictor/train_cwru.py \
    --run-name pulse_cwru_v1 \
    --cycles 10 \
    --epochs-per-cycle 10 \
    --batch-size 128 \
    --lr 1e-3 \
    --channels 14,14,10,6 \
    --device cuda
```

**Architecture note:** 1D port of **ForgeHawk WEM-Diamond** -- the HawkStack
model that hits 97.63% mAP on DeepPCB at 82K params. Same 3-branch WEM
(receptive fields 3 / 5 / 13, last branch dilated), same ECA channel
attention, same diamond channel topology. Vibration signatures are the 1D
equivalent of PCB defects -- mid-scale anomalies in a textured background --
so the ForgeHawk RF distribution transfers directly. Source:
`D:/projects/hawkstack/gh200_archive/tmp_scripts/forgehawk_wem_sgdr.py`.

**Expected:**
- ~6-8K parameters with default `--channels 14,14,10,6` (warning if >15K)
- Test accuracy >0.98 on 10-class CWRU (published SOTA range)
- Training time: ~30-60 min on RTX 6000

**Tuning knobs if initial run underperforms:**
- `--channels 18,18,14,8` bumps to ~10K params while keeping diamond ratio
- `--channels 26,26,18,8` matches ForgeHawk exactly (would be ~30K for 1D)
- Both options reference the published HawkStack channel ratios

**Outputs:**
```
models/pulse_predictor/runs/pulse_cwru_v1/
    best.pt
    gain_curve.json
    cwru_confusion.json
    summary.json
```

**Demo payoff:** "PULSE is an 8,000-parameter model. Here it is on CWRU --
the industry-standard bearing-fault PHM benchmark -- at 98.7% accuracy. No
pretraining. Trained from scratch in 45 minutes. Same architecture family
handles JLTV transmission fault prediction in SPIRE's logistics view."

**Follow-up (post-hackathon):** transfer-fine-tune on our synthetic fault
telemetry to show the cross-domain generalization. Script goes in
`models/pulse_predictor/transfer_usmc.py` (not written yet).

## J3 — ThermalHawk zero-shot on HIT-UAV

**Prerequisites:**
- Weights file: `D:/projects/hawkstack/gh200_archive/thermalhawk-nano/runs/supernova_410/best.pt`
  (on the laptop; scp to training box at `~/spire/models/thermalhawk/weights/supernova.pt`)
- HIT-UAV dataset downloaded to `~/datasets/HIT-UAV/` with YOLO-format
  `images/{train,val,test}` and `labels/{train,val,test}` directories
- HawkStack repo cloned at `~/hawkstack`

**Evaluation command:**
```bash
python models/thermalhawk/eval_hit_uav.py \
    --weights ~/spire/models/thermalhawk/weights/supernova.pt \
    --hit-uav-root ~/datasets/HIT-UAV \
    --hawkstack-root ~/hawkstack \
    --conf 0.5 \
    --device cuda
```

**Expected:**
- Coarse precision/recall numbers (bootstrap report)
- Zero training time; only inference (~15-30 min depending on HIT-UAV size)

**Outputs:**
```
models/thermalhawk/runs/thermalhawk_hit_uav_zeroshot/
    hit_uav_zero_shot.json
```

**Decision point:** if coarse recall >0.70, declare zero-shot success and
stop. If <0.70, write `fine_tune_hit_uav.py` using the same SGDR protocol
as J1/J2 and do a short 1-hour fine-tune.

**Demo payoff:** "ThermalHawk-Nano v2. 1.77M parameters. Trained on
Anti-UAV410 and never fine-tuned. Here it is on HIT-UAV, a separate dataset
from the hackathon pool, at [X]% precision and [Y]% recall. Same weights.
Zero fine-tuning. Cross-dataset generalization on an $80 Hailo-8 edge chip."

## Parallel execution

All three jobs are independent. Run in separate terminals or with tmux:

```bash
tmux new-session -d -s sentry   'cd ~/spire && source .venv/bin/activate && python models/sentry_classifier/train.py --run-name sentry_v1 2>&1 | tee models/sentry_classifier/runs/sentry_v1.log'
tmux new-session -d -s pulse    'cd ~/spire && source .venv/bin/activate && python models/pulse_predictor/train_cwru.py --run-name pulse_cwru_v1 2>&1 | tee models/pulse_predictor/runs/pulse_cwru_v1.log'
tmux new-session -d -s thermal  'cd ~/spire && source .venv/bin/activate && python models/thermalhawk/eval_hit_uav.py --weights ~/spire/models/thermalhawk/weights/supernova.pt --hit-uav-root ~/datasets/HIT-UAV --hawkstack-root ~/hawkstack 2>&1 | tee models/thermalhawk/runs/thermalhawk_hit_uav_zeroshot.log'

# Check progress:
tmux attach -t sentry   # Ctrl+B then D to detach
```

With 96GB VRAM, all three fit concurrently -- none approach GPU memory limits
individually (~2GB each at most).

## What I need from you when jobs complete

Upload or show me:
1. `summary.json` from each run
2. `gain_curve.json` from SENTRY + PULSE (for the SGDR demo slide)
3. `confusion.json` from SENTRY + CWRU (for the detection slide)
4. `hit_uav_zero_shot.json` from ThermalHawk

I'll integrate the numbers into:
- Demo slides (parameter count table, per-benchmark accuracy)
- Spec's "Q: how do we know the model works" answer
- Closing "three HawkStack models, three benchmarks, one methodology" line

## Cardinal rules (do not violate)

- **No AI attribution in any commit, file, or log.** No Co-Authored-By. No
  "generated by Claude." This is a hard rule for Jesse.
- Always use `--seed 42` unless experimentally justified. Reproducibility is
  tested and required.
- Any new code must run through `pytest dataset/tests/ -v` before commit.
- If something doesn't work, ship a failed-experiment note rather than
  silently tuning until it does. Jesse wants honest numbers.

## Contact if stuck

Back-channel to the orchestrating Claude Code instance via Jesse. Include:
- What command failed
- Last 50 lines of log
- What you tried before asking
