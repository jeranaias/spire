/**
 * InstallationSchematic — hand-drawn blueprint view of Camp Henderson.
 *
 * Replaces the off-the-shelf Leaflet world map with a purpose-built SVG
 * schematic. Buildings come from /bastion/cop's `buildings[]` array (MGRS
 * easting/northing in the `grid` field). We project directly from MGRS
 * into SVG user-space: 1 SVG unit = 1 meter. The viewBox is centred on
 * the installation footprint and padded with perimeter & context.
 *
 * This view is deliberately NOT a map. It's a CAD plan. Unit dots land on
 * the *building* they occupy — CLB-6 sits on the CLB-6 Motor Pool — so
 * placement is intentional instead of randomly offset lat/lon.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Building, ECP, RallyPoint, BastionCOPUnit } from "../api";

// ---------------------------------------------------------------------------
// MGRS helpers — pull easting/northing out of grid strings like
// "18S UJ 30120 70340" → {e: 30120, n: 70340}.
// ---------------------------------------------------------------------------
function parseGrid(grid: string): { e: number; n: number } | null {
  const parts = grid.trim().split(/\s+/);
  // Expect ["18S", "UJ", "EEEEE", "NNNNN"]
  if (parts.length < 4) return null;
  const e = parseInt(parts[parts.length - 2], 10);
  const n = parseInt(parts[parts.length - 1], 10);
  if (Number.isNaN(e) || Number.isNaN(n)) return null;
  return { e, n };
}

// Schematic bounds — padded outside the buildings so perimeter + off-base
// context have room. Easting grows east, northing grows north, so when we
// project to SVG we keep X but FLIP Y.
const BOUNDS = {
  eMin: 27200,
  eMax: 33400,
  nMin: 69200,
  nMax: 72600,
};
const WIDTH = BOUNDS.eMax - BOUNDS.eMin; // 6200 m
const HEIGHT = BOUNDS.nMax - BOUNDS.nMin; // 3400 m

function project(grid: string): { x: number; y: number } | null {
  const en = parseGrid(grid);
  if (!en) return null;
  return {
    x: en.e - BOUNDS.eMin,
    y: BOUNDS.nMax - en.n,
  };
}

// ---------------------------------------------------------------------------
// Type → visual rules. Buildings are rendered as typed rectangles.
// Widths/heights are chosen to *read* instead of being dimensionally faithful.
// ---------------------------------------------------------------------------
type TypeStyle = {
  w: number;
  h: number;
  fill: string;
  stroke: string;
  label: string;
};

// Palette deduped 2026-04-24 per adversarial review:
// - admin/billeting/housing/support/utility collapse to 2 grey tones (admin-grey, quiet-grey)
// - ASP (ammunition) vs ARMS (arms_storage) both remain red but ARMS adds a
//   dashed stroke so they're distinguishable at a glance
// - fuel + hazmat share amber-orange since both are HAZMAT-Class
const STROKE_ADMIN_GREY = "#9ca3af";
const STROKE_QUIET_GREY = "#6b7280";
const TYPE_STYLES: Record<string, TypeStyle> = {
  motor_pool:     { w: 260, h: 140, fill: "#3b2410", stroke: "#f59e0b", label: "MP"    },
  ammunition:     { w:  80, h:  60, fill: "#2a1212", stroke: "#ef4444", label: "ASP"   },
  arms_storage:   { w:  70, h:  50, fill: "#241010", stroke: "#ef4444", label: "ARMS"  },
  hazmat:         { w:  90, h:  60, fill: "#2a1d10", stroke: "#fb923c", label: "HAZ"   },
  fuel:           { w: 120, h:  80, fill: "#2d1e0b", stroke: "#fb923c", label: "POL"   },
  tactical:       { w: 110, h:  70, fill: "#0f1a2e", stroke: "#3b82f6", label: "TOC"   },
  admin:          { w:  90, h:  60, fill: "#141a28", stroke: STROKE_ADMIN_GREY, label: "ADM"   },
  billeting:      { w: 130, h:  50, fill: "#141822", stroke: STROKE_QUIET_GREY, label: "BR"    },
  housing:        { w: 180, h: 110, fill: "#161a24", stroke: STROKE_QUIET_GREY, label: "FAM"   },
  support:        { w: 100, h:  60, fill: "#141822", stroke: STROKE_QUIET_GREY, label: "SUP"   },
  medical:        { w: 100, h:  70, fill: "#0f1f14", stroke: "#22c55e", label: "MED"   },
  emergency:      { w:  90, h:  60, fill: "#1f1010", stroke: "#ef4444", label: "EMR"   },
  supply:         { w: 170, h:  90, fill: "#1a1710", stroke: "#eab308", label: "SSA"   },
  communications: { w:  70, h:  50, fill: "#17102a", stroke: "#8b5cf6", label: "COMM"  },
  aviation:       { w: 200, h: 130, fill: "#14102a", stroke: "#8b5cf6", label: "AIR"   },
  training:       { w: 500, h: 120, fill: "#101814", stroke: "#84cc16", label: "RNG"   },
  utility:        { w:  60, h:  50, fill: "#141822", stroke: STROKE_QUIET_GREY, label: "UTL"   },
  maintenance:    { w: 160, h:  90, fill: "#201808", stroke: "#eab308", label: "MX"    },
};

// Building types that get a dashed stroke to distinguish them from their
// same-colour siblings. arms_storage vs ammunition is the key disambiguation.
const DASHED_STROKE = new Set(["arms_storage"]);

function styleForType(t: string): TypeStyle {
  return TYPE_STYLES[t] || TYPE_STYLES.admin;
}

// Hand-picked arteries — installation road skeleton. Given in MGRS grid
// coords (raw e/n), then projected per segment.
const ROADS: { name: string; pts: [number, number][] }[] = [
  { name: "Main Cantonment Loop",
    pts: [
      [29200, 69800], // ECP-1 / Main Gate
      [29500, 70250],
      [29900, 70700],
      [30050, 71200],
      [29900, 71600],
      [29500, 71900],
      [28800, 72100],
      [28100, 72200], // ECP-2 / Piney Green
    ] },
  { name: "West Cantonment Artery",
    pts: [
      [28100, 72200],
      [28300, 71500],
      [28400, 71100],
      [28500, 70700],
      [28200, 70400],
      [27950, 70480], // Tank MP
    ] },
  { name: "MLG Sector Road",
    pts: [
      [29200, 70500],
      [28700, 70700],
      [28500, 70800],
      [28300, 70900],
      [28100, 70900], // ESB
    ] },
  { name: "Airfield Taxi",
    pts: [
      [29500, 70400],
      [29400, 70250],
      [29358, 70161], // Ramp/apron — terminates BEFORE the runway centerline
    ] },
  { name: "East Industrial Road",
    pts: [
      [30200, 70500],
      [30700, 70900],
      [31100, 71200],
      [30800, 71400],
      [30750, 71460],
      [30820, 71400],
    ] },
  { name: "Range Connector",
    pts: [
      [31900, 69900], // ECP-3
      [32500, 69800],
      [32800, 69600],
      [32950, 69480], // RANGE-2
    ] },
  { name: "Housing Road",
    pts: [
      [30000, 71500],
      [30800, 71700],
      [31400, 71800],
      [31800, 71900],
      [32100, 71700],
    ] },
  { name: "ASP Service Road",
    pts: [
      [30700, 71200],
      [30840, 71620], // ASP-1
      [30920, 71680],
      [30780, 71550],
    ] },
];

// Installation perimeter — irregular hexagon around the footprint.
const PERIMETER: [number, number][] = [
  [27400, 72400],
  [29200, 72500],
  [32500, 72400],
  [33200, 71800],
  [33100, 69400],
  [31800, 69300],
  [29100, 69600],
  [27500, 69900],
];

// Airfield — a single runway strip oriented NW-SE near HH-1.
const RUNWAY: { x: number; y: number; w: number; h: number; rotation: number } = {
  x: 29270,
  y: 70080,
  w: 900,
  h: 40,
  rotation: -30,
};

// Unit → building mapping. Units that don't have an exact building land on
// the closest sensible one (their parent HQ or related MP).
const UNIT_BUILDING: Record<string, string> = {
  "CLB-6":        "CLB6-MP",
  "CLB-1":        "MLG-SSC",   // Shared MLG area (actual home station: Pendleton)
  "3d Maint Bn":  "MLG-SSC",
  "2d Tank Bn":   "TANK-MP",
  "2d LAR Bn":    "LAR-MP",
  "MALS-31":      "HH-1",
  "MWSS-372":     "DL-HQ",
  "2d LAAD Bn":   "LAAD-TOC",
  "5/11 Marines": "TOC-MAIN",
  "7th ESB":      "ESB-WS",
};

// ---------------------------------------------------------------------------
// Interaction: pan + zoom by mutating a viewBox transform.
// Minimal local state — no external libraries.
// ---------------------------------------------------------------------------
interface Transform {
  scale: number;
  tx: number; // translate in SVG user-space units
  ty: number;
}
// Auto-fit: centred on the main cantonment where the units live.
// Building footprint is roughly E 27950–32950, N 69480–72200, but the cantonment
// cluster — where the 10 unit markers sit — is a tighter box around
// (29500, 70950). We fit that box so the first screen is dense with info
// instead of showing mostly empty perimeter.
const FIT_SCALE = 2.2;
const FIT_CENTROID = { x: 29500 - BOUNDS.eMin, y: BOUNDS.nMax - 70950 };
const INITIAL_T: Transform = (() => {
  // Place centroid at center of viewport: centroid_x = (WIDTH/scale)/2 - tx
  const tx = (WIDTH / FIT_SCALE) / 2 - FIT_CENTROID.x;
  const ty = (HEIGHT / FIT_SCALE) / 2 - FIT_CENTROID.y;
  return { scale: FIT_SCALE, tx, ty };
})();
const MIN_SCALE = 0.45;
const MAX_SCALE = 6;

// Cursor-anchored zoom utility used by the HUD buttons. The wheel-zoom
// (see onWheel below) already anchors on cursor position; this helper does
// the equivalent for the +/- buttons by computing the current viewport
// centre in unit-space, then re-solving tx/ty after the scale change so the
// centre point stays fixed. Without this, repeated + clicks walked the
// schematic off the viewport into empty grid — demo-killer documented in
// the 2026-04-24 adversarial review.
function zoomAroundCenter(setT: (fn: (t: Transform) => Transform) => void, factor: number) {
  setT((prev) => {
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev.scale * factor));
    if (newScale === prev.scale) return prev;
    // viewBox is computed as (vbX = -tx, vbY = -ty, vbW = WIDTH/scale).
    // Centre in unit-space: cx = -tx + vbW/2; after zoom we want the same cx.
    const cx = -prev.tx + (WIDTH / prev.scale) / 2;
    const cy = -prev.ty + (HEIGHT / prev.scale) / 2;
    const newTx = (WIDTH / newScale) / 2 - cx;
    const newTy = (HEIGHT / newScale) / 2 - cy;
    return { scale: newScale, tx: newTx, ty: newTy };
  });
}

function mcColor(rate: number): string {
  if (rate >= 0.90) return "#22c55e";
  if (rate >= 0.75) return "#eab308";
  if (rate >= 0.60) return "#fb923c";
  return "#ef4444";
}

// MIL-STD-2525C-lite branch modifier inside the unit frame.
// Returns an SVG element reflecting the unit's functional area — close
// enough to the doctrinal symbology that a Marine judge doesn't read
// the COP as "game UI" but simple enough that we're not maintaining the
// full 2525C symbol set.
function unitModifier(unitName: string): (color: string) => React.ReactElement {
  const n = unitName.toLowerCase();
  // Motor transport / combat logistics battalions — wheeled supply symbol
  if (n.includes("clb") || n.includes("lvsr") || n.includes("esb")) {
    return (color) => (
      <g>
        {/* Wheeled supply "T" trailer modifier */}
        <path d="M -10 -4 L 10 -4 M 0 -4 L 0 6" stroke={color} strokeWidth="1.6" fill="none" />
        <circle cx="-6" cy="8" r="2" fill={color} />
        <circle cx="0"  cy="8" r="2" fill={color} />
        <circle cx="6"  cy="8" r="2" fill={color} />
      </g>
    );
  }
  // Maintenance battalion — wrench modifier
  if (n.includes("maint")) {
    return (color) => (
      <g>
        <path d="M -8 -4 L 8 -4" stroke={color} strokeWidth="1.6" />
        <path d="M -4 2 L 4 2 M 0 2 L 0 6" stroke={color} strokeWidth="1.4" />
        <circle cx="-4" cy="2" r="2" fill="none" stroke={color} strokeWidth="1.2" />
      </g>
    );
  }
  // Tank battalion — armor oval
  if (n.includes("tank")) {
    return (color) => (
      <ellipse cx="0" cy="0" rx="14" ry="7" fill="none" stroke={color} strokeWidth="1.8" />
    );
  }
  // Light Armored Reconnaissance — diagonal slash (recon)
  if (n.includes("lar")) {
    return (color) => (
      <path d="M -12 6 L 12 -6" stroke={color} strokeWidth="1.8" />
    );
  }
  // Air Defense — arrow up
  if (n.includes("laad") || n.includes("ada")) {
    return (color) => (
      <path d="M 0 6 L 0 -6 M -5 -2 L 0 -7 L 5 -2" stroke={color} strokeWidth="1.6" fill="none" />
    );
  }
  // Aviation (fixed or rotary wing) — wing shape
  if (n.includes("mals") || n.includes("mwss") || n.includes("helo")) {
    return (color) => (
      <path d="M -12 0 L -4 -4 L 0 -4 L 4 -4 L 12 0 L 4 4 L -4 4 Z" fill="none" stroke={color} strokeWidth="1.4" />
    );
  }
  // Artillery — filled dot (cannon ball)
  if (n.includes("marines") || n.includes("hab") || n.includes("himars")) {
    return (color) => (
      <circle r="5" fill={color} />
    );
  }
  // Default — simple dot
  return (color) => (<circle r="3" fill={color} />);
}

