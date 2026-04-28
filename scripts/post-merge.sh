#!/bin/bash
set -e

# Reinstall backend Python dependencies (uv resolves uv.lock).
if command -v uv >/dev/null 2>&1; then
  uv sync
fi

# Reinstall frontend Node dependencies. Use `npm ci` when the lockfile is
# present and consistent so the install is reproducible and fast.
if [ -d frontend ]; then
  cd frontend
  if [ -f package-lock.json ]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
  cd ..
fi
