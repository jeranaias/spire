#!/usr/bin/env bash
# User-level Ollama install for the Orin (JetPack 6 GPU build) + model pull.
# Download-only work (no inference) so it's safe on the 5V supply / 15W idle.
set -u
log(){ echo "[$(date +%H:%M:%S)] $*"; }
export LD_LIBRARY_PATH="$HOME/ollama/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
URL="https://github.com/ollama/ollama/releases/download/v0.30.10/ollama-linux-arm64-jetpack6.tar.zst"

if [ ! -x "$HOME/ollama/bin/ollama" ]; then
  log "downloading ollama jetpack6 (~260MB)..."
  curl -fsSL "$URL" -o /tmp/ollama.tar.zst || { log "DOWNLOAD FAILED"; exit 1; }
  mkdir -p "$HOME/ollama"
  if tar --zstd -xf /tmp/ollama.tar.zst -C "$HOME/ollama" 2>/dev/null; then log "extracted via tar --zstd";
  elif command -v unzstd >/dev/null && unzstd -c /tmp/ollama.tar.zst | tar -x -C "$HOME/ollama"; then log "extracted via unzstd";
  elif command -v zstd >/dev/null && zstd -dc /tmp/ollama.tar.zst | tar -x -C "$HOME/ollama"; then log "extracted via zstd";
  else log "EXTRACT FAILED — no zstd available"; exit 1; fi
fi
log "ollama version: $("$HOME/ollama/bin/ollama" --version 2>&1 | head -1)"

if ! curl -s --max-time 4 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  log "starting ollama serve..."
  OLLAMA_HOST=127.0.0.1:11434 nohup "$HOME/ollama/bin/ollama" serve > "$HOME/spire/ollama.log" 2>&1 &
  sleep 8
fi
curl -s --max-time 4 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && log "ollama serve UP" || log "ollama serve NOT UP (see ollama.log)"

log "pulling gemma2:2b (~1.7GB download, no GPU load)..."
OLLAMA_HOST=127.0.0.1:11434 "$HOME/ollama/bin/ollama" pull gemma2:2b && log "MODEL gemma2:2b READY" || log "MODEL PULL FAILED"
log "==== OLLAMA SETUP DONE ===="
