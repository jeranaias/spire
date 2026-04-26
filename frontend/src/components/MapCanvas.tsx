/**
 * MapCanvas — MapLibre GL replacement for InstallationSchematic.
 *
 * Renders buildings, ECPs, rally points, and unit markers as overlays on
 * real vector-tile basemap (CartoDB Dark Matter GL). The hand-drawn SVG
 * schematic was elegant but didn't generalize — every new installation
 * required authoring a perimeter, roads, and runway. The map approach
 * onboards any base with "drop pins on real satellite / vector tiles."
 *
 * Layers (bottom → top):
 *   1. Base vector tiles (CartoDB Dark Matter GL)
 *   2. Building polygons — type-coloured GeoJSON fill + outline
 *   3. Cordon circles during ThermalHawk sim (radius expressed in meters)
 *   4. UAS entry-vector arc (GeoJSON line with dash-offset animation)
 *   5. Rally points, ECPs, Units (Marker components with custom SVG)
 *   6. QRF dot (Marker with CSS offset-path during sim)
 *   7. Target reticle (Marker with SVG reticle + spin)
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
// Alias the default import to MapGL so we don't shadow the built-in Map constructor.
import MapGL, { Marker, Source, Layer, NavigationControl, ScaleControl, Popup } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Building, ECP, RallyPoint, BastionCOPUnit } from "../api";

const MAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

// Vendored fallback style used when the CartoDB CDN intermittently fails
// (reviewer caught the AJAX 0 race). Single solid background — buildings,
// units, and overlays still render on top, so the schematic remains
// usable even when no basemap is reachable. This is only reached if the
// remote style.json fails twice in a row.
const FALLBACK_STYLE: any = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "fallback-bg",
      type: "background",
      paint: { "background-color": "#0a0c13" },
    },
  ],
  glyphs:
    "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
};

// --- Unit → home building mapping (kept in sync with InstallationSchematic
// during the transition). Eventually lives on the unit record itself.
const UNIT_BUILDING: Record<string, string> = {
  "CLB-6":        "CLB6-MP",
  "CLB-1":        "MLG-SSC",
  "3d Maint Bn":  "MLG-SSC",
  "3/6 Marines":  "TANK-MP",
  "2d LAR Bn":    "LAR-MP",
  "MALS-31":      "HH-1",
  "MWSS-271":     "DL-HQ",
  "2d LAAD Bn":   "LAAD-TOC",
  "2/14 Marines": "TOC-MAIN",
  "7th ESB":      "ESB-WS",
};

// --- Building type styling — sized (metres), stroked by type.
const TYPE_COLOR: Record<string, { fill: string; stroke: string; label: string }> = {
  motor_pool:     { fill: "#3b2410", stroke: "#f59e0b", label: "MP"    },
  ammunition:     { fill: "#2a1212", stroke: "#ef4444", label: "ASP"   },
  arms_storage:   { fill: "#241010", stroke: "#ef4444", label: "ARMS"  },
  hazmat:         { fill: "#2a1d10", stroke: "#fb923c", label: "HAZ"   },
  fuel:           { fill: "#2d1e0b", stroke: "#fb923c", label: "POL"   },
  tactical:       { fill: "#0f1a2e", stroke: "#3b82f6", label: "TOC"   },
  admin:          { fill: "#141a28", stroke: "#9ca3af", label: "ADM"   },
  billeting:      { fill: "#141822", stroke: "#6b7280", label: "BR"    },
  housing:        { fill: "#161a24", stroke: "#6b7280", label: "FAM"   },
  support:        { fill: "#141822", stroke: "#6b7280", label: "SUP"   },
  medical:        { fill: "#0f1f14", stroke: "#22c55e", label: "MED"   },
  emergency:      { fill: "#1f1010", stroke: "#ef4444", label: "EMR"   },
  supply:         { fill: "#1a1710", stroke: "#eab308", label: "SSA"   },
  communications: { fill: "#17102a", stroke: "#8b5cf6", label: "COMM"  },
  aviation:       { fill: "#14102a", stroke: "#8b5cf6", label: "AIR"   },
  training:       { fill: "#101814", stroke: "#84cc16", label: "RNG"   },
  utility:        { fill: "#141822", stroke: "#6b7280", label: "UTL"   },
  maintenance:    { fill: "#201808", stroke: "#eab308", label: "MX"    },
};

function mcColor(rate: number): string {
  if (rate >= 0.90) return "#22c55e";
  if (rate >= 0.75) return "#eab308";
  if (rate >= 0.60) return "#fb923c";
  return "#ef4444";
}

// --- Build a GeoJSON polygon rectangle centered on (lat, lon) sized by type.
// Dimensions are approximate but tuned to look right at installation zoom
// (z ≈ 14.5–17). A slight per-id rotation jitter keeps things from looking
// like a parking-lot of identical rectangles.
function buildingPolygon(b: Building, lat: number, lon: number): GeoJSON.Feature {
  const sizes: Record<string, [number, number]> = {
    motor_pool: [130, 80], training: [240, 100], housing: [120, 75],
    aviation: [110, 70], supply: [120, 75], maintenance: [110, 70],
    billeting: [80, 30], fuel: [80, 55], tactical: [70, 50],
    medical: [80, 55], support: [70, 45], hazmat: [60, 45],
    admin: [70, 45], emergency: [70, 45], ammunition: [55, 40],
    arms_storage: [50, 36], communications: [50, 36], utility: [42, 32],
  };
  const [w, h] = sizes[b.type] ?? [60, 40];
  // Per-id deterministic micro-rotation so adjacent same-type buildings
  // don't look like Xerox copies of each other.
  let seed = 0;
  for (let i = 0; i < b.id.length; i++) seed = (seed * 31 + b.id.charCodeAt(i)) >>> 0;
  const rot = (((seed % 11) - 5) * Math.PI) / 180; // ±5°
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const corners: Array<[number, number]> = [
    [-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2],
  ];
  const coords = corners.map(([x, y]): [number, number] => {
    const xr = x * cos - y * sin;
    const yr = x * sin + y * cos;
    return [lon + xr / mPerDegLon, lat + yr / mPerDegLat];
  });
  coords.push(coords[0]);
  const style = TYPE_COLOR[b.type] ?? TYPE_COLOR.admin;
  return {
    type: "Feature",
    properties: {
      id: b.id,
      name: b.name,
      type: b.type,
      label: style.label,
      fill: style.fill,
      stroke: style.stroke,
      critical: b.critical_infrastructure,
      hazmat: b.hazmat_present,
    },
    geometry: { type: "Polygon", coordinates: [coords] },
  };
}

// --- Installation cantonment perimeter — irregular polygon hugging the
// building cluster with a soft buffer. Returns one Feature ready to drop
// into a Source.
function perimeterPolygon(buildings: Building[]): GeoJSON.Feature | null {
  const pts = buildings.filter((b) => b.lat != null && b.lon != null);
  if (pts.length < 3) return null;
  let minLat = +Infinity, maxLat = -Infinity, minLon = +Infinity, maxLon = -Infinity;
  for (const b of pts) {
    minLat = Math.min(minLat, b.lat!); maxLat = Math.max(maxLat, b.lat!);
    minLon = Math.min(minLon, b.lon!); maxLon = Math.max(maxLon, b.lon!);
  }
  // 350m buffer outward.
  const cLat = (minLat + maxLat) / 2;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((cLat * Math.PI) / 180);
  const bufLat = 350 / mPerDegLat;
  const bufLon = 350 / mPerDegLon;
  minLat -= bufLat; maxLat += bufLat;
  minLon -= bufLon; maxLon += bufLon;
  // Octagon-ish — chamfer the four corners by ~20% so it doesn't read as a
  // perfect rectangle. Looks like a real cantonment perimeter.
  const dx = (maxLon - minLon) * 0.18;
  const dy = (maxLat - minLat) * 0.18;
  const ring: Array<[number, number]> = [
    [minLon + dx, minLat], [maxLon - dx, minLat],
    [maxLon, minLat + dy], [maxLon, maxLat - dy],
    [maxLon - dx, maxLat], [minLon + dx, maxLat],
    [minLon, maxLat - dy], [minLon, minLat + dy],
    [minLon + dx, minLat],
  ];
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

// --- MIL-STD-2525C affiliation. Marcus (ex-Lattice PM) flagged that every
// unit was rendering as a blue rectangle regardless of side. Per 2525C, the
// frame shape encodes affiliation:
//   FRIENDLY  → rectangle (default for SPIRE units)
//   HOSTILE   → diamond
//   NEUTRAL   → square (rectangle with equal width and height, framed green)
//   UNKNOWN   → quatrefoil (4-leaf shape)
// We carry the affiliation as a prop so the same component renders correctly
// for the ThermalHawk hostile UAS reticle area + future coalition/neutral
// scenarios. SPIRE's fixture is all-friendly; the sim target is hostile.
export type UnitAffiliation = "friendly" | "hostile" | "neutral" | "unknown";

function UnitMarkerSVG({
  unit,
  color,
  selected,
  affiliation = "friendly",
}: {
  unit: string;
  color: string;
  selected: boolean;
  affiliation?: UnitAffiliation;
}) {
  const n = unit.toLowerCase();
  let modifier: ReactNode;
  if (n.includes("clb") || n.includes("esb") || n.includes("lvsr")) {
    modifier = (
      <g>
        <path d="M-10 -4 L10 -4 M0 -4 L0 6" stroke={color} strokeWidth="1.6" fill="none" />
        <circle cx="-6" cy="8" r="2" fill={color} />
        <circle cx="0"  cy="8" r="2" fill={color} />
        <circle cx="6"  cy="8" r="2" fill={color} />
      </g>
    );
  } else if (n.includes("maint")) {
    modifier = (
      <g>
        <path d="M-8 -4 L8 -4" stroke={color} strokeWidth="1.6" />
        <path d="M-4 2 L4 2 M0 2 L0 6" stroke={color} strokeWidth="1.4" />
        <circle cx="-4" cy="2" r="2" fill="none" stroke={color} strokeWidth="1.2" />
      </g>
    );
  } else if (n.includes("tank")) {
    modifier = <ellipse cx="0" cy="0" rx="14" ry="7" fill="none" stroke={color} strokeWidth="1.8" />;
  } else if (n.includes("lar")) {
    modifier = <path d="M-12 6 L12 -6" stroke={color} strokeWidth="1.8" />;
  } else if (n.includes("laad") || n.includes("ada")) {
    modifier = <path d="M0 6 L0 -6 M-5 -2 L0 -7 L5 -2" stroke={color} strokeWidth="1.6" fill="none" />;
  } else if (n.includes("mals") || n.includes("mwss")) {
    modifier = (
      <path d="M-12 0 L-4 -4 L0 -4 L4 -4 L12 0 L4 4 L-4 4 Z" fill="none" stroke={color} strokeWidth="1.4" />
    );
  } else if (n.includes("marines") || n.includes("himars")) {
    modifier = <circle r="5" fill={color} />;
  } else {
    modifier = <circle r="3" fill={color} />;
  }

  // Frame shape + frame color per 2525C affiliation. The fill color stays
  // tinted by the unit's status (mc_rate -> green/yellow/orange/red), so the
  // semantic remains: shape = side, color tint = readiness.
  const W = 56, H = 36;
  const fill = `color-mix(in oklab, ${color} 25%, #0a0c13)`;
  const strokeWidth = selected ? 3 : 2;
  // 2525C frame colors (fallback when caller hasn't overridden via `color`):
  //   friendly = blue, hostile = red, neutral = green, unknown = yellow.
  // Caller-supplied color overrides for friendly readiness shading.
  let frame: ReactNode;
  let selectionRing: ReactNode = null;
  if (affiliation === "friendly") {
    // Rectangle.
    frame = (
      <rect
        x={-W / 2} y={-H / 2} width={W} height={H}
        fill={fill} stroke={color} strokeWidth={strokeWidth} rx="1"
      />
    );
    if (selected) {
      selectionRing = (
        <rect
          x={-W / 2 - 6} y={-H / 2 - 6}
          width={W + 12} height={H + 12}
          fill="none" stroke={color} strokeWidth="1.5"
          strokeDasharray="5 4" opacity="0.75" rx="2"
        />
      );
    }
  } else if (affiliation === "hostile") {
    // Diamond (rotated square). 2525C hostile frame is a red diamond. We size
    // it to match the rectangle's bounding box visually so labels still align.
    const HX = 14, HY = 12;
    frame = (
      <polygon
        points={`0,${-HY} ${HX},0 0,${HY} ${-HX},0`}
        fill={fill} stroke={color} strokeWidth={strokeWidth}
      />
    );
    if (selected) {
      selectionRing = (
        <polygon
          points={`0,${-HY - 4} ${HX + 4},0 0,${HY + 4} ${-HX - 4},0`}
          fill="none" stroke={color} strokeWidth="1.5"
          strokeDasharray="5 4" opacity="0.75"
        />
      );
    }
  } else if (affiliation === "neutral") {
    // Square — same dimensions on both axes. 2525C neutral frame is green.
    const S = 32;
    frame = (
      <rect
        x={-S / 2} y={-S / 2} width={S} height={S}
        fill={fill} stroke={color} strokeWidth={strokeWidth}
      />
    );
    if (selected) {
      selectionRing = (
        <rect
          x={-S / 2 - 5} y={-S / 2 - 5}
          width={S + 10} height={S + 10}
          fill="none" stroke={color} strokeWidth="1.5"
          strokeDasharray="5 4" opacity="0.75"
        />
      );
    }
  } else {
    // Unknown — quatrefoil (4-leaf clover). 2525C unknown frame is yellow.
    // Approximated as a path of four arcs meeting at the center; small enough
    // to read as the distinctive 4-leaf silhouette at marker scale.
    const R = 14;
    const d = `
      M 0 ${-R}
      A ${R} ${R} 0 0 1 ${R} 0
      A ${R} ${R} 0 0 1 0 ${R}
      A ${R} ${R} 0 0 1 ${-R} 0
      A ${R} ${R} 0 0 1 0 ${-R}
      Z
    `;
    frame = (
      <path d={d} fill={fill} stroke={color} strokeWidth={strokeWidth} />
    );
    if (selected) {
      selectionRing = (
        <circle r={R + 5} fill="none" stroke={color} strokeWidth="1.5"
                strokeDasharray="5 4" opacity="0.75" />
      );
    }
  }

  return (
    <svg
      width={W + 8}
      height={H + 18}
      viewBox={`${-(W + 8) / 2} ${-(H + 18) / 2} ${W + 8} ${H + 18}`}
      style={{ overflow: "visible", filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.7))" }}
    >
      {selectionRing}
      {frame}
      {/* Antenna dots — unit-id markers, only for the rectangular friendly
       * frame (the diamond/quatrefoil silhouettes don't accommodate them). */}
      {affiliation === "friendly" && (
        <>
          <circle cx="-6" cy={-H / 2 - 5} r="1.8" fill={color} />
          <circle cx="6"  cy={-H / 2 - 5} r="1.8" fill={color} />
        </>
      )}
      <g opacity="0.9">{modifier}</g>
    </svg>
  );
}

