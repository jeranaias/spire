# Offline basemap packs (PMTiles)

BASTION renders from a PMTiles archive served by this box. Drop an archive here
and the app switches to `mode=offline` automatically — no rebuild, no env change
(the backend picks up `deploy/tiles/*.pmtiles`, or set `SPIRE_TILE_ARCHIVE` to a
specific file).

With no archive installed:
- egress NOT enforced -> `mode=online`, the public CartoCDN style is used;
- `SPIRE_EGRESS_ENFORCE=1` -> `mode=none`, and the COP shows an explicit
  "no offline tile pack installed" panel instead of a silent gray void.
  Markers and threat rings still render.

## Baking an archive (do this on a networked box)

    pmtiles extract https://build.protomaps.com/<latest>.pmtiles okinawa.pmtiles \
        --bbox=123.7,23.9,128.6,27.1

    pmtiles extract https://build.protomaps.com/<latest>.pmtiles grafton.pmtiles \
        --bbox=-99.6,47.0,-98.2,48.3

Widen the Grafton bbox (e.g. `-104,45,-96,49`) if theater pull-back context is
wanted for the ND scenario. Verify max zoom 14 covers marker work.

Copy the resulting `.pmtiles` into this directory. Archives are gitignored —
they are large binaries, not source.

## Note on labels

The generated style (`/map/style.json`) is geometry-only: background, earth,
landuse, water, roads, boundaries. Text labels are omitted deliberately so the
pack stays a single self-contained archive with no glyph PBFs to vendor. Unit
symbology is drawn client-side (milsymbol), so the operating picture is
unaffected. If labels are wanted later, vendor the glyph ranges for the
fontstacks and add the text layers to `backend/map_tiles.py::_layers`.
