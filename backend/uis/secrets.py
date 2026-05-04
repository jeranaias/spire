"""Secrets resolver — env-var first, Vault fallback (UIS-P6.9).

The channel + audit code already uses an env-var pattern for
secrets (``password_env``, ``bearer_token_env``, etc.). For
production-grade IL5 deployments the actual secret often lives
in HashiCorp Vault, AWS Secrets Manager, or a DoD-approved
secrets store, and only a *reference* sits in env. This module
adds that indirection cleanly.

Resolution order
----------------
For an env-var name like ``SPIRE_DLA_PWD``:

  1. **Vault prefix** — if the env-var value starts with
     ``vault://`` (e.g. ``vault://secret/spire/dla#password``),
     resolve via the configured Vault client. Cached for the
     process lifetime; secrets refresh requires a SPIRE restart
     by default (operationally simpler, matches DoD secret-
     rotation cadence).
  2. **Plain value** — otherwise the env value IS the secret
     (existing dev / pilot behavior).
  3. **Missing** — env var unset → return None. Caller decides
     whether that's an error.

The ``vault://`` URL shape::

    vault://<mount>/<path>#<field>

  - ``<mount>``: KV mount point ("secret" by default for V2)
  - ``<path>``: secret path
  - ``<field>``: which field of the secret to read (Vault KV
    stores arbitrary key-value within a path)

Vault config (env vars)
-----------------------
  SPIRE_VAULT_ADDR       — Vault HTTP endpoint (e.g. https://vault.usmc.mil)
  SPIRE_VAULT_TOKEN      — auth token (production: AppRole or short-lived JWT)
  SPIRE_VAULT_NAMESPACE  — Vault namespace (Enterprise feature; optional)
  SPIRE_VAULT_KV_VERSION — "v1" or "v2"; default "v2"
  SPIRE_VAULT_VERIFY     — TLS verification flag/CA-bundle path; default true

Failure semantics
-----------------
- Vault unreachable → log + return None. Caller raises with
  context (e.g. ``RuntimeError(f"channel {id} requires
  password but Vault unreachable")``).
- Stale cache → no auto-refresh; restart SPIRE to rotate. ATO
  posture: short-lived tokens + scheduled redeploys, not
  in-process rotation.
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Any, Callable, Dict, Optional


log = logging.getLogger(__name__)


_CACHE: Dict[str, str] = {}
_CACHE_LOCK = threading.Lock()


# Test seam — production uses _vault_get; tests inject a stub.
VaultGetter = Callable[[str, str, str, Dict[str, Any]], Optional[str]]
_resolver: Optional[VaultGetter] = None


def set_vault_resolver(fn: Optional[VaultGetter]) -> None:
    """Override the Vault resolver (used by tests). Pass None to
    restore the default httpx-based resolver."""
    global _resolver
    _resolver = fn


def clear_cache() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def resolve_env_secret(env_var_name: str) -> Optional[str]:
    """Resolve an env-var-named secret. Returns the actual secret
    string or None if unset / unresolvable.

    Use this in place of ``os.environ.get(env_var_name)`` whenever
    the env value might be a Vault reference.
    """
    if not env_var_name:
        return None
    raw = os.environ.get(env_var_name)
    if raw is None:
        return None
    raw = raw.strip()
    if not raw:
        return None
    if raw.startswith("vault://"):
        return _resolve_vault_url(raw)
    return raw


# ---------------------------------------------------------------------------
# Vault URL parsing + lookup
# ---------------------------------------------------------------------------


def _resolve_vault_url(url: str) -> Optional[str]:
    """Parse vault://<mount>/<path>#<field> + look up via Vault client."""
    with _CACHE_LOCK:
        if url in _CACHE:
            return _CACHE[url]
    try:
        mount, path, field = _parse_vault_url(url)
    except ValueError as e:
        log.error("Invalid Vault URL %s: %s", url, e)
        return None
    try:
        value = (_resolver or _vault_get)(
            mount, path, field, _vault_config(),
        )
    except Exception as e:  # noqa: BLE001
        log.error("Vault lookup failed for %s: %s", url, e)
        return None
    if value is not None:
        with _CACHE_LOCK:
            _CACHE[url] = value
    return value


def _parse_vault_url(url: str):
    """Parse `vault://<mount>/<path>#<field>` into a tuple."""
    if not url.startswith("vault://"):
        raise ValueError("not a vault:// URL")
    rest = url[len("vault://"):]
    if "#" not in rest:
        raise ValueError("missing #<field>")
    path_part, field = rest.rsplit("#", 1)
    if "/" not in path_part:
        raise ValueError("missing /<path>")
    mount, path = path_part.split("/", 1)
    if not mount or not path or not field:
        raise ValueError("empty mount, path, or field")
    return mount, path, field


def _vault_config() -> Dict[str, Any]:
    return {
        "addr": os.environ.get("SPIRE_VAULT_ADDR", "").strip(),
        "token": os.environ.get("SPIRE_VAULT_TOKEN", "").strip(),
        "namespace": os.environ.get("SPIRE_VAULT_NAMESPACE", "").strip(),
        "kv_version": os.environ.get("SPIRE_VAULT_KV_VERSION", "v2").strip().lower(),
        "verify": _parse_verify(os.environ.get("SPIRE_VAULT_VERIFY", "1")),
    }


def _parse_verify(value: str):
    """Vault verify flag — boolean OR a CA bundle path."""
    s = value.strip()
    if not s:
        return True
    low = s.lower()
    if low in {"0", "false", "no", "off"}:
        return False
    if low in {"1", "true", "yes", "on"}:
        return True
    return s  # CA-bundle path


def _vault_get(mount: str, path: str, field: str, cfg: Dict[str, Any]) -> Optional[str]:
    """Default resolver — KV v1/v2 read via httpx."""
    try:
        import httpx  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "Vault resolver requires `httpx`. Install: pip install httpx"
        ) from e

    addr = cfg.get("addr") or ""
    token = cfg.get("token") or ""
    if not addr or not token:
        raise RuntimeError(
            "SPIRE_VAULT_ADDR + SPIRE_VAULT_TOKEN required for vault:// secrets."
        )
    headers = {"X-Vault-Token": token}
    if cfg.get("namespace"):
        headers["X-Vault-Namespace"] = cfg["namespace"]
    if cfg.get("kv_version", "v2") == "v2":
        url = f"{addr.rstrip('/')}/v1/{mount}/data/{path}"
    else:
        url = f"{addr.rstrip('/')}/v1/{mount}/{path}"
    with httpx.Client(verify=cfg.get("verify", True), timeout=10.0) as c:
        resp = c.get(url, headers=headers)
        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            raise RuntimeError(
                f"Vault GET {url} returned {resp.status_code}: {resp.text[:200]}"
            )
        body = resp.json()
    # KV v2 wraps fields under data.data; v1 puts them at data
    if cfg.get("kv_version", "v2") == "v2":
        data = ((body.get("data") or {}).get("data") or {})
    else:
        data = body.get("data") or {}
    return data.get(field)
