/**
 * Okinawa contested-logistics scenario seed.
 *
 * Three positions: Okinawa Honto (MEF-scale dispersion), Miyako, Ishigaki.
 * Coordinates are real (within a few hundred meters) — actual military
 * facilities are deliberately offset from their published locations so
 * this remains a doctrinally plausible *demonstration*, not an
 * intelligence product. SPIRE is a synthetic dataset; markers here are
 * an unclassified COP planning surface.
 *
 * SIDCs use MIL-STD-2525D 15-character codes:
 *   pos 1: scheme (S = warfighting)
 *   pos 2: standard identity (F = friend, H = hostile, N = neutral)
 *   pos 3: battle dimension (G = ground, A = air, S = sea)
 *   pos 4: status (P = present)
 *   pos 5-10: function ID (e.g. UCI = ground unit / combat / infantry)
 *   pos 11-12: modifier 1, modifier 2
 *   pos 13-15: country / specialty / placeholder
 *
 * milsymbol is forgiving — invalid codes render an "unknown" placeholder
 * rather than throwing. The codes below are doctrinally adjacent and
 * render correct symbology in v3.x of the library.
 */

export type ScenarioMarker = {
  id: string;
  // 15-char SIDC for milsymbol. Friendly green for US/JSDF, neutral for
  // installations, hostile for the threat scenario layer (added later).
  sidc: string;
  // [lng, lat] — MapLibre/GeoJSON convention.
  coords: [number, number];
  label: string;
  // Higher unit / parent command for the audit row + popup.
  parent: string;
  // The island grouping — useful for SPIRO grounding ("on Miyako…").
  island: "okinawa" | "miyako" | "ishigaki";
  // Doctrinal echelon for the size graphic above the icon. milsymbol
  // accepts: "Team", "Squad", "Section", "Platoon", "Company",
  // "Battalion", "Regiment", "Brigade", "Division", "Corps", "Army".
  echelon?: string;
  // Optional one-line additional text rendered under the icon. Keep
  // short — milsymbol clips at ~12 chars.
  additionalInfo?: string;
};

// Two islands SW of Okinawa Honto host JGSDF stand-in forces — those
// units render in OD green friendly with the JPN country code. Marines
// on Okinawa Honto carry the standard friendly USMC posture.

