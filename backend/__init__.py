"""SPIRE backend package.

Loads a local ``.env`` (if present) into ``os.environ`` before any
submodule reads its configuration. Dependency-free — we don't pull in
python-dotenv. Real environment variables always win (we only fill
values that aren't already set), so Docker/fly/CI env injection is
never clobbered, and ``.env`` acts purely as the local-dev default.
"""
from __future__ import annotations

import os
from pathlib import Path


def _load_dotenv() -> None:
    # Repo root is one level up from this package directory.
    env_path = Path(__file__).resolve().parent.parent / ".env"
    try:
        raw = env_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        # Strip optional surrounding quotes; don't expand anything.
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv()
