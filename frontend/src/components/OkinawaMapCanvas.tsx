/**
 * OkinawaMapCanvas — MapLibre GL canvas centered on the three-island
 * stand-in-forces scenario (Okinawa Honto, Miyako, Ishigaki). Renders
 * draggable MIL-STD-2525D markers via milsymbol; persistence + drag
 * history live in `state/markers.ts`.
 *
 * This component intentionally has no dataset coupling — it operates
 * on a separate planning layer so it remains usable both before
 * GCSS-MC ingest (the "lay of the land" view) and after (where the
 * unit positions overlay alongside readiness data).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import ms from "milsymbol";

import { useMarkersStore, type Marker } from "../state/markers";
import {
  ISLAND_PRESETS,
  OKINAWA_VIEW,
  OKINAWA_SCENARIO,
} from "../data/okinawa-scenario";
import { useSpireStore } from "../state/store";
import { registerMapBridge } from "../state/mapBridge";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, type SupplyClassStatus, type UnitSummary } from "../api";

// CartoDB Dark Matter — free vector tile style, no key, IL5-OK as a
// public-internet base for the demo. Production swap target is a
// PMTiles file bundled with the build for the air-gap path.
const CARTO_DARK_STYLE =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

// milsymbol options — base size is intentionally small (22px native)
// so single-island zoom levels render at a readable but unobtrusive
// scale. Theater-scale pull-back further shrinks via the zoom curve
// in scaleForZoom() below. Labels are white so they read against the
// dark CartoDB tiles.
const SYMBOL_BASE_OPTS = {
  size: 22,
  fillOpacity: 1,
  strokeWidth: 2.5,
  infoColor: "#ffffff",
  infoSize: 36,
  infoFields: true,
};

// milsymbol v3 default export carries the `Symbol` constructor.
// `withLabel=false` renders just the icon glyph (no text fields) — the
// decluttering pass uses this to hide labels that would collide.
function symbolSVG(m: Marker, withLabel: boolean): string {
  const sym = new ms.Symbol(m.sidc, {
    ...SYMBOL_BASE_OPTS,
    ...(withLabel
      ? {
          additionalInformation: m.additionalInfo ?? "",
          uniqueDesignation: m.label,
          higherFormation: m.parent ?? "",
        }
      : {}),
    ...(m.echelon ? { echelon: m.echelon } : {}),
  });
  return sym.asSVG();
}

function styleSymbolSvg(svgEl: SVGElement | null): void {
  if (!svgEl) return;
  svgEl.style.display = "block";
  // milsymbol estimates label width slightly short, so long designations
  // (e.g. "JGSDF Miyako", "7 SSM Regiment") run past the computed viewBox
  // and the SVG's default overflow:hidden clips them mid-word. Let the
  // labels paint outside the box. Base contrast shadow + MC-state glow
  // live in index.css (.spire-milsymbol-inner svg).
  svgEl.style.overflow = "visible";
}

function renderSymbolHTML(m: Marker, withLabel: boolean): HTMLElement {
  // Outer element is what MapLibre positions on the map (its transform
  // is mlbr-managed). Inner element wraps the milsymbol SVG and is
  // what *we* scale on zoom changes — keeping our scale separate
  // from MapLibre's translate3d() means we can compose them safely.
  const wrap = document.createElement("div");
  wrap.className = "spire-milsymbol-marker";
  wrap.style.cursor = "grab";
  wrap.style.userSelect = "none";
  // Mark this element so the zoom listener can find it cheaply.
  wrap.dataset.spireMilsymbol = "1";
  wrap.dataset.labeled = withLabel ? "1" : "0";

  const inner = document.createElement("div");
  inner.className = "spire-milsymbol-inner";
  inner.style.transformOrigin = "center center";
  inner.style.transition = "transform 120ms ease-out";
  inner.innerHTML = symbolSVG(m, withLabel);
  styleSymbolSvg(inner.querySelector("svg"));
  wrap.appendChild(inner);
  return wrap;
}

// Swap an existing marker between labeled / symbol-only in place,
// preserving the inner element (so its zoom transform survives).
function setMarkerLabeled(el: HTMLElement, m: Marker, withLabel: boolean): void {
  if (el.dataset.labeled === (withLabel ? "1" : "0")) return;
  const inner = el.querySelector<HTMLElement>(".spire-milsymbol-inner");
  if (!inner) return;
  inner.innerHTML = symbolSVG(m, withLabel);
  styleSymbolSvg(inner.querySelector("svg"));
  el.dataset.labeled = withLabel ? "1" : "0";
}

type LabelBox = { left: number; top: number; right: number; bottom: number };

// Estimate a marker's on-screen label box (screen px) for collision
// decluttering. milsymbol draws text to the right of the symbol; we
// approximate the extent from the projected position, the zoom scale,
// and the longest label line. Tuned against the live COP.
function estimateLabelBox(cx: number, cy: number, m: Marker, scale: number): LabelBox {
  const lines = [m.label, m.additionalInfo ?? "", m.parent ?? ""].filter(Boolean);
  const longest = lines.reduce((n, l) => Math.max(n, l.length), 0);
  const charW = 36 * scale * 0.21; // infoSize 36, ~0.21 px/char/unit on-screen
  const lineH = 36 * scale * 0.5;
  const symbolHalf = 11 * scale;
  const labelW = symbolHalf + 4 + longest * charW;
  const labelH = Math.max(symbolHalf * 2, lines.length * lineH);
  return {
    left: cx - symbolHalf,
    top: cy - labelH / 2,
    right: cx + labelW,
    bottom: cy + labelH / 2,
  };
}

function boxesIntersect(a: LabelBox, b: LabelBox): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

/**
 * Smart icon-size curve. milsymbol renders at a fixed pixel size, so
 * without this every symbol stays the same screen size at z=2 (whole
 * Pacific) as at z=14 (single garrison gate) — gigantic and unreadable
 * when pulled back. Scale grows linearly with zoom and is clamped at
 * both ends so we never get a 1px speck or a viewport-filling chevron.
 *
 * Reference points (with native size = 22 px):
 *   z=4  (theater)    → scale 0.18 → ~4 px  — barely visible dots
 *   z=6  (regional)   → scale 0.34 → ~7 px  — readable cluster
 *   z=8  (per-island) → scale 0.66 → ~14 px — symbol shape clear
 *   z=10 (per-camp)   → scale 1.00 → 22 px  — labels start to read
 *   z=12 (per-bldg)   → scale 1.30 → ~29 px — full doctrinal detail
 *   z=14 (max)        → scale 1.50 → ~33 px — clamped
 */
