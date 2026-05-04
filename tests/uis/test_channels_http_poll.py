"""HttpPollChannel tests using respx (httpx mock transport).

Unit tests don't fire real HTTP requests — they intercept httpx
calls through respx (or a hand-rolled MockTransport when respx
isn't available) and assert the channel's interaction protocol.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

import pytest

httpx = pytest.importorskip("httpx")

from backend.uis.channels import HttpPollChannel, IngestChannel


# ---------------------------------------------------------------------------
# Mock transport — installed by patching httpx.Client at import time
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_transport(monkeypatch):
    """Install an httpx.MockTransport that records requests and
    returns scripted responses. Returns the transport so tests can
    pre-populate routes."""
    routes: Dict[str, httpx.Response] = {}
    requests: List[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        # Match by url-without-query
        key = str(request.url).split("?")[0]
        if key in routes:
            return routes[key]
        # Fallback: any URL produces 200 + empty body
        return httpx.Response(200, content=b"")

    transport = httpx.MockTransport(handler)

    real_client = httpx.Client

    def patched_client(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", patched_client)
    # Expose helpers
    return type("MT", (), {
        "routes": routes,
        "requests": requests,
        "transport": transport,
    })()


# ---------------------------------------------------------------------------
# Construction + protocol
# ---------------------------------------------------------------------------


def test_satisfies_protocol():
    ch = HttpPollChannel(
        channel_id="t/http",
        adapter_id="gcss-mc/sr-header",
        url="https://example.mil/sr/export",
    )
    assert isinstance(ch, IngestChannel)
    assert ch.channel_type == "http_poll"


def test_to_config_excludes_secret_values(monkeypatch):
    monkeypatch.setenv("MY_TOKEN", "secret-token-xyz")
    ch = HttpPollChannel(
        channel_id="t/http",
        adapter_id="gcss-mc/sr-header",
        url="https://api.example.mil/v1",
        bearer_token_env="MY_TOKEN",
    )
    cfg = ch.to_config_dict()
    assert cfg["config"]["bearer_token_env"] == "MY_TOKEN"
    assert "secret-token-xyz" not in str(cfg)


# ---------------------------------------------------------------------------
# list_pending → fetch round-trip
# ---------------------------------------------------------------------------


def test_list_pending_returns_response_body_as_pending_file(mock_transport):
    body = b"SR_NUMBER,STATUS\nSR-1,OPEN\n"
    mock_transport.routes["https://api.example.mil/v1/srs"] = httpx.Response(
        200, content=body, headers={"X-Watermark": "2026-04-26T12:00:00Z"},
    )
    ch = HttpPollChannel(
        channel_id="t/http",
        adapter_id="gcss-mc/sr-header",
        url="https://api.example.mil/v1/srs",
        watermark_header="X-Watermark",
    )
    pending = list(ch.list_pending())
    assert len(pending) == 1
    p = pending[0]
    assert p.size_bytes == len(body)
    body_back = ch.fetch(p)
    assert body_back == body


def test_empty_response_yields_zero_pending(mock_transport):
    mock_transport.routes["https://api.example.mil/v1/srs"] = httpx.Response(
        200, content=b"",
    )
    ch = HttpPollChannel(
        channel_id="t/empty",
        adapter_id="gcss-mc/sr-header",
        url="https://api.example.mil/v1/srs",
    )
    assert list(ch.list_pending()) == []


def test_404_yields_zero_pending(mock_transport):
    """Some servers use 404 to mean 'no records since watermark' —
    treat as empty cycle, not failure."""
    mock_transport.routes["https://api.example.mil/v1/srs"] = httpx.Response(404)
    ch = HttpPollChannel(
        channel_id="t/404",
        adapter_id="gcss-mc/sr-header",
        url="https://api.example.mil/v1/srs",
    )
    assert list(ch.list_pending()) == []


def test_500_raises(mock_transport):
    mock_transport.routes["https://api.example.mil/v1/srs"] = httpx.Response(500)
    ch = HttpPollChannel(
        channel_id="t/500",
        adapter_id="gcss-mc/sr-header",
        url="https://api.example.mil/v1/srs",
    )
    with pytest.raises(RuntimeError, match="500"):
        list(ch.list_pending())
    assert ch._consecutive_failures == 1


# ---------------------------------------------------------------------------
# Watermark
# ---------------------------------------------------------------------------


def test_watermark_param_sent_on_subsequent_polls(mock_transport, tmp_path):
    state_path = tmp_path / "wm.txt"
    body1 = b"row1\n"
    mock_transport.routes["https://api.example.mil/v1/srs"] = httpx.Response(
        200, content=body1, headers={"X-Wm": "after-1"},
    )
    ch = HttpPollChannel(
        channel_id="t/wm",
        adapter_id="gcss-mc/sr-header",
        url="https://api.example.mil/v1/srs",
        watermark_param="since",
        watermark_header="X-Wm",
        watermark_state_path=str(state_path),
    )
    pending = list(ch.list_pending())[0]
    ch.acknowledge(pending)
    # Watermark persisted
    assert state_path.read_text(encoding="utf-8").strip() == "after-1"

    # Second poll uses the watermark in the query string
    list(ch.list_pending())
    last_request = mock_transport.requests[-1]
    assert "since=after-1" in str(last_request.url)


def test_watermark_jsonpath_extracts_from_response(mock_transport):
    body = b'{"data": [{"id": 1}], "meta": {"last_id": "row-99"}}'
    mock_transport.routes["https://api.example.mil/v1/items"] = httpx.Response(
        200, content=body,
    )
    ch = HttpPollChannel(
        channel_id="t/jsonpath",
        adapter_id="gcss-mc/sr-header",
        url="https://api.example.mil/v1/items",
        watermark_jsonpath="meta.last_id",
    )
    pending = list(ch.list_pending())[0]
    handle = pending.handle
    assert handle.watermark == "row-99"


def test_quarantine_does_not_advance_watermark(mock_transport, tmp_path):
    """If apply quarantines a fetched payload, the next poll
    re-fetches the same delta — operator's expected to fix the
    upstream first."""
    state_path = tmp_path / "wm.txt"
    state_path.write_text("baseline", encoding="utf-8")
    mock_transport.routes["https://api.example.mil/v1/srs"] = httpx.Response(
        200, content=b"data\n", headers={"X-Wm": "after-baseline"},
    )
    ch = HttpPollChannel(
        channel_id="t/no-advance",
        adapter_id="gcss-mc/sr-header",
        url="https://api.example.mil/v1/srs",
        watermark_header="X-Wm",
        watermark_state_path=str(state_path),
    )
    pending = list(ch.list_pending())[0]
    ch.quarantine(pending, "schema_drift")
    # Watermark file still says baseline — quarantine should not advance
    assert state_path.read_text(encoding="utf-8").strip() == "baseline"


def test_quarantine_dumps_body_to_quarantine_dir(mock_transport, tmp_path):
    state_path = tmp_path / "wm.txt"
    mock_transport.routes["https://api.example.mil/v1/srs"] = httpx.Response(
        200, content=b"poison-payload",
    )
    ch = HttpPollChannel(
        channel_id="t/qdump",
        adapter_id="gcss-mc/sr-header",
        url="https://api.example.mil/v1/srs",
        watermark_state_path=str(state_path),
    )
    pending = list(ch.list_pending())[0]
    ch.quarantine(pending, "duplicate_header_columns")
    qdir = tmp_path / "quarantine"
    files = list(qdir.iterdir())
    # Body + sidecar
    assert len(files) == 2
    sidecars = [f for f in files if f.name.endswith(".reason.txt")]
    assert sidecars
    sidecar_text = sidecars[0].read_text(encoding="utf-8")
    assert "duplicate_header_columns" in sidecar_text


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def test_bearer_token_added_to_authorization_header(mock_transport, monkeypatch):
    monkeypatch.setenv("DLA_TOKEN", "abc123")
    mock_transport.routes["https://api.dla.mil/v1/orders"] = httpx.Response(
        200, content=b"x\n",
    )
    ch = HttpPollChannel(
        channel_id="t/bearer",
        adapter_id="gcss-mc/sr-header",
        url="https://api.dla.mil/v1/orders",
        bearer_token_env="DLA_TOKEN",
    )
    list(ch.list_pending())
    req = mock_transport.requests[-1]
    assert req.headers.get("Authorization") == "Bearer abc123"


def test_basic_auth_credentials(mock_transport, monkeypatch):
    monkeypatch.setenv("MY_HTTP_PWD", "supersecret")
    mock_transport.routes["https://api.example.mil/v1/feed"] = httpx.Response(
        200, content=b"x\n",
    )
    ch = HttpPollChannel(
        channel_id="t/basic",
        adapter_id="gcss-mc/sr-header",
        url="https://api.example.mil/v1/feed",
        basic_auth_username="spire",
        basic_auth_password_env="MY_HTTP_PWD",
    )
    list(ch.list_pending())
    req = mock_transport.requests[-1]
    auth_header = req.headers.get("Authorization", "")
    assert auth_header.startswith("Basic ")
    import base64
    decoded = base64.b64decode(auth_header.split(" ", 1)[1]).decode()
    assert decoded == "spire:supersecret"


def test_bearer_token_unset_raises(mock_transport, monkeypatch):
    monkeypatch.delenv("UNSET_TOKEN", raising=False)
    ch = HttpPollChannel(
        channel_id="t/no-tok",
        adapter_id="gcss-mc/sr-header",
        url="https://api.example.mil/v1/feed",
        bearer_token_env="UNSET_TOKEN",
    )
    with pytest.raises(RuntimeError, match="bearer_token_env"):
        list(ch.list_pending())


# ---------------------------------------------------------------------------
# SOAP
# ---------------------------------------------------------------------------


def test_soap_action_header_and_request_body(mock_transport):
    soap_envelope = (
        "<?xml version='1.0'?>"
        "<soap:Envelope xmlns:soap='http://schemas.xmlsoap.org/soap/envelope/'>"
        "<soap:Body><GetSRs/></soap:Body>"
        "</soap:Envelope>"
    )
    response = (
        b"<?xml version='1.0'?>"
        b"<soap:Envelope xmlns:soap='http://schemas.xmlsoap.org/soap/envelope/'>"
        b"<soap:Body><GetSRsResponse><sr>1</sr></GetSRsResponse></soap:Body>"
        b"</soap:Envelope>"
    )
    mock_transport.routes["https://gcss-mc.usmc.mil/soap"] = httpx.Response(
        200, content=response,
    )
    ch = HttpPollChannel(
        channel_id="t/soap",
        adapter_id="gcss-mc/sr-header",
        url="https://gcss-mc.usmc.mil/soap",
        method="POST",
        soap_action="urn:GetSRs",
        request_body=soap_envelope,
    )
    list(ch.list_pending())
    req = mock_transport.requests[-1]
    assert req.method == "POST"
    assert req.headers.get("SOAPAction") == "urn:GetSRs"
    assert req.headers.get("Content-Type") == "application/xml"
    assert b"GetSRs" in req.content
