"""
CAC/PIV cert-based authentication scaffolding (UIS-P6.1).

The existing :mod:`backend.auth` flow (DODID + 6-digit PIN) is demo-grade — it
simulates the cert-selection UX without validating any real PKI. This module
adds production-shape code for the actual smartcard path: the TLS-terminating
proxy holds the mTLS handshake, the operator's CAC unlocks its private key
on-card via PIN, the proxy forwards the resulting client certificate to SPIRE
in a trusted header, and SPIRE validates the chain, extracts the EDIPI, and
binds the cert to a session.

The PIN itself never reaches SPIRE. PIN entry happens against the smartcard
(PKCS#11 / Windows CSP / browser middleware) before the TLS handshake even
begins. What SPIRE sees is just the resulting client certificate.

Auth modes (env: ``SPIRE_AUTH_MODE``):
  - ``mock``   — current default; PIN-based mock auth, no PKI. The cert
                 endpoint is still mounted but rejects all callers.
  - ``cac``    — require valid CAC cert; the PIN endpoint is disabled
                 (returns 410 Gone with a redirect hint).
  - ``hybrid`` — accept either. CAC is preferred when both are present;
                 PIN remains as a break-glass / CAC-reader-down fallback.
                 Audit log records which path each session used.

Trust anchors (env: ``SPIRE_CAC_TRUST_DIR``):
  - Directory of PEM-encoded DoD root + intermediate CAs. Defaults to
    ``backend/cac_trust/`` which ships empty (.gitkeep + README only).
  - Production deployments drop the DoD bundle in. Tests inject a fixture
    CA via :func:`set_trust_anchors_for_testing`.

Revocation (env: ``SPIRE_CAC_REVOCATION_MODE``):
  - ``ocsp`` — live OCSP responder check (requires egress; not IL5-air-gap)
  - ``crl``  — local CRL cache, refreshed out-of-band via cron
  - ``skip`` — no revocation check (test-only; logs a WARN on every auth)

Cert forwarding scheme (mTLS-terminating proxy):
  - Header ``X-Client-Cert``: URL-encoded PEM (nginx
    ``$ssl_client_escaped_cert``)
  - Header ``X-SSL-Client-Cert``: PEM with newlines preserved (Apache
    ``mod_ssl`` style)
  - ASGI scope ``extensions.tls.client_cert``: PEM bytes when uvicorn does
    its own TLS termination

EDIPI extraction:
  - DoD CAC certs carry the EDIPI in the subject CN, e.g.
    ``REYES.MARCUS.X.1234567890`` — the trailing 10-digit segment.
  - PIV cards carry the FASC-N in the SAN ``otherName`` field
    (OID 1.2.840.113549.1.9.16.2.4); the EDIPI is bytes 4–13 of the
    decoded FASC-N. We currently parse only the CN form; FASC-N decode
    is left as a TODO marker for the FIPS pass (P6.2).

This is a SCAFFOLD. The endpoint is mounted, the validation path runs
end-to-end against fixture certs, and the audit chain logs every CAC
authentication attempt with its outcome reason. Wiring a production DoD
PKI bundle + OCSP responder is a deployment task, not a code task.
"""
from __future__ import annotations

import logging
import os
import re
import threading
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, List, Optional, Tuple


log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Mode selector
# ---------------------------------------------------------------------------

AUTH_MODE_MOCK = "mock"
AUTH_MODE_CAC = "cac"
AUTH_MODE_HYBRID = "hybrid"
_VALID_MODES = frozenset({AUTH_MODE_MOCK, AUTH_MODE_CAC, AUTH_MODE_HYBRID})


def auth_mode() -> str:
    """Return the active auth mode. Unknown values fall back to mock with a
    one-time warning so a typo in deployment config never silently disables
    auth gating."""
    raw = (os.environ.get("SPIRE_AUTH_MODE") or AUTH_MODE_MOCK).strip().lower()
    if raw not in _VALID_MODES:
        log.warning("SPIRE_AUTH_MODE=%r unknown; falling back to %r", raw, AUTH_MODE_MOCK)
        return AUTH_MODE_MOCK
    return raw


