"""
Model weight-loading hooks.

Checks SPIRE_SENTRY_WEIGHTS and SPIRE_PULSE_WEIGHTS environment variables
at boot. If a path is set AND the file exists AND torch is installed, loads
the model and exposes it for inference. Otherwise returns None and routes
fall back to their rule-based implementations (regex ensemble for SENTRY,
weighted-factor scoring for PULSE).

Designed so that when J1 / J2 training artifacts land from the RigRun
handoff, a single env var flip turns on live model inference without any
other code changes.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional


class ModelState:
    def __init__(self):
        self.sentry_model: Any = None
        self.sentry_tokenizer: Any = None
        self.sentry_path: Optional[str] = None
        self.pulse_model: Any = None
        self.pulse_path: Optional[str] = None
        self.errors: list[str] = []

    def load(self) -> None:
        try:
            import torch  # noqa: F401
        except ImportError:
            self.errors.append("torch not installed — models stay in fallback mode")
            return

        self._load_sentry()
        self._load_pulse()

    def _load_sentry(self) -> None:
        path = os.environ.get("SPIRE_SENTRY_WEIGHTS")
        if not path:
            return
        p = Path(path)
        if not p.exists():
            self.errors.append(f"SENTRY weights not found at {path}")
            return
        try:
            import torch
            # Expected format: torch.save({'state_dict': ..., 'vocab_size': N, 'classes': [...], 'flags': [...]})
            ckpt = torch.load(str(p), map_location="cpu", weights_only=False)
            self.sentry_model = ckpt
            self.sentry_path = str(p)
        except Exception as e:  # noqa: BLE001
            self.errors.append(f"SENTRY load failed: {e}")

    def _load_pulse(self) -> None:
        path = os.environ.get("SPIRE_PULSE_WEIGHTS")
        if not path:
            return
        p = Path(path)
        if not p.exists():
            self.errors.append(f"PULSE weights not found at {path}")
            return
        try:
            import torch
            ckpt = torch.load(str(p), map_location="cpu", weights_only=False)
            self.pulse_model = ckpt
            self.pulse_path = str(p)
        except Exception as e:  # noqa: BLE001
            self.errors.append(f"PULSE load failed: {e}")

    def status(self) -> dict:
        return {
            "sentry_loaded": self.sentry_model is not None,
            "sentry_path": self.sentry_path,
            "pulse_loaded": self.pulse_model is not None,
            "pulse_path": self.pulse_path,
            "errors": self.errors,
        }


STATE = ModelState()
STATE.load()


def is_sentry_loaded() -> bool:
    return STATE.sentry_model is not None


def is_pulse_loaded() -> bool:
    return STATE.pulse_model is not None
