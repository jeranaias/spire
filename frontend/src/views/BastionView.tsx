import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { api, type BastionAlert, type BastionCOP, type ThermalHawkSim } from "../api";
import { withRetry, pollWithBackoff } from "../api-retry";
import { useSpireStore } from "../state/store";
import { MapCanvas } from "../components/MapCanvas";
import { FusedThreatsPanel } from "../components/FusedThreatsPanel";

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: "#ef4444",
  HIGH: "#f87171",
  MODERATE: "#f59e0b",
  LOW: "#22c55e",
  INFO: "#3b82f6",
};

// Severity glyph — color-blind-safe pairing alongside the color stripe.
// Filled triangle = action-required, diamond = watch, dot = context.
const SEVERITY_GLYPH: Record<string, string> = {
  CRITICAL: "▲",
  HIGH:     "▲",
  MODERATE: "◆",
  LOW:      "●",
  INFO:     "●",
};

// Format an ISO timestamp as Zulu, matching the Mission Clock face.
// `short` -> `17:00Z` for inline rows; `full` -> `261700Z APR 26` for
// audit-grade strings.
function formatZulu(iso: string, mode: "short" | "full" = "short"): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const z = (n: number, w = 2) => String(n).padStart(w, "0");
    const hh = z(d.getUTCHours());
    const mm = z(d.getUTCMinutes());
    if (mode === "short") return `${hh}:${mm}Z`;
    const dd = z(d.getUTCDate());
    const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
    const yy = String(d.getUTCFullYear()).slice(2);
    return `${dd}${hh}${mm}Z ${month} ${yy}`;
  } catch {
    return iso;
  }
}

type SeverityFilter = "ALL" | "CRITICAL" | "HIGH" | "MODERATE" | "LOW" | "INFO";

// Maps a unit name to the building id its markers live on. Kept in sync
// with InstallationSchematic's UNIT_BUILDING table.
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

