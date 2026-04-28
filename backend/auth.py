"""
CAC/PIV mock auth — identity foundation for SPIRE.

Demo-grade only: simulates the visual + UX of cert-selection from a four-up
"smartcard reader" without any real PKI. Sign-in writes an HMAC-signed
HttpOnly session cookie; the matching middleware (`session_middleware`)
hydrates `request.state.user` on every call and rejects unauthenticated
`/api/*` (excluding `/api/auth/*`) with 401.

The four mocked Marines exist in `MOCK_USERS` and represent the role
spectrum SPIRE currently scopes against: operator (G-4), maintenance chief,
security manager, MEF commander. Identity payload is the contract every
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
#
# Field shape is the load-bearing contract for downstream lanes. Once shipped
# every Wave 1 lane reads from this; additions are safe, renames break the
# world. Keep this in sync with `frontend/src/state/store.ts` `User`.
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
        "unit": "CLB-6",
        "parent_command": "2d MLG",
        "branch": "USMC",
        "clearance": "SECRET",
        "role": "g4",
        "initials": "MR",
        "cert_issuer": "DOD ID CA-59",
        "cert_serial": "0x4A7F12C8",
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
        "unit": "CLB-6",
        "parent_command": "2d MLG",
        "branch": "USMC",
        "clearance": "SECRET",
        "role": "maintenance_chief",
        "initials": "DK",
        "cert_issuer": "DOD ID CA-59",
        "cert_serial": "0x6B19E04A",
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
        "unit": "2d MLG",
        "parent_command": "II MEF",
        "branch": "USMC",
        "clearance": "TS//SCI",
        "role": "security_manager",
        "initials": "JP",
        "cert_issuer": "DOD ID SW-CA-66",
        "cert_serial": "0x8F02D971",
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
        "unit": "II MEF",
        "parent_command": "MARFORCOM",
        "branch": "USMC",
        "clearance": "TS//SCI",
        "role": "mef_commander",
        "initials": "RH",
        "cert_issuer": "DOD ID CA-59",
        "cert_serial": "0xC4A8B335",
        "cert_expires": "2028-01-17",
    },
]

MOCK_USERS_BY_DODID: dict[str, dict[str, Any]] = {u["dodid"]: u for u in MOCK_USERS}


# ---------------------------------------------------------------------------
# Auth router — /api/auth/*
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    dodid: str
    pin: str


router = APIRouter()


@router.get("/users")
def list_users() -> dict[str, Any]:
    """Cert-selection screen reads this to populate the four smartcards."""
    return {"users": MOCK_USERS}


@router.post("/login")
def login(req: LoginRequest, response: Response) -> dict[str, Any]:
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
