import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { api, type BastionAlert, type BastionCOP, type ThermalHawkSim } from "../api";
import { withRetry, pollWithBackoff, formatApiError, consecutiveErrorTracker } from "../api-retry";
import { useSpireStore } from "../state/store";
import { MapCanvas } from "../components/MapCanvas";
import { FusedThreatsPanel } from "../components/FusedThreatsPanel";
import { ThermalHawkFeed } from "../components/ThermalHawkFeed";
import { RefreshAge } from "../components/RefreshAge";
import { resolveAlertTarget } from "./bastion/resolveAlertTarget";
import { UseCaseStrip } from "../components/UseCaseStrip";
import { AwaitingIngestEmpty } from "../components/AwaitingIngestEmpty";
import { useDatasetStatus } from "../hooks/useDatasetStatus";
import { LinkStatusStrip, commsCadenceMultiplier } from "../components/LinkStatusStrip";
import { DemoSurfaceMarker } from "../components/classification";
import {
  Button,
  IconButton,
  Pressable,
  ErrorState,
  LoadingState,
  fireIdempotent,
  pushUndoToast,
} from "../components/ui";

// Walkthrough audit (#37 from the in-app feedback drawer): "The map needs
// to be given a bit more space, it is very crowded." At 1440×731 the map
// column was sandwiched between a 288px alerts aside (left) and the
// response drawer (right, when an alert is selected) — leaving the
// schematic with as little as ~840px wide. Map Focus Mode collapses the
// alerts aside to a 48px rail and suppresses the right drawer so the map
// owns the full width. Persisted across reloads via localStorage.
const FOCUS_MODE_STORAGE_KEY = "spire.bastion.mapFocus";

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

// Walkthrough audit: a hardcoded unit -> building lookup used to live
// here. The mapping is now data — each cop.units[].home_building carries
// the canonical value from `dataset/data/unit_structure.json`. The
// helper below resolves an arbitrary unit name to its home building id
// off the live cop payload, so adding/renaming a unit doesn't require
// touching this file.
function resolveHomeBuilding(cop: BastionCOP | null, unitName: string | null | undefined): string | null {
  if (!cop || !unitName) return null;
  const u = cop.units.find((x) => x.unit === unitName);
  return u?.home_building ?? null;
}

