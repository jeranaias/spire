"""IMAPChannel tests with a stubbed imaplib.

Same testing strategy as SFTP: mock the underlying client (imaplib
here) and assert the protocol surface. Real IMAP server smoke tests
live outside the unit suite.

Test fixtures build small RFC-2822 messages with attachments using
Python's stdlib email module so the body bytes the channel parses
are real, not hand-crafted.
"""
from __future__ import annotations

import os
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Dict, List

import pytest

from backend.uis.channels import IMAPChannel, IngestChannel


# ---------------------------------------------------------------------------
# Stub IMAP server
# ---------------------------------------------------------------------------


def _build_message(
    *,
    sender: str,
    subject: str,
    body: str,
    attachment_name: str,
    attachment_bytes: bytes,
    date: str = "Mon, 26 Apr 2026 14:23:00 +0000",
) -> bytes:
    msg = MIMEMultipart()
    msg["From"] = sender
    msg["To"] = "spire-intake@usmc.mil"
    msg["Subject"] = subject
    msg["Date"] = date
    msg.attach(MIMEText(body, "plain"))
    if attachment_name:
        part = MIMEApplication(attachment_bytes, Name=attachment_name)
        part["Content-Disposition"] = f'attachment; filename="{attachment_name}"'
        msg.attach(part)
    return msg.as_bytes()


class _StubIMAP:
    """In-memory IMAP4(_SSL) stand-in. Messages are stored by UID
    in self.inbox; flags + folders are simulated as dicts.

    Test setup: pre-populate `inbox` with {uid: raw_bytes}; the
    channel's IMAP operations (search/fetch/store/move/expunge)
    are translated into dict mutations the test can assert on.
    """

    def __init__(self, *args, **kwargs):
        self.inbox: Dict[bytes, bytes] = {}
        self.flags: Dict[bytes, set] = {}
        self.folders: Dict[bytes, str] = {}  # uid -> folder ("processed" / "quarantine")
        self.selected_folder: str = ""
        self.logged_in = False
        self.logged_out = False

    # imaplib API surface
    def login(self, user, pwd):
        self.logged_in = True
        self.last_credentials = (user, pwd)
        return ("OK", [b"LOGIN successful"])

    def select(self, folder):
        self.selected_folder = folder
        return ("OK", [str(len(self.inbox)).encode()])

    def uid(self, command, *args):
        cmd = command.upper()
        if cmd == "SEARCH":
            criterion = (args[1] if len(args) > 1 else args[0]).upper() if args else "ALL"
            uids: List[bytes] = []
            for uid, _ in self.inbox.items():
                if uid in self.folders:
                    continue  # moved out of inbox
                if criterion == "UNSEEN":
                    if "\\Seen" in self.flags.get(uid, set()):
                        continue
                uids.append(uid)
            return ("OK", [b" ".join(uids)])

        if cmd == "FETCH":
            uid = args[0].encode() if isinstance(args[0], str) else args[0]
            raw = self.inbox.get(uid)
            if raw is None:
                return ("OK", [None])
            # imaplib returns [(b'1 (RFC822 {len}', raw_bytes), b')']
            return ("OK", [(f"1 (RFC822 {{{len(raw)}}}".encode(), raw), b")"])

        if cmd == "STORE":
            uid = args[0].encode() if isinstance(args[0], str) else args[0]
            op, flags = args[1], args[2]
            self.flags.setdefault(uid, set())
            for f in flags.strip("()").split():
                if op == "+FLAGS":
                    self.flags[uid].add(f)
                elif op == "-FLAGS":
                    self.flags[uid].discard(f)
            return ("OK", [b""])

        if cmd == "MOVE":
            uid = args[0].encode() if isinstance(args[0], str) else args[0]
            target = args[1]
            self.folders[uid] = target
            return ("OK", [b""])

        if cmd == "COPY":
            uid = args[0].encode() if isinstance(args[0], str) else args[0]
            target = args[1]
            self.folders[uid] = target
            return ("OK", [b""])

        return ("OK", [b""])

    def expunge(self):
        return ("OK", [b""])

    def logout(self):
        self.logged_out = True
        return ("BYE", [b""])


class _ImapTestHarness:
    """Shared server-side state across all stub instances + a list
    of every client instance for assertion access."""
    def __init__(self):
        self.inbox: Dict[bytes, bytes] = {}
        self.flags: Dict[bytes, set] = {}
        self.folders: Dict[bytes, str] = {}
        self.instances: List[_StubIMAP] = []