def cac_required() -> bool:
    return auth_mode() == AUTH_MODE_CAC


def pin_path_disabled() -> bool:
    """When True, ``/api/auth/login`` (the PIN endpoint) returns 410. Hybrid
    keeps PIN open as a break-glass path."""
    return auth_mode() == AUTH_MODE_CAC


def revocation_mode() -> str:
    raw = (os.environ.get("SPIRE_CAC_REVOCATION_MODE") or "skip").strip().lower()
    if raw not in {"ocsp", "crl", "skip"}:
        log.warning("SPIRE_CAC_REVOCATION_MODE=%r unknown; falling back to skip", raw)
        return "skip"
    return raw


# ---------------------------------------------------------------------------
# Result dataclasses
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CacCertInfo:
    """Subset of a CAC/PIV cert SPIRE actually consumes. Built from
    :class:`cryptography.x509.Certificate` so the rest of the codebase
    doesn't need to import x509 directly."""

    edipi: Optional[str]            # 10-digit DODID extracted from CN
    subject_cn: str
    issuer_cn: str
    serial_hex: str                 # uppercase hex, no 0x, no leading zeros stripped
    not_before: datetime            # tz-aware UTC
    not_after: datetime             # tz-aware UTC
    email_san: Optional[str]


@dataclass(frozen=True)
class CacAuthResult:
    """Outcome of a single CAC authentication attempt. ``reason`` is the
    structured code persisted to the audit chain; ``message`` is the
    human-readable form for response bodies."""

    ok: bool
    reason: str       # ok | no_cert | malformed | expired | not_yet_valid | untrusted | revoked | no_edipi | edipi_unknown | mode_disabled
    message: str
    cert: Optional[CacCertInfo] = None
    user: Optional[dict] = None


# ---------------------------------------------------------------------------
# Trust anchor management
# ---------------------------------------------------------------------------


_TRUST_LOCK = threading.Lock()
_TRUST_CACHE: Optional[List[Any]] = None  # list[x509.Certificate]
_TRUST_CACHE_PATHS: Tuple[str, ...] = ()  # invalidates cache on dir change


def _default_trust_dir() -> Path:
    return Path(__file__).resolve().parent / "cac_trust"


def trust_dir() -> Path:
    raw = os.environ.get("SPIRE_CAC_TRUST_DIR", "").strip()
    return Path(raw) if raw else _default_trust_dir()