export const OKINAWA_SCENARIO: ScenarioMarker[] = [
  // ─── OKINAWA HONTO — MEF-scale dispersion ────────────────────────────
  // III MEF HQ, Camp Foster
  {
    id: "okn-mef-hq",
    sidc: "SFGPUH----H----",
    coords: [127.7544, 26.2742],
    label: "III MEF",
    parent: "Camp Foster",
    island: "okinawa",
    echelon: "Corps",
    additionalInfo: "MEF HQ",
  },
  // 3rd Marine Division HQ, Camp Courtney
  {
    id: "okn-3mardiv",
    sidc: "SFGPUCI---H----",
    coords: [127.8406, 26.4036],
    label: "3 MARDIV",
    parent: "Camp Courtney",
    island: "okinawa",
    echelon: "Division",
    additionalInfo: "Inf Div HQ",
  },
  // 4th Marines (infantry regiment), Camp Schwab
  {
    id: "okn-4mar",
    sidc: "SFGPUCI--------",
    coords: [128.0500, 26.5167],
    label: "4 MAR",
    parent: "Camp Schwab",
    island: "okinawa",
    echelon: "Regiment",
    additionalInfo: "Infantry",
  },
  // 12th Marine Regiment (artillery / HIMARS), Camp Hansen
  {
    id: "okn-12mar",
    sidc: "SFGPUCF--------",
    coords: [127.8814, 26.4503],
    label: "12 MAR",
    parent: "Camp Hansen",
    island: "okinawa",
    echelon: "Regiment",
    additionalInfo: "HIMARS / Arty",
  },
  // 3rd Reconnaissance Battalion, Camp Schwab
  {
    id: "okn-3recon",
    sidc: "SFGPUCRR-------",
    coords: [128.0322, 26.5061],
    label: "3 RECON",
    parent: "Camp Schwab",
    island: "okinawa",
    echelon: "Battalion",
    additionalInfo: "LRR",
  },
  // 9th Engineer Support Battalion, Camp Hansen
  {
    id: "okn-9esb",
    sidc: "SFGPUCE--------",
    coords: [127.8917, 26.4612],
    label: "9 ESB",
    parent: "Camp Hansen",
    island: "okinawa",
    echelon: "Battalion",
    additionalInfo: "Engineer",
  },
  // MAG-36, MCAS Futenma — rotary
  {
    id: "okn-mag36",
    sidc: "SFAPMHR--------",
    coords: [127.7561, 26.2710],
    label: "MAG-36",
    parent: "MCAS Futenma",
    island: "okinawa",
    echelon: "Group",
    additionalInfo: "Rotary",
  },
  // 1st MAW HQ, Kadena
  {
    id: "okn-1maw",
    sidc: "SFAPMF---------",
    coords: [127.7686, 26.3559],
    label: "1 MAW",
    parent: "Kadena AB",
    island: "okinawa",
    echelon: "Wing",
    additionalInfo: "Fixed Wing",
  },
  // CLR-37 Combat Logistics Regiment, Camp Kinser
  {
    id: "okn-clr37",
    sidc: "SFGPUSS--------",
    coords: [127.6817, 26.2542],
    label: "CLR-37",
    parent: "Camp Kinser",
    island: "okinawa",
    echelon: "Regiment",
    additionalInfo: "CSS / Log",
  },
  // Class III/V fuel point, Tengan Pier
  {
    id: "okn-fuel-tengan",
    sidc: "SFGPISP-OS-----",
    coords: [127.8561, 26.4083],
    label: "POL",
    parent: "Tengan Pier",
    island: "okinawa",
    additionalInfo: "Class III",
  },
  // Ammo / Class V depot, Henoko
  {
    id: "okn-ammo-henoko",
    sidc: "SFGPISP-A------",
    coords: [128.0567, 26.5350],
    label: "Class V",
    parent: "Henoko Munitions",
    island: "okinawa",
    additionalInfo: "Ammo Depot",
  },
  // Long-range surveillance radar, Yaedake (north Okinawa highlands)
  {
    id: "okn-radar-yaedake",
    sidc: "SFGPESR--------",
    coords: [128.1442, 26.7117],
    label: "AN/TPS-80",
    parent: "Yaedake Radar",
    island: "okinawa",
    additionalInfo: "G/ATOR",
  },
  // ECP / Main Gate, Camp Hansen
  {
    id: "okn-ecp-hansen",
    sidc: "SFGPSPA--------",
    coords: [127.8800, 26.4467],
    label: "ECP-1",
    parent: "Hansen Main Gate",
    island: "okinawa",
    additionalInfo: "Checkpoint",
  },

  // ─── MIYAKO — JGSDF SSM regiment, ground troops ───────────────────────
  // Miyakojima Garrison HQ
  {
    id: "myk-garrison",
    sidc: "SFGPUH----H---J",
    coords: [125.3083, 24.7833],
    label: "Miyako Gar",
    parent: "JGSDF Camp Miyako",
    island: "miyako",
    echelon: "Brigade",
    additionalInfo: "Garrison HQ",
  },
  // 7th Anti-Ship Missile Regiment — battery position alpha (north)
  {
    id: "myk-7assm-a",
    sidc: "SFGPUCMSE-----J",
    coords: [125.3500, 24.7917],
    label: "7 SSM A",
    parent: "7 SSM Regt",
    island: "miyako",
    echelon: "Battery",
    additionalInfo: "Type-12",
  },
  // 7th SSM — battery position bravo (south, dispersed)
  {
    id: "myk-7assm-b",
    sidc: "SFGPUCMSE-----J",
    coords: [125.2500, 24.7500],
    label: "7 SSM B",
    parent: "7 SSM Regt",
    island: "miyako",
    echelon: "Battery",
    additionalInfo: "Type-12",
  },
  // Coastal surveillance / radar
  {
    id: "myk-radar",
    sidc: "SFGPESR-------J",
    coords: [125.3300, 24.8000],
    label: "Coast Surv",
    parent: "JGSDF Miyako",
    island: "miyako",
    additionalInfo: "FPS-7",
  },
  // Combined fuel + ammo cache (CSS)
  {
    id: "myk-css",
    sidc: "SFGPUSS-------J",
    coords: [125.3200, 24.7800],
    label: "Sustain",
    parent: "JGSDF Miyako",
    island: "miyako",
    echelon: "Company",
    additionalInfo: "POL/Class V",
  },
  // Hirara Port checkpoint
  {
    id: "myk-ecp-hirara",
    sidc: "SFGPSPA-------J",
    coords: [125.2811, 24.8067],
    label: "Hirara CP",
    parent: "Hirara Port",
    island: "miyako",
    additionalInfo: "Sea ECP",
  },

  // ─── ISHIGAKI — JGSDF SSM regiment, ground troops ─────────────────────
  // Ishigaki Garrison HQ
  {
    id: "isg-garrison",
    sidc: "SFGPUH----H---J",
    coords: [124.1606, 24.4044],
    label: "Ishigaki Gar",
    parent: "JGSDF Camp Ishigaki",
    island: "ishigaki",
    echelon: "Brigade",
    additionalInfo: "Garrison HQ",
  },
  // 5th Anti-Ship Missile Regiment — battery position alpha (north)
  {
    id: "isg-5assm-a",
    sidc: "SFGPUCMSE-----J",
    coords: [124.1700, 24.4200],
    label: "5 SSM A",
    parent: "5 SSM Regt",
    island: "ishigaki",
    echelon: "Battery",
    additionalInfo: "Type-12",
  },
  // 5th SSM — battery position bravo (south, dispersed)
  {
    id: "isg-5assm-b",
    sidc: "SFGPUCMSE-----J",
    coords: [124.1450, 24.3950],
    label: "5 SSM B",
    parent: "5 SSM Regt",
    island: "ishigaki",
    echelon: "Battery",
    additionalInfo: "Type-12",
  },
  // Coastal surveillance / radar (north tip)
  {
    id: "isg-radar",
    sidc: "SFGPESR-------J",
    coords: [124.1900, 24.4500],
    label: "Coast Surv",
    parent: "JGSDF Ishigaki",
    island: "ishigaki",
    additionalInfo: "FPS-7",
  },
  // CSS / sustainment
  {
    id: "isg-css",
    sidc: "SFGPUSS-------J",
    coords: [124.1550, 24.3800],
    label: "Sustain",
    parent: "JGSDF Ishigaki",
    island: "ishigaki",
    echelon: "Company",
    additionalInfo: "POL/Class V",
  },
  // Ishigaki Port ECP
  {
    id: "isg-ecp-port",
    sidc: "SFGPSPA-------J",
    coords: [124.1561, 24.3403],
    label: "Port CP",
    parent: "Ishigaki Port",
    island: "ishigaki",
    additionalInfo: "Sea ECP",
  },
];

// Map view defaults — encompasses all three islands with a little
// breathing room. Operator can pan/zoom; the persisted view state lives
// in the markers store so density preferences carry across reloads.
export const OKINAWA_VIEW = {
  // Center between Miyako and Okinawa Honto so all three are on screen
  // at zoom 7.
  center: [126.5, 25.4] as [number, number],
  zoom: 7,
  // World-scale zoom-out is allowed — operator can pull back to see
  // the Pacific theater (or further) without hitting a wall. Tile
  // provider only serves down to ~zoom 0; below that the basemap goes
  // gray but markers still render.
  minZoom: 0,
  maxZoom: 18,
};

// Per-island fast-pan presets — SPIRO can use these as grounding
// anchors when the operator says "go to Miyako" / "show me Ishigaki".
export const ISLAND_PRESETS: Record<
  "okinawa" | "miyako" | "ishigaki",
  { center: [number, number]; zoom: number }
> = {
  okinawa:  { center: [127.85, 26.45], zoom: 9 },
  miyako:   { center: [125.31, 24.79], zoom: 11 },
  ishigaki: { center: [124.16, 24.40], zoom: 11 },
};
