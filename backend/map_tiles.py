"""Offline basemap resolution for BASTION (WI-1).

The COP must render on a disconnected node. The browser fetches map tiles
directly, so backend egress enforcement cannot help — the tiles have to be
served from this box. This module decides which of three modes the map is in
and generates a self-hosted MapLibre style when an offline pack is installed:

  offline  a PMTiles archive is present (deploy/tiles/*.pmtiles, or
           SPIRE_TILE_ARCHIVE pointing at one). Style, tiles: same-origin.
  online   no archive, and egress is NOT enforced -> the public CartoCDN style.
  none     no archive and egress IS enforced -> refuse to reach out. The UI
           renders an explicit "no offline tile pack installed" state rather
           than a silent gray void.

The generated style deliberately carries **no text layers**. Labels would need
glyph PBFs vendored per fontstack; skipping them keeps the offline pack a
single self-contained archive. Unit symbology is drawn client-side by milsymbol,
so the operating picture is unaffected.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional

# Public basemap used only when we are allowed to reach the internet.
CARTO_DARK_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
CARTO_ATTRIBUTION = "(c) OpenStreetMap contributors (c) CARTO"
PROTOMAPS_ATTRIBUTION = "(c) OpenStreetMap contributors"

TILES_DIR = Path(__file__).resolve().parent.parent / "deploy" / "tiles"


def _egress_enforced() -> bool:
    return (os.environ.get("SPIRE_EGRESS_ENFORCE") or "").strip().lower() in ("1", "true", "yes")


def tile_archive_path() -> Optional[Path]:
    """Path to the installed PMTiles archive, or None.

    SPIRE_TILE_ARCHIVE may point directly at a .pmtiles file (distinct from
    SPIRE_TILE_ORIGIN, which is a CSP origin); otherwise the
    first archive in deploy/tiles/ wins (operators drop one per AO).
    """
    origin = (os.environ.get("SPIRE_TILE_ARCHIVE") or "").strip()
    if origin:
        p = Path(origin)
        if p.is_file() and p.suffix == ".pmtiles":
            return p
        return None
    try:
        archives = sorted(TILES_DIR.glob("*.pmtiles"))
    except OSError:
        return None
    return archives[0] if archives else None


def map_mode() -> str:
    """offline | online | none — see module docstring."""
    if tile_archive_path() is not None:
        return "offline"
    return "online" if not _egress_enforced() else "none"


def _layers() -> List[Dict[str, Any]]:
    """Minimal dark basemap over the Protomaps vector schema. Geometry only."""
    return [
        {"id": "background", "type": "background",
         "paint": {"background-color": "#0b0f14"}},
        {"id": "earth", "type": "fill", "source": "protomaps", "source-layer": "earth",
         "paint": {"fill-color": "#11161d"}},
        {"id": "landuse", "type": "fill", "source": "protomaps", "source-layer": "landuse",
         "paint": {"fill-color": "#141a22"}},
        {"id": "water", "type": "fill", "source": "protomaps", "source-layer": "water",
         "paint": {"fill-color": "#0a1420"}},
        {"id": "roads", "type": "line", "source": "protomaps", "source-layer": "roads",
         "paint": {"line-color": "#2a3341", "line-width": 0.8}},
        {"id": "boundaries", "type": "line", "source": "protomaps", "source-layer": "boundaries",
         "paint": {"line-color": "#3a4655", "line-width": 0.6, "line-dasharray": [2, 2]}},
    ]


def build_style(pmtiles_url: str) -> Dict[str, Any]:
    """A self-contained MapLibre style pointing at a same-origin PMTiles archive.

    ``pmtiles_url`` is the absolute same-origin URL of the archive; the frontend
    registers the `pmtiles://` protocol so MapLibre can range-read it.
    """
    return {
        "version": 8,
        "name": "SPIRE offline dark",
        "sources": {
            "protomaps": {
                "type": "vector",
                "url": f"pmtiles://{pmtiles_url}",
                "attribution": PROTOMAPS_ATTRIBUTION,
            }
        },
        "layers": _layers(),
    }


def map_config(base_url: str) -> Dict[str, Any]:
    """Payload for GET /api/system/map-config. ``base_url`` is the request origin."""
    mode = map_mode()
    if mode == "offline":
        return {
            "mode": "offline",
            "style_url": f"{base_url.rstrip('/')}/map/style.json",
            "attribution": PROTOMAPS_ATTRIBUTION,
        }
    if mode == "online":
        return {"mode": "online", "style_url": CARTO_DARK_STYLE, "attribution": CARTO_ATTRIBUTION}
    return {"mode": "none", "style_url": None, "attribution": None}