def _load_pem_certs_from_dir(directory: Path) -> List[Any]:
    """Load every PEM-encoded cert under ``directory`` (recursively).
    Tolerant: malformed files emit a WARN and are skipped, never raise.
    Returns an empty list when the directory does not exist."""
    try:
        from cryptography import x509
    except ImportError:
        log.error("cryptography library missing; CAC auth unavailable")
        return []

    if not directory.exists() or not directory.is_dir():
        return []

    certs: List[Any] = []
    for path in sorted(directory.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in {".pem", ".crt", ".cer"}:
            continue
        try:
            data = path.read_bytes()
            # A single file may contain multiple PEM blocks (DoD bundle pattern).
            for block in _split_pem_blocks(data):
                try:
                    certs.append(x509.load_pem_x509_certificate(block))
                except Exception as e:
                    log.warning("trust anchor parse failed for %s: %s", path, e)
        except OSError as e:
            log.warning("trust anchor read failed for %s: %s", path, e)
    return certs


_PEM_BLOCK_RE = re.compile(
    rb"-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----",
    re.DOTALL,
)


def _split_pem_blocks(data: bytes) -> Iterable[bytes]:
    return _PEM_BLOCK_RE.findall(data)


_TEST_OVERRIDE_KEY = ("__test_override__",)


def trust_anchors() -> List[Any]:
    """Cached load of trust anchors from :func:`trust_dir`. The cache key is
    the resolved directory path; changing ``SPIRE_CAC_TRUST_DIR`` between
    calls picks up the new bundle without a restart.

    A test override installed via :func:`set_trust_anchors_for_testing`
    is sticky — the override persists until :func:`reset_trust_anchor_cache`
    is called explicitly. Otherwise a follow-up env-var change would
    silently invalidate the test fixture mid-run."""
    global _TRUST_CACHE, _TRUST_CACHE_PATHS
    with _TRUST_LOCK:
        if _TRUST_CACHE_PATHS == _TEST_OVERRIDE_KEY and _TRUST_CACHE is not None:
            return _TRUST_CACHE
        directory = trust_dir()
        key = (str(directory),)
        if _TRUST_CACHE is not None and _TRUST_CACHE_PATHS == key:
            return _TRUST_CACHE
        certs = _load_pem_certs_from_dir(directory)
        _TRUST_CACHE = certs
        _TRUST_CACHE_PATHS = key
        return certs


def set_trust_anchors_for_testing(certs: List[Any]) -> None:
    """Override the trust anchor cache. Test-only — production code reads
    from disk via :func:`trust_dir`. The cache is reset to its env-driven
    state by :func:`reset_trust_anchor_cache`."""
    global _TRUST_CACHE, _TRUST_CACHE_PATHS
    with _TRUST_LOCK:
        _TRUST_CACHE = list(certs)
        _TRUST_CACHE_PATHS = _TEST_OVERRIDE_KEY


def reset_trust_anchor_cache() -> None:
    global _TRUST_CACHE, _TRUST_CACHE_PATHS
    with _TRUST_LOCK:
        _TRUST_CACHE = None
        _TRUST_CACHE_PATHS = ()


# ---------------------------------------------------------------------------
# Cert parsing + EDIPI extraction
# ---------------------------------------------------------------------------


# DoD CAC subject CN: LASTNAME.FIRSTNAME.X.EDIPI
# - LASTNAME / FIRSTNAME may contain hyphens, apostrophes, spaces in real data
# - X is the middle initial (sometimes absent — then there's no extra dot)
# - EDIPI is exactly 10 digits, anchored to end-of-string
# - Negative lookbehind for a digit so we reject CNs with 11+ trailing
#   digits — that shape is malformed and would silently match the last
#   10 digits otherwise, masking the corruption.
_EDIPI_RE = re.compile(r"(?<!\d)(?P<edipi>\d{10})\Z")


def extract_edipi_from_cn(cn: str) -> Optional[str]:
    """Pull the 10-digit EDIPI from a DoD CAC subject CN. Returns None when
    the CN does not end in a 10-digit run."""
    if not cn:
        return None
    m = _EDIPI_RE.search(cn.strip())
    return m.group("edipi") if m else None


def _cert_cn(name: Any) -> str:
    """Extract CN attribute from an x509.Name. Empty string when absent."""
    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID
    except ImportError:
        return ""
    try:
        attrs = name.get_attributes_for_oid(NameOID.COMMON_NAME)
    except Exception:
        return ""
    return attrs[0].value if attrs else ""


def _cert_email_san(cert: Any) -> Optional[str]:
    try:
        from cryptography import x509
    except ImportError:
        return None
    try:
        san_ext = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName)
    except Exception:
        return None
    try:
        emails = san_ext.value.get_values_for_type(x509.RFC822Name)
    except Exception:
        return None
    return emails[0] if emails else None