export function BastionView() {
  const role = useSpireStore((s) => s.role);
  const setAlertCount = useSpireStore((s) => s.setAlertCount);
  const setAlertSeverityCounts = useSpireStore((s) => s.setAlertSeverityCounts);
  const setSelectedUnitIdGlobal = useSpireStore((s) => s.setSelectedUnitId);
  const [cop, setCop] = useState<BastionCOP | null>(null);
  const [alerts, setAlerts] = useState<BastionAlert[]>([]);
  const [selectedAlert, setSelectedAlert] = useState<BastionAlert | null>(null);
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null);
  const [sim, setSim] = useState<ThermalHawkSim | null>(null);
  const [copError, setCopError] = useState<string | null>(null);
  // Alert stream filter strip. `ALL` shows every severity; otherwise filter.
  // Search is a simple case-insensitive substring across title + body + unit.
  const [sevFilter, setSevFilter] = useState<SeverityFilter>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  // Acknowledged group is collapsed by default — operators want active rows
  // up top and acked rows tucked away at the bottom unless they ask.
  const [showAcked, setShowAcked] = useState(false);
  // Counters bumped by intent — MapCanvas listens for changes and acts.
  // simResolveSignal: restore the cached pre-sim viewport (cordon overlays
  // already drop because `simActive` flips false). resetViewSignal: refit
  // bounds to all units / ECPs (fired by the in-map Reset View button —
  // see MapCanvas — and from any future "go back to wide picture" affordance).
  const [simResolveSignal, setSimResolveSignal] = useState(0);
  // Confirmation modal for "Resolve sim · drop FPCON". Reviewer caught
  // the action being a single click — even in sim, the operator should
  // be reminded that resolving drops FPCON BRAVO and clears cordon state.
  const [confirmResolve, setConfirmResolve] = useState(false);
  // True only while the retry helper is on its 2nd+ attempt. Drives the
  // "Waking up — one moment" copy on Safari cold-start when Fly's machine
  // is spinning up and 5xx'ing the first request.
  const [waking, setWaking] = useState(false);

  const pushToast = useSpireStore((s) => s.pushToast);

  useEffect(() => {
    setCop(null);
    setCopError(null);
    setWaking(false);
    let cancelled = false;
    (async () => {
      try {
        const c = await withRetry(() => api.bastion.cop(), {
          onAttempt: (attempt) => {
            // Surface a friendlier state once we're past the first try.
            if (!cancelled) setWaking(attempt > 1);
          },
        });
        if (cancelled) return;
        setCop(c);
        setWaking(false);
      } catch (e) {
        if (cancelled) return;
        setCopError(String(e));
        setWaking(false);
        pushToast({
          tone: "error",
          text: "Installation offline — could not reach BASTION schematic. Retrying on next role change.",
          ttlMs: 6000,
        });
      }
    })();
    refreshAlerts();
    return () => {
      cancelled = true;
    };
  }, [role]);

  // Walkthrough audit: '/' focuses the alert search box (vim/Slack/Linear
  // convention). Only fires when focus isn't already in a field, so a
  // Marine typing '/' inside SPIRO or the search itself doesn't get yanked.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/") return;
      const t = e.target as HTMLElement | null;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t && t.isContentEditable)
      ) return;
      const search = document.getElementById("bastion-alert-search") as HTMLInputElement | null;
      if (search) {
        e.preventDefault();
        search.focus();
        search.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Apply backend response to local + global state in one place. Both the
  // initial fetch and the poll converge on this so the TopBar badge,
  // severity tooltip, and any future cross-view consumer always see the
  // same backend-truth numbers. Reviewer caught the count silently
  // dropping on role round-trips because counts were derived from
  // component-local state that reset on remount; ground-truth lives at
  // /api/bastion/alerts and we mirror it into the store on every poll.
  const applyAlertsResponse = useCallback(
    (r: { alerts: BastionAlert[]; total?: number; severity_counts?: Record<string, number> }) => {
      setAlerts(r.alerts);
      const total = typeof r.total === "number" ? r.total : r.alerts.length;
      setAlertCount(total);
      setAlertSeverityCounts(r.severity_counts ?? {});
    },
    [setAlertCount, setAlertSeverityCounts],
  );

  async function refreshAlerts() {
    try {
      const r = await withRetry(() => api.bastion.alerts(40));
      applyAlertsResponse(r);
    } catch (e) {
      // Toast once per session-ish: a steady poll that's failing should not
      // pop a toast every 5 seconds. We log to console so it's visible in
      // dev tools without spamming the operator.
      console.warn("BASTION alert refresh failed:", e);
    }
  }

  useEffect(() => {
    // Base 5s, backs off to 60s when the alert list is unchanged. The toast
    // wall doesn't move during quiet stretches; reviewer caught the fixed
    // setInterval as one of three components polling on the same cadence.
    const ctrl = pollWithBackoff(
      () => withRetry(() => api.bastion.alerts(40)),
      {
        baseMs: 5000,
        maxMs: 60000,
        fingerprint: (r) =>
          `${r.alerts.length}|${r.alerts.map((a) => a.id).join(",")}`,
        onResult: (r) => applyAlertsResponse(r),
        onError: (e) => console.warn("BASTION alert refresh failed:", e),
      },
    );
    return () => ctrl.stop();
  }, [applyAlertsResponse]);

  // Per-alert action — ack / snooze / resolve. Optimistic update so the
  // operator sees the row move (or vanish) immediately; if the backend
  // rejects, the next poll restores ground truth.
  async function alertAction(id: string, action: "ack" | "snooze" | "resolve" | "unack") {
    setAlerts((prev) =>
      prev
        .map((a) => {
          if (a.id !== id) return a;
          if (action === "resolve") return null;
          if (action === "unack") return { ...a, _state: undefined };
          if (action === "ack") {
            return {
              ...a,
              _state: { status: "acknowledged" as const, at: new Date().toISOString() },
            };
          }
          if (action === "snooze") {
            const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            return {
              ...a,
              _state: {
                status: "snoozed" as const,
                at: new Date().toISOString(),
                snooze_until: until,
              },
            };
          }
          return a;
        })
        .filter((a): a is BastionAlert => a !== null),
    );
    if (selectedAlert?.id === id && action === "resolve") setSelectedAlert(null);
    try {
      await api.bastion.alertAction(id, action);
      refreshAlerts();
    } catch (e) {
      pushToast({ tone: "error", text: `Alert action failed — ${String(e).slice(0, 80)}` });
      refreshAlerts();
    }
  }

  const setFpcon = useSpireStore((s) => s.setFpcon);
  const [recentAlertIds, setRecentAlertIds] = useState<Set<string>>(new Set());

  // Detect new alerts arriving in the poll so we can scan-line the row.
  const prevAlertIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const prev = prevAlertIdsRef.current;
    const fresh = new Set<string>();
    for (const a of alerts) {
      if (!prev.has(a.id)) fresh.add(a.id);
    }
    if (fresh.size > 0) {
      setRecentAlertIds(fresh);
      window.setTimeout(() => setRecentAlertIds(new Set()), 700);
    }
    prevAlertIdsRef.current = new Set(alerts.map((a) => a.id));
  }, [alerts]);

  // ThermalHawk sim trigger. Used to live as an in-column button (#37
  // moved it). Now the map agent owns the SIMULATE button in the COP
  // header; we expose the trigger via a custom window event so the map
  // agent can dispatch `new CustomEvent('spire:simulate-thermalhawk')`
  // without re-implementing the FPCON / sim / toast flow. This keeps
  // the side-effects (FPCON CHARLIE, sim state, alert refresh) co-located
  // with the alert column that owns the response panel.
  const triggerThermalHawk = useCallback(async () => {
    const s = await api.bastion.simulateThermalHawk("CLB-6");
    setSim(s);
    setSelectedAlert(s.alert);
    setSelectedUnit("CLB-6");
    setSelectedUnitIdGlobal("CLB-6");
    // Escalate FPCON BRAVO → CHARLIE for the duration of the incident.
    // De-escalation is tied to `sim` becoming null (Resolve sim or auto-clear)
    // rather than a fixed 30s timeout — reviewer caught the simulation footer
    // toast still active while FPCON had already reverted.
    setFpcon("CHARLIE");
    pushToast({
      tone: "warn",
      text: "FPCON elevated to CHARLIE · ThermalHawk UAS incident active",
      ttlMs: 4500,
    });
    refreshAlerts();
  }, [pushToast, setFpcon, setSelectedUnitIdGlobal]);

  useEffect(() => {
    const handler = () => {
      void triggerThermalHawk();
    };
    window.addEventListener("spire:simulate-thermalhawk", handler);
    return () => window.removeEventListener("spire:simulate-thermalhawk", handler);
  }, [triggerThermalHawk]);

  // Drop FPCON back to BRAVO whenever the simulation clears. Reviewer flagged
  // that the prior 30s setTimeout could revert FPCON while the sim was still
  // visibly active (rendered cordon rings, target reticle, response panel).
  // Tying de-escalation to `sim` state keeps the indicators honest.
  useEffect(() => {
    if (!sim) {
      // Only step DOWN — don't clobber a manually-set higher FPCON.
      const cur = useSpireStore.getState().fpcon;
      if (cur === "CHARLIE" || cur === "DELTA") setFpcon("BRAVO");
    }
  }, [sim, setFpcon]);

  // Resolve-sim handler — bumps the resolve signal so the MapCanvas restores
  // the cached pre-sim viewport, drops FPCON via the existing useEffect on
  // `sim`, clears the response drawer (which was opened from the sim alert),
  // and emits an honest toast that mirrors the actual side-effects.
  // Walkthrough caught the response drawer staying open after resolve because
  // `selectedAlert` was set to the sim's alert but never cleared.
  const resolveSim = useCallback(() => {
    setSim(null);
    setSelectedAlert(null);
    setSelectedUnit(null);
    setSelectedUnitIdGlobal(null);
    setSimResolveSignal((n) => n + 1);
    pushToast({
      tone: "ok",
      text: "Sim resolved · FPCON returning to BRAVO · cordons cleared · drawer closed",
      ttlMs: 3500,
    });
  }, [pushToast, setSelectedUnitIdGlobal]);

  function onUnitClick(unitName: string) {
    setSelectedUnit(unitName);
    setSelectedUnitIdGlobal(unitName);
    // Promote the most relevant alert for that unit, if any
    const unitAlerts = alerts.filter((a) => a.unit === unitName);
    if (unitAlerts.length > 0) setSelectedAlert(unitAlerts[0]);
  }

  // Drill-from-alert. Clicking an alert with a unit reference promotes the
  // unit selection (which drives the MapCanvas flyTo via UNIT_BUILDING and
  // lights the unit pin) and stamps the store so any other consumer can
  // react to the operator's drill intent. If the alert has no unit but
  // does have a grid (e.g. ThermalHawk targets a building), we lean on the
  // existing `flyToBuilding` derivation below.
  function onAlertClick(a: BastionAlert) {
    setSelectedAlert(a);
    if (a.unit) {
      setSelectedUnit(a.unit);
      setSelectedUnitIdGlobal(a.unit);
    }
  }

  const simTargetBuilding = useMemo(() => {
    if (!sim) return undefined;
    return UNIT_BUILDING[sim.alert.unit || "CLB-6"] || "CLB6-MP";
  }, [sim]);

  // When an alert is selected, derive a "fly to" target building:
  // - Alerts with a `unit` map to that unit's home building
  // - Alerts with a `grid` fall back to the nearest named building (future)
  const flyToBuilding = useMemo(() => {
    if (!selectedAlert) return null;
    if (selectedAlert.unit && UNIT_BUILDING[selectedAlert.unit]) {
      return UNIT_BUILDING[selectedAlert.unit];
    }
    return null;
  }, [selectedAlert]);

  // Active vs acknowledged partition + filter strip + free-text search.
  // Acked alerts move below to a collapsed group; resolved already drop
  // server-side. Severity filter and search compose (both must match).
  const { activeAlerts, ackedAlerts } = useMemo(() => {
    const matchesSearch = (a: BastionAlert) => {
      if (!searchQuery.trim()) return true;
      const q = searchQuery.trim().toLowerCase();
      return (
        a.title.toLowerCase().includes(q) ||
        a.body.toLowerCase().includes(q) ||
        (a.unit ?? "").toLowerCase().includes(q)
      );
    };
    const matchesSeverity = (a: BastionAlert) => {
      if (sevFilter === "ALL") return true;
      return a.severity === sevFilter;
    };
    const active: BastionAlert[] = [];
    const acked: BastionAlert[] = [];
    for (const a of alerts) {
      if (!matchesSearch(a) || !matchesSeverity(a)) continue;
      if (a._state?.status === "acknowledged") acked.push(a);
      else active.push(a);
    }
    return { activeAlerts: active, ackedAlerts: acked };
  }, [alerts, searchQuery, sevFilter]);

  if (copError && !cop) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <div className="max-w-md rounded-md border border-[var(--color-danger-muted)] bg-[var(--color-surface)] p-6 text-center">
          <div
            className="font-mono text-xs uppercase text-[var(--color-danger)] tracking-widest"
          >
            Installation Offline
          </div>
          <div className="mt-2 spire-body text-sm">
            BASTION schematic unreachable after 4 attempts. Backend may be cycling — wait a moment, then switch role to retry.
          </div>
          <div className="mt-3 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            {copError}
          </div>
          <button
            onClick={() => {
              // Force a re-fetch by toggling the role useEffect. Simplest path:
              // request the same role; the effect dependency triggers because
              // we set state inside.
              setCop(null);
              setCopError(null);
              setWaking(true);
              withRetry(() => api.bastion.cop(), {
                onAttempt: (attempt) => setWaking(attempt > 1),
              })
                .then((c) => {
                  setCop(c);
                  setWaking(false);
                })
                .catch((e) => {
                  setCopError(String(e));
                  setWaking(false);
                });
            }}
            className="mt-4 inline-flex h-11 min-w-[44px] items-center rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-4 font-mono text-sm font-semibold uppercase text-white hover:bg-[var(--color-primary-hover)] tracking-widest"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!cop) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-secondary)]">
        <div className="flex items-center gap-3 font-mono text-sm tracking-wider">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
          {waking ? "Waking up — one moment" : "Loading installation schematic ..."}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left sidebar: alert stream */}
      <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-bg)]">
        <AlertStreamHeader
          activeCount={activeAlerts.length}
          ackedCount={ackedAlerts.length}
          sevFilter={sevFilter}
          onSevFilter={setSevFilter}
          searchQuery={searchQuery}
          onSearchQuery={setSearchQuery}
        />
        <div className="flex-1 overflow-y-auto p-2">
          {/* Track-G2 — Fused threats live at the top of the alert sidebar.
           * Reviewer caught a duplicate header (CollapsiblePanel chevron
           * + the panel's own "FUSED THREATS · N active" card). Retired
           * the outer chevron group; the panel renders its own labelled
           * card with the live count + supports per-row expand inline. */}
          <FusedThreatsPanel />
          {dedupeAlerts(activeAlerts).map((a) => (
            <AlertRow
              key={a.id}
              alert={a}
              groupCount={a._groupCount}
              justArrived={recentAlertIds.has(a.id)}
              selected={selectedAlert?.id === a.id}
              onClick={() => onAlertClick(a)}
              onAck={() => alertAction(a.id, "ack")}
              onSnooze={() => alertAction(a.id, "snooze")}
              onResolve={() => alertAction(a.id, "resolve")}
            />
          ))}
          {activeAlerts.length === 0 && alerts.length > 0 && (
            <div className="px-2 py-6 text-center font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
              No alerts match the current filter
            </div>
          )}
          {alerts.length === 0 && (
            <div className="px-2 py-6 text-center font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
              No alerts in scope
            </div>
          )}
          {ackedAlerts.length > 0 && (
            <div className="mt-3 border-t border-[var(--color-border)] pt-2">
              <button
                type="button"
                onClick={() => setShowAcked((v) => !v)}
                className="flex w-full items-center justify-between rounded-sm px-2 py-1 font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                <span>Acknowledged ({ackedAlerts.length})</span>
                <span aria-hidden>{showAcked ? "▾" : "▸"}</span>
              </button>
              {showAcked &&
                dedupeAlerts(ackedAlerts).map((a) => (
                  <AlertRow
                    key={a.id}
                    alert={a}
                    groupCount={a._groupCount}
                    justArrived={false}
                    selected={selectedAlert?.id === a.id}
                    onClick={() => onAlertClick(a)}
                    onUnack={() => alertAction(a.id, "unack")}
                    onResolve={() => alertAction(a.id, "resolve")}
                  />
                ))}
            </div>
          )}
        </div>
        {/* Sim Controls — coordinate with map agent (#37).
         *
         * Reviewer flagged the SIMULATE THERMALHAWK button as out-of-place
         * inside the alert column wearing HIGH-alert chrome (looked like a
         * row, behaved like a global control). Map agent owns sim controls
         * in the COP header now; the button is retired here.
         *
         * If the COP-header button isn't wired yet, dev console fallback:
         *   await fetch('/api/bastion/simulate/thermalhawk-detection',
         *     {method:'POST', body:'{}', headers:{'Content-Type':'application/json'}})
         */}
      </aside>

      {/* Center: schematic */}
      <div className="relative flex-1">
        <MapCanvas
          buildings={cop.buildings}
          units={cop.units}
          ecps={cop.ecps}
          rallyPoints={cop.rally_points}
          centerLat={cop.center.lat}
          centerLon={cop.center.lon}
          selectedUnit={selectedUnit}
          onUnitClick={onUnitClick}
          flyToBuilding={flyToBuilding}
          simActive={!!sim}
          simTargetBuilding={simTargetBuilding}
          simCordons={sim?.cordon_zones}
          drawerOpen={!!selectedAlert}
          simResolveSignal={simResolveSignal}
        />

        {/* Installation title badge — top-left. Metrics row uses chip-flow
         * so when the response drawer narrows the map column the chips wrap
         * to 2x2 instead of mid-token-truncating "10 RF" → "10 R" (#27). */}
        <div
          className="pointer-events-none absolute left-3 top-3 z-[6] max-w-[min(60vw,320px)] rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] px-3 py-2 backdrop-blur"
        >
          <div
            className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
          >
            Common Operating Picture
          </div>
          <div
            className="mt-0.5 font-mono text-sm font-semibold uppercase text-[var(--color-text)] tracking-wider"
          >
            {cop.installation.name}
          </div>
          <div
            className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-xs text-[var(--color-text-secondary)] tracking-wider"
          >
            <span className="whitespace-nowrap">
              {cop.buildings_count} buildings
            </span>
            <span className="whitespace-nowrap">
              {cop.ecps.length} ECPs
            </span>
            <span
              className="whitespace-nowrap"
              title={`${cop.rally_points.length} rally points, ${cop.response_forces_count} response-force teams assigned`}
            >
              {cop.rally_points.length} RP · {cop.response_forces_count} RF
            </span>
            {/* Walkthrough audit: dropped the FPCON pill + // SYNTHETIC DATA
             * stamp from the COP card. FPCON lives in the StatusStrip and
             * classification banner already (3 mentions on one screen
             * read as visual noise); SYNTHETIC repeats the top banner. */}
          </div>
        </div>

        {/* Mission HUD — top-right */}
        <MissionHUD />

        {/* Walkthrough #JOB-A — Sim Controls pill row in the COP header area.
         * Browser dry-run caught the SIMULATE THERMALHAWK button as
         * not-deployed-in-bundle (map agent retired ASK·BASTION but left the
         * trigger in a TODO). Alerts agent already wired the
         * `spire:simulate-thermalhawk` window event listener to fire the full
         * FPCON CHARLIE / sim state / alert refresh chain (see useEffect
         * around line 264). This pill row dispatches that event.
         *
         * Visible to MEF Commander, Security Manager, G-4 only. Anchored
         * below the installation badge (top-left, second row) so it never
         * collides with the centered G-4 command summary card. Neutral
         * dashed border + ▶ glyph + "Simulate" prefix so it reads as a
         * sandbox control and never gets confused with a HIGH alert. */}
        {(role === "mef_commander" || role === "security_manager" || role === "g4") && (
          <div
            className="pointer-events-auto absolute left-3 top-[88px] z-[7] flex items-center gap-1.5"
            role="region"
            aria-label="Sim controls"
          >
            <span
              className="rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] px-2 py-1 font-mono text-[10px] font-semibold uppercase text-[var(--color-text-muted)] backdrop-blur tracking-widest"
            >
              Sim Controls
            </span>
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(new CustomEvent("spire:simulate-thermalhawk"));
              }}
              disabled={!!sim}
              title={
                sim
                  ? "Simulation already active — resolve via the response panel"
                  : "Dispatch a synthetic ThermalHawk UAS detection · escalates FPCON to CHARLIE for the duration"
              }
              className="inline-flex h-9 items-center gap-2 rounded-sm border border-dashed border-[var(--color-border-active)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] px-3 font-mono text-xs font-semibold uppercase text-[var(--color-text)] backdrop-blur transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50 tracking-widest"
            >
              <span aria-hidden className="text-[var(--color-primary)]">▶</span>
              <span className="text-[var(--color-text-muted)]">Simulate</span>
              <span>ThermalHawk</span>
            </button>
          </div>
        )}

        {/* Track-G1 — G-4 command summary card. Three columns of "what
         * matters in the next 30 seconds": MC% per scoped unit, top alerts,
         * top fused threats. Renders only for the G-4 role and only when no
         * alert is selected (so it doesn't fight with the response panel). */}
        {role === "g4" && !selectedAlert && (
          <G4CommandSummary alerts={alerts} onAlertClick={(a) => setSelectedAlert(a)} />
        )}

        {/* ASK·BASTION retired — SPIRO (Ctrl+/) is the sole chat surface
         * across all SPIRE views. Reviewer caught the floating NL bar
         * leaking pointer events to the map underneath (#41) and competing
         * with the right-rail toast lane in the same corner. SPIRO renders
         * from app shell and handles all natural-language operator input. */}
      </div>

      {/* Right sidebar: response panel */}
      {selectedAlert && (
        <ResponsePanel
          alert={selectedAlert}
          sim={sim}
          onClose={() => {
            setSelectedAlert(null);
          }}
          // Open the confirmation modal first; the actual resolve runs only
          // if the operator confirms. Reviewer flagged that one-click resolve
          // breaks the "even in sim, model the right reflex" principle (#69).
          onResolveSim={() => setConfirmResolve(true)}
        />
      )}

      {confirmResolve && (
        <ResolveSimConfirm
          onCancel={() => setConfirmResolve(false)}
          onConfirm={() => {
            setConfirmResolve(false);
            resolveSim();
          }}
        />
      )}
    </div>
  );
}

