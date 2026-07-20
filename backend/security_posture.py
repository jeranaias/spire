"""
FIPS / STIG security posture (UIS-P6.2).

SPIRE doesn't claim FIPS *validation* — that requires a CAVP cert and
isn't a software property. What SPIRE does claim is **FIPS-safe
configuration**: every cryptographic primitive used in a security path
is FIPS-approved (SHA-256, HMAC-SHA-256, AES-GCM, RSA / ECDSA / Ed25519
per FIPS 186-5). The system is therefore deployable on a host with the
OpenSSL FIPS provider enabled without any algorithm being refused at
runtime.

This module surfaces the security posture so:

  * Operators can verify the runtime configuration matches what they
    expect (auth mode, audit signing, cookie attributes, security
    headers).
  * STIG / IATT reviewers can read a single diagnostic and see every
    knob that affects security.
  * Tests can pin the configuration so a regression in any default
    fails the suite.

The module is deliberately *informational*. It does not enforce. The
only enforcement is at startup: when ``SPIRE_FIPS_MODE=1`` is set, the
process refuses to boot if a non-FIPS algorithm is configured anywhere
in the security path.

STIG-friendly defaults this module documents (and the middleware
applies):

  HTTP response headers:
    Strict-Transport-Security    max-age=31536000; includeSubDomains
    X-Content-Type-Options       nosniff
    X-Frame-Options              DENY
    Referrer-Policy              strict-origin-when-cross-origin
    Permissions-Policy           minimal allowlist
    Content-Security-Policy      tight (no inline JS, frame-ancestors none)

  Cookie defaults (for SPIRE-issued session cookies):
    HttpOnly                     always
    Secure                       SPIRE_SESSION_SECURE=1 → on (default off for dev)
    SameSite                     lax (production CAC mode → strict)

  Auth mode defaults:
    SPIRE_AUTH_MODE              mock (PIN demo)  /  cac (production)  /  hybrid
    SPIRE_CAC_REVOCATION_MODE    skip → ocsp / crl in production

  Audit chain:
    SHA-256 hash chain           always on
    Ed25519 signing              when SPIRE_AUDIT_SIGNING_KEY_PATH set
"""
from __future__ import annotations

import os
import sys
import hashlib
import logging
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional


log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Mode selectors
# ---------------------------------------------------------------------------


def fips_mode() -> bool:
    """True when SPIRE_FIPS_MODE=1.

    When True, the startup self-check (:func:`assert_fips_safe_config`)
    refuses to boot if any non-FIPS algorithm is configured. The flag
    is informational at runtime — runtime FIPS enforcement is the
    underlying OpenSSL FIPS provider's job, not SPIRE's.
    """
    return (os.environ.get("SPIRE_FIPS_MODE") or "").strip() == "1"


def profile() -> str:
    """Deployment profile. ``event`` is the assessed-event stance: everything
    enforcing, nothing phoning home, and a refusal to boot if any of that is
    missing. Anything else is the permissive default used for development
    and demos."""
    return (os.environ.get("SPIRE_PROFILE") or "").strip().lower()


def event_profile() -> bool:
    return profile() == "event"


def _egress_enforced() -> bool:
    return (os.environ.get("SPIRE_EGRESS_ENFORCE") or "").strip().lower() in ("1", "true", "yes")


def fips_mode_assumed() -> bool:
    """Test override: SPIRE_FIPS_MODE_ASSUME=1 makes the runtime probe
    return True even on a non-FIPS host. Lets the security-posture tests
    exercise the FIPS path on a developer laptop."""
    return (os.environ.get("SPIRE_FIPS_MODE_ASSUME") or "").strip() == "1"


# ---------------------------------------------------------------------------
# FIPS approved-algorithm allowlist
# ---------------------------------------------------------------------------