def parse_client_cert(pem_bytes: bytes) -> Optional[CacCertInfo]:
    """Parse a forwarded client cert PEM into the SPIRE-internal info shape.
    Returns None on any parse error — the caller maps that to the
    ``malformed`` reason code."""
    try:
        from cryptography import x509
    except ImportError:
        return None
    try:
        cert = x509.load_pem_x509_certificate(pem_bytes)
    except Exception:
        return None

    cn = _cert_cn(cert.subject)
    issuer_cn = _cert_cn(cert.issuer)
    edipi = extract_edipi_from_cn(cn)
    serial_hex = format(cert.serial_number, "X")
    nb = cert.not_valid_before_utc if hasattr(cert, "not_valid_before_utc") else cert.not_valid_before.replace(tzinfo=timezone.utc)
    na = cert.not_valid_after_utc if hasattr(cert, "not_valid_after_utc") else cert.not_valid_after.replace(tzinfo=timezone.utc)
    return CacCertInfo(
        edipi=edipi,
        subject_cn=cn,
        issuer_cn=issuer_cn,
        serial_hex=serial_hex,
        not_before=nb,
        not_after=na,
        email_san=_cert_email_san(cert),
    )


# ---------------------------------------------------------------------------
# Chain validation
# ---------------------------------------------------------------------------


def _verify_signed_by(child: Any, parent: Any) -> bool:
    """True iff ``child``'s signature verifies against ``parent``'s public
    key. Tolerates RSA + ECDSA + Ed25519. Any verify exception → False."""
    try:
        from cryptography.hazmat.primitives.asymmetric import padding, rsa, ec, ed25519
        from cryptography.exceptions import InvalidSignature
    except ImportError:
        return False
    try:
        pubkey = parent.public_key()
        sig = child.signature
        tbs = child.tbs_certificate_bytes
        sig_alg = child.signature_hash_algorithm
        if isinstance(pubkey, rsa.RSAPublicKey):
            pubkey.verify(sig, tbs, padding.PKCS1v15(), sig_alg)
        elif isinstance(pubkey, ec.EllipticCurvePublicKey):
            pubkey.verify(sig, tbs, ec.ECDSA(sig_alg))
        elif isinstance(pubkey, ed25519.Ed25519PublicKey):
            pubkey.verify(sig, tbs)
        else:
            return False
        return True
    except InvalidSignature:
        return False
    except Exception:
        return False


def validate_chain(cert: Any, anchors: Iterable[Any]) -> Tuple[bool, str]:
    """Walk back from ``cert`` through any anchors that look like
    intermediates until we find a self-signed root in the trust set.

    SCAFFOLD: this is a one-hop check (cert → trusted issuer). It does not
    yet handle path-length constraints, key-usage restrictions, name
    constraints, or policy mappings the real DoD PKI applies. Wiring
    ``cryptography.x509.verification.PolicyBuilder`` (added in
    cryptography 42+) is a follow-up — this layer exists so the rest of
    the auth path works against fixture certs today.
    """
    anchor_list = list(anchors)
    if not anchor_list:
        return False, "no_trust_anchors"
    for anchor in anchor_list:
        if cert.issuer == anchor.subject and _verify_signed_by(cert, anchor):
            return True, "ok"
    # Two-hop: try matching against intermediates that are themselves
    # signed by an anchor in the bundle.
    for inter in anchor_list:
        if cert.issuer != inter.subject:
            continue
        if not _verify_signed_by(cert, inter):
            continue
        for root in anchor_list:
            if inter.issuer == root.subject and _verify_signed_by(inter, root):
                return True, "ok"
    return False, "untrusted"


# ---------------------------------------------------------------------------
# Revocation (stub)
# ---------------------------------------------------------------------------


