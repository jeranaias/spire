#!/usr/bin/env bash
# Detached user-level SPIRE deploy for the Orin Nano (no sudo, no systemd).
# Launched via nohup so it survives the flaky USB-net link. Logs to deploy.log.
set -u
cd ~/spire || exit 1
log(){ echo "[$(date +%H:%M:%S)] $*"; }
log "==== DEPLOY START ===="

# 1. .env — local LLM, no cloud, fresh session secret (no GitHub token shipped).
if [ ! -f .env ]; then
  SEC=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
  printf 'SPIRE_LLM_PRIMARY_DISABLE=1\nSPIRE_LLM_LOCAL=http://127.0.0.1:11434\nSPIRE_LLM_LOCAL_MODEL=gemma2:2b\nSPIRE_SESSION_SECRET=%s\n' "$SEC" > .env
  log ".env written"
fi

# 2. venv (--without-pip, since python3.10-venv/ensurepip needs sudo) + pip bootstrap.
if [ ! -x .venv/bin/python ]; then python3 -m venv --without-pip .venv && log "venv created"; fi
if [ ! -x .venv/bin/pip ]; then
  curl -fsSL -o /tmp/get-pip.py https://bootstrap.pypa.io/get-pip.py && .venv/bin/python /tmp/get-pip.py >/dev/null 2>&1 && log "pip bootstrapped"
fi
log "installing python deps (aarch64 wheels; slowest step)..."
.venv/bin/pip install --disable-pip-version-check -q fastapi "uvicorn[standard]" pandas pydantic httpx cryptography openpyxl python-multipart && log "python deps OK" || log "PIP FAILED"

# 3. Ollama (user-local tarball; no sudo). GPU autodetect on JetPack.
if [ ! -x "$HOME/ollama/bin/ollama" ]; then
  log "downloading ollama arm64..."
  curl -fsSL https://ollama.com/download/ollama-linux-arm64.tgz -o /tmp/ollama.tgz && mkdir -p "$HOME/ollama" && tar xzf /tmp/ollama.tgz -C "$HOME/ollama" && log "ollama installed" || log "OLLAMA DL FAILED"
fi
if ! curl -s --max-time 4 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  log "starting ollama serve..."
  OLLAMA_HOST=127.0.0.1:11434 nohup "$HOME/ollama/bin/ollama" serve > "$HOME/spire/ollama.log" 2>&1 &
  sleep 6
fi
# Pull the quantized Gemma in the background — download only (no inference,
# so no GPU load / brownout on 5V). Safe at idle 15W.
log "pulling gemma2:2b in background (~1.7GB)..."
OLLAMA_HOST=127.0.0.1:11434 nohup "$HOME/ollama/bin/ollama" pull gemma2:2b > "$HOME/spire/model_pull.log" 2>&1 &

# 4. SPIRE backend — serves API + frontend/dist on :8000 (all interfaces).
log "starting SPIRE backend on :8000..."
pkill -f "uvicorn backend.main" 2>/dev/null || true
sleep 1
nohup .venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 > "$HOME/spire/spire.log" 2>&1 &
sleep 12
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 http://127.0.0.1:8000/ 2>/dev/null || echo "000")
log "backend http=$code"
log "==== DEPLOY DONE (model pull may still be running; see model_pull.log) ===="