@pytest.fixture
def stub_imap(monkeypatch):
    """Replace imaplib.IMAP4_SSL with a stub. Real IMAP servers are
    server-side state holders — each new client connection reads
    the same inbox — so the harness shares inbox/flags/folders
    dicts across all stub instances.

    Tests mutate harness.inbox between channel operations and
    assert across harness.instances or harness.{folders,flags}.
    """
    import imaplib
    harness = _ImapTestHarness()

    def factory(host, port):
        s = _StubIMAP()
        s.host = host
        s.port = port
        s.inbox = harness.inbox
        s.flags = harness.flags
        s.folders = harness.folders
        harness.instances.append(s)
        return s

    monkeypatch.setattr(imaplib, "IMAP4_SSL", factory)
    monkeypatch.setenv("TEST_IMAP_PWD", "supersecret")
    return harness


# ---------------------------------------------------------------------------
# Construction + protocol
# ---------------------------------------------------------------------------


def test_imap_satisfies_protocol():
    ch = IMAPChannel(
        channel_id="t/imap",
        adapter_id="gcss-mc/sr-header",
        host="imap.usmc.mil",
        username="spire-intake",
        password_env="TEST_IMAP_PWD",
    )
    assert isinstance(ch, IngestChannel)
    assert ch.channel_type == "imap"


def test_imap_to_config_excludes_secret_value(monkeypatch):
    monkeypatch.setenv("MY_PWD", "actual-secret-value")
    ch = IMAPChannel(
        channel_id="t/cfg",
        adapter_id="gcss-mc/sr-header",
        host="imap.example",
        username="u",
        password_env="MY_PWD",
        sender_allowlist=["@usmc.mil"],
    )
    cfg = ch.to_config_dict()
    assert cfg["config"]["password_env"] == "MY_PWD"
    assert "actual-secret-value" not in str(cfg)
    assert cfg["config"]["sender_allowlist"] == ["@usmc.mil"]


def test_password_env_unset_raises(stub_imap, monkeypatch):
    monkeypatch.delenv("MISSING_PWD", raising=False)
    ch = IMAPChannel(
        channel_id="t/no-pwd",
        adapter_id="gcss-mc/sr-header",
        host="imap.example",
        username="u",
        password_env="MISSING_PWD",
    )
    with pytest.raises(Exception, match="MISSING_PWD"):
        list(ch.list_pending())


# ---------------------------------------------------------------------------
# list_pending
# ---------------------------------------------------------------------------


def test_list_pending_returns_attachments_from_unseen_messages(stub_imap):
    ch = IMAPChannel(
        channel_id="t/list",
        adapter_id="gcss-mc/sr-header",
        host="imap.example",
        username="u",
        password_env="TEST_IMAP_PWD",
    )
    # Pre-populate the stub with one message
    list(ch.list_pending())  # forces stub instantiation
    server = stub_imap
    server.inbox[b"100"] = _build_message(
        sender="ssgt.smith@usmc.mil",
        subject="Daily SR rollup",
        body="Attached.",
        attachment_name="srs_2026_04_26.csv",
        attachment_bytes=b"SR_NUMBER,STATUS\nSR-1,OPEN\n",
    )

    pending = list(ch.list_pending())
    assert len(pending) == 1
    p = pending[0]
    assert p.filename == "srs_2026_04_26.csv"
    assert p.size_bytes is not None and p.size_bytes > 0


def test_list_pending_skips_seen_messages(stub_imap):
    ch = IMAPChannel(
        channel_id="t/seen",
        adapter_id="gcss-mc/sr-header",
        host="imap.example",
        username="u",
        password_env="TEST_IMAP_PWD",
    )
    list(ch.list_pending())
    server = stub_imap
    server.inbox[b"42"] = _build_message(
        sender="x@usmc.mil",
        subject="x",
        body="x",
        attachment_name="x.csv",
        attachment_bytes=b"a\n",
    )
    server.flags[b"42"] = {"\\Seen"}

    pending = list(ch.list_pending())
    assert pending == []


def test_list_pending_filters_by_attachment_glob(stub_imap):
    ch = IMAPChannel(
        channel_id="t/glob",
        adapter_id="gcss-mc/sr-header",
        host="imap.example",
        username="u",
        password_env="TEST_IMAP_PWD",
        attachment_glob="*.csv",
    )
    list(ch.list_pending())
    server = stub_imap
    server.inbox[b"1"] = _build_message(
        sender="x@usmc.mil", subject="x", body="x",
        attachment_name="report.csv",
        attachment_bytes=b"a\n",
    )
    server.inbox[b"2"] = _build_message(
        sender="x@usmc.mil", subject="x", body="x",
        attachment_name="readme.pdf",
        attachment_bytes=b"%PDF\n",
    )

    pending = list(ch.list_pending())
    names = sorted(p.filename for p in pending)
    assert names == ["report.csv"]


