/**
 * DhaRescueView — MDM 2026 stage pivot, hero use case #4
 * (USE CASE 4 · BLOOD/CLASS VIII H+72 — DMO).
 *
 * The fourth tile of the four-up stage layout: predictive blood / Class
 * VIII sustainment under INDOPACOM Distributed Maritime Operations.
 *
 * Stage layout (top → bottom):
 *
 *   1. Hero strap — use-case framing (DMO + H+72 hub-spoke)
 *   2. HubSpokeMap — MapLibre vector basemap (CartoDB Dark Matter GL)
 *      with the hub (CLB-6 ASP) and four forward spokes plotted as
 *      Markers in the WESTPAC AOR. Routes between hub and each spoke
 *      render as GeoJSON line layers; contested routes are amber and
 *      dashed. Migrated from the prior SVG schematic per WP-6.
 *   3. DaysOfSupplyPanel — gauges for PRBC, plasma, platelets, walking
 *      blood bank, plus a Class VIII consumables lane
 *   4. MarketSourcingPanel — surfaces alternate-source recommendations
 *      when the hub projects stockout in the current scenario hour;
 *      "Approve" writes a hash-chained audit row
 *   5. LiveShortagesPanel — backed by the existing
 *      `/api/decision-bridge/shortages` endpoint
 *   6. AdvanceBar — "Advance to H+72" steps the local scenario state
 *      through H+0 → H+24 → H+48 → H+72, decaying stocks per beat and
 *      writing an audit row on every advance
 *
 * Backend invariants honoured:
 *   • No new state on the server — the local scenario hour exists only
 *     in this component.
 *   • Audit writes go through `POST /api/system/dha-rescue/audit`,
 *     which calls `persistence.log()` with the same hash-chain
 *     contract the rest of the audit chain uses.
 *   • Live shortages remain authoritative: the panel renders backend
 *     data on top of the in-memory scenario, never the reverse.
 *
 * The view is read-only and bypasses ScopeGuard so any presenter role
 * can land on it. It is reachable from the stage-mode Decision Bridge
 * tile, BASTION's blood-vignette button, or a direct deep-link.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import MapGL, { Marker, Source, Layer, NavigationControl, ScaleControl } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";

import {
  api,
  type BloodScenarioFeed,
  type BloodScenarioMeta,
  type DecisionBridgeShortage,
  type DecisionBridgeShortages,
} from "../api";
import { formatApiError } from "../api-retry";
import { useSpireStore } from "../state/store";
import { Button, EmptyState, ErrorState, LoadingState, Pressable } from "../components/ui";

// ---------------------------------------------------------------------------
// Local scenario state — H+0 → H+72
// ---------------------------------------------------------------------------

interface BloodProduct {
  key: string;
  label: string;        // PRBC, FFP/Plasma, Platelets, Walking Blood Bank
  short: string;        // 2-char gauge label
  unit_label: string;   // "units", "pheresis units"
  // Stock at each scenario beat. Index 0 = H+0, 1 = H+24, 2 = H+48, 3 = H+72.
  stock: number[];      // current units on hand at the hub
  daily_burn: number;   // expected daily consumption rate at the hub
  hard_min: number;     // operational minimum — under this we annotate red
  shelf_life_days: number;
}

// Canonical blood-product roster aligned with the H+72 vignette (FOB ECHO
// pull). PRBC + plasma + platelets are scripted; the walking blood bank is
// the contingency the market-sourcing panel surfaces when the hub drops
// below operational reserve.
//
// Stock numbers are illustrative — they are *not* used to drive any
// operator decision in production, only to make the gauges visibly move
// across the four scenario beats. Real burn rates would arrive from the
// (future) DMO sustainment feed.
const PRODUCTS: BloodProduct[] = [
  {
    key: "prbc",
    label: "PRBC (Whole / Type O+)",
    short: "PRBC",
    unit_label: "units",
    stock: [60, 44, 28, 12],
    daily_burn: 16,
    hard_min: 16,
    shelf_life_days: 35,
  },
  {
    key: "ffp",
    label: "Plasma (FFP, thawed)",
    short: "FFP",
    unit_label: "units",
    stock: [40, 30, 18, 8],
    daily_burn: 12,
    hard_min: 10,
    shelf_life_days: 5,
  },
  {
    key: "plt",
    label: "Platelets (apheresis)",
    short: "PLT",
    unit_label: "pheresis units",
    stock: [12, 8, 5, 2],
    daily_burn: 4,
    hard_min: 3,
    shelf_life_days: 5,
  },
  {
    key: "wbb",
    label: "Walking Blood Bank (donor pool)",
    short: "WBB",
    unit_label: "donors on call",
    stock: [22, 22, 20, 18],
    daily_burn: 0,
    hard_min: 12,
    shelf_life_days: 0,
  },
];

const BEATS: { label: string; hour: number }[] = [
  { label: "H+0",  hour: 0  },
  { label: "H+24", hour: 24 },
  { label: "H+48", hour: 48 },
  { label: "H+72", hour: 72 },
];

// ---------------------------------------------------------------------------
// Hub-spoke topology — illustrative DMO schematic (FOB ECHO pull)
// ---------------------------------------------------------------------------

// Each node has a real WESTPAC AOR coordinate so the map reads as a
// theater logistics picture (CLB-6 ASP on Okinawa as the hub; spokes
// stretching from Camp Hansen up to MCAS Iwakuni and down into the SCS
// to a forward operating base off Subic). Coordinates are illustrative
// and intentionally rounded — they are NOT a planning input, only a
// stage prop so the contested routes have a believable bearing.
interface SpokeNode {
  key: string;
  unit: string;             // CLB-6, CLB-3, CLB-31, FOB ECHO, donor center
  short: string;            // 4-6 char marker label
  role: "hub" | "spoke";
  cold_chain: "ok" | "warn" | "fail";
  contested: boolean;       // route between hub and spoke is contested
  lon: number;
  lat: number;
}

const NODES: SpokeNode[] = [
  { key: "h",     unit: "CLB-6 ASP (Camp Kinser, Okinawa)",        short: "CLB-6", role: "hub",   cold_chain: "ok",   contested: false, lon: 127.715, lat: 26.273 },
  { key: "clb3",  unit: "CLB-3 (Camp Hansen, Okinawa)",            short: "CLB-3", role: "spoke", cold_chain: "ok",   contested: false, lon: 127.886, lat: 26.469 },
  { key: "clb31", unit: "CLB-31 (15th MEU · MCAS Iwakuni)",        short: "CLB-31", role: "spoke", cold_chain: "warn", contested: true,  lon: 132.236, lat: 34.143 },
  { key: "fobE",  unit: "FOB ECHO (Subic forward staging)",        short: "FOB-E", role: "spoke", cold_chain: "fail", contested: true,  lon: 120.265, lat: 14.794 },
  { key: "shore", unit: "Shore-side donor center (Sasebo)",        short: "DONOR", role: "spoke", cold_chain: "ok",   contested: false, lon: 129.713, lat: 33.166 },
];

// MapLibre basemap for the hub-spoke schematic. We share the same
// CartoDB Dark Matter style + vendored fallback as the BASTION
// MapCanvas so the AJAX-0 race the reviewer caught for that map is
// covered here too. If the remote style.json fails twice in a row we
// drop to a single-colour background — markers + route lines still
// render so the schematic remains usable offline.
const HUBSPOKE_MAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const HUBSPOKE_FALLBACK_STYLE: any = {
  version: 8,
  sources: {},
  layers: [
    { id: "fallback-bg", type: "background", paint: { "background-color": "#0a0c13" } },
  ],
  glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
};

// ---------------------------------------------------------------------------
// Market-sourcing recommendations
// ---------------------------------------------------------------------------

interface SourcingRec {
  id: string;
  product_key: string;       // matches PRODUCTS[].key
  source: string;            // human-readable source
  units: number;             // proposed transfer
  eta_hours: number;         // delivery ETA
  note: string;              // why this source
}

// Recommendations per scenario beat. The market-sourcing panel filters
// the active beat's recommendations down to products under the hard_min,
// so the screen stays empty-and-quiet when the hub is healthy.
const RECS_BY_BEAT: Record<number, SourcingRec[]> = {
  0: [],
  24: [
    {
      id: "rec-h24-plt",
      product_key: "plt",
      source: "JBER blood depot · INDOPACOM lift bridge",
      units: 6,
      eta_hours: 18,
      note: "Apheresis platelets within 5-day window; lift bridge 1 of 2 confirmed",
    },
  ],
  48: [
    {
      id: "rec-h48-prbc",
      product_key: "prbc",
      source: "USNS Mercy fwd-deployed reserve",
      units: 24,
      eta_hours: 14,
      note: "Type O+ PRBC; cold chain on Mercy validated 2026-04-25",
    },
    {
      id: "rec-h48-ffp",
      product_key: "ffp",
      source: "Korea ROK MIL coalition exchange",
      units: 12,
      eta_hours: 22,
      note: "Coalition release vetted via SENTRY; FMS interchange agreement #41-A",
    },
  ],
  72: [
    {
      id: "rec-h72-wbb",
      product_key: "wbb",
      source: "Walking blood bank · Camp Hansen",
      units: 18,
      eta_hours: 4,
      note: "Pre-screened type-O low-titre donor pool, on-island",
    },
    {
      id: "rec-h72-prbc",
      product_key: "prbc",
      source: "Civil agreement · Tokyo Red Cross",
      units: 32,
      eta_hours: 26,
      note: "Civil-mil HA/DR agreement; release authorized at MEF commander",
    },
    {
      id: "rec-h72-plt",
      product_key: "plt",
      source: "Self-source · apheresis collection at sea",
      units: 8,
      eta_hours: 12,
      note: "USS Tripoli lab spun up; donor roster pre-screened",
    },
  ],
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function HubSpokeMap({ beatIndex }: { beatIndex: number }) {
  // MapLibre vector basemap (CartoDB Dark Matter GL) with the hub +
  // four spokes plotted at real WESTPAC AOR coordinates. Routes between
  // hub and each spoke are GeoJSON LineStrings split into two layers —
  // contested vs nominal — because the MapLibre `line-dasharray` paint
  // property cannot be data-driven by a feature property in v3.x.
  const hub = NODES.find((n) => n.role === "hub")!;
  const spokes = NODES.filter((n) => n.role === "spoke");

  function ccColor(cc: SpokeNode["cold_chain"]): string {
    if (cc === "ok") return "#22c55e";
    if (cc === "warn") return "#eab308";
    return "#ef4444";
  }

  // The downstream stress on each spoke increases with the scenario
  // hour — we just bump the contested stroke width slightly so those
  // routes visibly "thicken" as the scenario progresses, telegraphing
  // that the problem is getting worse without overstating it.
  const stress = 1 + beatIndex * 0.4;

  // Two route layers: contested (amber, dashed, thicker) and nominal
  // (muted, solid). Splitting into two FeatureCollections sidesteps the
  // data-driven `line-dasharray` limitation in MapLibre GL.
  const routesContested = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: "FeatureCollection",
    features: spokes
      .filter((s) => s.contested)
      .map<GeoJSON.Feature>((s) => ({
        type: "Feature",
        properties: { key: s.key },
        geometry: {
          type: "LineString",
          coordinates: [[hub.lon, hub.lat], [s.lon, s.lat]],
        },
      })),
  }), [hub.lat, hub.lon, spokes]);

  const routesNominal = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: "FeatureCollection",
    features: spokes
      .filter((s) => !s.contested)
      .map<GeoJSON.Feature>((s) => ({
        type: "Feature",
        properties: { key: s.key },
        geometry: {
          type: "LineString",
          coordinates: [[hub.lon, hub.lat], [s.lon, s.lat]],
        },
      })),
  }), [hub.lat, hub.lon, spokes]);

  // Style fallback wiring — same retry pattern as MapCanvas. If the
  // CartoDB CDN style.json fails twice in a row we fall back to the
  // vendored single-colour background so the map remains usable.
  const [mapStyle, setMapStyle] = useState<string | typeof HUBSPOKE_FALLBACK_STYLE>(HUBSPOKE_MAP_STYLE);
  const styleRetryRef = useMemo(() => ({ current: 0 }), []);

  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-sm border border-[var(--color-border)]"
      role="img"
      aria-label="Hub-spoke map. Hub at CLB-6 ASP (Okinawa) with four forward spokes across the WESTPAC AOR; route lines highlight contested resupply paths."
    >
      <MapGL
        initialViewState={{ longitude: 127, latitude: 25, zoom: 3.6 }}
        mapStyle={mapStyle}
        onError={(e) => {
          if (styleRetryRef.current < 1 && mapStyle === HUBSPOKE_MAP_STYLE) {
            styleRetryRef.current += 1;
            setMapStyle(HUBSPOKE_MAP_STYLE);
          } else if (styleRetryRef.current >= 1 && mapStyle === HUBSPOKE_MAP_STYLE) {
            setMapStyle(HUBSPOKE_FALLBACK_STYLE);
          }
          // Surface remaining errors at debug level only — schematic
          // markers/lines render regardless of style state.
          // eslint-disable-next-line no-console
          console.debug("[HubSpokeMap] map error", e);
        }}
        attributionControl={{ compact: true }}
        style={{ width: "100%", height: "100%" }}
      >
        <NavigationControl position="top-right" showCompass={false} />
        <ScaleControl position="bottom-left" />

        {/* Nominal routes — muted, solid */}
        <Source id="hubspoke-routes-nominal" type="geojson" data={routesNominal}>
          <Layer
            id="hubspoke-routes-nominal-line"
            type="line"
            paint={{
              "line-color": "#3b4d6e",
              "line-width": 1.5,
              "line-opacity": 0.75,
            }}
          />
        </Source>

        {/* Contested routes — amber, dashed, beat-stress thickness */}
        <Source id="hubspoke-routes-contested" type="geojson" data={routesContested}>
          <Layer
            id="hubspoke-routes-contested-line"
            type="line"
            paint={{
              "line-color": "#f59e0b",
              "line-width": 1.4 * stress,
              "line-opacity": 0.9,
              "line-dasharray": [2, 2],
            }}
          />
        </Source>

        {/* Hub marker */}
        <Marker longitude={hub.lon} latitude={hub.lat} anchor="center">
          <div
            title={hub.unit}
            data-testid="hubspoke-hub"
            className="flex flex-col items-center"
          >
            <div
              className="h-4 w-4 rounded-full border-2"
              style={{
                background: "rgba(34,197,94,0.35)",
                borderColor: "#22c55e",
                boxShadow: "0 0 0 2px rgba(10,12,19,0.85)",
              }}
            />
            <div
              className="mt-0.5 px-1 font-mono text-[10px] font-semibold"
              style={{
                color: "var(--color-text)",
                background: "rgba(10,12,19,0.85)",
                border: "1px solid rgba(34,197,94,0.5)",
                borderRadius: 2,
              }}
            >
              {hub.short} · ASP
            </div>
          </div>
        </Marker>

        {/* Spoke markers */}
        {spokes.map((s) => (
          <Marker
            key={`marker-${s.key}`}
            longitude={s.lon}
            latitude={s.lat}
            anchor="center"
          >
            <div
              title={s.unit}
              data-testid={`hubspoke-spoke-${s.key}`}
              className="flex flex-col items-center"
            >
              <div
                className="h-3 w-3 rounded-full border-2"
                style={{
                  background: `${ccColor(s.cold_chain)}55`,
                  borderColor: ccColor(s.cold_chain),
                  boxShadow: "0 0 0 2px rgba(10,12,19,0.85)",
                }}
              />
              <div
                className="mt-0.5 px-1 font-mono text-[9px]"
                style={{
                  color: "var(--color-text-secondary)",
                  background: "rgba(10,12,19,0.85)",
                  border: `1px solid ${ccColor(s.cold_chain)}66`,
                  borderRadius: 2,
                }}
              >
                {s.short}
              </div>
            </div>
          </Marker>
        ))}
      </MapGL>

      {/* Legend overlay — non-interactive, anchored bottom-right so the
          NavigationControl + scale don't collide with it. */}
      <div
        className="pointer-events-none absolute bottom-2 right-2 z-10 rounded-sm border px-2 py-1 font-mono text-[10px]"
        style={{
          color: "var(--color-text-muted)",
          background: "rgba(10,12,19,0.85)",
          borderColor: "var(--color-border)",
        }}
      >
        ── route · ┄┄ contested · <span style={{ color: "#22c55e" }}>●</span> ok ·{" "}
        <span style={{ color: "#eab308" }}>●</span> warn ·{" "}
        <span style={{ color: "#ef4444" }}>●</span> fail
      </div>
    </div>
  );
}

