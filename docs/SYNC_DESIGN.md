# GC-2 sync design: what is implemented, what is simulated

Last updated: 2026-07-20

This document exists so nobody has to reverse-engineer the boundary between
working code and demo scaffolding. Read it before assessing GC-2.

## Terminology

SPIRE does not do distributed *consensus*. Consensus protocols (Raft, Paxos)
require a quorum to agree before a write commits. A node behind intermittent
SATCOM cannot reach a quorum, so consensus is the wrong tool for the problem.

What SPIRE does is CRDT-style reconciliation: accept every write locally,
carry causality metadata, merge on contact, and escalate genuinely concurrent
edits to an operator. The README previously said "distributed consensus
(CRDT)", which was both overstated and internally contradictory. It now reads
"CRDT-style reconciliation with operator conflict resolution (multi-node
replication in integration)".

## Implemented

Code: `backend/sync.py`, routes under `/api/system/sync/*`,
UI in `frontend/src/components/SystemStatusChip.tsx` and `NodeStatus.tsx`.

- **Vector clocks.** `VectorClock` with `tick`, `merge`, and `compare`.
  `compare` returns `equal`, `before`, `after`, or `concurrent`, with proper
  concurrency detection (neither clock dominates the other). This is the part
  that is genuinely hard to get right, and it is right.
- **Gossip merge.** `/sync/gossip` accepts a peer clock plus an event diff,
  merges the clock, classifies each incoming event as already-held, new, or
  conflicting with a local event on the same `record_id`, and returns the
  diff the peer should apply.
- **Conflict surface.** Concurrent edits to the same record become conflict
  records. `/sync/conflicts` lists them; the drawer renders both sides with
  actor, timestamp, clock, and payload.
- **Operator resolution.** `/sync/resolve/{id}` takes a winner. The losing
  side is not discarded - it is written to the audit chain as a
  `comms_conflict_resolved` entry. Last-writer-wins with the loser preserved
  is a deliberate choice: in a logistics context an operator must be able to
  see what the other node believed.
- **Audit integration.** Every resolution is an audit-chain append, so the
  reconciliation history is covered by the same hash chain and signature
  verification as everything else.

## Simulated

- **The peer node.** It runs in this process. `/sync/state` reports
  `peer_transport: "in_process_simulation"` and the drawer renders a
  SIMULATED PEER chip. No state crosses a wire between two physical nodes.
- **Conflict origination.** Conflicts in a demo come from
  `/sync/seed-conflict`, which deliberately injects one so the resolution
  flow can be walked. Real conflicts would arise from concurrent edits on
  two separated nodes.
- **Per-mutation clock bookkeeping.** Mutating endpoints do not each tick the
  vector clock today. `log_mutation` exists and is called from the sync paths,
  but it is not yet threaded through every write in the API.

## Plan for multi-node replication

Ordered by dependency. This is the work, not a promise of dates.

1. **Thread the clock through every mutation.** Every audit-chain append gets
   a vector clock entry, written in the same transaction. Without this, there
   is nothing coherent to replicate. This is the bulk of the work and it is
   mechanical rather than novel.
2. **Real transport.** A peer URL (`SPIRE_SYNC_PEER_URL`) plus an
   authenticated gossip exchange on a schedule and on reconnect. mTLS between
   nodes, reusing the CAC trust anchors. `PEER_TRANSPORT` flips to `network`.
3. **Store-and-forward.** Queue outbound diffs while the link is down; drain
   on reconnect with an exponential backoff. This is what makes it survive
   the DDIL profile rather than merely tolerate it.
4. **Two-node field test.** Two boxes, a cable to pull, divergent edits on
   both sides, reconnect, verify: clocks converge, conflicts surface, audit
   chains on both nodes verify independently.

## How to assess this honestly

- Open the sync drawer. If the SIMULATED PEER chip is showing, the peer is
  in-process. That chip disappearing is the signal that step 2 above landed.
- `GET /api/system/sync/state` reports `peer_transport` directly.
- Pulling the network cable will not change sync behaviour today, because
  nothing was crossing it. It will change LLM tier selection and the egress
  watchdog, which are real.
