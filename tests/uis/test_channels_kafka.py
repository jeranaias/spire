"""KafkaChannel tests with a mocked confluent_kafka.Consumer.

confluent-kafka is not installed by default; tests stub the
import so the channel logic is exercisable in any environment.
A real cluster smoke test lives outside the unit suite.
"""
from __future__ import annotations

import json
import sys
import types
from typing import Any, Dict, List
from unittest.mock import MagicMock

import pytest

from backend.uis.channels import IngestChannel, KafkaChannel


# ---------------------------------------------------------------------------
# Stub confluent_kafka module — installed once per test session
# ---------------------------------------------------------------------------


class _StubMessage:
    """Mimics confluent_kafka.Message — value()/error()/topic()/etc."""
    def __init__(self, value, *, topic="srs.updates", partition=0, offset=0, error=None):
        self._value = value
        self._error = error
        self._topic = topic
        self._partition = partition
        self._offset = offset
    def value(self): return self._value
    def error(self): return self._error
    def topic(self): return self._topic
    def partition(self): return self._partition
    def offset(self): return self._offset


class _StubTopicPartition:
    def __init__(self, *, topic, partition, offset):
        self.topic = topic
        self.partition = partition
        self.offset = offset


class _StubConsumer:
    """In-memory consumer. Tests pre-populate ``messages`` (list of
    _StubMessage); each consume() call drains up to N from the front."""
    def __init__(self, conf):
        self.conf = conf
        self.messages: List[_StubMessage] = []
        self.subscriptions: List[str] = []
        self.commits: List[List[_StubTopicPartition]] = []
        self.closed = False

    def subscribe(self, topics):
        self.subscriptions = list(topics)

    def consume(self, num_messages=500, timeout=5.0):
        out = self.messages[:num_messages]
        self.messages = self.messages[num_messages:]
        return out

    def commit(self, *, offsets, asynchronous=False):
        self.commits.append(list(offsets))

    def close(self):
        self.closed = True


@pytest.fixture
def stub_kafka(monkeypatch):
    """Install a fake confluent_kafka module + return a harness so
    tests can set messages, inspect commits, etc."""
    fake = types.ModuleType("confluent_kafka")
    fake.Consumer = _StubConsumer
    fake.TopicPartition = _StubTopicPartition

    fake_admin = types.ModuleType("confluent_kafka.admin")
    class _FakeAdmin:
        def __init__(self, conf): self.conf = conf
        def list_topics(self, timeout=5.0):
            return MagicMock()
    fake_admin.AdminClient = _FakeAdmin

    monkeypatch.setitem(sys.modules, "confluent_kafka", fake)
    monkeypatch.setitem(sys.modules, "confluent_kafka.admin", fake_admin)

    harness = types.SimpleNamespace(
        _instances=[],
        StubMessage=_StubMessage,
    )

    # Track the consumer instance that the channel ends up creating.
    orig_init = _StubConsumer.__init__
    def init_with_track(self, conf):
        orig_init(self, conf)
        harness._instances.append(self)
    _StubConsumer.__init__ = init_with_track

    yield harness

    _StubConsumer.__init__ = orig_init


# ---------------------------------------------------------------------------
# Construction + protocol
# ---------------------------------------------------------------------------


def test_satisfies_protocol():
    ch = KafkaChannel(
        channel_id="t/k",
        adapter_id="gcss-mc/sr-header",
        bootstrap_servers="b1:9092,b2:9092",
        topic="srs",
        group_id="spire-srs",
    )
    assert isinstance(ch, IngestChannel)
    assert ch.channel_type == "kafka"


def test_to_config_excludes_sasl_password(monkeypatch):
    monkeypatch.setenv("KFKPWD", "supersecret")
    ch = KafkaChannel(
        channel_id="t/auth",
        adapter_id="x",
        bootstrap_servers="b1",
        topic="x",
        group_id="g",
        sasl_password_env="KFKPWD",
    )
    cfg = ch.to_config_dict()
    assert cfg["config"]["sasl_password_env"] == "KFKPWD"
    assert "supersecret" not in str(cfg)


# ---------------------------------------------------------------------------
# list_pending → fetch round-trip
# ---------------------------------------------------------------------------


def test_list_pending_returns_one_pending_per_batch(stub_kafka):
    ch = KafkaChannel(
        channel_id="t/k1",
        adapter_id="gcss-mc/sr-header",
        bootstrap_servers="b1",
        topic="srs",
        group_id="g1",
    )
    # First call instantiates the consumer
    pending_first = list(ch.list_pending())
    assert pending_first == []
    # Drop messages on the same consumer
    consumer = stub_kafka._instances[-1]
    consumer.messages = [
        stub_kafka.StubMessage(
            value=b'{"sr_number": "SR-1", "status": "OPEN"}',
            partition=0, offset=100,
        ),
        stub_kafka.StubMessage(
            value=b'{"sr_number": "SR-2", "status": "CLOSED"}',
            partition=0, offset=101,
        ),
    ]
    pending = list(ch.list_pending())
    assert len(pending) == 1
    handle = pending[0].handle
    assert handle.message_count == 2
    body = ch.fetch(pending[0]).decode("utf-8").strip().split("\n")
    rows = [json.loads(line) for line in body]
    assert {r["sr_number"] for r in rows} == {"SR-1", "SR-2"}
    # Each row tagged with kafka metadata
    assert all("_kafka_offset" in r for r in rows)
    assert all("_kafka_partition" in r for r in rows)


