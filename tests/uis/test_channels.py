"""IngestChannel protocol + FilesystemChannel tests.

Channels are the pull-mode counterpart to /api/uis/upload. They
poll a source, hand bytes to the existing pipeline + writer
protocol. These tests cover the protocol contract and the
filesystem channel's directory-based state machine.
"""
from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from backend.uis.channels import (
    CHANNELS,
    ChannelHealth,
    FilesystemChannel,
    IngestChannel,
    PendingFile,
    get_channel,
    has_channel,
    register_channel,
    unregister_channel,
)


@pytest.fixture
def fs_channel(tmp_path):
    """A FilesystemChannel rooted at a fresh tmp dir."""
    ch = FilesystemChannel(
        channel_id="test/fs",
        adapter_id="gcss-mc/ecp",
        root=str(tmp_path),
        stability_seconds=0,  # tests don't want to wait
    )
    yield ch
    unregister_channel(ch.channel_id)


# ---------------------------------------------------------------------------
# Registry + protocol
# ---------------------------------------------------------------------------


def test_filesystem_channel_satisfies_protocol(fs_channel):
    assert isinstance(fs_channel, IngestChannel)


def test_register_and_get_channel(fs_channel):
    register_channel(fs_channel)
    assert has_channel("test/fs")
    assert get_channel("test/fs") is fs_channel


def test_register_rejects_empty_channel_id(tmp_path):
    bad = FilesystemChannel(
        channel_id="", adapter_id="gcss-mc/ecp", root=str(tmp_path),
    )
    with pytest.raises(ValueError):
        register_channel(bad)


def test_register_rejects_empty_adapter_id(tmp_path):
    bad = FilesystemChannel(
        channel_id="test/x", adapter_id="", root=str(tmp_path),
    )
    with pytest.raises(ValueError):
        register_channel(bad)


def test_get_channel_unknown_raises_with_known_list(fs_channel):
    register_channel(fs_channel)
    with pytest.raises(KeyError) as exc:
        get_channel("does-not-exist")
    assert "test/fs" in str(exc.value)


# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------


def test_construction_creates_layout(fs_channel, tmp_path):
    """incoming/, processed/, quarantine/ must exist after init."""
    assert (tmp_path / "incoming").is_dir()
    assert (tmp_path / "processed").is_dir()
    assert (tmp_path / "quarantine").is_dir()


# ---------------------------------------------------------------------------
# list_pending
# ---------------------------------------------------------------------------


def test_list_pending_empty_when_no_files(fs_channel):
    assert list(fs_channel.list_pending()) == []


def test_list_pending_returns_files_in_incoming(fs_channel, tmp_path):
    (tmp_path / "incoming" / "ecp.csv").write_bytes(b"TAMCN,NSN\nD1196,2320\n")
    (tmp_path / "incoming" / "another.csv").write_bytes(b"x\n")
    pending = list(fs_channel.list_pending())
    names = sorted(p.filename for p in pending)
    assert names == ["another.csv", "ecp.csv"]
    # Each carries handle + size_bytes
    for p in pending:
        assert p.handle.endswith(p.filename)
        assert p.size_bytes is not None


def test_list_pending_filters_by_glob(tmp_path):
    ch = FilesystemChannel(
        channel_id="t/glob",
        adapter_id="gcss-mc/ecp",
        root=str(tmp_path),
        glob="*.csv",
        stability_seconds=0,
    )
    (tmp_path / "incoming" / "good.csv").write_bytes(b"a\n")
    (tmp_path / "incoming" / "skip.txt").write_bytes(b"b\n")
    pending = list(ch.list_pending())
    names = [p.filename for p in pending]
    assert names == ["good.csv"]


def test_list_pending_skips_directories(fs_channel, tmp_path):
    (tmp_path / "incoming" / "a_subdir").mkdir()
    pending = list(fs_channel.list_pending())
    assert pending == []


def test_stability_filter_skips_recently_written(tmp_path):
    """Files written within stability_seconds are skipped — guards
    against picking up a half-written upload."""
    ch = FilesystemChannel(
        channel_id="t/stab",
        adapter_id="gcss-mc/ecp",
        root=str(tmp_path),
        stability_seconds=60,
    )
    p = tmp_path / "incoming" / "fresh.csv"
    p.write_bytes(b"a\n")
    # mtime is "now" → within 60-second cutoff → skipped
    pending = list(ch.list_pending())
    assert pending == []


def test_stability_filter_accepts_old_files(tmp_path):
    ch = FilesystemChannel(
        channel_id="t/stab2",
        adapter_id="gcss-mc/ecp",
        root=str(tmp_path),
        stability_seconds=1,
    )
    p = tmp_path / "incoming" / "old.csv"
    p.write_bytes(b"a\n")
    # Backdate mtime so it's outside the stability window
    older = time.time() - 10
    os.utime(p, (older, older))
    pending = list(ch.list_pending())
    assert [x.filename for x in pending] == ["old.csv"]


# ---------------------------------------------------------------------------
# fetch / acknowledge / quarantine
# ---------------------------------------------------------------------------


def test_fetch_returns_file_bytes(fs_channel, tmp_path):
    (tmp_path / "incoming" / "x.csv").write_bytes(b"hello\n")
    pending = list(fs_channel.list_pending())[0]
    assert fs_channel.fetch(pending) == b"hello\n"


