"""
SENTRY Tier-1 text classifier -- labeled training corpus synthesis.

Generates ~15k labeled maintenance-remark samples from the dataset engine's
fault templates + sensitive.py injection rules. Each record carries:

  - text          : the rendered maintenance remark
  - labels        : multi-label set from {PII, GEO, COMMS, CLASSIFIED, CONTROLLED}
  - class         : single top-level class {CLEAN, SENSITIVE_PII, SENSITIVE_GEO,
                    SENSITIVE_COMMS, SENSITIVE_CLASSIFIED, SENSITIVE_MULTI}
  - classification: derived security level {UNCLASSIFIED, CUI, CONFIDENTIAL, SECRET}
  - source_class  : what an operator typed (matches derived 94% of the time,
                    under-marked 6% of the time -- this is the mis-marking
                    SENTRY catches in the demo)

Output is written as JSONL to data/sentry_train.jsonl with a balanced class
distribution suitable for SGDR training.
"""
from __future__ import annotations

import json
import random
import sys
from datetime import date
from pathlib import Path
from typing import List

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "dataset"))

from config import RANDOM_SEED, OUTPUT_TARGETS  # noqa: E402
from fleet import generate_fleet  # noqa: E402
from personnel import generate_personnel  # noqa: E402
from faults import EQUIPMENT_PROFILES, FaultEvent  # noqa: E402
from remarks import generate_remark  # noqa: E402

OUT = ROOT / "models" / "sentry_classifier" / "data"
OUT.mkdir(parents=True, exist_ok=True)

TARGET_SAMPLES_PER_CLASS = {
    "CLEAN":                5000,
    "SENSITIVE_PII":        2500,
    "SENSITIVE_GEO":        2000,
    "SENSITIVE_COMMS":      1500,
    "SENSITIVE_CLASSIFIED": 1500,
    "SENSITIVE_MULTI":      2500,
}


def _derive_class(flags: list) -> str:
    flag_set = set(flags)
    if "classified" in flag_set:
        if len(flag_set) > 1:
            return "SENSITIVE_MULTI"
        return "SENSITIVE_CLASSIFIED"
    if len(flag_set) >= 2:
        return "SENSITIVE_MULTI"
    if not flag_set:
        return "CLEAN"
    mapping = {
        "pii":         "SENSITIVE_PII",
        "geo":         "SENSITIVE_GEO",
        "comms":       "SENSITIVE_COMMS",
        "controlled":  "SENSITIVE_MULTI",
    }
    return mapping.get(next(iter(flag_set)), "CLEAN")


def _synthesize_one(asset, fault_event, mechanic, rng: random.Random, seq: int) -> dict:
    text, flags, classification = generate_remark(
        fault_event, asset, mechanic, date(2025, 10, 15), rng, seq=seq,
    )
    return {
        "text": text,
        "labels": flags,
        "class": _derive_class(flags),
        "classification": classification,
        "equipment_type": asset.equipment_type,
        "fault_component": fault_event.component,
        "fault_id": fault_event.fault_id,
        "deployment_status": asset.deployment_status,
    }


def build(seed: int = RANDOM_SEED) -> Path:
    rng = random.Random(seed + 10)

    units, assets = generate_fleet(seed)
    roster = generate_personnel(units, OUTPUT_TARGETS["personnel_count"], seed)

    # Cycle through assets + fault profiles to synthesize remarks. We keep
    # pulling samples until each class hits its target.
    samples: List[dict] = []
    class_counts = {cls: 0 for cls in TARGET_SAMPLES_PER_CLASS}

    # For the CLEAN class we explicitly force no deployment_status trigger and
    # skip classified faults; we also override probabilities by zeroing flags.
    MAX_ATTEMPTS = 200_000
    attempts = 0
    seq = 0

    while any(class_counts[c] < TARGET_SAMPLES_PER_CLASS[c] for c in class_counts):
        attempts += 1
        if attempts > MAX_ATTEMPTS:
            break

        # Adaptive deployment_status forcing -- GEO trigger requires a deployed
        # posture, so when the GEO class is short we temporarily flip an asset
        # to 'field_exercise' to ensure those records get synthesized.
        asset = rng.choice(assets)
        original_status = asset.deployment_status
        if class_counts["SENSITIVE_GEO"] < TARGET_SAMPLES_PER_CLASS["SENSITIVE_GEO"]:
            if rng.random() < 0.4:
                asset.deployment_status = "field_exercise"

        mechanic = rng.choice([m for m in roster if m.unit_name == asset.unit_name] or roster)
        profile = EQUIPMENT_PROFILES[asset.equipment_type]
        fault_profile = rng.choice(profile["faults"])
        fe = FaultEvent.from_profile(fault_profile, date(2025, 10, 15))

        seq += 1
        sample = _synthesize_one(asset, fe, mechanic, rng, seq)
        asset.deployment_status = original_status  # restore (we mutate lightly during sampling)

        cls = sample["class"]
        if class_counts.get(cls, 0) < TARGET_SAMPLES_PER_CLASS.get(cls, 0):
            samples.append(sample)
            class_counts[cls] += 1

    rng.shuffle(samples)
    out_path = OUT / "sentry_train.jsonl"
    with out_path.open("w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")

    summary_path = OUT / "sentry_train_summary.json"
    summary = {
        "total_samples": len(samples),
        "class_distribution": class_counts,
        "targets": TARGET_SAMPLES_PER_CLASS,
        "attempts": attempts,
        "example_per_class": {
            cls: next((s for s in samples if s["class"] == cls), None)
            for cls in TARGET_SAMPLES_PER_CLASS
        },
    }
    summary_path.write_text(json.dumps(summary, indent=2))

    print(f"Wrote {len(samples):,} labeled samples to {out_path.relative_to(ROOT)}")
    print(f"Class distribution:")
    for cls, n in class_counts.items():
        target = TARGET_SAMPLES_PER_CLASS[cls]
        flag = "OK" if n >= target else f"short (want {target})"
        print(f"  {cls:<22} {n:>5,} / {target:<5} {flag}")
    print(f"\nSummary: {summary_path.relative_to(ROOT)}")
    return out_path


if __name__ == "__main__":
    build()
