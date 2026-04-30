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
  // Bridge to PULSE: the synthetic-fixture unit name this marker
  // represents for readiness lookup purposes. The Okinawa scenario uses
  // doctrinal unit names (12 MAR, III MEF, etc.) but the PULSE risk
  // board / cannib matcher / forecast engine all key on the synthetic
  // fixture units (CLB-6, CLB-1, MALS-31, ...). The alias lets a
  // marker-click drawer pull live readiness from /api/bastion/cop and
  // a SPIRO answer ground-truth itself. JGSDF markers leave this null
  // (they have no PULSE backing) and the drawer falls back to "no
  // readiness data — synthetic dataset is US-only."
  pulseUnit?: string | null;
};

// Two islands SW of Okinawa Honto host JGSDF stand-in forces — those
// units render in OD green friendly with the JPN country code. Marines
// on Okinawa Honto carry the standard friendly USMC posture.

export const OKINAWA_SCENARIO: ScenarioMarker[] = [
  // ─── OKINAWA HONTO — PULSE units, posture for the III MEF logistics force ─
  //
  // The 10 PULSE-fixture units are the COP's USMC ground truth: each
  // gets exactly one marker, label = pulseUnit (1:1), so a click on a
  // marker pulls real readiness from PULSE and a "Show on map" deeplink
  // from PULSE lands deterministically. 8 are positioned on Okinawa
  // Honto across realistic camps; 2 are forward-deployed (2d LAAD on
  // Miyako, 2/14 Marines on Ishigaki) to visualize the dispersed
  // stand-in-forces concept the doctrine pitches.
  //
  // The marker IDs use the `okn-pulse-<unit>` slug so duplicate-alias
  // bugs (the III MEF / Henoko collision we fixed earlier) cannot
  // recur — slug derives from the unit, no two markers share a unit.
  {
    id: "okn-pulse-clb6",
    sidc: "SFGPUSS---H----",
    coords: [127.6817, 26.2542],
    label: "CLB-6",
    parent: "Camp Kinser",
    island: "okinawa",
    echelon: "Battalion",
    additionalInfo: "Combat Log Bn",
    pulseUnit: "CLB-6",
  },
  {
    id: "okn-pulse-clb1",
    sidc: "SFGPUSS---H----",
    coords: [127.7544, 26.2742],
    label: "CLB-1",
    parent: "Camp Foster",
    island: "okinawa",
    echelon: "Battalion",
    additionalInfo: "Combat Log Bn",
    pulseUnit: "CLB-1",
  },
  {
    id: "okn-pulse-3dmaint",
    sidc: "SFGPUSM---H----",
    coords: [127.7616, 26.2810],
    label: "3d Maint Bn",
    parent: "Camp Foster",
    island: "okinawa",
    echelon: "Battalion",
    additionalInfo: "Maintenance",
    pulseUnit: "3d Maint Bn",
  },
  {
    id: "okn-pulse-mals31",
    sidc: "SFAPMF---------",
    coords: [127.7686, 26.3559],
    label: "MALS-31",
    parent: "Kadena AB",
    island: "okinawa",
    echelon: "Squadron",
    additionalInfo: "Avn Logistics",
    pulseUnit: "MALS-31",
  },
  {
    id: "okn-pulse-mwss271",
    sidc: "SFAPMHR--------",
    coords: [127.7561, 26.2710],
    label: "MWSS-271",
    parent: "MCAS Futenma",
    island: "okinawa",
    echelon: "Squadron",
    additionalInfo: "Wing Support",
    pulseUnit: "MWSS-271",
  },
  {
    id: "okn-pulse-7esb",
    sidc: "SFGPUCE---H----",
    coords: [127.8917, 26.4612],
    label: "7th ESB",
    parent: "Camp Hansen",
    island: "okinawa",
    echelon: "Battalion",
    additionalInfo: "Engineer Spt",
    pulseUnit: "7th ESB",
  },
  {
    id: "okn-pulse-3-6mar",
    sidc: "SFGPUCI---H----",
    coords: [128.0500, 26.5167],
    label: "3/6 Marines",
    parent: "Camp Schwab",
    island: "okinawa",
    echelon: "Battalion",
    additionalInfo: "Infantry",
    pulseUnit: "3/6 Marines",
  },
  {
    id: "okn-pulse-2dlar",
    sidc: "SFGPUCRR--H----",
    coords: [128.0322, 26.5061],
    label: "2d LAR Bn",
    parent: "Camp Schwab",
    island: "okinawa",
    echelon: "Battalion",
    additionalInfo: "Light Armd Recon",
    pulseUnit: "2d LAR Bn",
  },
  // Forward-deployed: 2d LAAD on Miyako (air defense for the stand-in posture).
  {
    id: "okn-pulse-2dlaad",
    sidc: "SFGPUCDA--H----",
    coords: [125.3450, 24.7950],
    label: "2d LAAD Bn",
    parent: "Miyako AD Site",
    island: "miyako",
    echelon: "Battalion",
    additionalInfo: "Air Defense",
    pulseUnit: "2d LAAD Bn",
  },
  // Forward-deployed: 2/14 Marines on Ishigaki (HIMARS/arty forward).
  {
    id: "okn-pulse-2-14mar",
    sidc: "SFGPUCF---H----",
    coords: [124.1750, 24.4150],
    label: "2/14 Marines",
    parent: "Ishigaki Fires Site",
    island: "ishigaki",
    echelon: "Battalion",
    additionalInfo: "HIMARS / Arty",
    pulseUnit: "2/14 Marines",
  },

  // ─── Site markers (no PULSE backing — these are facilities, not units) ─
  {
    id: "okn-fuel-tengan",
    sidc: "SFGPISP-OS-----",
    coords: [127.8561, 26.4083],
    label: "POL",
    parent: "Tengan Pier",
    island: "okinawa",
    additionalInfo: "Class III",
    pulseUnit: null,
  },
  {
    id: "okn-ammo-henoko",
    sidc: "SFGPISP-A------",
    coords: [128.0567, 26.5350],
    label: "Class V",
    parent: "Henoko Munitions",
    island: "okinawa",
    additionalInfo: "Ammo Depot",
    pulseUnit: null,
  },
  {
    id: "okn-radar-yaedake",
    sidc: "SFGPESR--------",
    coords: [128.1442, 26.7117],
    label: "AN/TPS-80",
    parent: "Yaedake Radar",
    island: "okinawa",
    additionalInfo: "G/ATOR",
    pulseUnit: null,
  },
  {
    id: "okn-ecp-hansen",
    sidc: "SFGPSPA--------",
    coords: [127.8800, 26.4467],
    label: "ECP-1",
    parent: "Hansen Main Gate",
    island: "okinawa",
    additionalInfo: "Checkpoint",
    pulseUnit: null,
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
    pulseUnit: null,
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
    pulseUnit: null,
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
    pulseUnit: null,
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
    pulseUnit: null,
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
    pulseUnit: null,
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
    pulseUnit: null,
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
    pulseUnit: null,
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
    pulseUnit: null,
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
    pulseUnit: null,
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
    pulseUnit: null,
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
    pulseUnit: null,
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
    pulseUnit: null,
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