// Modal-style confirmation overlay for "Resolve sim · drop FPCON". A
// deliberate two-click ceremony so the operator's reflex matches a real
// FPCON change. Spans the whole BastionView container.
function ResolveSimConfirm({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Keyboard-first UX: Escape cancels, Enter confirms. Operators rarely
  // mouse to the confirm path during a live sim — give them the safe key
  // (Cancel auto-focused) and the fast key (Enter to confirm) by default.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  return (
    <div
      className="absolute inset-0 z-[20] flex items-center justify-center bg-[color-mix(in_oklab,#000_55%,transparent)] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm resolve sim"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-w-md rounded-md border border-[var(--color-success)] bg-[var(--color-surface)] p-5 shadow-2xl"
      >
        <div className="font-mono text-xs uppercase text-[var(--color-success)] tracking-widest">
          Resolve simulation?
        </div>
        <div className="mt-2 text-sm text-[var(--color-text)]">
          Drop FPCON to BRAVO and clear all sim state — cordons, response
          forces, and target reticle.
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="inline-flex h-10 min-w-[88px] items-center justify-center rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-4 font-mono text-xs font-semibold uppercase text-[var(--color-text)] tracking-widest hover:bg-[var(--color-surface-hover)]"
            autoFocus
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="inline-flex h-10 min-w-[120px] items-center justify-center rounded-sm border border-[var(--color-success)] bg-[var(--color-success)] px-4 font-mono text-xs font-semibold uppercase text-white tracking-widest hover:opacity-90"
          >
            Resolve
          </button>
        </div>
      </div>
    </div>
  );
}