export interface MapCanvasProps {
  buildings: Building[];
  units: BastionCOPUnit[];
  ecps: ECP[];
  rallyPoints: RallyPoint[];
  centerLat: number;
  centerLon: number;
  selectedUnit?: string | null;
  onUnitClick?: (unitName: string) => void;
  flyToBuilding?: string | null;
  // ThermalHawk sim
  simActive?: boolean;
  simTargetBuilding?: string;
  simCordons?: { radius_m: number; label: string }[];
  // When true, the map applies right-edge padding so markers (especially
  // ECP B at the east edge) aren't clipped by the response/threat drawer.
  drawerOpen?: boolean;
  // Bumped by parent each time a sim resolves. MapCanvas caches the
  // pre-sim viewport on simulate and restores it when this counter ticks.
  simResolveSignal?: number;
  // Bumped by parent to request a fit-bounds back to the full installation
  // (all units in viewport) — wired to the Reset View button so the
  // operator can recover from any zoom/pan state.
  resetViewSignal?: number;
}

export function MapCanvas({
  buildings,
  units,
  ecps,
  rallyPoints,
  centerLat,
  centerLon,
  selectedUnit,
  onUnitClick,
  flyToBuilding,
  simActive,
  simTargetBuilding,
  simCordons,
  drawerOpen,
  simResolveSignal,
  resetViewSignal,
}: MapCanvasProps) {
  const mapRef = useRef<any>(null);
  const [hoverBuilding, setHoverBuilding] = useState<Building | null>(null);
  const [ecpSelected, setEcpSelected] = useState<ECP | null>(null);
  const [rpSelected, setRpSelected] = useState<RallyPoint | null>(null);
  const [unitSelected, setUnitSelected] = useState<{ u: BastionCOPUnit; lat: number; lon: number } | null>(null);
  // Map-style fallback — flips to the vendored solid-background style if the
  // CartoDB CDN style.json fails (AJAX error 0). Operators still see units,
  // buildings, ECPs, rally points; just no vector basemap underneath.
  const [mapStyle, setMapStyle] = useState<string | typeof FALLBACK_STYLE>(MAP_STYLE);
  const styleRetryRef = useRef(0);
  // Cached pre-sim viewport. Captured the moment the operator triggers the
  // sim so resolve-sim restores the framing they were on, not just clears
  // the cordon overlays. Reviewer flagged that "Resolve sim · drop FPCON"
  // left the operator silently zoomed at the incident with no zoom-back.
  const preSimViewRef = useRef<{ longitude: number; latitude: number; zoom: number } | null>(null);
  // First-load fit-to-units pass — at the entry zoom of 14.7 some units
  // (CLB-1, 3d Maint Bn) sat off-viewport, so the operator only saw ~5 of
  // the 10 unit markers. We fit-bounds to all unit positions on the first
  // render that has both the map ref and the placed-units list ready.
  const initialFitDoneRef = useRef(false);

  // Smart anchor picker — chooses bottom / top / left / right based on where
  // the marker lands in the viewport so left-edge ECPs don't render their
  // popup off-screen. Reviewer caught the bottom-anchored Popup clipping
  // when the marker was near the left edge of the map.
  type Anchor = "top" | "bottom" | "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
  function pickAnchor(lat: number, lon: number, fallback: Anchor = "bottom"): Anchor {
    const map = mapRef.current;
    if (!map) return fallback;
    try {
      const pt = map.project([lon, lat]);
      const c = map.getContainer();
      const w = c.clientWidth;
      const h = c.clientHeight;
      // Margins inside which a marker is "near the edge" — popup width is
      // roughly 240px so we keep 220px of clearance on each side.
      const horizMargin = 220;
      const vertMargin = 200;
      const nearLeft = pt.x < horizMargin;
      const nearRight = pt.x > w - horizMargin;
      const nearTop = pt.y < vertMargin;
      const nearBottom = pt.y > h - vertMargin;
      // Anchor is the side of the popup attached to the marker — i.e. the
      // popup grows AWAY from that side. So if marker is near the left, we
      // anchor "left" so the popup grows to the right.
      if (nearBottom && nearLeft) return "bottom-left";
      if (nearBottom && nearRight) return "bottom-right";
      if (nearTop && nearLeft) return "top-left";
      if (nearTop && nearRight) return "top-right";
      if (nearLeft) return "left";
      if (nearRight) return "right";
      if (nearBottom) return "bottom";
      return fallback;
    } catch {
      return fallback;
    }
  }

  // Building centroid lookup for fly-to + sim targeting.
  const buildingById = useMemo(() => {
    const m = new Map<string, Building>();
    for (const b of buildings) if (b.lat != null && b.lon != null) m.set(b.id, b);
    return m;
  }, [buildings]);

  // Pre-computed GeoJSON FeatureCollection for the building-fill layer.
  const buildingGeoJson = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: "FeatureCollection",
    features: buildings
      .filter((b) => b.lat != null && b.lon != null)
      .map((b) => buildingPolygon(b, b.lat!, b.lon!)),
  }), [buildings]);

  // Building label points — typed badges shown at high zoom.
  const labelGeoJson = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: "FeatureCollection",
    features: buildings
      .filter((b) => b.lat != null && b.lon != null)
      .map((b): GeoJSON.Feature => {
        const style = TYPE_COLOR[b.type] ?? TYPE_COLOR.admin;
        return {
          type: "Feature",
          properties: { id: b.id, label: style.label, stroke: style.stroke },
          geometry: { type: "Point", coordinates: [b.lon!, b.lat!] },
        };
      }),
  }), [buildings]);

  // Cantonment perimeter — once per buildings change.
  const perimeterGeoJson = useMemo<GeoJSON.FeatureCollection | null>(() => {
    const p = perimeterPolygon(buildings);
    if (!p) return null;
    return { type: "FeatureCollection", features: [p] };
  }, [buildings]);

  // Unit markers with home-building lat/lon resolution.
  const placedUnits = useMemo(() => {
    return units.map((u) => {
      const homeId = UNIT_BUILDING[u.unit];
      const home = homeId ? buildingById.get(homeId) : undefined;
      return {
        u,
        lat: home?.lat ?? centerLat,
        lon: home?.lon ?? centerLon,
      };
    });
  }, [units, buildingById, centerLat, centerLon]);

  // Fly to a building when requested (alert click, sim trigger).
  useEffect(() => {
    if (!flyToBuilding || !mapRef.current) return;
    const b = buildingById.get(flyToBuilding);
    if (!b || b.lat == null || b.lon == null) return;
    mapRef.current.flyTo({ center: [b.lon, b.lat], zoom: 16.5, duration: 900 });
  }, [flyToBuilding, buildingById]);

  // Reviewer caught the map collapsing to a corner with units piled on each
  // other after role swap / modal close / sim trigger. Root cause: the parent
  // flex container momentarily reports height=0 during the role-change
  // transition (BastionView clears `cop` to null, which yanks the map
  // subtree) and MapLibre caches that 0-height. When the container re-mounts
  // at full size, MapLibre never auto-resizes. A ResizeObserver on the
  // container forces a `map.resize()` on every layout change so the canvas
  // tracks the wrapper. Belt-and-suspenders: also resize on window resize
  // and on a 100ms tick after first paint.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const container: HTMLElement | null = (map.getContainer && map.getContainer()) as HTMLElement | null;
    if (!container) return;
    let raf = 0;
    const doResize = () => {
      try {
        map.resize();
      } catch {
        /* tolerant — map may have unmounted */
      }
    };
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(doResize);
    });
    ro.observe(container);
    window.addEventListener("resize", doResize);
    // Kick once on mount in case the container was 0px when MapLibre booted.
    const initial = window.setTimeout(doResize, 100);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", doResize);
      window.clearTimeout(initial);
      ro.disconnect();
    };
  }, []);

  // Fly to the sim target when the sim fires. Cache the prior viewport so
  // sim-resolve can restore it (#4).
  useEffect(() => {
    if (!simActive || !simTargetBuilding || !mapRef.current) return;
    const map = mapRef.current;
    const b = buildingById.get(simTargetBuilding);
    if (!b || b.lat == null || b.lon == null) return;
    try {
      const c = map.getCenter();
      preSimViewRef.current = {
        longitude: c.lng,
        latitude: c.lat,
        zoom: map.getZoom(),
      };
    } catch {
      /* tolerant — best-effort cache */
    }
    map.flyTo({
      center: [b.lon, b.lat],
      zoom: 17,
      duration: 1200,
      // Right-padding so the response drawer (400px) doesn't bury the
      // target reticle behind the panel.
      padding: drawerOpen ? { top: 0, bottom: 0, left: 0, right: 400 } : undefined,
    });
  }, [simActive, simTargetBuilding, buildingById, drawerOpen]);

  // Sim-resolve restoration. Parent bumps `simResolveSignal` when the
  // operator clicks "Resolve sim · drop FPCON" so we fly back to the cached
  // pre-sim viewport instead of leaving the operator zoomed in. The cordon
  // overlays clear because `simActive` flips false at the same time
  // (cordon Source is gated on `simActive && simTarget && simCordons`).
  useEffect(() => {
    if (!simResolveSignal || !mapRef.current) return;
    const map = mapRef.current;
    const cached = preSimViewRef.current;
    if (cached) {
      map.flyTo({
        center: [cached.longitude, cached.latitude],
        zoom: cached.zoom,
        duration: 900,
      });
      preSimViewRef.current = null;
    } else {
      // No cache (e.g. sim was already running before mount) — fall back to
      // a fit-to-all-units pass so the operator sees the full picture.
      fitToAllUnits();
    }
    // Belt-and-suspenders: explicitly trigger a resize on the map so the
    // canvas honours any drawer-close that happened in the same React tick.
    try { map.resize(); } catch { /* tolerant */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simResolveSignal]);

  // Fit-bounds helper — computes a bounding box covering every unit marker
  // and ECP and zooms the map so all of them are in viewport with a small
  // padding. Honours drawer state so the right-edge ECP isn't clipped.
  const fitToAllUnits = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const points: Array<[number, number]> = [];
    for (const u of units) {
      const homeId = UNIT_BUILDING[u.unit];
      const home = homeId ? buildingById.get(homeId) : undefined;
      const lat = home?.lat ?? null;
      const lon = home?.lon ?? null;
      if (lat != null && lon != null) points.push([lon, lat]);
    }
    for (const e of ecps) {
      if (e.lat != null && e.lon != null) points.push([e.lon, e.lat]);
    }
    if (points.length < 2) return;
    let minLon = +Infinity, maxLon = -Infinity, minLat = +Infinity, maxLat = -Infinity;
    for (const [lon, lat] of points) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    try {
      map.fitBounds(
        [[minLon, minLat], [maxLon, maxLat]],
        {
          padding: drawerOpen
            ? { top: 80, bottom: 80, left: 80, right: 420 }
            : { top: 80, bottom: 80, left: 80, right: 80 },
          duration: 700,
          maxZoom: 14,
        },
      );
    } catch {
      /* tolerant — best-effort */
    }
  }, [units, ecps, buildingById, drawerOpen]);

  // First-load fit so all unit markers are in viewport at default zoom (#21).
  // Runs once after the map style finishes loading and units are available.
  useEffect(() => {
    if (initialFitDoneRef.current) return;
    const map = mapRef.current;
    if (!map) return;
    if (units.length === 0 || buildingById.size === 0) return;
    const run = () => {
      if (initialFitDoneRef.current) return;
      initialFitDoneRef.current = true;
      fitToAllUnits();
    };
    if (map.isStyleLoaded && map.isStyleLoaded()) {
      run();
    } else {
      const onLoad = () => run();
      try { map.once("load", onLoad); } catch { /* tolerant */ }
    }
  }, [units, buildingById, fitToAllUnits]);

  // Reset-view signal — fires when the operator clicks the Reset View
  // button next to the zoom controls. Always re-fits to all units AND
  // wipes any cached pre-sim viewport so a fresh sim starts cleanly.
  useEffect(() => {
    if (!resetViewSignal) return;
    preSimViewRef.current = null;
    fitToAllUnits();
  }, [resetViewSignal, fitToAllUnits]);

  // Drawer-aware reflow. When the right drawer (response or fused threats)
  // opens or closes, kick a resize so MapLibre re-measures and the
  // currently-centered point ends up in the *visible* portion of the
  // canvas. Without this the right-edge ECP "B" gets clipped behind the
  // drawer (#24).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const id = window.setTimeout(() => {
      try { map.resize(); } catch { /* tolerant */ }
    }, 80);
    return () => window.clearTimeout(id);
  }, [drawerOpen]);

  // Bump the road-label layers' minzoom so major arteries are legible at
  // the entry zoom (#22). CartoDB Dark Matter hides road labels until ~z14;
  // we drop them all to z12 so Brewster / Holcomb / Stone read on first load.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      try {
        const style = map.getStyle && map.getStyle();
        if (!style || !style.layers) return;
        for (const layer of style.layers) {
          // The CartoDB style names road label layers like
          // "highway-name-major", "road_major_label", "road-label" etc.
          // Match anything that's a symbol layer mentioning "road" or "highway".
          if (layer.type !== "symbol") continue;
          const id: string = layer.id || "";
          if (!/road|highway|street/i.test(id)) continue;
          if (!/label|name|text/i.test(id)) continue;
          // Drop minzoom so labels appear at our entry zoom (~14.7).
          map.setLayerZoomRange(id, 12, 24);
        }
      } catch {
        /* tolerant — style not ready yet */
      }
    };
    if (map.isStyleLoaded && map.isStyleLoaded()) apply();
    try { map.on("styledata", apply); } catch { /* tolerant */ }
    return () => {
      try { map.off && map.off("styledata", apply); } catch { /* tolerant */ }
    };
  }, [mapStyle]);

  // Hover handler for buildings — queries the polygon layer.
  const onMouseMove = useCallback((e: any) => {
    if (!mapRef.current) return;
    const features = e.features ?? [];
    const hit = features.find((f: any) => f.layer.id === "buildings-fill");
    if (hit) {
      const id = hit.properties.id;
      const b = buildings.find((x) => x.id === id);
      setHoverBuilding(b ?? null);
    } else {
      setHoverBuilding(null);
    }
  }, [buildings]);

  const simTarget = simActive && simTargetBuilding ? buildingById.get(simTargetBuilding) : null;

  return (
    <div className="relative h-full w-full overflow-hidden bg-[var(--color-bg)]">
      <MapGL
        ref={mapRef}
        mapStyle={mapStyle}
        // CartoDB CDN sometimes fails (AJAX 0) on cold start — retry once
        // after 500ms then fall back to the vendored solid-background style
        // so the schematic stays usable. Without this, the whole map is blank
        // on the intermittent failure.
        onError={(e: any) => {
          const msg = String(e?.error?.message || e?.message || "");
          if (/style|fetch|0/i.test(msg) && styleRetryRef.current < 1) {
            styleRetryRef.current += 1;
            window.setTimeout(() => {
              setMapStyle(MAP_STYLE);
            }, 500);
          } else if (styleRetryRef.current >= 1 && mapStyle === MAP_STYLE) {
            setMapStyle(FALLBACK_STYLE);
          }
        }}
        initialViewState={{
          longitude: centerLon,
          latitude: centerLat,
          zoom: 14.7,
          bearing: 0,
          pitch: 0,
        }}
        interactiveLayerIds={["buildings-fill"]}
        onMouseMove={onMouseMove}
        style={{ width: "100%", height: "100%" }}
      >
        {/* Cantonment perimeter — chamfered polygon below the buildings. */}
        {perimeterGeoJson && (
          <Source id="perimeter" type="geojson" data={perimeterGeoJson}>
            <Layer
              id="perimeter-fill"
              type="fill"
              paint={{
                "fill-color": "#1d2740",
                "fill-opacity": 0.18,
              }}
            />
            <Layer
              id="perimeter-outline"
              type="line"
              paint={{
                "line-color": "#3b82f6",
                "line-width": 1.4,
                "line-opacity": 0.55,
                "line-dasharray": [3, 3],
              }}
            />
          </Source>
        )}

        {/* Buildings — polygon fill + outline layer driven by GeoJSON. */}
        <Source id="buildings" type="geojson" data={buildingGeoJson}>
          <Layer
            id="buildings-fill"
            type="fill"
            paint={{
              "fill-color": ["get", "fill"],
              "fill-opacity": [
                "interpolate", ["linear"], ["zoom"],
                12, 0.55,
                15, 0.86,
                18, 0.94,
              ],
            }}
          />
          <Layer
            id="buildings-outline"
            type="line"
            paint={{
              "line-color": ["get", "stroke"],
              "line-width": ["case", ["get", "critical"], 2, 0.9],
              "line-opacity": [
                "interpolate", ["linear"], ["zoom"],
                12, 0.65,
                15, 0.95,
              ],
            }}
          />
        </Source>

        {/* Building label badges — rendered over fills, only at close zoom. */}
        <Source id="building-labels" type="geojson" data={labelGeoJson}>
          <Layer
            id="building-labels-text"
            type="symbol"
            minzoom={15.4}
            layout={{
              "text-field": ["get", "label"],
              "text-size": [
                "interpolate", ["linear"], ["zoom"],
                15.4, 9,
                17, 11,
                19, 13,
              ],
              "text-letter-spacing": 0.18,
              "text-allow-overlap": false,
              "text-padding": 2,
            }}
            paint={{
              "text-color": ["get", "stroke"],
              "text-halo-color": "#0a0c13",
              "text-halo-width": 1.4,
              "text-halo-blur": 0.4,
            }}
          />
        </Source>

        {/* ThermalHawk cordon circles — rendered as GeoJSON Point features
         * styled with a meters-accurate circle radius. MapLibre interprets
         * `circle-radius` in pixels by default, so we use a per-zoom scale. */}
        {simActive && simTarget && simCordons && simTarget.lat != null && simTarget.lon != null && (() => {
          const stLat = simTarget.lat;
          const stLon = simTarget.lon;
          return (
          <Source
            id="cordons"
            type="geojson"
            data={{
              type: "FeatureCollection",
              features: simCordons.map((cz, i): GeoJSON.Feature => ({
                type: "Feature",
                id: i,
                properties: {
                  radius_m: cz.radius_m,
                  color: cz.radius_m <= 300 ? "#ef4444" : cz.radius_m <= 500 ? "#fb923c" : "#3b82f6",
                },
                geometry: { type: "Point", coordinates: [stLon, stLat] },
              })),
            }}
          >
            <Layer
              id="cordon-rings"
              type="circle"
              paint={{
                "circle-radius": [
                  "interpolate", ["exponential", 2], ["zoom"],
                  // at zoom 10, 1 meter ≈ 0.005 px; at zoom 17, 1 m ≈ 0.65 px
                  10, ["*", ["get", "radius_m"], 0.005],
                  17, ["*", ["get", "radius_m"], 0.65],
                ],
                "circle-color": ["get", "color"],
                "circle-opacity": 0.12,
                "circle-stroke-color": ["get", "color"],
                "circle-stroke-width": 2,
                "circle-stroke-opacity": 0.78,
              }}
            />
          </Source>
          );
        })()}

        {/* Rally points */}
        {rallyPoints.filter((rp) => rp.lat != null && rp.lon != null).map((rp) => (
          <Marker
            key={rp.id}
            longitude={rp.lon!}
            latitude={rp.lat!}
            anchor="center"
            onClick={(e) => {
              e.originalEvent.stopPropagation();
              setRpSelected(rp);
            }}
          >
            <svg width="36" height="36" viewBox="-18 -18 36 36" style={{ cursor: "pointer" }}>
              <circle r="16" fill="none" stroke="#8b5cf6" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
              <circle r="7" fill="#14102a" stroke="#8b5cf6" strokeWidth="1.5" />
              <text
                x="0" y="3" textAnchor="middle"
                fontFamily="JetBrains Mono, monospace" fontSize="10" fontWeight="700"
                fill="#8b5cf6"
              >
                {rp.id.replace("RP-", "")[0]}
              </text>
            </svg>
          </Marker>
        ))}

        {/* ECPs */}
        {ecps.filter((e) => e.lat != null && e.lon != null).map((ecp) => {
          const open = ecp.status === "open";
          const color = open ? "#22c55e" : "#6b7280";
          return (
            <Marker
              key={ecp.id}
              longitude={ecp.lon!}
              latitude={ecp.lat!}
              anchor="center"
              onClick={(ev) => {
                ev.originalEvent.stopPropagation();
                setEcpSelected(ecp);
              }}
            >
              <svg width="40" height="40" viewBox="-20 -20 40 40" style={{ cursor: "pointer" }}>
                <polygon points="-16,0 -8,-14 8,-14 16,0 8,14 -8,14" fill="#0a0c13" stroke={color} strokeWidth="2" />
                <text y="-2" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="9" fontWeight="700" fill={color}>
                  {ecp.id.replace("ECP-", "")}
                </text>
                <text className="tracking-wider" y="8" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="6" fill={color}>
                  ECP
                </text>
              </svg>
            </Marker>
          );
        })}

        {/* Unit markers — MIL-STD-2525C-lite battalion rectangles */}
        {placedUnits.map(({ u, lat, lon }) => {
          const selected = selectedUnit === u.unit;
          const color = mcColor(u.mc_rate);
          return (
            <Marker
              key={u.unit}
              longitude={lon}
              latitude={lat}
              anchor="bottom"
              onClick={(ev) => {
                ev.originalEvent.stopPropagation();
                // Open the unit detail popup AND notify the parent — keeps
                // the existing dashed selection-ring behaviour while making
                // the click consistent with ECPs / rally points (which show
                // a popup on click). Reviewer caught units feeling dead.
                setUnitSelected({ u, lat, lon });
                onUnitClick?.(u.unit);
              }}
            >
              <div className="relative flex flex-col items-center" style={{ cursor: "pointer" }}>
                {/* SPIRE units are friendly. Marcus (ex-Lattice) flagged that
                 * 2525C affiliation must drive frame shape, not just color. */}
                <UnitMarkerSVG unit={u.unit} color={color} selected={selected} affiliation="friendly" />
                <div
                  className="mt-1 rounded-sm bg-[color-mix(in_oklab,#0a0c13_80%,transparent)] px-1.5 py-[1px] font-mono text-xs tabular-nums tracking-wide"
                  style={{ color }}
                >
                  {/* Precision parity (#30): one decimal everywhere. The
                   * alert body reads "MC 50.0%"; the map marker has to
                   * agree, not round to 50%. */}
                  {u.unit} · {(u.mc_rate * 100).toFixed(1)}%
                </div>
              </div>
            </Marker>
          );
        })}

        {/* Sim hostile UAS — 2525C diamond frame with red fill, sits beside
         * the existing reticle so the hostile "unit" is symbol-correct rather
         * than just a target indicator. The reticle remains as the targeting
         * cue; this is the hostile unit symbol per 2525C spec.
         * Offset slightly NE of the target so it doesn't overlap the reticle. */}
        {simActive && simTarget && simTarget.lat != null && simTarget.lon != null && (
          <Marker longitude={simTarget.lon + 0.0009} latitude={simTarget.lat + 0.0006} anchor="bottom">
            <div className="relative flex flex-col items-center" style={{ pointerEvents: "none" }}>
              <UnitMarkerSVG unit="UAS" color="#ef4444" selected={false} affiliation="hostile" />
              <div
                className="mt-1 rounded-sm bg-[color-mix(in_oklab,#0a0c13_85%,transparent)] px-1.5 py-[1px] font-mono text-xs tabular-nums tracking-wide"
                style={{ color: "#ef4444" }}
              >
                UAS · GROUP 1
              </div>
            </div>
          </Marker>
        )}

        {/* Sim target reticle */}
        {simActive && simTarget && simTarget.lat != null && simTarget.lon != null && (
          <Marker longitude={simTarget.lon} latitude={simTarget.lat} anchor="center">
            <svg width="80" height="80" viewBox="-40 -40 80 80" style={{ pointerEvents: "none" }}>
              <circle r="26" fill="none" stroke="#ef4444" strokeWidth="2" opacity="0.85" className="reticle-spin" />
              <line x1="-36" y1="0" x2="-12" y2="0" stroke="#ef4444" strokeWidth="1" />
              <line x1="12" y1="0" x2="36" y2="0" stroke="#ef4444" strokeWidth="1" />
              <line x1="0" y1="-36" x2="0" y2="-12" stroke="#ef4444" strokeWidth="1" />
              <line x1="0" y1="12" x2="0" y2="36" stroke="#ef4444" strokeWidth="1" />
              <circle r="5" fill="#ef4444" className="animate-pulse" />
            </svg>
          </Marker>
        )}

        {/* Building hover popup — follows cursor via closeOnClick=false */}
        {hoverBuilding && hoverBuilding.lat != null && hoverBuilding.lon != null && (
          <Popup
            longitude={hoverBuilding.lon}
            latitude={hoverBuilding.lat}
            closeButton={false}
            closeOnClick={false}
            anchor="bottom"
            offset={12}
            className="spire-map-popup"
          >
            <div className="rounded-sm bg-[var(--color-surface)] px-3 py-2" style={{ minWidth: 200 }}>
              <div
                className="font-mono text-xs uppercase tracking-wider"
                style={{ color: TYPE_COLOR[hoverBuilding.type]?.stroke ?? "#9ca3af" }}
              >
                {hoverBuilding.id} · {hoverBuilding.type.replace("_", " ")}
              </div>
              <div className="mt-0.5 text-base font-semibold text-[var(--color-text)]">
                {hoverBuilding.name}
              </div>
              <div className="mt-1 font-mono text-xs text-[var(--color-text-muted)]">
                {hoverBuilding.grid}
              </div>
              <div className="mt-1 font-mono text-xs text-[var(--color-text-secondary)]">
                OCC {hoverBuilding.current_occupancy}/{hoverBuilding.occupancy_capacity}
                {hoverBuilding.critical_infrastructure && (
                  <span className="ml-2 text-[var(--color-primary)]">CRIT INFRA</span>
                )}
                {hoverBuilding.hazmat_present && (
                  <span className="ml-2 text-[#fb923c]">HAZMAT</span>
                )}
              </div>
              {hoverBuilding.notes && (
                <div className="mt-1 text-xs italic text-[var(--color-text-muted)]">
                  {hoverBuilding.notes}
                </div>
              )}
            </div>
          </Popup>
        )}

        {/* ECP popup */}
        {ecpSelected && ecpSelected.lat != null && ecpSelected.lon != null && (
          <Popup
            longitude={ecpSelected.lon}
            latitude={ecpSelected.lat}
            anchor={pickAnchor(ecpSelected.lat, ecpSelected.lon, "bottom")}
            offset={18}
            maxWidth="260px"
            closeOnClick={false}
            onClose={() => setEcpSelected(null)}
          >
            <div className="rounded-sm bg-[var(--color-surface)] px-3 py-2" style={{ minWidth: 220, maxWidth: 240 }}>
              <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
                Entry Control Point
              </div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--color-text)]">
                {ecpSelected.name}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-xs">
                <div>
                  <div className="text-xs uppercase text-[var(--color-text-muted)] tracking-widest">Status</div>
                  <div style={{ color: ecpSelected.status === "open" ? "var(--color-success)" : "var(--color-text-muted)" }}>
                    {ecpSelected.status.toUpperCase()}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase text-[var(--color-text-muted)] tracking-widest">Lanes</div>
                  <div className="text-[var(--color-text)]">{ecpSelected.lanes_in}×IN · {ecpSelected.lanes_out}×OUT</div>
                </div>
              </div>
              {ecpSelected.notes && (
                <div className="mt-2 text-xs italic text-[var(--color-text-muted)]">
                  {ecpSelected.notes}
                </div>
              )}
            </div>
          </Popup>
        )}

        {/* Rally-point popup */}
        {rpSelected && rpSelected.lat != null && rpSelected.lon != null && (
          <Popup
            longitude={rpSelected.lon}
            latitude={rpSelected.lat}
            anchor={pickAnchor(rpSelected.lat, rpSelected.lon, "bottom")}
            offset={14}
            maxWidth="260px"
            closeOnClick={false}
            onClose={() => setRpSelected(null)}
          >
            <div className="rounded-sm bg-[var(--color-surface)] px-3 py-2" style={{ minWidth: 200 }}>
              <div className="font-mono text-xs uppercase text-[#8b5cf6] tracking-widest">
                Rally Point
              </div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--color-text)]">
                {rpSelected.name}
              </div>
              <div className="mt-2 font-mono text-xs text-[var(--color-text)]">
                Capacity <span className="tabular-nums">{rpSelected.capacity}</span> PAX
              </div>
              <div className="mt-1 font-mono text-xs text-[var(--color-text-muted)]">
                {rpSelected.grid}
              </div>
            </div>
          </Popup>
        )}

        {/* Unit popup — opens on click of a unit marker. Mirrors the ECP /
         * rally-point pattern; reviewer caught the unit click drawing only
         * a dashed selection ring with no detail popup. */}
        {unitSelected && (
          <Popup
            longitude={unitSelected.lon}
            latitude={unitSelected.lat}
            anchor={pickAnchor(unitSelected.lat, unitSelected.lon, "bottom")}
            offset={28}
            maxWidth="280px"
            closeOnClick={false}
            onClose={() => setUnitSelected(null)}
          >
            <div className="rounded-sm bg-[var(--color-surface)] px-3 py-2" style={{ minWidth: 220, maxWidth: 260 }}>
              <div
                className="font-mono text-xs uppercase tracking-widest"
                style={{ color: mcColor(unitSelected.u.mc_rate) }}
              >
                Unit · MC {(unitSelected.u.mc_rate * 100).toFixed(1)}%
              </div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--color-text)]">
                {unitSelected.u.unit}
              </div>
              <div className="mt-0.5 font-mono text-xs text-[var(--color-text-muted)]">
                {unitSelected.u.parent} · {unitSelected.u.location}
              </div>
              {/* MC + PMC + NMC must sum to total_equipment. Reviewer caught
               * MWSS-271 reading ASSETS 31 · MC 25 · NMC 3 (28 ≠ 31) — the
               * PMC bucket was hidden, so 3 partial-mission-capable assets
               * were uncounted. */}
              <div className="mt-2 grid grid-cols-4 gap-2 font-mono text-xs">
                <div>
                  <div className="text-xs uppercase text-[var(--color-text-muted)] tracking-widest">Assets</div>
                  <div className="tabular-nums text-[var(--color-text)]">{unitSelected.u.total_equipment}</div>
                </div>
                <div>
                  <div className="text-xs uppercase text-[var(--color-text-muted)] tracking-widest">MC</div>
                  <div className="tabular-nums text-[var(--color-success)]">{unitSelected.u.mc_count}</div>
                </div>
                <div>
                  <div className="text-xs uppercase text-[var(--color-text-muted)] tracking-widest">PMC</div>
                  <div className="tabular-nums text-[var(--color-warning)]">{unitSelected.u.pmc_count}</div>
                </div>
                <div>
                  <div className="text-xs uppercase text-[var(--color-text-muted)] tracking-widest">NMC</div>
                  <div className="tabular-nums text-[var(--color-danger)]">
                    {unitSelected.u.nmcm_count + unitSelected.u.nmcs_count}
                  </div>
                </div>
              </div>
              {(() => {
                const sum =
                  unitSelected.u.mc_count
                  + unitSelected.u.pmc_count
                  + unitSelected.u.nmcm_count
                  + unitSelected.u.nmcs_count;
                if (sum === unitSelected.u.total_equipment) return null;
                // Defensive: surface the discrepancy honestly rather than
                // silently mis-totalling. If the API ever ships data where
                // the buckets don't sum, the operator sees it.
                return (
                  <div className="mt-1 font-mono text-xs italic text-[var(--color-warning)] tracking-wide">
                    Note: MC + PMC + NMC = {sum} ≠ ASSETS {unitSelected.u.total_equipment}
                    {" "}({unitSelected.u.total_equipment - sum} unreported)
                  </div>
                );
              })()}
              {Object.keys(unitSelected.u.equipment_breakdown || {}).length > 0 && (
                <div className="mt-2">
                  <div className="text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
                    Equipment types
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {Object.entries(unitSelected.u.equipment_breakdown)
                      .slice(0, 6)
                      .map(([type, count]) => (
                        <span
                          key={type}
                          className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-[1px] font-mono text-xs text-[var(--color-text-secondary)]"
                        >
                          {type} <span className="tabular-nums text-[var(--color-text)]">{count}</span>
                        </span>
                      ))}
                  </div>
                </div>
              )}
            </div>
          </Popup>
        )}

        <NavigationControl position="top-right" showCompass showZoom />
        <ScaleControl position="bottom-right" unit="metric" maxWidth={140} />
      </MapGL>

      {/* Reset view button — sits just below MapLibre's NavigationControl on
       * the top-right. Refits the camera to all units and ECPs and clears
       * any cached pre-sim viewport. Reviewer flagged that an operator who
       * pans/zooms in the heat of an incident has no obvious way to "go
       * back to the wide picture" (#28). */}
      <button
        type="button"
        onClick={() => {
          // Use a local fitToAllUnits-equivalent path. We can't reach the
          // memoised callback directly from the render body without a ref,
          // so we replicate the fit-bounds inline here and clear the cache.
          preSimViewRef.current = null;
          const map = mapRef.current;
          if (!map) return;
          const points: Array<[number, number]> = [];
          for (const u of units) {
            const homeId = UNIT_BUILDING[u.unit];
            const home = homeId ? buildingById.get(homeId) : undefined;
            if (home && home.lat != null && home.lon != null) points.push([home.lon, home.lat]);
          }
          for (const e of ecps) {
            if (e.lat != null && e.lon != null) points.push([e.lon, e.lat]);
          }
          if (points.length < 2) return;
          let minLon = +Infinity, maxLon = -Infinity, minLat = +Infinity, maxLat = -Infinity;
          for (const [lon, lat] of points) {
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
          }
          try {
            map.fitBounds(
              [[minLon, minLat], [maxLon, maxLat]],
              {
                padding: drawerOpen
                  ? { top: 80, bottom: 80, left: 80, right: 420 }
                  : { top: 80, bottom: 80, left: 80, right: 80 },
                duration: 700,
                maxZoom: 14,
              },
            );
          } catch { /* tolerant */ }
        }}
        className="absolute right-2 z-[7] flex h-8 w-[29px] items-center justify-center rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] font-mono text-xs uppercase text-[var(--color-text)] shadow hover:bg-[var(--color-surface-hover)] tracking-widest"
        // 116px ≈ NavigationControl (56px tall) + ~10px gap + standard top-3 inset.
        style={{ top: "116px" }}
        title="Reset view — fit all units and ECPs in viewport"
        aria-label="Reset view"
      >
        ⤢
      </button>

      {/* Active-overlay legend — explains the pink cordon hatching, cyan
       * selection ring, and yellow route line so the operator doesn't
       * have to guess. Renders only when at least one overlay is active
       * (#26). Bottom-left so it doesn't fight with the scale bar. */}
      <MapLegend
        cordonActive={!!simActive && !!simCordons && simCordons.length > 0}
        selectionActive={!!selectedUnit || !!unitSelected || !!ecpSelected || !!rpSelected}
        routeActive={false}
      />
    </div>
  );
}

