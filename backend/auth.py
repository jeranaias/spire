"""
CAC/PIV mock auth — identity foundation for SPIRE.

Demo-grade only: simulates the visual + UX of cert-selection from a four-up
"smartcard reader" without any real PKI. Sign-in writes an HMAC-signed
HttpOnly session cookie; the matching middleware (`session_middleware`)
hydrates `request.state.user` on every call and rejects unauthenticated
`/api/*` (excluding `/api/auth/*`) with 401.

The four mocked Marines exist in `MOCK_USERS` and represent the role
spectrum SPIRE currently scopes against: operator (G-4), maintenance chief,
security manager, MEF commander. All four are assigned to the pilot
customer named by slide 2 / AboutTeamView / TransitionView (3d MLR ·
CLB-Det · III MEF · MARFORPAC). Identity payload is the contract every
downstream lane reads — additions only, no renames.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sys
from time import time
from typing import Any, Optional
from urllib.parse import parse_qsl, urlencode

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Cookie / signing
# ---------------------------------------------------------------------------

SESSION_COOKIE_NAME = "spire_session"
SESSION_TTL_SECONDS = 12 * 3600  # 12-hour shift


_EPHEMERAL_SECRET: Optional[bytes] = None


def _session_secret() -> bytes:
    """Resolve the HMAC key for session signatures.

    Production deployments MUST set `SPIRE_SESSION_SECRET` in the environment.
    When it is unset we mint a per-process random key and warn loudly. The
    consequence in dev: any backend restart invalidates outstanding sessions
    and the operator is bounced back to the cert-selection screen — preferable
    to a hardcoded fallback that effectively shares signing material across
    every demo install.
    """
    global _EPHEMERAL_SECRET
    secret = os.environ.get("SPIRE_SESSION_SECRET")
    if secret:
        return secret.encode("utf-8")
    if _EPHEMERAL_SECRET is None:
        _EPHEMERAL_SECRET = secrets.token_bytes(32)
        print(
            "[SPIRE][auth] WARNING: SPIRE_SESSION_SECRET is not set — "
            "using a random per-process secret. Sessions will not survive "
            "backend restarts. Set SPIRE_SESSION_SECRET for stable sessions.",
            file=sys.stderr,
            flush=True,
        )
    return _EPHEMERAL_SECRET


def _b64u_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64u_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def sign_session(payload: dict[str, Any]) -> str:
    """Encode + HMAC-SHA256 sign a session payload. Returns `body.sig`."""
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    body_b64 = _b64u_encode(body)
    sig = hmac.new(_session_secret(), body_b64.encode("ascii"), hashlib.sha256).digest()
    return f"{body_b64}.{_b64u_encode(sig)}"


def verify_session(token: str) -> Optional[dict[str, Any]]:
    """Verify signature + TTL. Returns payload dict or None if invalid."""
    try:
        body_b64, sig_b64 = token.split(".", 1)
    except ValueError:
        return None
    try:
        expected = hmac.new(_session_secret(), body_b64.encode("ascii"), hashlib.sha256).digest()
        actual = _b64u_decode(sig_b64)
    except Exception:
        return None
    if not hmac.compare_digest(expected, actual):
        return None
    try:
        payload = json.loads(_b64u_decode(body_b64))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    if int(payload.get("exp", 0)) < int(time()):
        return None
    return payload


# ---------------------------------------------------------------------------
# Mock identities — the four cert "smartcards" the operator picks from.
# Field shape is the load-bearing contract for downstream lanes; additions
# are safe, renames break the world. Keep this in sync with
# `frontend/src/state/store.ts` `User`.
#
# Unit / parent_command values are constrained to the pilot-customer chain
# (CLB-Det → 3d MLR → 3d MarDiv → III MEF → MARFORPAC) that slide 2 names.
# `tests/test_identity_persona_alignment.py` enforces the chain; update
# both ends together when changing the customer.
# ---------------------------------------------------------------------------

MOCK_USERS: list[dict[str, Any]] = [
    {
        "dodid": "1234567890",
        "name": "GySgt Marcus Reyes",
        "first_name": "Marcus",
        "last_name": "Reyes",
        "rank": "GySgt",
        "rank_long": "Gunnery Sergeant",
        "billet": "Logistics Operator",
        "unit": "CLB-Det",
        "parent_command": "3d MLR",
        "branch": "USMC",
        "clearance": "CUI",
        "role": "g4",
        "initials": "MR",
        "cert_issuer": "DOD ID CA-59",
        # Cert serials reshaped to ~16-hex-digit, mixed case, no `0x` prefix —
        # the shape DEERS actually issues. Task #27 (auth-cac-splash F7).
        "cert_serial": "4A7f12C8e03B91a2",
        "cert_expires": "2027-08-14",
    },
    {
        "dodid": "2345678901",
        "name": "MSgt Diana Kowalski",
        "first_name": "Diana",
        "last_name": "Kowalski",
        "rank": "MSgt",
        "rank_long": "Master Sergeant",
        "billet": "Maintenance Chief",
        "unit": "CLB-Det",
        "parent_command": "3d MLR",
        "branch": "USMC",
        "clearance": "CUI",
        "role": "maintenance_chief",
        "initials": "DK",
        "cert_issuer": "DOD ID CA-59",
        "cert_serial": "6b19E04a8C7d2531",
        "cert_expires": "2026-11-02",
    },
    {
        "dodid": "3456789012",
        "name": "CWO3 James Park",
        "first_name": "James",
        "last_name": "Park",
        "rank": "CWO3",
        "rank_long": "Chief Warrant Officer 3",
        "billet": "Security Manager",
        "unit": "3d MLR",
        "parent_command": "3d MarDiv",
        "branch": "USMC",
        "clearance": "CUI",
        "role": "security_manager",
        "initials": "JP",
        "cert_issuer": "DOD ID SW-CA-66",
        "cert_serial": "8F02d971B4E6c0A8",
        "cert_expires": "2027-03-29",
    },
    {
        "dodid": "4567890123",
        "name": "MajGen Robert Hayes",
        "first_name": "Robert",
        "last_name": "Hayes",
        "rank": "MajGen",
        "rank_long": "Major General",
        "billet": "Commanding General",
        "unit": "III MEF",
        "parent_command": "MARFORPAC",
        "branch": "USMC",
        "clearance": "CUI",
        "role": "mef_commander",
        "initials": "RH",
        "cert_issuer": "DOD ID CA-59",
        "cert_serial": "C4a8B335E97f1D60",
        "cert_expires": "2028-01-17",
    },
]

# Fields a real CAC reader surfaces on the cert-selection screen — name,
# rank, branch, cert metadata, masked DODID, initials. Clearance, role,
# billet, unit, and parent_command are deliberately withheld from the
# unauthenticated `/api/auth/users` response so a passer-by glancing at
# the laptop (or an unauth API caller) cannot enumerate who holds TS//SCI
# vs SECRET, who's the security manager, etc. Those fields stay on the
# authenticated payloads (`/api/auth/me`, `/api/auth/login`, and the
# authenticated re-fetch of `/api/auth/users` the in-app identity
# switcher uses). Task #27 / auth-cac-splash F1.
_PUBLIC_USER_FIELDS = (
    "dodid",
    "name",
    "rank",
    "branch",
    "initials",
    "cert_issuer",
    "cert_serial",
    "cert_expires",
)


def _public_user(u: dict[str, Any]) -> dict[str, Any]:
    return {k: u[k] for k in _PUBLIC_USER_FIELDS if k in u}

MOCK_USERS_BY_DODID: dict[str, dict[str, Any]] = {u["dodid"]: u for u in MOCK_USERS}


# ---------------------------------------------------------------------------
# Auth router — /api/auth/*
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    dodid: str
    pin: str


router = APIRouter()


@router.get("/users")
def list_users(request: Request) -> dict[str, Any]:
    """Cert-selection screen reads this to populate the four smartcards.

    OPSEC: when the caller is unauthenticated (the normal case at the
    splash) we return only the fields a real CAC reader surfaces — name,
    rank, branch, masked DODID, initials, cert metadata. Clearance,
    role, billet, unit, and parent_command are stripped so a passer-by
    glancing at the laptop or an unauth API caller cannot infer who
    holds which clearance / billet. Authenticated callers (the in-app
    identity switcher in the topbar) get the full directory because
    they've already cleared the auth gate. See task #27 / F1.
    """
    user = getattr(request.state, "user", None)
    if user is not None:
        return {"users": MOCK_USERS}
    return {"users": [_public_user(u) for u in MOCK_USERS]}


@router.post("/login")
def login(req: LoginRequest, response: Response) -> dict[str, Any]:
    # When SPIRE_AUTH_MODE=cac the PIN endpoint hard-closes — every session
    # MUST come through the cert path. The frontend redirects to the CAC
    # screen on a 410 response.
    from . import cac_auth  # local import; cac_auth imports MOCK_USERS_BY_DODID
    if cac_auth.pin_path_disabled():
        raise HTTPException(
            status_code=410,
            detail="pin_path_disabled",
            headers={"X-Spire-Auth-Mode": cac_auth.auth_mode()},
        )
    user = MOCK_USERS_BY_DODID.get(req.dodid)
    if not user:
        raise HTTPException(status_code=404, detail="cert_not_found")
    # UI illusion — any 6-digit numeric PIN clears. No real PKI / OCSP.
    pin = (req.pin or "").strip()
    if len(pin) != 6 or not pin.isdigit():
        raise HTTPException(status_code=400, detail="invalid_pin")

    issued = int(time())
    payload = {
        "dodid": user["dodid"],
        "iat": issued,
        "exp": issued + SESSION_TTL_SECONDS,
        # `jti` lets us spot replay in the audit log even though we don't
        # currently maintain a server-side revocation list.
        "jti": secrets.token_hex(8),
        "auth_path": "pin",
    }
    token = sign_session(payload)
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        httponly=True,
        samesite="lax",
        max_age=SESSION_TTL_SECONDS,
        path="/",
        # secure=False so the cookie works over plain HTTP in dev. Behind a
        # TLS-terminating proxy in real deployments, set `SPIRE_SESSION_SECURE=1`.
        secure=os.environ.get("SPIRE_SESSION_SECURE", "0") == "1",
    )
    return {"ok": True, "user": user, "expires_at": payload["exp"]}


@router.post("/cac")
def cac_login(request: Request, response: Response) -> dict[str, Any]:
    """Cert-based sign-in. The TLS-terminating proxy handles the mTLS
    handshake and forwards the client cert PEM in ``X-Client-Cert`` (URL-
    encoded) or ``X-SSL-Client-Cert`` (raw PEM). On valid cert + EDIPI
    match, mints the same session cookie shape as ``/login`` so every
    downstream gate (middleware, role guards, audit chain) treats CAC and
    PIN sessions identically.

    Audit semantics: every attempt — success or failure — emits an
    ``auth.cac`` chain entry with the structured rejection reason and
    masked EDIPI. Operators can reconcile lockouts and probe attempts
    from the audit log alone.
    """
    from . import cac_auth  # local import keeps module load order tidy

    mode = cac_auth.auth_mode()
    if mode == cac_auth.AUTH_MODE_MOCK:
        # CAC endpoint is mounted but inert in mock mode so frontend
        # capability probes get a stable 410 instead of a 500.
        raise HTTPException(
            status_code=410,
            detail="cac_disabled_in_mock_mode",
            headers={"X-Spire-Auth-Mode": mode},
        )

    pem = cac_auth.extract_forwarded_cert(
        dict(request.headers),
        scope_extensions=request.scope.get("extensions"),
    )
    if not pem:
        result = cac_auth.CacAuthResult(
            ok=False,
            reason="no_cert",
            message="No client certificate forwarded by the TLS proxy.",
        )
        cac_auth.audit_cac_attempt(result)
        raise HTTPException(
            status_code=401,
            detail={"reason": result.reason, "message": result.message},
            headers={"X-Spire-Auth-Mode": mode},
        )

    result = cac_auth.authenticate_cac(pem)
    cac_auth.audit_cac_attempt(result)
    if not result.ok or result.user is None:
        raise HTTPException(
            status_code=401,
            detail={"reason": result.reason, "message": result.message},
            headers={"X-Spire-Auth-Mode": mode},
        )

    issued = int(time())
    payload = {
        "dodid": result.user["dodid"],
        "iat": issued,
        "exp": issued + SESSION_TTL_SECONDS,
        "jti": secrets.token_hex(8),
        "auth_path": "cac",
        "cert_serial": result.cert.serial_hex if result.cert else None,
    }
    token = sign_session(payload)
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        httponly=True,
        samesite="lax",
        max_age=SESSION_TTL_SECONDS,
        path="/",
        secure=os.environ.get("SPIRE_SESSION_SECURE", "0") == "1",
    )
    return {
        "ok": True,
        "user": result.user,
        "expires_at": payload["exp"],
        "auth_path": "cac",
        "cert": {
            "subject_cn": result.cert.subject_cn if result.cert else None,
            "issuer_cn": result.cert.issuer_cn if result.cert else None,
            "serial_hex": result.cert.serial_hex if result.cert else None,
            "not_after": result.cert.not_after.isoformat() if result.cert else None,
        },
    }


@router.get("/mode")
def auth_mode_info() -> dict[str, Any]:
    """Capability probe so the splash UI knows whether to show the PIN
    form (mock / hybrid) or jump straight to a cert prompt (cac)."""
    from . import cac_auth
    mode = cac_auth.auth_mode()
    return {
        "mode": mode,
        "pin_enabled": not cac_auth.pin_path_disabled(),
        "cac_enabled": mode in {cac_auth.AUTH_MODE_CAC, cac_auth.AUTH_MODE_HYBRID},
        "trust_anchors_loaded": len(cac_auth.trust_anchors()),
        "revocation_mode": cac_auth.revocation_mode(),
    }


@router.post("/logout")
def logout(response: Response) -> dict[str, Any]:
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me")
def me(request: Request) -> dict[str, Any]:
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="unauthenticated")
    return {"user": user}


# ---------------------------------------------------------------------------
# MDM 2026 stage-pivot — additive quick-switch endpoint.
#
# Re-issues a session cookie for a different mock identity WITHOUT
# requiring a PIN re-entry. Used only by the on-stage IdentityPill in
# `stageMode` so the presenter can swap CAC identity in one click.
#
# Hardening:
#   • Gated by env var `SPIRE_DEMO_QUICK_SWITCH=1`. Disabled (404) by
#     default, so production / non-stage deploys never expose the path.
#   • DODID must already exist in MOCK_USERS (no on-the-fly user
#     creation; the four cert identities are the only valid targets).
#   • Same cookie attributes as `/login` so a quick-switched session is
#     indistinguishable on the wire from one that came through PIN entry.
#   • Middleware is unchanged — this is router-only, additive code.
# ---------------------------------------------------------------------------


class QuickSwitchRequest(BaseModel):
    dodid: str


def _quick_switch_enabled() -> bool:
    return os.environ.get("SPIRE_DEMO_QUICK_SWITCH", "0") == "1"


@router.post("/quick-switch")
def quick_switch(req: QuickSwitchRequest, request: Request, response: Response) -> dict[str, Any]:
    if not _quick_switch_enabled():
        raise HTTPException(status_code=404, detail="quick_switch_disabled")
    # SECURITY: require an EXISTING authenticated session before re-issuing
    # a cookie for any other identity. Without this gate, an unauthenticated
    # caller could mint a valid session for any mock user just by knowing
    # the env var was on. The session middleware already populates
    # `request.state.user` from the signed cookie; if it is None the
    # caller is not currently signed in and we refuse the swap.
    current = getattr(request.state, "user", None)
    if not current:
        raise HTTPException(status_code=401, detail="quick_switch_requires_session")
    user = MOCK_USERS_BY_DODID.get(req.dodid)
    if not user:
        raise HTTPException(status_code=404, detail="cert_not_found")
    issued = int(time())
    payload = {
        "dodid": user["dodid"],
        "iat": issued,
        "exp": issued + SESSION_TTL_SECONDS,
        "jti": secrets.token_hex(8),
    }
    token = sign_session(payload)
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        httponly=True,
        samesite="lax",
        max_age=SESSION_TTL_SECONDS,
        path="/",
        secure=os.environ.get("SPIRE_SESSION_SECURE", "0") == "1",
    )
    return {"ok": True, "user": user, "expires_at": payload["exp"]}


# ---------------------------------------------------------------------------
# Middleware
# ---------------------------------------------------------------------------

# Path predicates — kept tight so we don't accidentally open a backend
# surface. Static asset paths (mounted under `/assets`, `/favicon.svg`,
# `/`) are always open. Everything under `/api/` requires auth EXCEPT
# the `/api/auth/*` cluster (the means of getting a session) and the
# bare `/api/system/status` health-discovery endpoint that container
# healthchecks + uptime probes hit before any session exists.
_OPEN_API_PREFIXES = ("/api/auth/",)
_OPEN_API_EXACT = frozenset({"/api/system/status"})


def _is_protected_api(path: str) -> bool:
    if not path.startswith("/api/"):
        return False
    if path in _OPEN_API_EXACT:
        return False
    for prefix in _OPEN_API_PREFIXES:
        if path.startswith(prefix):
            return False
    return True


def resolve_user_from_request(request: Request) -> Optional[dict[str, Any]]:
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        return None
    payload = verify_session(token)
    if not payload:
        return None
    return MOCK_USERS_BY_DODID.get(str(payload.get("dodid", "")))


def session_role(request: Request) -> Optional[str]:
    """Authoritative role for the current request, taken from the signed
    session. Routes MUST prefer this over any client-supplied `role` /
    `actor_role` field in query strings or payloads.
    """
    user = getattr(request.state, "user", None)
    if not user:
        return None
    return user.get("role")


def _override_query_role(scope: dict, role: str) -> None:
    """Strip any client-supplied `role` from the query string and replace
    it with the authenticated session role. Existing handlers that read
    `role: Optional[str] = None` from `?role=` therefore receive the
    server-truth role automatically with no per-route changes.
    """
    raw_qs = scope.get("query_string", b"") or b""
    try:
        params = parse_qsl(raw_qs.decode("ascii"), keep_blank_values=True)
    except UnicodeDecodeError:
        params = []
    params = [(k, v) for (k, v) in params if k != "role"]
    params.append(("role", role))
    scope["query_string"] = urlencode(params).encode("ascii")


async def session_middleware(request: Request, call_next):
    """Hydrate `request.state.user`, gate `/api/*` behind a valid session,
    and force the authenticated role onto the request so downstream
    handlers can't be tricked by a client-supplied `?role=` override.
    """
    request.state.user = resolve_user_from_request(request)
    if _is_protected_api(request.url.path) and request.state.user is None:
        return JSONResponse(
            status_code=401,
            content={
                "error": "unauthenticated",
                "detail": "Sign in via /auth required.",
                "path": request.url.path,
            },
        )
    if request.state.user is not None and request.url.path.startswith("/api/"):
        _override_query_role(request.scope, request.state.user["role"])
    return await call_next(request)
