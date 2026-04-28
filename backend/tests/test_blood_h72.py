"""
Lane W2 / Task #36 — Blood / Class VIII H+72 vignette content tests.

Asserts the contract every downstream lane (A1 scenario engine, MissionClock,
J3 fact-check) depends on:

  * The scenario JSON parses, declares the six required beats at the right
    H+offsets, and every beat declares the fields the FE/BE consume.
  * The lane B4 mission clock event registry is built FROM the vignette —
    seeking past each beat fires the matching event_id.
  * Each beat's `inject` actions run exactly once: audit rows land in the
    hash-chained log; alert/forecast/requisition rows land in the
    in-memory feed.
  * `/api/scenario/blood-h72` and `/api/scenario/blood-h72/feed` serve the
    config + injected events for the scenario engine to read.
  * Reset clears both the dispatched-set and the feed so a back-to-back
    rehearsal produces identical content.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import scenario as scenario_state
from backend import scenario_blood
from backend.main import app
from backend.persistence import recent_entries
from dataset.blood_vignette import beats_sorted, load_scenario


EXPECTED_BEATS = [
    ("beat.h0.setup",            "evt.h0.scenario_start",         0),
    ("beat.h12.casualty_event",  "evt.h12.casualty_event",        12 * 60),
    ("beat.h24.pulse_forecast",  "evt.h24.pulse_shortage_forecast", 24 * 60),
    ("beat.h36.coalition_scrub", "evt.h36.coalition_scrub",       36 * 60),
    ("beat.h48.bastion_action",  "evt.h48.bastion_action",        48 * 60),
    ("beat.h72.resolution",      "evt.h72.resupply_complete",     72 * 60),
]


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Static config — JSON loads + beats line up with the spec.
# ---------------------------------------------------------------------------

def test_scenario_loads_with_six_beats_at_expected_offsets():
    data = load_scenario(force_reload=True)
    assert data["scenario_id"] == "blood-h72"

    beats = beats_sorted()
    assert len(beats) == 6, "Spec calls for 6 beats: H+0/12/24/36/48/72"

    for beat, (expected_id, expected_event, expected_offset) in zip(beats, EXPECTED_BEATS):
        assert beat.beat_id == expected_id
        assert beat.event_id == expected_event
        assert beat.offset_min == expected_offset
        assert beat.narration, f"beat {beat.beat_id} narration empty"
        assert beat.expected_duration_seconds_at_1x > 0
        assert beat.inject, f"beat {beat.beat_id} declares no inject actions"
        # Every beat declares at least one audit injector — that's how the
        # lineage shows up in /system/audit at the close of the demo.
        assert any(a.get("kind") == "audit" for a in beat.inject), \
            f"beat {beat.beat_id} has no audit inject"


def test_scenario_meta_includes_setting_and_demand_model():
    meta = scenario_blood.scenario_meta()
    assert meta["loaded"] is True
    assert meta["scenario_id"] == "blood-h72"
    # The demand-model assumptions are the J3 fact-check surface.
    dm = meta["blood_demand_model"]
    assert dm["casualty_event_count"] == 14
    assert dm["mtp_units_per_patient"]["RBC_O_neg"] == 6
    assert dm["platelet_shelf_life_days"] == 5
    # Setting must declare the depots PULSE recommends.
    depot_ids = {d["depot_id"] for d in meta["setting"]["depots"]}
    assert {"USAF-KADENA", "USAF-YOKOTA"} <= depot_ids


# ---------------------------------------------------------------------------
# Mission-clock integration — the registry is built from the vignette.
# ---------------------------------------------------------------------------

def test_registry_matches_vignette_event_ids():
    state = scenario_state.snapshot()
    upcoming_ids = {ev["event_id"] for ev in state["upcoming_events"]}
    fired_ids = {ev["event_id"] for ev in state["fired_events"]}
    all_ids = upcoming_ids | fired_ids
    expected = {evt for _, evt, _ in EXPECTED_BEATS}
    # Reset first so we have a clean view if a prior test seeked the clock.
    scenario_state.reset()
    state = scenario_state.snapshot()
    upcoming_ids = {ev["event_id"] for ev in state["upcoming_events"]}
    fired_ids = {ev["event_id"] for ev in state["fired_events"]}
    all_ids = upcoming_ids | fired_ids
    assert expected <= all_ids


# ---------------------------------------------------------------------------
# Hook dispatch — seek past each beat fires its injectors exactly once.
# ---------------------------------------------------------------------------

def test_seek_to_h72_fires_all_six_beats_with_audit_rows():
    # Clean slate.
    scenario_state.reset()
    scenario_blood.reset()

    state = scenario_state.seek(72 * 60)
    fired_ids = [ev["event_id"] for ev in state["fired_events"]]
    expected = [evt for _, evt, _ in EXPECTED_BEATS]
    assert fired_ids == expected, f"expected {expected}, got {fired_ids}"

    # Every beat dropped at least one audit row (the `scenario_beat_fired`
    # row, plus any beat-specific audit injectors). Walk the recent rows
    # and confirm each beat shows up.
    rows = recent_entries(limit=200)
    audit_subjects = {r["subject_id"] for r in rows}
    for beat_id, _evt, _offset in EXPECTED_BEATS:
        assert any(s.startswith(f"blood-h72:{beat_id}") for s in audit_subjects), \
            f"no audit row for {beat_id}"


def test_dispatch_is_idempotent_within_a_play():
    scenario_state.reset()
    scenario_blood.reset()

    scenario_state.seek(72 * 60)
    feed_first = scenario_blood.feed(limit=500)
    count_first = len(feed_first)

    # A subsequent tick must not re-dispatch — fired set + dispatched set
    # both prevent it. Calling seek again to the same offset is a no-op.
    scenario_state.seek(72 * 60)
    feed_second = scenario_blood.feed(limit=500)
    assert len(feed_second) == count_first, \
        "injectors must not double-fire on subsequent ticks at the same offset"


def test_reset_clears_feed_and_audit_dispatch():
    scenario_state.reset()
    scenario_blood.reset()
    scenario_state.seek(72 * 60)
    assert scenario_blood.feed(limit=500), "feed should be populated after a full seek"

    scenario_state.reset()
    assert scenario_blood.feed(limit=500) == [], \
        "reset() must clear the W2 vignette feed"


def test_feed_contains_alert_forecast_and_requisition_kinds():
    scenario_state.reset()
    scenario_blood.reset()
    scenario_state.seek(72 * 60)

    rows = scenario_blood.feed(limit=500)
    kinds = {r["kind"] for r in rows}
    # The H+12 casualty beat injects a requisition; H+24 injects a
    # forecast; multiple beats inject alerts. All three must be present.
    assert "alert" in kinds
    assert "forecast" in kinds
    assert "requisition" in kinds
    assert "audit" in kinds


# ---------------------------------------------------------------------------
# HTTP API — config + feed endpoints.
# ---------------------------------------------------------------------------

def test_api_scenario_blood_returns_full_config(client: TestClient):
    _login(client, "1234567890")
    r = client.get("/api/system/scenario/blood-h72")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scenario_id"] == "blood-h72"
    assert len(body["beats"]) == 6
    assert body["global_sources"], "global sources required for J3 fact-check"


def test_api_scenario_blood_feed_round_trip(client: TestClient):
    _login(client, "1234567890")
    # Reset, then drive the clock forward via the public control API so
    # the test exercises the same path the demo uses.
    r = client.post("/api/system/scenario/control", json={"action": "reset"})
    assert r.status_code == 200, r.text
    r = client.post("/api/system/scenario/control",
                    json={"action": "seek", "offset_min": 72 * 60})
    assert r.status_code == 200, r.text

    r = client.get("/api/system/scenario/blood-h72/feed?limit=500")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scenario_id"] == "blood-h72"
    events = body["events"]
    assert events, "feed must be non-empty after seeking to H+72"
    # Filter test — ?kind=alert returns only alerts.
    r = client.get("/api/system/scenario/blood-h72/feed?kind=alert&limit=500")
    assert r.status_code == 200
    assert all(e["kind"] == "alert" for e in r.json()["events"])


# ---------------------------------------------------------------------------
# Negative path — a malformed JSON file at runtime must yield a structured
# 503, never a 500. The Mission Clock keeps ticking via the placeholder
# registry, but the W2 surfaces should advertise "not loaded" cleanly so
# the presenter can recover.
# ---------------------------------------------------------------------------

def test_runtime_load_failure_yields_structured_503(client: TestClient, monkeypatch):
    _login(client, "1234567890")

    from dataset import blood_vignette as bv

    def _broken(*_args, **_kwargs):
        raise bv.ScenarioLoadError("simulated malformed JSON: missing required key 'beats'")

    # `scenario_blood` did `from dataset.blood_vignette import …` so it
    # holds its own bound references — monkeypatch the module-level
    # names that scenario_blood actually calls, not just dataset.*.
    monkeypatch.setattr(scenario_blood, "load_scenario", _broken)
    monkeypatch.setattr(scenario_blood, "beats_sorted", _broken)
    scenario_blood.reload()

    try:
        # /scenario/blood-h72 must surface a 503 with a structured error,
        # not a 500 traceback.
        r = client.get("/api/system/scenario/blood-h72")
        assert r.status_code == 503, r.text
        body = r.json()
        assert body["detail"]["error"] == "ScenarioConfigUnavailable"
        assert "missing required key" in body["detail"]["message"]

        # Same for the feed endpoint.
        r = client.get("/api/system/scenario/blood-h72/feed?limit=10")
        assert r.status_code == 503, r.text
        assert r.json()["detail"]["error"] == "ScenarioConfigUnavailable"

        # And dispatch must degrade quietly — no traceback, just zero
        # injectors fired.
        assert scenario_blood.dispatch_for_event(
            "evt.h0.scenario_start", fired_at_offset=0, fired_wall=None
        ) == 0
    finally:
        # Unwind the monkeypatch and re-prime the cache so other tests
        # see the real scenario.
        monkeypatch.undo()
        scenario_blood.reload()
        assert scenario_blood.is_loaded(), \
            "real scenario must be reloadable after the failure simulation"


def test_reload_rebuilds_mission_clock_registry():
    """If the vignette is edited live, scenario_blood.reload() must
    propagate the new beats into the lane B4 mission-clock registry —
    otherwise the clock would stay on whatever it captured at boot."""
    # Force the registry to a known shape: real beats from the JSON.
    scenario_state.reset()
    before = scenario_state.snapshot()
    upcoming_before = {ev["event_id"] for ev in before["upcoming_events"]}
    fired_before = {ev["event_id"] for ev in before["fired_events"]}
    expected = {evt for _, evt, _ in EXPECTED_BEATS}
    assert expected <= (upcoming_before | fired_before)

    # Drop the registry to a single placeholder, then prove reload()
    # restores it from the vignette.
    placeholder = [
        scenario_state.ScenarioEvent(
            event_id="evt.placeholder",
            offset_min=0,
            title="placeholder",
            payload={},
        )
    ]
    scenario_state._REGISTRY = placeholder  # type: ignore[attr-defined]
    snap = scenario_state.snapshot()
    upcoming_ids = {ev["event_id"] for ev in snap["upcoming_events"]}
    fired_ids = {ev["event_id"] for ev in snap["fired_events"]}
    assert "evt.placeholder" in (upcoming_ids | fired_ids)

    n = scenario_blood.reload()
    assert n is True
    snap = scenario_state.snapshot()
    upcoming_ids = {ev["event_id"] for ev in snap["upcoming_events"]}
    fired_ids = {ev["event_id"] for ev in snap["fired_events"]}
    assert expected <= (upcoming_ids | fired_ids), \
        "reload() must rebuild the mission-clock registry from the vignette"


def test_reload_re_reads_json_from_disk(tmp_path, monkeypatch):
    """Live-edit reload contract: scenario_blood.reload() must bust the
    underlying dataset.blood_vignette._CACHE and re-read the JSON from
    disk, not just hand back the dict captured at process start. We
    point the loader at a temp copy of the canonical JSON, mutate it,
    then assert the new title shows up via the routes."""
    import json
    import shutil
    from dataset import blood_vignette as bv

    # Stage a fresh copy of the canonical JSON we can mutate freely.
    src = bv.DATA_PATH
    dst = tmp_path / "blood-h72.scenario.json"
    shutil.copy(src, dst)

    # Point the loader at the temp file. The module reads `DATA_PATH`
    # inside load_scenario(), so monkeypatching the module attribute
    # reroutes both load_scenario() and (transitively) beats_sorted().
    monkeypatch.setattr(bv, "DATA_PATH", dst, raising=False)

    try:
        # Prime the cache via the staged file.
        scenario_blood.reload()
        first = scenario_blood.scenario_meta()
        assert first["loaded"] is True
        original_title = first["title"]

        # Mutate the on-disk JSON (live edit during rehearsal).
        with open(dst) as f:
            raw = json.load(f)
        raw["title"] = "EDITED LIVE — Blood / Class VIII H+72 (test)"
        with open(dst, "w") as f:
            json.dump(raw, f)

        # Without reload, the cached dict still wins.
        cached = scenario_blood.scenario_meta()
        assert cached["title"] == original_title, \
            "cache must hold the original title until reload() is called"

        # reload() must re-read from disk and surface the new title.
        ok = scenario_blood.reload()
        assert ok is True
        fresh = scenario_blood.scenario_meta()
        assert fresh["title"] == "EDITED LIVE — Blood / Class VIII H+72 (test)", \
            "reload() must re-read JSON from disk, not return the cached dict"
    finally:
        # Restore canonical loader state for downstream tests.
        monkeypatch.undo()
        # Bust both caches so the canonical file is re-read.
        bv._CACHE = None  # type: ignore[attr-defined]
        scenario_blood.reload()
        assert scenario_blood.is_loaded()


def test_seek_does_not_re_inject_w2_audit_rows():
    """Document the rewind semantics: a backward-then-forward seek
    must NOT write duplicate audit rows or duplicate feed entries.
    Replaying the injectors from the top is a `reset()` operation."""
    scenario_state.reset()
    scenario_blood.reset()

    scenario_state.seek(72 * 60)
    feed_first = scenario_blood.feed(limit=500)
    rows_first = recent_entries(limit=200)
    audit_count_first = sum(
        1 for r in rows_first if r["subject_id"].startswith("blood-h72:")
    )

    # Rewind to H+24 then forward to H+72 again. The mission-clock
    # `fired` set re-marks them as fired (clock surface), but the W2
    # injectors must stay silent.
    scenario_state.seek(24 * 60)
    scenario_state.seek(72 * 60)

    feed_second = scenario_blood.feed(limit=500)
    rows_second = recent_entries(limit=200)
    audit_count_second = sum(
        1 for r in rows_second if r["subject_id"].startswith("blood-h72:")
    )

    assert len(feed_second) == len(feed_first), \
        "seek-rewind must not push duplicate feed entries"
    assert audit_count_second == audit_count_first, \
        "seek-rewind must not write duplicate audit rows"


# ---------------------------------------------------------------------------
# Task #126 — schema validator must reject beats that omit `classification`
# or declare a non-canonical value. Without these the cockpit silently
# defaults a forgotten beat to CUI and re-introduces the OPSEC leak Task #50
# closed.
# ---------------------------------------------------------------------------

def _minimal_valid_scenario() -> dict:
    """A two-beat scenario the validator accepts. Tests below clone this
    and selectively break a single beat field."""
    return {
        "scenario_id": "blood-h72",
        "beats": [
            {
                "beat_id": "beat.h0.setup",
                "event_id": "evt.h0.scenario_start",
                "offset_min": 0,
                "phase": "setup",
                "title": "H+0 — setup",
                "view": "cockpit",
                "overlay": {},
                "narration": "Setup narration.",
                "expected_duration_seconds_at_1x": 30,
                "inject": [],
                "classification": "CUI",
            },
            {
                "beat_id": "beat.h12.casualty_event",
                "event_id": "evt.h12.casualty_event",
                "offset_min": 12 * 60,
                "phase": "shock",
                "title": "H+12 — casualty",
                "view": "cockpit",
                "overlay": {},
                "narration": "Casualty narration.",
                "expected_duration_seconds_at_1x": 45,
                "inject": [],
                "classification": "SECRET",
            },
        ],
    }


def test_validator_rejects_beat_missing_classification():
    """A future scenario author who forgets `classification` must see a
    loud ScenarioLoadError at boot, not a silent default to CUI."""
    from dataset import blood_vignette as bv

    data = _minimal_valid_scenario()
    # Drop `classification` from the H+12 beat — emulates a copy/paste
    # oversight in a freshly-authored vignette.
    del data["beats"][1]["classification"]

    with pytest.raises(bv.ScenarioLoadError) as exc:
        bv._validate(data)
    msg = str(exc.value)
    assert "beat.h12.casualty_event" in msg
    assert "classification" in msg


def test_validator_rejects_beat_with_non_canonical_classification():
    """Typos like `"Cui "`, `"sec"`, or unknown caveats like `"NOFORN"`
    must fail validation rather than mis-marking the cockpit. The
    canonical set mirrors `frontend/.../classification/levels.ts`."""
    from dataset import blood_vignette as bv

    for bogus in ("Cui ", "sec", "NOFORN", "TOPSECRET", "", "secret"):
        data = _minimal_valid_scenario()
        data["beats"][0]["classification"] = bogus
        with pytest.raises(bv.ScenarioLoadError) as exc:
            bv._validate(data)
        msg = str(exc.value)
        assert "classification" in msg
        assert "beat.h0.setup" in msg, f"expected beat id in message for {bogus!r}: {msg}"

    # Wrong type (e.g. an int) is also rejected.
    data = _minimal_valid_scenario()
    data["beats"][0]["classification"] = 3
    with pytest.raises(bv.ScenarioLoadError):
        bv._validate(data)


def test_validator_accepts_each_canonical_classification():
    """Sanity: every level in ALLOWED_BEAT_CLASSIFICATIONS validates."""
    from dataset import blood_vignette as bv

    for level in bv.ALLOWED_BEAT_CLASSIFICATIONS:
        data = _minimal_valid_scenario()
        data["beats"][0]["classification"] = level
        bv._validate(data)  # must not raise


def test_canonical_scenario_still_validates():
    """Belt-and-suspenders: the real scenario JSON shipped with the
    repo must continue to pass validation after the new check is wired
    up. Without this guard a stale beat would break the demo at boot."""
    from dataset import blood_vignette as bv

    data = bv.load_scenario(force_reload=True)
    bv._validate(data)
    for beat in data["beats"]:
        assert beat["classification"] in bv.ALLOWED_BEAT_CLASSIFICATIONS, \
            f"beat {beat['beat_id']!r} ships with off-spec classification " \
            f"{beat['classification']!r}"