def check_revocation(cert: Any) -> Tuple[bool, str]:
    """Return (is_valid, reason). In ``skip`` mode this is unconditionally
    valid with a WARN — real deployments must set ``ocsp`` or ``crl``.

    The OCSP/CRL implementations are intentional stubs in this scaffold:
    OCSP needs egress to ``ocsp.disa.mil`` (forbidden in IL5 air-gap), and
    a working CRL cache requires deployment-time ops (``spire-cac-crl-refresh``
    cron + offline CRL bundle distribution). Both surfaces will land in
    P6.2 (FIPS-mode crypto) when the broader STIG pass picks them up.
    """
    mode = revocation_mode()
    if mode == "skip":
        log.warning("CAC revocation check skipped (SPIRE_CAC_REVOCATION_MODE=skip)")
        return True, "skipped"
    if mode in {"ocsp", "crl"}:
        # TODO(P6.2): implement live OCSP / CRL verify. Until then, a
        # configured-but-unimplemented mode hard-fails closed.
        log.error("CAC revocation mode %r is not implemented yet; rejecting auth", mode)
        return False, f"mode_{mode}_not_implemented"
    return False, "mode_unknown"


# ---------------------------------------------------------------------------
# Cert ingest from request
# ---------------------------------------------------------------------------


CAC_HEADER_URLENCODED = "x-client-cert"
CAC_HEADER_RAW = "x-ssl-client-cert"


def extract_forwarded_cert(headers: dict, scope_extensions: Optional[dict] = None) -> Optional[bytes]:
    """Pull the forwarded client cert PEM bytes from a request. Looks at,
    in order:
      1. ``X-Client-Cert`` (URL-encoded PEM, nginx-style)
      2. ``X-SSL-Client-Cert`` (PEM, Apache mod_ssl-style)
      3. ASGI scope ``extensions.tls.client_cert`` (uvicorn TLS termination)

    Returns None when no cert is present.
    """
    # Headers are case-insensitive; normalize.
    lower = {k.lower(): v for k, v in headers.items()}

    enc = lower.get(CAC_HEADER_URLENCODED)
    if enc:
        try:
            return urllib.parse.unquote(enc).encode("utf-8")
        except Exception:
            return None

    raw = lower.get(CAC_HEADER_RAW)
    if raw:
        # Apache forwards with newlines collapsed to spaces; some proxies
        # also strip the BEGIN/END framing. Restore both so the parser
        # accepts the result.
        return _restore_pem_framing(raw).encode("utf-8")

    if scope_extensions:
        tls = scope_extensions.get("tls") or {}
        client_cert = tls.get("client_cert")
        if isinstance(client_cert, (bytes, bytearray)):
            return bytes(client_cert)
        if isinstance(client_cert, str):
            return client_cert.encode("utf-8")

    return None


_BEGIN_MARKER = "-----BEGIN CERTIFICATE-----"
_END_MARKER = "-----END CERTIFICATE-----"


def _restore_pem_framing(value: str) -> str:
    """Apache ``mod_ssl`` SSL_CLIENT_CERT collapses newlines into single
    spaces. Restore line breaks and reattach the BEGIN/END framing if it
    was stripped.

    Tricky bit — the markers themselves contain a literal space ("BEGIN
    CERTIFICATE") so we cannot blindly replace every space with a
    newline; that would split "BEGIN" / "CERTIFICATE" mid-marker. Pull
    the markers out first, restore line breaks in the body only, then
    reassemble.
    """
    cleaned = value.strip()
    if _BEGIN_MARKER not in cleaned:
        body_only = cleaned.replace(" ", "\n").replace("\r", "")
        return f"{_BEGIN_MARKER}\n{body_only}\n{_END_MARKER}"

    begin_idx = cleaned.find(_BEGIN_MARKER)
    end_idx = cleaned.find(_END_MARKER)
    if end_idx == -1 or end_idx <= begin_idx:
        # Malformed — return as-is and let the parser reject it.
        return cleaned
    body = cleaned[begin_idx + len(_BEGIN_MARKER) : end_idx]
    body = body.strip().replace(" ", "\n").replace("\r", "")
    return f"{_BEGIN_MARKER}\n{body}\n{_END_MARKER}"


# ---------------------------------------------------------------------------
# End-to-end authenticate
# ---------------------------------------------------------------------------


