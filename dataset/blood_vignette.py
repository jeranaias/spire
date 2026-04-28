"""
Blood / Class VIII H+72 vignette loader (Task #36 / Lane W2).

Reads the canonical scenario authored in `data/blood-h72.scenario.json`,
validates the shape downstream consumers depend on, and exposes a small
typed surface so the backend hooks (`backend/scenario_blood.py`) and the
scenario-engine FE lane (lane A1) read the same data.

The scenario file itself is *data, not code* — narration, beat ordering,
expected durations, and the inject side-effects can be edited without
touching this loader. This module's job is bounded:

  * Load + cache the JSON once.
  * Validate that every beat declares the fields downstream code reads
    (`event_id`, `offset_min`, `view`, `narration`, `inject`).
  * Expose `load_scenario()` for the hook module + an API route, and
    `beats_sorted()` for callers that walk the timeline in order.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

DATA_PATH = Path(__file__).parent / "data" / "blood-h72.scenario.json"
_CACHE: Optional[dict[str, Any]] = None

# Fields every beat must declare. The hook module / scenario player both
# read these; missing them at boot is a bug, not a runtime surprise.
#
# `classification` is required (Task #126): each beat's narration is
# rendered verbatim onto the cockpit, and a single screenshot needs the
# classification stamped on the same surface. A future scenario author
# who forgets the field would silently default the beat to CUI and
# re-introduce the OPSEC leak Task #50 closed — so the loader rejects
# the file at boot instead.
_REQUIRED_BEAT_KEYS = {
    "beat_id", "event_id", "offset_min", "phase", "title",
    "view", "overlay", "narration", "expected_duration_seconds_at_1x",
    "inject", "classification",
}

# Canonical classification levels mirrored from the FE
# (`frontend/src/components/classification/levels.ts`). The loader
# constrains beat `classification` to this exact set — a typo
# (`"Cui "`, `"sec"`, `"NOFORN"`) fails validation rather than
# mis-marking a screenshot.
ALLOWED_BEAT_CLASSIFICATIONS = frozenset({
    "UNCLASSIFIED", "CUI", "CONFIDENTIAL", "SECRET", "TOP_SECRET", "TS_SCI",
})

# Inject kinds the backend hook module knows how to dispatch. Anything
# else is allowed in the JSON for forward compatibility (the FE / future
# lanes might pick it up) but the hook module will skip it with a log.
KNOWN_INJECT_KINDS = {"audit", "alert", "forecast", "requisition", "toast"}


class ScenarioLoadError(RuntimeError):
    """Raised when the scenario JSON is missing required fields. Surfaces
    at backend boot so a malformed edit fails loud rather than silently
    breaking the demo mid-rehearsal."""


@dataclass(frozen=True)
class ScenarioBeat:
    """A single beat in the timeline. Mirrors the JSON shape so callers
    that prefer dataclasses can read `.event_id` / `.offset_min` without
    indexing into a dict."""
    beat_id: str
    event_id: str
    offset_min: int
    phase: str
    title: str
    view: str
    narration: str
    overlay: dict[str, Any]
    expected_duration_seconds_at_1x: int
    inject: list[dict[str, Any]]
    sources: list[str]
    # Per-beat classification stamp (Task #50). Each beat narration
    # describes doctrine-shaped activity (unit IDs, base names, forward
    # PARs); the cockpit + narration overlay render it verbatim, so a
    # single screenshot needs the classification on the same surface as
    # the prose. Required by the loader (Task #126) and constrained to
    # `ALLOWED_BEAT_CLASSIFICATIONS` so a future scenario can't omit
    # the field and silently default the beat to CUI.
    classification: str
    raw: dict[str, Any]  # full JSON for callers that want everything


def load_scenario(*, force_reload: bool = False) -> dict[str, Any]:
    """Return the parsed scenario dict. Cached on first call.

    `force_reload=True` re-reads from disk — useful when an operator
    edits narration mid-session and wants the change to take effect on
    the next play.
    """
    global _CACHE
    if _CACHE is not None and not force_reload:
        return _CACHE
    with open(DATA_PATH, encoding="utf-8") as f:
        data = json.load(f)
    _validate(data)
    _CACHE = data
    return data


def _validate(data: dict[str, Any]) -> None:
    if data.get("scenario_id") != "blood-h72":
        raise ScenarioLoadError(
            f"scenario_id must be 'blood-h72', got {data.get('scenario_id')!r}"
        )
    beats = data.get("beats")
    if not isinstance(beats, list) or not beats:
        raise ScenarioLoadError("`beats` must be a non-empty list")

    seen_event_ids: set[str] = set()
    seen_beat_ids: set[str] = set()
    last_offset = -1
    for i, beat in enumerate(beats):
        missing = _REQUIRED_BEAT_KEYS - set(beat.keys())
        if missing:
            raise ScenarioLoadError(
                f"beat #{i} ({beat.get('beat_id')!r}) missing required keys: "
                f"{sorted(missing)}"
            )
        if beat["event_id"] in seen_event_ids:
            raise ScenarioLoadError(
                f"duplicate event_id {beat['event_id']!r} at beat #{i}"
            )
        if beat["beat_id"] in seen_beat_ids:
            raise ScenarioLoadError(
                f"duplicate beat_id {beat['beat_id']!r} at beat #{i}"
            )
        seen_event_ids.add(beat["event_id"])
        seen_beat_ids.add(beat["beat_id"])
        offset = beat["offset_min"]
        if not isinstance(offset, int) or offset < 0:
            raise ScenarioLoadError(
                f"beat {beat['beat_id']!r} offset_min must be a non-negative int, got {offset!r}"
            )
        if offset < last_offset:
            raise ScenarioLoadError(
                f"beat {beat['beat_id']!r} offset_min={offset} regresses below previous beat ({last_offset})"
            )
        last_offset = offset
        if not isinstance(beat["inject"], list):
            raise ScenarioLoadError(
                f"beat {beat['beat_id']!r} inject must be a list (got {type(beat['inject']).__name__})"
            )
        for j, action in enumerate(beat["inject"]):
            if not isinstance(action, dict) or "kind" not in action:
                raise ScenarioLoadError(
                    f"beat {beat['beat_id']!r} inject[{j}] must be a dict with a 'kind' field"
                )
        # Per-beat classification (Task #126). The required-keys check
        # above guarantees the field is present; here we constrain it to
        # the canonical set. Compare strict — no normalize/uppercase —
        # so a typo (`"Cui "`, `"sec"`, `"NOFORN"`) fails loud rather
        # than mis-stamping the cockpit.
        cls = beat["classification"]
        if not isinstance(cls, str) or cls not in ALLOWED_BEAT_CLASSIFICATIONS:
            raise ScenarioLoadError(
                f"beat {beat['beat_id']!r} classification {cls!r} is not one of "
                f"{sorted(ALLOWED_BEAT_CLASSIFICATIONS)}"
            )


def beats_sorted() -> list[ScenarioBeat]:
    """Return the beats as ScenarioBeat dataclasses, in offset order."""
    data = load_scenario()
    out: list[ScenarioBeat] = []
    for raw in sorted(data["beats"], key=lambda b: b["offset_min"]):
        out.append(
            ScenarioBeat(
                beat_id=raw["beat_id"],
                event_id=raw["event_id"],
                offset_min=int(raw["offset_min"]),
                phase=raw["phase"],
                title=raw["title"],
                view=raw["view"],
                narration=raw["narration"],
                overlay=raw["overlay"],
                expected_duration_seconds_at_1x=int(raw["expected_duration_seconds_at_1x"]),
                inject=list(raw["inject"]),
                sources=list(raw.get("sources", [])),
                classification=raw["classification"],
                raw=raw,
            )
        )
    return out


def beat_for_event_id(event_id: str) -> Optional[ScenarioBeat]:
    """Lookup helper for the backend hook module."""
    for beat in beats_sorted():
        if beat.event_id == event_id:
            return beat
    return None