function scaleForZoom(zoom: number): number {
  const min = 0.18;
  const max = 1.5;
  const s = 1.0 + (zoom - 10) * 0.16;
  return Math.max(min, Math.min(max, s));
}

function applyZoomScale(map: maplibregl.Map) {
  const z = map.getZoom();
  const s = scaleForZoom(z);
  // MapLibre keeps marker DOM under its container; our markers are
  // tagged with data-spire-milsymbol so we can scale just ours.
  const root = map.getContainer();
  const inners = root.querySelectorAll<HTMLElement>(
    "[data-spire-milsymbol] > .spire-milsymbol-inner",
  );
  inners.forEach((el) => {
    el.style.transform = `scale(${s.toFixed(3)})`;
  });
}

interface Props {
  // Optional initial preset — useful if a parent route encodes
  // "?island=miyako" for SPIRO grounding.
  initialIsland?: keyof typeof ISLAND_PRESETS;
  // Render an inline header bar with the per-island shortcut chips +
  // reset button. False when embedding inside a larger frame that
  // already provides chrome.
  showHeader?: boolean;
}

export function OkinawaMapCanvas({
  initialIsland,
  showHeader = true,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRefs = useRef<Map<string, maplibregl.Marker>>(new Map());
  const [ready, setReady] = useState(false);

  const markers = useMarkersStore((s) => s.markers);
  const moveMarker = useMarkersStore((s) => s.moveMarker);
  const dirty = useMarkersStore((s) => s.dirty);
  const resetToSeed = useMarkersStore((s) => s.resetToSeed);
  const locked = useMarkersStore((s) => s.locked);
  const setLocked = useMarkersStore((s) => s.setLocked);

  const currentUser = useSpireStore((s) => s.currentUser);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Selected marker — clicking a marker pops a side drawer that pulls
  // live readiness from /api/bastion/cop for the marker's pulseUnit
  // alias. Selection state also feeds SPIRO's planner via the
  // selectedMarker context the chat panel reads from this store.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Ref mirror so the bridge's getSelectedMarker callback (registered
  // once at mount) reads current state without stale-closure pain.
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
    // Also publish on the SPIRE store so the chat panel can include
    // it in the planner request without prop-drilling.
    try {
      window.dispatchEvent(
        new CustomEvent("spire:map-selection", {
          detail: { markerId: selectedId },
        }),
      );
    } catch { /* tolerant */ }
  }, [selectedId]);
  const selectedMarker: Marker | null = useMemo(
    () => markers.find((m) => m.id === selectedId) ?? null,
    [markers, selectedId],
  );

  // Hovered marker — its label is always shown (and raised above
  // neighbors) so an operator can pull up a name in a dense cluster
  // without clicking. Ref mirror keeps the relayout closure current.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  useEffect(() => {
    hoveredIdRef.current = hoveredId;
  }, [hoveredId]);

  // Deep-link from PULSE Risk Board: /bastion?unit=CLB-1 selects the
  // marker aliased to that PULSE unit and flies the camera to it. We
  // wait for `ready` so the bridge is registered + map is initialized.
  const queryUnit = searchParams.get("unit");
  useEffect(() => {
    if (!ready || !queryUnit) return;
    const m = OKINAWA_SCENARIO.find(
      (x) => (x.pulseUnit ?? "").toLowerCase() === queryUnit.toLowerCase(),
    );
    if (!m) return;
    setSelectedId(m.id);
    const map = mapRef.current;
    if (map) map.flyTo({ center: m.coords, zoom: 12, duration: 1100 });
  }, [ready, queryUnit]);

  // PULSE×BASTION-A2 — single-call commander summary for the selected
  // unit. Replaces the previous /bastion/cop filter pattern; one round
  // trip carries MC state, supply chips, alerts, TMRs, and PULSE
  // deep-link URLs the drawer renders below.
  const [unitSummary, setUnitSummary] = useState<UnitSummary | null>(null);
  const [pulseLoading, setPulseLoading] = useState(false);
  useEffect(() => {
    if (!selectedMarker?.pulseUnit) {
      setUnitSummary(null);
      return;
    }
    let cancelled = false;
    setPulseLoading(true);
    api.pulse
      .unitSummary(selectedMarker.pulseUnit)
      .then((s) => {
        if (cancelled) return;
        setUnitSummary(s);
      })
      .catch(() => {
        if (!cancelled) setUnitSummary(null);
      })
      .finally(() => {
        if (!cancelled) setPulseLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedMarker?.pulseUnit]);

  // PULSE×BASTION-A1 — fleet-wide MC state map for marker halos.
  // One /bastion/cop round-trip at mount gives us every unit's
  // mc_rate; we project that into a {pulseUnit → state} dict and
  // the marker reconciliation effect (below) writes data-mc-state
  // on each marker's DOM. Halo CSS in index.css picks up the attr.
  // Refresh cadence: once on map ready + whenever the operator
  // returns to BASTION (re-mounted). For the live demo this is
  // adequate; a "tick" toast or scheduled refetch can layer on if
  // we ever want second-by-second telemetry.
  const [mcByUnit, setMcByUnit] = useState<Record<string, SupplyClassStatus>>({});
  useEffect(() => {
    // Fetch the readiness halo data on MOUNT, in parallel with the map
    // tiles — not gated on `ready` — so the MC dict is usually in hand by
    // the time the map paints and markers light up on first frame instead
    // of flashing plain. The marker-sync effect (deps include mcByUnit)
    // stamps data-mc-state as soon as BOTH the map is ready and this lands.
    //
    // Retry-until-data: a single /cop that hits a cold/warming machine
    // (Fly auto-stop wakes one on the first hit) returns an empty COP, and
    // a one-shot fetch would leave every icon unhalo'd until the operator
    // re-entered BASTION. Poll a few times so the halos reliably appear
    // once the dataset is live.
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const MAX_ATTEMPTS = 8;

    const load = () => {
      attempts += 1;
      api.bastion
        .cop()
        .then((c) => {
          if (cancelled) return;
          const empty = (c as unknown as { empty?: boolean }).empty;
          const units = empty ? [] : c.units ?? [];
          if (units.length === 0) {
            if (attempts < MAX_ATTEMPTS) timer = setTimeout(load, 1500);
            else setMcByUnit({});
            return;
          }
          const out: Record<string, SupplyClassStatus> = {};
          for (const u of units) {
            const r = u.mc_rate ?? 0;
            out[u.unit] = r >= 0.85 ? "green" : r >= 0.6 ? "amber" : "red";
          }
          setMcByUnit(out);
        })
        .catch(() => {
          if (cancelled) return;
          if (attempts < MAX_ATTEMPTS) timer = setTimeout(load, 1500);
          else setMcByUnit({});
        });
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Initial-mount: build the map once, attach controls.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const start = initialIsland
      ? ISLAND_PRESETS[initialIsland]
      : { center: OKINAWA_VIEW.center, zoom: OKINAWA_VIEW.zoom };

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: CARTO_DARK_STYLE,
      center: start.center,
      zoom: start.zoom,
      minZoom: OKINAWA_VIEW.minZoom,
      maxZoom: OKINAWA_VIEW.maxZoom,
      attributionControl: { compact: true },
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

    map.on("load", () => setReady(true));
    // Zoom-aware icon sizing — without this, milsymbol icons render at
    // a fixed pixel size at every zoom level and are unreadably huge
    // when the operator pulls back to theater scale.
    const onZoom = () => applyZoomScale(map);
    map.on("zoom", onZoom);
    map.on("zoomend", onZoom);

    mapRef.current = map;

    // Register the SPIRO bridge so map_fly_to / map_select_marker tool
    // calls reach the live map. Cleared on unmount; if the operator
    // navigates off BASTION the bridge resolves to null and SPIRO
    // tools fall back to text-only answers.
    registerMapBridge({
      flyTo: (lng, lat, zoom) => {
        const m = mapRef.current;
        if (!m) return;
        m.flyTo({
          center: [lng, lat],
          zoom: zoom ?? 11,
          duration: 1100,
        });
      },
      selectMarker: (id) => setSelectedId(id),
      getSelectedMarker: () =>
        OKINAWA_SCENARIO.find((x) => x.id === (selectedIdRef.current ?? "")) ??
        null,
    });

    return () => {
      registerMapBridge(null);
      mapRef.current?.remove();
      mapRef.current = null;
      markerRefs.current.clear();
    };
    // initialIsland intentionally captured at mount; pan-to-island
    // happens via the header chips below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Marker sync — reconcile the DOM markers against the store.
  // We avoid a full teardown each render by reusing maplibre Marker
  // instances and only recreating the inner DOM when the SIDC / label
  // changes.
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    const map = mapRef.current;
    const existing = markerRefs.current;
    const seen = new Set<string>();

    for (const m of markers) {
      seen.add(m.id);
      const prev = existing.get(m.id);
      if (prev) {
        // Update position if the store moved it (e.g. SPIRO command).
        const lng = m.coords[0];
        const lat = m.coords[1];
        const cur = prev.getLngLat();
        if (cur.lng !== lng || cur.lat !== lat) {
          prev.setLngLat([lng, lat]);
        }
        // PULSE×BASTION-A1 — keep the readiness halo in sync as the
        // map's MC dictionary refreshes. Cheap to set unconditionally
        // (DOM attribute write is a no-op when the value is unchanged).
        const prevEl = prev.getElement() as HTMLElement | null;
        if (prevEl && m.pulseUnit) {
          const state = mcByUnit[m.pulseUnit];
          if (state) prevEl.dataset.mcState = state;
          else delete prevEl.dataset.mcState;
        }
        continue;
      }
      // Mount symbol-only; the declutter pass below adds labels where
      // they fit (and on hover/selection), so dense clusters don't pile
      // overlapping text on first paint.
      const el = renderSymbolHTML(m, false);
      // Stamp readiness halo on first mount so newly-rendered
      // markers don't flash unhalo'd before the COP fetch completes.
      if (m.pulseUnit) {
        const state = mcByUnit[m.pulseUnit];
        if (state) el.dataset.mcState = state;
      }
      const marker = new maplibregl.Marker({
        element: el,
        draggable: !locked,
        anchor: "center",
      })
        .setLngLat(m.coords)
        .addTo(map);

      el.style.cursor = locked ? "pointer" : "grab";

      // Click → open the right drawer with live PULSE readiness. We
      // suppress the default popup so the operator gets a richer side
      // panel instead of the inline white box.
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        setSelectedId(m.id);
      });

      // Hover surfaces this marker's label (and raises it) even in a
      // crowded cluster where the declutter pass otherwise hid it.
      el.addEventListener("mouseenter", () => setHoveredId(m.id));
      el.addEventListener("mouseleave", () =>
        setHoveredId((cur) => (cur === m.id ? null : cur)),
      );

      marker.on("dragstart", () => {
        el.style.cursor = "grabbing";
      });
      marker.on("dragend", () => {
        el.style.cursor = locked ? "pointer" : "grab";
        const ll = marker.getLngLat();
        moveMarker(
          m.id,
          [ll.lng, ll.lat],
          currentUser?.initials ?? undefined,
        );
      });

      existing.set(m.id, marker);
    }

    // Remove markers that disappeared from the store.
    for (const [id, marker] of Array.from(existing.entries())) {
      if (!seen.has(id)) {
        marker.remove();
        existing.delete(id);
      }
    }

    // Make sure newly-added markers pick up the current zoom scale on
    // first paint instead of flashing in at native size.
    applyZoomScale(map);
  }, [markers, ready, moveMarker, currentUser?.initials, locked, mcByUnit]);

  // Label decluttering. Greedy collision pass: walk markers by priority
  // (selected > hovered > PULSE-backed > other); a label shows only if
  // its estimated screen box doesn't overlap an already-placed label.
  // Selected/hovered always win and are raised. Re-runs on zoom/pan and
  // whenever selection/hover changes. Keeps the COP readable from
  // theater scale down to a single dense base cluster.
  const relayoutLabels = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const scale = scaleForZoom(map.getZoom());
    const sel = selectedIdRef.current;
    const hov = hoveredIdRef.current;
    const entries = markers
      .map((m) => {
        const marker = markerRefs.current.get(m.id);
        if (!marker) return null;
        const ll = marker.getLngLat();
        const p = map.project([ll.lng, ll.lat]);
        const pr = m.id === sel ? 3 : m.id === hov ? 2 : m.pulseUnit ? 1 : 0;
        return { m, el: marker.getElement() as HTMLElement, x: p.x, y: p.y, pr };
      })
      .filter((e): e is { m: Marker; el: HTMLElement; x: number; y: number; pr: number } => e !== null);
    entries.sort((a, b) => b.pr - a.pr || a.m.id.localeCompare(b.m.id));
    const placed: LabelBox[] = [];
    for (const e of entries) {
      const box = estimateLabelBox(e.x, e.y, e.m, scale);
      const show = e.pr >= 2 || !placed.some((p) => boxesIntersect(box, p));
      if (show) placed.push(box);
      setMarkerLabeled(e.el, e.m, show);
      e.el.style.zIndex = e.pr >= 2 ? "6" : show ? "3" : "1";
    }
  }, [markers]);

  // Re-declutter on selection/hover changes and after markers (re)mount.
  useEffect(() => {
    if (ready) relayoutLabels();
  }, [ready, markers, selectedId, hoveredId, mcByUnit, relayoutLabels]);

  // Re-declutter when the camera settles (zoom/pan changes which labels fit).
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const onSettle = () => relayoutLabels();
    map.on("zoomend", onSettle);
    map.on("moveend", onSettle);
    return () => {
      map.off("zoomend", onSettle);
      map.off("moveend", onSettle);
    };
  }, [ready, relayoutLabels]);

  // Apply lock/unlock to every existing marker so the user toggling
  // the chip flips draggability for every already-rendered icon.
  useEffect(() => {
    if (!ready) return;
    markerRefs.current.forEach((marker) => {
      marker.setDraggable(!locked);
      const el = marker.getElement() as HTMLElement | null;
      if (el) el.style.cursor = locked ? "pointer" : "grab";
    });
  }, [locked, ready]);

  function flyToIsland(island: keyof typeof ISLAND_PRESETS) {
    const map = mapRef.current;
    if (!map) return;
    const preset = ISLAND_PRESETS[island];
    map.flyTo({ center: preset.center, zoom: preset.zoom, duration: 1100 });
  }

  function flyToAll() {
    const map = mapRef.current;
    if (!map) return;
    map.flyTo({
      center: OKINAWA_VIEW.center,
      zoom: OKINAWA_VIEW.zoom,
      duration: 1100,
    });
  }

  // 3D pitch toggle — swings the camera between top-down (0°) and
  // oblique (60°). MapLibre's NavigationControl exposes pitch via the
  // compass dial, but the explicit chip is faster on stage and matches
  // the affordance from the previous BASTION map.
  const [pitched, setPitched] = useState(false);
  function togglePitch() {
    const map = mapRef.current;
    if (!map) return;
    const next = pitched ? 0 : 55;
    map.easeTo({ pitch: next, duration: 700 });
    setPitched(!pitched);
  }

  // Quick stats per island for the header chip — lets the operator
  // see "Miyako: 6" so they know nothing got lost during a drag spree.
  const counts = useMemo(() => {
    const c: Record<string, number> = { okinawa: 0, miyako: 0, ishigaki: 0 };
    for (const m of markers) c[m.island] = (c[m.island] ?? 0) + 1;
    return c;
  }, [markers]);

  return (
    // Bulletproof sizing — explicit `height: 100%` plus `min-height:
    // 24rem` floor guarantees MapLibre always has a non-zero canvas to
    // mount into, even when an ancestor's flexbox height-chain hasn't
    // resolved yet. We dropped `absolute inset-0` after it interacted
    // poorly with the parent's overflow-hidden in the populated path
    // and left the map invisible despite no console errors. The
    // min-height is a safety floor; in practice the map fills its
    // container via h-full whenever the parent is constrained.
    <div
      className="flex w-full flex-col"
      style={{ height: "100%", minHeight: "24rem" }}
    >
      {showHeader && (
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
          <span className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
            COP · NANSEI SHOTO
          </span>
          <div className="ml-2 flex items-center gap-1">
            <button
              type="button"
              onClick={flyToAll}
              className="rounded-sm border border-[var(--color-border)] px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
              aria-label="Fit map to all three islands"
            >
              All
            </button>
            <button
              type="button"
              onClick={() => flyToIsland("okinawa")}
              className="rounded-sm border border-[var(--color-border)] px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
            >
              Okinawa · {counts.okinawa}
            </button>
            <button
              type="button"
              onClick={() => flyToIsland("miyako")}
              className="rounded-sm border border-[var(--color-border)] px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
            >
              Miyako · {counts.miyako}
            </button>
            <button
              type="button"
              onClick={() => flyToIsland("ishigaki")}
              className="rounded-sm border border-[var(--color-border)] px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
            >
              Ishigaki · {counts.ishigaki}
            </button>
          </div>
          <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            MIL-STD-2525D
          </span>
          {/* 3D pitch toggle — equivalent to the 3D affordance on the
           * previous BASTION map. */}
          <button
            type="button"
            onClick={togglePitch}
            className={
              "rounded-sm border px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors " +
              (pitched
                ? "border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_18%,var(--color-surface))] text-[var(--color-primary)]"
                : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]")
            }
            aria-pressed={pitched}
            aria-label={pitched ? "Switch to top-down view" : "Switch to oblique 3D view"}
            title={pitched ? "Top-down (2D)" : "Oblique (3D)"}
          >
            {pitched ? "2D" : "3D"}
          </button>
          {/* Lock toggle — markers are immutable when locked so a
           * casual click can't drift a garrison. Toggle to plan. */}
          <button
            type="button"
            onClick={() => setLocked(!locked)}
            className={
              "rounded-sm border px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors " +
              (locked
                ? "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
                : "border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning)_15%,var(--color-surface))] text-[var(--color-warning)] hover:bg-[color-mix(in_oklab,var(--color-warning)_28%,var(--color-surface))]")
            }
            aria-pressed={!locked}
            aria-label={locked ? "Unlock markers — enable drag to reposition" : "Lock markers — disable drag"}
            title={locked ? "Locked · click to unlock and drag" : "Unlocked · drag enabled"}
          >
            {locked ? "🔒 Locked" : "🔓 Plan"}
          </button>
          {dirty && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm("Reset all markers to scenario seed positions?")) {
                  resetToSeed();
                }
              }}
              className="rounded-sm border border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning)_15%,var(--color-surface))] px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-warning)] hover:bg-[color-mix(in_oklab,var(--color-warning)_28%,var(--color-surface))]"
              aria-label="Reset all markers to their initial scenario positions"
            >
              Reset to Seed
            </button>
          )}
        </div>
      )}
      <div className="relative flex-1 min-h-0 w-full">
        {/* h-full w-full not `absolute inset-0` — MapLibre's CSS sets
         * .maplibregl-map { position: relative } which beats the Tailwind
         * `absolute` class and collapses the wrapper to h:0. Filling the
         * parent via flex height is the path that survives MapLibre's
         * stylesheet without !important hacks. */}
        <div ref={containerRef} className="h-full w-full" />
        {selectedMarker && (
          <MarkerDrawer
            marker={selectedMarker}
            summary={unitSummary}
            loading={pulseLoading}
            onClose={() => setSelectedId(null)}
            onOpenForecast={() => {
              if (selectedMarker.pulseUnit) {
                navigate(`/pulse/forecast?unit=${encodeURIComponent(selectedMarker.pulseUnit)}`);
              } else {
                navigate("/pulse/forecast");
              }
            }}
            onOpenRiskBoard={() => {
              if (selectedMarker.pulseUnit) {
                navigate(`/pulse/risk?unit=${encodeURIComponent(selectedMarker.pulseUnit)}`);
              } else {
                navigate("/pulse");
              }
            }}
            onAskSpiro={() => {
              try {
                window.dispatchEvent(
                  new CustomEvent("spire:open-spiro", {
                    detail: {
                      prompt: `What's the readiness picture for ${selectedMarker.label} (${selectedMarker.parent})?`,
                    },
                  }),
                );
              } catch { /* tolerant */ }
            }}
          />
        )}
      </div>
    </div>
  );
}