function MapLegend({
  cordonActive,
  selectionActive,
  routeActive,
}: {
  cordonActive: boolean;
  selectionActive: boolean;
  routeActive: boolean;
}) {
  if (!cordonActive && !selectionActive && !routeActive) return null;
  return (
    <div
      className="pointer-events-none absolute bottom-3 left-3 z-[7] rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] px-2 py-1.5 font-mono text-xs text-[var(--color-text)] shadow backdrop-blur tracking-wider"
      role="region"
      aria-label="Map legend"
    >
      <div className="mb-1 text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
        Overlay legend
      </div>
      {cordonActive && (
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-3 w-5 rounded-sm border"
            style={{
              borderColor: "#ef4444",
              background:
                "repeating-linear-gradient(45deg, color-mix(in oklab, #ef4444 25%, transparent) 0 3px, transparent 3px 6px)",
            }}
          />
          <span>Cordon (exclusion)</span>
        </div>
      )}
      {selectionActive && (
        <div className="flex items-center gap-2">
          <span
            className="inline-block h-3 w-5 rounded-sm border"
            style={{ borderColor: "#22d3ee", borderStyle: "dashed" }}
          />
          <span>Selection</span>
        </div>
      )}
      {routeActive && (
        <div className="flex items-center gap-2">
          <span className="inline-block h-[3px] w-5" style={{ background: "#eab308" }} />
          <span>Route</span>
        </div>
      )}
    </div>
  );
}
