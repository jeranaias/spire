#!/usr/bin/env bash
# =============================================================================
# SPIRE — one-shot installer for NVIDIA Jetson Orin Nano
#   Target: JetPack 6 / Ubuntu 22.04, ARM64 (aarch64), Ampere GPU, 8 GB
#
# What it does (idempotent — safe to re-run):
#   1. Installs Ollama (the installer auto-detects the Jetson GPU)
#   2. Enables + starts the ollama systemd service
#   3. Pulls the on-device model (gemma2:2b, Q4 ~1.7 GB by default)
#   4. Creates a Python venv and installs the SPIRE backend deps
#   5. Builds the React frontend into frontend/dist
#   6. Writes a repo-root .env (only if one does not already exist)
#   7. Templates + installs the spire.service systemd unit and starts it
#
# Run from anywhere AS A NON-ROOT USER that can sudo:
#   bash deploy/orin/setup.sh
# =============================================================================
set -euo pipefail

# --- locate the repo root (this script lives in <repo>/deploy/orin) ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VENV_DIR="${REPO_DIR}/.venv"
RUN_USER="${SUDO_USER:-$(id -un)}"

# The on-device model. Override at call time:
#   SPIRE_MODEL=llama3.2:1b bash deploy/orin/setup.sh
MODEL="${SPIRE_MODEL:-gemma2:2b}"

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$*"; }

log "SPIRE Orin Nano setup"
echo "    repo : ${REPO_DIR}"
echo "    user : ${RUN_USER}"
echo "    model: ${MODEL}"

if [ "$(id -u)" -eq 0 ] && [ -z "${SUDO_USER:-}" ]; then
  warn "Running as bare root. Re-run as a normal user with sudo so the"
  warn "venv, build, and service are owned by a login account, not root."
fi

# -----------------------------------------------------------------------------
# 1. Ollama
# -----------------------------------------------------------------------------
log "Step 1/7 — Ollama"
if command -v ollama >/dev/null 2>&1; then
  ok "ollama already installed ($(ollama --version 2>/dev/null | head -n1))"
else
  # The official installer detects Jetson and wires up GPU acceleration.
  curl -fsSL https://ollama.com/install.sh | sh
  ok "ollama installed"
fi

# -----------------------------------------------------------------------------
# 2. Enable + start the ollama service
# -----------------------------------------------------------------------------
log "Step 2/7 — ollama service"
if systemctl is-enabled --quiet ollama 2>/dev/null && systemctl is-active --quiet ollama 2>/dev/null; then
  ok "ollama.service already enabled and running"
else
  sudo systemctl enable --now ollama
  ok "ollama.service enabled and started"
fi

# Wait for the daemon to answer before pulling.
log "    waiting for Ollama API on 127.0.0.1:11434 ..."
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    ok "Ollama API up"
    break
  fi
  sleep 1
done

# -----------------------------------------------------------------------------
# 3. Pull the on-device model
# -----------------------------------------------------------------------------
log "Step 3/7 — pull model: ${MODEL}"
# gemma2:2b is the default — Gemma brand, Q4 (~1.7 GB), GPU-accelerated, fits
# 8 GB alongside the OS + the SPIRE backend.
#   Max speed / smaller     : SPIRE_MODEL=llama3.2:1b
#   Pin the exact quant     : SPIRE_MODEL=gemma2:2b-instruct-q4_K_M
#   DO NOT pull a ~7 GB model (e.g. gemma3:e2b) — it will not fit in 8 GB.
if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "${MODEL}"; then
  ok "model ${MODEL} already present"
else
  ollama pull "${MODEL}"
  ok "model ${MODEL} pulled"
fi

# -----------------------------------------------------------------------------
# 4. Python venv + backend deps
# -----------------------------------------------------------------------------
log "Step 4/7 — Python venv + backend deps"
# pyproject.toml pins requires-python >=3.12, but JetPack 6 ships Python 3.10.
# SPIRE's deps install fine on 3.10, so we install them directly with pip
# rather than via the project's build metadata (which would hard-fail the pin).
if ! command -v python3 >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y python3 python3-venv python3-pip
fi
PYVER="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
echo "    python3 -> ${PYVER}"

