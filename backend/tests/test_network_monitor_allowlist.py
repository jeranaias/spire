"""
Task #197 — the SOC dashboard's network-egress counter (footer
``unapproved_attempts``) should only tick up for actually surprising
outbound traffic, not for our own legitimate test/reference calls.

The backing watchdog is ``backend.network_monitor``. Its allow-list
must recognise:

  * the GCSS-MC mock reference adapter host (no live partner link)
  * IETF-reserved DNS suffixes used by the integration suite
    (``.test``, ``.invalid``, ``.example``, ``.local``, ``example.com``,
    etc. — RFC 2606 / RFC 6761) — these names are guaranteed never
    to resolve to a real internet host, so a lookup against them is by
    definition not unauthorised egress.

This test pokes ``_is_allowed`` directly and also drives the public
``_audit_outbound`` path so the recent-attempts buffer + the
``unapproved_count`` it feeds the footer are exercised end-to-end.
"""
from __future__ import annotations

import pytest

from backend import network_monitor as nm


@pytest.fixture(autouse=True)
def _clean_audit_buffer():
    # Every test gets a clean tally so assertions on
    # ``unapproved_count`` are independent of test ordering.
    with nm._LOCK:
        nm._AUDITED.clear()
    yield
    with nm._LOCK:
        nm._AUDITED.clear()


@pytest.mark.parametrize(
    "host",
    [
        # Loopback / self — the existing baseline we must not regress.
        "127.0.0.1",
        "localhost",
        # GCSS-MC mock reference adapter.
        "gcss-mc.mock",
        "gcss-mc.mock.spire.local",
        "gcss-mc.reference.local",
        "table.gcss-mc.mock",
        # Reserved test / docs / local suffixes — integration suite uses
        # these whenever it needs a fully-qualified name that is
        # guaranteed never to be a real partner system.
        "anything.test",
        "anything.invalid",
        "anything.example",
        "example.com",
        "example.org",
        "example.net",
        "host.example.com",
        "node.local",
        "svc.internal",
        "box.localdomain",
    ],
)
def test_known_reference_traffic_is_allowed(host: str) -> None:
    assert nm._is_allowed(host, 443), f"{host} should be on the allow-list"


@pytest.mark.parametrize(
    "host",
    [
        # Genuinely surprising egress — these MUST still register so the
        # footer remains honest when something unexpected actually leaves
        # the box.
        "data.partner-not-on-allowlist.com",
        "evil.example-but-not-reserved.io",
    ],
)
def test_unexpected_egress_still_flagged(host: str) -> None:
    assert not nm._is_allowed(host, 443), (
        f"{host} should NOT be on the allow-list — the footer must stay "
        "honest about real surprise egress"
    )


def test_audit_buffer_does_not_count_reference_traffic() -> None:
    """End-to-end: pumping legitimate reference traffic through the
    watchdog must not bump the ``unapproved_attempts`` counter that the
    footer reads."""
    nm._audit_outbound("gcss-mc.mock", 443, nm._is_allowed("gcss-mc.mock", 443))
    nm._audit_outbound("integration.test", 80, nm._is_allowed("integration.test", 80))
    nm._audit_outbound("host.example.com", 443, nm._is_allowed("host.example.com", 443))
    assert nm.unapproved_count() == 0


def test_audit_buffer_still_counts_real_surprises() -> None:
    """Negative control — unknown destinations still show up in the
    counter so the SOC story stays truthful."""
    host = "data.partner-not-on-allowlist.com"
    nm._audit_outbound(host, 443, nm._is_allowed(host, 443))
    assert nm.unapproved_count() == 1