// ---------------------------------------------------------------------------
export interface SchematicProps {
  buildings: Building[];
  units: BastionCOPUnit[];
  ecps: ECP[];
  rallyPoints: RallyPoint[];
  selectedUnit?: string | null;
  onUnitClick?: (unitName: string) => void;
  // Alert-driven fly-to: caller passes a building id (or unit-mapped id) when
  // the operator wants the viewport to centre on a specific location. Each
  // distinct value triggers a fresh ease animation.
  flyToBuilding?: string | null;
  // ThermalHawk simulation overlay
  simActive?: boolean;
  simTargetBuilding?: string;
  simCordons?: { radius_m: number; label: string }[];
}

export function InstallationSchematic({
  buildings,
  units,
  ecps,
  rallyPoints,
  selectedUnit,
  onUnitClick,
  flyToBuilding,
  simActive,
  simTargetBuilding,
  simCordons,
}: SchematicProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [t, setT] = useState<Transform>(INITIAL_T);
  const [hoverId, setHoverId] = useState<string | null>(null);
  // Cursor position (container-relative) used to anchor the hover card next
  // to whatever building the operator is hovering over.
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  // ECP click inspector — state isolated from the hover card since ECPs are
  // not buildings.
  const [ecpSelected, setEcpSelected] = useState<ECP | null>(null);
  // Rally point click state — same pattern, separate channel.
  const [rpSelected, setRpSelected] = useState<RallyPoint | null>(null);
  const panRef = useRef<{ startX: number; startY: number; baseTx: number; baseTy: number } | null>(null);

  // Pan via mouse drag
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    panRef.current = { startX: e.clientX, startY: e.clientY, baseTx: t.tx, baseTy: t.ty };
  }, [t.tx, t.ty]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!panRef.current || !svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      // Convert pixel delta → SVG user-units (accounting for current scale & viewport fit)
      const unitsPerPixelX = (WIDTH / t.scale) / rect.width;
      const unitsPerPixelY = (HEIGHT / t.scale) / rect.height;
      const dxPx = e.clientX - panRef.current.startX;
      const dyPx = e.clientY - panRef.current.startY;
      setT((prev) => ({
        ...prev,
        tx: panRef.current!.baseTx + dxPx * unitsPerPixelX,
        ty: panRef.current!.baseTy + dyPx * unitsPerPixelY,
      }));
    }
    function onUp() { panRef.current = null; }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [t.scale]);

  // Wheel → zoom around cursor
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Point under cursor in unit space (before zoom)
    const ux = (mx / rect.width) * (WIDTH / t.scale) - t.tx;
    const uy = (my / rect.height) * (HEIGHT / t.scale) - t.ty;
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, t.scale * factor));
    // Re-solve translate so the point under cursor stays put
    const newTx = (mx / rect.width) * (WIDTH / newScale) - ux;
    const newTy = (my / rect.height) * (HEIGHT / newScale) - uy;
    setT({ scale: newScale, tx: newTx, ty: newTy });
  }, [t]);

  // Keyboard: +/- zoom, arrow pan, 0 reset
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const step = 300 / t.scale;
      if (e.key === "=" || e.key === "+") { setT((p) => ({ ...p, scale: Math.min(MAX_SCALE, p.scale * 1.2) })); }
      else if (e.key === "-" || e.key === "_") { setT((p) => ({ ...p, scale: Math.max(MIN_SCALE, p.scale / 1.2) })); }
      else if (e.key === "0")   { setT(INITIAL_T); }
      else if (e.key === "ArrowUp")    { setT((p) => ({ ...p, ty: p.ty + step })); }
      else if (e.key === "ArrowDown")  { setT((p) => ({ ...p, ty: p.ty - step })); }
      else if (e.key === "ArrowLeft")  { setT((p) => ({ ...p, tx: p.tx + step })); }
      else if (e.key === "ArrowRight") { setT((p) => ({ ...p, tx: p.tx - step })); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t.scale]);

  // Precompute projected building positions
  const placedBuildings = useMemo(() => {
    return buildings
      .map((b) => {
        const p = project(b.grid);
        if (!p) return null;
        const s = styleForType(b.type);
        return {
          b,
          style: s,
          // Rectangle centred on the projected point
          rx: p.x - s.w / 2,
          ry: p.y - s.h / 2,
          cx: p.x,
          cy: p.y,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [buildings]);

  const buildingById = useMemo(() => {
    const m = new Map<string, (typeof placedBuildings)[number]>();
    placedBuildings.forEach((pb) => m.set(pb.b.id, pb));
    return m;
  }, [placedBuildings]);

  // Units with their anchor position on the schematic
  const placedUnits = useMemo(() => {
    return units.map((u) => {
      const buildingId = UNIT_BUILDING[u.unit];
      const pb = buildingId ? buildingById.get(buildingId) : undefined;
      // Fallback: if no building match, drop unit at installation center
      const cx = pb ? pb.cx : WIDTH / 2;
      const cy = pb ? pb.cy - (pb.style.h / 2) - 40 : HEIGHT / 2; // offset above building
      return { u, cx, cy, buildingId };
    });
  }, [units, buildingById]);

  const simTargetPos = useMemo(() => {
    if (!simActive || !simTargetBuilding) return null;
    const pb = buildingById.get(simTargetBuilding);
    return pb ? { x: pb.cx, y: pb.cy } : null;
  }, [simActive, simTargetBuilding, buildingById]);

  // When the sim kicks in, ease the viewport toward the target building.
  // Animates over ~1s with a quadratic ease-out so the drone-detected
  // building sits front-and-centre by the time the cordons drop.
  const simTargetKey = simActive ? simTargetBuilding : null;
  useEffect(() => {
    if (!simTargetKey || !simTargetPos) return;
    const startT = { ...t };
    const targetScale = 3.2;
    const targetTx = (WIDTH / targetScale) / 2 - simTargetPos.x;
    const targetTy = (HEIGHT / targetScale) / 2 - simTargetPos.y;
    const duration = 900;
    const started = performance.now();
    let raf = 0;
    function step(ts: number) {
      const k = Math.min(1, (ts - started) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setT({
        scale: startT.scale + (targetScale - startT.scale) * eased,
        tx: startT.tx + (targetTx - startT.tx) * eased,
        ty: startT.ty + (targetTy - startT.ty) * eased,
      });
      if (k < 1) raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simTargetKey]);

  // Alert-driven fly-to — same ease as the sim but at a softer zoom (2.4×).
  // Skip when a sim is active so we don't fight the sim's cinematic pan.
  useEffect(() => {
    if (!flyToBuilding || simActive) return;
    const pb = buildingById.get(flyToBuilding);
    if (!pb) return;
    const startT = { ...t };
    const targetScale = 2.4;
    const targetTx = (WIDTH / targetScale) / 2 - pb.cx;
    const targetTy = (HEIGHT / targetScale) / 2 - pb.cy;
    const duration = 700;
    const started = performance.now();
    let raf = 0;
    function step(ts: number) {
      const k = Math.min(1, (ts - started) / duration);
      const eased = 1 - Math.pow(1 - k, 3);
      setT({
        scale: startT.scale + (targetScale - startT.scale) * eased,
        tx: startT.tx + (targetTx - startT.tx) * eased,
        ty: startT.ty + (targetTy - startT.ty) * eased,
      });
      if (k < 1) raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyToBuilding]);

  // Viewport calculation — apply transform on the inner <g>
  const vbX = -t.tx;
  const vbY = -t.ty;
  const vbW = WIDTH / t.scale;
  const vbH = HEIGHT / t.scale;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-[var(--color-bg)]"
      onMouseMove={(e) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) setCursorPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }}
    >
      <svg
        ref={svgRef}
        className="absolute inset-0 h-full w-full cursor-grab active:cursor-grabbing"
        viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseDown={onMouseDown}
        onWheel={onWheel}
      >
        <defs>
          <pattern id="blueprint-grid" width="100" height="100" patternUnits="userSpaceOnUse">
            <path d="M 100 0 L 0 0 0 100" fill="none" stroke="rgba(59,130,246,0.05)" strokeWidth="1" />
          </pattern>
          <pattern id="blueprint-grid-major" width="500" height="500" patternUnits="userSpaceOnUse">
            <path d="M 500 0 L 0 0 0 500" fill="none" stroke="rgba(59,130,246,0.12)" strokeWidth="2" />
          </pattern>
          <pattern id="runway-stripes" width="60" height="40" patternUnits="userSpaceOnUse" patternTransform={`rotate(${RUNWAY.rotation})`}>
            <rect width="60" height="40" fill="#1a1d2a" />
            <rect x="26" y="14" width="8" height="12" fill="#9ca3af" opacity="0.4" />
          </pattern>
          <radialGradient id="sim-cordon-gradient" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.18" />
            <stop offset="70%" stopColor="#ef4444" stopOpacity="0.03" />
            <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
          </radialGradient>
          <filter id="building-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
        </defs>

        {/* Layer 0: grid substrate */}
        <rect x={BOUNDS.eMin - BOUNDS.eMin} y={0} width={WIDTH} height={HEIGHT} fill="url(#blueprint-grid)" />
        <rect x={BOUNDS.eMin - BOUNDS.eMin} y={0} width={WIDTH} height={HEIGHT} fill="url(#blueprint-grid-major)" />

        {/* Layer 1: installation perimeter — bold blueprint-blue, with a
         * 1.2s trace-in reveal on mount so the COP visibly "initializes". */}
        <polygon
          points={PERIMETER.map(([e, n]) => `${e - BOUNDS.eMin},${BOUNDS.nMax - n}`).join(" ")}
          fill="rgba(15,26,46,0.35)"
          stroke="#3b82f6"
          strokeWidth="4"
          strokeLinejoin="round"
          opacity="0.9"
        />
        <polygon
          className="perimeter-trace"
          points={PERIMETER.map(([e, n]) => `${e - BOUNDS.eMin},${BOUNDS.nMax - n}`).join(" ")}
          fill="none"
          stroke="#60a5fa"
          strokeWidth="2"
          strokeDasharray="6000"
          strokeDashoffset="6000"
          opacity="0.9"
        />
        {/* Perimeter highlight (static, sits below the trace for ambient dash) */}
        <polygon
          points={PERIMETER.map(([e, n]) => `${e - BOUNDS.eMin},${BOUNDS.nMax - n}`).join(" ")}
          fill="none"
          stroke="#60a5fa"
          strokeWidth="1"
          strokeDasharray="40 20"
          opacity="0.3"
        />

        {/* Layer 2: airfield runway + taxi */}
        <g transform={`translate(${RUNWAY.x - BOUNDS.eMin},${BOUNDS.nMax - RUNWAY.y}) rotate(${RUNWAY.rotation})`}>
          <rect
            x={-RUNWAY.w / 2}
            y={-RUNWAY.h / 2}
            width={RUNWAY.w}
            height={RUNWAY.h}
            fill="url(#runway-stripes)"
            stroke="#4b5563"
            strokeWidth="1"
            rx="2"
          />
          <line x1={-RUNWAY.w / 2 + 20} y1={0} x2={RUNWAY.w / 2 - 20} y2={0} stroke="#9ca3af" strokeWidth="1" strokeDasharray="30 20" opacity="0.5" />
        </g>

        {/* Layer 3: roads — each artery gets a labeled textPath for CAD read. */}
        {ROADS.map((r, i) => {
          const pathId = `road-${i}`;
          const d = r.pts
            .map(([e, n], idx) => `${idx === 0 ? "M" : "L"} ${e - BOUNDS.eMin} ${BOUNDS.nMax - n}`)
            .join(" ");
          return (
            <g key={i}>
              <defs>
                <path id={pathId} d={d} />
              </defs>
              <path d={d} fill="none" stroke="#2a3042" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round" />
              <path d={d} fill="none" stroke="#1a1e2e" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
              <path d={d} fill="none" stroke="#3b82f6" strokeWidth="0.5" strokeDasharray="8 12" opacity="0.25" strokeLinecap="round" />
              {/* Only label the two main arteries — others would read as noise */}
              {(r.name === "Main Cantonment Loop" || r.name === "East Industrial Road" || r.name === "Range Connector") && (
                <text fontFamily="JetBrains Mono, monospace" fontSize="11" fill="#6b7280" style={{ letterSpacing: "0.24em", pointerEvents: "none" }}>
                  <textPath href={`#${pathId}`} startOffset="18%">
                    {r.name.toUpperCase()}
                  </textPath>
                </text>
              )}
            </g>
          );
        })}
        {/* Runway designation — 09/27 magnetic heading */}
        <g
          transform={`translate(${RUNWAY.x - BOUNDS.eMin},${BOUNDS.nMax - RUNWAY.y}) rotate(${RUNWAY.rotation})`}
          style={{ pointerEvents: "none" }}
        >
          <text
            x={-RUNWAY.w / 2 + 30}
            y="5"
            fontFamily="JetBrains Mono, monospace"
            fontSize="16"
            fontWeight="700"
            fill="#9ca3af"
            style={{ letterSpacing: "0.14em" }}
          >
            27
          </text>
          <text
            x={RUNWAY.w / 2 - 60}
            y="5"
            fontFamily="JetBrains Mono, monospace"
            fontSize="16"
            fontWeight="700"
            fill="#9ca3af"
            style={{ letterSpacing: "0.14em" }}
          >
            09
          </text>
        </g>

        {/* Layer 4: rally points — click to inspect capacity / staffing */}
        {rallyPoints.map((rp) => {
          const p = project(rp.grid);
          if (!p) return null;
          const isSelected = rpSelected?.id === rp.id;
          return (
            <g
              key={rp.id}
              transform={`translate(${p.x},${p.y})`}
              style={{ cursor: "pointer" }}
              onClick={(e) => {
                e.stopPropagation();
                setRpSelected(rpSelected?.id === rp.id ? null : rp);
              }}
            >
              <circle r="24" fill="none" stroke="#8b5cf6" strokeWidth="1" strokeDasharray="4 4" opacity={isSelected ? 0.9 : 0.5} />
              <circle r="8" fill="#14102a" stroke="#8b5cf6" strokeWidth={isSelected ? 2 : 1.5} />
              <text
                x="0"
                y="3"
                textAnchor="middle"
                fill="#8b5cf6"
                fontFamily="JetBrains Mono, monospace"
                fontSize="10"
                fontWeight="600"
                style={{ pointerEvents: "none" }}
              >
                {rp.id.replace("RP-", "")[0]}
              </text>
            </g>
          );
        })}

        {/* Layer 5: buildings */}
        {placedBuildings.map((pb) => {
          const { b, style, rx, ry, cx, cy } = pb;
          const isHover = hoverId === b.id;
          const isCritical = b.critical_infrastructure;
          return (
            <g
              key={b.id}
              style={{ cursor: "pointer" }}
              onMouseEnter={() => setHoverId(b.id)}
              onMouseLeave={() => setHoverId(null)}
            >
              {/* Shadow */}
              <rect
                x={rx + 2}
                y={ry + 3}
                width={style.w}
                height={style.h}
                fill="rgba(0,0,0,0.5)"
                rx="2"
              />
              {/* Body — dashed stroke for arms_storage to distinguish from ASP ammo */}
              <rect
                x={rx}
                y={ry}
                width={style.w}
                height={style.h}
                fill={style.fill}
                stroke={style.stroke}
                strokeWidth={isCritical ? 1.5 : 0.8}
                strokeDasharray={DASHED_STROKE.has(b.type) ? "4 3" : undefined}
                opacity={isHover ? 1 : 0.92}
                rx="2"
              />
              {/* Critical infrastructure corner marks */}
              {isCritical && (
                <>
                  <path d={`M ${rx} ${ry + 10} L ${rx} ${ry} L ${rx + 10} ${ry}`} stroke={style.stroke} strokeWidth="2" fill="none" />
                  <path d={`M ${rx + style.w - 10} ${ry} L ${rx + style.w} ${ry} L ${rx + style.w} ${ry + 10}`} stroke={style.stroke} strokeWidth="2" fill="none" />
                  <path d={`M ${rx + style.w} ${ry + style.h - 10} L ${rx + style.w} ${ry + style.h} L ${rx + style.w - 10} ${ry + style.h}`} stroke={style.stroke} strokeWidth="2" fill="none" />
                  <path d={`M ${rx + 10} ${ry + style.h} L ${rx} ${ry + style.h} L ${rx} ${ry + style.h - 10}`} stroke={style.stroke} strokeWidth="2" fill="none" />
                </>
              )}
              {/* Hazmat warning */}
              {b.hazmat_present && (
                <g transform={`translate(${rx + style.w - 14},${ry + 14})`}>
                  <polygon points="0,-6 5,3 -5,3" fill="#fb923c" stroke="#0a0c13" strokeWidth="0.5" />
                  <text y="2" textAnchor="middle" fontSize="6" fill="#0a0c13" fontFamily="JetBrains Mono, monospace" fontWeight="700">!</text>
                </g>
              )}
              {/* Label — font sized to box width so wide buildings (ranges,
               * housing) don't end up with a stamp-sized ID. */}
              <text
                x={cx}
                y={cy + 3}
                textAnchor="middle"
                fontFamily="JetBrains Mono, monospace"
                fontSize={
                  style.w > 400 ? 22 :
                  style.w > 200 ? 16 :
                  style.w > 150 ? 13 :
                  style.w > 100 ? 11 :
                                  10
                }
                fontWeight="700"
                fill={style.stroke}
                style={{ letterSpacing: "0.1em", pointerEvents: "none" }}
              >
                {b.id}
              </text>
              {/* Sub-label on hover or larger buildings */}
              {(style.w > 180 || isHover) && (
                <text
                  x={cx}
                  y={cy + (style.w > 400 ? 24 : 18)}
                  textAnchor="middle"
                  fontFamily="JetBrains Mono, monospace"
                  fontSize={style.w > 400 ? 10 : 8}
                  fill="#9ca3af"
                  style={{ letterSpacing: "0.08em", pointerEvents: "none" }}
                >
                  {b.name}
                </text>
              )}
            </g>
          );
        })}

        {/* Layer 6: ECPs — click to inspect */}
        {ecps.map((ecp) => {
          const p = project(ecp.grid);
          if (!p) return null;
          const isOpen = ecp.status === "open";
          const color = isOpen ? "#22c55e" : "#6b7280";
          const isSelected = ecpSelected?.id === ecp.id;
          return (
            <g
              key={ecp.id}
              transform={`translate(${p.x},${p.y})`}
              style={{ cursor: "pointer" }}
              onClick={(e) => {
                e.stopPropagation();
                setEcpSelected(ecpSelected?.id === ecp.id ? null : ecp);
              }}
            >
              {/* Selection halo */}
              {isSelected && (
                <polygon
                  points="-24,0 -12,-22 12,-22 24,0 12,22 -12,22"
                  fill="none"
                  stroke={color}
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  opacity="0.8"
                />
              )}
              {/* Hex gate glyph */}
              <polygon
                points="-18,0 -9,-16 9,-16 18,0 9,16 -9,16"
                fill="#0a0c13"
                stroke={color}
                strokeWidth="2"
              />
              <text
                y="-2"
                textAnchor="middle"
                fontFamily="JetBrains Mono, monospace"
                fontSize="9"
                fontWeight="700"
                fill={color}
                style={{ pointerEvents: "none" }}
              >
                {ecp.id.replace("ECP-", "")}
              </text>
              <text
                y="9"
                textAnchor="middle"
                fontFamily="JetBrains Mono, monospace"
                fontSize="6"
                fill={color}
                style={{ letterSpacing: "0.12em", pointerEvents: "none" }}
              >
                ECP
              </text>
            </g>
          );
        })}

        {/* Layer 7: ThermalHawk sim — UAS entry-vector arc, cordons, reticle,
         * and QRF response-force dot animating from TOC to the inner cordon. */}
        {simActive && simTargetPos && simCordons && (
          <g>
            {/* UAS entry-vector track — a curved arc from the south-east
             * perimeter into the target building. Draws BEFORE cordons drop
             * so it reads as "drone came from there, cordons responded".
             * Animates via stroke-dashoffset; fades after 2s. */}
            {(() => {
              // Entry at approx (33100, 69500) = southeast perimeter corner
              const entryX = 33100 - BOUNDS.eMin;
              const entryY = BOUNDS.nMax - 69500;
              const tx = simTargetPos.x;
              const ty = simTargetPos.y;
              // Quadratic Bezier control point for a gentle curve
              const cx = (entryX + tx) / 2 + 200;
              const cy = (entryY + ty) / 2 - 400;
              const dashLength = 3000;
              return (
                <>
                  <path
                    className="uas-track"
                    d={`M ${entryX} ${entryY} Q ${cx} ${cy} ${tx} ${ty}`}
                    fill="none"
                    stroke="#ef4444"
                    strokeWidth="2.5"
                    strokeDasharray={`${dashLength}`}
                    strokeDashoffset={dashLength}
                    opacity="0.85"
                  />
                  {/* Entry point marker */}
                  <circle
                    cx={entryX}
                    cy={entryY}
                    r="6"
                    fill="#ef4444"
                    opacity="0"
                    style={{ animation: "uas-track-draw 2s ease-out forwards" }}
                  />
                </>
              );
            })()}

            {[...simCordons].sort((a, b) => a.radius_m - b.radius_m).map((cz, i) => {
              const color = cz.radius_m <= 300 ? "#ef4444" : cz.radius_m <= 500 ? "#fb923c" : "#3b82f6";
              return (
                <circle
                  key={cz.radius_m}
                  cx={simTargetPos.x}
                  cy={simTargetPos.y}
                  r={cz.radius_m}
                  fill="url(#sim-cordon-gradient)"
                  stroke={color}
                  strokeWidth={2}
                  strokeDasharray="10 14"
                  opacity={0}
                  style={{
                    animation: `cordon-pulse 1.2s ease-out forwards`,
                    animationDelay: `${0.8 + i * 0.3}s`,  // after UAS arc draws
                    transformOrigin: `${simTargetPos.x}px ${simTargetPos.y}px`,
                  }}
                />
              );
            })}
            {/* Target reticle — 10s spin reads as active scan */}
            <g transform={`translate(${simTargetPos.x},${simTargetPos.y})`}>
              <circle r="45" fill="none" stroke="#ef4444" strokeWidth="2" opacity="0.85" className="reticle-spin" />
              <line x1="-60" y1="0" x2="-20" y2="0" stroke="#ef4444" strokeWidth="1" />
              <line x1="20" y1="0" x2="60" y2="0" stroke="#ef4444" strokeWidth="1" />
              <line x1="0" y1="-60" x2="0" y2="-20" stroke="#ef4444" strokeWidth="1" />
              <line x1="0" y1="20" x2="0" y2="60" stroke="#ef4444" strokeWidth="1" />
              <circle r="8" fill="#ef4444" className="animate-pulse" />
            </g>

            {/* QRF dot — animates from TOC-MAIN to inner cordon. offset-path
             * traces a straight vector; 10% head fade-in then hold until 90%
             * then tail fade. 2.2s total, delayed to land ~1s after cordons. */}
            {(() => {
              const tocPB = buildingById.get("TOC-MAIN");
              if (!tocPB) return null;
              const dx = simTargetPos.x - tocPB.cx;
              const dy = simTargetPos.y - tocPB.cy;
              // Path terminates at the inner cordon (300m short of target)
              const dist = Math.hypot(dx, dy);
              const tgt_x = simTargetPos.x - (dx / dist) * 300;
              const tgt_y = simTargetPos.y - (dy / dist) * 300;
              return (
                <g>
                  {/* Trail line (faded) */}
                  <line
                    x1={tocPB.cx}
                    y1={tocPB.cy}
                    x2={tgt_x}
                    y2={tgt_y}
                    stroke="#22c55e"
                    strokeWidth="1.5"
                    strokeDasharray="6 6"
                    opacity="0"
                    style={{
                      animation: "uas-track-draw 2.4s ease-out forwards",
                      animationDelay: "1.2s",
                    }}
                  />
                  {/* QRF dot with offset-path animation */}
                  <circle
                    cx="0"
                    cy="0"
                    r="9"
                    fill="#22c55e"
                    stroke="white"
                    strokeWidth="1"
                    style={{
                      offsetPath: `path("M ${tocPB.cx} ${tocPB.cy} L ${tgt_x} ${tgt_y}")`,
                      offsetDistance: "0%",
                      animation: "qrf-move 2.2s ease-in-out forwards",
                      animationDelay: "1.2s",
                      filter: "drop-shadow(0 0 6px #22c55e)",
                    }}
                  />
                  <text
                    x={(tocPB.cx + tgt_x) / 2}
                    y={(tocPB.cy + tgt_y) / 2 - 16}
                    textAnchor="middle"
                    fontFamily="JetBrains Mono, monospace"
                    fontSize="10"
                    fontWeight="700"
                    fill="#22c55e"
                    opacity="0"
                    style={{
                      animation: "uas-track-draw 3s ease-out forwards",
                      animationDelay: "1.5s",
                      letterSpacing: "0.18em",
                    }}
                  >
                    QRF
                  </text>
                </g>
              );
            })()}
          </g>
        )}

        {/* Layer 8: unit markers — MIL-STD-2525C-lite symbology.
         * Friendly land unit (Marine battalion) = blue-outlined rectangle
         * with branch modifier annotated inside:
         *   MP/maint/supply = ⊂ (supply) + "T" trailer
         *   LAR/Tank        = reconnaissance diagonal or armor oval
         *   LAAD            = air-defense arrow-up
         *   MALS/MWSS       = aviation
         * Not full 2525C (that's weeks of modifier work) but enough that a
         * Marine judge doesn't read the COP as a game UI. */}
        {placedUnits.map(({ u, cx, cy }) => {
          const selected = selectedUnit === u.unit;
          const color = mcColor(u.mc_rate);
          const degraded = u.mc_rate < 0.70;
          const modifier = unitModifier(u.unit);
          const W = 56, H = 36;  // battalion-sized rectangle
          return (
            <g
              key={u.unit}
              transform={`translate(${cx},${cy})`}
              style={{ cursor: "pointer" }}
              onClick={() => onUnitClick?.(u.unit)}
            >
              {/* Leader line down to building */}
              <line x1="0" y1={H / 2} x2="0" y2={H / 2 + 24} stroke={color} strokeWidth="1.6" opacity="0.55" strokeDasharray="3 4" />
              {/* Halo pulse for degraded */}
              {degraded && (
                <rect x={-W / 2 - 10} y={-H / 2 - 10} width={W + 20} height={H + 20} fill={color} opacity="0.14" className="animate-pulse" rx="2" />
              )}
              {/* Selection ring */}
              {selected && (
                <rect x={-W / 2 - 6} y={-H / 2 - 6} width={W + 12} height={H + 12} fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="5 4" opacity="0.7" rx="2" />
              )}
              {/* 2525C-lite frame: friendly (blue) rectangle, filled with
               * an MC-tinted background so readiness is encoded in colour
               * at a glance. */}
              <rect
                x={-W / 2}
                y={-H / 2}
                width={W}
                height={H}
                fill={`color-mix(in oklab, ${color} 25%, #0a0c13)`}
                stroke={color}
                strokeWidth={selected ? 3 : 2}
              />
              {/* Battalion echelon mark: two dots atop the frame (MIL-STD
               * convention: II = battalion). */}
              <circle cx={-6} cy={-H / 2 - 5} r="1.8" fill={color} />
              <circle cx={6}  cy={-H / 2 - 5} r="1.8" fill={color} />
              {/* Branch modifier glyph — rendered inside the frame */}
              <g opacity="0.9">{modifier(color)}</g>
              {/* MC% — hero number outside the frame */}
              <text
                x="0"
                y={H / 2 + 14}
                textAnchor="middle"
                fontFamily="JetBrains Mono, monospace"
                fontSize="14"
                fontWeight="700"
                fill={color}
                style={{ pointerEvents: "none", letterSpacing: "-0.02em" }}
              >
                {Math.round(u.mc_rate * 100)}%
              </text>
              {/* Unit ID — rendered outside the frame to the right */}
              <text
                x={W / 2 + 6}
                y="4"
                fontFamily="JetBrains Mono, monospace"
                fontSize="10"
                fontWeight="700"
                fill={color}
                style={{ letterSpacing: "0.08em", pointerEvents: "none" }}
              >
                {u.unit}
              </text>
            </g>
          );
        })}
      </svg>

      {/* Zoom control HUD — anchors zoom on viewport CENTRE so repeated
       * clicks keep the schematic in view rather than walking off-screen.
       * The wheel zoom already anchors on cursor position (see onWheel). */}
      <div className="pointer-events-auto absolute right-3 top-[5.5rem] z-[10] flex flex-col gap-1">
        <button
          onClick={() => zoomAroundCenter(setT, 1.2)}
          className="rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_92%,transparent)] px-2 py-1 font-mono text-xs text-[var(--color-text)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
          title="Zoom in (+)"
        >
          +
        </button>
        <button
          onClick={() => zoomAroundCenter(setT, 1 / 1.2)}
          className="rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_92%,transparent)] px-2 py-1 font-mono text-xs text-[var(--color-text)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
          title="Zoom out (-)"
        >
          −
        </button>
        <button
          onClick={() => setT(INITIAL_T)}
          className="rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_92%,transparent)] px-2 py-1 font-mono text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-primary)]"
          title="Reset view (0)"
        >
          ⟲
        </button>
      </div>

      {/* Hover card — follows cursor with bounds clamping so it doesn't
       * slip off-screen near the edges. Offset +14px from cursor so it
       * doesn't intercept the underlying hover. */}
      {hoverId && (() => {
        const pb = buildingById.get(hoverId);
        if (!pb) return null;
        // Bounds clamping — assume ~240px card width, 140px height.
        const containerW = containerRef.current?.clientWidth ?? 1200;
        const containerH = containerRef.current?.clientHeight ?? 800;
        const cardW = 260;
        const cardH = 140;
        let left = cursorPos.x + 14;
        let top = cursorPos.y + 14;
        if (left + cardW > containerW - 12) left = cursorPos.x - cardW - 14;
        if (top + cardH > containerH - 12) top = cursorPos.y - cardH - 14;
        return (
          <div
            className="pointer-events-none absolute z-[10] max-w-xs rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] px-3 py-2 backdrop-blur"
            style={{ left, top }}
          >
            <div
              className="font-mono text-[10px] uppercase"
              style={{ letterSpacing: "0.16em", color: pb.style.stroke }}
            >
              {pb.b.id} · {pb.b.type.replace("_", " ")}
            </div>
            <div className="mt-0.5 text-[12px] font-semibold text-[var(--color-text)]">
              {pb.b.name}
            </div>
            <div className="mt-1 font-mono text-[10px] text-[var(--color-text-muted)]">
              GRID {pb.b.grid}
            </div>
            <div className="mt-1 font-mono text-[10px] text-[var(--color-text-secondary)]">
              OCC {pb.b.current_occupancy}/{pb.b.occupancy_capacity} · FLOORS {pb.b.floors}
              {pb.b.critical_infrastructure && (
                <span className="ml-2 text-[var(--color-primary)]">CRIT INFRA</span>
              )}
              {pb.b.hazmat_present && (
                <span className="ml-2 text-[#fb923c]">HAZMAT</span>
              )}
            </div>
            {pb.b.notes && (
              <div className="mt-1 text-[10px] italic text-[var(--color-text-muted)]">{pb.b.notes}</div>
            )}
          </div>
        );
      })()}

      {/* Legend */}
      <div
        className="pointer-events-none absolute bottom-16 left-3 z-[10] max-w-[16rem] rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_92%,transparent)] px-3 py-2 font-mono text-[10px] backdrop-blur"
        style={{ letterSpacing: "0.08em" }}
      >
        <div
          className="mb-1.5 text-[9px] uppercase text-[var(--color-text-muted)]"
          style={{ letterSpacing: "0.2em" }}
        >
          Schematic Legend
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <LegendItem swatch="#f59e0b" label="Motor Pool" />
          <LegendItem swatch="#ef4444" label="Ammo / Arms" />
          <LegendItem swatch="#3b82f6" label="Tactical / TOC" />
          <LegendItem swatch="#22c55e" label="Medical" />
          <LegendItem swatch="#eab308" label="Supply" />
          <LegendItem swatch="#8b5cf6" label="Aviation / Comm" />
          <LegendItem swatch="#84cc16" label="Training" />
          <LegendItem swatch="#fb923c" label="Hazmat / Fuel" />
        </div>
        <div
          className="mt-2 border-t border-[var(--color-border)] pt-1 text-[9px] text-[var(--color-text-muted)]"
          style={{ letterSpacing: "0.14em" }}
        >
          Drag to pan · wheel to zoom · 0 to reset
        </div>
      </div>

      {/* Scale bar + north arrow — CAD-credibility moves. Scale bar
       * rescales with zoom so the 500m tick always represents 500 real
       * meters. North arrow is static (schematic is true-north aligned). */}
      <ScaleBarAndCompass containerWidth={containerRef.current?.clientWidth ?? 1200} scale={t.scale} />

      {/* ECP popover — opens on click */}
      {ecpSelected && (
        <EcpPopover
          ecp={ecpSelected}
          cursor={cursorPos}
          container={containerRef.current}
          onClose={() => setEcpSelected(null)}
        />
      )}

      {/* Rally Point popover */}
      {rpSelected && (
        <RallyPopover
          rp={rpSelected}
          cursor={cursorPos}
          container={containerRef.current}
          onClose={() => setRpSelected(null)}
        />
      )}
    </div>
  );
}

function ScaleBarAndCompass({ containerWidth, scale }: { containerWidth: number; scale: number }) {
  // 500m scale — at current zoom, how many container pixels = 500m?
  // Unit→pixel: containerWidth / (WIDTH / scale) = containerWidth * scale / WIDTH
  const px500 = (500 * containerWidth * scale) / WIDTH;
  const barPx = Math.max(40, Math.min(140, px500));
  const barMeters = Math.round((barPx / px500) * 500);
  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-[8] flex flex-col items-end gap-2">
      {/* North arrow */}
      <svg width="44" height="44" viewBox="0 0 44 44">
        <circle cx="22" cy="22" r="20" fill="color-mix(in oklab, var(--color-surface) 92%, transparent)" stroke="var(--color-border)" strokeWidth="1" />
        <path d="M22 6 L26 24 L22 20 L18 24 Z" fill="var(--color-primary)" stroke="white" strokeWidth="0.3" />
        <path d="M22 38 L24 26 L22 28 L20 26 Z" fill="var(--color-text-muted)" opacity="0.7" />
        <text x="22" y="14" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="6" fontWeight="700" fill="var(--color-text)" style={{ letterSpacing: "0.08em" }}>
          N
        </text>
      </svg>
      {/* Scale bar */}
      <div className="rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_92%,transparent)] px-2 py-1 backdrop-blur">
        <div className="flex items-center gap-2 font-mono text-[9px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.14em" }}>
          <div className="flex flex-col">
            <div className="h-[3px]" style={{ width: `${barPx}px`, background: "var(--color-text-secondary)" }} />
            <div className="flex justify-between" style={{ width: `${barPx}px` }}>
              <span className="h-[4px] w-[1px] bg-[var(--color-text-secondary)]" />
              <span className="h-[4px] w-[1px] bg-[var(--color-text-secondary)]" />
            </div>
          </div>
          <span className="tabular-nums">{barMeters}m</span>
        </div>
      </div>
    </div>
  );
}