if [ ! -x "${VENV_DIR}/bin/python" ]; then
  python3 -m venv "${VENV_DIR}"
  ok "venv created at ${VENV_DIR}"
else
  ok "venv already exists at ${VENV_DIR}"
fi

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"
python -m pip install --upgrade pip wheel setuptools

# Backend deps, mirrored from pyproject.toml (installed directly so the
# Python 3.12 pin doesn't block a 3.10 JetPack). pandas/numpy build from
# wheels on aarch64; apt provides BLAS if a source build is ever needed.
log "    installing backend dependencies (pip)"
pip install \
  "fastapi>=0.115.0" \
  "uvicorn[standard]>=0.32.0" \
  "pydantic>=2.9.0" \
  "httpx>=0.27.0" \
  "cryptography>=43.0.0" \
  "openpyxl>=3.1.5" \
  "python-multipart>=0.0.20" \
  "pandas>=2.2.0" \
  "numpy>=1.26.0"
ok "backend deps installed"

# Dataset engine deps, if present (pandas/openpyxl/numpy — mostly overlap).
if [ -f "${REPO_DIR}/dataset/requirements.txt" ]; then
  pip install -r "${REPO_DIR}/dataset/requirements.txt"
  ok "dataset/requirements.txt installed"
fi
deactivate

# -----------------------------------------------------------------------------
# 5. Build the frontend
# -----------------------------------------------------------------------------
log "Step 5/7 — frontend bundle (prefer a prebuilt dist)"
# On a power-constrained Orin (5V / 7W), compiling the frontend on the box
# risks a brownout. Preferred path: build frontend/dist on a laptop and ship
# it alongside the repo — this branch then skips Node + the Vite build
# entirely. Only fall back to an on-box build if no dist was shipped.
if [ -f "${REPO_DIR}/frontend/dist/index.html" ]; then
  ok "frontend/dist present — skipping on-box build (no Node needed)"
else
  warn "No prebuilt frontend/dist found — building on the box (heavier; ensure 19V power)."
  if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
    warn "Node 20+ not found. Installing via NodeSource ..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  echo "    node -> $(node -v),  npm -> $(npm -v)"
  ( cd "${REPO_DIR}/frontend" && npm ci && npm run build )
  ok "frontend built -> frontend/dist"
fi

# -----------------------------------------------------------------------------
# 6. Repo-root .env (fill-if-absent — never clobber an existing one)
# -----------------------------------------------------------------------------
log "Step 6/7 — repo-root .env"
ENV_FILE="${REPO_DIR}/.env"
if [ -f "${ENV_FILE}" ]; then
  ok ".env already exists — leaving it untouched"
else
  cat > "${ENV_FILE}" <<EOF
# SPIRE Orin Nano — generated by deploy/orin/setup.sh
SPIRE_LLM_PRIMARY_DISABLE=1
SPIRE_LLM_LOCAL=http://127.0.0.1:11434
SPIRE_LLM_LOCAL_MODEL=${MODEL}
EOF
  ok "wrote ${ENV_FILE}"
fi

# -----------------------------------------------------------------------------
# 7. Install + enable the systemd unit
# -----------------------------------------------------------------------------
log "Step 7/7 — spire.service"
UNIT_SRC="${SCRIPT_DIR}/spire.service"
UNIT_DST="/etc/systemd/system/spire.service"
# Template the placeholders from this machine's real paths/user.
sudo sed \
  -e "s|__SPIRE_USER__|${RUN_USER}|g" \
  -e "s|__SPIRE_DIR__|${REPO_DIR}|g" \
  -e "s|__SPIRE_VENV__|${VENV_DIR}|g" \
  "${UNIT_SRC}" | sudo tee "${UNIT_DST}" >/dev/null
ok "installed ${UNIT_DST}"

sudo systemctl daemon-reload
sudo systemctl enable spire.service
sudo systemctl restart spire.service
ok "spire.service enabled and (re)started"

# -----------------------------------------------------------------------------
# Done
# -----------------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
log "SPIRE is up."
echo
echo "    Open the UI on the LAN:   http://${IP:-<orin-ip>}:8000"
echo
echo "    Useful commands:"
echo "      systemctl status spire        # service health"
echo "      journalctl -u spire -f        # live backend logs"
echo "      ollama ps                     # what the GPU has loaded"
echo