// PULSE×BASTION-A — readiness-first drawer.
//
// Click a unit symbol → drawer slides in from the right with the
// commander's full picture for that unit in one round-trip:
//
//   - MC state (color-coded, mirrors the map halo)
//   - Asset counts (MC / PMC / NMCM / NMCS) with totals
//   - Five supply classes as chips (Class I / III / V / VIII / IX)
//   - Top 3 unit-scoped alerts
//   - Inbound / outbound TMRs (transportation movement requests)
//   - Three CTAs: "Forecast" → 14d Monte Carlo for this unit;
//     "Risk Board" → asset-level cannibalization candidates;
//     "Ask SPIRO" → opens the planner pre-loaded with the marker.
function _toneForState(state?: SupplyClassStatus | null): string {
  switch (state) {
    case "green":     return "var(--color-success)";
    case "amber":     return "var(--color-warning)";
    case "red":       return "var(--color-danger)";
    default:          return "var(--color-text-muted)";
  }
}

function _classLabel(klass: keyof UnitSummary["supply"]): string {
  switch (klass) {
    case "class_i":    return "I — Subsist";
    case "class_iii":  return "III — Fuel";
    case "class_v":    return "V — Ammo";
    case "class_viii": return "VIII — Med";
    case "class_ix":   return "IX — Parts";
  }
}

