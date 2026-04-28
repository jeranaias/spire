"""
Blood / Class VIII H+72 vignette hook module (Task #36 / Lane W2).

Translates the scenario authored in `dataset/data/blood-h72.scenario.json`
into the runtime side-effects the demo needs:

  * Re-builds the lane-B4 scenario event registry from the vignette's
    six beats (H+0 setup → H+12 casualty → H+24 forecast → H+36 coalition
    → H+48 action → H+72 resolution). This replaces the placeholder
    registry in `backend/scenario.py` so the Mission Clock surfaces the
    real beats.
  * On each beat firing, dispatches the beat's `inject` actions:
      - `audit`        → writes a hash-chained row to the audit log so
                          `/api/system/audit` shows the decision lineage
                          end-to-end.
      - `alert`        → appends to an in-memory ring buffer that
                          `/api/scenario/blood-h72/feed` exposes for the
                          scenario-engine FE (lane A1).
      - `forecast`     → same buffer with a forecast tag so PULSE-style
                          surfaces can pick it out.
      - `requisition`  → same buffer with a requisition tag (the FE shows
                          this as a GCSS-MC-shaped request).
      - `toast`        → buffer + toast hint for the FE.
  * Idempotent: each beat fires its injectors at most once per scenario
    play. A `reset()` clears the buffer so the demo runs cleanly back-to-
    back.

The scenario engine UI (lane A1) is not in scope here — this module only
publishes the data so the player has something to read.
"""
from __future__ import annotations

import logging
import sys
from collections import deque
from pathlib import Path
from threading import RLock
from typing import Any, Optional

# Module-level logger so swallowed-exception paths still leave a
# breadcrumb in the backend workflow logs without taking down the
# scenario clock. Use WARNING for recoverable failures.
_log = logging.getLogger(__name__)

# Make `dataset/` importable when this module is loaded under uvicorn.
# `backend/state.py` does the same dance; we duplicate so this module can
# load standalone (e.g. pytest collecting `backend/tests/`).
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

try:
    from dataset.blood_vignette import (  # type: ignore[import-not-found]
        beats_sorted,
        load_scenario,
        ScenarioBeat,
        ScenarioLoadError,
    )
    _IMPORT_OK = True
    _IMPORT_ERROR: Optional[str] = None
except Exception as e:  # noqa: BLE001
    _IMPORT_OK = False
    _IMPORT_ERROR = f"{type(e).__name__}: {e}"
    # Stub out names so the rest of this module doesn't NameError at
    # parse time. Real callers gate on `is_loaded()` before using them.
    beats_sorted = lambda: []  # type: ignore[assignment]
    load_scenario = lambda: {}  # type: ignore[assignment]
    ScenarioBeat = object  # type: ignore[assignment,misc]
    class ScenarioLoadError(Exception):  # type: ignore[no-redef]
        pass

# Runtime load state: even if the *import* succeeded, the JSON itself
# might be malformed when first read (file edited live, IO error, etc).
# We probe lazily on the first call to `_ensure_loaded()` and cache the
# verdict so repeated polls don't re-parse on every request. A successful
# probe sets `_RUNTIME_OK = True`; a failure stores the error and lets
# the routes return a structured 503 instead of a 500.
_RUNTIME_OK: Optional[bool] = None
_RUNTIME_ERROR: Optional[str] = None


# In-memory ring buffer of injected events. The scenario player polls this
# (via /api/scenario/blood-h72/feed) to render the alert/forecast/req
# surfaces in step with the Mission Clock. Bounded so a runaway demo
# doesn't pin memory.
_FEED_MAX = 256
_FEED: deque[dict[str, Any]] = deque(maxlen=_FEED_MAX)
_FEED_LOCK = RLock()

# Track which beats we've already dispatched so a /scenario/state poll
# that re-reports the same fired event doesn't double-fire injectors.
# Note: the mission-clock `fired` set in scenario.py is rebuilt on
# seek (entries past the new offset get cleared, so a backward-then-
# forward seek DOES re-fire the clock event). _DISPATCHED here is
# play-scoped — it stays populated across seeks so the audit chain
# and feed never contain duplicate W2 injector rows. Cleared by
# reset() at the start of every play.
#
# Guarded by `_FEED_LOCK` so concurrent worker reads/writes (gunicorn
# multi-thread, async-tick races) can't observe a partial mutation.
_DISPATCHED: set[str] = set()


