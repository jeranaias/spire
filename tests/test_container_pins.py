"""Container base images stay digest-pinned (WI-5).

A floating tag means the image an assessor reviewed is not the image that
ships next month. CI has no Docker daemon, so this is a text check on the
Dockerfiles - cheap, and it catches the regression that actually happens: a
hand edit that drops the digest back to a tag.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
DOCKERFILES = ["Dockerfile", "Dockerfile.fips", "Dockerfile.web", "frontend/Dockerfile"]

# Dockerfile.web is the public single-image build (Fly). It runs nginx,
# supervisord and the Tailscale daemon in one container, which needs root and
# NET_ADMIN. Excluded from the drop-root check deliberately rather than papered
# over: the enforcing field build is Dockerfile + docker-compose.event.yml,
# where every process is non-root. Revisit if the public image drops Tailscale.
RUNS_AS_ROOT = {"Dockerfile.web"}

FROM_LINE = re.compile(r"^FROM\s+(\S+)", re.M)


@pytest.mark.parametrize("rel", DOCKERFILES)
def test_every_base_image_is_digest_pinned(rel):
    text = (REPO / rel).read_text(encoding="utf-8")
    images = FROM_LINE.findall(text)
    assert images, f"{rel} has no FROM line"
    for image in images:
        assert "@sha256:" in image, f"{rel}: {image} is not digest-pinned"


@pytest.mark.parametrize("rel", [d for d in DOCKERFILES if d not in RUNS_AS_ROOT])
def test_every_image_drops_root(rel):
    text = (REPO / rel).read_text(encoding="utf-8")
    users = re.findall(r"^USER\s+(\S+)", text, re.M)
    assert users, f"{rel} never sets USER"
    assert users[-1] not in ("0", "root"), f"{rel} ends up running as root"


def test_frontend_build_context_is_pruned():
    # The frontend image builds from ./frontend, so the root .dockerignore
    # does not cover it.
    ignore = (REPO / "frontend" / ".dockerignore").read_text(encoding="utf-8")
    for entry in ("node_modules", "dist"):
        assert entry in ignore