# FIPS 140-3 / 186-5 approved algorithms SPIRE may use in security paths.
# This is the allowlist — anything outside it is a hard fail when
# SPIRE_FIPS_MODE=1.
FIPS_APPROVED_HASHES = frozenset({
    "sha224", "sha256", "sha384", "sha512",
    "sha3_224", "sha3_256", "sha3_384", "sha3_512",
})

FIPS_APPROVED_HMAC = frozenset({
    "sha224", "sha256", "sha384", "sha512",
    "sha3_224", "sha3_256", "sha3_384", "sha3_512",
})

# Ed25519 is FIPS-approved per FIPS 186-5 (Feb 2023). RSA and ECDSA
# are approved across earlier publications.
FIPS_APPROVED_SIGNATURE = frozenset({
    "rsa", "ecdsa", "ed25519",
})


# ---------------------------------------------------------------------------
# Posture probe
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CryptoPosture:
    """Snapshot of the crypto choices SPIRE makes."""

    audit_chain_hash: str = "sha256"
    audit_signing_algorithm: str = "ed25519"
    session_cookie_hmac: str = "sha256"
    cac_chain_validation: str = "rsa+ecdsa+ed25519"
    sentry_export_bundle_hash: str = "sha256"


@dataclass(frozen=True)
class CookiePosture:
    """How SPIRE issues its own session cookies."""

    httponly: bool
    secure: bool
    samesite: str


@dataclass(frozen=True)
class HeaderPosture:
    """Which security headers the middleware adds to every response."""

    strict_transport_security: bool
    x_content_type_options: bool
    x_frame_options: bool
    referrer_policy: bool
    permissions_policy: bool
    content_security_policy: bool


@dataclass(frozen=True)
class SecurityPosture:
    """Full diagnostic snapshot."""

    fips_mode: bool
    fips_mode_assumed: bool
    profile: str
    auth_mode: str
    cac_revocation_mode: str
    audit_signing_enabled: bool
    audit_chain_pin_path: Optional[str]
    crypto: CryptoPosture
    cookie: CookiePosture
    headers: HeaderPosture

    def to_dict(self) -> Dict[str, Any]:
        return {
            "fips_mode": self.fips_mode,
            "fips_mode_assumed": self.fips_mode_assumed,
            "profile": self.profile,
            "auth_mode": self.auth_mode,
            "cac_revocation_mode": self.cac_revocation_mode,
            "audit_signing_enabled": self.audit_signing_enabled,
            "audit_chain_pin_path": self.audit_chain_pin_path,
            "crypto": asdict(self.crypto),
            "cookie": asdict(self.cookie),
            "headers": asdict(self.headers),
        }


def _audit_signing_enabled() -> bool:
    """True when an Ed25519 signing key is configured for the audit chain."""
    return bool(
        (os.environ.get("SPIRE_AUDIT_SIGNING_KEY_PATH") or "").strip()
        or (os.environ.get("SPIRE_AUDIT_SIGNING_KEY_HEX") or "").strip()
    )


def _cookie_posture() -> CookiePosture:
    # Secure by default (matches backend.auth._cookie_secure); only an explicit
    # SPIRE_SESSION_SECURE=0 turns it off for a plain-HTTP deploy.
    secure = (os.environ.get("SPIRE_SESSION_SECURE") or "1").strip() != "0"
    # SameSite is lax in dev for cross-port testing; production CAC
    # mode tightens to strict. We surface whatever the operator set.
    samesite = (os.environ.get("SPIRE_SESSION_SAMESITE") or "lax").strip().lower()
    if samesite not in {"lax", "strict", "none"}:
        samesite = "lax"
    return CookiePosture(httponly=True, secure=secure, samesite=samesite)


def _header_posture() -> HeaderPosture:
    """Which headers the middleware will emit. Today it emits all of
    them when STIG-headers are enabled (default on)."""
    enabled = (os.environ.get("SPIRE_STIG_HEADERS") or "1").strip() == "1"
    return HeaderPosture(
        strict_transport_security=enabled,
        x_content_type_options=enabled,
        x_frame_options=enabled,
        referrer_policy=enabled,
        permissions_policy=enabled,
        content_security_policy=enabled,
    )