// Collapse adjacent identical (source, title) alerts into a single row with
// a count badge so 11 copies of "UAS DETECTED" read as "UAS DETECTED ×11"
// instead of a wall of red.
type GroupedAlert = BastionAlert & { _groupCount?: number };
function dedupeAlerts(alerts: BastionAlert[]): GroupedAlert[] {
  const seen = new Map<string, GroupedAlert>();
  for (const a of alerts) {
    const key = `${a.source}::${a.title}`;
    const existing = seen.get(key);
    if (existing) {
      existing._groupCount = (existing._groupCount ?? 1) + 1;
      // Keep the newest timestamp visible
      if (new Date(a.timestamp) > new Date(existing.timestamp)) {
        existing.timestamp = a.timestamp;
      }
    } else {
      seen.set(key, { ...a });
    }
  }
  return Array.from(seen.values()).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

function AlertRow({
  alert,
  selected,
  onClick,
  groupCount,
  justArrived,
  onAck,
  onSnooze,
  onResolve,
  onUnack,
}: {
  alert: BastionAlert;
  selected: boolean;
  onClick: () => void;
  groupCount?: number;
  justArrived?: boolean;
  onAck?: () => void;
  onSnooze?: () => void;
  onResolve?: () => void;
  onUnack?: () => void;
}) {
  const color = SEVERITY_COLOR[alert.severity] || SEVERITY_COLOR.INFO;
  const glyph = SEVERITY_GLYPH[alert.severity] || SEVERITY_GLYPH.INFO;
  const acked = alert._state?.status === "acknowledged";
  const snoozed = alert._state?.status === "snoozed";
  return (
    <div
      onClick={onClick}
      className={clsx(
        "relative mb-1.5 cursor-pointer overflow-hidden rounded-sm border-l-4 bg-[var(--color-surface)] px-2 py-1.5 transition-colors",
        selected ? "border border-[var(--color-primary)]" : "border-r border-t border-b border-[var(--color-border)]",
        acked && "opacity-60",
      )}
      style={{ borderLeftColor: color }}
    >
      {justArrived && (
        <div
          className="scan-line pointer-events-none absolute inset-y-0 left-0 w-full"
          style={{
            background: `linear-gradient(90deg, transparent 0%, ${color} 50%, transparent 100%)`,
            opacity: 0.35,
          }}
        />
      )}
      <div className="flex items-center gap-1 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
        <span aria-hidden style={{ color, fontSize: "10px", lineHeight: 1 }}>
          {glyph}
        </span>
        <span className="font-semibold" style={{ color }}>{alert.severity}</span>
        <span>· {alert.source}</span>
        {groupCount && groupCount > 1 && (
          <span
            className="rounded-sm border px-1 font-semibold tabular-nums tracking-wide"
            style={{
              color,
              borderColor: `color-mix(in oklab, ${color} 40%, var(--color-border))`,
              background: `color-mix(in oklab, ${color} 12%, transparent)`,
            }}
            title={`This alert fired ${groupCount} times — same source/title collapsed into one row`}
          >
            ×{groupCount}
          </span>
        )}
        {snoozed && (
          <span
            className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-1 text-[10px] uppercase text-[var(--color-text-muted)]"
            title={alert._state?.snooze_until ? `Snoozed until ${formatZulu(alert._state.snooze_until)}` : "Snoozed"}
          >
            ZZZ
          </span>
        )}
        {acked && (
          <span
            className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-1 text-[10px] uppercase text-[var(--color-text-muted)]"
            title="Acknowledged"
          >
            ACK
          </span>
        )}
        <span
          className="ml-auto tabular-nums"
          title={formatZulu(alert.timestamp, "full")}
        >
          {formatZulu(alert.timestamp)}
        </span>
      </div>
      <div className="mt-0.5 text-base font-medium text-[var(--color-text)]">{alert.title}</div>
      <div className="line-clamp-2 text-xs text-[var(--color-text-secondary)]">{alert.body}</div>
      {(onAck || onSnooze || onResolve || onUnack) && (
        <div
          className="mt-1.5 flex gap-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          {onAck && !acked && (
            <button
              type="button"
              onClick={onAck}
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-text)]"
              title="Acknowledge — moves to the Acknowledged group"
            >
              Ack
            </button>
          )}
          {onSnooze && !snoozed && !acked && (
            <button
              type="button"
              onClick={onSnooze}
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-warning)] hover:text-[var(--color-warning)]"
              title="Snooze 1h — row resurfaces if still open"
            >
              Snooze 1h
            </button>
          )}
          {onUnack && (
            <button
              type="button"
              onClick={onUnack}
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-text)]"
              title="Move back to active alerts"
            >
              Un-ack
            </button>
          )}
          {onResolve && (
            <button
              type="button"
              onClick={onResolve}
              className="rounded-sm border border-[var(--color-success)] bg-[color-mix(in_oklab,var(--color-success-muted)_25%,transparent)] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-[var(--color-success)] hover:bg-[var(--color-success)] hover:text-white"
              title="Resolve — drops from the open count"
            >
              Resolve
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Filter strip + search above the alert stream. Severity filter is a four-
// chip segmented control; search matches title + body + unit. Reviewer
// asked for both as a way to triage 30+ rows without scrolling.
// Walkthrough audit: filter strip was missing CRITICAL + LOW even though
// alerts of those severities exist (e.g. WEATHER LOW, fused-threat CRITICAL
// during a sim). Operators couldn't isolate them. Full ladder now exposed.
const SEV_FILTER_OPTIONS: SeverityFilter[] = ["ALL", "CRITICAL", "HIGH", "MODERATE", "LOW", "INFO"];

function AlertStreamHeader({
  activeCount,
  ackedCount,
  sevFilter,
  onSevFilter,
  searchQuery,
  onSearchQuery,
}: {
  activeCount: number;
  ackedCount: number;
  sevFilter: SeverityFilter;
  onSevFilter: (s: SeverityFilter) => void;
  searchQuery: string;
  onSearchQuery: (s: string) => void;
}) {
  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between p-3 pb-2">
        <h3 className="font-mono text-xs font-semibold uppercase text-[var(--color-text)] tracking-widest">
          Alert Stream
        </h3>
        <span
          className="rounded-sm border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-xs tabular-nums text-[var(--color-text-muted)] tracking-wide"
          title={
            ackedCount > 0
              ? `${activeCount} active · ${ackedCount} acknowledged`
              : `${activeCount} active`
          }
        >
          {activeCount}
        </span>
      </div>
      <div className="flex items-center gap-1 px-2 pb-1.5">
        {SEV_FILTER_OPTIONS.map((opt) => {
          const active = sevFilter === opt;
          const tone =
            opt === "HIGH"     ? "var(--color-danger)" :
            opt === "MODERATE" ? "var(--color-warning)" :
            opt === "INFO"     ? "var(--color-primary)" :
                                 "var(--color-text)";
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onSevFilter(opt)}
              className={clsx(
                "rounded-sm border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-widest transition-colors",
                active
                  ? "bg-[var(--color-bg)] text-[var(--color-text)]"
                  : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
              )}
              style={{
                borderColor: active ? tone : "transparent",
                color: active ? tone : undefined,
              }}
              aria-pressed={active}
            >
              {opt}
            </button>
          );
        })}
      </div>
      <div className="px-2 pb-2">
        <input
          id="bastion-alert-search"
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            // Walkthrough audit: Esc inside the search clears + blurs.
            // Previously Escape did nothing, leaving the operator to
            // mouse to the input and select-all-delete.
            if (e.key === "Escape") {
              if (searchQuery) {
                e.preventDefault();
                onSearchQuery("");
              } else {
                (e.target as HTMLInputElement).blur();
              }
            }
          }}
          placeholder="Search title, body, unit… ( / )"
          aria-label="Filter alerts (press / to focus, Esc to clear)"
          className="w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
        />
      </div>
    </div>
  );
}