def _ensure_loaded(*, force_reload: bool = False) -> bool:
    """Probe the JSON and cache the verdict. Returns True if the
    scenario is usable; False if either the import failed or the JSON
    is malformed at runtime. Callers (routes, registry builder) should
    gate on this and surface `load_error()` for diagnostics.

    Pass `force_reload=True` to bust both this module's verdict cache
    AND the underlying `dataset.blood_vignette._CACHE`, so a probe
    actually re-reads the file from disk. `reload()` does this.
    """
    global _RUNTIME_OK, _RUNTIME_ERROR
    if not _IMPORT_OK:
        return False
    if not force_reload:
        if _RUNTIME_OK is True:
            return True
        if _RUNTIME_OK is False:
            return False
    # Probe — try to parse the file and walk the beats. If either
    # raises, we record the error and stay False until reload() is
    # called (which clears the cache).
    try:
        load_scenario(force_reload=force_reload)
        _ = beats_sorted()
        _RUNTIME_OK = True
        _RUNTIME_ERROR = None
        return True
    except TypeError:
        # Test monkeypatches sometimes substitute a stub that doesn't
        # accept the kw — fall back to the no-arg form.
        try:
            load_scenario()
            _ = beats_sorted()
            _RUNTIME_OK = True
            _RUNTIME_ERROR = None
            return True
        except ScenarioLoadError as exc:
            _RUNTIME_OK = False
            _RUNTIME_ERROR = f"ScenarioLoadError: {exc}"
            return False
        except Exception as exc:  # noqa: BLE001
            _RUNTIME_OK = False
            _RUNTIME_ERROR = f"{type(exc).__name__}: {exc}"
            return False
    except ScenarioLoadError as exc:
        _RUNTIME_OK = False
        _RUNTIME_ERROR = f"ScenarioLoadError: {exc}"
        return False
    except Exception as exc:  # noqa: BLE001
        _RUNTIME_OK = False
        _RUNTIME_ERROR = f"{type(exc).__name__}: {exc}"
        return False


def is_loaded() -> bool:
    """Whether the scenario is usable — both the module import and the
    runtime JSON parse must have succeeded. Lazily probes on first call
    so a malformed JSON edited *after* server start surfaces cleanly."""
    return _ensure_loaded()


def load_error() -> Optional[str]:
    """Human-readable description of why the scenario is unavailable
    (import failure or runtime parse error). None when healthy."""
    if not _IMPORT_OK:
        return _IMPORT_ERROR
    # Force a probe so callers that hit load_error() before is_loaded()
    # still get a useful message.
    _ensure_loaded()
    return _RUNTIME_ERROR


def reload() -> bool:
    """Clear the cached runtime verdict, re-probe, and ask the lane B4
    Mission-Clock registry to rebuild itself from the (re-parsed)
    vignette JSON. Useful after a live edit of the scenario JSON during
    a demo dry run — without the registry rebuild, the mission clock
    would otherwise stay on whatever events it captured at process
    boot.

    Returns the new is_loaded() verdict. The registry rebuild is best
    effort; a circular-import or missing-module error is swallowed so
    the loader probe still gets cached.
    """
    global _RUNTIME_OK, _RUNTIME_ERROR
    _RUNTIME_OK = None
    _RUNTIME_ERROR = None
    # `force_reload=True` re-reads the JSON from disk (busts the
    # underlying dataset.blood_vignette._CACHE) so a live edit during
    # rehearsal actually shows up. Without this the loader would
    # return the cached dict from process start.
    ok = _ensure_loaded(force_reload=True)
    try:
        # Local import to avoid a circular at module load: scenario.py
        # imports scenario_blood inside _build_registry().
        from . import scenario as _scenario
        _scenario.rebuild_registry()
    except Exception as exc:  # noqa: BLE001
        _log.warning(
            "scenario_blood.reload(): mission-clock registry rebuild failed: %s",
            exc,
        )
    return ok


