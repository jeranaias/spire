"""
Task-31 — focused integration test for /pulse/model-card.

Asserts the in-PULSE model-card endpoint returns:
  * an `engine` block whose public_label honestly reflects fallback mode
    when no torch weights are loaded
  * a `loss_function` block with FN penalty 5x and FP penalty 1x
  * a baselines list with model + random + sop + prior_contractor entries
    that share the same N (same eval set drives every metric)
  * a `confusion_matrix` whose tp/fp/fn/tn matches the model baseline
  * a `split` with non-empty train/val/test counts and ordered date ranges
  * a `drift` block with a monthly series + alert array (may be empty)
  * a `last_validation` block with a methodology link to the canonical
    model card under /admin/models/pulse-risk-scorer

The endpoint is deterministic under RANDOM_SEED=42, so any drift in the
returned numbers is a real regression.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str = "1234567890") -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def test_model_card_shape_and_engine_label(client):
    _login(client)
    r = client.get("/api/pulse/model-card")
    assert r.status_code == 200, r.text
    body = r.json()

    # Engine label must be honest: no torch weights → rule-based fallback.
    eng = body["engine"]
    assert eng["public_label"] == "rule-based fallback"
    assert eng["internal_id"] == "rule_based_v1"
    assert eng["weights_path"] is None

    # Loss function reflects the J3 DELTA-required wording.
    loss = body["loss_function"]
    assert loss["weights"]["false_negative"] == 5
    assert loss["weights"]["false_positive"] == 1
    assert loss["horizon_days"] == 30
    assert "false-negatives" in loss["headline"]


def test_model_card_baselines_share_eval_set(client):
    _login(client)
    body = client.get("/api/pulse/model-card").json()

    baselines = {b["key"]: b for b in body["baselines"]}
    for key in ("model", "random", "sop", "prior_contractor"):
        assert key in baselines, f"missing baseline: {key}"

    n_set = {b["n"] for b in body["baselines"]}
    assert len(n_set) == 1, "all baselines must score the same eval set"
    assert next(iter(n_set)) > 0

    # Random chance should sit near 50% accuracy; the rule-based model
    # must clear it. SOP exists as a published comparator.
    assert baselines["random"]["accuracy"] < 0.7
    assert baselines["model"]["accuracy"] > baselines["random"]["accuracy"]


def test_model_card_confusion_matrix_matches_model_baseline(client):
    _login(client)
    body = client.get("/api/pulse/model-card").json()

    model = next(b for b in body["baselines"] if b["key"] == "model")
    cm = body["confusion_matrix"]
    assert cm["tp"] == model["tp"]
    assert cm["fp"] == model["fp"]
    assert cm["fn"] == model["fn"]
    assert cm["tn"] == model["tn"]
    assert cm["n"] == model["n"]


def test_model_card_split_is_ordered_and_non_empty(client):
    _login(client)
    body = client.get("/api/pulse/model-card").json()

    split = body["split"]
    assert split["train_n"] > 0
    assert split["val_n"] > 0
    assert split["test_n"] > 0
    # Dates lex-sort identically to date-sort because they're ISO-8601.
    assert split["train_start"] < split["train_end"]
    assert split["train_end"] < split["val_start"]
    assert split["val_end"] < split["test_start"]
    assert split["test_start"] <= split["test_end"]


def test_model_card_drift_and_validation_links(client):
    _login(client)
    body = client.get("/api/pulse/model-card").json()

    drift = body["drift"]
    assert isinstance(drift["series"], list)
    assert len(drift["series"]) >= 6, "expect at least 6 monthly buckets"
    for p in drift["series"]:
        assert {"period", "n", "nmc_rate", "avg_days_deadlined"} <= set(p.keys())
    assert isinstance(drift["alerts"], list)

    val = body["last_validation"]
    assert val["methodology_link"].endswith("/admin/models/pulse-risk-scorer")
    assert body["canonical_model_card_url"].endswith("/admin/models/pulse-risk-scorer")


def test_model_card_includes_forecast_calibration(client):
    """Task #130 — the model card detail page renders the same
    regression-band calibration the Forecast tab reports. The block
    must include the headline coverage, sample size, target, a short
    methodology string, and the 50/80/95 reliability bins. The 80%
    bin's realized coverage MUST equal the headline number — they're
    the same metric and divergence here would be a UI lie."""
    _login(client)
    body = client.get("/api/pulse/model-card", params={"refresh": True}).json()

    assert "forecast_calibration" in body, (
        "model card must surface forecast band calibration so a judge "
        "clicking 'model card →' lands somewhere that mentions it"
    )
    fc = body["forecast_calibration"]
    assert fc["coverage_target"] == 0.80
    assert isinstance(fc["coverage_n"], int) and fc["coverage_n"] >= 60, (
        "trailing-90 backtest should evaluate on most of the window"
    )
    assert isinstance(fc["methodology"], str) and "30-day" in fc["methodology"]

    bins = fc["reliability_bins"]
    nominals = [b["nominal"] for b in bins]
    assert nominals == [0.5, 0.8, 0.95], (
        "reliability bins must sweep 50/80/95 in ascending order"
    )
    for b in bins:
        assert b["n"] == fc["coverage_n"], "each bin scores the full backtest"
        assert isinstance(b["realized"], float)
        assert 0.0 <= b["realized"] <= 1.0

    eighty = next(b for b in bins if b["nominal"] == 0.8)
    assert eighty["realized"] == fc["coverage_p10_p90"], (
        "the 80% reliability bin and the headline coverage_p10_p90 are "
        "the same metric — they MUST agree"
    )


def test_forecast_and_model_card_share_calibration_helper(client):
    """Task #130 — both endpoints share `_compute_forecast_calibration`,
    so both report the same coverage_target and methodology string. The
    headline coverage values can legitimately differ because /forecast is
    role-scoped to the caller's allowed units while the model card always
    reports against the full fleet (the model's own report card)."""
    _login(client)
    fc = client.get("/api/pulse/model-card", params={"refresh": True}).json()[
        "forecast_calibration"
    ]
    fr = client.get("/api/pulse/forecast", params={"window": 14}).json()
    assert fc["coverage_target"] == fr["coverage_target"] == 0.80
    # methodology string lives only on the model card payload, but both
    # numbers must stem from a backtest with the documented parameters.
    assert "30-day fit window" in fc["methodology"]
    assert "1-day-ahead" in fc["methodology"]
    assert fc["coverage_n"] >= 60 and fr["coverage_n"] >= 60


def test_model_card_holdout_mae_block_shape(client):
    """The holdout-MAE block is the published accuracy claim; its shape
    must be stable so the slide / visual can cite it without the front-
    end going cargo-cult on optional fields."""
    _login(client)
    body = client.get("/api/pulse/model-card").json()

    holdout = body["holdout_mae"]
    # Top-level keys
    assert {
        "model",
        "baseline",
        "baseline_diff_pct",
        "frozen_holdout",
        "metric_definition",
        "reproducibility_script",
    } <= set(holdout.keys())

    # Reproducibility script must be a real path in the repo (the slide
    # speaker notes point judges at it directly).
    assert holdout["reproducibility_script"] == "scripts/pulse_baseline_eval.py"

    for side_key in ("model", "baseline"):
        side = holdout[side_key]
        for k in ("mae", "ci_lower_95", "ci_upper_95", "n", "n_bootstrap", "seed", "method"):
            assert k in side, f"{side_key} missing {k}"
        assert 0.0 <= side["mae"] <= 1.0
        assert side["ci_lower_95"] <= side["mae"] <= side["ci_upper_95"]
        assert side["n_bootstrap"] >= 100
        assert side["seed"] == 42

    fh = holdout["frozen_holdout"]
    assert {
        "window_start",
        "window_end",
        "asset_pool_n",
        "asset_pool_description",
        "evaluation_horizon_days",
        "label_definition",
    } <= set(fh.keys())
    assert fh["window_start"] <= fh["window_end"]
    assert fh["asset_pool_n"] > 0
    assert fh["evaluation_horizon_days"] == 30


def test_model_card_holdout_mae_baseline_is_named_sop_heuristic(client):
    """The published baseline must be the FY24 G-4 SOP heuristic — the
    rule the Marine Corps would actually recognise — not a straw-man.
    This is the integrity assertion behind the slide claim."""
    _login(client)
    body = client.get("/api/pulse/model-card").json()

    baseline = body["holdout_mae"]["baseline"]
    assert baseline["key"] == "sop"
    assert baseline["name"] == "FY24 G-4 SOP heuristic"
    assert "NMC" in baseline["rule"]


def test_model_card_holdout_mae_is_deterministic(client):
    """The bootstrap CI is seeded; two refresh calls must return the
    bit-identical numbers. Otherwise the slide-cited value drifts every
    process restart and the 'reproducible' claim is hollow."""
    _login(client)
    a = client.get("/api/pulse/model-card?refresh=true").json()["holdout_mae"]
    b = client.get("/api/pulse/model-card?refresh=true").json()["holdout_mae"]
    for side in ("model", "baseline"):
        assert a[side]["mae"] == b[side]["mae"]
        assert a[side]["ci_lower_95"] == b[side]["ci_lower_95"]
        assert a[side]["ci_upper_95"] == b[side]["ci_upper_95"]
    assert a["baseline_diff_pct"] == b["baseline_diff_pct"]


def test_model_card_holdout_window_matches_test_split(client):
    """The 'frozen holdout' must be the same trailing 15% of dates that
    the binary metrics block is computed against. If they diverge the
    model card publishes two different definitions of 'holdout' which
    is exactly the kind of thing the deck pivot was supposed to fix."""
    _login(client)
    body = client.get("/api/pulse/model-card").json()
    split = body["split"]
    fh = body["holdout_mae"]["frozen_holdout"]
    assert fh["window_start"] == split["test_start"]
    assert fh["window_end"] == split["test_end"]


def test_baseline_eval_script_matches_live_endpoint(client):
    """`scripts/pulse_baseline_eval.py` is what we point judges at if
    they want to recompute the slide number themselves. It must produce
    the same MAE the live model-card endpoint reports — otherwise the
    slide and the script disagree, which is worse than no cite at all."""
    from backend.routes.pulse import _build_eval_pairs, _holdout_mae
    from backend.state import get_dataset
    from datetime import timedelta

    _login(client)
    body = client.get("/api/pulse/model-card?refresh=true").json()
    holdout = body["holdout_mae"]

    ds = get_dataset()
    first_day = ds.snapshots[0].snapshot_date
    last_day = ds.snapshots[-1].snapshot_date
    total_days = (last_day - first_day).days + 1
    val_end = first_day + timedelta(days=int(total_days * 0.85))
    pairs = _build_eval_pairs(ds, val_end)
    model_mae = _holdout_mae(pairs, "model_prob")
    sop_mae = _holdout_mae(pairs, "sop_prob")

    assert model_mae["mae"] == holdout["model"]["mae"]
    assert sop_mae["mae"] == holdout["baseline"]["mae"]
