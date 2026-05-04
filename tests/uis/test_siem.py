"""SIEM CEF formatter + forwarder tests (UIS-P6.7)."""
from __future__ import annotations

from typing import List

import pytest

from backend.uis.siem import (
    SiemConfig,
    SiemForwarder,
    _cef_severity,
    _escape_cef_extension,
    _escape_cef_header,
    format_cef,
)


# ---------------------------------------------------------------------------
# CEF formatting — pure
# ---------------------------------------------------------------------------


def test_format_cef_minimum_fields():
    line = format_cef({
        "id": 42,
        "ts": "2026-04-26T12:00:00Z",
        "actor": "ssgt.smith",
        "kind": "ingest.ecp.apply.commit",
        "subject_id": "tok123",
        "self_hash": "deadbeef" * 8,
        "signature": None,
        "payload": {"counts": {"new": 5}},
    })
    # Header is 7 pipe-separated fields
    parts = line.split("|", 7)
    assert parts[0] == "CEF:0"
    assert parts[1] == "SPIRE"
    assert parts[2] == "UIS"
    assert parts[3] == "0.1.0"
    assert parts[4] == "ingest.ecp.apply.commit"
    assert parts[5] == "ingest.ecp.apply.commit"
    # Severity 5 for .commit / .apply
    assert parts[6] == "5"
    # Extensions string contains the expected fields
    extensions = parts[7]
    assert "rt=2026-04-26T12:00:00Z" in extensions
    assert "suser=ssgt.smith" in extensions
    assert "act=tok123" in extensions
    assert "cs1=" in extensions
    assert "cs1Label=audit_self_hash" in extensions


def test_cef_escape_extension_value():
    """Equals + backslash + newline in payload values must escape."""
    out = _escape_cef_extension("a=b\\c\nd")
    assert "\\=" in out
    assert "\\\\" in out
    assert "\\n" in out


def test_cef_escape_header_pipe():
    out = _escape_cef_header("kind|with|pipes")
    assert "|" not in out.replace("\\|", "")  # all pipes escaped


def test_cef_severity_quarantined_is_high():
    assert _cef_severity("channel.quarantined") == 7
    assert _cef_severity("ingest.ecp.apply.failed") == 7


def test_cef_severity_circuit_open_is_high():
    assert _cef_severity("uis.channels.circuit.reset") == 7  # circuit keyword


def test_cef_severity_commit_is_medium():
    assert _cef_severity("ingest.ecp.apply.commit") == 5


def test_cef_severity_default_is_low():
    assert _cef_severity("system.login.success") == 3


def test_format_cef_handles_missing_signature():
    line = format_cef({
        "id": 1,
        "ts": "2026-01-01T00:00:00Z",
        "actor": "u",
        "kind": "x",
        "subject_id": "",
        "self_hash": "a" * 64,
        "signature": None,
        "payload": {},
    })
    assert "cs2=" not in line  # only added when signature present


def test_format_cef_truncates_payload():
    big_payload = {"data": "x" * 5000}
    line = format_cef({
        "id": 1,
        "ts": "2026-01-01T00:00:00Z",
        "actor": "u",
        "kind": "x",
        "subject_id": "",
        "self_hash": "a" * 64,
        "signature": None,
        "payload": big_payload,
    })
    # msg= field should be ≤ 1024 chars
    msg_part = next(p for p in line.split(" ") if p.startswith("msg="))
    assert len(msg_part) < 1100  # 1024 + escape overhead


# ---------------------------------------------------------------------------
# Forwarder — poll loop
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_audit_entries():
    return [
        {"id": 1, "ts": "2026-01-01T00:00:00Z", "actor": "u",
         "kind": "ingest.ecp.apply.commit", "subject_id": "t1",
         "self_hash": "a" * 64, "signature": None,
         "payload": {"counts": {"new": 1}}},
        {"id": 2, "ts": "2026-01-01T00:00:01Z", "actor": "u",
         "kind": "channel.quarantined", "subject_id": "ch/x",
         "self_hash": "b" * 64, "signature": None,
         "payload": {"reason": "duplicate_header"}},
        {"id": 3, "ts": "2026-01-01T00:00:02Z", "actor": "u",
         "kind": "login.success", "subject_id": "",
         "self_hash": "c" * 64, "signature": None,
         "payload": {"dodid": "1234"}},
    ]


