"""Unhandled errors return a generic body, not internal detail (P2-10)."""
from __future__ import annotations

import asyncio
import json

from starlette.requests import Request

from backend.main import unhandled_exception_handler


def _fake_request(path="/api/thing"):
    return Request({"type": "http", "path": path, "method": "GET", "headers": []})


def test_error_handler_hides_exception_detail():
    exc = ValueError("boom while opening /etc/spire/secret.key")
    resp = asyncio.run(unhandled_exception_handler(_fake_request(), exc))
    assert resp.status_code == 500
    body = json.loads(resp.body)
    raw = resp.body.decode()
    assert body["error"] == "internal_error"
    assert body["detail"] == "An unexpected error occurred."
    assert len(body["correlation_id"]) == 12
    # None of the exception's internal detail leaks to the client.
    assert "boom" not in raw
    assert "/etc/spire/secret.key" not in raw
    assert "ValueError" not in raw