export function BastionView() {
  // Task #183 — stage live-ingest mode. While the dataset is empty
  // BASTION renders the "Awaiting GCSS-MC ingest" placeholder instead
  // of the COP map, since /api/bastion/cop returns ``{empty: true}``
  // and there is no fleet geometry to render. The hook polls so the
  // view auto-flips after the operator hydrates from DECISION BRIDGE.
  const datasetStatus = useDatasetStatus().status;
  const role = useSpireStore((s) => s.role);
  // Per-view pollers slow down on degraded comms (Task #128) — same
  // multiplier the bridge uses, so the lane backs off everywhere not
  // just on the Decision Bridge.
  const ddilMode = useSpireStore((s) => s.ddilMode);
  const cadenceMult = commsCadenceMultiplier(ddilMode);
  const setAlertCount = useSpireStore((s) => s.setAlertCount);
  const setAlertSeverityCounts = useSpireStore((s) => s.setAlertSeverityCounts);
  const setSelectedUnitIdGlobal = useSpireStore((s) => s.setSelectedUnitId);
  const selectedBuildingIdGlobal = useSpireStore((s) => s.selectedBuildingId);
  const setSelectedBuildingIdGlobal = useSpireStore((s) => s.setSelectedBuildingId);
  const [cop, setCop] = useState<BastionCOP | null>(null);
  // Tracks the case where the dataset *singleton* is non-empty (so
  // useDatasetStatus returns empty=false and we issue the cop fetch),
  // but the cop endpoint still responds with the {empty:true} envelope
  // because no DailySnapshot rows are present. Keeps BASTION from
  // sitting on the loading skeleton forever after an SR-only ingest.
  const [bastionEnvelopeEmpty, setBastionEnvelopeEmpty] = useState(false);
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
  // Wall-clock timestamp of the last successful /alerts response. Drives
  // the "Stream last refreshed Nm Ns ago" indicator on the alert sidebar
  // header (findings F6/F9 in `.local/critiques/bastion-cop.md`). The
  // poll backs off to 60s when the alert fingerprint is unchanged, so
  // without this stamp the operator can't tell if the silent stream is
  // current truth or a degraded link sitting on stale data.
  const [alertsLastRefreshedAt, setAlertsLastRefreshedAt] = useState<number | null>(null);
  // Sustained-outage signal for the alert sidebar. `pollWithBackoff` plus
  // `withRetry` already swallow individual blips so a one-off 5xx during
  // Fly machine spin-up doesn't toast-spam the operator. But a sustained
  // outage previously left the operator with no signal at all — only the
  // RefreshAge stamp climbing red, with no statement of cause. Once
  // ALERTS_OFFLINE_THRESHOLD consecutive polls fail, we surface a
  // persistent "alerts feed offline · retrying" banner inside the
  // sidebar header. Banner stays up until polling recovers (a single
  // success flips the tracker back to online and clears the banner).
  // Threshold lives in `consecutiveErrorTracker` and is unit-tested in
  // `tests/unit/api-retry.test.ts` so it can't silently regress.
  const [alertsFeedOffline, setAlertsFeedOffline] = useState(false);
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

  // Walkthrough audit (#37): Map Focus Mode. When ON the alerts aside
  // collapses to a 48px rail and the right response drawer is suppressed,
  // giving the map the full canvas width. State is hydrated from
  // localStorage so an operator who prefers the focused layout doesn't
  // have to re-toggle on every reload. The selected alert is preserved
  // internally so exiting Focus Mode restores the same drawer state.
  const [mapFocusMode, setMapFocusMode] = useState<boolean>(() => {
    try { return localStorage.getItem(FOCUS_MODE_STORAGE_KEY) === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(FOCUS_MODE_STORAGE_KEY, mapFocusMode ? "1" : "0"); }
    catch { /* tolerant — quota / disabled storage shouldn't crash the view */ }
  }, [mapFocusMode]);

  // Task #185 — at <xl viewports the alerts column collapses to a 48px
  // rail regardless of the operator's Focus Mode preference. The map
  // needs that real estate at 1024-1279, and the rail still surfaces
  // severity counts so situational awareness isn't dropped. Tracked
  // via matchMedia so a window resize updates the layout live (helpful
  // when an operator pops the panel out to a second monitor mid-session).
  //
  // Click-to-expand on the rail at <xl opens the alerts content as an
  // OVERLAY pinned to the left edge of the map column instead of
  // pushing the map — the operator gets the full alert stream when
  // they explicitly ask for it without losing the wide schematic.
  const [viewportXl, setViewportXl] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    try { return window.matchMedia("(min-width: 1280px)").matches; }
    catch { return true; }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(min-width: 1280px)");
    const onChange = () => setViewportXl(mql.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);
  const [alertsOverlayOpen, setAlertsOverlayOpen] = useState(false);
  // The aside is rail-only when Focus Mode is engaged OR the viewport
  // is below xl. The overlay path is independent — it never affects
  // the in-flow column width.
  const railOnly = mapFocusMode || !viewportXl;
  const showAlertsOverlay = !viewportXl && !mapFocusMode && alertsOverlayOpen;
  // Auto-close the overlay if the operator widens the window past xl —
  // the in-flow alerts column is back, the overlay is now redundant.
  useEffect(() => {
    if (viewportXl && alertsOverlayOpen) setAlertsOverlayOpen(false);
  }, [viewportXl, alertsOverlayOpen]);

  const pushToast = useSpireStore((s) => s.pushToast);

  useEffect(() => {
    setCop(null);
    setCopError(null);
    setWaking(false);
    // Task #183 — skip the COP fetch while the dataset is empty. The
    // route returns ``{empty: true}`` and downstream code (MapCanvas,
    // resolveAlertTarget) cannot consume it. The early return at the
    // top of BastionView handles render; we just avoid the wasted call.
    if (datasetStatus?.empty) return;
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
        if ((c as unknown as { empty?: boolean }).empty) {
          // Either: (a) race — ingest cleared between the dataset-status
          // poll and this fetch, or (b) post-ingest partial — singleton
          // has SRs but no DailySnapshot rows so cop legitimately has
          // no map data to render. Either way, surface the placeholder
          // instead of sitting on the loading skeleton.
          setBastionEnvelopeEmpty(true);
          setWaking(false);
          return;
        }
        setBastionEnvelopeEmpty(false);
        setCop(c);
        setWaking(false);
      } catch (e) {
        if (cancelled) return;
        setCopError(formatApiError(e));
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
  }, [role, datasetStatus?.empty]);

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

  // Walkthrough audit (#37): 'F' toggles Map Focus Mode. Same input-skip
  // guard as the '/' shortcut so it's safe to type 'f' inside the search
  // input or SPIRO. Hotkey is documented in the toggle button's title
  // attribute so an operator who hovers the affordance discovers it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "f" && e.key !== "F") return;
      // Code review: App.tsx 'g f' chord opens the feedback drawer and the
      // chord handler now calls e.preventDefault() once it consumes the F.
      // If we see a defaultPrevented F here, the chord already fired — do
      // NOT also toggle Focus Mode (a single keypress would do both).
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t && t.isContentEditable)
      ) return;
      // Don't fight modifier-key combos (Ctrl+F find, Cmd+F find).
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      setMapFocusMode((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Single tracker instance shared by the initial refresh + the poll loop
  // so a one-off blip on either path doesn't flip the offline banner. 3
  // consecutive failures = sustained outage by our standard. The tracker
  // keeps its own counter; React state only sees the on/off transition.
  const alertsFeedTracker = useMemo(
    () => consecutiveErrorTracker(3, setAlertsFeedOffline),
    [],
  );

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
      // Stamp success time for the sidebar's "last refreshed" indicator.
      // Only successful responses bump the stamp; failed polls leave the
      // age ticking up so amber/red tones surface honestly.
      setAlertsLastRefreshedAt(Date.now());
      // Reset the consecutive-error counter — a single good response
      // collapses any "alerts feed offline" banner that was up.
      alertsFeedTracker.onResult();
    },
    [setAlertCount, setAlertSeverityCounts, alertsFeedTracker],
  );

  async function refreshAlerts() {
    try {
      const r = await withRetry(() => api.bastion.alerts(40));
      applyAlertsResponse(r);
    } catch (e) {
      // Toast once per session-ish: a steady poll that's failing should not
      // pop a toast every 5 seconds. We log to console so it's visible in
      // dev tools without spamming the operator. The tracker upgrades the
      // signal to a persistent sidebar banner once N consecutive polls
      // have failed, so a sustained outage isn't silent.
      alertsFeedTracker.onError();
      console.warn("BASTION alert refresh failed:", e);
    }
  }

  useEffect(() => {
    // Base 5s, backs off to 60s when the alert list is unchanged. The toast
    // wall doesn't move during quiet stretches; reviewer caught the fixed
    // setInterval as one of three components polling on the same cadence.
    // On degraded comms (Task #128) base+cap stretch by `cadenceMult` so
    // the alert lane backs off rather than hammering against a queued lane.
    const ctrl = pollWithBackoff(
      () => withRetry(() => api.bastion.alerts(40)),
      {
        baseMs: 5000 * cadenceMult,
        maxMs: 60000 * cadenceMult,
        fingerprint: (r) =>
          `${r.alerts.length}|${r.alerts.map((a) => a.id).join(",")}`,
        onResult: (r) => applyAlertsResponse(r),
        onError: (e) => {
          // Same fail-visibly path as `refreshAlerts` — the tracker is
          // shared so the banner reflects the worst-case across both.
          alertsFeedTracker.onError();
          console.warn("BASTION alert refresh failed:", e);
        },
      },
    );
    return () => ctrl.stop();
  }, [applyAlertsResponse, alertsFeedTracker, cadenceMult]);

  // Per-alert action — ack / snooze / resolve. Optimistic update so the
  // operator sees the row move (or vanish) immediately; if the backend
  // rejects, the next poll restores ground truth.
  //
  // E1 hardening:
  //   • Each (id, action) pair is deduped via fireIdempotent so a fat-finger
  //     double-tap on Resolve fires once, not twice. Lockout of 250 ms.
  //   • Resolve is destructive: defer the API call by 5s and show an
  //     UndoToast. Operator gets a one-click reversal window before the row
  //     leaves the system. Undo restores the alert locally; if the backend
  //     poll has already removed it (rare), the next refresh reconciles.
  async function alertAction(id: string, action: "ack" | "snooze" | "resolve" | "unack") {
    const dedupKey = `bastion:alert:${id}:${action}`;
    return fireIdempotent(dedupKey, async () => {
      if (action === "resolve") {
        const target = alerts.find((a) => a.id === id);
        if (!target) return;
        // Optimistic remove from local stream.
        setAlerts((prev) => prev.filter((a) => a.id !== id));
        if (selectedAlert?.id === id) setSelectedAlert(null);

        let undone = false;
        pushUndoToast({
          text: `Resolved · ${target.title}`,
          onUndo: () => {
            undone = true;
            // Snap the row back into the stream; the next poll will overwrite
            // with the canonical server-side state if it differs.
            setAlerts((prev) => [target, ...prev]);
            if (selectedAlert?.id === id) setSelectedAlert(target);
            pushToast({ tone: "ok", text: "Resolve undone", ttlMs: 2500 });
          },
        });

        // Defer the actual mutation 5s so the undo window is honoured.
        window.setTimeout(async () => {
          if (undone) return;
          try {
            await api.bastion.alertAction(id, "resolve");
            refreshAlerts();
          } catch (e) {
            pushToast({ tone: "error", text: `Resolve failed — ${formatApiError(e)}` });
            refreshAlerts();
          }
        }, 5000);
        return;
      }

      // Non-destructive paths (ack / snooze / unack) commit immediately.
      setAlerts((prev) =>
        prev
          .map((a) => {
            if (a.id !== id) return a;
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
      try {
        await api.bastion.alertAction(id, action);
        refreshAlerts();
      } catch (e) {
        pushToast({ tone: "error", text: `Alert action failed — ${formatApiError(e)}` });
        refreshAlerts();
      }
    });
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
    // Idempotent: keyed per unit so a triple-tap on SIMULATE never spawns
    // two concurrent ThermalHawk incidents. Falls through silently when
    // the lockout window suppresses the duplicate.
    const s = await fireIdempotent(
      "bastion:sim:thermalhawk:CLB-6",
      () => api.bastion.simulateThermalHawk("CLB-6"),
      500,
    );
    if (!s) return;
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

  // F13 — Sim auto-expiry mirror.
  //
  // Server-side, an active sim is dropped from `_ACTIVE_SIMS` after
  // `SIM_TTL` (30 min) and stops appearing in `/alerts`. Locally, `sim`
  // was previously only cleared via the explicit Resolve button — so
  // an operator who triggered ThermalHawk and walked away would come
  // back to a "Sim Active" chip and a Resolve button the server had
  // already forgotten. Acting on that chip projects confidence in
  // state that no longer exists.
  //
  // Strategy:
  //   1. Track whether the active sim's alert id has ever been seen
  //      in a poll response. The trigger response includes the alert
  //      directly, but the very next /alerts poll race could fire
  //      before the server-side prepend lands; we only clear AFTER
  //      we've observed it once and then watch it disappear.
  //   2. When the alert id was previously present in the alerts
  //      stream and the latest poll no longer contains it, clear
  //      `sim` and notify the operator.
  const simSeenInPollRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sim) {
      simSeenInPollRef.current = null;
      return;
    }
    const simId = sim.alert.id;
    const presentInStream = alerts.some((a) => a.id === simId);
    if (presentInStream) {
      simSeenInPollRef.current = simId;
      return;
    }
    // Only clear once we've previously seen this sim id in the stream
    // — otherwise a poll that races the trigger response would clear
    // a freshly-armed sim before the server-side prepend lands.
    if (simSeenInPollRef.current === simId) {
      setSim(null);
      setSelectedAlert((cur) => (cur && cur.id === simId ? null : cur));
      setSelectedUnit(null);
      setSelectedUnitIdGlobal(null);
      simSeenInPollRef.current = null;
      pushToast({
        tone: "warn",
        text: "Sim auto-cleared · server expired the ThermalHawk incident · FPCON returning to BRAVO",
        ttlMs: 4500,
      });
    }
  }, [alerts, sim, pushToast, setSelectedUnitIdGlobal]);

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

  // Drill-from-alert. Run the deterministic alert→building resolver so
  // every alert lands the operator on a real building, not a silent
  // no-op. Precedence (see resolveAlertTarget):
  //   1. unit's home_building   2. exact grid match   3. nearest named
  //   building inside the same MGRS 1km square (projected metres).
  //
  // Unit selection is promoted only when the alert references a unit;
  // otherwise we *clear* it so a non-unit alert (e.g. a grid-only
  // weather/UAS hit) doesn't leave a stale unit ring on the map.
  // selectedBuildingId is shared global state so the building focus
  // survives view transitions and a future cross-view drill.
  function onAlertClick(a: BastionAlert) {
    setSelectedAlert(a);
    if (a.unit) {
      setSelectedUnit(a.unit);
      setSelectedUnitIdGlobal(a.unit);
    } else {
      setSelectedUnit(null);
      setSelectedUnitIdGlobal(null);
    }
    const target = resolveAlertTarget(a, cop);
    setSelectedBuildingIdGlobal(target.buildingId);
  }

  const simTargetBuilding = useMemo(() => {
    if (!sim) return undefined;
    return resolveHomeBuilding(cop, sim.alert.unit) ?? undefined;
  }, [sim, cop]);

  // When an alert is selected, derive a "fly to" target building via the
  // shared resolver (unit_home → exact grid → nearest in same 1km square).
  // Closes the existing TODO around the "nearest named building" fallback
  // so a grid-only alert no longer silently no-ops on the map.
  const flyToBuilding = useMemo(() => {
    if (!selectedAlert) return null;
    return resolveAlertTarget(selectedAlert, cop).buildingId;
  }, [selectedAlert, cop]);

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

  if (datasetStatus?.empty || bastionEnvelopeEmpty) {
    return (
      <div className="flex h-full flex-col">
        <UseCaseStrip
          number="11"
          title="BASTION"
          subtitle="COMMON OPERATING PICTURE — INSTALLATION SCHEMATIC"
          accent="var(--color-warning)"
        />
        <div className="flex-1 overflow-hidden">
          <AwaitingIngestEmpty
            surface="BASTION"
            description={
              datasetStatus?.empty
                ? "The COP map renders unit positions, MC%, and threats from the live GCSS-MC export. Drop the three sanitized CSVs into DECISION BRIDGE to populate this view."
                : "The COP map needs daily readiness snapshots. The current ingest only contains SR records — drop a snapshot timeseries to populate this view."
            }
          />
        </div>
      </div>
    );
  }
  if (copError && !cop) {
    return (
      <ErrorState
        title="Installation Offline"
        description="BASTION schematic unreachable after 4 attempts. Backend may be cycling — wait a moment, then switch role to retry."
        detail={copError}
        onRetry={() => {
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
              setCopError(formatApiError(e));
              setWaking(false);
            });
        }}
      />
    );
  }
  if (!cop) {
    return <LoadingState size="page" label="Loading installation schematic..." waking={waking} />;
  }

  return (
    // MDM 2026 stage-pivot — wrap the original sidebar+map+panel row
    // in a flex-column so the UseCaseStrip can sit above it without
    // disturbing the existing 3-pane layout. Strip is render-noop in
    // operator mode so this wrapper has no visual impact off-stage.
    <div className="flex h-full flex-col overflow-hidden">
      <UseCaseStrip number="15" title="BASTION" subtitle="INSTALLATION COP AGGREGATOR · gates · utilities · emergency · weather · sensors" accent="var(--color-danger)" />
      {/* Link-status strip — Task #128. Lives at the top of every primary
       * view so the operator can't lose track of a degraded lane while
       * scrolling the alert stream or working a building. */}
      <div className="flex shrink-0 items-center justify-end border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1">
        <LinkStatusStrip />
      </div>
      {/* Task #125 — per-beat classification + DEMO DATA chip on the
        * BASTION surface itself, so a screenshot of the COP / alerts
        * during a live demo beat self-marks instead of leaning on the
        * global app-shell banner. Render-noop off-stage. */}
      <DemoSurfaceMarker />
      <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left sidebar: alert stream — collapses to a 48px rail in Map
       * Focus Mode (#37). The rail still surfaces the active count + a
       * severity-tinted top edge so the operator hasn't lost situational
       * awareness; click the rail to expand back. */}
      {/* Task #185 — alerts column responsive widths.
       *
       * Off-stage at 1024–1279 the column is a 48px rail so the
       * schematic gets the breathing room operators ask for; click on
       * the rail opens the alerts content as an OVERLAY pinned to the
       * left edge of the map (no push). 1280–1535 (xl → 2xl) gives
       * 240px (w-60) in-flow — wide enough for the AlertRow severity
       * chip + truncated title without crowding the map. 1536+
       * (2xl/3xl) gives the legacy 288px (w-72) so wide-monitor demos
       * retain the original information density.
       *
       * Map Focus Mode (#37) still forces the rail at every breakpoint
       * — it's an explicit operator override, not a viewport hint. */}
      <aside
        className={clsx(
          "flex shrink-0 flex-col overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-bg)]",
          railOnly ? "w-12" : "w-60 2xl:w-72",
        )}
      >
      {railOnly ? (
        <FocusModeAlertRail
          activeCount={activeAlerts.length}
          ackedCount={ackedAlerts.length}
          severityCounts={(() => {
            const c: Record<string, number> = { CRITICAL: 0, HIGH: 0, MODERATE: 0, LOW: 0, INFO: 0 };
            for (const a of alerts) {
              if (a._state?.status === "acknowledged") continue;
              c[a.severity] = (c[a.severity] ?? 0) + 1;
            }
            return c;
          })()}
          onExpand={() => {
            // Click-to-expand has to work in EVERY rail state, including
            // the (<xl ∧ focus-on) corner case the reviewer caught: if we
            // only set `alertsOverlayOpen` there, `showAlertsOverlay` =
            // `!viewportXl && !mapFocusMode && alertsOverlayOpen` stays
            // false because `mapFocusMode` is still true → click does
            // nothing visually. Fix: always drop focus mode first, then
            // open the overlay at <xl. At xl+, dropping focus mode alone
            // restores the full alerts column without needing the overlay.
            setMapFocusMode(false);
            if (!viewportXl) {
              setAlertsOverlayOpen(true);
            }
          }}
        />
      ) : (
        <>
        {/* Focus Mode toggle row — sits above the alert stream header
         * so the affordance is the first thing an operator sees on the
         * column. Title carries the F hotkey for keyboard discovery. */}
        <div className="flex justify-end border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1">
          <Pressable
            onClick={() => setMapFocusMode(true)}
            block={false}
            aria-label="Focus map (F) — collapse alerts column and response drawer"
            title="Focus map (F) — give the schematic the full canvas. Click again to restore."
            className="!min-h-0 flex h-6 items-center gap-1 rounded-sm border border-transparent px-1.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
          >
            <span aria-hidden>↤</span>
            <span>Focus map</span>
          </Pressable>
        </div>
        <AlertStreamHeader
          activeCount={activeAlerts.length}
          ackedCount={ackedAlerts.length}
          sevFilter={sevFilter}
          onSevFilter={setSevFilter}
          searchQuery={searchQuery}
          onSearchQuery={setSearchQuery}
          lastRefreshedAt={alertsLastRefreshedAt}
          feedOffline={alertsFeedOffline}
          // Walkthrough audit: prior code passed alertSeverityCounts
          // (raw API counts including acked rows). After an ACK the
          // 'ALL N' chip stayed at 30 while the stream rendered 29.
          // Count over alerts MINUS acked rows so the chips reflect
          // what's actually in the active stream (and don't pre-filter
          // by current severity selection — that would zero out the
          // other chips).
          severityCounts={(() => {
            const c: Record<string, number> = { CRITICAL: 0, HIGH: 0, MODERATE: 0, LOW: 0, INFO: 0 };
            for (const a of alerts) {
              if (a._state?.status === "acknowledged") continue;
              c[a.severity] = (c[a.severity] ?? 0) + 1;
            }
            return c;
          })()}
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
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAcked((v) => !v)}
                className="w-full justify-between px-2 text-[10px] tracking-widest text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                trailingIcon={<span aria-hidden>{showAcked ? "▾" : "▸"}</span>}
              >
                Acknowledged ({ackedAlerts.length})
              </Button>
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
        </>
      )}
      </aside>

      {/* Center: schematic — Task #185 adds `min-w-0` so the flex child
       *  stops claiming its content's intrinsic width when the alerts
       *  column / response drawer expand. Without this, MapLibre's
       *  internal width measurement was occasionally pushing the row
       *  past the parent and triggering horizontal scroll on 1024-wide
       *  viewports. */}
      <div className="relative flex-1 min-w-0">
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
          selectedBuildingId={selectedBuildingIdGlobal}
          onBuildingClick={(id) => setSelectedBuildingIdGlobal(id)}
          simActive={!!sim}
          simTargetBuilding={simTargetBuilding}
          simCordons={sim?.cordon_zones}
          drawerOpen={!!selectedAlert && !mapFocusMode}
          simResolveSignal={simResolveSignal}
        />

        {/* Task #185 — at <xl viewports the alerts content overlays the
         *  map column when the operator clicks expand on the rail. The
         *  panel is pinned to the left edge so the rail stays as the
         *  visible affordance to close it again. */}
        {showAlertsOverlay && (
          <div
            role="dialog"
            aria-label="BASTION alert stream (overlay)"
            className="absolute inset-y-0 left-0 z-20 flex w-72 max-w-[80vw] flex-col overflow-hidden border-r border-[var(--color-border-active)] bg-[var(--color-bg)] shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1">
              <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                Alerts (overlay)
              </span>
              <Pressable
                onClick={() => setAlertsOverlayOpen(false)}
                block={false}
                aria-label="Collapse alerts overlay"
                title="Collapse alerts overlay"
                className="!min-h-0 flex h-6 items-center gap-1 rounded-sm border border-transparent px-1.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
              >
                <span aria-hidden>↦</span>
                <span>Collapse</span>
              </Pressable>
            </div>
            <AlertStreamHeader
              activeCount={activeAlerts.length}
              ackedCount={ackedAlerts.length}
              sevFilter={sevFilter}
              onSevFilter={setSevFilter}
              searchQuery={searchQuery}
              onSearchQuery={setSearchQuery}
              lastRefreshedAt={alertsLastRefreshedAt}
              feedOffline={alertsFeedOffline}
              severityCounts={(() => {
                const c: Record<string, number> = { CRITICAL: 0, HIGH: 0, MODERATE: 0, LOW: 0, INFO: 0 };
                for (const a of alerts) {
                  if (a._state?.status === "acknowledged") continue;
                  c[a.severity] = (c[a.severity] ?? 0) + 1;
                }
                return c;
              })()}
            />
            <div className="flex-1 overflow-y-auto p-2">
              <FusedThreatsPanel />
              {dedupeAlerts(activeAlerts).map((a) => (
                <AlertRow
                  key={a.id}
                  alert={a}
                  groupCount={a._groupCount}
                  justArrived={recentAlertIds.has(a.id)}
                  selected={selectedAlert?.id === a.id}
                  onClick={() => {
                    onAlertClick(a);
                    setAlertsOverlayOpen(false);
                  }}
                  onAck={() => alertAction(a.id, "ack")}
                  onSnooze={() => alertAction(a.id, "snooze")}
                  onResolve={() => alertAction(a.id, "resolve")}
                />
              ))}
            </div>
          </div>
        )}

        {/* Installation title badge — top-left. Metrics row uses chip-flow
         * so when the response drawer narrows the map column the chips wrap
         * to 2x2 instead of mid-token-truncating "10 RF" → "10 R" (#27). */}
        {/* Walkthrough audit: COP card was at top-left, directly on top
         * of the unit marker cluster (3d Maint Bn, 2d LAR Bn, 7th ESB
         * labels were partially obscured). Move to bottom-left, where
         * the map is empty and the MapLibre attribution sits at
         * bottom-right (no conflict). */}
        <div
          className="pointer-events-none absolute bottom-12 left-3 z-[6] max-w-[min(60vw,320px)] rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] px-3 py-2 backdrop-blur"
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
        {/* Walkthrough audit: when a sim is active the response panel
         * opens on the right and the map shrinks, leaving Sim Controls
         * (left-3) and Mission Clock (right-3) overlapping. The button
         * is also disabled during an active sim, so hiding the whole
         * pill removes the overlap and the dead control simultaneously. */}
        {(role === "mef_commander" || role === "security_manager" || role === "g4" || useSpireStore.getState().stageMode) && !sim && (
          <div
            className="pointer-events-auto absolute left-3 top-3 z-[7] flex items-center gap-1.5"
            role="region"
            aria-label="Sim controls"
          >
            <span
              className="rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] px-2 py-1 font-mono text-[10px] font-semibold uppercase text-[var(--color-text-muted)] backdrop-blur tracking-widest"
            >
              Sim Controls
            </span>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                window.dispatchEvent(new CustomEvent("spire:simulate-thermalhawk"));
              }}
              disabled={!!sim}
              title={
                sim
                  ? "Simulation already active — resolve via the response panel"
                  : "Dispatch a synthetic ThermalHawk UAS detection · escalates FPCON to CHARLIE for the duration"
              }
              className="border-dashed border-[var(--color-border-active)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] backdrop-blur"
              leadingIcon={<span aria-hidden className="text-[var(--color-primary)]">▶</span>}
            >
              <span className="text-[var(--color-text-muted)] mr-1">Simulate</span>
              ThermalHawk
            </Button>
          </div>
        )}

        {/* Walkthrough audit: when a sim is active and the operator
         * dismisses the response panel (✕), there was no surface left
         * to resolve the sim — they'd have to re-open the alert from
         * the stream. Replace the hidden Sim Controls pill with a
         * persistent 'Resolve sim · drop FPCON' chip in the same slot
         * during sims, so the resolve action is always one click away. */}
        {sim && (role === "mef_commander" || role === "security_manager" || role === "g4") && (
          <div
            className="pointer-events-auto absolute left-3 top-3 z-[7] flex items-center gap-1.5"
            role="region"
            aria-label="Sim resolve"
          >
            <span
              className="rounded-sm border border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning-muted)_18%,transparent)] px-2 py-1 font-mono text-[10px] font-semibold uppercase text-[var(--color-warning)] backdrop-blur tracking-widest"
            >
              Sim Active
            </span>
            <Button
              variant="secondary"
              size="md"
              onClick={() => setConfirmResolve(true)}
              title="Resolve simulation · drop FPCON BRAVO and clear cordon overlays"
              className="border-[var(--color-success)] bg-[color-mix(in_oklab,var(--color-success-muted)_30%,transparent)] text-[var(--color-success)] backdrop-blur hover:bg-[color-mix(in_oklab,var(--color-success-muted)_50%,transparent)]"
              leadingIcon={<span aria-hidden>✓</span>}
            >
              Resolve sim
            </Button>
          </div>
        )}

        {/* Track-G1 — G-4 command summary card. Three columns of "what
         * matters in the next 30 seconds": MC% per scoped unit, top alerts,
         * top fused threats. Renders only for the G-4 role and only when no
         * alert is selected (so it doesn't fight with the response panel).
         * Also hidden in Map Focus Mode (#37) — the whole point of focus
         * is to give the map breathing room, and this card spans the
         * top-center of the schematic. */}
        {role === "g4" && !selectedAlert && !mapFocusMode && (
          <G4CommandSummary alerts={alerts} onAlertClick={(a) => setSelectedAlert(a)} />
        )}

        {/* ASK·BASTION retired — SPIRO (Ctrl+/) is the sole chat surface
         * across all SPIRE views. Reviewer caught the floating NL bar
         * leaking pointer events to the map underneath (#41) and competing
         * with the right-rail toast lane in the same corner. SPIRO renders
         * from app shell and handles all natural-language operator input. */}
      </div>

      {/* Right sidebar: response panel — suppressed in Map Focus Mode
       * (#37). selectedAlert is preserved internally so exiting Focus
       * Mode restores the same drawer; the operator doesn't have to
       * re-click the alert. */}
      {selectedAlert && !mapFocusMode && (
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
          <Button variant="secondary" onClick={onCancel} autoFocus>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            className="border-[var(--color-success)] bg-[var(--color-success)] text-white hover:opacity-90"
          >
            Resolve
          </Button>
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
          {/* Row actions composed via <Button> primitives. The visual
           * compactness (h-7, text-[10px]) is preserved via className
           * overrides while inheriting focus rings and consistent disabled
           * styling. Touch targets remain ≥36px in this dense alert list
           * — operators on the desktop staff view, not the field iPad. */}
          {onAck && !acked && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onAck}
              className="h-7 px-2 text-[10px] tracking-widest"
              title="Acknowledge — moves to the Acknowledged group"
            >
              Ack
            </Button>
          )}
          {onSnooze && !snoozed && !acked && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onSnooze}
              className="h-7 px-2 text-[10px] tracking-widest hover:border-[var(--color-warning)] hover:text-[var(--color-warning)]"
              title="Snooze 1h — row resurfaces if still open"
            >
              Snooze 1h
            </Button>
          )}
          {onUnack && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onUnack}
              className="h-7 px-2 text-[10px] tracking-widest"
              title="Move back to active alerts"
            >
              Un-ack
            </Button>
          )}
          {onResolve && (
            <Button
              variant="secondary"
              size="sm"
              onClick={onResolve}
              className="h-7 px-2 text-[10px] tracking-widest border-[var(--color-success)] bg-[color-mix(in_oklab,var(--color-success-muted)_25%,transparent)] text-[var(--color-success)] hover:bg-[var(--color-success)] hover:text-white"
              title="Resolve — drops from the open count"
            >
              Resolve
            </Button>
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
  severityCounts,
  lastRefreshedAt,
  feedOffline,
}: {
  activeCount: number;
  ackedCount: number;
  sevFilter: SeverityFilter;
  severityCounts?: Record<string, number>;
  onSevFilter: (s: SeverityFilter) => void;
  searchQuery: string;
  onSearchQuery: (s: string) => void;
  /** Wall-clock ms timestamp of the last successful /alerts response;
   * null while the very first response is in flight. Drives the
   * "Stream last refreshed Nm Ns ago" indicator that goes amber after
   * 30s and red after 90s — see findings F6/F9. */
  lastRefreshedAt: number | null;
  /** True once the consecutive-error tracker (api-retry) has decided
   * the alerts feed is offline. Drives the persistent "alerts feed
   * offline · retrying" banner — replaces the prior dev-console-only
   * console.warn. */
  feedOffline: boolean;
}) {
  return (
    <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between p-3 pb-1">
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
      {/* Recency indicator — ticks every second so motion = freshness on
       * the alert stream the same way it did on the Mission Clock.
       * Without this stamp the operator can't tell whether a quiet
       * sidebar means "nothing is happening" or "the link went yellow
       * a minute ago and we're sitting on stale data". */}
      <div className="px-3 pb-2">
        <RefreshAge ts={lastRefreshedAt} />
        {/* Sustained-outage banner. Persistent (not a toast) so it
         * stays visible while polling retries — the RefreshAge stamp
         * tells the operator how stale the displayed list is, this
         * banner names the cause. Clears automatically on the next
         * successful poll via consecutiveErrorTracker.onResult(). */}
        {feedOffline && (
          <div
            role="status"
            aria-live="polite"
            className="mt-1.5 flex items-center gap-1.5 rounded-sm border border-[var(--color-danger)] bg-[color-mix(in_oklab,var(--color-danger)_15%,var(--color-bg))] px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-danger)]"
          >
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-danger)]"
              style={{ boxShadow: "0 0 4px var(--color-danger)" }}
            />
            <span>Alerts feed offline · retrying</span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 px-2 pb-1.5">
        {SEV_FILTER_OPTIONS.map((opt) => {
          const active = sevFilter === opt;
          const tone =
            opt === "HIGH"     ? "var(--color-danger)" :
            opt === "MODERATE" ? "var(--color-warning)" :
            opt === "INFO"     ? "var(--color-primary)" :
                                 "var(--color-text)";
          // Walkthrough audit: clicking 'CRITICAL' or 'INFO' on a
          // dataset that has zero of that severity wastes a click. Show
          // the count beside each label so the operator can see
          // up-front which severities have rows. ALL shows total
          // open count.
          const total = (severityCounts?.CRITICAL ?? 0) + (severityCounts?.HIGH ?? 0)
            + (severityCounts?.MODERATE ?? 0) + (severityCounts?.LOW ?? 0) + (severityCounts?.INFO ?? 0);
          const count = opt === "ALL" ? total : (severityCounts?.[opt] ?? 0);
          return (
            <Button
              key={opt}
              variant="ghost"
              size="sm"
              onClick={() => onSevFilter(opt)}
              className={clsx(
                "h-7 rounded-sm border px-2 text-[10px] tracking-widest",
                active ? "bg-[var(--color-bg)] text-[var(--color-text)]" : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
                count === 0 && opt !== "ALL" ? "opacity-50" : "",
              )}
              style={{
                borderColor: active ? tone : "transparent",
                color: active ? tone : undefined,
              }}
              aria-pressed={active}
              aria-label={`${opt} · ${count}`}
            >
              {opt} <span className="ml-1 tabular-nums opacity-70">{count}</span>
            </Button>
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

// Walkthrough audit (#37): collapsed-rail rendering of the alert column
// for Map Focus Mode. The rail surfaces (a) the active alert count so
// the operator hasn't lost situational awareness, (b) a top edge
// tinted by the highest-severity bucket so a CRITICAL doesn't become
// invisible just because the panel is narrow, and (c) a clickable
// chevron at the bottom that expands the column back to full width.
// Whole rail is a click target — no precision-aiming a tiny chevron
// during a live incident.
function FocusModeAlertRail({
  activeCount,
  ackedCount,
  severityCounts,
  onExpand,
}: {
  activeCount: number;
  ackedCount: number;
  severityCounts: Record<string, number>;
  onExpand: () => void;
}) {
  // Highest-severity bucket with at least one alert. CRITICAL > HIGH >
  // MODERATE > LOW > INFO. Drives the rail's top edge tint so a single
  // CRITICAL still reads at a glance with the column at 48px.
  const topSeverity = (
    (severityCounts.CRITICAL ?? 0) > 0 ? "CRITICAL" :
    (severityCounts.HIGH ?? 0) > 0     ? "HIGH" :
    (severityCounts.MODERATE ?? 0) > 0 ? "MODERATE" :
    (severityCounts.LOW ?? 0) > 0      ? "LOW" :
    (severityCounts.INFO ?? 0) > 0     ? "INFO" :
                                          null
  ) as keyof typeof SEVERITY_COLOR | null;
  const tint = topSeverity ? SEVERITY_COLOR[topSeverity] : "var(--color-border)";
  return (
    <Pressable
      onClick={onExpand}
      block={false}
      aria-label={`Expand alerts column (F) — ${activeCount} active${ackedCount ? `, ${ackedCount} acknowledged` : ""}`}
      title={`Expand alerts (F) — ${activeCount} active${topSeverity ? `, top severity ${topSeverity}` : ""}`}
      className="!min-h-0 group flex h-full w-full flex-col items-center gap-2 px-1.5 pt-2 pb-2 hover:bg-[color-mix(in_oklab,var(--color-text)_4%,transparent)]"
    >
      {/* Top tint bar — shouts the highest severity bucket. */}
      <span
        className="h-1 w-full rounded-sm"
        style={{ background: tint, opacity: topSeverity ? 0.85 : 0.3 }}
        aria-hidden
      />
      {/* Vertical "ALERTS" label — stays legible at 48px wide. */}
      <span
        className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]"
        style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
      >
        Alerts
      </span>
      {/* Active count — large + tabular so it reads at a glance. */}
      <span
        className="font-mono text-base font-semibold tabular-nums leading-none"
        style={{ color: topSeverity ? tint : "var(--color-text-secondary)" }}
      >
        {activeCount}
      </span>
      {/* Severity stack — only buckets with > 0 are rendered to keep
       * the rail uncluttered. Tooltip on each shows the count. */}
      <div className="mt-1 flex flex-col items-center gap-1">
        {(["CRITICAL", "HIGH", "MODERATE", "LOW", "INFO"] as const).map((sev) => {
          const n = severityCounts[sev] ?? 0;
          if (n === 0) return null;
          return (
            <span
              key={sev}
              className="flex items-center gap-0.5 font-mono text-[10px] tabular-nums"
              style={{ color: SEVERITY_COLOR[sev] }}
              title={`${sev} · ${n}`}
            >
              <span aria-hidden style={{ fontSize: "9px", lineHeight: 1 }}>{SEVERITY_GLYPH[sev]}</span>
              <span>{n}</span>
            </span>
          );
        })}
      </div>
      {/* Spacer + expand chevron at the bottom — mirrors the rail's
       * "click anywhere to expand" affordance with a literal cue. */}
      <span className="mt-auto font-mono text-base text-[var(--color-text-muted)] group-hover:text-[var(--color-text)]" aria-hidden>
        ↦
      </span>
    </Pressable>
  );
}

function MissionHUD() {
  // Findings F6/F9: a 1-Hz seconds tick on the Mission Clock dominated
  // the page and broadcast "everything is current" while the alert
  // stream and fused-threats card had no comparable motion. Operators
  // read motion as freshness; on a yellow SATCOM link they were
  // trusting the clock while reading minute-old alerts.
  //
  // The seconds counter is demoted (the visible DTG only resolves to
  // the minute, so we tick once per 5s — enough to roll over within a
  // minute boundary on time, never enough to dominate). The data-
  // recency indicators on the alert sidebar / fused-threats card now
  // own the per-second tick across the page.
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 5000);
    return () => window.clearInterval(id);
  }, []);

  const z = (n: number, w = 2) => String(n).padStart(w, "0");
  // DTG resolves to HHMM only — the seconds suffix on the secondary
  // line was deliberately dropped so motion = freshness lives on the
  // data-recency stamps, not the clock face.
  const dtg = `${z(now.getUTCDate())}${z(now.getUTCHours())}${z(now.getUTCMinutes())}Z`;
  const dd = z(now.getUTCDate());
  const month = now
    .toLocaleString("en-US", { month: "short", timeZone: "UTC" })
    .toUpperCase();
  const yyyy = String(now.getUTCFullYear());
  const datestamp = `${dd} ${month} ${yyyy}`;

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
        className="mt-0.5 font-mono text-base font-semibold tabular-nums text-[var(--color-text)] tracking-wide"
        style={{ lineHeight: 1 }}
      >
        {dtg}
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
    // Walkthrough audit: prior allowlist was 8 keywords and dropped the
    // Maintenance Chief's primary action — 'Execute cannibalization if
    // match available' — because 'cannib' wasn't in the regex. Broaden
    // to cover everything a maintenance chief acts on directly: parts,
    // assets, equipment, repair, motor pool, and unit-internal admin.
    return items.filter((it) =>
      /equipment|facility|unit|update|motor|MEL|parts|shop|cannib|asset|nmcs|nmcm|repair|maintain|service|TM|TAMCN|secure|protect|expedite|priority/i.test(it)
    );
  }
  if (role === "g4") {
    // Walkthrough audit: prior allowlist was 8 keywords and excluded
    // 'restrict', 'protect', 'secure', 'cannibalize', 'parts', 'asset'
    // — every UAS_INCURSION item that touches logistics impact.
    // Broaden to cover the G-4 mandate: assets/parts/units/facilities,
    // movement, supply chain, and notification of higher.
    return items.filter((it) =>
      /notify|dispatch|coordinate|MLG|G-4|convoy|TMR|expedite|response|restrict|protect|secure|asset|parts|facility|equipment|cannib|MEL|escalate|brief|ETA|SSA|DLA/i.test(it)
    );
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

  // Task #185 — response drawer scales with viewport. md/lg keep
  // the legacy 400px feel but at xl+ we lift to 28rem (448px) so
  // the model-info / checklist sections stop forcing a vertical
  // scroll on first paint, and 3xl+ takes 32rem to match the
  // wider alerts column. <md falls back to a fluid panel that
  // consumes the right two-thirds of the viewport so the schematic
  // remains glanceable behind it.
  return (
    <aside className="flex w-[min(72vw,400px)] md:w-[400px] xl:w-[28rem] 3xl:w-[32rem] shrink-0 flex-col overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)]">
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
          <IconButton
            aria-label="Close response panel"
            onClick={onClose}
            variant="ghost"
            size="md"
          >
            <span aria-hidden>✕</span>
          </IconButton>
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
            <div className="mb-1 flex items-baseline justify-between font-mono text-xs uppercase tracking-widest">
              <span className="font-semibold text-[var(--color-text-muted)]">Detection Model</span>
              {/* Walkthrough audit: load_state badge so the operator can see
               * whether the alert came from a deployed model, present-but-
               * idle weights, or the rule-based sim. Reads as
               * 'LIVE' / 'WEIGHTS PRESENT' / 'SIM' with a matched colour. */}
              {alert.model_info.load_state && (
                <span
                  className="rounded-sm border px-1 font-mono text-[10px] font-semibold tracking-widest"
                  style={(() => {
                    const s = alert.model_info.load_state;
                    if (s === "live")             return { color: "var(--color-success)", borderColor: "color-mix(in oklab, var(--color-success) 40%, var(--color-border))" };
                    if (s === "weights_present")  return { color: "var(--color-warning)", borderColor: "color-mix(in oklab, var(--color-warning) 40%, var(--color-border))" };
                    return { color: "var(--color-text-muted)", borderColor: "var(--color-border)" };
                  })()}
                >
                  {alert.model_info.load_state === "live"
                    ? "LIVE"
                    : alert.model_info.load_state === "weights_present"
                    ? "WEIGHTS PRESENT"
                    : "SIM"}
                </span>
              )}
            </div>
            <div className="font-mono text-[var(--color-text)]">{alert.model_info.model}</div>
            {(alert.model_info.parameters != null || alert.model_info.architecture || alert.model_info.validation_map_50_95 != null) && (
              <div className="text-[var(--color-text-secondary)]">
                {alert.model_info.parameters != null && (
                  <>{alert.model_info.parameters.toLocaleString("en-US")} parameters</>
                )}
                {alert.model_info.parameters != null && alert.model_info.architecture && " · "}
                {alert.model_info.architecture}
                {alert.model_info.validation_map_50_95 != null && (
                  <span className="ml-1 text-[var(--color-text-muted)]">
                    · val mAP {(alert.model_info.validation_map_50_95 * 100).toFixed(1)}%
                  </span>
                )}
              </div>
            )}
            {(alert.model_info.training || alert.model_info.deployment_target || alert.model_info.capability) && (
              <div className="mt-1 break-words text-xs text-[var(--color-text-muted)]">
                {alert.model_info.capability && <>{alert.model_info.capability}</>}
                {alert.model_info.capability && (alert.model_info.training || alert.model_info.deployment_target) && " · "}
                {alert.model_info.training}
                {alert.model_info.training && alert.model_info.deployment_target && " · "}
                {alert.model_info.deployment_target && <>target: {alert.model_info.deployment_target}</>}
              </div>
            )}
            {alert.model_info.weights_size_mb != null && (
              <div className="mt-1 font-mono text-xs text-[var(--color-text-secondary)]">
                Weights on disk: {alert.model_info.weights_size_mb} MB
              </div>
            )}
            {alert.model_info.note && (
              <div className="mt-1 font-mono text-xs italic text-[var(--color-text-muted)]">
                {alert.model_info.note}
              </div>
            )}
          </section>
        )}

        {/* Live ThermalHawk feed — mounts when the sim alert is selected
         * and the trained model is loaded (load_state === 'live'). The
         * component handles its own polling, pause control, and graceful
         * degradation when the model isn't loaded. */}
        {sim && sim.alert.id === alert.id
          && alert.model_info?.load_state === "live" && (
          <section>
            <ThermalHawkFeed />
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
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={(e) => {
                        // stopPropagation guards against any future ancestor
                        // click handler swallowing the event before it lands.
                        e.stopPropagation();
                        sendNotification(n.who);
                      }}
                      disabled={isSent}
                      title={isSent ? `Already sent to ${n.who}` : `Send draft notification to ${n.who} · audit logged`}
                      className="ml-auto"
                      style={{
                        borderColor: isSent ? "var(--color-success)" : "var(--color-primary)",
                        background: isSent
                          ? "color-mix(in oklab, var(--color-success-muted) 30%, transparent)"
                          : "var(--color-surface)",
                        color: isSent ? "var(--color-success)" : "var(--color-primary)",
                      }}
                    >
                      {isSent ? `✓ Sent ${n.who}` : "Send Draft"}
                    </Button>
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
              <Button
                variant="secondary"
                size="md"
                onClick={onResolveSim}
                className="mt-3 border-[var(--color-success)] bg-[color-mix(in_oklab,var(--color-success-muted)_30%,var(--color-surface))] text-[var(--color-success)] hover:bg-[var(--color-success)] hover:text-white"
                title="Mark the simulated incident resolved · drops FPCON back to BRAVO and clears cordons"
              >
                ✓ Resolve sim · drop FPCON
              </Button>
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
// Walkthrough audit: the G-4 unit list used to be a hardcoded triple of
// ['CLB-6', 'CLB-1', '3d Maint Bn']. CLB-1 belongs to 1st MLG and is out
// of scope for a 2d MLG G-4, so the list both leaked an out-of-scope
// unit AND duplicated data the API already scopes. The card now reads
// the visible units off the role-scoped fleetOverview heatmap response.

function G4CommandSummary({
  alerts,
  onAlertClick,
}: {
  alerts: BastionAlert[];
  onAlertClick: (a: BastionAlert) => void;
}) {
  // Match the bridge: slow the fused-threat poller down on degraded comms
  // (Task #128) so the lane backs off rather than hammering against a
  // queued/cached payload.
  const ddilMode = useSpireStore((s) => s.ddilMode);
  const cadenceMult = commsCadenceMultiplier(ddilMode);
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
    // On degraded comms (Task #128) base+cap stretch by `cadenceMult`.
    const ctrl = pollWithBackoff(() => api.bastion.fusedThreats(), {
      baseMs: 5000 * cadenceMult,
      maxMs: 60000 * cadenceMult,
      fingerprint: (r) =>
        (r.fused_threats || []).slice(0, 3).map((t) => `${t.id}:${t.severity}`).join(","),
      onResult: (r) => setFused((r.fused_threats || []).slice(0, 3)),
    });
    return () => ctrl.stop();
  }, [cadenceMult]);

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
          {Object.keys(mcRates).sort().map((u) => {
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
            <Button
              key={a.id}
              variant="ghost"
              size="sm"
              onClick={() => onAlertClick(a)}
              className="h-6 justify-start gap-2 px-1 text-left"
              leadingIcon={
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: SEVERITY_COLOR[a.severity] || SEVERITY_COLOR.INFO }}
                />
              }
            >
              <span
                className="truncate font-mono text-[var(--color-text)]"
                style={{ fontSize: "var(--text-sm)", maxWidth: "10rem" }}
                title={a.title}
              >
                {a.title}
              </span>
            </Button>
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
