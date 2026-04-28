"""
Task-173 — lock in the SENTRY ``/mark`` doctrinal contract that Task-61
established so a future refactor of ``tier1_classify`` or the caveat /
distribution tables can't silently regress it.

Three rules are pinned by the tests below:

1. **REL TO is a single authoritative caveat, never a stack.** A NATO
   release on the Convoy sample text must surface exactly one
   ``REL TO ...`` entry in ``caveats_recommended`` (the prior bug emitted
   ``REL TO FVEY`` from a comms flag *and* ``REL TO NATO`` from the
   release authority — a doctrinally wrong double-stamp).

2. **Distribution Statement letter is content-derived (A-F per
   DoDI 5230.24), not hardcoded to "C".** The three Mark-Tab sample
   chips must produce three distinct letters (B / C / D) so the panel
   stops claiming the same statement on every input.

3. **A self-introduced NOFORN that triggers a release block must be
   explained with the evidence span**, so the operator can see *why*
   the engine added the caveat that's now blocking their release —
   not just a generic "SECRET//NOFORN cannot be released to FVEY".

Plus: a clean UNCLASSIFIED text returns Distribution **A** (not B), so
the engine can't drift back to "everything is at least B".
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app


# Sample texts mirror the three chips on ``frontend/src/views/sentry/MarkTab.tsx``.
# Keep them in sync — these tests assert the doctrinal letter each one
# produces, which is the user-visible promise of the Mark Tab.
MOTOR_POOL_TEXT = (
    "Veh exhibited trans fluid leak from output shaft area during ops. "
    "Approx 1 qt on ground after overnight. Traced to output seal failure "
    "IAW TM 9-2320-391-20. Replaced seal and gasket set. "
    "POC: Cpl Davis R. / ext 4827"
)
RADAR_CLASSIFIED_TM_TEXT = (
    "Phased array calibration exceeding [REDACTED] threshold during BIT. "
    "6 T/R modules showing degraded output. DL'd for depot-level "
    "calibration per [CLASSIFIED TM XX-XXXX-XXX-XX-X]. "
    "POC: SSgt Martinez J. / EDIPI 9910042851"
)
CONVOY_TEXT = (
    "Convoy SP at 18S UJ 23648 60819 heading NE. 4 x MTVR + 1 x JLTV. "
    "Reported on TAD Net 30.050 MHz to BN COC. Route clearance confirmed, "
    "no further action."
)
CLEAN_UNCLASS_TEXT = "Routine maintenance complete. All systems nominal."


# ``/sentry/mark`` is gated to data_custodian / security_manager. The
# CWO3 Park identity is the security_manager seeded in backend.auth.
SECURITY_MANAGER_DODID = "3456789012"


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str = SECURITY_MANAGER_DODID) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _mark(client: TestClient, text: str, release: str = "US_ONLY") -> dict:
    r = client.post(
        "/api/sentry/mark",
        json={"text": text, "release_authority": release},
    )
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------------------
# Rule 1 — REL TO is a single authoritative caveat, not a stack.
# ---------------------------------------------------------------------------

def test_convoy_with_nato_release_emits_exactly_one_rel_to(client):
    """Convoy text has comms + geo flags; under NATO release the engine
    must surface ``REL TO NATO`` once — not stack it with a
    content-derived ``REL TO FVEY``."""
    _login(client)
    body = _mark(client, CONVOY_TEXT, release="NATO")

    assert body["rel_to_caveat"] == "REL TO NATO"

    rel_to_entries = [c for c in body["caveats_recommended"] if c.startswith("REL TO")]
    assert rel_to_entries == ["REL TO NATO"], (
        "exactly one REL TO caveat expected; got "
        f"{rel_to_entries!r} (full caveats: {body['caveats_recommended']!r})"
    )


# ---------------------------------------------------------------------------
# Rule 2 — Distribution letter is derived from content (A-F), not pinned.
# ---------------------------------------------------------------------------

def test_three_mark_samples_produce_three_distinct_distribution_letters(client):
    """The three Mark-Tab sample chips were pinned at "Distribution C"
    before Task-61. They must now span three different DoDI 5230.24
    letters: B (PII-only / CUI), C (operational geo+comms / CUI), and
    D (classified TM / SECRET)."""
    _login(client)

    motor_pool = _mark(client, MOTOR_POOL_TEXT)
    convoy = _mark(client, CONVOY_TEXT)
    radar = _mark(client, RADAR_CLASSIFIED_TM_TEXT)

    motor_letter = motor_pool["distribution_statement"]["letter"]
    convoy_letter = convoy["distribution_statement"]["letter"]
    radar_letter = radar["distribution_statement"]["letter"]

    # Pin each letter explicitly so a regression to "all C" or any other
    # single-letter collapse fails loudly.
    assert motor_letter == "B", motor_pool["distribution_statement"]
    assert convoy_letter == "C", convoy["distribution_statement"]
    assert radar_letter == "D", radar["distribution_statement"]

    # And belt-and-braces: three distinct letters.
    assert len({motor_letter, convoy_letter, radar_letter}) == 3

    # Label / description must agree with the letter so the panel can't
    # render "Distribution C" under a "B" letter heading.
    for body, letter in (
        (motor_pool, "B"),
        (convoy, "C"),
        (radar, "D"),
    ):
        ds = body["distribution_statement"]
        assert ds["label"] == f"Distribution {letter}"
        assert ds["description"], "distribution description must not be empty"


def test_clean_unclassified_text_returns_distribution_a(client):
    """A flag-free UNCLASSIFIED remark must come back as Distribution A
    ("approved for public release"). The pre-Task-61 engine pinned every
    response at C; the post-Task-61 engine must never silently upgrade a
    truly clean record above A."""
    _login(client)
    body = _mark(client, CLEAN_UNCLASS_TEXT)

    assert body["recommended_classification"] == "UNCLASSIFIED"
    assert body["flags"] == []
    ds = body["distribution_statement"]
    assert ds["letter"] == "A", ds
    assert ds["label"] == "Distribution A"
    assert "public release" in ds["description"].lower()


# ---------------------------------------------------------------------------
# Rule 3 — Self-introduced NOFORN must explain itself when it blocks.
# ---------------------------------------------------------------------------

def test_classified_tm_to_fvey_blocks_with_named_evidence(client):
    """When the engine itself adds NOFORN from a [CLASSIFIED TM ...]
    match and that NOFORN then blocks an FVEY release, the issue text
    must name *both* the engine action ("We added NOFORN") and the
    evidence span the operator can redact — not the generic shared
    validator message."""
    _login(client)
    body = _mark(client, RADAR_CLASSIFIED_TM_TEXT, release="FVEY")

    compat = body["release_compatibility"]
    assert compat["status"] == "block", body

    # An explanatory issue must be present and must mention both the
    # engine self-introduction phrase and the literal evidence span.
    explanatory = [
        i for i in compat["issues"]
        if "We added NOFORN" in i and "[CLASSIFIED TM XX-XXXX-XXX-XX-X]" in i
    ]
    assert explanatory, (
        "expected an issue naming both 'We added NOFORN' and the "
        f"evidence span; got: {compat['issues']!r}"
    )

    # The auto_caveats panel must also expose NOFORN with the same
    # evidence so the FE can render the explanation pane consistently.
    nofor = [c for c in body["auto_caveats"] if c["caveat"] == "NOFORN"]
    assert nofor, body["auto_caveats"]
    assert nofor[0]["evidence"] == "[CLASSIFIED TM XX-XXXX-XXX-XX-X]"
    assert nofor[0]["rule"] == "cls_tm"
