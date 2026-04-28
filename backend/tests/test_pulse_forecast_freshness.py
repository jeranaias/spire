"""
Task-73 — focused integration test for /pulse/forecast freshness +
calibration metadata.

Asserts the forecast endpoint:
  * returns a UTC `as_of` ISO timestamp (matching the pattern used by
    /predict-failures and /recommend-actions) so the UI can stamp the
    chart pane with a generated time + STALE chip.
  * declares the rolling fit window (`data_window_days`).
  * surfaces a `coverage_p10_p90` calibration metric — fraction of last
    90 1-day-ahead predictions whose realized rate fell inside the
    predicted p10/p90 band — alongside `coverage_n` and a target of
    0.80, so the answer to "calibrate this band against historicals" is
    on screen and not silence.
  * exposes the canonical `model_card_url` so the operator-visible
    "model card →" link in the legend points at the canonical detail
    page.

Also asserts the projection band is no longer artificially compressed
by the prior 0.6× damping factor — at the 14-day horizon the p10/p90
spread should reach a non-trivial width (≥3pts on the synthetic
deterministic dataset), confirming the realistic-volatility fix.

Endpoint is deterministic under RANDOM_SEED=42, so number drift is a
real regression.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from backend.main import app


_ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str = "1234567890") -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def test_forecast_returns_freshness_metadata(client):
    _login(client)
    r = client.get("/api/pulse/forecast", params={"window": 14})
    assert r.status_code == 200, r.text
    data = r.json()

    # as_of: UTC ISO timestamp ending in Z, parseable, and within a
    # generous window of "now" (test runs are local; avoid flake by
    # only asserting the timestamp is sane and not in the far future).
    assert "as_of" in data
    assert _ISO_Z.match(data["as_of"]), f"unexpected as_of format: {data['as_of']}"
    parsed = datetime.strptime(data["as_of"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    assert abs((now - parsed).total_seconds()) < 60, (
        "as_of should be wall-clock generation time (UTC), not a stale or future stamp"
    )

    # Rolling fit window declared so the UI can render
    # "data window: 30d" without hard-coding the number.
    assert data.get("data_window_days") == 30


def test_forecast_returns_calibration_block(client):
    _login(client)
    r = client.get("/api/pulse/forecast", params={"window": 14})
    assert r.status_code == 200, r.text
    data = r.json()

    # Calibration: 1-day-ahead p10/p90 coverage on the trailing 90 days
    # of history. With the deterministic synthetic dataset and the
    # corrected sigma path (cap raised, damping removed) we should land
    # somewhere in the broad "informative" range. We deliberately
    # tolerate a wide window — the point is "metric is computed and
    # plausible", not "regression-pin a specific value".
    assert "coverage_p10_p90" in data
    cov = data["coverage_p10_p90"]
    assert cov is not None, "coverage should be computed on the canonical dataset"
    assert 0.0 <= cov <= 1.0
    assert data.get("coverage_n", 0) >= 60, (
        "trailing-90 backtest should evaluate on most of the window"
    )
    assert data.get("coverage_target") == 0.80


def test_forecast_links_to_model_card(client):
    _login(client)
    r = client.get("/api/pulse/forecast", params={"window": 14})
    assert r.status_code == 200, r.text
    data = r.json()
    # "model card →" link in the legend points at the canonical
    # detail page (lane C3). Front-end consumes this rather than
    # hard-coding the route so the canonical URL stays single-source.
    assert data.get("model_card_url", "").endswith("/admin/models/pulse-risk")


def test_forecast_publishes_kpi_color_bands(client):
    """Task #113 — the KPI color cutoffs used by the front-end card
    (`< amber_min` = red, `< green_min` = amber, else green) must be
    published by the backend so the doctrine lives next to the rest of
    the forecast thresholds and is documented in one place. Asserts
    the bands are present, sane, and carry an operator-facing label
    the UI can drop into a tooltip."""
    _login(client)
    r = client.get("/api/pulse/forecast", params={"window": 14})
    assert r.status_code == 200, r.text
    data = r.json()

    bands = data.get("kpi_bands")
    assert isinstance(bands, dict), "kpi_bands must be on the forecast payload"

    green_min = bands.get("green_min")
    amber_min = bands.get("amber_min")
    label = bands.get("label")

    assert isinstance(green_min, (int, float)), "kpi_bands.green_min must be numeric"
    assert isinstance(amber_min, (int, float)), "kpi_bands.amber_min must be numeric"
    assert 0.0 < amber_min < green_min < 1.0, (
        f"kpi_bands ordering invalid (amber_min={amber_min}, green_min={green_min})"
    )
    # Green band is tied to the calibration target — operators should
    # not see "green" at a confidence below what the band is calibrated
    # for. The backend derives one from the other so they cannot drift.
    assert green_min == data.get("coverage_target"), (
        "kpi_bands.green_min must equal coverage_target so 'green' "
        "lines up with the calibration bar (drift guard)"
    )
    assert isinstance(label, str) and label.strip(), (
        "kpi_bands.label is what the UI tooltip shows; must be a non-empty string"
    )


def test_forecast_band_is_not_artificially_compressed(client):
    """Sigma cap raised to 0.10 and 0.6× damping dropped — at a
    14-day horizon the p10/p90 spread on the synthetic dataset should
    open up beyond the prior ±4pt artifact. Asserts the spread reaches
    at least 3 percentage points by horizon end."""
    _login(client)
    r = client.get("/api/pulse/forecast", params={"window": 14})
    assert r.status_code == 200, r.text
    data = r.json()
    proj = data.get("projection") or []
    assert len(proj) >= 14
    last = proj[-1]
    spread = last["p90"] - last["p10"]
    assert spread >= 0.03, (
        f"p10/p90 band collapsed at horizon end (spread={spread:.3f}); "
        f"sigma cap or damping factor regressed?"
    )
