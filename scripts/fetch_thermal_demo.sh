#!/usr/bin/env bash
#
# fetch_thermal_demo.sh — pull the live-feed assets ThermalHawk needs.
#
# Two artefacts:
#   1. Trained ThermalHawk checkpoint (4.4 MB) — copied from
#      hawkstack repo if present locally; otherwise the operator must
#      drop it at $TARGET_CKPT manually (path is exported as
#      SPIRE_THERMALHAWK_WEIGHTS).
#   2. Roboflow Thermal-Drone-Detection v1 (Zenodo 15633051, CC-BY-4.0,
#      ~87 MB zip → 1504 thermal DJI drone frames). Downloaded once
#      and cached so re-runs are no-ops.
#
# Usage:
#   bash scripts/fetch_thermal_demo.sh
#   export SPIRE_THERMALHAWK_WEIGHTS=$(pwd)/data/thermal_demo/thermalhawk_wem_best.pt
#   export SPIRE_THERMALHAWK_FRAMES=$(pwd)/data/thermal_demo/extracted/train/images
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="$ROOT/data/thermal_demo"
TARGET_CKPT="$TARGET_DIR/thermalhawk_wem_best.pt"
TARGET_ZIP="$TARGET_DIR/thermal_drone.zip"
TARGET_FRAMES="$TARGET_DIR/extracted"

mkdir -p "$TARGET_DIR"

# 1. Checkpoint — copy from local hawkstack archive if present.
HAWKSTACK_CKPT="/d/projects/hawkstack/gh200_archive/tmp_checkpoints/thermalhawk_wem_best.pt"
if [ ! -f "$TARGET_CKPT" ] && [ -f "$HAWKSTACK_CKPT" ]; then
  cp "$HAWKSTACK_CKPT" "$TARGET_CKPT"
  echo "[fetch] copied ThermalHawk weights to $TARGET_CKPT"
fi

if [ ! -f "$TARGET_CKPT" ]; then
  echo "[fetch] WARNING: ThermalHawk weights not found at $TARGET_CKPT"
  echo "[fetch]          drop the .pt there or set SPIRE_THERMALHAWK_WEIGHTS"
fi

# 2. Frame dataset — fetch + extract once.
if [ ! -d "$TARGET_FRAMES/train/images" ]; then
  if [ ! -f "$TARGET_ZIP" ]; then
    echo "[fetch] downloading Roboflow Thermal-Drone (Zenodo 15633051, CC-BY-4.0)…"
    curl -L --silent --show-error \
      -o "$TARGET_ZIP" \
      "https://zenodo.org/records/15633051/files/Thermal_drone_detection.v1i.yolov11_no_augmentation.zip?download=1"
  fi
  echo "[fetch] extracting frames to $TARGET_FRAMES"
  mkdir -p "$TARGET_FRAMES"
  ( cd "$TARGET_DIR" && unzip -q -o "$TARGET_ZIP" -d "extracted" )
fi

FRAME_COUNT=$(ls "$TARGET_FRAMES/train/images" 2>/dev/null | wc -l || echo 0)
echo "[fetch] ready · $FRAME_COUNT thermal frames + $( [ -f "$TARGET_CKPT" ] && echo "checkpoint loaded" || echo "checkpoint missing" )"
echo
echo "Export to enable the live feed in SPIRE:"
echo "  export SPIRE_THERMALHAWK_WEIGHTS=\"$TARGET_CKPT\""
echo "  export SPIRE_THERMALHAWK_FRAMES=\"$TARGET_FRAMES/train/images\""
