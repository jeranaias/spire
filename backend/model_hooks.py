"""
Model weight-loading hooks.

Checks SPIRE_SENTRY_WEIGHTS, SPIRE_PULSE_WEIGHTS, and
SPIRE_THERMALHAWK_WEIGHTS environment variables at boot. If a path is
set AND the file exists AND torch is installed, loads the model and
exposes it for inference. Otherwise returns None and routes fall back
to their rule-based implementations (regex ensemble for SENTRY,
weighted-factor scoring for PULSE, alert-only sim for ThermalHawk).

Designed so that when training artifacts land from the GH200 / RigRun
handoff, a single env var flip turns on live model inference without
any other code changes.

Loading semantics:
  - SENTRY / PULSE: lazy `torch.load` of the checkpoint dict. The
    inference glue (model class, tokenizer, head) ships separately and
    consumes `STATE.sentry_model` / `STATE.pulse_model` directly.
  - ThermalHawk: presence-only by default — we record that the weights
    file exists and report metadata, but do NOT instantiate the model
    on boot (the architecture lives in the thermalhawk repo and the
    1.77 M-param model would dominate cold-start). When SPIRE_THERMALHAWK_EAGER=1
    is set we also try to import `thermalhawk.models.ThermalHawk` and
    load the weights into it; this requires the thermalhawk package to
    be importable (pip install -e /d/projects/thermalhawk).
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
        # ThermalHawk presence-only (default) or live-loaded (eager).
        self.thermalhawk_path: Optional[str] = None
        self.thermalhawk_size_bytes: Optional[int] = None
        self.thermalhawk_model: Any = None
        self.thermalhawk_metadata: dict = {}
        self.errors: list[str] = []

    def load(self) -> None:
        # ThermalHawk presence detection runs even without torch installed —
        # operators can ship a SPIRE deploy without torch and still surface
        # 'weights present, inference disabled' in the status footer.
        self._detect_thermalhawk()
        try:
            import torch  # noqa: F401
        except ImportError:
            self.errors.append("torch not installed — SENTRY/PULSE models stay in fallback mode")
            return

        self._load_sentry()
        self._load_pulse()
        self._maybe_eager_thermalhawk()

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

    def _detect_thermalhawk(self) -> None:
        """File-presence + size detection for the ThermalHawk weights file.
        Runs even without torch — gives the StatusFooter something honest
        to render before the eager load kicks in (or in air-gap deploys
        without torch installed).
        """
        path = os.environ.get("SPIRE_THERMALHAWK_WEIGHTS")
        if not path:
            return
        p = Path(path)
        if not p.exists():
            self.errors.append(f"ThermalHawk weights not found at {path}")
            return
        try:
            self.thermalhawk_path = str(p)
            self.thermalhawk_size_bytes = p.stat().st_size
            # Public model card — capability + outcome only. Mechanism
            # details (backbone family, training protocol, head design)
            # stay with Thornveil's private ML package per LICENSE.md §2
            # and are not disclosed in the public SPIRE repo.
            self.thermalhawk_metadata = {
                "model": "ThermalHawk (Thornveil)",
                "capability": "thermal infrared drone detection",
                "deployment_target": "edge accelerator",
                "license": "Thornveil proprietary — see LICENSE.md §2",
                "contact": "jesse@thornveil.ai",
            }
        except Exception as e:  # noqa: BLE001
            self.errors.append(f"ThermalHawk presence-detect failed: {e}")

    def _maybe_eager_thermalhawk(self) -> None:
        """Eager-load the ThermalHawk detector when the Thornveil-licensed
        private ML package is installed AND weights are on disk. The
        architecture, training methodology, and inference helpers live
        in a Thornveil-managed private package; SPIRE only knows how to
        ask it to load + infer.

        Without the private package installed, this is a no-op — the
        sim alert advertises 'weights present, inference disabled' or
        falls through to scripted-sim mode."""
        if os.environ.get("SPIRE_THERMALHAWK_EAGER", "1") == "0":
            return
        if not self.thermalhawk_path:
            return
        try:
            # Thornveil private package — installed only on licensed deploys.
            from thornveil_ml.thermalhawk import load_detector  # type: ignore
        except Exception as e:  # noqa: BLE001
            self.errors.append(
                f"ThermalHawk live inference unavailable in this build "
                f"(Thornveil private package not installed): {type(e).__name__}"
            )
            return
        try:
            model = load_detector(self.thermalhawk_path, device="cpu")
            self.thermalhawk_model = model
            meta = getattr(model, "ckpt_meta", {}) or {}
            # Live-checkpoint metadata can override the static card
            # ONLY for capability-level signals (params count, val
            # accuracy figures the licensee already publishes).
            if meta.get("val_map") is not None:
                self.thermalhawk_metadata["validation_accuracy"] = float(meta["val_map"])
            if meta.get("params_reported") is not None:
                self.thermalhawk_metadata["parameters"] = int(meta["params_reported"])
        except Exception as e:  # noqa: BLE001
            self.errors.append(f"ThermalHawk eager-load failed: {e}")

    def status(self) -> dict:
        return {
            "sentry_loaded": self.sentry_model is not None,
            "sentry_path": self.sentry_path,
            "pulse_loaded": self.pulse_model is not None,
            "pulse_path": self.pulse_path,
            # ThermalHawk: weights_present means the .pt file is on disk;
            # model_loaded means inference is active (requires EAGER + import).
            "thermalhawk_weights_present": self.thermalhawk_path is not None,
            "thermalhawk_path": self.thermalhawk_path,
            "thermalhawk_size_mb": (
                round(self.thermalhawk_size_bytes / (1024 * 1024), 2)
                if self.thermalhawk_size_bytes else None
            ),
            "thermalhawk_model_loaded": self.thermalhawk_model is not None,
            "thermalhawk_metadata": self.thermalhawk_metadata,
            "errors": self.errors,
        }


STATE = ModelState()
STATE.load()


def is_sentry_loaded() -> bool:
    return STATE.sentry_model is not None


def is_pulse_loaded() -> bool:
    return STATE.pulse_model is not None


def is_thermalhawk_loaded() -> bool:
    """True only when the model class is loaded and ready for inference."""
    return STATE.thermalhawk_model is not None


def thermalhawk_weights_present() -> bool:
    """True when the weights file is on disk — sim alerts can advertise this
    without committing to live inference."""
    return STATE.thermalhawk_path is not None