def test_non_json_message_wrapped_as_value(stub_kafka):
    ch = KafkaChannel(
        channel_id="t/k2",
        adapter_id="gcss-mc/sr-header",
        bootstrap_servers="b", topic="x", group_id="g",
    )
    list(ch.list_pending())  # init consumer
    consumer = stub_kafka._instances[-1]
    consumer.messages = [
        stub_kafka.StubMessage(value=b"plain text payload", partition=0, offset=10),
    ]
    pending = list(ch.list_pending())[0]
    rows = [json.loads(l) for l in pending.handle.body.decode().strip().split("\n")]
    assert rows[0]["_value"] == "plain text payload"


def test_messages_with_errors_are_skipped(stub_kafka):
    ch = KafkaChannel(
        channel_id="t/k3",
        adapter_id="x", bootstrap_servers="b", topic="x", group_id="g",
    )
    list(ch.list_pending())
    consumer = stub_kafka._instances[-1]
    consumer.messages = [
        stub_kafka.StubMessage(value=b'{"a":1}', partition=0, offset=1),
        stub_kafka.StubMessage(value=None, partition=0, offset=2, error="EOF"),
        stub_kafka.StubMessage(value=b'{"b":2}', partition=0, offset=3),
    ]
    pending = list(ch.list_pending())[0]
    assert pending.handle.message_count == 2


def test_empty_consume_returns_no_pending(stub_kafka):
    ch = KafkaChannel(
        channel_id="t/k4",
        adapter_id="x", bootstrap_servers="b", topic="x", group_id="g",
    )
    list(ch.list_pending())
    consumer = stub_kafka._instances[-1]
    consumer.messages = []
    assert list(ch.list_pending()) == []


# ---------------------------------------------------------------------------
# acknowledge → commit
# ---------------------------------------------------------------------------


def test_acknowledge_commits_high_water_offsets(stub_kafka):
    ch = KafkaChannel(
        channel_id="t/k5",
        adapter_id="x", bootstrap_servers="b", topic="x", group_id="g",
    )
    list(ch.list_pending())
    consumer = stub_kafka._instances[-1]
    consumer.messages = [
        stub_kafka.StubMessage(value=b'{"a":1}', topic="x", partition=0, offset=10),
        stub_kafka.StubMessage(value=b'{"a":2}', topic="x", partition=0, offset=11),
        stub_kafka.StubMessage(value=b'{"a":3}', topic="x", partition=1, offset=20),
    ]
    pending = list(ch.list_pending())[0]
    ch.acknowledge(pending)
    # One commit fired with the high-water offsets per partition
    assert len(consumer.commits) == 1
    committed = {(tp.topic, tp.partition): tp.offset for tp in consumer.commits[0]}
    # Kafka semantics: commit "next offset to consume" → consumed + 1
    assert committed[("x", 0)] == 12  # max consumed 11 + 1
    assert committed[("x", 1)] == 21  # max consumed 20 + 1


def test_quarantine_does_not_commit(stub_kafka):
    """Re-delivery on poison batch — the broker re-sends since
    we never committed."""
    ch = KafkaChannel(
        channel_id="t/k6",
        adapter_id="x", bootstrap_servers="b", topic="x", group_id="g",
    )
    list(ch.list_pending())
    consumer = stub_kafka._instances[-1]
    consumer.messages = [
        stub_kafka.StubMessage(value=b'{"a":1}', partition=0, offset=5),
    ]
    pending = list(ch.list_pending())[0]
    ch.quarantine(pending, "schema_drift")
    assert consumer.commits == []  # no offsets committed
    assert ch._consecutive_failures == 1


# ---------------------------------------------------------------------------
# Auth + close
# ---------------------------------------------------------------------------


def test_sasl_password_resolved_from_env(stub_kafka, monkeypatch):
    monkeypatch.setenv("KAFKA_PWD", "p@ss")
    ch = KafkaChannel(
        channel_id="t/auth",
        adapter_id="x", bootstrap_servers="b", topic="x", group_id="g",
        security_protocol="SASL_SSL",
        sasl_mechanism="PLAIN",
        sasl_username="spire",
        sasl_password_env="KAFKA_PWD",
    )
    list(ch.list_pending())
    consumer = stub_kafka._instances[-1]
    assert consumer.conf["sasl.password"] == "p@ss"
    assert consumer.conf["sasl.username"] == "spire"
    assert consumer.conf["sasl.mechanism"] == "PLAIN"
    assert consumer.conf["security.protocol"] == "SASL_SSL"


def test_sasl_password_unset_raises(stub_kafka, monkeypatch):
    monkeypatch.delenv("MISSING_PWD", raising=False)
    ch = KafkaChannel(
        channel_id="t/no-pwd",
        adapter_id="x", bootstrap_servers="b", topic="x", group_id="g",
        sasl_password_env="MISSING_PWD",
    )
    with pytest.raises(RuntimeError, match="sasl_password_env"):
        list(ch.list_pending())


def test_close_releases_consumer(stub_kafka):
    ch = KafkaChannel(
        channel_id="t/close",
        adapter_id="x", bootstrap_servers="b", topic="x", group_id="g",
    )
    list(ch.list_pending())
    consumer = stub_kafka._instances[-1]
    assert not consumer.closed
    ch.close()
    assert consumer.closed
    assert ch._consumer is None


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


def test_health_uses_admin_client(stub_kafka):
    ch = KafkaChannel(
        channel_id="t/h",
        adapter_id="x", bootstrap_servers="b", topic="x", group_id="g",
    )
    h = ch.health()
    assert h.reachable is True
    assert h.channel_type == "kafka"
