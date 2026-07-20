"""Same-origin basemap assets for the offline COP (WI-1).

Mounted at /map (deliberately NOT under /api, so it is not session-gated —
these are public basemap geometry, no CUI, and MapLibre fetches them directly
from the browser). Serving them ourselves is what makes a disconnected node
render a map at all.

`/map/tiles.pmtiles` is served by FileResponse, which honours HTTP Range
requests — PMTiles is a range-read format and will not work without them.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from ..map_tiles import build_style, tile_archive_path

router = APIRouter()


@router.get("/style.json")
async def style_json(request: Request) -> JSONResponse:
    """Generated MapLibre style pointing at the same-origin PMTiles archive."""
    if tile_archive_path() is None:
        raise HTTPException(status_code=404, detail="no_offline_tile_pack")
    base = str(request.base_url).rstrip("/")
    return JSONResponse(build_style(f"{base}/map/tiles.pmtiles"))


@router.get("/tiles.pmtiles")
async def tiles(request: Request) -> FileResponse:
    """The PMTiles archive itself (range-read by the pmtiles protocol)."""
    archive = tile_archive_path()
    if archive is None:
        raise HTTPException(status_code=404, detail="no_offline_tile_pack")
    return FileResponse(
        archive,
        media_type="application/octet-stream",
        headers={"Cache-Control": "public, max-age=86400"},
    )
