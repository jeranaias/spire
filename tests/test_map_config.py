"""Offline basemap resolution (WI-1).

The COP must never silently reach for the public CDN on an enforcing node, and
must never render a gray void when no pack is installed.
"""
from __future__ import annotations

import pytest

from backend import map_tiles


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    monkeypatch.delenv("SPIRE_TILE_ARCHIVE", raising=False)
    monkeypatch.delenv("SPIRE_EGRESS_ENFORCE", raising=False)
    # Point the archive dir at an empty temp dir so the developer's own packs
    # don't leak into the test.
    monkeypatch.setattr(map_tiles, "TILES_DIR", tmp_path)
    return tmp_path


def _install_archive(d):
    p = d / "okinawa.pmtiles"
    p.write_bytes(b"PMTiles\x03fake")
    return p


def test_offline_when_archive_present(_clean_env):
    _install_archive(_clean_env)
    assert map_tiles.map_mode() == "offline"
    cfg = map_tiles.map_config("http://node.local/")
    assert cfg["mode"] == "offline"
    assert cfg["style_url"] == "http://node.local/map/style.json"  # same-origin


def test_online_when_no_archive_and_egress_allowed(_clean_env):
    assert map_tiles.map_mode() == "online"
    cfg = map_tiles.map_config("http://node.local/")
    assert cfg["mode"] == "online"
    assert "cartocdn" in cfg["style_url"]


def test_none_when_no_archive_and_egress_enforced(_clean_env, monkeypatch):
    monkeypatch.setenv("SPIRE_EGRESS_ENFORCE", "1")
    assert map_tiles.map_mode() == "none"
    cfg = map_tiles.map_config("http://node.local/")
    assert cfg["mode"] == "none"
    assert cfg["style_url"] is None  # never reach out on an enforcing node


def test_tile_origin_overrides_dir(_clean_env, monkeypatch, tmp_path):
    explicit = tmp_path / "grafton.pmtiles"
    explicit.write_bytes(b"PMTiles\x03fake")
    monkeypatch.setenv("SPIRE_TILE_ARCHIVE", str(explicit))
    assert map_tiles.tile_archive_path() == explicit
    assert map_tiles.map_mode() == "offline"


def test_generated_style_is_self_contained(_clean_env):
    style = map_tiles.build_style("http://node.local/map/tiles.pmtiles")
    assert style["sources"]["protomaps"]["url"].startswith("pmtiles://http://node.local/")
    # Geometry-only: no glyphs/sprite dependency to vendor, nothing external.
    assert "glyphs" not in style and "sprite" not in style
    assert not any(layer["type"] == "symbol" for layer in style["layers"])
    blob = str(style)
    assert "cartocdn" not in blob and "https://" not in blob.replace("http://node.local", "")
