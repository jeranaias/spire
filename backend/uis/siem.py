"""SIEM audit feed — CEF over UDP/TCP syslog (UIS-P6.7).

DoD-mandatory for any monitored deployment. Streams audit chain
entries to an external SIEM (Splunk Enterprise Security,
ArcSight ESM, IBM QRadar) in CEF (Common Event Format) so the
operator's existing detection/correlation rules apply.

CEF wire format
---------------
::

    CEF:0|SPIRE|UIS|0.1.0|<sigid>|<name>|<severity>|<extensions>

Where extensions are key=value pairs separated by spaces, with
characters escaped per the CEF spec (\\, =, |, \\n).

Forwarder
---------
A background poller checks the audit_log table every
``poll_interval_seconds`` for entries whose ``id > checkpoint``.
Each new entry serializes to CEF + sends to the configured
syslog destination. Checkpoint advances on successful send.

Failure semantics:
- UDP send is fire-and-forget. Drop on the floor if the SIEM is
  unreachable; checkpoint still advances. Acceptable for IL5
  internal networks where syslog loss is preferable to backlog.
- TCP send retries inside a single poll cycle but doesn't block
  forever — failed sends keep the checkpoint at the last
  successful entry; next cycle retries the failed batch.

Config (env vars)
-----------------
* SPIRE_SIEM_ENABLED      — "1" to turn on; default off
* SPIRE_SIEM_HOST         — syslog server hostname/IP
* SPIRE_SIEM_PORT         — port (default 514)
* SPIRE_SIEM_PROTOCOL     — "udp" (default) or "tcp"
* SPIRE_SIEM_POLL_SECONDS — polling cadence (default 5)
* SPIRE_SIEM_CHECKPOINT   — file holding last-sent id; default
                            ``$SPIRE_CHANNEL_STATE_ROOT/siem-checkpoint.txt``
* SPIRE_SIEM_KIND_PREFIXES — comma-separated; only forward
                              kinds matching one of these.
                              Default empty = forward all.
"""
from __future__ import annotations

import logging
import os
import socket
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# CEF formatter — pure, no I/O, fully testable
# ---------------------------------------------------------------------------


CEF_VERSION = "0"
DEVICE_VENDOR = "SPIRE"
DEVICE_PRODUCT = "UIS"
DEVICE_VERSION = "0.1.0"


def _escape_cef_extension(value: str) -> str:
    """Escape extension VALUES per CEF spec: backslash, equals,
    pipe, newline."""
    if value is None:
        return ""
    s = str(value)
    return (
        s.replace("\\", "\\\\")
         .replace("\n", "\\n")
         .replace("\r", "\\r")
         .replace("=", "\\=")
    )


def _escape_cef_header(value: str) -> str:
    """Header fields escape pipe + backslash (no equals — equals
    is only meaningful in extensions)."""
    if value is None:
        return ""
    s = str(value)
    return s.replace("\\", "\\\\").replace("|", "\\|")


def _cef_severity(kind: str) -> int:
    """Map audit kind → CEF severity 0-10. Conservative defaults:

      - failed / quarantined / circuit_open events: 7
      - apply commits / channel applies: 5 (operator-attention)
      - everything else: 3 (informational)
    """
    if any(kind.endswith(x) for x in (".failed", ".quarantined", ".breach")):
        return 7
    if "circuit" in kind or "tamper" in kind or "spillage" in kind:
        return 7
    if kind.endswith(".commit") or kind.endswith(".apply"):
        return 5
    return 3


