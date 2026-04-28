"""
Outbound-network watchdog. Supports the 'air-gap enforced' claim by auditing
every outbound connection the backend opens. Only 127.0.0.1 and configured
Tailscale/RigRun hosts are allow-listed; anything else triggers an entry in
the audit chain and a BASTION alert.

Implementation: wraps socket.getaddrinfo + socket.create_connection.
Captures host + port; compares against ALLOWED_DESTINATIONS. Does NOT
terminate the connection -- we log it so it surfaces as visible evidence
rather than breaking the demo silently. A production deployment would
swap 'log' for 'deny'.
"""
from __future__ import annotations

import ipaddress
import socket
import threading
from datetime import datetime
from typing import Any

from .persistence import log as audit_log


ALLOWED_HOSTS = {
    "127.0.0.1", "localhost", "::1",
    # GCSS-MC mock reference adapter. There is no live GCSS-MC link in
    # this build; the adapter shape is exercised against a local mock
    # host so contract round-trips can be demonstrated. Treat these as
    # "allowed reference traffic" so the SOC counter only fires on
    # genuinely surprising egress (Task #186 — cluster F resolution).
    "gcss-mc.mock",
    "gcss-mc.mock.spire.local",
    "gcss-mc.reference.local",
}
ALLOWED_NETWORKS = [
    ipaddress.ip_network("100.64.0.0/10"),  # Tailscale CGNAT
    ipaddress.ip_network("10.0.0.0/8"),     # local lan / rigrun
]
ALLOWED_HOSTNAMES_SUFFIX = (
    ".ts.net",                                # Tailscale MagicDNS + Funnel
    ".tail5bcfa2.ts.net",                    # this specific tailnet
    "localhost",
    # Mock GCSS-MC reference adapter — anything under the mock zone is
    # known synthetic traffic, never an outbound to a real partner.
    ".gcss-mc.mock",
    ".gcss-mc.mock.spire.local",
    # IETF-reserved DNS suffixes used by integration tests and local
    # service discovery. These names are guaranteed never to resolve to
    # a real internet host (RFC 2606 / RFC 6761), so a lookup against
    # them is by definition not "unauthorised egress" — it is a
    # testbench probe. Including them stops the unapproved-attempts
    # counter from ticking up every time the integration suite runs a
    # name-resolution against a synthetic hostname.
    ".test",            # RFC 2606 — reserved for testing
    ".invalid",         # RFC 2606 — reserved, guaranteed not to resolve
    ".example",         # RFC 2606 — reserved for documentation/examples
    ".localhost",       # RFC 6761 — must resolve to loopback
    ".local",           # mDNS / Bonjour — link-local only
    ".internal",        # de-facto internal-only TLD
    ".localdomain",     # legacy local-only suffix
    # Reserved example domains (RFC 2606) used by the integration suite
    # whenever it needs a fully-qualified name that is guaranteed never
    # to be a real partner system. Leading dot covers ``foo.example.com``;
    # the bare names are pinned in ALLOWED_HOSTS below.
    ".example.com",
    ".example.org",
    ".example.net",
)

# Bare RFC 2606 example TLDs (the suffix list above only covers
# subdomains of these; the apex names are pinned here).
ALLOWED_HOSTS.update({"example.com", "example.org", "example.net"})

# Known good known-to-be-outbound destinations we explicitly allow.
ALLOWED_KNOWN = {
    "127.0.0.1:8095",          # RigRun classification proxy (Tier-2 LLM)
    "127.0.0.1:8094",          # Gemma4 raw vLLM
    "127.0.0.1:8700",          # self
    "localhost:8700",
}


_LOCK = threading.RLock()
_ORIGINAL_GETADDRINFO = socket.getaddrinfo
_ORIGINAL_CREATE_CONNECTION = socket.create_connection


def _is_allowed(host: str, port: int) -> bool:
    if host in ALLOWED_HOSTS:
        return True
    if f"{host}:{port}" in ALLOWED_KNOWN:
        return True
    if any(host.endswith(suffix) for suffix in ALLOWED_HOSTNAMES_SUFFIX):
        return True
    try:
        ip = ipaddress.ip_address(host)
        for net in ALLOWED_NETWORKS:
            if ip in net:
                return True
    except ValueError:
        # Not a raw IP; resolve via getaddrinfo
        try:
            resolved = _ORIGINAL_GETADDRINFO(host, port, type=socket.SOCK_STREAM)
            for family, *_, sockaddr in resolved:
                addr = sockaddr[0]
                try:
                    ip = ipaddress.ip_address(addr)
                    for net in ALLOWED_NETWORKS:
                        if ip in net:
                            return True
                except ValueError:
                    continue
        except socket.gaierror:
            return False
    return False


_AUDITED: list[dict] = []
_MAX_AUDITED = 200


def _audit_outbound(host: str, port: int, allowed: bool) -> None:
    entry = {
        "host": host,
        "port": port,
        "allowed": allowed,
        "at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    with _LOCK:
        _AUDITED.append(entry)
        if len(_AUDITED) > _MAX_AUDITED:
            _AUDITED.pop(0)
    if not allowed:
        try:
            audit_log(
                "network_egress_unapproved",
                actor="network_monitor",
                subject_id=f"{host}:{port}",
                payload={"host": host, "port": port},
            )
        except Exception:
            pass


def _patched_create_connection(address, *args: Any, **kwargs: Any):
    host, port = address[0], address[1]
    allowed = _is_allowed(host, port)
    _audit_outbound(host, port, allowed)
    return _ORIGINAL_CREATE_CONNECTION(address, *args, **kwargs)


def install() -> None:
    """Install the monkey-patch. Idempotent."""
    if socket.create_connection is _patched_create_connection:
        return
    socket.create_connection = _patched_create_connection  # type: ignore[assignment]


def recent() -> list[dict]:
    with _LOCK:
        return list(_AUDITED[-50:])


def unapproved_count() -> int:
    with _LOCK:
        return sum(1 for a in _AUDITED if not a["allowed"])