def test_forwarder_sends_all_entries_when_no_filter(fake_audit_entries, tmp_path):
    captured: List[str] = []
    cfg = SiemConfig(
        enabled=True, host="localhost", port=9514,
        checkpoint_path=str(tmp_path / "ckpt.txt"),
    )
    fwd = SiemForwarder(
        config=cfg,
        fetch_entries=lambda after, limit: [r for r in fake_audit_entries if r["id"] > after],
        send=lambda c, line: captured.append(line),
    )
    sent = fwd.poll_once()
    assert sent == 3
    assert len(captured) == 3
    # Checkpoint advanced to highest id seen
    with open(cfg.checkpoint_path) as f:
        assert int(f.read()) == 3


def test_forwarder_skips_entries_outside_kind_prefix_filter(fake_audit_entries, tmp_path):
    captured: List[str] = []
    cfg = SiemConfig(
        enabled=True, host="localhost", port=9514,
        checkpoint_path=str(tmp_path / "ckpt.txt"),
        kind_prefixes=["ingest.", "channel."],
    )
    fwd = SiemForwarder(
        config=cfg,
        fetch_entries=lambda after, limit: [r for r in fake_audit_entries if r["id"] > after],
        send=lambda c, line: captured.append(line),
    )
    fwd.poll_once()
    # login.success is not in the prefix list → not sent
    assert len(captured) == 2
    kinds_in_lines = [
        l.split("|")[4] for l in captured  # signatureId is the 5th field
    ]
    assert "login.success" not in kinds_in_lines


def test_forwarder_advances_checkpoint_on_subsequent_poll(fake_audit_entries, tmp_path):
    captured: List[str] = []
    cfg = SiemConfig(
        enabled=True, host="localhost", port=9514,
        checkpoint_path=str(tmp_path / "ckpt.txt"),
    )

    def fetch(after, limit):
        return [r for r in fake_audit_entries if r["id"] > after][:limit]

    fwd = SiemForwarder(
        config=cfg,
        fetch_entries=fetch,
        send=lambda c, line: captured.append(line),
    )
    # First poll sends all 3
    sent1 = fwd.poll_once()
    assert sent1 == 3
    # Second poll has nothing new
    sent2 = fwd.poll_once()
    assert sent2 == 0
    assert len(captured) == 3


def test_forwarder_tcp_failure_holds_checkpoint(fake_audit_entries, tmp_path):
    """TCP send failure leaves checkpoint at the last successful
    id so the next poll re-attempts the failed batch."""
    cfg = SiemConfig(
        enabled=True, host="localhost", port=9514, protocol="tcp",
        checkpoint_path=str(tmp_path / "ckpt.txt"),
    )
    sent_attempts: List[int] = []

    def boom_on_second(c, line):
        sent_attempts.append(line.count("CEF:0"))
        if len(sent_attempts) == 2:
            raise ConnectionError("siem unreachable")

    fwd = SiemForwarder(
        config=cfg,
        fetch_entries=lambda after, limit: [r for r in fake_audit_entries if r["id"] > after],
        send=boom_on_second,
    )
    fwd.poll_once()
    # Checkpoint advanced to id=1 (entry sent before the failure)
    with open(cfg.checkpoint_path) as f:
        assert int(f.read()) == 1


def test_forwarder_udp_failure_advances_checkpoint(fake_audit_entries, tmp_path):
    """UDP fire-and-forget — even if send raises we keep moving."""
    cfg = SiemConfig(
        enabled=True, host="localhost", port=9514, protocol="udp",
        checkpoint_path=str(tmp_path / "ckpt.txt"),
    )

    def always_fail(c, line):
        raise IOError("udp send failed")

    fwd = SiemForwarder(
        config=cfg,
        fetch_entries=lambda after, limit: [r for r in fake_audit_entries if r["id"] > after],
        send=always_fail,
    )
    fwd.poll_once()
    # All checkpoints advance; failures recorded but checkpoint moves
    with open(cfg.checkpoint_path) as f:
        assert int(f.read()) == 3
    assert fwd.stats()["errors"] == 3


def test_forwarder_disabled_config_is_noop(tmp_path):
    cfg = SiemConfig(enabled=False, host="", port=0)
    fwd = SiemForwarder(
        config=cfg,
        fetch_entries=lambda after, limit: [],
        send=lambda c, line: None,
    )
    fwd.start()  # no-op when disabled
    assert fwd._thread is None
    fwd.stop()
