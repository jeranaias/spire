"""De-identification uses a keyed HMAC, not a brute-forceable bare hash (P2-7)."""
from __future__ import annotations

import hashlib

from backend import deid
from backend.uis.transforms.hashing import classify_hashed_field


def test_stable_for_the_same_input():
    a, _ = classify_hashed_field("EDIPI", "1234567890")
    b, _ = classify_hashed_field("EDIPI", "1234567890")
    assert a == b  # join stability preserved


def test_not_a_bare_sha256(monkeypatch):
    # A bare SHA-256 of a 10-digit EDIPI is what an attacker would brute-force;
    # the keyed digest must NOT equal it.
    monkeypatch.setattr(deid, "_key_cache", b"unit-test-key-abc")
    keyed, _ = classify_hashed_field("EDIPI", "1234567890")
    bare = "EDIPI_" + hashlib.sha256(b"1234567890").hexdigest()[:20]
    assert keyed != bare


def test_key_changes_the_digest(monkeypatch):
    monkeypatch.setattr(deid, "_key_cache", b"key-one")
    one, _ = classify_hashed_field("EDIPI", "1234567890")
    monkeypatch.setattr(deid, "_key_cache", b"key-two")
    two, _ = classify_hashed_field("EDIPI", "1234567890")
    assert one != two  # different install key => different pseudonym
