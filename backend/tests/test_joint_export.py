"""
Task #78 — joint export defect fixes (SIDC length, J7.2 correlation, snapshot
freshness, severity enum).

Each assertion below maps to one of the P0/P1 defects called out in
`.local/critiques/joint-cop.md` for the joint-coherence payload:

  * P0-1: every emitted SIDC string is exactly 15 characters (MIL-STD-2525C).
  * P0-2: J7.2 Track Correlation messages only emit when an entity has BOTH
    a J3.5 land point AND a J3.3 surface track, and pair the two distinct
    TNs (no self-correlations).
  * P0-3: per-message `asOfTime` and the envelope `asOfUtc` are sourced from
    the underlying snapshot, NOT wall-clock time — two back-to-back curls
    return identical `asOfUtc` when the dataset hasn't changed.
  * P1-9: alert severity values come from a single normalized enum
    {LOW, MODERATE, HIGH, CRITICAL}.

Task #146 — `publishedAtUtc` is sourced from the SPIRE mission-clock anchor,
not wall-clock. When the scenario is paused, two consecutive exports return
the same `publishedAtUtc`, so the JLTC topbar's "Published T-Ns" pill freezes
and the operator can see SPIRE's clock has stopped. When the scenario is
running, `publishedAtUtc` advances. Distinct from the data-as-of moment,
which now lives in `asOfUtc`.
"""
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from backend import scenario
from backend.main import app
from backend.routes.joint import ALERT_SEVERITY_ENUM, _sym2525
from backend.state import get_dataset


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


# A SECRET-cleared mock identity is enough for the joint exports — the
# require_clearance gate is "SECRET". Use a TS//SCI identity so role-scoping
# never excludes units we want to assert against.
TS_SCI_DODID = "3456789012"


# ---------------------------------------------------------------------------
# P0-1 — SIDC length
# ---------------------------------------------------------------------------

def test_sym2525_emits_15_char_sidc_for_every_unit():
    """Direct unit test: every unit name in the canonical dataset produces
    a 15-char SIDC. The OMS-UCI EntityState.sidc and Link 16 J3.5
    specificType fields both depend on this."""
    with TestClient(app):
        ds = get_dataset()
        for u in ds.units:
            sidc = _sym2525(u.name)
            assert len(sidc) == 15, (
                f"SIDC for {u.name!r} is {len(sidc)} chars, expected 15: {sidc!r}"
            )
            # Standard Identity F (friend), Battle dim G (ground), Status P
            assert sidc.startswith("SFGP"), sidc


def test_oms_uci_entity_sidc_is_15_chars_end_to_end(client: TestClient):
    """End-to-end: every EntityState in the OMS-UCI export carries a 15-char
    SIDC. Catches the case where SIDC generation regresses behind the
    serialization layer."""
    _login(client, TS_SCI_DODID)  # security manager, TS//SCI
    r = client.get("/api/joint/oms-uci/export")
    assert r.status_code == 200, r.text
    payload = r.json()
    entities = payload["messages"]["EntityState"]
    assert entities, "expected at least one EntityState in the export"
    for ent in entities:
        sidc = ent["EntityType"]["sidc"]
        assert len(sidc) == 15, f"EntityState SIDC not 15 chars: {sidc!r}"


def test_link16_j35_specific_type_is_15_char_sidc(client: TestClient):
    _login(client, TS_SCI_DODID)
    r = client.get("/api/joint/link16/export")
    assert r.status_code == 200, r.text
    payload = r.json()
    j35 = payload["messages"]["J3_5_LandPointTrack"]
    assert j35, "expected at least one J3.5 land-point track"
    for msg in j35:
        sidc = msg["specificType"]
        assert len(sidc) == 15, f"J3.5 specificType not 15 chars: {sidc!r}"


# ---------------------------------------------------------------------------
# P0-2 — J7.2 correlation pairs distinct TNs, only when both rep families
# ---------------------------------------------------------------------------

def test_j72_correlations_pair_distinct_tns_only_when_both_present(client: TestClient):
    _login(client, TS_SCI_DODID)
    r = client.get("/api/joint/link16/export")
    assert r.status_code == 200, r.text
    payload = r.json()

    j35_tns = {m["trackNumber"] for m in payload["messages"]["J3_5_LandPointTrack"]}
    j33_tns = {m["trackNumber"] for m in payload["messages"]["J3_3_SurfaceTrack"]}
    j72 = payload["messages"]["J7_2_TrackCorrelation"]

    # No self-correlations — that was the P0-2 bug giveaway.
    for corr in j72:
        assert corr["primaryTN"] != corr["secondaryTN"], (
            f"J7.2 self-correlation leaked: {corr!r}"
        )
        # Both sides must reference TNs that actually exist in the export.
        assert corr["primaryTN"] in j35_tns, (
            f"J7.2 primaryTN {corr['primaryTN']} not in any J3.5 message"
        )
        assert corr["secondaryTN"] in j33_tns, (
            f"J7.2 secondaryTN {corr['secondaryTN']} not in any J3.3 message"
        )

    # And the count must match the population of dual-rep entities — one
    # correlation per entity that has both a land point and a surface track.
    assert len(j72) == len(payload["messages"]["J3_3_SurfaceTrack"])


# ---------------------------------------------------------------------------
# P0-3 — asOfUtc is snapshot-derived and stable across calls (per-message
# `asOfTime` follows the same anchor)
# ---------------------------------------------------------------------------

