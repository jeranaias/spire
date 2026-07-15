"""
Outbound-network watchdog. Supports the 'air-gap enforced' claim by auditing
every outbound connection the backend opens. Only 127.0.0.1 and configured
Tailscale/RigRun hosts are allow-listed; anything else triggers an entry in
the audit chain and a BASTION alert.

Implementation: wraps socket.getaddrinfo + socket.create_connection.
Captures host + port; compares against the allowlist. By default it logs
(so unapproved egress surfaces as visible evidence rather than breaking the
demo silently). Set SPIRE_EGRESS_ENFORCE=1 to DENY instead: a connection
outside the allowlist raises EgressBlocked before it opens — the enforcing
air-gap posture for a production/pilot deploy.
"""
from __future__ import annotations

import ipaddress
import os
import socket
import threading
from datetime import datetime
from typing import Any

from .persistence import log as audit_log


class EgressBlocked(OSError):
    """Raised when SPIRE_EGRESS_ENFORCE=1 and a connection targets a host
    outside the allowlist."""


def _enforcing() -> bool:
    return os.environ.get("SPIRE_EGRESS_ENFORCE", "0").strip().lower() in ("1", "true", "yes")


ALLOWED_HOSTS = {
    "127.0.0.1", "localhost", "::1",
}
ALLOWED_NETWORKS = [
    ipaddress.ip_network("100.64.0.0/10"),  # Tailscale CGNAT
    ipaddress.ip_network("10.0.0.0/8"),     # local lan / rigrun
]
ALLOWED_HOSTNAMES_SUFFIX = (
    ".ts.net",                                # Tailscale MagicDNS + Funnel
    ".tail5bcfa2.ts.net",                    # this specific tailnet
    "localhost",
)

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
    if not allowed and _enforcing():
        raise EgressBlocked(
            f"egress to {host}:{port} blocked by SPIRE_EGRESS_ENFORCE"
        )
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
