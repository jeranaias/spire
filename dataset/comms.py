"""
Comms-state timeline + queued-op log for GC-7 Air-gap Deployment Mode.

SPIRE is designed to run inside an adversary's weapons-engagement zone
where SATCOM is intermittent at best. This module models the comms-state
lifecycle a SPIRE node experiences during deployed ops:

    CONNECTED → DEGRADED → DISCONNECTED → [mutations queued locally] →
    CONNECTED (sync-on-restore)

The backend /comms/state endpoint reads the current mock state; the
frontend StatusFooter pulses the indicator accordingly. The air-gap toggle
in the TopBar (GC-7) forces the state to DISCONNECTED and queues all
writes until the toggle is released.

Deterministic under a shared RNG so the demo scenario reproduces.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Optional


class CommsState(str, Enum):
    CONNECTED = "CONNECTED"
    DEGRADED = "DEGRADED"
    DISCONNECTED = "DISCONNECTED"


@dataclass
class CommsEvent:
    """One state-transition in the comms timeline."""
    at: datetime
    from_state: Optional[CommsState]
    to_state: CommsState
    reason: str
    node_id: str = "MLG-NODE-0"


@dataclass
class QueuedOperation:
    """A mutation attempted during disconnect; replayed on sync-restore."""
    queued_at: datetime
    op_kind: str   # e.g. "cannibalization_propose", "tmr_submit", "review_action"
    payload: dict
    actor: str
    actor_edipi: Optional[str] = None
    local_id: str = ""
    replayed_at: Optional[datetime] = None
    replay_result: Optional[str] = None  # "applied" | "conflict" | "rejected"


@dataclass
class SyncResolution:
    """Outcome log of a single queued op replayed against the master."""
    at: datetime
    local_id: str
    op_kind: str
    resolution: str  # "applied" | "conflict_lww_local" | "conflict_lww_remote" | "rejected"
    notes: str = ""


@dataclass
class CommsTimeline:
    events: list[CommsEvent] = field(default_factory=list)
    queued_ops: list[QueuedOperation] = field(default_factory=list)
    resolutions: list[SyncResolution] = field(default_factory=list)
    current_state: CommsState = CommsState.CONNECTED


def generate_comms_timeline(now: datetime, seed: int = 0) -> CommsTimeline:
    """Seed a plausible 14-day comms history for a deployed SPIRE node.

    Pattern: mostly CONNECTED with 2-3 DEGRADED windows and 1-2
    DISCONNECTED windows. Deterministic under seed."""
    import random
    rng = random.Random(seed + 777)
    events: list[CommsEvent] = [
        CommsEvent(now - timedelta(days=14), None, CommsState.CONNECTED, "node-initialised")
    ]
    last_state = CommsState.CONNECTED
    t = now - timedelta(days=14)
    # 14 days of one-transition-per-2-hour granularity
    while t < now:
        t += timedelta(hours=rng.randint(4, 36))
        if t >= now:
            break
        # 85% stay connected, 10% degraded, 5% disconnected
        r = rng.random()
        if r < 0.70:
            target = CommsState.CONNECTED
            reason = "satellite-link nominal"
        elif r < 0.92:
            target = CommsState.DEGRADED
            reason = rng.choice([
                "satcom-jitter 240ms",
                "throughput below threshold",
                "encryption-renegotiation",
                "weather-induced packet loss",
            ])
        else:
            target = CommsState.DISCONNECTED
            reason = rng.choice([
                "adversary EW event suspected",
                "satcom-window lapsed",
                "terminal-power fault",
                "cable fault ECP-1 to radio-shack",
            ])
        if target != last_state:
            events.append(CommsEvent(t, last_state, target, reason))
            last_state = target
    # Walkthrough: ensure the demo opens with CONNECTED. The 14-day walk can
    # leave the timeline mid-DEGRADED or mid-DISCONNECTED, which makes the
    # StatusFooter / StatusStrip read DEGRADED on first paint even when the
    # rest of the system (LLM, alerts, sync) is up. If the last_state isn't
    # CONNECTED, append a recovery event ~30 min ago so the operator lands
    # on a green comms posture and can simulate degradation explicitly.
    if last_state != CommsState.CONNECTED:
        events.append(
            CommsEvent(
                now - timedelta(minutes=30),
                last_state,
                CommsState.CONNECTED,
                "satellite-link recovered",
            )
        )
        last_state = CommsState.CONNECTED
    return CommsTimeline(events=events, current_state=last_state)


def format_state_for_api(timeline: CommsTimeline) -> dict:
    """Render a timeline into the /comms/state response body."""
    return {
        "current_state": timeline.current_state.value,
        "as_of": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds") + "Z",
        "recent_events": [
            {
                "at": e.at.isoformat(timespec="seconds") + "Z",
                "from": e.from_state.value if e.from_state else None,
                "to": e.to_state.value,
                "reason": e.reason,
                "node_id": e.node_id,
            }
            for e in timeline.events[-20:]
        ],
        "queued_ops_count": sum(1 for q in timeline.queued_ops if q.replayed_at is None),
        "last_sync_at": max((r.at for r in timeline.resolutions), default=None).isoformat(timespec="seconds") + "Z"
            if timeline.resolutions else None,
    }