def test_acknowledge_moves_file_into_processed_dated_dir(fs_channel, tmp_path):
    (tmp_path / "incoming" / "x.csv").write_bytes(b"a\n")
    pending = list(fs_channel.list_pending())[0]
    fs_channel.acknowledge(pending)

    # Source gone
    assert not (tmp_path / "incoming" / "x.csv").exists()
    # Lands under processed/<YYYY-MM-DD>/x.csv
    found = list((tmp_path / "processed").rglob("x.csv"))
    assert len(found) == 1


def test_acknowledge_handles_filename_collision(fs_channel, tmp_path):
    """Same-name file processed twice on the same day → numeric suffix."""
    (tmp_path / "incoming" / "x.csv").write_bytes(b"first\n")
    p1 = list(fs_channel.list_pending())[0]
    fs_channel.acknowledge(p1)

    (tmp_path / "incoming" / "x.csv").write_bytes(b"second\n")
    # Bypass stability cutoff for the second file
    older = time.time() - 100
    os.utime(tmp_path / "incoming" / "x.csv", (older, older))
    p2 = list(fs_channel.list_pending())[0]
    fs_channel.acknowledge(p2)

    found = sorted((tmp_path / "processed").rglob("x*"))
    assert len(found) == 2
    # Second one got a numeric suffix
    suffixed = [f for f in found if "-2" in f.name]
    assert len(suffixed) == 1


def test_acknowledge_idempotent_when_source_already_gone(fs_channel, tmp_path):
    """Calling ack twice on the same handle (e.g., partial-success
    retry) does not raise."""
    (tmp_path / "incoming" / "x.csv").write_bytes(b"a\n")
    pending = list(fs_channel.list_pending())[0]
    fs_channel.acknowledge(pending)
    # Second call — file already moved
    fs_channel.acknowledge(pending)  # must not raise


def test_quarantine_moves_file_with_reason_sidecar(fs_channel, tmp_path):
    (tmp_path / "incoming" / "bad.csv").write_bytes(b"corrupted\n")
    pending = list(fs_channel.list_pending())[0]
    fs_channel.quarantine(pending, "duplicate_header_columns: TAMCN appears twice")

    # Source gone
    assert not (tmp_path / "incoming" / "bad.csv").exists()
    # Lands in quarantine/ with a sidecar
    q = tmp_path / "quarantine"
    files = sorted(q.iterdir())
    names = [f.name for f in files]
    assert "bad.csv" in names
    assert "bad.csv.reason.txt" in names
    sidecar = (q / "bad.csv.reason.txt").read_text(encoding="utf-8")
    assert "duplicate_header_columns" in sidecar
    assert fs_channel.channel_id in sidecar


def test_quarantine_increments_failure_counter(fs_channel, tmp_path):
    (tmp_path / "incoming" / "bad.csv").write_bytes(b"x\n")
    pending = list(fs_channel.list_pending())[0]
    assert fs_channel.health().consecutive_failures == 0
    fs_channel.quarantine(pending, "test failure")
    assert fs_channel.health().consecutive_failures == 1
    assert "test failure" in (fs_channel.health().last_error or "")


def test_acknowledge_resets_failure_counter(fs_channel, tmp_path):
    """A successful ack after a quarantine clears the failure tally —
    that's what the circuit breaker reads to decide reachability."""
    (tmp_path / "incoming" / "bad.csv").write_bytes(b"x\n")
    pending = list(fs_channel.list_pending())[0]
    fs_channel.quarantine(pending, "test failure")
    assert fs_channel.health().consecutive_failures == 1

    (tmp_path / "incoming" / "good.csv").write_bytes(b"y\n")
    older = time.time() - 100
    os.utime(tmp_path / "incoming" / "good.csv", (older, older))
    pending2 = list(fs_channel.list_pending())[0]
    fs_channel.acknowledge(pending2)
    assert fs_channel.health().consecutive_failures == 0


# ---------------------------------------------------------------------------
# health()
# ---------------------------------------------------------------------------


def test_health_reflects_directory_state(fs_channel, tmp_path):
    h = fs_channel.health()
    assert isinstance(h, ChannelHealth)
    assert h.channel_id == "test/fs"
    assert h.channel_type == "filesystem"
    assert h.reachable is True
    assert h.pending_count == 0


def test_health_counts_pending_files(fs_channel, tmp_path):
    (tmp_path / "incoming" / "a.csv").write_bytes(b"x\n")
    (tmp_path / "incoming" / "b.csv").write_bytes(b"y\n")
    h = fs_channel.health()
    assert h.pending_count == 2


def test_health_unreachable_when_root_missing(tmp_path):
    """If the root path is wiped (mount lost), reachable=False so
    the operator sees the disconnect in the channel admin tab."""
    bad_root = tmp_path / "vanished"
    ch = FilesystemChannel(
        channel_id="t/missing",
        adapter_id="gcss-mc/ecp",
        root=str(bad_root),
        stability_seconds=0,
    )
    # __post_init__ created the layout; remove it
    import shutil as _sh
    _sh.rmtree(str(bad_root))
    h = ch.health()
    assert h.reachable is False


def test_to_config_dict_round_trips(fs_channel):
    """to_config_dict produces JSON-serializable shape for persistence."""
    cfg = fs_channel.to_config_dict()
    assert cfg["channel_id"] == "test/fs"
    assert cfg["channel_type"] == "filesystem"
    assert cfg["adapter_id"] == "gcss-mc/ecp"
    assert "root" in cfg["config"]
    assert "glob" in cfg["config"]
    import json
    assert json.dumps(cfg)  # raises if not serializable