function MissionHUD() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const z = (n: number, w = 2) => String(n).padStart(w, "0");
  const zulu = `${z(now.getUTCHours())}${z(now.getUTCMinutes())}${z(now.getUTCSeconds())}Z`;
  const datestamp = `${z(now.getUTCDate())} ${now
    .toLocaleString("en-US", { month: "short", timeZone: "UTC" })
    .toUpperCase()} ${now.getUTCFullYear().toString().slice(2)}`;

  return (
    <div
      className="pointer-events-none absolute right-3 top-3 z-[6] rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] px-3 py-2 backdrop-blur"
    >
      <div
        className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
      >
        Mission Clock
      </div>
      <div
        className="mt-0.5 font-mono text-xl font-semibold tabular-nums text-[var(--color-text)] tracking-wide"
        style={{ lineHeight: 1 }}
      >
        {zulu}
      </div>
      <div
        className="mt-0.5 font-mono text-xs text-[var(--color-text-secondary)] tracking-wider"
      >
        {datestamp}
      </div>
    </div>
  );
}

// Role-specific filter over the canonical checklist. Keeps the scope of the
// response panel honest — a Maintenance Chief shouldn't see tasks for FPCON
// escalation or regional notification; a MEF Commander sees decision-level
// summaries; a Security Manager gets the full tasklist.
function filterChecklistForRole(
  items: string[],
  role: string,
): string[] {
  if (role === "maintenance_chief") {
    return items.filter((it) => /equipment|facility|unit|update|motor|MEL|parts|shop/i.test(it));
  }
  if (role === "g4") {
    return items.filter((it) => /notify|dispatch|coordinate|MLG|convoy|TMR|expedite|response/i.test(it));
  }
  if (role === "mef_commander") {
    // Commander view: keep only 3-5 decision-critical lines
    return items.slice(0, Math.max(3, Math.ceil(items.length / 3)));
  }
  // Security Manager + Data Custodian default: full checklist
  return items;
}