def scenario_meta() -> dict[str, Any]:
    """Compact metadata block for /api/scenario/blood-h72 — the FE A1
    lane uses this to render the timeline before the clock advances."""
    if not _ensure_loaded():
        return {"loaded": False, "error": load_error()}
    try:
        data = load_scenario()
        beats = beats_sorted()
    except Exception as exc:  # noqa: BLE001
        # Late failure (file truncated between probe and call) — degrade
        # gracefully rather than 500.
        global _RUNTIME_OK, _RUNTIME_ERROR
        _RUNTIME_OK = False
        _RUNTIME_ERROR = f"{type(exc).__name__}: {exc}"
        return {"loaded": False, "error": _RUNTIME_ERROR}
    return {
        "loaded": True,
        "scenario_id": data["scenario_id"],
        "version": data["version"],
        "title": data["title"],
        "summary": data["summary"],
        "duration_minutes": data["duration_minutes"],
        "phases": data["phases"],
        "setting": data["setting"],
        "blood_demand_model": data["blood_demand_model"],
        "speed_validation": data.get("speed_validation", {}),
        "beats": [
            {
                "beat_id": b.beat_id,
                "event_id": b.event_id,
                "offset_min": b.offset_min,
                "phase": b.phase,
                "title": b.title,
                "view": b.view,
                "overlay": b.overlay,
                "narration": b.narration,
                "expected_duration_seconds_at_1x": b.expected_duration_seconds_at_1x,
                "inject_kinds": [a.get("kind") for a in b.inject],
                "sources": b.sources,
                # Per-beat classification (Task #50). The cockpit timeline
                # rows + narration overlay stamp this so a single screenshot
                # of the presenter UI carries the prose's classification on
                # the same surface as the prose itself.
                "classification": b.classification,
            }
            for b in beats
        ],
        "global_sources": data.get("global_sources", []),
    }


def registry_events() -> list[dict[str, Any]]:
    """Wire shape consumed by `backend/scenario.py` to populate the
    process-wide event registry. Each entry is `{event_id, offset_min,
    title, payload}` matching the existing `ScenarioEvent` dataclass.

    Returns `[]` (not raises) when the scenario fails to load — callers
    fall back to a placeholder registry so the Mission Clock keeps
    ticking even with a broken vignette JSON."""
    if not _ensure_loaded():
        return []
    try:
        beats = beats_sorted()
    except Exception as exc:  # noqa: BLE001
        global _RUNTIME_OK, _RUNTIME_ERROR
        _RUNTIME_OK = False
        _RUNTIME_ERROR = f"{type(exc).__name__}: {exc}"
        return []
    out: list[dict[str, Any]] = []
    for beat in beats:
        out.append({
            "event_id": beat.event_id,
            "offset_min": beat.offset_min,
            "title": beat.title,
            "payload": {
                "scenario_id": "blood-h72",
                "beat_id": beat.beat_id,
                "phase": beat.phase,
                "view": beat.view,
                "overlay": beat.overlay,
                "expected_duration_seconds_at_1x": beat.expected_duration_seconds_at_1x,
            },
        })
    return out


def feed(*, since_offset_min: Optional[float] = None,
        kinds: Optional[list[str]] = None,
        limit: int = 100) -> list[dict[str, Any]]:
    """Return injected events. Optional filters:
      - `since_offset_min` — only events whose source-beat offset > this
      - `kinds` — restrict to the listed inject kinds
      - `limit` — cap rows (most recent first)
    """
    with _FEED_LOCK:
        rows = list(_FEED)
    if since_offset_min is not None:
        rows = [r for r in rows if r.get("source_offset_min", 0) > since_offset_min]
    if kinds:
        wanted = set(kinds)
        rows = [r for r in rows if r.get("kind") in wanted]
    rows.sort(key=lambda r: (r.get("source_offset_min", 0), r.get("dispatched_at_offset", 0)))
    return rows[-limit:]


def reset() -> None:
    """Clear the dispatched-set + feed. Wired into the lane B4 reset flow
    so a back-to-back demo gets the same posture both times."""
    with _FEED_LOCK:
        _FEED.clear()
        _DISPATCHED.clear()