def format_cef(entry: Dict[str, Any]) -> str:
    """Convert an audit-log row dict to a CEF-formatted string.

    ``entry`` shape (matches backend.persistence.recent_entries
    output):
        {
          "id": int,
          "ts": ISO timestamp,
          "actor": str,
          "kind": str,
          "subject_id": str,
          "payload": dict | str,
          "self_hash": str,
          "signature": str | None,
        }
    """
    kind = entry.get("kind", "")
    actor = entry.get("actor", "")
    subject_id = entry.get("subject_id", "")
    self_hash = entry.get("self_hash", "")
    sig = entry.get("signature", "") or ""

    # CEF header: 7 pipe-separated fields
    header = "|".join([
        f"CEF:{CEF_VERSION}",
        DEVICE_VENDOR,
        DEVICE_PRODUCT,
        DEVICE_VERSION,
        _escape_cef_header(kind),                  # signatureId
        _escape_cef_header(kind),                  # name (same as sigid)
        str(_cef_severity(kind)),
    ])

    # Extensions — common DoD/Splunk fields
    extensions = []
    if "id" in entry:
        extensions.append(f"externalId={_escape_cef_extension(entry.get('id'))}")
    if entry.get("ts"):
        extensions.append(f"rt={_escape_cef_extension(entry.get('ts'))}")
    if actor:
        extensions.append(f"suser={_escape_cef_extension(actor)}")
    if subject_id:
        extensions.append(f"act={_escape_cef_extension(subject_id)}")
    if self_hash:
        extensions.append(f"cs1={_escape_cef_extension(self_hash)}")
        extensions.append("cs1Label=audit_self_hash")
    if sig:
        extensions.append(f"cs2={_escape_cef_extension(sig[:128])}")
        extensions.append("cs2Label=audit_signature")
    payload = entry.get("payload")
    if payload:
        if isinstance(payload, dict):
            import json as _json
            payload_str = _json.dumps(payload, sort_keys=True, default=str)
        else:
            payload_str = str(payload)
        # msg is the payload truncated to a reasonable size — full
        # payload lives in the audit DB; SIEM gets a digest line.
        extensions.append(f"msg={_escape_cef_extension(payload_str[:1024])}")

    return f"{header}|{' '.join(extensions)}"


# ---------------------------------------------------------------------------
# Syslog emitter
# ---------------------------------------------------------------------------


@dataclass
class SiemConfig:
    enabled: bool = False
    host: str = ""
    port: int = 514
    protocol: str = "udp"             # "udp" | "tcp"
    poll_interval_seconds: int = 5
    checkpoint_path: str = ""
    kind_prefixes: List[str] = field(default_factory=list)


def _config_from_env() -> SiemConfig:
    enabled = (os.environ.get("SPIRE_SIEM_ENABLED") or "").strip() in {
        "1", "true", "yes", "on",
    }
    prefixes_raw = os.environ.get("SPIRE_SIEM_KIND_PREFIXES", "").strip()
    prefixes = [p.strip() for p in prefixes_raw.split(",") if p.strip()] if prefixes_raw else []

    checkpoint = os.environ.get("SPIRE_SIEM_CHECKPOINT", "").strip()
    if not checkpoint:
        # Default lands under the channel state root if set, else
        # cwd.
        from .channels.paths import state_root
        checkpoint = str(state_root() / "siem-checkpoint.txt")

    return SiemConfig(
        enabled=enabled,
        host=os.environ.get("SPIRE_SIEM_HOST", "").strip(),
        port=int(os.environ.get("SPIRE_SIEM_PORT", "514") or 514),
        protocol=(os.environ.get("SPIRE_SIEM_PROTOCOL", "udp") or "udp").strip().lower(),
        poll_interval_seconds=int(
            os.environ.get("SPIRE_SIEM_POLL_SECONDS", "5") or 5,
        ),
        checkpoint_path=checkpoint,
        kind_prefixes=prefixes,
    )


def _read_checkpoint(path: str) -> int:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return int(f.read().strip() or "0")
    except (FileNotFoundError, ValueError):
        return 0


def _write_checkpoint(path: str, value: int) -> None:
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(str(value))
    except OSError as e:
        log.warning("SIEM checkpoint write failed at %s: %s", path, e)


# Pluggable sender so tests can inject a mock without opening a
# real socket. Default uses stdlib socket; production can swap
# to a TLS-capable client when the SIEM front-end requires.
SyslogSender = Callable[[SiemConfig, str], None]


def _default_send(cfg: SiemConfig, line: str) -> None:
    """Send a single CEF line via UDP or TCP to the configured
    syslog server. Best-effort — a connection error logs but
    doesn't propagate (the caller advances the checkpoint anyway
    on UDP; TCP failure leaves checkpoint untouched)."""
    if not cfg.host:
        return
    payload = (line + "\n").encode("utf-8", errors="replace")
    if cfg.protocol == "tcp":
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(5.0)
            s.connect((cfg.host, cfg.port))
            s.sendall(payload)
    else:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.sendto(payload, (cfg.host, cfg.port))


