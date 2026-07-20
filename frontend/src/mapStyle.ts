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
 * If that call fails (backend older than this build, or unreachable) we fall
 * back to the build-time VITE_MAP_STYLE_URL, then to the public style — the
 * pre-WI-1 behaviour, so a demo laptop is never left without a map.
 */
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";

export type MapMode = "offline" | "online" | "none";

export interface MapConfig {
  mode: MapMode;
  styleUrl: string | null;
  attribution: string | null;
}

export const CARTO_DARK_STYLE =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const BUILD_STYLE_URL =
  (import.meta.env?.VITE_MAP_STYLE_URL as string | undefined) || "";

/**
 * Style used when there is no basemap to draw. Markers, threat rings and any
 * other client-drawn layer still render on top of it, so the operator keeps a
 * usable — if unreferenced — picture instead of a gray void.
 */
export const BLANK_STYLE = {
  version: 8,
  name: "SPIRE no-basemap",
  sources: {},
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#0b0f14" } },
  ],
} as unknown as maplibregl.StyleSpecification;

let protocolRegistered = false;

/** Teach MapLibre to range-read `pmtiles://` URLs. Idempotent. */
export function registerPmtilesProtocol(): void {
  if (protocolRegistered) return;
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  protocolRegistered = true;
}

function buildFallback(): MapConfig {
  const url = BUILD_STYLE_URL || CARTO_DARK_STYLE;
  return {
    mode: BUILD_STYLE_URL ? "offline" : "online",
    styleUrl: url,
    attribution: null,
  };
}

export async function resolveMapConfig(): Promise<MapConfig> {
  try {
    const res = await fetch("/api/system/map-config", { credentials: "same-origin" });
    if (!res.ok) return buildFallback();
    const body = (await res.json()) as {
      mode?: string;
      style_url?: string | null;
      attribution?: string | null;
    };
    const mode = body.mode;
    if (mode !== "offline" && mode !== "online" && mode !== "none") return buildFallback();
    // A build-time override outranks the public CDN but never the pack the
    // node is actually serving, and never a deliberate "do not reach out".
    if (mode === "online" && BUILD_STYLE_URL) {
      return { mode: "offline", styleUrl: BUILD_STYLE_URL, attribution: body.attribution ?? null };
    }
    return {
      mode,
      styleUrl: body.style_url ?? null,
      attribution: body.attribution ?? null,
    };
  } catch {
    return buildFallback();
  }
}
