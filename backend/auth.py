"""
Session-bound authentication.

Replaces the spoofable `?role=...` URL parameter with a server-minted,
HMAC-signed bearer token. The token is the *only* trusted source for the
caller's effective role on every sensitive endpoint; it is also the actor
recorded in the audit chain.

Token format (URL-safe base64, three dot-separated parts):

    <header>.<payload>.<signature>

  header   = b64(json({"alg":"HS256","typ":"spire-session"}))
  payload  = b64(json({"role":"<role>","iat":<unix>,"exp":<unix>,"sid":"<rand>"}))
  signature = b64(HMAC-SHA256(secret, header + "." + payload))

The signing secret comes from `SPIRE_SESSION_SECRET`. If unset, a
process-local secret is generated on import — fine for the demo, but it
means tokens do NOT survive a backend restart. Production deployments
should set the env var explicitly. A KeyVault / CAC / Keycloak adapter
would replace `mint()` to issue tokens that are bound to a verified
identity assertion instead of accepting whatever role the caller asks
for; the verifier (`verify`) and FastAPI deps are unchanged in that
swap.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field


# ---- Secret material -------------------------------------------------------

_DEFAULT_TTL_SECONDS = 8 * 60 * 60  # 8h — covers a long shift without re-mint.
_ALG_HEADER = {"alg": "HS256", "typ": "spire-session"}

# Roles known to the system. Any mint request for a role outside this set is
# rejected at the door so a client can't fabricate a privileged-sounding
# string and have it pass the bearer check downstream.
KNOWN_ROLES = frozenset({
    "maintenance_chief",
    "g4",
    "mef_commander",
    "data_custodian",
    "security_manager",
})


def _load_secret() -> bytes:
    raw = os.environ.get("SPIRE_SESSION_SECRET", "").strip()
    if raw:
        return raw.encode("utf-8")
    # Process-local fallback. Logged once so an operator can see why
    # tokens didn't survive a restart.
    rand = secrets.token_urlsafe(48)
    print("[SPIRE] SPIRE_SESSION_SECRET unset — using ephemeral session secret.")
    return rand.encode("utf-8")


_SECRET = _load_secret()


# ---- Encoding helpers ------------------------------------------------------

def _b64u_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64u_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _sign(header_b64: str, payload_b64: str) -> str:
    msg = f"{header_b64}.{payload_b64}".encode("ascii")
    sig = hmac.new(_SECRET, msg, hashlib.sha256).digest()
    return _b64u_encode(sig)


# ---- Mint / verify ---------------------------------------------------------

def mint(role: str, ttl_seconds: int = _DEFAULT_TTL_SECONDS) -> dict:
    """Mint a signed session token for `role`. Returns
    `{token, role, expires_at, session_id}`. Raises 400 if role unknown.
    """
    if role not in KNOWN_ROLES:
        raise HTTPException(
            status_code=400,
            detail={"error": "UnknownRole", "role_seen": role,
                    "roles_allowed": sorted(KNOWN_ROLES)},
        )
    now = int(time.time())
    exp = now + max(60, int(ttl_seconds))
    sid = secrets.token_urlsafe(12)

    header_b64 = _b64u_encode(json.dumps(_ALG_HEADER, separators=(",", ":")).encode())
    payload = {"role": role, "iat": now, "exp": exp, "sid": sid}
    payload_b64 = _b64u_encode(json.dumps(payload, separators=(",", ":")).encode())
    sig_b64 = _sign(header_b64, payload_b64)
    token = f"{header_b64}.{payload_b64}.{sig_b64}"
    return {"token": token, "role": role, "expires_at": exp, "session_id": sid}


def verify(token: str) -> dict:
    """Validate signature + expiry; return decoded payload. Raises 401."""
    if not token or token.count(".") != 2:
        raise HTTPException(status_code=401, detail={"error": "MalformedToken"})
    header_b64, payload_b64, sig_b64 = token.split(".")
    expected = _sign(header_b64, payload_b64)
    # Constant-time compare so a forger can't probe byte-by-byte.
    if not hmac.compare_digest(expected, sig_b64):
        raise HTTPException(status_code=401, detail={"error": "BadSignature"})
    try:
        payload = json.loads(_b64u_decode(payload_b64))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=401, detail={"error": "MalformedPayload",
                                                     "reason": str(e)})
    role = payload.get("role")
    exp = int(payload.get("exp", 0))
    if role not in KNOWN_ROLES:
        raise HTTPException(status_code=401, detail={"error": "UnknownRole",
                                                     "role_seen": role})
    if exp < int(time.time()):
        raise HTTPException(status_code=401, detail={"error": "TokenExpired",
                                                     "expired_at": exp})
    return payload


# ---- FastAPI dependencies --------------------------------------------------

def _extract_token(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    parts = authorization.strip().split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    return parts[1].strip() or None


def current_role(authorization: Optional[str] = Header(default=None)) -> str:
    """Required dependency: returns the role from the bearer or raises 401."""
    token = _extract_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail={"error": "MissingBearer"})
    payload = verify(token)
    return payload["role"]


def current_role_optional(authorization: Optional[str] = Header(default=None)) -> Optional[str]:
    """Optional dependency: returns role if a valid bearer is present, else
    None. Used by read endpoints whose default behavior (no role = no
    scoping filter) is acceptable for now but should still record the
    effective actor when one is supplied.
    """
    token = _extract_token(authorization)
    if not token:
        return None
    try:
        return verify(token)["role"]
    except HTTPException:
        # Don't leak that the bearer was malformed for an optional dep —
        # treat it as anonymous and let the route's own gating decide.
        return None


# ---- Router ---------------------------------------------------------------

router = APIRouter()


class MintRequest(BaseModel):
    # In a CAC / Keycloak deployment this body would carry the upstream
    # identity assertion (SAML / OIDC id_token / X.509 thumb-print), and
    # `role` would be derived from the verified claims. The persona-switch
    # demo accepts a role directly so the dropdown still works locally.
    role: str = Field(..., description="Role to mint a session for.")
    ttl_seconds: Optional[int] = Field(None, description="Override TTL.")


class MintResponse(BaseModel):
    token: str
    role: str
    expires_at: int
    session_id: str


@router.post("/session", response_model=MintResponse)
def mint_session(req: MintRequest) -> MintResponse:
    out = mint(req.role, ttl_seconds=req.ttl_seconds or _DEFAULT_TTL_SECONDS)
    return MintResponse(**out)


@router.get("/whoami")
def whoami(role: str = Depends(current_role)) -> dict:
    return {"role": role}
