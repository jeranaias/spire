"""
Mission clock + scenario timeline (lane B4).

A scripted contested-fight scenario that runs from H+0 → H+72 with four
phases. Every view that wants to know "what time is it in the scenario"
reads from here. Operators can play/pause/seek/fast-forward through the
timeline so the demo is reproducible without waiting 72 wall-clock hours.

Design choices:

- Decoupled from real wall-clock time. Real seconds tick scenario minutes
  via a configurable `rate` (1×, 4×, 16×). Pause freezes the offset.
- Single global scenario. The hackathon demo runs one war game.
- Events are registered by H+offset_min and fire (idempotently) the first
  time a `/scenario/state` poll observes the offset has rolled past them.
  Frontend turns each newly-fired event into a `spire:scenario-event`
  window event so downstream lanes (B3 blood vignette, A1 scenario engine)
  can subscribe without coupling.
- State lives in this process. Reset returns to H+0 paused — same posture
  judges see on first load.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from threading import RLock
from typing import Any, Optional

# Module logger — recoverable scenario-hook failures get a WARNING here
# instead of being silently swallowed, so the backend workflow log
# keeps a breadcrumb without disturbing the clock surface.
_log = logging.getLogger(__name__)


# Phase boundaries in H+offset minutes. Matches the task spec.
_PHASES: list[tuple[int, str]] = [
    (0,           "Pre-conflict"),
    (24 * 60,     "Initial action"),
    (48 * 60,     "Sustainment crisis"),
    (72 * 60,     "Recovery"),
]

# Hard upper bound. Past this offset the clock keeps ticking but stays in
# Recovery. Used for the operator UI (slider max + "scenario complete" cue).
SCENARIO_MAX_OFFSET_MIN: int = 96 * 60  # H+96 — 1 day past the resupply close

# Allowed playback rates. 1× is real-time-equivalent (1 wall second = 1
# scenario minute is too fast; we use 1 wall second = 1 scenario minute *
# rate factor). 16× lets a 72h scenario run in ~4.5 wall minutes — fast
# enough for the demo, slow enough to read.
ALLOWED_RATES: tuple[int, ...] = (1, 4, 16)


@dataclass
class ScenarioEvent:
    """A scripted timeline event. `payload` travels to subscribers verbatim."""
    event_id: str
    offset_min: int
    title: str
    payload: dict[str, Any] = field(default_factory=dict)
    fired_at_offset: Optional[float] = None
    fired_wall: Optional[str] = None


# Canonical event registry. Populated from the W2 blood-h72 vignette
# (`dataset/data/blood-h72.scenario.json`) by `scenario_blood.registry_events()`
# so the six beats — Setup / Casualty / Forecast / Coalition / Action /
# Resolution — are the events the Mission Clock surfaces. Falls back to a
# minimal placeholder if the scenario JSON fails to load (so the clock
# still ticks during a config-edit mistake instead of taking the API down).
_REGISTRY: list[ScenarioEvent] = []


def _build_registry() -> list[ScenarioEvent]:
    try:
        from . import scenario_blood as _vignette
        events = _vignette.registry_events()
        if events:
            return [
                ScenarioEvent(
                    event_id=e["event_id"],
                    offset_min=int(e["offset_min"]),
                    title=e["title"],
                    payload=dict(e.get("payload") or {}),
                )
                for e in events
            ]
    except Exception as exc:
        # Fall through to the placeholder so a malformed JSON edit doesn't
        # break the clock surface, but leave a breadcrumb in the workflow
        # log so the operator can see *why* the W2 vignette didn't load.
        _log.warning(
            "scenario._build_registry(): falling back to placeholder "
            "registry — vignette load failed: %s",
            exc,
        )
    return [
        ScenarioEvent(
            event_id="evt.h0.scenario_start",
            offset_min=0,
            title="Scenario start — Pre-conflict posture",
            payload={"phase": "Pre-conflict"},
        ),
        ScenarioEvent(
            event_id="evt.h72.resupply_complete",
            offset_min=72 * 60,
            title="Resupply mission complete — Recovery begins",
            payload={"phase": "Recovery"},
        ),
    ]


_REGISTRY = _build_registry()


def rebuild_registry() -> int:
    """Re-source the canonical event registry from the W2 vignette.

    Called by `scenario_blood.reload()` after a live edit of the
    blood-h72 scenario JSON so the Mission Clock immediately picks up
    the new beats instead of waiting for a process restart. Returns the
    number of events now in the registry.

    Safe to call concurrently with `_tick_events_locked` because we
    swap the module-level `_REGISTRY` reference under `_LOCK` — readers
    grab the list once per tick and don't observe a partial swap.
    """
    global _REGISTRY
    new_registry = _build_registry()
    with _LOCK:
        _REGISTRY = new_registry
        # Drop fired entries that are no longer in the new registry so
        # a removed beat doesn't keep haunting `fired_events`. Keep
        # entries whose event_id still exists.
        valid_ids = {ev.event_id for ev in new_registry}
        _STATE.fired = {
            eid: ev for eid, ev in _STATE.fired.items()
            if eid in valid_ids
        }
        return len(new_registry)


def phase_for_offset(offset_min: float) -> str:
    """Return the human label for the current scenario phase."""
    label = _PHASES[0][1]
    for boundary, name in _PHASES:
        if offset_min >= boundary:
            label = name
        else:
            break
    return label


def phase_started_at_offset(offset_min: float) -> int:
    """Offset (in minutes) at which the current phase began."""
    started = _PHASES[0][0]
    for boundary, _name in _PHASES:
        if offset_min >= boundary:
            started = boundary
        else:
            break
    return started


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass
class ScenarioState:
    """Process-wide scenario singleton. Guarded by `_LOCK`."""
    running: bool = False
    rate: int = 1
    # Wall-clock anchor: the moment we last started/seeked/changed-rate.
    anchor_wall: datetime = field(default_factory=_utcnow)
    # Offset at the anchor moment.
    anchor_offset_min: float = 0.0
    # Subset of registry that has been observed-as-fired. Keyed by event_id.
    fired: dict[str, ScenarioEvent] = field(default_factory=dict)

    def offset_min(self, *, now: Optional[datetime] = None) -> float:
        """Compute the current scenario offset in minutes."""
        if not self.running:
            return self.anchor_offset_min
        n = now or _utcnow()
        wall_delta_sec = (n - self.anchor_wall).total_seconds()
        # 1× means 1 wall-second == 1 scenario-minute — that's fast for a
        # demo but readable. 16× compresses a 72-hour scenario into ~4.5
        # wall minutes which matches the Shark Tank time budget.
        offset = self.anchor_offset_min + (wall_delta_sec / 60.0) * self.rate * 60.0
        # Clamp at the upper bound so the clock doesn't run away if a
        # demo is left running unattended.
        return min(offset, float(SCENARIO_MAX_OFFSET_MIN))


_STATE: ScenarioState = ScenarioState()
_LOCK = RLock()


# ---------------------------------------------------------------------------
# Mutators — every public mutator takes the lock, re-anchors the clock so
# offset_min() stays continuous across rate/seek changes, and runs the
# event-tick before returning so subscribers never miss a transition.
# ---------------------------------------------------------------------------


def _reanchor(now: datetime) -> None:
    """Snap anchor_offset_min to the current observed offset and reset
    anchor_wall to `now`. Called whenever rate or running flips so the
    next `offset_min()` reading stays continuous."""
    _STATE.anchor_offset_min = _STATE.offset_min(now=now)
    _STATE.anchor_wall = now


def play() -> dict:
    with _LOCK:
        if not _STATE.running:
            _reanchor(_utcnow())
            _STATE.running = True
        _tick_events_locked()
        return serialize_locked()


def pause() -> dict:
    with _LOCK:
        if _STATE.running:
            _reanchor(_utcnow())
            _STATE.running = False
        _tick_events_locked()
        return serialize_locked()


def set_rate(rate: int) -> dict:
    if rate not in ALLOWED_RATES:
        raise ValueError(f"rate must be one of {ALLOWED_RATES}, got {rate}")
    with _LOCK:
        _reanchor(_utcnow())
        _STATE.rate = rate
        _tick_events_locked()
        return serialize_locked()


def seek(offset_min: float) -> dict:
    """Jump to a specific offset. Negative or out-of-range values clamp.

    Rewind / re-fire semantics — important for presenters:

      * Mission-clock `fired` set: events at or before the new offset
        stay fired; events past the new offset get cleared. So seeking
        backward then forward DOES re-fire crossed events on the
        clock surface.
      * W2 vignette injectors (audit rows, alerts, forecasts,
        requisitions in `scenario_blood._FEED`) are de-duped per play
        via `scenario_blood._DISPATCHED` and are NOT cleared by seek.
        So a backward-then-forward seek will not write duplicate
        audit rows or push duplicate feed entries — it stays silent
        for already-injected beats. To replay the injectors from the
        top, call `reset()` (which clears both surfaces).

    This split is intentional: the clock display benefits from being
    able to scrub freely during rehearsal, while the audit chain and
    decision feed must not contain spurious duplicates.
    """
    if offset_min < 0:
        offset_min = 0.0
    if offset_min > SCENARIO_MAX_OFFSET_MIN:
        offset_min = float(SCENARIO_MAX_OFFSET_MIN)
    with _LOCK:
        _STATE.anchor_offset_min = float(offset_min)
        _STATE.anchor_wall = _utcnow()
        # Clear fired events past the new offset (treat the seek as a
        # rewind so a subsequent forward-pass re-fires them) but keep
        # everything at-or-before the new offset marked as fired.
        _STATE.fired = {
            eid: ev for eid, ev in _STATE.fired.items()
            if ev.offset_min <= offset_min
        }
        _tick_events_locked()
        return serialize_locked()


def reset() -> dict:
    """Reset to H+0 paused, clearing fired events. The reset-demo lane
    (A5) wires this into the operator-facing reset button. Also clears
    the W2 vignette hook state so the back-to-back demo run produces
    identical injectors."""
    with _LOCK:
        _STATE.running = False
        _STATE.rate = 1
        _STATE.anchor_wall = _utcnow()
        _STATE.anchor_offset_min = 0.0
        _STATE.fired = {}
        try:
            from . import scenario_blood as _vignette
            _vignette.reset()
        except Exception as exc:  # noqa: BLE001
            _log.warning(
                "scenario.reset(): scenario_blood.reset() failed: %s",
                exc,
            )
        return serialize_locked()


# ---------------------------------------------------------------------------
# Event ticker — pure read-side. Idempotent: marks any event whose offset
# has been crossed as "fired" exactly once.
# ---------------------------------------------------------------------------


def _tick_events_locked() -> None:
    now = _utcnow()
    offset = _STATE.offset_min(now=now)
    newly_fired: list[ScenarioEvent] = []
    for ev in _REGISTRY:
        if ev.offset_min <= offset and ev.event_id not in _STATE.fired:
            fired = ScenarioEvent(
                event_id=ev.event_id,
                offset_min=ev.offset_min,
                title=ev.title,
                payload=dict(ev.payload),
                fired_at_offset=offset,
                fired_wall=_iso(now),
            )
            _STATE.fired[ev.event_id] = fired
            newly_fired.append(fired)
    if newly_fired:
        # Lane W2 hook — fire the blood-h72 vignette injectors (audit
        # rows + alert/forecast/req feed entries) for any beat whose event
        # just crossed. Tolerant: a hook failure must not freeze the clock
        # for everyone else.
        try:
            from . import scenario_blood as _vignette
            for fired in newly_fired:
                _vignette.dispatch_for_event(
                    fired.event_id,
                    fired_at_offset=fired.fired_at_offset,
                    fired_wall=fired.fired_wall,
                )
        except Exception as exc:  # noqa: BLE001
            _log.warning(
                "scenario._tick_events_locked(): vignette dispatch failed "
                "(event ids=%s): %s",
                [f.event_id for f in newly_fired], exc,
            )


def tick_and_serialize() -> dict:
    """Public entrypoint for /scenario/state — runs the event ticker so
    a poll naturally surfaces any events the offset has crossed."""
    with _LOCK:
        _tick_events_locked()
        return serialize_locked()


# ---------------------------------------------------------------------------
# Serialization — wire shape consumed by the FE store + topbar.
# ---------------------------------------------------------------------------


def _event_dict(ev: ScenarioEvent) -> dict:
    return {
        "event_id": ev.event_id,
        "offset_min": ev.offset_min,
        "title": ev.title,
        "payload": ev.payload,
        "fired_at_offset": ev.fired_at_offset,
        "fired_wall": ev.fired_wall,
    }


def serialize_locked() -> dict:
    now = _utcnow()
    offset = _STATE.offset_min(now=now)
    phase = phase_for_offset(offset)
    phase_started = phase_started_at_offset(offset)
    fired = sorted(_STATE.fired.values(), key=lambda e: e.offset_min)
    upcoming = [ev for ev in _REGISTRY if ev.event_id not in _STATE.fired]
    return {
        "now_wall": _iso(now),
        "running": _STATE.running,
        "rate": _STATE.rate,
        "allowed_rates": list(ALLOWED_RATES),
        "offset_min": round(offset, 3),
        "offset_label": format_offset_label(offset),
        "phase": phase,
        "phase_started_at_offset_min": phase_started,
        "max_offset_min": SCENARIO_MAX_OFFSET_MIN,
        "phases": [
            {"offset_min": b, "label": name} for b, name in _PHASES
        ],
        "fired_events": [_event_dict(e) for e in fired],
        "upcoming_events": [_event_dict(e) for e in upcoming],
        "registry_count": len(_REGISTRY),
    }


def format_offset_label(offset_min: float) -> str:
    """Format a scenario offset as `H+HHH:MM`. Uses three-digit hours so
    H+72 doesn't visually shrink next to H+96."""
    total_min = max(0, int(offset_min))
    hours, minutes = divmod(total_min, 60)
    return f"H+{hours:03d}:{minutes:02d}"


def snapshot() -> dict:
    """Read-only snapshot for callers that just want the current state
    without forcing a tick (useful for tests and audit payloads)."""
    with _LOCK:
        return serialize_locked()
