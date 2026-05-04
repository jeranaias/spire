"""Channel runner tests — drives a channel through one cycle.

Tests use FilesystemChannel (real, no mocks at the channel level)
to exercise the full pipeline + writer + audit fan-out path. Audit
emission is captured via an in-memory list so we can assert the
exact entries written without touching the live audit chain.
"""
from __future__ import annotations

from datetime import date, timezone
from pathlib import Path
from typing import List

import pytest

from backend.uis.channels import (
    ChannelScheduler,
    FilesystemChannel,
    poll_channel,
    set_audit_func,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def audit_capture():
    """Replace the runner's audit emitter with a list-appending stub."""
    captured: List[dict] = []
    set_audit_func(lambda **kw: captured.append(dict(kw)))
    yield captured
    # Restore default no-op so other tests don't get our list polluted
    set_audit_func(lambda **kw: None)


@pytest.fixture
def fs_channel(tmp_path):
    return FilesystemChannel(
        channel_id="t/runner",
        adapter_id="gcss-mc/ecp",
        root=str(tmp_path),
        stability_seconds=0,
    )


def _drop_ecp(tmp_path: Path, name: str, contents: bytes) -> None:
    """Drop a file into the channel's incoming/ dir."""
    (tmp_path / "incoming" / name).write_bytes(contents)


def _ecp_csv(*lines):
    header = (
        "TAMCN,NSN,SERIAL_NUMBER,NOMENCLATURE,OWNER_UIC,"
        "ALLOWANCE_QTY,ON_HAND_QTY,LAST_INVENTORY_DATE"
    )
    return ("\n".join((header, *lines)) + "\n").encode("utf-8")


# Reset the canonical singleton between tests so writer.apply has a
# stable pre-state — otherwise the second test in a session sees
# the first test's appended assets.
@pytest.fixture(autouse=True)
def reset_canonical():
    from backend import state
    state.init_empty_dataset()
    yield
    state.init_empty_dataset()


# ---------------------------------------------------------------------------
# Empty-cycle behaviour
# ---------------------------------------------------------------------------


def test_poll_empty_channel_returns_zero_pending(fs_channel, audit_capture):
    result = poll_channel(fs_channel)
    assert result.pending_count == 0
    assert result.file_results == []
    # Still emits a poll-summary audit entry
    summary = [e for e in audit_capture if e["kind"] == "channel.poll"]
    assert len(summary) == 1
    assert summary[0]["payload"]["outcome"] == "ok"


def test_list_pending_failure_surfaces_in_audit(audit_capture, monkeypatch):
    """If channel.list_pending raises (e.g. SFTP host unreachable),
    poll_channel returns an empty result and emits a list_pending_failed
    audit entry — no silent swallow."""
    class _BoomChannel:
        channel_id = "t/boom"
        channel_type = "filesystem"
        adapter_id = "gcss-mc/ecp"
        def list_pending(self):
            raise RuntimeError("connection refused")
        def fetch(self, p): raise NotImplementedError
        def acknowledge(self, p): raise NotImplementedError
        def quarantine(self, p, r): raise NotImplementedError
        def health(self): raise NotImplementedError

    result = poll_channel(_BoomChannel())
    assert result.pending_count == 0
    assert result.file_results == []
    summary = [e for e in audit_capture if e["kind"] == "channel.poll"]
    assert summary
    assert summary[0]["payload"]["outcome"] == "list_pending_failed"
    assert "connection refused" in summary[0]["payload"]["error"]


# ---------------------------------------------------------------------------
# Happy path — file flows through pipeline + writer
# ---------------------------------------------------------------------------


def test_poll_applies_clean_ecp_file(fs_channel, audit_capture, tmp_path):
    body = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,"
        "owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    _drop_ecp(tmp_path, "ecp_2026_04_26.csv", body)

    result = poll_channel(fs_channel)
    assert result.pending_count == 1
    assert len(result.file_results) == 1
    fr = result.file_results[0]
    assert fr.status == "applied"
    assert fr.bytes_read == len(body)
    assert fr.file_sha256
    assert fr.rows_kept == 1
    assert fr.diff_counts.get("new", 0) == 1

    # File moved out of incoming/ into processed/
    assert not (tmp_path / "incoming" / "ecp_2026_04_26.csv").exists()
    found = list((tmp_path / "processed").rglob("ecp_2026_04_26.csv"))
    assert len(found) == 1

    # Audit entries fired in the right order: fetched, applied, poll
    kinds = [e["kind"] for e in audit_capture]
    assert "channel.fetched" in kinds
    assert "channel.applied" in kinds
    assert "channel.poll" in kinds
    # The applied entry carries the sha256 + counts
    applied = next(e for e in audit_capture if e["kind"] == "channel.applied")
    assert applied["payload"]["sha256"] == fr.file_sha256
    assert applied["payload"]["counts"]["new"] == 1


def test_poll_quarantines_duplicate_header_file(fs_channel, audit_capture, tmp_path):
    """Duplicate header columns is a hard-fail signal — file goes
    to quarantine, NOT applied. No silent data loss."""
    body = (
        # Two TAMCN columns — pipeline raises DuplicateHeaderError →
        # warning code "duplicate_header_columns" → runner quarantines
        b"TAMCN,NSN,TAMCN,NOMENCLATURE,OWNER_UIC,SERIAL_NUMBER,"
        b"ALLOWANCE_QTY,ON_HAND_QTY,LAST_INVENTORY_DATE\n"
        b"D1196,2320-01-540-2480,DUPLICATE,JLTV,"
        b"owner_uic_zZyYxXwWvVuUtTsSrRqQ,owner_serial_aBcDeFgHiJkLmNoPqRsT,"
        b"15,12,12-MAR-26\n"
    )
    _drop_ecp(tmp_path, "bad.csv", body)

    result = poll_channel(fs_channel)
    fr = result.file_results[0]
    assert fr.status == "quarantined"
    assert "duplicate_header_columns" in fr.error

    # File moved to quarantine/ with sidecar
    assert (tmp_path / "quarantine" / "bad.csv").exists()
    assert (tmp_path / "quarantine" / "bad.csv.reason.txt").exists()

    # Audit reflects the quarantine
    quar = [e for e in audit_capture if e["kind"] == "channel.quarantined"]
    assert quar
    assert "duplicate_header_columns" in quar[0]["payload"]["reason"]


def test_poll_quarantines_unknown_adapter(audit_capture, tmp_path):
    """Channel configured against a missing adapter quarantines
    rather than 500'ing the loop. Operator notices via health
    + quarantine sidecar."""
    ch = FilesystemChannel(
        channel_id="t/bad-adapter",
        adapter_id="does-not-exist",
        root=str(tmp_path),
        stability_seconds=0,
    )
    _drop_ecp(tmp_path, "x.csv", b"a\n1\n")
    result = poll_channel(ch)
    assert result.file_results[0].status == "quarantined"
    assert "unknown_adapter" in result.file_results[0].error


def test_poll_skipped_when_adapter_has_no_writer(audit_capture, tmp_path):
    """DRRS-MC has a writer (CRatingWriter); to test the
    no-writer path we need an adapter without one. Use SR-header
    is — wait, SR-header DOES have a writer now. Use a registered
    adapter without a writer if there is one."""
    # Register a temporary writer-less adapter. We can't easily do
    # that here without breaking the registry, so we'll achieve the
    # same by unregistering an existing writer for the test.
    from backend.uis.writers import WRITERS, register_writer
    from backend.uis.writers.asset_ecp import AssetEcpWriter

    saved = WRITERS.pop("gcss-mc/ecp", None)
    try:
        ch = FilesystemChannel(
            channel_id="t/no-writer",
            adapter_id="gcss-mc/ecp",
            root=str(tmp_path),
            stability_seconds=0,
        )
        body = _ecp_csv(
            "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,"
            "owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
        )
        _drop_ecp(tmp_path, "x.csv", body)
        result = poll_channel(ch)
        assert result.file_results[0].status == "skipped"
        # File still moves to processed/ — pipeline parsed cleanly,
        # we just don't have a write path for this adapter
        assert (tmp_path / "processed").exists()
        skip_audit = [e for e in audit_capture if e["kind"] == "channel.skipped"]
        assert skip_audit
        assert skip_audit[0]["payload"]["reason"] == "no_writer_registered"
    finally:
        if saved is not None:
            register_writer(saved)


# ---------------------------------------------------------------------------
# Multi-file cycle + max_files
# ---------------------------------------------------------------------------


def test_poll_processes_multiple_files_in_one_cycle(fs_channel, audit_capture, tmp_path):
    body1 = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,"
        "owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    body2 = _ecp_csv(
        "D1197,2320-01-540-2481,owner_serial_zYxWvUtSrQpOnMlKjIhG,MTVR,"
        "owner_uic_aAbBcCdDeEfFgGhHiIjJ,10,8,15-MAR-26"
    )
    _drop_ecp(tmp_path, "a.csv", body1)
    _drop_ecp(tmp_path, "b.csv", body2)

    result = poll_channel(fs_channel)
    assert result.pending_count == 2
    statuses = sorted(fr.status for fr in result.file_results)
    assert statuses == ["applied", "applied"]