@dataclass
class SiemForwarder:
    """Background-poll syslog forwarder. Wire into the FastAPI
    lifespan (start on startup, stop on shutdown) so audit
    entries flow to the SIEM in near-real-time."""

    config: SiemConfig
    fetch_entries: Callable[[int, int], List[Dict[str, Any]]]
    send: SyslogSender = field(default_factory=lambda: _default_send)
    _stop_event: threading.Event = field(default_factory=threading.Event, init=False, repr=False)
    _thread: Optional[threading.Thread] = field(default=None, init=False, repr=False)
    _stats: Dict[str, int] = field(default_factory=lambda: {"sent": 0, "errors": 0}, init=False, repr=False)

    def start(self) -> None:
        if not self.config.enabled:
            return
        if self._thread is not None:
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._loop, name="SiemForwarder", daemon=True,
        )
        self._thread.start()

    def stop(self, *, timeout: float = 5.0) -> None:
        self._stop_event.set()
        t = self._thread
        if t is not None:
            t.join(timeout=timeout)
        self._thread = None

    def stats(self) -> Dict[str, int]:
        return dict(self._stats)

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.poll_once()
            except Exception as e:  # noqa: BLE001
                log.warning("SiemForwarder loop error: %s", e)
                self._stats["errors"] += 1
            self._stop_event.wait(timeout=self.config.poll_interval_seconds)

    def poll_once(self) -> int:
        """Fetch any new audit entries past the checkpoint, send
        each one, advance checkpoint. Returns count sent.

        Tests call this directly; production driver is the
        `_loop` thread above."""
        ckpt = _read_checkpoint(self.config.checkpoint_path)
        rows = self.fetch_entries(ckpt, 1000)
        if not rows:
            return 0
        sent_count = 0
        last_id = ckpt
        for row in rows:
            kind = row.get("kind", "")
            if self.config.kind_prefixes and not any(
                kind.startswith(p) for p in self.config.kind_prefixes
            ):
                last_id = row.get("id", last_id)
                continue
            try:
                cef = format_cef(row)
                self.send(self.config, cef)
                sent_count += 1
                self._stats["sent"] += 1
                last_id = row.get("id", last_id)
            except Exception as e:  # noqa: BLE001
                log.warning("SIEM send failed for entry id=%s: %s", row.get("id"), e)
                self._stats["errors"] += 1
                if self.config.protocol == "tcp":
                    # On TCP we want at-least-once; stop the batch
                    # at the last successful id and retry next poll.
                    break
                # UDP is fire-and-forget; advance checkpoint anyway
                last_id = row.get("id", last_id)
        if last_id > ckpt:
            _write_checkpoint(self.config.checkpoint_path, last_id)
        return sent_count


# ---------------------------------------------------------------------------
# Module-level singleton — wired into FastAPI lifespan
# ---------------------------------------------------------------------------


_FORWARDER: Optional[SiemForwarder] = None
_FORWARDER_LOCK = threading.Lock()


def install_forwarder() -> Optional[SiemForwarder]:
    """Create + start a SiemForwarder if SIEM is enabled in env.
    No-op when disabled. Returns the forwarder for shutdown."""
    cfg = _config_from_env()
    if not cfg.enabled or not cfg.host:
        return None
    from ..persistence import recent_entries

    def fetch(after_id: int, limit: int) -> List[Dict[str, Any]]:
        # recent_entries returns newest-first; we want oldest-first
        # past the checkpoint so the SIEM sees ordered events.
        rows = recent_entries(limit=limit + 100, include_payload=True)
        rows = [r for r in rows if r.get("id", 0) > after_id]
        rows.sort(key=lambda r: r.get("id", 0))
        return rows[:limit]

    forwarder = SiemForwarder(config=cfg, fetch_entries=fetch)
    forwarder.start()
    with _FORWARDER_LOCK:
        global _FORWARDER
        _FORWARDER = forwarder
    return forwarder


def shutdown_forwarder() -> None:
    with _FORWARDER_LOCK:
        global _FORWARDER
        if _FORWARDER is not None:
            _FORWARDER.stop()
            _FORWARDER = None