def authenticate_cac(
    pem_bytes: bytes,
    *,
    user_lookup: Optional[Any] = None,
) -> CacAuthResult:
    """Validate a forwarded client cert and resolve it to a SPIRE user.

    Pipeline:
      1. parse PEM
      2. validate temporal window (not_before / not_after)
      3. validate chain against trust anchors
      4. check revocation (mode-driven; ``skip`` is permissive)
      5. extract EDIPI from subject CN
      6. resolve EDIPI → SPIRE user (default: MOCK_USERS_BY_DODID)

    ``user_lookup`` is a dict-like ``{edipi: user}`` for tests / future
    extensions where the user directory comes from a different source.
    """
    if cac_required() is False and auth_mode() == AUTH_MODE_MOCK:
        return CacAuthResult(
            ok=False,
            reason="mode_disabled",
            message="CAC authentication is disabled in mock mode.",
        )

    info = parse_client_cert(pem_bytes)
    if info is None:
        return CacAuthResult(ok=False, reason="malformed", message="Client certificate could not be parsed.")

    now = datetime.now(timezone.utc)
    if now < info.not_before:
        return CacAuthResult(ok=False, reason="not_yet_valid", message="Certificate is not yet valid.", cert=info)
    if now > info.not_after:
        return CacAuthResult(ok=False, reason="expired", message="Certificate has expired.", cert=info)

    # Chain validation requires the parsed x509 object, not just CacCertInfo.
    try:
        from cryptography import x509
        cert_obj = x509.load_pem_x509_certificate(pem_bytes)
    except Exception:
        return CacAuthResult(ok=False, reason="malformed", message="Client certificate could not be parsed.", cert=info)

    chain_ok, chain_reason = validate_chain(cert_obj, trust_anchors())
    if not chain_ok:
        return CacAuthResult(ok=False, reason="untrusted", message=f"Certificate chain rejected: {chain_reason}.", cert=info)

    rev_ok, rev_reason = check_revocation(cert_obj)
    if not rev_ok:
        return CacAuthResult(ok=False, reason="revoked", message=f"Certificate revocation check failed: {rev_reason}.", cert=info)

    if not info.edipi:
        return CacAuthResult(ok=False, reason="no_edipi", message="No EDIPI found in certificate subject.", cert=info)

    if user_lookup is None:
        # Imported here to avoid a circular import at module load.
        from .auth import MOCK_USERS_BY_DODID  # noqa: WPS433
        user_lookup = MOCK_USERS_BY_DODID

    user = user_lookup.get(info.edipi)
    if not user:
        return CacAuthResult(ok=False, reason="edipi_unknown", message="Certificate EDIPI is not provisioned in SPIRE.", cert=info)

    return CacAuthResult(ok=True, reason="ok", message="Authenticated.", cert=info, user=user)


# ---------------------------------------------------------------------------
# Audit hook
# ---------------------------------------------------------------------------


def audit_cac_attempt(result: CacAuthResult) -> None:
    """Best-effort audit chain entry for a CAC auth outcome. Never raises;
    auth must not fail because audit logging is degraded."""
    try:
        from . import persistence
    except Exception:
        return
    payload: dict[str, Any] = {
        "outcome": "ok" if result.ok else "denied",
        "reason": result.reason,
    }
    if result.cert is not None:
        payload["subject_cn"] = result.cert.subject_cn
        payload["issuer_cn"] = result.cert.issuer_cn
        payload["serial_hex"] = result.cert.serial_hex
        payload["edipi_masked"] = (
            ("***" + result.cert.edipi[-4:]) if result.cert.edipi else None
        )
        payload["not_after"] = result.cert.not_after.isoformat()
    actor = "anonymous"
    if result.user is not None:
        actor = result.user.get("dodid", "anonymous")
    try:
        persistence.log(
            kind="auth.cac",
            actor=actor,
            subject_id=result.cert.serial_hex if result.cert else "no_cert",
            payload=payload,
        )
    except Exception:  # noqa: BLE001
        log.exception("audit_cac_attempt failed; continuing")
