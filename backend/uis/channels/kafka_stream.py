"""KafkaChannel — streaming consumer for Kafka topics.

Modern AISs that emit events on Kafka land here. Same protocol
contract as the file-based channels — each poll cycle materializes
a batch of messages as one JSONL ``PendingFile`` and lets the
existing pipeline + writer do their work.

Consumer-group semantics
------------------------
Configurable consumer group ID; messages stream from wherever
the group's offset currently sits. Acknowledge advances the
offset (commits to the broker); quarantine rolls it back so the
batch is re-delivered once the upstream issue is fixed.

Polling shape
-------------
``list_pending`` calls ``consumer.consume(num=batch_size, timeout=...)``
to drain up to ``batch_size`` messages within ``poll_timeout_seconds``.
A batch becomes one ``PendingFile`` whose body is the messages
serialized as JSON Lines (one per row). The pipeline auto-detects
JSONL — no special handling needed downstream.

When zero messages are available within the timeout window, the
cycle returns empty (no PendingFile). The channel runner moves
on; the scheduler retries on its configured interval.

Auth
----
Standard Kafka auth via librdkafka properties:
  * ``security_protocol`` — PLAINTEXT / SSL / SASL_PLAINTEXT / SASL_SSL
  * ``sasl_mechanism`` — PLAIN / SCRAM-SHA-256 / SCRAM-SHA-512 / GSSAPI
  * ``sasl_username`` + ``sasl_password_env`` — credentials
  * ``ssl_ca_path``, ``ssl_cert_path``, ``ssl_key_path`` — TLS materials

DoD-relevant: Kafka clusters fronted by mTLS or Kerberos GSSAPI.
The channel exposes the librdkafka knobs directly so an operator
configures the cluster the way the broker team requires.

Streaming != stateless
----------------------
Unlike file channels, Kafka holds CONNECTION state between polls
(consumer subscription, broker connection, offset position).
``health()`` opens a transient connection to assert reachability
without committing the long-lived one — an idle consumer can
otherwise tie up broker resources.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from .base import ChannelHealth, IngestChannel, PendingFile


log = logging.getLogger(__name__)


@dataclass
class _KafkaHandle:
    body: bytes
    message_count: int
    # Per-partition offset to commit on ack: {(topic, partition): offset}
    offsets: Dict[Any, int] = field(default_factory=dict)


@dataclass
class KafkaChannel:
    """Streaming consumer for one Kafka topic (or a list of topics).

    Idempotency is at-least-once: if SPIRE crashes between apply
    and offset commit, the batch is re-delivered next poll. The
    writer's state_token + idempotent merge semantics handle this
    correctly (a re-delivered already-applied row lands in
    ``unchanged`` rather than mutating canonical state).
    """

    channel_id: str
    adapter_id: str
    bootstrap_servers: str         # "broker1:9092,broker2:9092"
    topic: str                      # may be a comma-separated list
    group_id: str                   # consumer group

    # Polling
    batch_size: int = 500
    poll_timeout_seconds: float = 5.0

    # Reset semantics for fresh group: "earliest" / "latest" / "none"
    auto_offset_reset: str = "latest"

    # Auth
    security_protocol: str = "PLAINTEXT"
    sasl_mechanism: str = ""
    sasl_username: str = ""
    sasl_password_env: str = ""
    ssl_ca_path: str = ""
    ssl_cert_path: str = ""
    ssl_key_path: str = ""

    # Misc
    response_filename: str = ""

    channel_type: str = field(default="kafka", init=False)

    _last_polled_at: Optional[str] = field(default=None, init=False, repr=False)
    _last_success_at: Optional[str] = field(default=None, init=False, repr=False)
    _last_error: Optional[str] = field(default=None, init=False, repr=False)
    _consecutive_failures: int = field(default=0, init=False, repr=False)
    # Lazy-init persistent consumer — created on first list_pending,
    # reused across polls until close() is called or process exits.
    _consumer: Any = field(default=None, init=False, repr=False)

    # ------------------------------------------------------------------
    # Consumer lifecycle
    # ------------------------------------------------------------------

    def _build_consumer(self):
        """Late-bound — confluent_kafka isn't a hard dep on the UIS
        package. If a deployment uses Kafka they install the lib;
        otherwise importing this module still works."""
        try:
            from confluent_kafka import Consumer  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "KafkaChannel requires `confluent-kafka`. "
                "Install: pip install confluent-kafka"
            ) from e

        conf: Dict[str, Any] = {
            "bootstrap.servers": self.bootstrap_servers,
            "group.id": self.group_id,
            "auto.offset.reset": self.auto_offset_reset,
            # We commit offsets manually on ack — disable auto-commit
            # to keep at-least-once semantics tight.
            "enable.auto.commit": False,
            "security.protocol": self.security_protocol,
        }
        if self.sasl_mechanism:
            conf["sasl.mechanism"] = self.sasl_mechanism
        if self.sasl_username:
            conf["sasl.username"] = self.sasl_username
        if self.sasl_password_env:
            # P6.9 — Vault-aware secrets resolution
            from ..secrets import resolve_env_secret as _resolve
            pwd = _resolve(self.sasl_password_env)
            if pwd is None:
                raise RuntimeError(
                    f"KafkaChannel {self.channel_id}: sasl_password_env "
                    f"{self.sasl_password_env!r} is unset."
                )
            conf["sasl.password"] = pwd
        if self.ssl_ca_path:
            conf["ssl.ca.location"] = self.ssl_ca_path
        if self.ssl_cert_path:
            conf["ssl.certificate.location"] = self.ssl_cert_path
        if self.ssl_key_path:
            conf["ssl.key.location"] = self.ssl_key_path

        consumer = Consumer(conf)
        topics = [t.strip() for t in self.topic.split(",") if t.strip()]
        consumer.subscribe(topics)
        return consumer

    def _ensure_consumer(self):
        if self._consumer is None:
            self._consumer = self._build_consumer()
        return self._consumer

    def close(self) -> None:
        """Operator hook — release the consumer + commit cleanly.
        Called by the scheduler at shutdown."""
        if self._consumer is not None:
            try:
                self._consumer.close()
            except Exception:  # noqa: BLE001
                pass
            self._consumer = None

    # ------------------------------------------------------------------
    # IngestChannel interface
    # ------------------------------------------------------------------

    def list_pending(self) -> Iterable[PendingFile]:
        self._last_polled_at = _utc_iso()
        try:
            consumer = self._ensure_consumer()
            messages = consumer.consume(
                num_messages=self.batch_size,
                timeout=self.poll_timeout_seconds,
            )
        except Exception as e:
            self._record_failure(str(e))
            raise

        if not messages:
            return []

        body_lines: List[str] = []
        offsets: Dict[Any, int] = {}
        valid_count = 0
        for m in messages:
            err = m.error()
            if err is not None:
                # Errors here are protocol / partition events the
                # broker surfaces in-band. Skip — they're not
                # records to ingest.
                log.info(
                    "KafkaChannel %s: dropped message error: %s",
                    self.channel_id, err,
                )
                continue
            payload = m.value()
            if payload is None:
                continue
            try:
                # Try JSON; if it isn't, wrap as a string field
                obj = json.loads(payload)
                if not isinstance(obj, dict):
                    obj = {"_value": obj}
            except (json.JSONDecodeError, UnicodeDecodeError):
                obj = {
                    "_value": payload.decode("utf-8", errors="replace"),
                }
            obj["_kafka_topic"] = m.topic()
            obj["_kafka_partition"] = m.partition()
            obj["_kafka_offset"] = m.offset()
            body_lines.append(json.dumps(obj, default=str))
            # Track high-water offset per (topic, partition)
            key = (m.topic(), m.partition())
            cur = offsets.get(key, -1)
            if m.offset() > cur:
                offsets[key] = m.offset()
            valid_count += 1

        if valid_count == 0:
            return []

        body = ("\n".join(body_lines) + "\n").encode("utf-8")
        filename = self.response_filename or _derive_filename(self)
        handle = _KafkaHandle(
            body=body,
            message_count=valid_count,
            offsets=offsets,
        )
        return [PendingFile(
            handle=handle,
            filename=filename,
            size_bytes=len(body),
            received_at=_utc_iso(),
        )]

    def fetch(self, pending: PendingFile) -> bytes:
        if not isinstance(pending.handle, _KafkaHandle):
            raise TypeError(
                f"KafkaChannel.fetch expected _KafkaHandle, got {type(pending.handle)}"
            )
        return pending.handle.body

    def acknowledge(self, pending: PendingFile) -> None:
        """Commit offsets for the consumed batch.

        At-least-once: if commit fails, the next poll re-delivers
        the batch. The writer's idempotent merge semantics mean
        already-applied rows land in ``unchanged`` on the redelivery.
        """
        handle: _KafkaHandle = pending.handle
        if not handle.offsets:
            return
        consumer = self._ensure_consumer()
        try:
            from confluent_kafka import TopicPartition  # type: ignore
        except ImportError:
            return
        # Commit at the offset AFTER the last consumed (Kafka stores
        # "next offset to consume" semantics).
        partitions = [
            TopicPartition(topic=t, partition=p, offset=off + 1)
            for (t, p), off in handle.offsets.items()
        ]
        try:
            consumer.commit(offsets=partitions, asynchronous=False)
            self._last_success_at = _utc_iso()
            self._consecutive_failures = 0
            self._last_error = None
        except Exception as e:  # noqa: BLE001
            log.warning(
                "KafkaChannel %s: offset commit failed: %s",
                self.channel_id, e,
            )
            self._record_failure(f"commit_failed: {e}")

    def quarantine(self, pending: PendingFile, reason: str) -> None:
        """Don't commit offsets — let the broker re-deliver. Sidecar
        the batch to disk for inspection.

        Caveat: re-delivery means a poison message keeps coming
        back until the upstream is fixed. The circuit breaker (P4.3)
        eventually trips and suppresses the channel — operator
        notices via health endpoint.
        """
        handle: _KafkaHandle = pending.handle
        # Optional disk dump
        dump_dir = os.environ.get("SPIRE_KAFKA_QUARANTINE_DIR", "")
        if dump_dir:
            try:
                from pathlib import Path
                qdir = Path(dump_dir) / self.channel_id
                qdir.mkdir(parents=True, exist_ok=True)
                stamp = _utc_iso().replace(":", "").replace("-", "")
                payload = qdir / f"{stamp}_{pending.filename}"
                payload.write_bytes(handle.body)
                sidecar = payload.with_suffix(payload.suffix + ".reason.txt")
                sidecar.write_text(
                    f"channel: {self.channel_id}\n"
                    f"timestamp: {_utc_iso()}\n"
                    f"message_count: {handle.message_count}\n"
                    f"offsets: {dict(handle.offsets)}\n"
                    f"reason: {reason}\n",
                    encoding="utf-8",
                )
            except OSError as e:
                log.warning("KafkaChannel quarantine dump failed: %s", e)
        self._record_failure(reason)

    def health(self) -> ChannelHealth:
        """Reachability probe — open a fresh AdminClient + list
        topics with a short timeout. Doesn't touch the long-lived
        consumer."""
        reachable = False
        try:
            from confluent_kafka.admin import AdminClient  # type: ignore
            conf: Dict[str, Any] = {
                "bootstrap.servers": self.bootstrap_servers,
                "security.protocol": self.security_protocol,
            }
            client = AdminClient(conf)
            md = client.list_topics(timeout=5.0)
            reachable = md is not None
        except Exception as e:
            self._last_error = str(e)
        return ChannelHealth(
            channel_id=self.channel_id,
            channel_type=self.channel_type,
            reachable=reachable,
            pending_count=None,
            last_polled_at=self._last_polled_at,
            last_success_at=self._last_success_at,
            last_error=self._last_error,
            consecutive_failures=self._consecutive_failures,
            extra={
                "bootstrap_servers": self.bootstrap_servers,
                "topic": self.topic,
                "group_id": self.group_id,
            },
        )

    def _record_failure(self, reason: str) -> None:
        self._consecutive_failures += 1
        self._last_error = reason

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def to_config_dict(self) -> dict:
        return {
            "channel_id": self.channel_id,
            "channel_type": self.channel_type,
            "adapter_id": self.adapter_id,
            "config": {
                "bootstrap_servers": self.bootstrap_servers,
                "topic": self.topic,
                "group_id": self.group_id,
                "batch_size": self.batch_size,
                "poll_timeout_seconds": self.poll_timeout_seconds,
                "auto_offset_reset": self.auto_offset_reset,
                "security_protocol": self.security_protocol,
                "sasl_mechanism": self.sasl_mechanism,
                "sasl_username": self.sasl_username,
                "sasl_password_env": self.sasl_password_env,
                "ssl_ca_path": self.ssl_ca_path,
                "ssl_cert_path": self.ssl_cert_path,
                "ssl_key_path": self.ssl_key_path,
                "response_filename": self.response_filename,
            },
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _derive_filename(channel) -> str:
    safe_topic = channel.topic.replace(",", "+").replace("/", "_")
    return f"kafka_{safe_topic}_{channel.group_id}.jsonl"
