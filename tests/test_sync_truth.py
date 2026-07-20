"""GC-2 truth alignment (WI-2 Lane A).

The vector-clock math is real; the peer is not. These tests pin the labelling
so a future refactor cannot quietly re-inflate the claim. An assessor who
pulls a cable must never be surprised by what they find.
"""
from __future__ import annotations

from pathlib import Path

from backend import sync

REPO = Path(__file__).resolve().parent.parent


def test_state_reports_the_peer_as_simulated():
    state = sync.state_summary()
    assert state["peer_transport"] == "in_process_simulation"


def test_the_word_consensus_is_gone_from_shipped_surfaces():
    # "Consensus" is the wrong term for coordination-free replication, and it
    # overstates what runs. If multi-node replication ever lands, the honest
    # word is still "replication", not "consensus".
    for rel in ("README.md", "backend/sync.py", "backend/routes/system.py"):
        text = (REPO / rel).read_text(encoding="utf-8").lower()
        # sync.py explains why the term is wrong, so allow it there in that
        # context only: the ban is on claiming it, not on naming it.
        if rel == "backend/sync.py":
            assert "not consensus" in text
            continue
        assert "consensus" not in text, f"{rel} still claims consensus"


def test_concurrency_detection_is_the_part_that_is_real():
    a = sync.VectorClock({"A": 2, "B": 1})
    b = sync.VectorClock({"A": 1, "B": 2})
    assert a.compare(b) == "concurrent"
    assert a.merge(b).to_dict() == {"A": 2, "B": 2}
    assert sync.VectorClock({"A": 1}).compare(sync.VectorClock({"A": 1})) == "equal"


def test_ordering_points_the_direction_it_says():
    # The chip renders 'before' as BEHIND and 'after' as AHEAD, so an
    # inverted result puts the wrong direction in front of the operator.
    ahead = sync.VectorClock({"A": 3, "B": 2})
    behind = sync.VectorClock({"A": 1, "B": 2})
    assert ahead.compare(behind) == "after"
    assert behind.compare(ahead) == "before"
    # A key the other side has never seen still counts as being ahead.
    assert sync.VectorClock({"A": 1, "B": 1}).compare(sync.VectorClock({"A": 1})) == "after"
