"""
GC-2 — CRDT-style reconciliation primitives with operator conflict resolution.

Not consensus. Consensus protocols (Raft, Paxos) need a quorum to agree before
a write commits, which is exactly what a node behind intermittent SATCOM cannot
do. The approach here is the opposite: accept every write locally, carry a
vector clock keyed by node_id + counter, merge on contact, and hand genuinely
concurrent edits to the operator with the losing side preserved in the audit
chain. Calling that consensus would be both overstated and the wrong term.

What is real today is the math and the operator surface. The peer is an
in-process simulation - state does not replicate between two physical nodes
yet. See docs/SYNC_DESIGN.md for the line between implemented and simulated,
and the plan for multi-node replication.

The MVP shipped here:
- VectorClock dataclass + tick / merge / compare helpers.
- Simulated peer node (so a single backend can demo two-node sync).
- /sync/state — return this node's vector clock + a snapshot summary.
- /sync/gossip — accept a peer's clock + diff, merge, return our state.
- /sync/reconcile — force a reconciliation pass; surface conflicts in
  the response for the operator-facing modal.
- /sync/seed-conflict — for the demo, deliberately seed a conflict
  scenario so the CWO can walk through the resolution flow.

Per-mutation vector-clock bookkeeping in every endpoint is the
production work. The MVP keeps the math correct + the UI surface real;
production wires the clock into the persistence layer for every
audit-chain entry.
"""
from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


def node_id() -> str:
    """This node's identifier. Default MLG-NODE-0 unless SPIRE_NODE_ID is set."""
    return os.environ.get("SPIRE_NODE_ID", "MLG-NODE-0")


def peer_node_id() -> str:
    """Peer for the demo. SPIRE_PEER_NODE_ID env var; falls back to MEU-NODE-0."""
    return os.environ.get("SPIRE_PEER_NODE_ID", "MEU-NODE-0")


# The peer lives in this process. Nothing crosses a wire. Surfaced through
# /sync/state so the UI can label it and an assessor pulling a cable is never
# misled about what they are looking at. Flips to "network" when multi-node
# replication lands (docs/SYNC_DESIGN.md, Lane B).
PEER_TRANSPORT = "in_process_simulation"


@dataclass
class VectorClock:
    """Per-node monotonic counters. {node_id: counter}.
    Two clocks A, B: A < B iff every counter in A is ≤ B, and at least
    one is strictly less. A and B are *concurrent* iff neither A < B
    nor B < A — that's the conflict case."""
    counters: dict[str, int] = field(default_factory=dict)

    def tick(self, node: str) -> "VectorClock":
        new = dict(self.counters)
        new[node] = new.get(node, 0) + 1
        return VectorClock(new)

    def merge(self, other: "VectorClock") -> "VectorClock":
        keys = set(self.counters) | set(other.counters)
        return VectorClock({k: max(self.counters.get(k, 0), other.counters.get(k, 0)) for k in keys})

    def compare(self, other: "VectorClock") -> str:
        """This clock's causal relationship to ``other``.

        'before' = every counter is <= the other's and at least one is lower,
        i.e. this node is behind. 'after' is the mirror. 'concurrent' means
        each side has seen something the other has not, which is the case that
        needs an operator.
        """
        keys = set(self.counters) | set(other.counters)
        self_le_other = True   # no counter of ours exceeds theirs
        other_le_self = True   # no counter of theirs exceeds ours
        equal = True
        for k in keys:
            a = self.counters.get(k, 0)
            b = other.counters.get(k, 0)
            if a > b:
                self_le_other = False
            if a < b:
                other_le_self = False
            if a != b:
                equal = False
        if equal:
            return "equal"
        if self_le_other:
            return "before"
        if other_le_self:
            return "after"
        return "concurrent"

    def to_dict(self) -> dict:
        return dict(self.counters)


@dataclass
class SyncEvent:
    """One mutation with vector-clock metadata."""
    event_id: str
    op_kind: str
    record_id: str
    payload: dict
    clock: VectorClock
    actor: str
    at: str


# Global state for the demo: the local node's clock + a log of mutations
# with their clocks so we can show vector-clock evolution.
_LOCAL_CLOCK = VectorClock({node_id(): 0})
_EVENT_LOG: list[SyncEvent] = []
_PEER_CLOCK = VectorClock()  # populated via /sync/gossip
_CONFLICTS: list[dict] = []


def log_mutation(*, op_kind: str, record_id: str, payload: dict, actor: str) -> SyncEvent:
    """Tick the clock + append a SyncEvent. Called by mutation endpoints
    that opt in to the GC-2 demo (cannibalization propose, requisition
    draft, FPCON change, classification mark, etc.)."""
    global _LOCAL_CLOCK
    _LOCAL_CLOCK = _LOCAL_CLOCK.tick(node_id())
    ev = SyncEvent(
        event_id=f"EV-{uuid.uuid4().hex[:10]}",
        op_kind=op_kind,
        record_id=record_id,
        payload=payload,
        clock=VectorClock(dict(_LOCAL_CLOCK.counters)),
        actor=actor,
        at=datetime.utcnow().isoformat(timespec="seconds") + "Z",
    )
    _EVENT_LOG.append(ev)
    return ev


