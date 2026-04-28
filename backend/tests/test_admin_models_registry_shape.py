"""
Task #139 — regression test for the model-registry response shape.

Task #82 reshaped `/api/system/admin/models` so the supply-chain header
honestly buckets FedRAMP coverage three ways instead of one (covered /
not_applicable / pending), and surfaces an `authorization` block plus a
`vendor_jurisdictions` array on every per-model summary. None of those
fields had an automated regression test, so a future edit to
`_supply_chain_at_a_glance` or `_model_summary` could quietly:

  * recombine the FedRAMP buckets (re-introducing the projector-bait
    "all five lack FedRAMP" framing),
  * drop the `authorization` block (and let an IL-5 hosting target read
    as an IL-5 ATO again),
  * drop `vendor_jurisdictions` (flipping `at_risk_jurisdictions` back
    to empty, which would silently zero the auditor-facing UK callout
    while Gemma is the active copilot model).

This test pins the shape so any of those regressions fails CI.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app


# CWO3 James Park — security_manager — is the only role allowed into
# `/api/system/admin/models` (see backend/tests/test_role_gates.py).
SECURITY_MANAGER_DODID = "3456789012"


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(c: TestClient, dodid: str = SECURITY_MANAGER_DODID) -> None:
    r = c.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _get_admin_models(c: TestClient) -> dict:
    _login(c)
    r = c.get("/api/system/admin/models")
    assert r.status_code == 200, r.text
    return r.json()


def test_supply_chain_fedramp_buckets_sum_to_total_active_models(client):
    """The three FedRAMP buckets must exist on the header and sum to the
    total active-model count. Catches a regression that recombines the
    buckets or that miscounts the registry length."""
    body = _get_admin_models(client)
    summary = body["supply_chain_at_a_glance"]

    for key in (
        "models_fedramp_covered",
        "models_fedramp_not_applicable",
        "models_fedramp_pending",
        "total_models",
    ):
        assert key in summary, f"missing supply-chain field: {key}"
        assert isinstance(summary[key], int), f"{key} must be int, got {summary[key]!r}"

    bucket_total = (
        summary["models_fedramp_covered"]
        + summary["models_fedramp_not_applicable"]
        + summary["models_fedramp_pending"]
    )
    assert bucket_total == summary["total_models"], (
        f"FedRAMP buckets must partition the active-model set: "
        f"covered={summary['models_fedramp_covered']} + "
        f"not_applicable={summary['models_fedramp_not_applicable']} + "
        f"pending={summary['models_fedramp_pending']} "
        f"= {bucket_total}, but total_models={summary['total_models']}"
    )

    # `total_models` must equal the actual number of summary rows
    # returned (i.e. the registry length the page renders).
    assert summary["total_models"] == len(body["models"]), (
        "total_models drifted from the rendered model rows"
    )


def test_supply_chain_at_risk_jurisdictions_includes_uk_while_gemma_is_active(client):
    """While the active copilot model is Gemma (Google DeepMind, UK),
    `at_risk_jurisdictions` must surface 'United Kingdom'. This is the
    auditor-facing callout that Task #82 added — losing it would mean
    the page reads as a pure-US LLM stack again."""
    body = _get_admin_models(client)

    copilot = next(
        (m for m in body["models"] if m["id"] == "copilot-llm"),
        None,
    )
    assert copilot is not None, "copilot-llm model row missing from /admin/models"

    # Precondition for the at-risk assertion: Gemma is still the active
    # copilot impl. If a future task swaps the copilot to a US-only
    # model, this guard fails loudly so the test (and the auditor
    # narrative behind it) is reconsidered, not silently passed.
    assert copilot["active_implementation"] == "gemma4_26b_fp8_local", (
        f"Test premise broken: copilot active_implementation is "
        f"{copilot['active_implementation']!r}, expected "
        f"'gemma4_26b_fp8_local'. Update Task #139's regression test "
        f"if the copilot model has intentionally changed."
    )
    assert "United Kingdom" in (copilot["vendor_jurisdictions"] or []), (
        "copilot-llm vendor_jurisdictions must include 'United Kingdom' "
        "(Google DeepMind is UK-based); got "
        f"{copilot['vendor_jurisdictions']!r}"
    )

    summary = body["supply_chain_at_a_glance"]
    at_risk = summary.get("at_risk_jurisdictions") or []
    assert "United Kingdom" in at_risk, (
        f"supply_chain_at_a_glance.at_risk_jurisdictions must include "
        f"'United Kingdom' while Gemma is the active copilot model; "
        f"got {at_risk!r}"
    )
    assert summary.get("at_risk_jurisdictions_count") == len(at_risk), (
        "at_risk_jurisdictions_count must equal len(at_risk_jurisdictions)"
    )


def test_every_active_model_summary_has_authorization_and_vendor_jurisdictions(client):
    """Every summary row must carry an `authorization` dict with
    ao/package_id/expiration keys (Task #82 separated hosting target
    from authorization), and a non-empty `vendor_jurisdictions` list
    (so the row honestly states where the vendor sits)."""
    body = _get_admin_models(client)
    rows = body["models"]
    assert rows, "no model summaries returned — registry failed to load?"

    for row in rows:
        model_id = row.get("id")

        auth = row.get("authorization")
        assert isinstance(auth, dict), (
            f"{model_id}: authorization must be a dict; got {auth!r}"
        )
        for key in ("ao", "package_id", "expiration"):
            assert key in auth, (
                f"{model_id}: authorization missing required key {key!r}; "
                f"got keys {sorted(auth.keys())!r}"
            )

        jurs = row.get("vendor_jurisdictions")
        assert isinstance(jurs, list) and jurs, (
            f"{model_id}: vendor_jurisdictions must be a non-empty list; "
            f"got {jurs!r}"
        )
        for j in jurs:
            assert isinstance(j, str) and j.strip(), (
                f"{model_id}: vendor_jurisdictions entries must be "
                f"non-empty strings; got {j!r}"
            )
