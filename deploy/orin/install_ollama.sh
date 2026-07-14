#!/usr/bin/env bash
# User-level Ollama install for the Orin (JetPack 6). The release splits into:
#   - ollama-linux-arm64.tar.zst         (base: bin/ollama + core libs, ~1.4GB)
#   - ollama-linux-arm64-jetpack6.tar.zst (Jetson CUDA runner overlay, ~260MB)
# Extract BOTH into ~/ollama. Download-only work → safe on the 5V supply.
set -u
log(){ echo "[$(date +%H:%M:%S)] $*"; }
export LD_LIBRARY_PATH="$HOME/ollama/lib:$HOME/ollama/lib/ollama${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
BASE="https://github.com/ollama/ollama/releases/download/v0.30.10/ollama-linux-arm64.tar.zst"
JP6="https://github.com/ollama/ollama/releases/download/v0.30.10/ollama-linux-arm64-jetpack6.tar.zst"
mkdir -p "$HOME/ollama"

extract(){ tar --zstd -xf "$1" -C "$HOME/ollama" 2>/dev/null || zstd -dc "$1" | tar -x -C "$HOME/ollama"; }

# JetPack6 CUDA overlay (idempotent — may already be present).
if [ ! -d "$HOME/ollama/lib/ollama/cuda_jetpack6" ]; then
  log "downloading jetpack6 CUDA overlay (~260MB)..."
  curl -fsSL "$JP6" -o /tmp/ollama-jp6.tar.zst && extract /tmp/ollama-jp6.tar.zst && log "jetpack6 overlay in"
fi

# Base package (has bin/ollama).
if [ ! -x "$HOME/ollama/bin/ollama" ]; then
  log "downloading ollama base (~1.4GB, this is the long one)..."
  curl -fsSL "$BASE" -o /tmp/ollama-base.tar.zst || { log "BASE DOWNLOAD FAILED"; exit 1; }
  log "extracting base..."
  extract /tmp/ollama-base.tar.zst || { log "BASE EXTRACT FAILED"; exit 1; }
fi
[ -x "$HOME/ollama/bin/ollama" ] || { log "NO BINARY at ~/ollama/bin/ollama after extract"; find "$HOME/ollama" -maxdepth 2 -type f | head; exit 1; }
log "ollama version: $("$HOME/ollama/bin/ollama" --version 2>&1 | head -1)"

if ! curl -s --max-time 4 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  log "starting ollama serve..."
  OLLAMA_HOST=127.0.0.1:11434 nohup "$HOME/ollama/bin/ollama" serve > "$HOME/spire/ollama.log" 2>&1 &
  sleep 8
fi
curl -s --max-time 4 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && log "ollama serve UP" || { log "serve NOT up:"; tail -5 "$HOME/spire/ollama.log"; }

log "pulling gemma2:2b (~1.7GB download, no GPU load)..."
OLLAMA_HOST=127.0.0.1:11434 "$HOME/ollama/bin/ollama" pull gemma2:2b && log "MODEL gemma2:2b READY" || log "MODEL PULL FAILED"
log "==== OLLAMA SETUP DONE ===="
