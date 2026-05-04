"""State-file path containment.

Channels persist small bits of state to disk: SFTP processed-
handles checkpoints, HTTP poll watermarks, DB CDC watermarks,
filesystem channel root dirs. Operator-supplied paths could
escape to ``/etc/passwd`` or ``C:\\Windows\\System32`` if we
trust them blindly.

This module enforces that every state path resolves under a
designated state root: ``$SPIRE_CHANNEL_STATE_ROOT`` (default
``~/.spire/channel-state``). Any config that escapes is
rejected at create/update time so a misconfigured channel
can't write outside its sandbox.

The filesystem channel's ``root`` is *not* containment-checked
because that path IS the operator's intentional choice — they
might genuinely want to watch ``/mnt/dla-share/incoming``. The
distinction: ``root`` is a watch target the operator knows; the
state files are SPIRE internal bookkeeping that has no reason
to be anywhere else.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional


def state_root() -> Path:
    """Designated parent directory for SPIRE-managed state files.

    Default: ``~/.spire/channel-state``. Override via
    ``SPIRE_CHANNEL_STATE_ROOT`` for IL5 deployments that want
    state on an encrypted volume rather than the home dir.
    """
    raw = (os.environ.get("SPIRE_CHANNEL_STATE_ROOT") or "").strip()
    if raw:
        return Path(raw).resolve()
    return (Path.home() / ".spire" / "channel-state").resolve()


def ensure_state_root() -> Path:
    """Create the state root if it doesn't exist; return its
    resolved Path."""
    root = state_root()
    root.mkdir(parents=True, exist_ok=True)
    return root


class PathEscapeError(ValueError):
    """Raised when a configured path escapes the state root."""

    def __init__(self, *, label: str, path: str, root: Path):
        self.label = label
        self.path = path
        self.root = root
        super().__init__(
            f"{label}={path!r} escapes the state root {root!s}. "
            f"Configure paths under SPIRE_CHANNEL_STATE_ROOT."
        )


def validate_state_path(path: Optional[str], *, label: str = "state_path") -> None:
    """Raise PathEscapeError if ``path`` resolves outside state_root().

    Empty / None paths are allowed — channels treat absent state
    as "no checkpoint, start fresh."
    """
    if not path:
        return
    root = state_root()
    resolved = Path(path).resolve()
    try:
        resolved.relative_to(root)
    except ValueError:
        raise PathEscapeError(label=label, path=path, root=root)


def contained_path(channel_id: str, filename: str) -> Path:
    """Convenience builder: returns ``<state_root>/<channel_id>/<filename>``,
    creating parent directories. Use this in default config to
    construct state file paths that are guaranteed-safe."""
    safe_channel = channel_id.replace("/", "_").replace("\\", "_").replace("..", "_")
    safe_file = filename.replace("/", "_").replace("\\", "_").replace("..", "_")
    target = ensure_state_root() / safe_channel / safe_file
    target.parent.mkdir(parents=True, exist_ok=True)
    return target