def posture_status() -> SecurityPosture:
    """Build the full security posture snapshot from current env."""
    # Local imports — these modules pull in sibling SPIRE state and
    # we don't want a dependency loop at module import time.
    try:
        from . import cac_auth
        auth_mode = cac_auth.auth_mode()
        cac_revocation_mode = cac_auth.revocation_mode()
    except Exception:  # noqa: BLE001
        auth_mode = "mock"
        cac_revocation_mode = "skip"

    return SecurityPosture(
        fips_mode=fips_mode(),
        fips_mode_assumed=fips_mode_assumed(),
        profile=profile() or "default",
        auth_mode=auth_mode,
        cac_revocation_mode=cac_revocation_mode,
        audit_signing_enabled=_audit_signing_enabled(),
        audit_chain_pin_path=(os.environ.get("SPIRE_AUDIT_PIN_PATH") or None),
        crypto=CryptoPosture(),
        cookie=_cookie_posture(),
        headers=_header_posture(),
    )


# ---------------------------------------------------------------------------
# Startup self-check
# ---------------------------------------------------------------------------


class FipsConfigViolation(RuntimeError):
    """Raised at startup when SPIRE_FIPS_MODE=1 conflicts with a
    configured non-FIPS algorithm. The process should not boot —
    a misconfigured FIPS deployment is worse than an obviously-mock one.
    """


class EventProfileViolation(RuntimeError):
    """Raised at startup when SPIRE_PROFILE=event but the enforcing posture is
    not actually configured. An event build that silently downgrades to the
    demo posture is the failure mode this whole profile exists to prevent."""


def _cors_wildcard() -> bool:
    origins = os.environ.get("SPIRE_CORS_ORIGINS")
    if origins is None:
        return False  # the built-in default is an explicit dev allowlist
    return any(o.strip() in ("*", ".*") for o in origins.split(","))


def assert_event_profile() -> None:
    """Fail-fast validation of the assessed-event posture (WI-3).

    Every check here corresponds to a claim the event build makes about itself.
    A missing one is a misconfiguration, and a misconfigured enforcing build is
    worse than an obviously-permissive one: nobody goes looking for the gap.
    """
    if not event_profile():
        return

    violations: List[str] = []

    if not _egress_enforced():
        violations.append("SPIRE_EGRESS_ENFORCE is not 1 (egress must deny, not monitor)")

    auth_mode = (os.environ.get("SPIRE_AUTH_MODE") or "mock").strip().lower()
    if auth_mode == "mock":
        violations.append("SPIRE_AUTH_MODE=mock (set cac or hybrid)")

    if not (os.environ.get("SPIRE_SESSION_SECRET") or "").strip():
        violations.append("SPIRE_SESSION_SECRET is unset (sessions would use an ephemeral key)")

    if not _audit_signing_enabled():
        violations.append(
            "audit signing key unset (set SPIRE_AUDIT_SIGNING_KEY_PATH or "
            "SPIRE_AUDIT_SIGNING_KEY_HEX)"
        )

    if (os.environ.get("SPIRE_GITHUB_TOKEN") or "").strip():
        violations.append("SPIRE_GITHUB_TOKEN is set (feedback phone-home must be off)")

    if (os.environ.get("SPIRE_LLM_PRIMARY_DISABLE") or "1").strip().lower() not in ("1", "true", "yes"):
        violations.append("SPIRE_LLM_PRIMARY_DISABLE is not 1 (hosted LLM egress must be off)")

    if _cors_wildcard():
        violations.append("SPIRE_CORS_ORIGINS contains a wildcard (use an explicit allowlist)")

    if violations:
        raise EventProfileViolation(
            "SPIRE_PROFILE=event startup self-check failed; refusing to boot.\n"
            + "\n".join(f"  - {v}" for v in violations)
        )

    log.info("[security-posture] event profile self-check passed; auth_mode=%s", auth_mode)


