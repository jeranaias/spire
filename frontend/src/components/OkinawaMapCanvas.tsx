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
import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import ms from "milsymbol";

import { useMarkersStore, type Marker } from "../state/markers";
import {
  ISLAND_PRESETS,
  OKINAWA_VIEW,
} from "../data/okinawa-scenario";
import { useSpireStore } from "../state/store";

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

function renderSymbolHTML(m: Marker): HTMLElement {
  // milsymbol v3 default export carries the `Symbol` constructor.
  const sym = new ms.Symbol(m.sidc, {
    ...SYMBOL_BASE_OPTS,
    additionalInformation: m.additionalInfo ?? "",
    uniqueDesignation: m.label,
    higherFormation: m.parent ?? "",
    ...(m.echelon ? { echelon: m.echelon } : {}),
  });

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

  const inner = document.createElement("div");
  inner.className = "spire-milsymbol-inner";
  inner.style.transformOrigin = "center center";
  inner.style.transition = "transform 120ms ease-out";
  inner.innerHTML = sym.asSVG();
  const svgEl = inner.querySelector("svg");
  if (svgEl) {
    svgEl.style.filter = "drop-shadow(0 0 3px rgba(0,0,0,0.85))";
    svgEl.style.display = "block";
  }
  wrap.appendChild(inner);
  return wrap;
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
    return () => {
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
        continue;
      }
      const el = renderSymbolHTML(m);
      const marker = new maplibregl.Marker({
        element: el,
        draggable: !locked,
        anchor: "center",
      })
        .setLngLat(m.coords)
        .setPopup(
          new maplibregl.Popup({ offset: 20, closeButton: true }).setHTML(
            popupHTML(m),
          ),
        )
        .addTo(map);

      el.style.cursor = locked ? "pointer" : "grab";

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
  }, [markers, ready, moveMarker, currentUser?.initials, locked]);

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
      <div ref={containerRef} className="flex-1 min-h-0 w-full" />
    </div>
  );
}

function popupHTML(m: Marker): string {
  const lng = m.coords[0].toFixed(5);
  const lat = m.coords[1].toFixed(5);
  const moves = m.history?.length ?? 0;
  return `
    <div style="font-family: var(--font-mono, monospace); font-size: 11px; color: #111;">
      <div style="font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;">${escapeHtml(m.label)}</div>
      <div style="opacity: 0.8;">${escapeHtml(m.parent)}</div>
      <div style="margin-top: 6px; opacity: 0.7;">SIDC: ${escapeHtml(m.sidc)}</div>
      <div style="opacity: 0.7;">${lat}°N, ${lng}°E</div>
      ${moves > 0 ? `<div style="margin-top: 4px; opacity: 0.7;">moved ${moves}×</div>` : ""}
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
