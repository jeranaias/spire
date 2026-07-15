#!/bin/bash
set -e

# Post-merge setup for the SENTRY/BASTION/COP demo project.
# Reinstalls Python + JS dependencies after a task merge so workflows
# come back up cleanly. Idempotent and non-interactive.

# 1) Python deps — install from the same exact-pinned requirements the build
# and CI use, so dev doesn't drift from production.
if command -v pip >/dev/null 2>&1; then
  pip install -r backend/requirements.txt -r dataset/requirements.txt >/dev/null
fi

# 2) Frontend deps. Use npm ci when the lockfile is in sync,
# otherwise fall back to npm install so a drifted lockfile from
# a rebase doesn't kill the whole post-merge.
if [ -f frontend/package-lock.json ]; then
  (cd frontend && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund))
else
  (cd frontend && npm install --no-audit --no-fund)
fi
