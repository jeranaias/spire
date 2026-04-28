import type { BastionAlert, BastionCOP, Building } from "../../api";

export interface AlertTarget {
  buildingId: string | null;
  // How the resolver landed on the building — useful for debugging /
  // future telemetry. Order mirrors the precedence in resolveAlertTarget.
  via: "unit_home" | "exact_grid" | "nearest_in_square" | "none";
}

interface ParsedGrid {
  zone: string;
  square: string;
  easting: number;
  northing: number;
  digits: number;
}

// Parse an MGRS-ish grid string like "18S UJ 30120 70340" into its
// components. Returns null on malformed input.
//
// We tolerate variable easting/northing precision (the digits field) so a
// 4-digit grid (10m precision) and a 5-digit grid (1m precision) both
// parse and can be compared after normalisation.
export function parseMgrs(g: string | null | undefined): ParsedGrid | null {
  if (!g) return null;
  const cleaned = g.trim().toUpperCase().replace(/\s+/g, " ");
  // Match: zone (digits + letter) + 100km square (2 letters) + easting + northing.
  const m = cleaned.match(/^(\d{1,2}[A-Z])\s+([A-Z]{2})\s+(\d+)\s+(\d+)$/);
  if (!m) {
    // Tolerant fallback: no spaces between easting/northing — split in
    // half. e.g. "18SUJ3012070340".
    const m2 = cleaned.match(/^(\d{1,2}[A-Z])\s*([A-Z]{2})\s*(\d+)$/);
    if (!m2) return null;
    const en = m2[3];
    if (en.length % 2 !== 0) return null;
    const half = en.length / 2;
    return {
      zone: m2[1],
      square: m2[2],
      easting: Number(en.slice(0, half)),
      northing: Number(en.slice(half)),
      digits: half,
    };
  }
  const e = m[3];
  const n = m[4];
  if (e.length !== n.length) return null;
  return {
    zone: m[1],
    square: m[2],
    easting: Number(e),
    northing: Number(n),
    digits: e.length,
  };
}

// Return easting/northing in meters, scaled to the standard 5-digit
// (1m) precision so two grids of differing precision can be compared.
function toMeters(p: ParsedGrid): { e: number; n: number } {
  // Each digit dropped from a 5-digit grid is a factor of 10 in metres
  // (5 digits = 1m, 4 digits = 10m, 3 digits = 100m, 2 digits = 1km).
  const scale = Math.pow(10, 5 - p.digits);
  return { e: p.easting * scale, n: p.northing * scale };
}

// Two parsed grids share the same MGRS 1km grid square if the zone +
// 100km square match AND the first two digits of their normalised
// easting / northing match. The bake_latlon projection is consistent
// with this — a grid square is a true 1km × 1km box on the ground.
function sameGridSquare(a: ParsedGrid, b: ParsedGrid): boolean {
  if (a.zone !== b.zone || a.square !== b.square) return false;
  const am = toMeters(a);
  const bm = toMeters(b);
  // 1km cell index — floor(meters / 1000) * 100 in 5-digit space.
  return (
    Math.floor(am.e / 1000) === Math.floor(bm.e / 1000) &&
    Math.floor(am.n / 1000) === Math.floor(bm.n / 1000)
  );
}

// Distance in projected meters between two parsed grids. Consistent with
// the flat-earth projection used by `scripts/bake_latlon.py` — easting /
// northing are already metres, so Euclidean distance is correct inside a
// single 100km square. Naive lat/lon distance would drift inside a grid.
function distanceMeters(a: ParsedGrid, b: ParsedGrid): number {
  if (a.zone !== b.zone || a.square !== b.square) {
    return Number.POSITIVE_INFINITY;
  }
  const am = toMeters(a);
  const bm = toMeters(b);
  const dE = am.e - bm.e;
  const dN = am.n - bm.n;
  return Math.sqrt(dE * dE + dN * dN);
}

// Resolve an alert into the building the operator most likely wants to
// drill into. Precedence:
//
//   1. The alert's unit's home_building (canonical mapping in the COP).
//   2. A building whose `grid` exactly equals the alert's `grid`.
//   3. The nearest named building inside the same MGRS 1km grid square
//      (distance computed in projected meters — consistent with the
//      existing flat-earth projection).
//
// Returns `{ buildingId: null, via: "none" }` when no path matches.
export function resolveAlertTarget(
  alert: BastionAlert,
  cop: BastionCOP | null,
): AlertTarget {
  if (!cop) return { buildingId: null, via: "none" };

  // 1. Unit home building — canonical and cheapest.
  if (alert.unit) {
    const unit = cop.units.find((u) => u.unit === alert.unit);
    if (unit?.home_building) {
      const bld = cop.buildings.find((b) => b.id === unit.home_building);
      if (bld) return { buildingId: bld.id, via: "unit_home" };
    }
  }

  const alertGrid = parseMgrs(alert.grid);
  if (!alertGrid) return { buildingId: null, via: "none" };

  // 2. Exact grid match against any building. We compare on normalised
  //    metres so a 5-digit alert grid still matches a 4-digit building
  //    grid down-sampled to the same cell.
  const am = toMeters(alertGrid);
  for (const b of cop.buildings) {
    const bg = parseMgrs(b.grid);
    if (!bg) continue;
    if (bg.zone !== alertGrid.zone || bg.square !== alertGrid.square) continue;
    const bm = toMeters(bg);
    if (am.e === bm.e && am.n === bm.n) {
      return { buildingId: b.id, via: "exact_grid" };
    }
  }

  // 3. Nearest named building inside the same 1km grid square.
  let nearest: Building | null = null;
  let nearestDist = Number.POSITIVE_INFINITY;
  for (const b of cop.buildings) {
    const bg = parseMgrs(b.grid);
    if (!bg) continue;
    if (!sameGridSquare(alertGrid, bg)) continue;
    const d = distanceMeters(alertGrid, bg);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = b;
    }
  }
  if (nearest) return { buildingId: nearest.id, via: "nearest_in_square" };

  return { buildingId: null, via: "none" };
}