def test_sender_allowlist_blocks_outsiders(stub_imap):
    ch = IMAPChannel(
        channel_id="t/allow",
        adapter_id="gcss-mc/sr-header",
        host="imap.example",
        username="u",
        password_env="TEST_IMAP_PWD",
        sender_allowlist=["@usmc.mil"],
    )
    list(ch.list_pending())
    server = stub_imap
    server.inbox[b"1"] = _build_message(
        sender="ssgt@usmc.mil", subject="x", body="x",
        attachment_name="ok.csv", attachment_bytes=b"a\n",
    )
    server.inbox[b"2"] = _build_message(
        sender="random@example.com", subject="x", body="x",
        attachment_name="spoofed.csv", attachment_bytes=b"b\n",
    )

    pending = list(ch.list_pending())
    names = [p.filename for p in pending]
    assert names == ["ok.csv"]


def test_sender_allowlist_exact_match(stub_imap):
    """Specific addresses (not just domains) work too."""
    ch = IMAPChannel(
        channel_id="t/exact",
        adapter_id="gcss-mc/sr-header",
        host="imap.example",
        username="u",
        password_env="TEST_IMAP_PWD",
        sender_allowlist=["s4-bn1@usmc.mil"],
    )
    list(ch.list_pending())
    server = stub_imap
    server.inbox[b"1"] = _build_message(
        sender="s4-bn1@usmc.mil", subject="x", body="x",
        attachment_name="ok.csv", attachment_bytes=b"a\n",
    )
    server.inbox[b"2"] = _build_message(
        sender="other@usmc.mil", subject="x", body="x",
        attachment_name="block.csv", attachment_bytes=b"b\n",
    )
    pending = list(ch.list_pending())
    assert [p.filename for p in pending] == ["ok.csv"]


# ---------------------------------------------------------------------------
# fetch
# ---------------------------------------------------------------------------


def test_fetch_returns_attachment_bytes(stub_imap):
    ch = IMAPChannel(
        channel_id="t/fetch",
        adapter_id="gcss-mc/sr-header",
        host="imap.example",
        username="u",
        password_env="TEST_IMAP_PWD",
    )
    list(ch.list_pending())
    server = stub_imap
    payload = b"SR_NUMBER,STATUS\nSR-99,CLOSED\n"
    server.inbox[b"50"] = _build_message(
        sender="x@usmc.mil", subject="x", body="x",
        attachment_name="report.csv",
        attachment_bytes=payload,
    )
    pending = list(ch.list_pending())[0]
    body = ch.fetch(pending)
    assert body == payload


# ---------------------------------------------------------------------------
# acknowledge / quarantine
# ---------------------------------------------------------------------------


def test_acknowledge_marks_seen(stub_imap):
    ch = IMAPChannel(
        channel_id="t/ack",
        adapter_id="gcss-mc/sr-header",
        host="imap.example",
        username="u",
        password_env="TEST_IMAP_PWD",
    )
    list(ch.list_pending())
    server = stub_imap
    server.inbox[b"7"] = _build_message(
        sender="x@usmc.mil", subject="x", body="x",
        attachment_name="x.csv", attachment_bytes=b"a\n",
    )
    pending = list(ch.list_pending())[0]
    ch.acknowledge(pending)
    # The latest stub instance (ack opens a fresh client) holds the
    # \\Seen flag; check the most recent stub's flags
    assert "\\Seen" in stub_imap.flags.get(b"7", set())


def test_acknowledge_moves_to_processed_folder_when_configured(stub_imap):
    ch = IMAPChannel(
        channel_id="t/ack-move",
        adapter_id="gcss-mc/sr-header",
        host="imap.example",
        username="u",
        password_env="TEST_IMAP_PWD",
        processed_folder="SPIRE/Processed",
    )
    list(ch.list_pending())
    server = stub_imap
    server.inbox[b"9"] = _build_message(
        sender="x@usmc.mil", subject="x", body="x",
        attachment_name="x.csv", attachment_bytes=b"a\n",
    )
    pending = list(ch.list_pending())[0]
    ch.acknowledge(pending)
    assert stub_imap.folders.get(b"9") == "SPIRE/Processed"


def test_quarantine_marks_seen_and_records_failure(stub_imap):
    ch = IMAPChannel(
        channel_id="t/quar",
        adapter_id="gcss-mc/sr-header",
        host="imap.example",
        username="u",
        password_env="TEST_IMAP_PWD",
        quarantine_folder="SPIRE/Quarantine",
    )
    list(ch.list_pending())
    server = stub_imap
    server.inbox[b"3"] = _build_message(
        sender="x@usmc.mil", subject="x", body="x",
        attachment_name="bad.csv", attachment_bytes=b"x\n",
    )
    pending = list(ch.list_pending())[0]
    ch.quarantine(pending, "duplicate_header_columns")
    # Marked seen
    assert "\\Seen" in stub_imap.flags.get(b"3", set())
    assert stub_imap.folders.get(b"3") == "SPIRE/Quarantine"
    # Failure recorded
    assert ch._consecutive_failures == 1
    assert "duplicate_header_columns" in (ch._last_error or "")
