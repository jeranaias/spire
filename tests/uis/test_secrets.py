"""Secrets resolver tests (UIS-P6.9)."""
from __future__ import annotations

import pytest

from backend.uis.secrets import (
    _parse_vault_url,
    _parse_verify,
    clear_cache,
    resolve_env_secret,
    set_vault_resolver,
)


@pytest.fixture(autouse=True)
def reset_secrets_state():
    clear_cache()
    set_vault_resolver(None)
    yield
    clear_cache()
    set_vault_resolver(None)


# ---------------------------------------------------------------------------
# Plain env-var path
# ---------------------------------------------------------------------------


def test_plain_env_var_returned_as_is(monkeypatch):
    monkeypatch.setenv("MY_PWD", "supersecret")
    assert resolve_env_secret("MY_PWD") == "supersecret"


def test_unset_env_returns_none(monkeypatch):
    monkeypatch.delenv("MISSING", raising=False)
    assert resolve_env_secret("MISSING") is None


def test_empty_env_returns_none(monkeypatch):
    monkeypatch.setenv("EMPTY", "   ")
    assert resolve_env_secret("EMPTY") is None


def test_no_env_var_name_returns_none():
    assert resolve_env_secret("") is None
    assert resolve_env_secret(None) is None  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Vault URL parsing
# ---------------------------------------------------------------------------


def test_parse_vault_url_basic():
    mount, path, field = _parse_vault_url("vault://secret/spire/dla#password")
    assert mount == "secret"
    assert path == "spire/dla"
    assert field == "password"


def test_parse_vault_url_nested_path():
    mount, path, field = _parse_vault_url(
        "vault://kv/team/usmc/spire/credentials#sasl_password",
    )
    assert mount == "kv"
    assert path == "team/usmc/spire/credentials"
    assert field == "sasl_password"


def test_parse_vault_url_missing_fragment_raises():
    with pytest.raises(ValueError, match="missing #"):
        _parse_vault_url("vault://secret/spire/dla")


def test_parse_vault_url_missing_path_raises():
    with pytest.raises(ValueError, match="missing /"):
        _parse_vault_url("vault://secret#password")


def test_parse_vault_url_empty_field_raises():
    with pytest.raises(ValueError):
        _parse_vault_url("vault://secret/path#")


# ---------------------------------------------------------------------------
# Vault resolution via injected resolver
# ---------------------------------------------------------------------------


def test_vault_url_routes_through_resolver(monkeypatch):
    captured = []

    def fake_resolver(mount, path, field, cfg):
        captured.append((mount, path, field))
        return "vault-secret-value"

    set_vault_resolver(fake_resolver)
    monkeypatch.setenv("DLA_PWD", "vault://secret/dla#password")
    assert resolve_env_secret("DLA_PWD") == "vault-secret-value"
    assert captured == [("secret", "dla", "password")]


def test_vault_resolver_failure_returns_none(monkeypatch):
    def boom(mount, path, field, cfg):
        raise IOError("vault unreachable")

    set_vault_resolver(boom)
    monkeypatch.setenv("DLA_PWD", "vault://secret/dla#password")
    assert resolve_env_secret("DLA_PWD") is None


def test_vault_url_cached_after_first_lookup(monkeypatch):
    call_count = [0]

    def counting_resolver(mount, path, field, cfg):
        call_count[0] += 1
        return f"value-{call_count[0]}"

    set_vault_resolver(counting_resolver)
    monkeypatch.setenv("DLA_PWD", "vault://secret/dla#password")
    a = resolve_env_secret("DLA_PWD")
    b = resolve_env_secret("DLA_PWD")
    # Same value both times — cache hit on second call
    assert a == b
    assert call_count[0] == 1


def test_invalid_vault_url_returns_none(monkeypatch):
    """Bad URL shape doesn't crash callers."""
    monkeypatch.setenv("DLA_PWD", "vault://busted-format-no-field")
    assert resolve_env_secret("DLA_PWD") is None


# ---------------------------------------------------------------------------
# Verify-flag parsing
# ---------------------------------------------------------------------------


def test_parse_verify_truthy():
    assert _parse_verify("1") is True
    assert _parse_verify("true") is True
    assert _parse_verify("yes") is True
    assert _parse_verify("ON") is True


def test_parse_verify_falsy():
    assert _parse_verify("0") is False
    assert _parse_verify("false") is False
    assert _parse_verify("no") is False


def test_parse_verify_path_passes_through():
    """A path-shaped value is treated as a CA bundle file path."""
    out = _parse_verify("/etc/spire/dod-root-ca.pem")
    assert out == "/etc/spire/dod-root-ca.pem"