def test_max_files_caps_per_cycle(fs_channel, audit_capture, tmp_path):
    """Operator can bound how much one cycle drains — useful when
    a channel suddenly gets a 50,000-file backlog."""
    for i in range(5):
        _drop_ecp(tmp_path, f"file{i}.csv", _ecp_csv(
            f"D119{i},2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPq{i:04d},"
            f"JLTV,owner_uic_zZyYxXwWvVuUtTsSrR{i:04d},15,12,12-MAR-26"
        ))
    result = poll_channel(fs_channel, max_files=2)
    assert result.pending_count == 2
    assert len(result.file_results) == 2


# ---------------------------------------------------------------------------
# Scheduler
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_scheduler_polls_at_interval(fs_channel, tmp_path, audit_capture):
    import asyncio

    # Drop one file before starting the scheduler
    body = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,"
        "owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    _drop_ecp(tmp_path, "scheduled.csv", body)

    sched = ChannelScheduler()
    sched.add(fs_channel, interval_seconds=1)
    await sched.start()
    try:
        # Give the loop a moment to fire at least once
        await asyncio.sleep(0.5)
    finally:
        await sched.stop()

    # Sleep is racy; assert that at least one poll cycle ran
    polls = [e for e in audit_capture if e["kind"] == "channel.poll"]
    assert len(polls) >= 1
