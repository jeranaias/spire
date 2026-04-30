/**
 * mapBridge — global handle that connects SPIRO to the BASTION map.
 *
 * The map component (`OkinawaMapCanvas`) registers its concrete
 * implementation on mount; SPIRO calls into it via /api/copilot/execute
 * tool dispatchers that the frontend Spiro panel intercepts. The bridge
 * is intentionally small: fly-to, select, get markers. Anything more
 * elaborate (NL marker placement, multi-marker highlight) layers on
 * top of these primitives.
 *
 * The bridge lives at module scope rather than React context because
 * SPIRO's tool-execution path runs outside the React tree (a fetch
 * wrapper that needs to talk to the map without prop-drilling).
 *
 * If the map isn't mounted (e.g. operator on /pulse), tool calls
 * resolve to a clean "map not mounted" payload so SPIRO can still
 * answer textually instead of failing the whole plan.
 */
import { OKINAWA_SCENARIO } from "../data/okinawa-scenario";
import type { ScenarioMarker } from "../data/okinawa-scenario";

export interface MapBridge {
  flyTo: (lng: number, lat: number, zoom?: number) => void;
  selectMarker: (id: string | null) => void;
  getSelectedMarker: () => ScenarioMarker | null;
}

let _bridge: MapBridge | null = null;

export function registerMapBridge(b: MapBridge | null): void {
  _bridge = b;
}

export function getMapBridge(): MapBridge | null {
  return _bridge;
}

// Direct lookup helpers used by SPIRO tools. These are pure data-shape
// helpers — they don't require the map to be mounted because the marker
// registry is the static OKINAWA_SCENARIO seed plus any dragged
// positions in the markers Zustand store. For the bridge's
// remote-control purposes the seed is authoritative.

export function findMarkerById(id: string): ScenarioMarker | undefined {
  return OKINAWA_SCENARIO.find((m) => m.id === id);
}

export function findMarkerByLabel(label: string): ScenarioMarker | undefined {
  const target = label.trim().toLowerCase();
  return OKINAWA_SCENARIO.find(
    (m) =>
      m.label.toLowerCase() === target ||
      m.parent.toLowerCase() === target ||
      m.label.toLowerCase().includes(target),
  );
}

export function findMarkerByPulseUnit(unit: string): ScenarioMarker | undefined {
  const target = unit.trim().toLowerCase();
  return OKINAWA_SCENARIO.find(
    (m) => (m.pulseUnit ?? "").toLowerCase() === target,
  );
}

// Distance in km between two [lng, lat] points (haversine). Used by the
// `query_within_radius` SPIRO tool — small enough to inline; importing
// turf or geolib for one call would bloat the bundle.
export function haversineKm(
  a: [number, number],
  b: [number, number],
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const sa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa));
  return R * c;
}
