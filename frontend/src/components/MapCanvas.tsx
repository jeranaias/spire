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

// --- Unit → home building mapping (kept in sync with InstallationSchematic
// during the transition). Eventually lives on the unit record itself.
const UNIT_BUILDING: Record<string, string> = {
  "CLB-6":        "CLB6-MP",
  "CLB-1":        "MLG-SSC",
  "3d Maint Bn":  "MLG-SSC",
  "3/6 Marines":  "TANK-MP",
  "2d LAR Bn":    "LAR-MP",
  "MALS-31":      "HH-1",
  "MWSS-372":     "DL-HQ",
  "2d LAAD Bn":   "LAAD-TOC",
  "5/10 Marines": "TOC-MAIN",
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

// --- MIL-STD-2525C-lite unit marker SVG (ported from schematic).
function UnitMarkerSVG({ unit, color, selected }: { unit: string; color: string; selected: boolean }) {
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
  const W = 56, H = 36;
  return (
    <svg
      width={W + 8}
      height={H + 18}
      viewBox={`${-(W + 8) / 2} ${-(H + 18) / 2} ${W + 8} ${H + 18}`}
      style={{ overflow: "visible", filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.7))" }}
    >
      {selected && (
        <rect
          x={-W / 2 - 6} y={-H / 2 - 6}
          width={W + 12} height={H + 12}
          fill="none" stroke={color} strokeWidth="1.5"
          strokeDasharray="5 4" opacity="0.75" rx="2"
        />
      )}
      <rect
        x={-W / 2} y={-H / 2} width={W} height={H}
        fill={`color-mix(in oklab, ${color} 25%, #0a0c13)`}
        stroke={color}
        strokeWidth={selected ? 3 : 2}
        rx="1"
      />
      <circle cx="-6" cy={-H / 2 - 5} r="1.8" fill={color} />
      <circle cx="6"  cy={-H / 2 - 5} r="1.8" fill={color} />
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
}: MapCanvasProps) {
  const mapRef = useRef<any>(null);
  const [hoverBuilding, setHoverBuilding] = useState<Building | null>(null);
  const [ecpSelected, setEcpSelected] = useState<ECP | null>(null);
  const [rpSelected, setRpSelected] = useState<RallyPoint | null>(null);

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

  // Fly to the sim target when the sim fires.
  useEffect(() => {
    if (!simActive || !simTargetBuilding || !mapRef.current) return;
    const b = buildingById.get(simTargetBuilding);
    if (!b || b.lat == null || b.lon == null) return;
    mapRef.current.flyTo({ center: [b.lon, b.lat], zoom: 17, duration: 1200 });
  }, [simActive, simTargetBuilding, buildingById]);

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
        mapStyle={MAP_STYLE}
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
                onUnitClick?.(u.unit);
              }}
            >
              <div className="relative flex flex-col items-center" style={{ cursor: "pointer" }}>
                <UnitMarkerSVG unit={u.unit} color={color} selected={selected} />
                <div
                  className="mt-1 rounded-sm bg-[color-mix(in_oklab,#0a0c13_80%,transparent)] px-1.5 py-[1px] font-mono text-xs tabular-nums tracking-wide"
                  style={{ color }}
                >
                  {u.unit} · {Math.round(u.mc_rate * 100)}%
                </div>
              </div>
            </Marker>
          );
        })}

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
            anchor="bottom"
            offset={18}
            closeOnClick={false}
            onClose={() => setEcpSelected(null)}
          >
            <div className="rounded-sm bg-[var(--color-surface)] px-3 py-2" style={{ minWidth: 220 }}>
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
            anchor="bottom"
            offset={14}
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

        <NavigationControl position="top-right" showCompass showZoom />
        <ScaleControl position="bottom-right" unit="metric" maxWidth={140} />
      </MapGL>
    </div>
  );
}