def fips_runtime_status() -> Dict[str, Any]:
    """Whether the crypto backend is *actually* running in FIPS mode — not just
    whether SPIRE_FIPS_MODE was requested.

    This is the check that catches the common trap: a pip-installed
    `cryptography` wheel bundles its own (non-FIPS) OpenSSL, so an operator can
    set SPIRE_FIPS_MODE=1 and still be running unvalidated crypto. The kernel
    flag at /proc/sys/crypto/fips_enabled is authoritative on RHEL/UBI9;
    OPENSSL_FORCE_FIPS_MODE is Red Hat's testing-only forcing knob.
    """
    kernel = False
    try:
        kernel = Path("/proc/sys/crypto/fips_enabled").read_text().strip() == "1"
    except OSError:
        kernel = False  # not Linux / file absent → not in kernel FIPS mode
    forced = (os.environ.get("OPENSSL_FORCE_FIPS_MODE") or "").strip().lower() in ("1", "true", "yes")
    return {
        "kernel_fips_enabled": kernel,
        "openssl_forced": forced,
        "active": kernel or forced,
    }


def assert_fips_safe_config() -> None:
    """When SPIRE_FIPS_MODE=1, verify every configured algorithm is on
    the FIPS allowlist. Idempotent — call once at startup. Raises
    :class:`FipsConfigViolation` on any violation.

    Soft mode (FIPS_MODE off): logs a one-line summary of the posture
    and returns. No assertions.
    """
    posture = posture_status()
    if not posture.fips_mode:
        log.info(
            "[security-posture] auth_mode=%s audit_signing=%s cookie_secure=%s "
            "stig_headers=%s",
            posture.auth_mode,
            posture.audit_signing_enabled,
            posture.cookie.secure,
            posture.headers.x_frame_options,
        )
        return

    violations: List[str] = []

    if posture.crypto.audit_chain_hash not in FIPS_APPROVED_HASHES:
        violations.append(
            f"audit_chain_hash={posture.crypto.audit_chain_hash} not in "
            f"FIPS_APPROVED_HASHES"
        )
    if posture.crypto.session_cookie_hmac not in FIPS_APPROVED_HMAC:
        violations.append(
            f"session_cookie_hmac={posture.crypto.session_cookie_hmac} not in "
            f"FIPS_APPROVED_HMAC"
        )
    if posture.crypto.audit_signing_algorithm not in FIPS_APPROVED_SIGNATURE:
        violations.append(
            f"audit_signing_algorithm={posture.crypto.audit_signing_algorithm} "
            f"not in FIPS_APPROVED_SIGNATURE"
        )
    if posture.crypto.sentry_export_bundle_hash not in FIPS_APPROVED_HASHES:
        violations.append(
            f"sentry_export_bundle_hash={posture.crypto.sentry_export_bundle_hash} "
            f"not in FIPS_APPROVED_HASHES"
        )

    # Cookies: production FIPS deployment must have Secure on.
    if not posture.cookie.secure:
        violations.append(
            "session cookie Secure flag is OFF (set SPIRE_SESSION_SECURE=1)"
        )

    # CAC mode: revocation must not be 'skip' under FIPS.
    if posture.auth_mode in {"cac", "hybrid"} and posture.cac_revocation_mode == "skip":
        violations.append(
            f"auth_mode={posture.auth_mode} but SPIRE_CAC_REVOCATION_MODE=skip "
            f"(must be ocsp or crl)"
        )

    # Runtime FIPS engagement: the algorithms above being FIPS-approved is
    # necessary but NOT sufficient — the crypto backend must actually be running
    # in FIPS mode (validated OpenSSL provider). Fail closed unless the operator
    # explicitly opts into config-only testing.
    rt = fips_runtime_status()
    allow_unverified = (os.environ.get("SPIRE_FIPS_ALLOW_UNVERIFIED") or "").strip().lower() in ("1", "true", "yes")
    if not rt["active"] and not allow_unverified:
        violations.append(
            "SPIRE_FIPS_MODE=1 but the crypto backend is NOT in FIPS mode "
            "(/proc/sys/crypto/fips_enabled=0 and OPENSSL_FORCE_FIPS_MODE unset). "
            "Boot on a FIPS-enabled host (or the Dockerfile.fips image), or set "
            "SPIRE_FIPS_ALLOW_UNVERIFIED=1 for config-only testing."
        )

    if violations:
        msg = (
            "FIPS-mode startup self-check failed; refusing to boot.\n"
            + "\n".join(f"  - {v}" for v in violations)
        )
        raise FipsConfigViolation(msg)

    log.info(
        "[security-posture] FIPS-mode self-check passed; auth_mode=%s "
        "cac_revocation=%s audit_signing=%s",
        posture.auth_mode, posture.cac_revocation_mode, posture.audit_signing_enabled,
    )