def state_summary() -> dict:
    """Snapshot for /sync/state."""
    return {
        "node_id": node_id(),
        "peer_node_id": peer_node_id(),
        "peer_transport": PEER_TRANSPORT,
        "local_clock": _LOCAL_CLOCK.to_dict(),
        "peer_clock": _PEER_CLOCK.to_dict(),
        "events_logged": len(_EVENT_LOG),
        "conflicts_pending": len([c for c in _CONFLICTS if not c.get("resolved_at")]),
        "compare": _LOCAL_CLOCK.compare(_PEER_CLOCK) if _PEER_CLOCK.counters else "no_peer_data",
    }


def absorb_peer_state(peer_clock: dict, peer_events: list[dict]) -> dict:
    """Apply a peer's gossip payload. Merge clocks, detect concurrent
    events as conflicts, return the diff we should send back."""
    global _LOCAL_CLOCK, _PEER_CLOCK
    incoming = VectorClock(peer_clock)
    _PEER_CLOCK = _PEER_CLOCK.merge(incoming)
    # Walk peer events, decide which we already have vs which are new vs
    # which conflict with a local event of the same record_id.
    new_count = 0
    conflict_count = 0
    by_record: dict[str, list[SyncEvent]] = {}
    for ev in _EVENT_LOG:
        by_record.setdefault(ev.record_id, []).append(ev)
    for pe in peer_events:
        rid = pe.get("record_id")
        peer_clock_obj = VectorClock(pe.get("clock", {}))
        local = by_record.get(rid, [])
        if not local:
            new_count += 1
            continue
        # Compare with the most recent local event for this record.
        last = local[-1]
        cmp = last.clock.compare(peer_clock_obj)
        if cmp == "concurrent":
            conflict_count += 1
            _CONFLICTS.append({
                "id": f"CONF-{uuid.uuid4().hex[:10]}",
                "record_id": rid,
                "op_kind": pe.get("op_kind"),
                "local_event": {
                    "event_id": last.event_id,
                    "actor": last.actor,
                    "at": last.at,
                    "clock": last.clock.to_dict(),
                    "payload": last.payload,
                },
                "peer_event": {
                    "event_id": pe.get("event_id"),
                    "actor": pe.get("actor"),
                    "at": pe.get("at"),
                    "clock": peer_clock_obj.to_dict(),
                    "payload": pe.get("payload", {}),
                },
                "detected_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                "resolved_at": None,
                "winner": None,
            })
    # Merge local clock with peer's so future ticks dominate both.
    _LOCAL_CLOCK = _LOCAL_CLOCK.merge(incoming)
    return {
        "merged_clock": _LOCAL_CLOCK.to_dict(),
        "new_events_absorbed": new_count,
        "conflicts_detected": conflict_count,
        "outgoing_events": [
            {
                "event_id": ev.event_id,
                "op_kind": ev.op_kind,
                "record_id": ev.record_id,
                "clock": ev.clock.to_dict(),
                "actor": ev.actor,
                "at": ev.at,
                "payload": ev.payload,
            }
            for ev in _EVENT_LOG
        ],
    }


def resolve_conflict(conflict_id: str, winner: str, actor: str) -> Optional[dict]:
    """Mark a conflict resolved. Loser stays in the audit chain so the
    history is preserved — this is the LWW-with-history pattern."""
    for c in _CONFLICTS:
        if c["id"] == conflict_id:
            c["resolved_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
            c["winner"] = winner
            c["resolved_by"] = actor
            return c
    return None


def conflicts_pending() -> list[dict]:
    return [c for c in _CONFLICTS if not c.get("resolved_at")]


def all_conflicts() -> list[dict]:
    return list(_CONFLICTS)


# Demo helper — preload a conflict scenario without requiring a real second
# node, so the CWO can walk through the resolution flow.
def seed_demo_conflict() -> dict:
    """Inject a deliberate conflict scenario directly into the pending list.

    The earlier implementation went through absorb_peer_state with a hand-
    crafted clock, but that path occasionally classified the seeded events
    as not-concurrent (depending on _LOCAL_CLOCK's prior state) and returned
    an empty pending list, which crashed the frontend's renderer. The
    deterministic version writes a fully-formed conflict record straight
    to _CONFLICTS so the demo path is reliable regardless of prior state.
    """
    rid = f"DEMO-CANN-{uuid.uuid4().hex[:6].upper()}"
    now = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    local_clock = {node_id(): 1}
    peer_clock = {peer_node_id(): 1}
    conflict = {
        "id": f"CONF-{uuid.uuid4().hex[:10]}",
        "record_id": rid,
        "op_kind": "cannibalization_proposal",
        "local_event": {
            "event_id": f"LOCAL-EV-{uuid.uuid4().hex[:8]}",
            "actor": "g4",
            "at": now,
            "clock": local_clock,
            "payload": {
                "recipient_sr": "SR-2025-1042",
                "donor_sr": "SR-2025-2150",
                "nsn": "2815-01-362-1492",
                "approver": "G-4 (2d MLG)",
            },
        },
        "peer_event": {
            "event_id": "PEER-EV-DEMO",
            "actor": "maintenance_chief",
            "at": now,
            "clock": peer_clock,
            "payload": {
                "recipient_sr": "SR-2025-1042",
                "donor_sr": "SR-2025-2151",
                "nsn": "2815-01-362-1492",
                "approver": "Maintenance Chief, CLB-6",
            },
        },
        "detected_at": now,
        "resolved_at": None,
    }
    _CONFLICTS.append(conflict)
    return conflict
