"""Event-build profile boot validation (WI-3).

SPIRE_PROFILE=event is the assessed-event stance. Every check below maps to a
claim the event build makes about itself; a missing one must stop the boot
rather than silently downgrade to the demo posture.
"""
from __future__ import annotations

import pytest

from backend import security_posture


# A fully-configured enforcing environment. Individual tests remove one key
# at a time to prove each check is load-bearing.
COMPLETE_ENV = {
    "SPIRE_PROFILE": "event",
    "SPIRE_EGRESS_ENFORCE": "1",
    "SPIRE_AUTH_MODE": "cac",
    "SPIRE_SESSION_SECRET": "0" * 64,
    "SPIRE_AUDIT_SIGNING_KEY_PATH": "/opt/spire/runtime/audit-signing.key",
    "SPIRE_LLM_PRIMARY_DISABLE": "1",
}

# Every var the profile inspects, so a stray value in the developer's shell
# cannot make a negative test pass for the wrong reason.
_INSPECTED = (
    "SPIRE_PROFILE",
    "SPIRE_EGRESS_ENFORCE",
    "SPIRE_AUTH_MODE",
    "SPIRE_SESSION_SECRET",
    "SPIRE_AUDIT_SIGNING_KEY_PATH",
    "SPIRE_AUDIT_SIGNING_KEY_HEX",
    "SPIRE_GITHUB_TOKEN",
    "SPIRE_LLM_PRIMARY_DISABLE",
    "SPIRE_CORS_ORIGINS",
)


@pytest.fixture
def env(monkeypatch):
    def _apply(overrides=None, drop=()):
        for var in _INSPECTED:
            monkeypatch.delenv(var, raising=False)
        values = dict(COMPLETE_ENV)
        values.update(overrides or {})
        for var in drop:
            values.pop(var, None)
        for k, v in values.items():
            monkeypatch.setenv(k, v)
    return _apply


def test_no_profile_is_a_no_op(env, monkeypatch):
    env(drop=("SPIRE_PROFILE",))
    monkeypatch.delenv("SPIRE_PROFILE", raising=False)
    assert security_posture.event_profile() is False
    security_posture.assert_event_profile()  # must not raise


def test_complete_event_profile_boots(env):
    env()
    assert security_posture.event_profile() is True
    security_posture.assert_event_profile()


@pytest.mark.parametrize(
    "overrides,drop,expected",
    [
        ({"SPIRE_EGRESS_ENFORCE": "0"}, (), "SPIRE_EGRESS_ENFORCE"),
        ({"SPIRE_AUTH_MODE": "mock"}, (), "SPIRE_AUTH_MODE=mock"),
        ({}, ("SPIRE_SESSION_SECRET",), "SPIRE_SESSION_SECRET"),
        ({}, ("SPIRE_AUDIT_SIGNING_KEY_PATH",), "audit signing key"),
        ({"SPIRE_GITHUB_TOKEN": "ghp_example"}, (), "SPIRE_GITHUB_TOKEN"),
        ({"SPIRE_LLM_PRIMARY_DISABLE": "0"}, (), "SPIRE_LLM_PRIMARY_DISABLE"),
        ({"SPIRE_CORS_ORIGINS": "https://a.example,*"}, (), "wildcard"),
    ],
)
def test_each_requirement_is_load_bearing(env, overrides, drop, expected):
    env(overrides=overrides, drop=drop)
    with pytest.raises(security_posture.EventProfileViolation) as exc:
        security_posture.assert_event_profile()
    assert expected in str(exc.value)


def test_violation_names_every_gap_not_just_the_first(env):
    env(overrides={"SPIRE_AUTH_MODE": "mock", "SPIRE_EGRESS_ENFORCE": "0"})
    with pytest.raises(security_posture.EventProfileViolation) as exc:
        security_posture.assert_event_profile()
    msg = str(exc.value)
    assert "SPIRE_AUTH_MODE=mock" in msg and "SPIRE_EGRESS_ENFORCE" in msg


def test_audit_key_hex_satisfies_the_signing_requirement(env):
    env(drop=("SPIRE_AUDIT_SIGNING_KEY_PATH",))
    import os
    os.environ["SPIRE_AUDIT_SIGNING_KEY_HEX"] = "ab" * 32
    try:
        security_posture.assert_event_profile()
    finally:
        os.environ.pop("SPIRE_AUDIT_SIGNING_KEY_HEX", None)


def test_posture_reports_the_profile(env):
    env()
    assert security_posture.posture_status().to_dict()["profile"] == "event"