def test_oms_uci_as_of_is_stable_across_calls(client: TestClient):
    """Two back-to-back exports against an unchanged dataset must return the
    same `asOfUtc` — the JLTC topbar's "As of" pill must reflect dataset
    freshness, not wall-clock time. Per-message `asOfTime` rides the same
    snapshot anchor so a partner sees consistent freshness across the
    envelope and the messages it carries."""
    _login(client, TS_SCI_DODID)
    r1 = client.get("/api/joint/oms-uci/export").json()
    r2 = client.get("/api/joint/oms-uci/export").json()
    assert r1["envelope"]["asOfUtc"] == r2["envelope"]["asOfUtc"]
    as_of = r1["envelope"]["asOfUtc"]
    for ent in r1["messages"]["EntityState"]:
        assert ent["asOfTime"] == as_of
    for trk in r1["messages"]["TrackData"]:
        assert trk["asOfTime"] == as_of
    for log in r1["messages"]["LogisticsStatus"]:
        assert log["asOfTime"] == as_of


def test_link16_as_of_is_stable_and_snapshot_anchored(client: TestClient):
    _login(client, TS_SCI_DODID)
    r1 = client.get("/api/joint/link16/export").json()
    r2 = client.get("/api/joint/link16/export").json()
    assert r1["header"]["asOfUtc"] == r2["header"]["asOfUtc"]

    # The data-as-of timestamp must encode the canonical snapshot date —
    # i.e. contain the YYYY-MM-DD of the last simulated day. (The
    # `publishedAtUtc` sibling field is now mission-clock-anchored and
    # has its own dedicated test below.)
    with TestClient(app):
        ds = get_dataset()
    last_date = ds.snapshots[-1].snapshot_date.isoformat()
    assert last_date in r1["header"]["asOfUtc"]


# ---------------------------------------------------------------------------
# Task #146 — `publishedAtUtc` is sourced from the SPIRE mission-clock
# anchor, freezes when the scenario is paused
# ---------------------------------------------------------------------------

def test_published_at_pinned_when_scenario_paused(client: TestClient):
    """Two consecutive exports with the scenario paused (no scenario-tick
    in between) MUST carry the same `publishedAtUtc`. This is the cue the
    JLTC topbar's "Published T-Ns" pill uses to freeze when SPIRE's clock
    has stopped — the partner can see at a glance that the scenario isn't
    advancing instead of being lied to with a confidently-fresh
    `_now_iso()` timestamp on every poll."""
    _login(client, TS_SCI_DODID)
    # Pause the scenario explicitly; the default state is paused at H+0
    # but other tests in the same process may have left it running.
    scenario.pause()
    try:
        r1_oms = client.get("/api/joint/oms-uci/export").json()
        time.sleep(0.05)  # ensure wall-clock advances between calls
        r2_oms = client.get("/api/joint/oms-uci/export").json()
        assert (
            r1_oms["envelope"]["publishedAtUtc"]
            == r2_oms["envelope"]["publishedAtUtc"]
        ), "OMS/UCI publishedAtUtc must be pinned while scenario is paused"

        r1_l16 = client.get("/api/joint/link16/export").json()
        time.sleep(0.05)
        r2_l16 = client.get("/api/joint/link16/export").json()
        assert (
            r1_l16["header"]["publishedAtUtc"]
            == r2_l16["header"]["publishedAtUtc"]
        ), "Link 16 publishedAtUtc must be pinned while scenario is paused"
    finally:
        # Leave the scenario paused for downstream tests so we don't
        # introduce a play() side effect across the test session.
        scenario.pause()


def test_published_at_distinct_from_as_of(client: TestClient):
    """`publishedAtUtc` (mission-clock anchor) and `asOfUtc` (dataset
    snapshot) answer different questions and the envelope must surface
    them as distinct fields. Concretely: after a process start the
    mission-clock anchor is `now`-ish, while the dataset snapshot is a
    historical date — the two should not collapse to one."""
    _login(client, TS_SCI_DODID)
    scenario.pause()
    payload = client.get("/api/joint/oms-uci/export").json()
    env = payload["envelope"]
    assert "publishedAtUtc" in env
    assert "asOfUtc" in env
    assert env["publishedAtUtc"] != env["asOfUtc"], (
        "publishedAtUtc must reflect the mission-clock anchor and asOfUtc "
        "the dataset snapshot — collapsing both to a single value erases "
        "the freshness vs publish-moment distinction the JLTC topbar relies on"
    )


def test_published_at_advances_when_scenario_running(client: TestClient):
    """Counterpart to the paused-pinning test: when the scenario IS
    running, the mission clock is advancing and `publishedAtUtc` must
    advance with it — otherwise a Marine watching JLTC would see a
    perpetually-frozen "Published" pill even during an active scenario."""
    _login(client, TS_SCI_DODID)
    scenario.play()
    try:
        r1 = client.get("/api/joint/oms-uci/export").json()
        time.sleep(1.1)  # > 1s so the seconds-precision ISO string moves
        r2 = client.get("/api/joint/oms-uci/export").json()
        assert (
            r1["envelope"]["publishedAtUtc"]
            != r2["envelope"]["publishedAtUtc"]
        ), "publishedAtUtc must advance while the scenario is running"
        # asOfUtc still points at the (unchanged) dataset snapshot, so it
        # should NOT have moved between the same two calls.
        assert r1["envelope"]["asOfUtc"] == r2["envelope"]["asOfUtc"]
    finally:
        scenario.pause()


# ---------------------------------------------------------------------------
# P1-9 — alert severity enum
# ---------------------------------------------------------------------------

def test_alert_severities_use_canonical_enum(client: TestClient):
    _login(client, TS_SCI_DODID)
    payload = client.get("/api/joint/oms-uci/export").json()
    for alert in payload["messages"]["AlertNotification"]:
        assert alert["severity"] in ALERT_SEVERITY_ENUM, (
            f"alert severity {alert['severity']!r} outside enum {ALERT_SEVERITY_ENUM}"
        )