# ---------------------------------------------------------------------------
# HTTP security headers middleware
# ---------------------------------------------------------------------------


# Tight CSP: no inline JS, no eval, no third-party scripts. Frontend is
# bundled by Vite into hashed assets that load from /assets/ on the
# same origin. MapLibre tiles come from a configurable origin (by
# default CartoDB's basemaps) — operators set SPIRE_TILE_ORIGIN to
# extend connect-src and img-src for offline-tile deployments.
def _csp_value() -> str:
    tile_origin = (os.environ.get("SPIRE_TILE_ORIGIN") or "").strip()
    extra = f" {tile_origin}" if tile_origin else ""
    # CartoDB serves the style.json from the APEX (basemaps.cartocdn.com) while
    # tiles/sprites/glyphs come off subdomains (a/b/c.basemaps...). CSP
    # wildcards don't cover the apex, so both must be listed or the online
    # BASTION map fails to load its style. When egress is enforced there is no
    # online basemap by definition, so the policy drops them entirely — the
    # header should not advertise a hole the deployment does not use.
    carto = "" if _egress_enforced() else (
        " https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com"
    )
    return (
        "default-src 'self'; "
        f"img-src 'self' data: blob:{carto}{extra}; "
        f"connect-src 'self'{carto}{extra}; "
        "script-src 'self'; "
        "worker-src 'self' blob:; "  # MapLibre GL spawns its render worker from a blob: URL
        "style-src 'self' 'unsafe-inline'; "  # Vite injects style tags; safe
        "font-src 'self' data:; "
        "frame-ancestors 'none'; "
        "form-action 'self'; "
        "base-uri 'self'"
    )


def security_headers_middleware_factory():
    """Return an ASGI middleware that stamps STIG-friendly security
    headers on every response. Returns None when SPIRE_STIG_HEADERS=0
    (operator opted out for a debugging session)."""
    if (os.environ.get("SPIRE_STIG_HEADERS") or "1").strip() != "1":
        return None

    csp = _csp_value()
    # HSTS only makes sense over TLS; it tracks the Secure-cookie setting, which
    # is on by default and turned off only for a plain-HTTP deploy.
    secure = (os.environ.get("SPIRE_SESSION_SECURE") or "1").strip() != "0"

    async def add_security_headers(request, call_next):
        response = await call_next(request)
        # Always-safe headers.
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault(
            "Referrer-Policy", "strict-origin-when-cross-origin"
        )
        response.headers.setdefault(
            "Permissions-Policy",
            "geolocation=(), microphone=(), camera=(), payment=(), usb=()",
        )
        response.headers.setdefault("Content-Security-Policy", csp)
        # HSTS only when TLS is in play. Setting it without HTTPS
        # would lock browsers to a non-existent secure origin.
        if secure:
            response.headers.setdefault(
                "Strict-Transport-Security",
                "max-age=31536000; includeSubDomains",
            )
        return response

    return add_security_headers