function ResponsePanel({
  alert,
  sim,
  onClose,
  onResolveSim,
}: {
  alert: BastionAlert;
  sim: ThermalHawkSim | null;
  onClose: () => void;
  onResolveSim?: () => void;
}) {
  const role = useSpireStore((s) => s.role);
  const pushToast = useSpireStore((s) => s.pushToast);
  const checklist = sim && sim.alert.id === alert.id ? sim.checklist : null;
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  // Per-recipient "Sent" state so the Send button stays disabled and reads
  // "✓ Sent" after a successful dispatch. Reviewer caught these clicks doing
  // nothing visible; the operator must always see acknowledgement.
  const [sent, setSent] = useState<Record<string, boolean>>({});

  function sendNotification(who: string) {
    if (sent[who]) return;
    setSent((s) => ({ ...s, [who]: true }));
    // Stub a client-side audit-log entry. A real backend endpoint would be
    // POST /api/bastion/notify { who, alert_id }; for now we record locally
    // so the air-gap demo claim still holds (no external egress).
    let auditDepth = 0;
    try {
      const key = "spire.bastion.notify_audit";
      const prior = JSON.parse(window.localStorage.getItem(key) || "[]");
      const entry = {
        who,
        alert_id: alert.id,
        alert_title: alert.title,
        at: new Date().toISOString(),
        actor: role,
      };
      prior.push(entry);
      const trimmed = prior.slice(-200);
      window.localStorage.setItem(key, JSON.stringify(trimmed));
      auditDepth = trimmed.length;
    } catch {
      /* tolerant — private mode etc */
    }
    // Toast text echoes the recipient + the running audit count so the
    // operator sees a state change every click (reviewer caught the prior
    // toast looking identical between sends and feeling like nothing fired).
    pushToast({
      tone: "ok",
      text: `✓ Sent ${who}${auditDepth ? ` · audit #${auditDepth}` : ""}`,
      ttlMs: 3500,
    });
  }

  const scopedImmediate = useMemo(
    () => (checklist ? filterChecklistForRole(checklist.immediate, role) : []),
    [checklist, role],
  );
  const scopedFollowOn = useMemo(
    () => (checklist ? filterChecklistForRole(checklist.followon, role) : []),
    [checklist, role],
  );

  function toggle(key: string) {
    setChecked((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <aside className="flex w-[400px] shrink-0 flex-col overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex items-start justify-between">
          <div>
            <div
              className="font-mono text-xs font-semibold uppercase tracking-widest"
              style={{ color: SEVERITY_COLOR[alert.severity] }}
            >
              {alert.severity} · {alert.source}
            </div>
            <div className="mt-0.5 text-sm font-semibold">{alert.title}</div>
          </div>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-4 text-xs">
        <section>
          <div className="text-[var(--color-text-secondary)]">{alert.body}</div>
          {alert.grid && (
            <div className="mt-2 font-mono text-sm text-[var(--color-text-muted)]">Grid: {alert.grid}</div>
          )}
        </section>

        {alert.model_info && (
          <section className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
            <div
              className="mb-1 font-mono text-xs font-semibold uppercase text-[var(--color-text-muted)] tracking-widest"
            >
              Detection Model
            </div>
            <div className="font-mono text-[var(--color-text)]">{alert.model_info.model}</div>
            <div className="text-[var(--color-text-secondary)]">
              {alert.model_info.parameters.toLocaleString()} parameters · {alert.model_info.architecture}
            </div>
            <div className="mt-1 break-words text-xs text-[var(--color-text-muted)]">
              {alert.model_info.training} · target: {alert.model_info.deployment_target}
            </div>
          </section>
        )}

        {alert.correlated_with && alert.correlated_with.length > 0 && (
          <section>
            <div
              className="mb-1 font-mono text-xs font-semibold uppercase text-[var(--color-text-muted)] tracking-widest"
            >
              Auto-correlated with
            </div>
            {alert.correlated_with.map((c, i) => (
              <div key={i} className="rounded-sm border-l-2 border-[var(--color-primary)] bg-[var(--color-bg)] px-2 py-1 text-sm">
                <span className="font-mono text-[var(--color-primary)]">{c.source}</span> — {c.note}
              </div>
            ))}
          </section>
        )}

        {checklist && (
          <section>
            <div className="mb-2 text-xs font-semibold">{checklist.title}</div>
            <div
              className="mb-2 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
            >
              Immediate (0-5 MIN)
            </div>
            <ul className="flex flex-col gap-1.5 text-sm">
              {scopedImmediate.map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={!!checked[`imm-${i}`]}
                    onChange={() => toggle(`imm-${i}`)}
                    className="mt-0.5 accent-[var(--color-primary)]"
                  />
                  <span className={checked[`imm-${i}`] ? "text-[var(--color-text-muted)] line-through" : ""}>{item}</span>
                </li>
              ))}
            </ul>
            <div
              className="mb-2 mt-3 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
            >
              Follow-on (5-30 MIN)
            </div>
            <ul className="flex flex-col gap-1.5 text-sm">
              {scopedFollowOn.map((item, i) => (
                <li key={i} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={!!checked[`fol-${i}`]}
                    onChange={() => toggle(`fol-${i}`)}
                    className="mt-0.5 accent-[var(--color-primary)]"
                  />
                  <span className={checked[`fol-${i}`] ? "text-[var(--color-text-muted)] line-through" : ""}>{item}</span>
                </li>
              ))}
            </ul>
            <div
              className="mb-2 mt-3 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
            >
              Notifications
            </div>
            <ul className="flex flex-col gap-1.5 text-sm">
              {checklist.notifications.map((n, i) => {
                const isSent = !!sent[n.who];
                return (
                  <li key={i} className="flex items-center gap-2">
                    <span className="font-mono text-[var(--color-text)]">{n.who}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        // stopPropagation guards against any future ancestor
                        // click handler swallowing the event before it lands.
                        e.stopPropagation();
                        sendNotification(n.who);
                      }}
                      disabled={isSent}
                      title={isSent ? `Already sent to ${n.who}` : `Send draft notification to ${n.who} · audit logged`}
                      className="ml-auto rounded border px-2 py-1 font-mono text-xs font-semibold uppercase tracking-wider transition-colors disabled:cursor-not-allowed"
                      style={{
                        borderColor: isSent ? "var(--color-success)" : "var(--color-primary)",
                        background: isSent
                          ? "color-mix(in oklab, var(--color-success-muted) 30%, transparent)"
                          : "var(--color-surface)",
                        color: isSent ? "var(--color-success)" : "var(--color-primary)",
                      }}
                    >
                      {isSent ? `✓ Sent ${n.who}` : "Send Draft"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {sim && (
          <section>
            <div
              className="mb-1 font-mono text-xs font-semibold uppercase text-[var(--color-text-muted)] tracking-widest"
            >
              Response forces dispatched
            </div>
            <div className="flex flex-wrap gap-1">
              {sim.response_forces_dispatched.map((rf) => (
                <span
                  key={rf}
                  className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 font-mono text-xs text-[var(--color-text)]"
                >
                  {rf}
                </span>
              ))}
            </div>
            {onResolveSim && (
              <button
                onClick={onResolveSim}
                className="mt-3 inline-flex h-11 min-w-[44px] items-center rounded-sm border border-[var(--color-success)] bg-[color-mix(in_oklab,var(--color-success-muted)_30%,var(--color-surface))] px-3 font-mono text-xs font-semibold uppercase text-[var(--color-success)] transition-colors hover:bg-[var(--color-success)] hover:text-white tracking-widest"
                title="Mark the simulated incident resolved · drops FPCON back to BRAVO and clears cordons"
              >
                ✓ Resolve sim · drop FPCON
              </button>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}

// NLResultPanel + KV retired alongside ASK·BASTION (#41 / RETIRE).
// Natural-language TMR submissions live in SPIRO going forward; the
// backend /api/bastion/nl-query endpoint stays available for SPIRO's
// tool-call. Removed unused: function NLResultPanel, function KV.

// Track-G1 — G-4 BASTION command summary card. Three compact columns:
//   1. MC% for each unit in the G-4's scope (max 3 shown).
//   2. Top 3 active alerts by severity.
//   3. Top 3 fused threats (cross-sensor correlations).
// Lives top-center on the schematic. Click any alert row to open the
// existing ResponsePanel — same behaviour as clicking from the sidebar.
// Hidden when an alert is selected so the response panel has the field
// of view to itself.
const G4_UNITS = ["CLB-6", "CLB-1", "3d Maint Bn"];

function G4CommandSummary({
  alerts,
  onAlertClick,
}: {
  alerts: BastionAlert[];
  onAlertClick: (a: BastionAlert) => void;
}) {
  const [mcRates, setMcRates] = useState<Record<string, number | null>>({});
  const [fused, setFused] = useState<Array<{ id: string; severity: string; title: string }>>([]);

  useEffect(() => {
    let alive = true;
    api.pulse
      .fleetOverview()
      .then((r) => {
        if (!alive) return;
        const out: Record<string, number | null> = {};
        // Heatmap rates are per equipment-type. Average across non-null
        // rates to get a single MC% per unit for the summary card.
        for (const u of r.heatmap) {
          const vals = Object.values(u.rates).filter((v): v is number => v != null);
          out[u.unit] = vals.length
            ? vals.reduce((a, b) => a + b, 0) / vals.length
            : null;
        }
        setMcRates(out);
      })
      .catch(() => {
        /* tolerate */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // Base 5s, backs off to 60s when the fused-threat list is unchanged.
    const ctrl = pollWithBackoff(() => api.bastion.fusedThreats(), {
      baseMs: 5000,
      maxMs: 60000,
      fingerprint: (r) =>
        (r.fused_threats || []).slice(0, 3).map((t) => `${t.id}:${t.severity}`).join(","),
      onResult: (r) => setFused((r.fused_threats || []).slice(0, 3)),
    });
    return () => ctrl.stop();
  }, []);

  const topAlerts = useMemo(() => {
    const sevRank: Record<string, number> = { CRITICAL: 5, HIGH: 4, MODERATE: 3, LOW: 2, INFO: 1 };
    return [...alerts]
      .sort(
        (a, b) =>
          (sevRank[b.severity] ?? 0) - (sevRank[a.severity] ?? 0) ||
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      )
      .slice(0, 3);
  }, [alerts]);

  return (
    <div
      className="pointer-events-auto absolute left-1/2 top-3 z-[6] flex -translate-x-1/2 gap-2 rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] px-3 py-2 shadow-lg backdrop-blur"
      role="region"
      aria-label="G-4 command summary"
    >
      {/* Unit MC% column */}
      <div className="min-w-[10rem] border-r border-[var(--color-border)] pr-3">
        <div
          className="font-mono uppercase text-[var(--color-text-muted)]"
          style={{ fontSize: "var(--text-xs)", letterSpacing: "var(--tracking-widest)" }}
        >
          Unit MC% · 2d MLG
        </div>
        <div className="mt-1 flex flex-col gap-0.5">
          {G4_UNITS.map((u) => {
            const rate = mcRates[u];
            const tone =
              rate == null ? "var(--color-text-muted)"
              : rate >= 0.75 ? "var(--color-success)"
              : rate >= 0.65 ? "var(--color-warning)"
              : "var(--color-danger)";
            return (
              <div key={u} className="flex items-baseline justify-between gap-3">
                <span
                  className="font-mono text-[var(--color-text)]"
                  style={{ fontSize: "var(--text-sm)", letterSpacing: "var(--tracking-wide)" }}
                >
                  {u}
                </span>
                <span
                  className="font-mono tabular-nums"
                  style={{
                    fontSize: "var(--text-sm)",
                    color: tone,
                    letterSpacing: "var(--tracking-wide)",
                  }}
                >
                  {rate == null ? "—" : `${(rate * 100).toFixed(1)}%`}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Top alerts column */}
      <div className="min-w-[12rem] border-r border-[var(--color-border)] pr-3">
        <div
          className="font-mono uppercase text-[var(--color-text-muted)]"
          style={{ fontSize: "var(--text-xs)", letterSpacing: "var(--tracking-widest)" }}
        >
          Top Alerts · {topAlerts.length}
        </div>
        <div className="mt-1 flex flex-col gap-0.5">
          {topAlerts.length === 0 && (
            <div
              className="font-mono italic text-[var(--color-text-muted)]"
              style={{ fontSize: "var(--text-sm)" }}
            >
              All clear.
            </div>
          )}
          {topAlerts.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => onAlertClick(a)}
              className="flex items-baseline gap-2 rounded-sm px-1 py-[1px] text-left hover:bg-[var(--color-surface-hover)]"
            >
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: SEVERITY_COLOR[a.severity] || SEVERITY_COLOR.INFO }}
              />
              <span
                className="truncate font-mono text-[var(--color-text)]"
                style={{ fontSize: "var(--text-sm)", maxWidth: "10rem" }}
                title={a.title}
              >
                {a.title}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Fused threats column */}
      <div className="min-w-[10rem]">
        <div
          className="font-mono uppercase text-[var(--color-danger)]"
          style={{ fontSize: "var(--text-xs)", letterSpacing: "var(--tracking-widest)" }}
        >
          Fused Threats · {fused.length}
        </div>
        <div className="mt-1 flex flex-col gap-0.5">
          {fused.length === 0 && (
            <div
              className="font-mono italic text-[var(--color-text-muted)]"
              style={{ fontSize: "var(--text-sm)" }}
            >
              None active.
            </div>
          )}
          {fused.map((t) => (
            <div
              key={t.id}
              className="truncate font-mono text-[var(--color-text)]"
              style={{ fontSize: "var(--text-sm)", maxWidth: "11rem" }}
              title={t.title}
            >
              {t.title}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
