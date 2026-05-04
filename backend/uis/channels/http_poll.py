"""HttpPollChannel — REST / SOAP polling.

For source systems that don't expose file dumps but do expose a
web service. GCSS-MC's SOAP web services are a real example; many
modern AISs also have JSON REST APIs (M-CARE, MILS, DRRS Next).

Per poll, the channel fires one HTTP request, and the response
body becomes one ``PendingFile``. If the body is empty or the
server returns a "no data" sentinel, the cycle yields zero
pending files and skips silently.

Watermark / delta polling
-------------------------
Many web services support "give me records since X" semantics —
``?since=<timestamp>``, ``If-Modified-Since`` header, etc.
HttpPollChannel persists a watermark in a sidecar file (no DB
write) and threads it through each request. After a successful
apply, the watermark advances to whatever the response carried
(server-supplied via header or JSON field, configurable).

Auth
----
Three modes — config picks one or none:

  * ``bearer_token_env`` — Authorization: Bearer <env>
  * ``basic_auth_username`` + ``basic_auth_password_env`` — Basic auth
  * ``mtls_cert_path`` + ``mtls_key_path`` — mutual TLS (DoD common)

SOAP-specific extras
--------------------
``soap_action`` populates the SOAPAction HTTP header. ``request_body``
is a literal payload (e.g. an XML envelope) sent on every poll.
``content_type`` defaults to "application/xml" when SOAP fields are
configured.

Failure semantics
-----------------
Network / 5xx / 4xx errors raise from list_pending; runner catches,
applies retry/backoff, surfaces in audit + circuit breaker. 404
on the watermark endpoint is treated as "no new records" (some
servers use 404 for empty deltas).
"""
from __future__ import annotations

import base64
import json
import logging
import os
import socket
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import urlparse

from .base import ChannelHealth, IngestChannel, PendingFile


log = logging.getLogger(__name__)


