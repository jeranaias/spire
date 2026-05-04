"""State-file path containment tests."""
from __future__ import annotations

from pathlib import Path

import pytest

from backend.uis.channels.paths import (
    PathEscapeError,
    contained_path,
    ensure_state_root,
    state_root,
    validate_state_path,
)


@pytest.fixture
def state_root_tmp(monkeypatch, tmp_path):
    """Point SPIRE_CHANNEL_STATE_ROOT at a tmp dir for the test."""
    root = tmp_path / "state-root"
    monkeypatch.setenv("SPIRE_CHANNEL_STATE_ROOT", str(root))
    return root


def test_state_root_honors_env_var(state_root_tmp, tmp_path):
    assert state_root() == (tmp_path / "state-root").resolve()


def test_ensure_state_root_creates_dir(state_root_tmp):
    root = ensure_state_root()
    assert root.exists() and root.is_dir()


def test_validate_accepts_path_inside_root(state_root_tmp):
    inside = state_root_tmp / "channel/wm.txt"
    inside.parent.mkdir(parents=True, exist_ok=True)
    validate_state_path(str(inside), label="watermark_state_path")  # no raise


def test_validate_accepts_empty_path(state_root_tmp):
    """No checkpoint configured = no validation needed."""
    validate_state_path("", label="x")
    validate_state_path(None, label="x")


def test_validate_rejects_path_outside_root(state_root_tmp, tmp_path):
    outside = tmp_path / "elsewhere" / "leak.txt"
    with pytest.raises(PathEscapeError) as exc:
        validate_state_path(str(outside), label="watermark_state_path")
    assert "escapes the state root" in str(exc.value)


def test_validate_rejects_etc_passwd_traversal(state_root_tmp):
    """The classic — admin pastes /etc/passwd as the watermark file."""
    with pytest.raises(PathEscapeError):
        validate_state_path("/etc/passwd", label="watermark_state_path")


def test_validate_rejects_dotdot_escape(state_root_tmp):
    sneaky = str(state_root_tmp / ".." / "elsewhere.txt")
    with pytest.raises(PathEscapeError):
        validate_state_path(sneaky, label="watermark_state_path")


def test_contained_path_strips_traversal_chars(state_root_tmp):
    target = contained_path("channel/with/slashes", "../etc/passwd")
    # Both channel id slashes and filename traversal are sanitized
    assert ".." not in str(target)
    # Lands under the state root
    target.relative_to(state_root_tmp.resolve())  # no raise
