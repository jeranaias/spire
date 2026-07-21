/**
 * Basemap resolution for the COP.
 *
 * The browser fetches map tiles itself, so backend egress enforcement cannot
 * stop the canvas from calling out to a CDN. The backend therefore tells us up
 * front which of three modes we are in (GET /api/system/map-config):
 *
 *   offline  a PMTiles pack is installed and served same-origin
 *   online   no pack, egress allowed -> public CartoCDN style
 *   none     no pack, egress enforced -> do not reach out at all
 *
 * For the offline mode we build the MapLibre style HERE, on the client, rather
 * than fetching one the backend generated. The style is geometry-only and
 * static; the only variable is the archive URL, and the one origin we can
 * trust to be reachable and same-scheme is the page's own. A backend-generated
 * absolute URL breaks the moment the API is on a different port (dev/preview)
 * or the page is https while the backend speaks http (behind a TLS proxy) -
 * both are cross-origin / mixed-content failures. Deriving the URL from
 * window.location.origin sidesteps all of it.
 *
 * If the config call fails (older backend, unreachable) we fall back to the
 * build-time VITE_MAP_STYLE_URL, then to the public style, so a demo laptop is
 * never left without a map.
 */
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";

export type MapMode = "offline" | "online" | "none";

export interface MapConfig {
  mode: MapMode;
  // Either a URL (public CDN style) or a fully-formed style object (offline,
  // built same-origin) or the blank fallback. Handed straight to MapLibre.
  style: string | maplibregl.StyleSpecification;
  attribution: string | null;
}

export const CARTO_DARK_STYLE =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const BUILD_STYLE_URL =
  (import.meta.env?.VITE_MAP_STYLE_URL as string | undefined) || "";

/**
 * Style used when there is no basemap to draw. Markers, threat rings and any
 * other client-drawn layer still render on top of it, so the operator keeps a
 * usable - if unreferenced - picture instead of a gray void.
 */
export const BLANK_STYLE = {
  version: 8,
  name: "SPIRE no-basemap",
  sources: {},
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#0b0f14" } },
  ],
} as unknown as maplibregl.StyleSpecification;

/**
 * Geometry-only dark basemap over the Protomaps vector schema, pointing at the
 * same-origin PMTiles archive. Mirrors backend/map_tiles.py::_layers so the
 * self-hosted look matches whatever the backend would have generated. No text
 * layers (no glyph PBFs to vendor); unit symbology is drawn by milsymbol.
 */
function buildOfflineStyle(origin: string): maplibregl.StyleSpecification {
  return {
    version: 8,
    name: "SPIRE offline dark",
    sources: {
      protomaps: {
        type: "vector",
        url: `pmtiles://${origin}/map/tiles.pmtiles`,
        attribution: "(c) OpenStreetMap contributors",
      },
    },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#0b0f14" } },
      { id: "earth", type: "fill", source: "protomaps", "source-layer": "earth", paint: { "fill-color": "#11161d" } },
      { id: "landuse", type: "fill", source: "protomaps", "source-layer": "landuse", paint: { "fill-color": "#141a22" } },
      { id: "water", type: "fill", source: "protomaps", "source-layer": "water", paint: { "fill-color": "#0a1420" } },
      { id: "roads", type: "line", source: "protomaps", "source-layer": "roads", paint: { "line-color": "#2a3341", "line-width": 0.8 } },
      { id: "boundaries", type: "line", source: "protomaps", "source-layer": "boundaries", paint: { "line-color": "#3a4655", "line-width": 0.6, "line-dasharray": [2, 2] } },
    ],
  } as unknown as maplibregl.StyleSpecification;
}

let protocolRegistered = false;

/** Teach MapLibre to range-read `pmtiles://` URLs. Idempotent. */
export function registerPmtilesProtocol(): void {
  if (protocolRegistered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  protocolRegistered = true;
}

function origin(): string {
  try {
    return window.location.origin;
  } catch {
    return "";
  }
}

function buildFallback(): MapConfig {
  return {
    mode: BUILD_STYLE_URL ? "offline" : "online",
    style: BUILD_STYLE_URL || CARTO_DARK_STYLE,
    attribution: null,
  };
}

export async function resolveMapConfig(): Promise<MapConfig> {
  try {
    const res = await fetch("/api/system/map-config", { credentials: "same-origin" });
    if (!res.ok) return buildFallback();
    const body = (await res.json()) as {
      mode?: string;
      attribution?: string | null;
    };
    const mode = body.mode;
    if (mode === "offline") {
      // A build-time override wins only over the public CDN, never over the
      // pack the node is serving.
      const style = BUILD_STYLE_URL || buildOfflineStyle(origin());
      return { mode: "offline", style, attribution: body.attribution ?? null };
    }
    if (mode === "none") {
      return { mode: "none", style: BLANK_STYLE, attribution: null };
    }
    if (mode === "online") {
      // Build-time override outranks the CDN even here.
      if (BUILD_STYLE_URL) return { mode: "offline", style: BUILD_STYLE_URL, attribution: body.attribution ?? null };
      return { mode: "online", style: CARTO_DARK_STYLE, attribution: body.attribution ?? null };
    }
    return buildFallback();
  } catch {
    return buildFallback();
  }
}