function SupplyChip({
  klass, cell,
}: {
  klass: keyof UnitSummary["supply"];
  cell: UnitSummary["supply"]["class_ix"] | UnitSummary["supply"]["class_i"];
}) {
  const tone = _toneForState(cell.status);
  const label = _classLabel(klass);
  const detail =
    cell.status === "no_signal"
      ? "no signal"
      : cell.primary_metric
        ? cell.primary_metric
        : (cell.hits && cell.hits[0]?.title) || cell.status;
  return (
    <div
      className="flex items-baseline justify-between gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5"
      title={
        cell.hits && cell.hits.length
          ? cell.hits.map((h) => h.title || "").filter(Boolean).join("\n")
          : undefined
      }
    >
      <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)]">
        {label}
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="inline-block size-2 rounded-full"
          style={{ background: tone }}
        />
        <span className="font-mono text-[10px] tabular-nums text-[var(--color-text)]">
          {detail}
        </span>
      </span>
    </div>
  );
}

function MarkerDrawer({
  marker,
  summary,
  loading,
  onClose,
  onOpenForecast,
  onOpenRiskBoard,
  onAskSpiro,
}: {
  marker: Marker;
  summary: UnitSummary | null;
  loading: boolean;
  onClose: () => void;
  onOpenForecast: () => void;
  onOpenRiskBoard: () => void;
  onAskSpiro: () => void;
}) {
  const moves = marker.history?.length ?? 0;
  const tone = _toneForState(summary?.mc_state);
  const mc = summary?.mc_rate;
  return (
    <div
      role="dialog"
      aria-label={`Marker details: ${marker.label}`}
      className="absolute right-0 top-0 bottom-0 z-10 flex w-80 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl"
      style={{ minWidth: "20rem" }}
    >
      <div className="flex items-start justify-between border-b border-[var(--color-border)] px-4 py-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Marker · {marker.island.toUpperCase()}
          </div>
          <div className="mt-1 truncate font-mono text-base font-semibold tracking-wide text-[var(--color-text)]">
            {marker.label}
          </div>
          <div className="truncate font-mono text-xs text-[var(--color-text-secondary)]">
            {marker.parent}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close marker drawer"
          className="font-mono text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
        <section>
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Symbology
          </div>
          <div className="mt-1 font-mono text-[11px] text-[var(--color-text)] break-all">
            SIDC {marker.sidc}
          </div>
          {marker.echelon && (
            <div className="mt-0.5 font-mono text-[11px] text-[var(--color-text-secondary)]">
              Echelon · {marker.echelon}
            </div>
          )}
          {marker.additionalInfo && (
            <div className="mt-0.5 font-mono text-[11px] text-[var(--color-text-secondary)]">
              {marker.additionalInfo}
            </div>
          )}
        </section>

        <section>
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Position
          </div>
          <div className="mt-1 font-mono text-[11px] text-[var(--color-text)]">
            {marker.coords[1].toFixed(5)}°N, {marker.coords[0].toFixed(5)}°E
          </div>
          {moves > 0 && (
            <div className="mt-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
              moved {moves}× since seed
            </div>
          )}
        </section>

        <section>
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Readiness · PULSE
          </div>
          {!marker.pulseUnit ? (
            <div className="mt-1 font-mono text-[11px] italic text-[var(--color-text-muted)]">
              No PULSE backing (JGSDF / installation marker).
            </div>
          ) : loading ? (
            <div className="mt-1 font-mono text-[11px] text-[var(--color-text-muted)]">
              Loading {marker.pulseUnit}…
            </div>
          ) : !summary ? (
            <div className="mt-1 font-mono text-[11px] italic text-[var(--color-text-muted)]">
              Aliased to {marker.pulseUnit} · readiness unavailable (dataset empty?).
            </div>
          ) : (
            <div className="mt-1">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[11px] text-[var(--color-text-secondary)]">
                  {summary.unit}
                </span>
                <span
                  className="font-mono text-base font-semibold tabular-nums"
                  style={{ color: tone }}
                >
                  {mc != null ? `${(mc * 100).toFixed(1)}% MC` : "—"}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-sm bg-[var(--color-bg)]">
                <div
                  className="h-full"
                  style={{
                    width: `${Math.min(100, Math.max(0, (mc ?? 0) * 100))}%`,
                    background: tone,
                  }}
                />
              </div>
              <dl className="mt-2 grid grid-cols-4 gap-2 font-mono text-[10px] tabular-nums text-[var(--color-text-secondary)]">
                <div>
                  <dt className="text-[var(--color-text-muted)]">Assets</dt>
                  <dd className="text-[var(--color-text)]">{summary.asset_counts.total}</dd>
                </div>
                <div>
                  <dt className="text-[var(--color-text-muted)]">PMC</dt>
                  <dd className="text-[var(--color-text)]">{summary.asset_counts.pmc}</dd>
                </div>
                <div>
                  <dt className="text-[var(--color-text-muted)]">NMCM</dt>
                  <dd className="text-[var(--color-text)]">{summary.asset_counts.nmcm}</dd>
                </div>
                <div>
                  <dt className="text-[var(--color-text-muted)]">NMCS</dt>
                  <dd className="text-[var(--color-text)]">{summary.asset_counts.nmcs}</dd>
                </div>
              </dl>
            </div>
          )}
        </section>

        {/* PULSE×BASTION-A — five-class supply chips. Class IX is direct
         * from MC math; the other four light up only when an alert or
         * incident mentions that supply class (honest "no_signal" when
         * the system has no data, rather than fake green). */}
        {summary && marker.pulseUnit && (
          <section>
            <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              Supply
            </div>
            <div className="mt-1.5 grid grid-cols-1 gap-1">
              <SupplyChip klass="class_i" cell={summary.supply.class_i} />
              <SupplyChip klass="class_iii" cell={summary.supply.class_iii} />
              <SupplyChip klass="class_v" cell={summary.supply.class_v} />
              <SupplyChip klass="class_viii" cell={summary.supply.class_viii} />
              <SupplyChip klass="class_ix" cell={summary.supply.class_ix} />
            </div>
          </section>
        )}

        {/* PULSE×BASTION-A — top unit-scoped alerts. We surface the
         * three highest-severity alerts the bastion module composed
         * for this unit; tapping the title opens SPIRO scoped to the
         * alert (a cheaper "what is this?" path than the alerts feed). */}
        {summary?.alerts && summary.alerts.length > 0 && (
          <section>
            <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              Alerts ({summary.alerts.length})
            </div>
            <ul className="mt-1.5 space-y-1">
              {summary.alerts.map((a) => (
                <li
                  key={a.id ?? `${a.source}-${a.title}`}
                  className="flex items-start gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5"
                >
                  <span
                    aria-hidden
                    className="mt-1 inline-block size-1.5 shrink-0 rounded-full"
                    style={{
                      background:
                        (a.severity || "").toUpperCase() === "HIGH"
                          ? "var(--color-danger)"
                          : (a.severity || "").toUpperCase() === "MODERATE"
                            ? "var(--color-warning)"
                            : "var(--color-text-muted)",
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[11px] text-[var(--color-text)]">
                      {a.title || a.id}
                    </div>
                    {a.body && (
                      <div className="mt-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
                        {a.body}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* PULSE×BASTION-A — TMRs touching this unit. Inbound first
         * (the commander cares more about what's arriving than what
         * they're sending out). Empty list = silent section. */}
        {summary?.tmrs && summary.tmrs.length > 0 && (
          <section>
            <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              Transportation ({summary.tmrs.length})
            </div>
            <ul className="mt-1.5 space-y-1">
              {summary.tmrs.slice(0, 5).map((t) => (
                <li
                  key={t.tmr_number}
                  className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[11px] text-[var(--color-text)]">
                      {t.tmr_number}
                    </span>
                    <span className="font-mono text-[9px] uppercase tracking-widest text-[var(--color-text-muted)]">
                      {t.is_outbound ? "outbound" : "inbound"} · {t.priority}
                    </span>
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
                    {t.origin} → {t.destination}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
                    sched {t.scheduled_date} · {t.status}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2 border-t border-[var(--color-border)] p-3">
        <button
          type="button"
          onClick={onOpenForecast}
          disabled={!marker.pulseUnit}
          className="rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_12%,var(--color-surface))] px-2 py-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-primary)] hover:bg-[color-mix(in_oklab,var(--color-primary)_22%,var(--color-surface))] disabled:cursor-not-allowed disabled:opacity-40"
          title={marker.pulseUnit ? `Open PULSE Forecast for ${marker.pulseUnit}` : "No PULSE unit aliased"}
        >
          Forecast
        </button>
        <button
          type="button"
          onClick={onOpenRiskBoard}
          disabled={!marker.pulseUnit}
          className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-2 py-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text)] hover:border-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-40"
          title={marker.pulseUnit ? `Open Risk Board for ${marker.pulseUnit}` : "No PULSE unit aliased"}
        >
          Risk Board
        </button>
        <button
          type="button"
          onClick={onAskSpiro}
          className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-2 py-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text)] hover:border-[var(--color-primary)]"
          title="Open SPIRO with this marker pre-selected"
        >
          ◆ SPIRO
        </button>
      </div>
    </div>
  );
}

// popupHTML + escapeHtml retired with the marker click → drawer flow.
// React's text rendering escapes for us inside the drawer.