function EcpPopover({
  ecp,
  cursor,
  container,
  onClose,
}: {
  ecp: ECP;
  cursor: { x: number; y: number };
  container: HTMLDivElement | null;
  onClose: () => void;
}) {
  const cW = container?.clientWidth ?? 1200;
  const cH = container?.clientHeight ?? 800;
  let left = cursor.x + 14;
  let top = cursor.y + 14;
  if (left + 260 > cW - 12) left = cursor.x - 260 - 14;
  if (top + 180 > cH - 12) top = cursor.y - 180 - 14;
  const open = ecp.status === "open";
  return (
    <div
      className="absolute z-[10] w-[260px] rounded-sm border bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] p-3 shadow-lg backdrop-blur"
      style={{
        left, top,
        borderColor: open ? "color-mix(in oklab, var(--color-success) 40%, var(--color-border))" : "var(--color-border-active)",
      }}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="font-mono text-[9px] uppercase text-[var(--color-text-muted)]" style={{ letterSpacing: "0.22em" }}>
            Entry Control Point
          </div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--color-text)]" style={{ letterSpacing: "0.04em" }}>
            {ecp.name}
          </div>
        </div>
        <button
          onClick={onClose}
          className="font-mono text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          ✕
        </button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[10px]" style={{ letterSpacing: "0.08em" }}>
        <KvRow label="Status" value={open ? "OPEN" : ecp.status.toUpperCase()} tone={open ? "ok" : "muted"} />
        <KvRow label="Lanes" value={`${ecp.lanes_in}×IN · ${ecp.lanes_out}×OUT`} />
        <KvRow label="Commercial" value={ecp.commercial_access ? "YES" : "NO"} />
        <KvRow label="Grid" value={ecp.grid} />
      </div>
      {ecp.notes && (
        <div className="mt-2 spire-body-muted text-[11px]">{ecp.notes}</div>
      )}
    </div>
  );
}