# ---------------------------------------------------------------------------
# Dispatch — called from `backend/scenario.py` whenever an event crosses
# its offset for the first time. Idempotent on `event_id`.
# ---------------------------------------------------------------------------

def dispatch_for_event(
    event_id: str,
    *,
    fired_at_offset: Optional[float],
    fired_wall: Optional[str],
) -> int:
    """Fire all `inject` actions for the beat keyed by `event_id`.

    Returns the number of injectors that ran (0 if the event isn't part
    of the blood vignette, or if it was already dispatched). Tolerant of
    audit-log unavailability — a misbehaving persistence layer must not
    take down the scenario clock.
    """
    if not _ensure_loaded():
        return 0

    try:
        all_beats = beats_sorted()
    except Exception as exc:  # noqa: BLE001
        _log.warning(
            "scenario_blood.dispatch_for_event(%r): could not list beats: %s",
            event_id, exc,
        )
        return 0
    beat: Optional[ScenarioBeat] = None
    for b in all_beats:
        if b.event_id == event_id:
            beat = b
            break
    if beat is None:
        return 0

    # Atomic check-and-set under the feed lock so two concurrent ticks
    # crossing the same beat boundary can't both pass the membership
    # check and dispatch the injectors twice.
    with _FEED_LOCK:
        if event_id in _DISPATCHED:
            return 0
        _DISPATCHED.add(event_id)
    count = 0
    for action in beat.inject:
        try:
            _dispatch_one(beat, action, fired_at_offset, fired_wall)
            count += 1
        except Exception as exc:  # noqa: BLE001
            # Log to the feed so the FE can show an inject failure rather
            # than silently swallowing it. The scenario clock is unaffected.
            _log.warning(
                "scenario_blood.dispatch_for_event(%r): inject action %r "
                "failed: %s",
                event_id, action.get("kind"), exc,
            )
            _push_feed({
                "kind": "_inject_error",
                "source_beat_id": beat.beat_id,
                "source_event_id": beat.event_id,
                "source_offset_min": beat.offset_min,
                "dispatched_at_offset": fired_at_offset,
                "dispatched_wall": fired_wall,
                "error": f"{type(exc).__name__}: {exc}",
                "action_kind": action.get("kind"),
            })
    return count


def _dispatch_one(
    beat: ScenarioBeat,
    action: dict[str, Any],
    fired_at_offset: Optional[float],
    fired_wall: Optional[str],
) -> None:
    """Side-effect dispatcher for a single inject action."""
    kind = action.get("kind")
    if kind == "audit":
        _dispatch_audit(beat, action)
    # Audit + buffer: writing to the buffer ensures the FE can render
    # everything (alerts/forecasts/requisitions/toasts) on a single poll.
    _push_feed({
        "kind": kind or "unknown",
        "source_beat_id": beat.beat_id,
        "source_event_id": beat.event_id,
        "source_offset_min": beat.offset_min,
        "source_view": beat.view,
        "phase": beat.phase,
        "dispatched_at_offset": fired_at_offset,
        "dispatched_wall": fired_wall,
        "action": action,
    })


def _dispatch_audit(beat: ScenarioBeat, action: dict[str, Any]) -> None:
    """Append a hash-chained audit row. Local import keeps this module
    free of a hard backend.persistence dependency at import time so
    pytest collection doesn't choke if the runtime SQLite isn't bootable
    (e.g. on a read-only mount during static analysis)."""
    from .persistence import log as audit_log

    audit_kind = action.get("audit_kind") or "scenario_inject"
    subject_id = action.get("subject_id") or f"blood-h72:{beat.beat_id}"
    payload = dict(action.get("payload") or {})
    # Stamp every audit row with scenario provenance so the SOC view can
    # filter rows by the originating vignette.
    payload.setdefault("scenario_id", "blood-h72")
    payload.setdefault("beat_id", beat.beat_id)
    payload.setdefault("event_id", beat.event_id)
    audit_log(audit_kind, actor="scenario.blood-h72", subject_id=subject_id, payload=payload)


def _push_feed(row: dict[str, Any]) -> None:
    with _FEED_LOCK:
        _FEED.append(row)