@dataclass
class HttpPollChannel:
    """Pull channel that fires one HTTP request per poll cycle.

    A successful response with a non-empty body produces one
    ``PendingFile`` whose ``handle`` is a ``_HttpHandle`` carrying
    the URL, status code, and watermark hint.
    """

    channel_id: str
    adapter_id: str
    url: str
    method: str = "GET"

    # Auth (one of these — not all)
    bearer_token_env: str = ""
    basic_auth_username: str = ""
    basic_auth_password_env: str = ""
    mtls_cert_path: str = ""
    mtls_key_path: str = ""

    # SOAP / payload
    soap_action: str = ""
    request_body: str = ""
    content_type: str = ""
    headers: Dict[str, str] = field(default_factory=dict)

    # Watermark
    watermark_param: str = ""        # query-string key (e.g. "since")
    watermark_header: str = ""        # response header name to read
    watermark_jsonpath: str = ""     # dotted path into JSON (e.g. "meta.last_id")
    watermark_state_path: str = ""    # local sidecar file holding current watermark

    # TLS
    verify_tls: bool = True
    ca_bundle_path: str = ""

    # Misc
    timeout_seconds: float = 30.0
    response_filename: str = ""  # what to call the synthetic file (default URL-derived)

    channel_type: str = field(default="http_poll", init=False)

    _last_polled_at: Optional[str] = field(default=None, init=False, repr=False)
    _last_success_at: Optional[str] = field(default=None, init=False, repr=False)
    _last_error: Optional[str] = field(default=None, init=False, repr=False)
    _consecutive_failures: int = field(default=0, init=False, repr=False)

    # ------------------------------------------------------------------
    # IngestChannel interface
    # ------------------------------------------------------------------

    def list_pending(self) -> Iterable[PendingFile]:
        """Fire the HTTP request, surface the response as one PendingFile.

        Empty 200 response → empty list (nothing to apply).
        404 on a watermark path → empty list (no new records).
        Other non-2xx → raise; runner catches + retries + audits.
        """
        self._last_polled_at = _utc_iso()
        try:
            body, status, response_watermark = self._do_request()
        except Exception as e:
            self._record_failure(str(e))
            raise

        if status == 404:
            return []
        if not body:
            return []

        filename = self.response_filename or _derive_filename(self.url)
        # Embed status + watermark into the handle so fetch can
        # re-emit the body without a second network round-trip.
        handle = _HttpHandle(
            body=body,
            status=status,
            watermark=response_watermark,
        )
        return [PendingFile(
            handle=handle,
            filename=filename,
            size_bytes=len(body),
            received_at=_utc_iso(),
        )]

    def fetch(self, pending: PendingFile) -> bytes:
        """Return the body cached on the handle. No second round-trip
        — list_pending already paid the latency cost."""
        if not isinstance(pending.handle, _HttpHandle):
            raise TypeError(
                f"HttpPollChannel.fetch expected _HttpHandle, got {type(pending.handle)}"
            )
        return pending.handle.body

    def acknowledge(self, pending: PendingFile) -> None:
        """Advance the watermark sidecar. The body itself isn't
        moved anywhere — HTTP responses are ephemeral."""
        handle: _HttpHandle = pending.handle
        if handle.watermark and self.watermark_state_path:
            try:
                Path(self.watermark_state_path).parent.mkdir(parents=True, exist_ok=True)
                with open(self.watermark_state_path, "w", encoding="utf-8") as f:
                    f.write(handle.watermark)
            except OSError as e:
                log.warning(
                    "HttpPollChannel %s: could not write watermark: %s",
                    self.channel_id, e,
                )
        self._last_success_at = _utc_iso()
        self._consecutive_failures = 0
        self._last_error = None

    def quarantine(self, pending: PendingFile, reason: str) -> None:
        """HTTP responses are ephemeral — there's no on-disk file to
        move. Audit captures the reason; the response body's hash
        is recorded so an operator can reconstruct what came back.

        Watermark does NOT advance on quarantine — the next poll
        will re-fetch the same delta (operator hopefully fixes the
        upstream issue first).
        """
        handle: _HttpHandle = pending.handle
        # Optional: dump the bad body to a quarantine dir for inspection
        if self.watermark_state_path:
            qdir = Path(self.watermark_state_path).parent / "quarantine"
            try:
                qdir.mkdir(parents=True, exist_ok=True)
                stamp = _utc_iso().replace(":", "").replace("-", "")
                payload_path = qdir / f"{stamp}_{pending.filename}"
                payload_path.write_bytes(handle.body)
                sidecar = payload_path.with_suffix(payload_path.suffix + ".reason.txt")
                sidecar.write_text(
                    f"channel: {self.channel_id}\n"
                    f"timestamp: {_utc_iso()}\n"
                    f"http_status: {handle.status}\n"
                    f"reason: {reason}\n",
                    encoding="utf-8",
                )
            except OSError as e:
                log.warning(
                    "HttpPollChannel %s: could not write quarantine artifacts: %s",
                    self.channel_id, e,
                )
        self._record_failure(reason)

    def health(self) -> ChannelHealth:
        reachable = False
        try:
            parsed = urlparse(self.url)
            host = parsed.hostname or ""
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            if host:
                with socket.create_connection((host, port), timeout=5):
                    reachable = True
        except Exception as e:
            self._last_error = str(e)
        return ChannelHealth(
            channel_id=self.channel_id,
            channel_type=self.channel_type,
            reachable=reachable,
            pending_count=None,  # HTTP poll doesn't have a notion of "pending"
            last_polled_at=self._last_polled_at,
            last_success_at=self._last_success_at,
            last_error=self._last_error,
            consecutive_failures=self._consecutive_failures,
            extra={
                "url": self.url,
                "method": self.method,
                "watermark_state_path": self.watermark_state_path,
            },
        )

    # ------------------------------------------------------------------
    # HTTP request — split out so tests can stub at the seam
    # ------------------------------------------------------------------

    def _do_request(self) -> tuple:
        """Fire the request. Returns (body_bytes, status_code, watermark_str_or_None).

        Late-binds httpx so the broader UIS package stays importable
        on hosts that don't have it.
        """
        try:
            import httpx  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "HttpPollChannel requires `httpx`. Install it: pip install httpx"
            ) from e

        url = self._url_with_watermark()
        headers = dict(self.headers)
        if self.soap_action:
            headers.setdefault("SOAPAction", self.soap_action)
        if self.content_type:
            headers.setdefault("Content-Type", self.content_type)
        elif self.request_body and self.soap_action:
            headers.setdefault("Content-Type", "application/xml")

        # Auth — populates `auth` (httpx auth) or appends to `headers`
        # (for Bearer tokens). _build_auth must be called AFTER `headers`
        # is constructed since it may inject Authorization there.
        auth = self._build_auth_into_headers(headers)
        cert = None
        if self.mtls_cert_path:
            cert = (
                self.mtls_cert_path,
                self.mtls_key_path or self.mtls_cert_path,
            )

        verify: Any = self.verify_tls
        if self.ca_bundle_path:
            verify = self.ca_bundle_path

        with httpx.Client(
            timeout=self.timeout_seconds,
            verify=verify,
            cert=cert,
            auth=auth,
        ) as client:
            resp = client.request(
                method=self.method,
                url=url,
                headers=headers,
                content=self.request_body.encode("utf-8") if self.request_body else None,
            )

        # 4xx other than 404 → raise
        if resp.status_code == 404:
            return (b"", 404, None)
        if resp.status_code >= 400:
            raise RuntimeError(
                f"HttpPollChannel {self.channel_id}: HTTP {resp.status_code} "
                f"from {url}"
            )

        watermark = self._extract_watermark(resp)
        return (resp.content, resp.status_code, watermark)

    def _url_with_watermark(self) -> str:
        if not self.watermark_param:
            return self.url
        existing = self._read_watermark()
        if not existing:
            return self.url
        sep = "&" if "?" in self.url else "?"
        # Naive URL-encode just the value (httpx will fully validate)
        from urllib.parse import quote
        return f"{self.url}{sep}{self.watermark_param}={quote(existing, safe='')}"

    def _read_watermark(self) -> str:
        if not self.watermark_state_path:
            return ""
        try:
            with open(self.watermark_state_path, "r", encoding="utf-8") as f:
                return f.read().strip()
        except FileNotFoundError:
            return ""
        except OSError:
            return ""

    def _extract_watermark(self, resp) -> Optional[str]:
        """Pull a watermark from the response per channel config."""
        if self.watermark_header:
            wm = resp.headers.get(self.watermark_header, "")
            if wm:
                return wm
        if self.watermark_jsonpath:
            try:
                doc = resp.json()
            except Exception:
                return None
            return _walk_jsonpath(doc, self.watermark_jsonpath)
        return None

    def _build_auth_into_headers(self, headers: Dict[str, str]):
        """Resolve auth at request time. Bearer tokens get injected
        into ``headers`` (httpx doesn't ship a Bearer helper); basic
        auth returns a tuple httpx accepts directly. Returns the
        httpx auth value (None if header-based)."""
        if self.bearer_token_env:
            tok = os.environ.get(self.bearer_token_env)
            if not tok:
                raise RuntimeError(
                    f"HttpPollChannel {self.channel_id}: bearer_token_env "
                    f"{self.bearer_token_env!r} is empty / unset."
                )
            headers["Authorization"] = f"Bearer {tok}"
            return None
        if self.basic_auth_username:
            pwd = os.environ.get(self.basic_auth_password_env or "")
            if pwd is None:
                raise RuntimeError(
                    f"HttpPollChannel {self.channel_id}: basic_auth_password_env "
                    f"{self.basic_auth_password_env!r} is unset."
                )
            return (self.basic_auth_username, pwd)
        return None

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
                "url": self.url,
                "method": self.method,
                "bearer_token_env": self.bearer_token_env,
                "basic_auth_username": self.basic_auth_username,
                "basic_auth_password_env": self.basic_auth_password_env,
                "mtls_cert_path": self.mtls_cert_path,
                "mtls_key_path": self.mtls_key_path,
                "soap_action": self.soap_action,
                "request_body": self.request_body,
                "content_type": self.content_type,
                "headers": dict(self.headers),
                "watermark_param": self.watermark_param,
                "watermark_header": self.watermark_header,
                "watermark_jsonpath": self.watermark_jsonpath,
                "watermark_state_path": self.watermark_state_path,
                "verify_tls": self.verify_tls,
                "ca_bundle_path": self.ca_bundle_path,
                "timeout_seconds": self.timeout_seconds,
                "response_filename": self.response_filename,
            },
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@dataclass
class _HttpHandle:
    body: bytes
    status: int
    watermark: Optional[str] = None


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _derive_filename(url: str) -> str:
    parsed = urlparse(url)
    path = parsed.path or ""
    leaf = path.rsplit("/", 1)[-1] or parsed.netloc
    if "." not in leaf:
        leaf = f"{leaf or 'response'}.bin"
    return leaf


def _walk_jsonpath(doc: Any, path: str) -> Optional[str]:
    """Dotted-path traversal into a JSON document. ``a.b.c`` →
    doc["a"]["b"]["c"]. Returns None if any segment is missing.
    """
    if doc is None or not path:
        return None
    cur: Any = doc
    for seg in path.split("."):
        if isinstance(cur, dict) and seg in cur:
            cur = cur[seg]
        else:
            return None
    if cur is None:
        return None
    return str(cur)