function RallyPopover({
  rp,
  cursor,
  container,
  onClose,
}: {
  rp: RallyPoint;
  cursor: { x: number; y: number };
  container: HTMLDivElement | null;
  onClose: () => void;
}) {
  const cW = container?.clientWidth ?? 1200;
  const cH = container?.clientHeight ?? 800;
  let left = cursor.x + 14;
  let top = cursor.y + 14;
  if (left + 240 > cW - 12) left = cursor.x - 240 - 14;
  if (top + 140 > cH - 12) top = cursor.y - 140 - 14;
  return (
    <div
      className="absolute z-[10] w-[240px] rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] p-3 shadow-lg backdrop-blur"
      style={{ left, top }}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="font-mono text-[9px] uppercase text-[#8b5cf6]" style={{ letterSpacing: "0.22em" }}>
            Rally Point
          </div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--color-text)]" style={{ letterSpacing: "0.04em" }}>
            {rp.name}
          </div>
        </div>
        <button
          onClick={onClose}
          className="font-mono text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          ✕
        </button>
      </div>
      <div className="mt-2 font-mono text-[10px]" style={{ letterSpacing: "0.08em" }}>
        <KvRow label="Capacity" value={`${rp.capacity} PAX`} />
        <KvRow label="Grid" value={rp.grid} />
      </div>
    </div>
  );
}

function KvRow({ label, value, tone }: { label: string; value: string; tone?: "ok" | "muted" }) {
  const color =
    tone === "ok" ? "var(--color-success)" :
    tone === "muted" ? "var(--color-text-muted)" :
    "var(--color-text)";
  return (
    <div>
      <div className="text-[9px] uppercase text-[var(--color-text-muted)]" style={{ letterSpacing: "0.18em" }}>
        {label}
      </div>
      <div style={{ color }}>{value}</div>
    </div>
  );
}

function LegendItem({ swatch, label }: { swatch: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[var(--color-text-secondary)]">
      <span
        className="inline-block h-2 w-3 rounded-[1px] border"
        style={{ borderColor: swatch, background: `color-mix(in oklab, ${swatch} 30%, #0a0c13)` }}
      />
      <span>{label}</span>
    </div>
  );
}