function DaysOfSupplyGauge({
  product, beatIndex,
}: { product: BloodProduct; beatIndex: number }) {
  const stock = product.stock[beatIndex] ?? product.stock[product.stock.length - 1];
  // For walking blood bank the "burn" is conceptually 0 — we show a
  // capacity bar against the hard_min instead of a days-of-supply
  // calc, which would otherwise read as ∞.
  const days = product.daily_burn > 0 ? stock / product.daily_burn : null;
  const underMin = stock < product.hard_min;

  // Visual fill for the bar: capacity vs the H+0 baseline so the bar
  // visibly drains across beats. Floor at 6% so a near-zero stock is
  // still detectable visually.
  const baseline = product.stock[0] || 1;
  const fillPct = Math.max(6, Math.min(100, (stock / baseline) * 100));
  const tone = underMin ? "var(--color-danger)"
            : days !== null && days < 2 ? "var(--color-warning)"
            : "var(--color-success)";

  return (
    <div
      className="flex flex-col gap-1.5 rounded-sm border-l-2 px-3 py-2"
      style={{
        borderLeftColor: tone,
        background: "color-mix(in oklab, var(--color-bg) 60%, transparent)",
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-[var(--color-text)]">{product.label}</div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            {product.short} · {product.unit_label}
            {underMin ? " · UNDER MIN" : ""}
          </div>
        </div>
        <div className="text-right font-mono tabular-nums">
          <div className="text-[15px] font-semibold" style={{ color: tone }}>
            {stock}
          </div>
          {days !== null && (
            <div className="text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              {days.toFixed(1)} DOS
            </div>
          )}
        </div>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-sm"
        style={{ background: "color-mix(in oklab, var(--color-border) 50%, transparent)" }}
        role="progressbar"
        aria-valuenow={Math.round(fillPct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${product.label} stock vs baseline`}
      >
        <div className="h-full" style={{ width: `${fillPct}%`, background: tone }} />
      </div>
    </div>
  );
}

function MarketSourcingPanel({
  beatIndex, onApprove, approvedIds, busyId,
}: {
  beatIndex: number;
  onApprove: (rec: SourcingRec) => void;
  approvedIds: Set<string>;
  busyId: string | null;
}) {
  // Only show recommendations whose product is currently under hard_min
  // at the active beat. Keeps the panel quiet until the scenario
  // actually demands a market source.
  const hour = BEATS[beatIndex].hour;
  const beatRecs = RECS_BY_BEAT[hour] ?? [];
  const recs = useMemo(() => {
    return beatRecs.filter((r) => {
      const p = PRODUCTS.find((pp) => pp.key === r.product_key);
      if (!p) return false;
      return (p.stock[beatIndex] ?? 0) < p.hard_min;
    });
  }, [beatRecs, beatIndex]);

  if (recs.length === 0) {
    return (
      <EmptyState
        title="No market sources required"
        description="All blood products above hard minimum at this scenario hour."
      />
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {recs.map((r) => {
        const p = PRODUCTS.find((pp) => pp.key === r.product_key);
        const approved = approvedIds.has(r.id);
        const busy = busyId === r.id;
        return (
          <li
            key={r.id}
            className="flex items-start gap-3 rounded-sm border-l-2 px-3 py-2"
            style={{
              borderLeftColor: approved ? "var(--color-success)" : "var(--color-info)",
              background: "color-mix(in oklab, var(--color-bg) 60%, transparent)",
            }}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-muted)]">
                  {p?.short ?? r.product_key.toUpperCase()}
                </span>
                <span className="text-[13px] font-semibold text-[var(--color-text)]">{r.source}</span>
                <span className="font-mono text-[11px] tabular-nums text-[var(--color-text-secondary)]">
                  {r.units} {p?.unit_label ?? "units"} · ETA H+{r.eta_hours}h
                </span>
              </div>
              <p className="mt-0.5 text-[12px] leading-snug text-[var(--color-text-secondary)]">
                {r.note}
              </p>
            </div>
            <Button
              variant={approved ? "secondary" : "primary"}
              size="sm"
              onClick={() => onApprove(r)}
              disabled={approved || !!busyId}
              aria-label={approved ? `Sourcing approved · ${r.source}` : `Approve sourcing from ${r.source}`}
              title={approved ? "Approved · audit chain row written" : "Approve · writes hash-chained audit row"}
            >
              {approved ? "✓ Approved" : busy ? "…" : "Approve"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

const SHORTAGE_BADGE: Record<string, { label: string; tone: string }> = {
  class_ix:   { label: "IX",   tone: "var(--color-warning)" },
  class_viii: { label: "VIII", tone: "var(--color-danger)"  },
  class_iii:  { label: "III",  tone: "var(--color-info)"    },
};

function stockoutTone(hours: number): string {
  if (hours < 24) return "var(--color-danger)";
  if (hours < 48) return "var(--color-warning)";
  return "var(--color-text-secondary)";
}

function ShortageRow({ s }: { s: DecisionBridgeShortage }) {
  const badge = SHORTAGE_BADGE[s.kind] ?? { label: s.kind.toUpperCase(), tone: "var(--color-text-muted)" };
  const tone = stockoutTone(s.hours_to_stockout);
  return (
    <li
      className="flex items-center gap-3 rounded-sm border-l-2 px-3 py-2"
      style={{
        borderLeftColor: tone,
        background: "color-mix(in oklab, var(--color-bg) 60%, transparent)",
      }}
    >
      <span
        className="rounded-sm px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-widest"
        style={{ color: badge.tone, border: `1px solid ${badge.tone}` }}
        aria-label={s.label}
      >
        {badge.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-[var(--color-text)]">{s.item}</div>
        <div className="truncate font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          {s.drill_unit ?? "—"}
          {s.open_requisitions ? ` · ${s.open_requisitions} open req` : ""}
          {s.location ? ` · ${s.location}` : ""}
        </div>
      </div>
      <div
        className="font-mono text-[15px] font-semibold tabular-nums tracking-wider"
        style={{ color: tone }}
        aria-label={`Hours to stockout: ${s.hours_to_stockout}`}
      >
        H+{s.hours_to_stockout}h
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// View root
// ---------------------------------------------------------------------------

export function DhaRescueView() {
  const nav = useNavigate();
  const stageMode = useSpireStore((s) => s.stageMode);
  const pushToast = useSpireStore((s) => s.pushToast);

  // Scenario index: 0 = H+0, 1 = H+24, 2 = H+48, 3 = H+72.
  const [beatIndex, setBeatIndex] = useState(0);
  const [advancing, setAdvancing] = useState(false);

  const [shortages, setShortages] = useState<DecisionBridgeShortages | null>(null);
  const [shortagesErr, setShortagesErr] = useState<string | null>(null);

  const [vignette, setVignette] = useState<BloodScenarioMeta | null>(null);
  const [vignetteErr, setVignetteErr] = useState<string | null>(null);

  // Round-4 — events buffer (alerts/forecasts/requisitions/toasts that
  // the scripted vignette has injected this run). Sourced from
  // `/api/system/scenario/blood-h72/feed`. The view summarises the
  // event count next to the beat counter so the operator can see that
  // the scenario engine fired real injections, not just static UI.
  const [feed, setFeed] = useState<BloodScenarioFeed | null>(null);
  const [feedErr, setFeedErr] = useState<string | null>(null);

  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set());
  const [approvingId, setApprovingId] = useState<string | null>(null);

  // Live shortages — single fetch on mount + refresh every 60s. Filter
  // down to medical / blood (class_viii) entries because that's the
  // story DHA RESCUE tells; if the backend has none we still show all
  // shortages so the operator sees what's live.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const v = await api.decisionBridge.shortages(8);
        if (!cancelled) {
          setShortages(v);
          setShortagesErr(null);
        }
      } catch (err) {
        if (!cancelled) setShortagesErr(formatApiError(err));
      }
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  // Vignette metadata + injected-events buffer — together they prove
  // the scripted scenario is live. `/scenario/blood-h72` returns the
  // beat catalog (narration, view targets, durations); the companion
  // `/scenario/blood-h72/feed` returns the actual events the engine
  // has fired this run, filtered by the current beat's offset_min.
  useEffect(() => {
    let cancelled = false;
    api.system.scenarioBloodVignette()
      .then((v) => { if (!cancelled) setVignette(v); })
      .catch((err) => { if (!cancelled) setVignetteErr(formatApiError(err)); });
    return () => { cancelled = true; };
  }, []);

  // Re-fetch the feed every time the operator advances a beat so the
  // counter reflects events injected up to and including the current
  // hour. We pass since_offset_min = -1 to get every event from H+0
  // onwards but ask the backend to cap rows at 200 so the FE stays
  // responsive even if the scenario JSON grows.
  useEffect(() => {
    let cancelled = false;
    api.system.scenarioBloodFeed(-1, undefined, 200)
      .then((f) => {
        if (cancelled) return;
        setFeed(f);
        setFeedErr(null);
      })
      .catch((err) => {
        if (!cancelled) setFeedErr(formatApiError(err));
      });
    return () => { cancelled = true; };
  }, [beatIndex]);

  const medical: DecisionBridgeShortage[] = shortages
    ? shortages.shortages.filter((s) => s.kind === "class_viii")
    : [];
  const visibleShortages = medical.length > 0 ? medical : (shortages?.shortages ?? []);

  async function advance() {
    if (advancing) return;
    if (beatIndex >= BEATS.length - 1) {
      pushToast({ tone: "info", text: "Scenario already at H+72 — reset to walk again." });
      return;
    }
    setAdvancing(true);
    const nextIndex = beatIndex + 1;
    const targetHour = BEATS[nextIndex].hour;
    try {
      // Best-effort audit write. The local scenario advances regardless
      // so a brief 5xx doesn't strand the presenter mid-walk; the toast
      // surfaces the failure for post-demo review.
      await api.system.dhaRescueAudit({
        action: "advance",
        advance_to_hour: targetHour,
        subject_id: `dha-rescue-h${targetHour}`,
      });
    } catch (e) {
      pushToast({ tone: "warn", text: `Audit write failed (advance): ${formatApiError(e)}` });
    } finally {
      setBeatIndex(nextIndex);
      setAdvancing(false);
    }
  }

  function resetScenario() {
    setBeatIndex(0);
    setApprovedIds(new Set());
  }

  async function approveRec(rec: SourcingRec) {
    if (approvingId) return;
    setApprovingId(rec.id);
    try {
      await api.system.dhaRescueAudit({
        action: "approve_sourcing",
        recommendation_id: rec.id,
        advance_to_hour: BEATS[beatIndex].hour,
        subject_id: `dha-rescue-${rec.product_key}`,
      });
      setApprovedIds((prev) => {
        const next = new Set(prev);
        next.add(rec.id);
        return next;
      });
      pushToast({
        tone: "ok",
        text: `Sourcing approved · ${rec.source} · audit row written`,
        ttlMs: 3500,
      });
    } catch (e) {
      pushToast({ tone: "error", text: `Audit write failed: ${formatApiError(e)}` });
    } finally {
      setApprovingId(null);
    }
  }

  const beat = BEATS[beatIndex];

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-[var(--color-bg)] p-5">
      {/* Hero strip — use-case framing. Only renders the badge in stage
       * mode (it's redundant noise in operator browse). */}
      {stageMode && (
        <div
          className="rounded-md border px-4 py-3"
          style={{
            borderColor: "color-mix(in oklab, var(--color-danger) 55%, var(--color-border))",
            background:
              "linear-gradient(135deg, color-mix(in oklab, var(--color-danger) 8%, var(--color-surface)) 0%, var(--color-surface) 70%)",
          }}
        >
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--color-danger)]">
            USE CASE 4 · DHA RESCUE · BLOOD/CLASS VIII · {beat.label} — DMO
          </div>
          <h1 className="mt-1 font-sans text-xl font-semibold text-[var(--color-text)]">
            Predictive blood &amp; Class VIII sustainment under DMO
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-[var(--color-text-secondary)]">
            Hub-spoke schematic, days-of-supply gauges, and market-aware
            sourcing on a single decision surface. Every approval and
            every advance writes a hash-chained audit row.
          </p>
        </div>
      )}

      {/* When the stage badge is hidden we still want a single h1 for
       * screen readers + document outline. */}
      {!stageMode && (
        <h1 className="font-mono text-sm font-semibold uppercase tracking-[0.22em] text-[var(--color-text)]">
          DHA RESCUE · Class VIII / Blood Resupply · {beat.label}
        </h1>
      )}

      {/* Advance bar — sits high so the audience sees the active hour
       * before reading the gauges. */}
      <div
        className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5"
        role="region"
        aria-label="Scenario advance bar"
      >
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Scenario hour
          </span>
          <div className="flex items-center gap-1" role="tablist" aria-label="Scenario hour selector">
            {BEATS.map((b, i) => (
              <button
                key={b.label}
                type="button"
                role="tab"
                aria-selected={i === beatIndex}
                onClick={() => {
                  if (i === beatIndex) return;
                  setBeatIndex(i);
                  pushToast({
                    tone: "info",
                    text: `Scenario set to ${b.label}`,
                    ttlMs: 2500,
                  });
                }}
                className="rounded-sm border px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums tracking-widest transition-colors hover:border-[var(--color-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-selected)]"
                style={{
                  borderColor: i === beatIndex
                    ? "var(--color-primary)"
                    : i < beatIndex
                      ? "color-mix(in oklab, var(--color-success) 60%, var(--color-border))"
                      : "var(--color-border)",
                  background: i === beatIndex
                    ? "color-mix(in oklab, var(--color-primary) 18%, var(--color-surface))"
                    : "transparent",
                  color: i === beatIndex
                    ? "var(--color-text)"
                    : i < beatIndex
                      ? "var(--color-success)"
                      : "var(--color-text-muted)",
                  cursor: "pointer",
                }}
                aria-current={i === beatIndex ? "step" : undefined}
                title={`Jump to ${b.label}`}
              >
                {b.label}
              </button>
            ))}
          </div>
          {/* Round-4 — backend-sourced injected-events count, proves
           * `/api/system/scenario/blood-h72/feed` is wired and live. */}
          <span
            className="hidden font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)] sm:inline"
            aria-label={
              feedErr
                ? `Scenario feed unavailable: ${feedErr}`
                : feed
                  ? `${feed.events.length} scripted events injected through ${beat.label}`
                  : "Scenario feed loading"
            }
            title="Sourced from /api/system/scenario/blood-h72/feed"
          >
            {feedErr
              ? "feed: unavailable"
              : feed
                ? `feed · ${feed.events.filter((e) => (e.offset_min ?? 0) <= beat.hour * 60).length}/${feed.events.length} fired`
                : "feed · loading"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="md"
            onClick={advance}
            disabled={advancing || beatIndex >= BEATS.length - 1}
            aria-label="Advance to next scenario beat"
            title="Advance the scenario (writes audit-chain entry)"
          >
            {beatIndex >= BEATS.length - 1 ? "At H+72" : `Advance to ${BEATS[beatIndex + 1].label}`}
          </Button>
          <Button
            variant="secondary"
            size="md"
            onClick={resetScenario}
            disabled={beatIndex === 0 && approvedIds.size === 0}
            aria-label="Reset scenario to H+0"
            title="Reset scenario to H+0 (does not touch audit chain)"
          >
            Reset
          </Button>
        </div>
      </div>

      {/* Top row — hub-spoke + days-of-supply */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section
          className="flex min-h-[260px] flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          aria-label="Hub-spoke schematic"
        >
          <header className="flex items-center justify-between border-b border-[var(--color-border)] pb-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
              Hub-spoke · DMO topology
            </span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)]">
              {beat.label} · contested routes amber-dashed
            </span>
          </header>
          <div className="mt-3 flex-1">
            <HubSpokeMap beatIndex={beatIndex} />
          </div>
        </section>

        <section
          className="flex min-h-[260px] flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          aria-label="Days of supply gauges"
        >
          <header className="flex items-center justify-between border-b border-[var(--color-border)] pb-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
              Days of supply · hub stocks @ {beat.label}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)]">
              PRBC · FFP · PLT · WBB
            </span>
          </header>
          <div className="mt-3 grid flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
            {PRODUCTS.map((p) => (
              <DaysOfSupplyGauge key={p.key} product={p} beatIndex={beatIndex} />
            ))}
          </div>
        </section>
      </div>

      {/* Middle row — market sourcing + live shortages */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section
          className="flex min-h-[220px] flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          aria-label="Market sourcing recommendations"
        >
          <header className="flex items-center justify-between border-b border-[var(--color-border)] pb-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
              Market sourcing · alternates surfaced under hard-min
            </span>
            <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)]">
              Approve writes audit row
            </span>
          </header>
          <div className="mt-3 flex-1 overflow-y-auto">
            <MarketSourcingPanel
              beatIndex={beatIndex}
              onApprove={approveRec}
              approvedIds={approvedIds}
              busyId={approvingId}
            />
          </div>
        </section>

        <section
          className="flex min-h-[220px] flex-col rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          aria-label="Live shortages"
        >
          <header className="flex items-center justify-between border-b border-[var(--color-border)] pb-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
              Live shortages · medical first
            </span>
            <Pressable
              onClick={() => nav("/pulse/forecast")}
              block={false}
              className="rounded-sm border border-[var(--color-border)] px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
            >
              Open PULSE forecast →
            </Pressable>
          </header>
          <div className="mt-3 flex-1 overflow-y-auto">
            {shortagesErr && !shortages ? (
              <ErrorState title="Shortages unavailable" description={shortagesErr} />
            ) : !shortages ? (
              <LoadingState label="Loading live shortages" />
            ) : visibleShortages.length === 0 ? (
              <EmptyState title="No shortages in scope" description="All watched classes above minimum." />
            ) : (
              <ul className="flex flex-col gap-2">
                {visibleShortages.map((s) => (
                  <ShortageRow key={`${s.kind}-${s.item}`} s={s} />
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* Vignette + jump-buttons strip — kept from prior pass so the
       * presenter can still hop into BASTION's scripted vignette. */}
      <section
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        aria-label="H+72 vignette and jump controls"
      >
        <header className="flex items-center justify-between border-b border-[var(--color-border)] pb-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
            H+72 blood vignette
          </span>
          {vignette ? (
            <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)]">
              {vignette.beats?.length ?? 0} beats · {vignette.duration_minutes}m
            </span>
          ) : null}
        </header>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <div className="lg:col-span-2">
            {vignetteErr && !vignette ? (
              <ErrorState title="Vignette unavailable" description={vignetteErr} />
            ) : !vignette ? (
              <LoadingState label="Loading vignette" />
            ) : (
              <>
                <div className="font-sans text-base font-semibold text-[var(--color-text)]">
                  {vignette.title}
                </div>
                <p className="mt-1 text-sm leading-snug text-[var(--color-text-secondary)]">
                  {vignette.summary}
                </p>
                {vignette.phases?.length ? (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {vignette.phases.map((p) => (
                      <li
                        key={`${p.offset_min}-${p.label}`}
                        className="rounded-sm border border-[var(--color-border)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]"
                      >
                        H+{p.offset_min}m · {p.label}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </div>
          <div className="flex flex-wrap items-start gap-2 lg:justify-end">
            <Button
              variant="primary"
              size="md"
              onClick={() => nav("/bastion")}
              aria-label="Walk the H+72 blood vignette on BASTION"
              title="Open BASTION — walk the H+72 blood vignette"
            >
              Walk the vignette →
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => nav("/pulse/forecast")}
              aria-label="Open PULSE forecast"
              title="Open PULSE forecast for unit-level Class VIII signals"
            >
              PULSE forecast
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => nav("/admin/audit")}
              aria-label="Open audit chain"
              title="Open audit chain (15-minute window pre-applied in stage mode)"
            >
              View audit chain →
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => nav("/")}
              aria-label="Return to Decision Bridge"
              title="Return to Decision Bridge"
            >
              Back to bridge
            </Button>
          </div>
        </div>
      </section>

      {/* Bottom strap — proof statement. Phrased to avoid AI / vendor
       * attribution per the stage-pivot constraints. */}
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          Why this matters
        </div>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          Whole-blood and FFP windows are short. Pushing requirements,
          hub stocks, cold-chain status, contested-route timing, and
          market alternates onto a single decision surface lets the
          planner cut the request-to-airframe interval — and gives the
          surgeon a defensible, audit-chained decision the moment it's
          made.
        </p>
      </div>
    </div>
  );
}
