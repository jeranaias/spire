/**
 * JointPreviewView — faux Navy / Joint J4 console rendering the SPIRE
 * OMS/UCI export. Lives at /joint/preview, opened in a new tab from the
 * "Push to Joint COP" topbar action so a judge can hold both windows
 * side-by-side and see SPIRE's data appearing coherently in a sister-
 * service shell.
 *
 * Design intent: this is INTENTIONALLY not the SPIRE chrome. Different
 * banner, different colors (Navy steel-blue vs SPIRE primary), different
 * type, "Joint Logistics & Tracks Console" branding. The point is to
 * show the data is portable across services, so the shell has to feel
 * unfamiliar relative to the parent app.
 *
 * Task #79 — contested-fight survival pass:
 *  - SPIRE comms control surfaced on JLTC topbar (Limited/Intermittent/
 *    Disconnected). Drives `useSpireStore.ddilMode`; the API interceptor
 *    (registered in `main.tsx`) applies latency / loss / cache effects to
 *    every fetch in this tab too, since JLTC lives inside the same React
 *    app.
 *  - Auto-refresh: 30s default, 60s on LIMITED, suspended on DISCONNECTED
 *    (the page renders the last-good cache instead of hammering an
 *    unreachable backend).
 *  - "What's hot now" rollup (worst alert / worst MC unit / C3-C4 count /
 *    active alert count) so a Marine glancing for ≤5 seconds gets ground
 *    truth without scrolling.
 *  - Stale stripe when DISCONNECTED with the last-good pull T-N seconds
 *    so the operator can never confuse cached data for live truth.
 *  - Legibility pass for projection at 30 ft (banner ≥18px bold; field
 *    values and table cells ≥14px).
 *  - ErrorPanel: corrects the misleading "sign in as Security Manager"
 *    hint (any SECRET-cleared operator can pull) and surfaces a "Sign in
 *    to SPIRE" link specifically on 401.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type JointOmsUciExport } from "../api";
import { ClassificationBannerStrip } from "../components/ClassificationBannerStrip";
import { useSpireStore, type DdilMode } from "../state/store";

interface State {
  loading: boolean;
  data: JointOmsUciExport | null;
  error: string | null;
  errorStatus: number | null;
  pulledAt: number | null;
  // Wall-clock at which the data currently in `data` was actually
  // produced by the backend (server-truth). Pinned at the *original*
  // pull moment, never overwritten by a cached pull, so the "Last good
  // pull" stripe stays honest across DISCONNECTED transitions.
  lastGoodPullAt: number | null;
}

const REFRESH_HINT = "Re-pull from SPIRE";

// Polling cadence in ms, keyed on DDIL mode. DISCONNECTED is null —
// no point polling an unreachable backend; the page renders cache.
// INTERMITTENT keeps the default cadence — the interceptor's packet-
// loss simulation will skip ~30% of calls anyway, which is the demo
// shape we want to show under flicker.
const POLL_CADENCE_MS: Record<DdilMode, number | null> = {
  CONNECTED: 30_000,
  LIMITED: 60_000,
  INTERMITTENT: 30_000,
  DISCONNECTED: null,
};

export function JointPreviewView() {
  const ddilMode = useSpireStore((s) => s.ddilMode);
  const ddilLastCacheHit = useSpireStore((s) => s.ddilLastCacheHit);
  const [s, setS] = useState<State>({
    loading: true,
    data: null,
    error: null,
    errorStatus: null,
    pulledAt: null,
    lastGoodPullAt: null,
  });
  const inflight = useRef(false);
  // Tick the clock so the relative-time pills ("T-30s", "2 min stale")
  // re-render without each timestamp computation re-firing on every
  // setState. 1Hz is plenty — Marines aren't reading sub-second time.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  async function pull(opts: { quiet?: boolean } = {}) {
    if (inflight.current) return;
    inflight.current = true;
    if (!opts.quiet) {
      setS((prev) => ({ ...prev, loading: true, error: null, errorStatus: null }));
    }
    // Snapshot the cache-hit cursor BEFORE the call so we can detect
    // whether the response we just got was served from the DDIL cache
    // (and therefore should NOT advance lastGoodPullAt).
    const cacheCursorBefore = useSpireStore.getState().ddilLastCacheHit;
    try {
      const data = await api.joint.omsUci();
      const cacheCursorAfter = useSpireStore.getState().ddilLastCacheHit;
      const servedFromCache =
        cacheCursorAfter !== cacheCursorBefore && cacheCursorAfter !== null;
      const pulledAtMs = Date.now();
      setS(() => ({
        loading: false,
        data,
        error: null,
        errorStatus: null,
        pulledAt: pulledAtMs,
        // If served from the local DDIL cache (DISCONNECTED branch), the
        // "last good pull" is the cache's cachedAt — the moment the
        // backend last produced this body. Otherwise it's now.
        lastGoodPullAt: servedFromCache
          ? cacheCursorAfter!.cachedAt
          : pulledAtMs,
      }));
    } catch (e) {
      const status = e instanceof ApiError ? e.status : null;
      const msg =
        e instanceof ApiError && e.body && typeof e.body === "object"
          ? ((e.body as { detail?: { error?: string } }).detail || {}).error || e.message
          : (e as Error).message || "fetch failed";
      setS((prev) => ({
        ...prev,
        loading: false,
        error: String(msg),
        errorStatus: status,
      }));
    } finally {
      inflight.current = false;
    }
  }

  // Initial pull on mount.
  useEffect(() => {
    void pull();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh polling. Cadence is comms-state-aware. DISCONNECTED
  // suspends the interval entirely; transitioning out of DISCONNECTED
  // fires an immediate pull so the operator sees fresh data the moment
  // the link comes back, not 30 seconds later.
  const prevModeRef = useRef<DdilMode>(ddilMode);
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = ddilMode;
    // Reconnection edge — pull immediately.
    if (prev === "DISCONNECTED" && ddilMode !== "DISCONNECTED") {
      void pull({ quiet: true });
    }
    const cadence = POLL_CADENCE_MS[ddilMode];
    if (cadence == null) return;
    const id = window.setInterval(() => {
      void pull({ quiet: true });
    }, cadence);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ddilMode]);

  // Compute "what's hot now" off the live data.
  const hot = useMemo(() => computeHotline(s.data), [s.data]);

  // Staleness math for the DISCONNECTED stripe and the Pulled pill.
  const isDisconnected = ddilMode === "DISCONNECTED";
  const lastGoodAgeSec = s.lastGoodPullAt != null ? Math.max(0, Math.floor((nowMs - s.lastGoodPullAt) / 1000)) : null;
  const pulledAgoSec = s.pulledAt != null ? Math.max(0, Math.floor((nowMs - s.pulledAt) / 1000)) : null;
  const publishedAgoSec = s.data?.envelope.publishedAtUtc
    ? (() => {
        const t = Date.parse(s.data.envelope.publishedAtUtc);
        return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / 1000)) : null;
      })()
    : null;

  // Layout: outer column flex pins the canonical CAPCO classification
  // strips to the very top and bottom of the viewport (DoDM 5200.01-V2
  // page-level marking, task #151). The Navy partner chrome — its own
  // SECRET/REL header, JLTC topbar, hotline strip, body and operator
  // footer — lives inside the flex-1 middle pane that scrolls. The
  // strip is the canonical green CAPCO block (UNCLASSIFIED // DEMO DATA
  // // NOT FOR OPERATIONAL USE) regardless of the Navy palette below;
  // classification marking is service-agnostic and must be visible in
  // the first frame on a 30-ft projector. No FPCON badge: the partner
  // shell has no SPIRE session state to surface.
  return (
    <div
      className="flex h-screen w-full flex-col"
      style={{
        background: "#0d1620",
        color: "#cfdbe4",
        fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
      }}
    >
      <ClassificationBannerStrip position="top" />
      <div
        className="flex flex-1 flex-col overflow-y-auto"
        style={{
          background: "#0d1620",
          color: "#cfdbe4",
          fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
        }}
      >
        <JointBanner
          classification={s.data?.envelope.classification.marking ?? "SECRET"}
          releasability={s.data?.envelope.classification.releasability ?? "REL TO USA, FVEY"}
        />
        {isDisconnected && (
          <StaleStripe lastGoodAgeSec={lastGoodAgeSec} cachedAt={ddilLastCacheHit?.cachedAt ?? s.lastGoodPullAt ?? null} />
        )}
        <JointTopBar
          publishedAgoSec={publishedAgoSec}
          pulledAgoSec={pulledAgoSec}
          loading={s.loading}
          onPull={() => void pull()}
          ddilMode={ddilMode}
        />
        <HotlineStrip hot={hot} ddilMode={ddilMode} />
        <main style={{ padding: "16px 24px 24px", maxWidth: 1600, margin: "0 auto", width: "100%" }}>
          {s.error ? (
            <ErrorPanel message={s.error} status={s.errorStatus} />
          ) : s.loading && !s.data ? (
            <LoadingPanel />
          ) : s.data ? (
            <Console data={s.data} />
          ) : null}
        </main>
        <JointFooter operator={s.data?.envelope.operator ?? null} subscription={s.data?.envelope.subscriptionModel ?? null} />
      </div>
      <ClassificationBannerStrip position="bottom" />
    </div>
  );
}

function JointBanner({ classification, releasability }: { classification: string; releasability: string }) {
  // CAPCO-style banner. SECRET/REL is amber-on-red; SPIRE uses red but the
  // partner shell uses the slightly darker DoD CAPCO red so the banner
  // reads as "this is the partner's marking system, not SPIRE's."
  //
  // Task #79 legibility: bumped from 12px to 18px bold so a judge 30 ft
  // from the projector can read the marking before they read anything else.
  const color = classification.includes("TS") ? "#ff7a00" : classification.includes("SECRET") ? "#d11616" : "#0066cc";
  return (
    <div
      role="banner"
      style={{
        background: color,
        color: "white",
        textAlign: "center",
        padding: "8px 12px",
        fontFamily: "'IBM Plex Mono', monospace",
        fontWeight: 800,
        fontSize: 18,
        letterSpacing: "0.18em",
      }}
    >
      {classification} // {releasability}
    </div>
  );
}

function StaleStripe({ lastGoodAgeSec, cachedAt }: { lastGoodAgeSec: number | null; cachedAt: number | null }) {
  // The honest-broker stripe: when the operator is in DISCONNECTED, the
  // page renders the last successful pull from the DDIL cache. That data
  // is by definition stale; this stripe makes the staleness loud so a
  // Marine never confuses cached numbers for live truth.
  const ageLabel = lastGoodAgeSec == null ? "—" : formatStale(lastGoodAgeSec);
  const cachedClock = cachedAt
    ? new Date(cachedAt).toISOString().replace("T", " ").slice(0, 19) + "Z"
    : "—";
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        background: "#3a1414",
        color: "#ffd7d2",
        textAlign: "center",
        padding: "6px 12px",
        fontFamily: "'IBM Plex Mono', monospace",
        fontWeight: 700,
        fontSize: 14,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        borderTop: "1px solid #6e2222",
        borderBottom: "1px solid #6e2222",
      }}
    >
      STALE — DISCONNECTED · last good pull T-{ageLabel} · cache {cachedClock}
    </div>
  );
}

function HotlineStrip({ hot, ddilMode }: { hot: Hotline; ddilMode: DdilMode }) {
  // Fixed strip between the JLTC topbar and the body. A Marine with 12
  // seconds and a yellow SATCOM should be able to read this row alone
  // and walk away with: worst alert, worst MC unit, C3/C4 count, active
  // alert count. Each cell is sized for 30-ft projection legibility.
  return (
    <section
      aria-label="What's hot now"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 5,
        display: "grid",
        gridTemplateColumns: "minmax(0, 2.4fr) minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr)",
        gap: 12,
        padding: "12px 24px",
        background: "linear-gradient(180deg, #0f1822 0%, #0a131c 100%)",
        borderBottom: "1px solid #1f2c39",
        boxShadow: "0 4px 12px -6px rgba(0,0,0,0.6)",
      }}
    >
      <HotCell
        label="Worst alert"
        accent={severityAccent(hot.worstAlert?.severity)}
        primary={
          hot.worstAlert
            ? `${hot.worstAlert.severity} · ${hot.worstAlert.entity}`
            : ddilMode === "DISCONNECTED"
            ? "no joint-relevant alerts in cache"
            : "no joint-relevant alerts"
        }
        secondary={hot.worstAlert?.summary ?? ""}
      />
      <HotCell
        label="Worst MC unit"
        accent={mcRateAccent(hot.worstMc?.rate)}
        primary={
          hot.worstMc
            ? `${hot.worstMc.entity} · ${(hot.worstMc.rate * 100).toFixed(0)}% MC`
            : "no logistics data"
        }
        secondary={hot.worstMc?.category ?? ""}
      />
      <HotCell
        label="C3 / C4 units"
        accent={hot.degradedCount > 0 ? "#ff9b95" : "#7be39c"}
        primary={String(hot.degradedCount)}
        secondary={hot.degradedCount > 0 ? "non-mission-capable readiness" : "all ground units C1/C2"}
      />
      <HotCell
        label="Active alerts"
        accent={hot.alertCount > 0 ? "#f0c682" : "#7be39c"}
        primary={String(hot.alertCount)}
        secondary={hot.alertCount > 0 ? "joint-relevant in window" : "window clear"}
      />
    </section>
  );
}

function HotCell({
  label,
  primary,
  secondary,
  accent,
}: {
  label: string;
  primary: string;
  secondary: string;
  accent: string;
}) {
  return (
    <div
      style={{
        background: "#101a26",
        border: "1px solid #1f2c39",
        borderLeft: `3px solid ${accent}`,
        padding: "8px 12px",
        borderRadius: 2,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 10,
          letterSpacing: "0.18em",
          color: "#7e94a8",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 18,
          fontWeight: 700,
          color: "#e6eef5",
          marginTop: 2,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        title={primary}
      >
        {primary}
      </div>
      {secondary && (
        <div
          style={{
            fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
            fontSize: 13,
            color: "#9eb1c2",
            marginTop: 2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={secondary}
        >
          {secondary}
        </div>
      )}
    </div>
  );
}

interface Hotline {
  worstAlert: { severity: string; entity: string; summary: string } | null;
  worstMc: { entity: string; rate: number; category: string } | null;
  degradedCount: number;
  alertCount: number;
}

function computeHotline(data: JointOmsUciExport | null): Hotline {
  if (!data) {
    return { worstAlert: null, worstMc: null, degradedCount: 0, alertCount: 0 };
  }
  const alerts = data.messages.AlertNotification || [];
  const sevOrder = (s: string) =>
    s === "CRITICAL" ? 4 : s === "HIGH" ? 3 : s === "MODERATE" ? 2 : s === "INFO" ? 1 : 0;
  const sortedAlerts = [...alerts].sort((a: any, b: any) => sevOrder(b.severity) - sevOrder(a.severity));
  const worstA = sortedAlerts[0];
  const worstAlert = worstA
    ? {
        severity: String(worstA.severity || "—"),
        entity: String(worstA.EntityIdentifierRef || "—"),
        summary: String(worstA.summary || ""),
      }
    : null;

  const logs = data.messages.LogisticsStatus || [];
  const sortedLogs = [...logs]
    .filter((l: any) => typeof l.missionCapableRate === "number")
    .sort((a: any, b: any) => (a.missionCapableRate ?? 1) - (b.missionCapableRate ?? 1));
  const worstL = sortedLogs[0];
  const worstMc = worstL
    ? {
        entity: String(worstL.EntityIdentifierRef || "—"),
        rate: Number(worstL.missionCapableRate ?? 0),
        category: String(worstL.logisticsCategory || ""),
      }
    : null;

  const entities = data.messages.EntityState || [];
  const degradedCount = entities.filter(
    (e: any) => e.ReadinessRating === "C3" || e.ReadinessRating === "C4",
  ).length;

  return {
    worstAlert,
    worstMc,
    degradedCount,
    alertCount: alerts.length,
  };
}

function severityAccent(sev: string | undefined): string {
  if (!sev) return "#2d6cb6";
  if (sev === "CRITICAL" || sev === "HIGH") return "#ff9b95";
  if (sev === "MODERATE") return "#f0c682";
  return "#9ec3df";
}

function mcRateAccent(rate: number | undefined): string {
  if (rate == null) return "#2d6cb6";
  if (rate < 0.55) return "#ff9b95";
  if (rate < 0.70) return "#f0c682";
  if (rate < 0.85) return "#cfe87a";
  return "#7be39c";
}

function formatStale(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60 ? ` ${sec % 60}s` : ""}`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60 ? ` ${min % 60}m` : ""}`;
}

function JointTopBar({
  publishedAgoSec,
  pulledAgoSec,
  loading,
  onPull,
  ddilMode,
}: {
  publishedAgoSec: number | null;
  pulledAgoSec: number | null;
  loading: boolean;
  onPull: () => void;
  ddilMode: DdilMode;
}) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 14,
        padding: "10px 24px",
        borderBottom: "1px solid #1f2c39",
        background: "linear-gradient(180deg, #15202d 0%, #0f1822 100%)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
        <Anchor />
        <div style={{ lineHeight: 1.1 }}>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, letterSpacing: "0.18em", fontSize: 14, color: "#e6eef5" }}>
            JLTC · JOINT LOGISTICS &amp; TRACKS CONSOLE
          </div>
          <div style={{ fontSize: 11, color: "#7e94a8", letterSpacing: "0.12em", textTransform: "uppercase", marginTop: 2 }}>
            Sister-service viewer · OMS/UCI subscriber
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, flexWrap: "wrap", justifyContent: "flex-end" }}>
        <Pill label="Source" value="SPIRE · USMC" />
        <Pill label="Standard" value="OMS 2.4 / UCI 5.0" />
        <Pill label="Published" value={publishedAgoSec == null ? "—" : `T-${formatStale(publishedAgoSec)}`} />
        <Pill label="Pulled" value={pulledAgoSec == null ? "—" : `T-${formatStale(pulledAgoSec)}`} />
        <JltcCommsControl mode={ddilMode} />
        <button
          type="button"
          onClick={onPull}
          disabled={loading}
          aria-label={REFRESH_HINT}
          style={{
            background: loading ? "#1f3a5a" : "#1d4f8a",
            color: "white",
            border: "1px solid #2d6cb6",
            padding: "6px 12px",
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 11,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            cursor: loading ? "wait" : "pointer",
            borderRadius: 2,
          }}
        >
          {loading ? "Pulling…" : REFRESH_HINT}
        </button>
      </div>
    </header>
  );
}

// JLTC-themed comms-state switcher. Reads/writes the SPIRE store's
// `ddilMode` directly — same source of truth the SPIRE TopBar's
// CommsControl writes to. We reuse the store rather than the SPIRE-
// shell control because (a) JLTC is mounted outside the App shell so
// it can't render TopBar's Tailwind-themed CommsControl without
// looking out of place, and (b) the JLTC operator only needs the
// mode toggle, not the queue tray + drill button (this view is
// read-only — there are no writes to queue from here).
function JltcCommsControl({ mode }: { mode: DdilMode }) {
  const setDdilMode = useSpireStore((s) => s.setDdilMode);
  const MODES: { mode: DdilMode; short: string; tone: string; label: string }[] = [
    { mode: "CONNECTED", short: "CONN", tone: "#7be39c", label: "Connected · 30s polling" },
    { mode: "LIMITED", short: "LIM", tone: "#f0c682", label: "Limited · 60s polling, 800–2000ms latency" },
    { mode: "INTERMITTENT", short: "INT", tone: "#f0c682", label: "Intermittent · 30s polling, ~30% packet loss" },
    { mode: "DISCONNECTED", short: "DISC", tone: "#ff9b95", label: "Disconnected · cached read, polling suspended" },
  ];
  return (
    <div
      role="group"
      aria-label="SPIRE comms state"
      style={{
        display: "inline-flex",
        alignItems: "stretch",
        background: "#0a131c",
        border: "1px solid #1f2c39",
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      <span
        style={{
          padding: "6px 8px",
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 9,
          letterSpacing: "0.16em",
          color: "#7e94a8",
          textTransform: "uppercase",
          alignSelf: "center",
          borderRight: "1px solid #1f2c39",
        }}
      >
        Comms
      </span>
      {MODES.map((m) => {
        const active = m.mode === mode;
        return (
          <button
            key={m.mode}
            type="button"
            onClick={() => setDdilMode(m.mode)}
            title={m.label}
            aria-pressed={active}
            style={{
              padding: "6px 10px",
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 11,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              fontWeight: active ? 700 : 500,
              border: "none",
              borderRight: "1px solid #1f2c39",
              background: active ? `color-mix(in oklab, ${m.tone} 22%, transparent)` : "transparent",
              color: active ? m.tone : "#7e94a8",
              cursor: "pointer",
            }}
          >
            {m.short}
          </button>
        );
      })}
    </div>
  );
}

function Anchor() {
  // Navy fouled-anchor stand-in. Generic enough to read as "Joint" rather
  // than any specific service; we don't want to imply DoN endorsement.
  return (
    <svg width="32" height="36" viewBox="0 0 32 36" aria-hidden>
      <defs>
        <linearGradient id="anchor-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#9ec3df" />
          <stop offset="100%" stopColor="#3d6a8e" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="6" r="3" fill="none" stroke="url(#anchor-fill)" strokeWidth="1.6" />
      <line x1="16" y1="9" x2="16" y2="30" stroke="url(#anchor-fill)" strokeWidth="1.6" />
      <line x1="10" y1="14" x2="22" y2="14" stroke="url(#anchor-fill)" strokeWidth="1.6" />
      <path d="M5 26 Q16 36 27 26" fill="none" stroke="url(#anchor-fill)" strokeWidth="1.6" />
      <line x1="5" y1="26" x2="3" y2="22" stroke="url(#anchor-fill)" strokeWidth="1.6" />
      <line x1="27" y1="26" x2="29" y2="22" stroke="url(#anchor-fill)" strokeWidth="1.6" />
    </svg>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        flexDirection: "column",
        padding: "4px 10px",
        background: "#0a131c",
        border: "1px solid #1f2c39",
        color: "#cfdbe4",
        textTransform: "uppercase",
        letterSpacing: "0.12em",
        lineHeight: 1.15,
        borderRadius: 2,
        minWidth: 88,
      }}
    >
      <span style={{ fontSize: 9, color: "#7e94a8" }}>{label}</span>
      <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{value || "—"}</span>
    </span>
  );
}

function ErrorPanel({ message, status }: { message: string; status: number | null }) {
  // Task #79 P1-5 / P0-4 fix: the previous hint told Reyes (g4 SECRET)
  // and Kowalski (maint chief SECRET) to "sign in as a Security Manager
  // or MEF Commander," which is wrong — any SECRET-cleared operator can
  // pull the OMS/UCI bundle. The 401 case is a separate problem (no
  // session at all) and gets its own actionable link back to /auth.
  const is401 = status === 401;
  const looksLikeAuth = is401 || /unauthen|not authenticated|401/i.test(message);
  const looksLikeClearance = /insufficientclearance|clearance/i.test(message);
  return (
    <div
      style={{
        marginTop: 20,
        background: "#3a1414",
        border: "1px solid #6e2222",
        padding: 18,
        color: "#ffd7d2",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 14,
        borderRadius: 2,
      }}
      role="alert"
    >
      <div style={{ fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", marginBottom: 8, fontSize: 14 }}>
        Subscription failed
      </div>
      <div style={{ marginBottom: 10, fontSize: 14 }}>{message}</div>
      {looksLikeAuth ? (
        <div style={{ color: "#ffd7d2", fontSize: 13, lineHeight: 1.5 }}>
          No SPIRE session on this browser. Sign in to SPIRE in another tab, then re-pull.
          {" "}
          <a
            href="#/auth"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: "#ffe9b3",
              textDecoration: "underline",
              fontWeight: 700,
            }}
          >
            Sign in to SPIRE →
          </a>
        </div>
      ) : looksLikeClearance ? (
        <div style={{ color: "#ffd7d2", fontSize: 13, lineHeight: 1.5 }}>
          The signed-in operator does not hold the clearance to release a SECRET//REL bundle to
          a partner. Any SECRET-cleared SPIRE operator (G-4, Maintenance Chief, MEF Commander,
          Security Manager) can pull — sign in as one and re-try.
        </div>
      ) : (
        <div style={{ color: "#ffd7d2", fontSize: 13, lineHeight: 1.5 }}>
          The OMS/UCI subscription endpoint did not return a payload. Check the SPIRE backend or
          the comms-state switch above; if SPIRE is up and the operator holds SECRET, re-pull.
        </div>
      )}
    </div>
  );
}

function LoadingPanel() {
  return (
    <div
      style={{
        marginTop: 20,
        padding: 30,
        textAlign: "center",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 14,
        letterSpacing: "0.14em",
        color: "#7e94a8",
        textTransform: "uppercase",
      }}
    >
      Subscribing to SPIRE OMS/UCI feed…
    </div>
  );
}

function Console({ data }: { data: JointOmsUciExport }) {
  const env = data.envelope;
  const counts = env.messageCounts;
  return (
    <>
      <section style={cardSection}>
        <SectionHeader title="Subscription envelope" subtitle="OMS UCIMessage header" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12 }}>
          <Field label="Source system" value={`${env.sourceSystem} ${env.sourceSystemVersion}`} />
          <Field label="Source service" value={env.sourceService} />
          <Field label="Source unit" value={env.sourceUnit} />
          <Field label="Originator country" value={env.classification.originatorCountry ?? "USA"} />
          <Field label="Specification" value={env.specification} />
          <Field label="Spec version" value={env.specificationVersion} />
          <Field label="Marking" value={env.classification.marking} />
          <Field label="Releasability" value={env.classification.releasability} />
        </div>
        <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {Object.entries(counts).map(([k, v]) => (
            <CountChip key={k} label={k} count={v} />
          ))}
        </div>
      </section>

      <section style={cardSection}>
        <SectionHeader title="Entity state · ground units" subtitle={`${data.messages.EntityState.length} EntityState messages`} />
        <Table
          columns={["Callsign", "UIC", "SIDC", "Lat", "Lon", "Readiness", "Operational", "As-of"]}
          rows={data.messages.EntityState.map((e: any) => [
            e.EntityIdentifier?.callsign ?? "—",
            e.EntityIdentifier?.uic ?? "—",
            e.EntityType?.sidc ?? "—",
            num(e.Position?.latitude, 4),
            num(e.Position?.longitude, 4),
            <ReadinessChip key="r" code={e.ReadinessRating} />,
            e.OperationalStatus,
            short(e.asOfTime),
          ])}
        />
      </section>

      <section style={cardSection}>
        <SectionHeader title="Track data" subtitle={`${data.messages.TrackData.length} TrackData messages`} />
        <Table
          columns={["Track #", "Origin", "Quality (0..15)", "Lat", "Lon", "Stationary", "Entity ref"]}
          rows={data.messages.TrackData.map((t: any) => [
            t.trackNumber,
            t.trackOrigin,
            t.trackQuality,
            num(t.Position?.latitude, 4),
            num(t.Position?.longitude, 4),
            t.Kinematic?.stationary ? "yes" : "no",
            t.EntityIdentifierRef,
          ])}
        />
      </section>

      <section style={cardSection}>
        <SectionHeader title="Logistics status" subtitle={`${data.messages.LogisticsStatus.length} LogisticsStatus messages`} />
        <Table
          columns={["Entity ref", "Category", "MC rate", "Items (top)", "As-of"]}
          rows={data.messages.LogisticsStatus.map((l: any) => [
            l.EntityIdentifierRef,
            l.logisticsCategory,
            <ReadinessBar key="r" rate={l.missionCapableRate ?? 0} />,
            <ItemList key="i" items={(l.items || []).slice(0, 3)} />,
            short(l.asOfTime),
          ])}
        />
      </section>

      <section style={cardSection}>
        <SectionHeader title="Alert notifications" subtitle={`${data.messages.AlertNotification.length} AlertNotification messages`} />
        {data.messages.AlertNotification.length === 0 ? (
          <Empty text="No active joint-relevant alerts in this window." />
        ) : (
          <Table
            columns={["Severity", "Category", "Entity ref", "Summary", "As-of"]}
            rows={data.messages.AlertNotification.map((a: any) => [
              <SeverityChip key="s" sev={a.severity} />,
              a.alertCategory,
              a.EntityIdentifierRef,
              a.summary,
              short(a.asOfTime),
            ])}
          />
        )}
      </section>
    </>
  );
}

const cardSection: React.CSSProperties = {
  background: "#101a26",
  border: "1px solid #1f2c39",
  borderRadius: 2,
  padding: "14px 18px 18px",
  marginTop: 16,
};

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12, borderBottom: "1px solid #1f2c39", paddingBottom: 6 }}>
      <h2 style={{ margin: 0, fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, letterSpacing: "0.18em", textTransform: "uppercase", color: "#e6eef5" }}>{title}</h2>
      {subtitle && <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, letterSpacing: "0.12em", color: "#7e94a8", textTransform: "uppercase" }}>{subtitle}</span>}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | number }) {
  // Task #79 legibility: field value bumped from 12px to 14px so the
  // envelope header reads from across the room.
  return (
    <div style={{ background: "#0a131c", border: "1px solid #1f2c39", padding: "8px 10px", borderRadius: 2 }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: "0.16em", color: "#7e94a8", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, marginTop: 3, color: "#e6eef5" }}>{value}</div>
    </div>
  );
}

function CountChip({ label, count }: { label: string; count: number }) {
  return (
    <span
      style={{
        display: "inline-flex",
        gap: 8,
        padding: "4px 10px",
        background: "#162335",
        border: "1px solid #2d6cb6",
        color: "#9ec3df",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 13,
        letterSpacing: "0.12em",
        borderRadius: 2,
      }}
    >
      <span style={{ textTransform: "uppercase" }}>{label}</span>
      <span style={{ color: "#e6eef5", fontWeight: 600 }}>{count}</span>
    </span>
  );
}

function Table({ columns, rows }: { columns: string[]; rows: React.ReactNode[][] }) {
  // Task #79 legibility: table cells bumped from 11px to 14px so a
  // judge 30 ft away can read the EntityIdentifierRef / readiness /
  // MC-rate columns without binoculars.
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'IBM Plex Mono', monospace", fontSize: 14 }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  borderBottom: "1px solid #1f2c39",
                  color: "#7e94a8",
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  fontWeight: 500,
                  fontSize: 11,
                }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ background: i % 2 ? "#0d1620" : "transparent" }}>
              {r.map((cell, j) => (
                <td key={j} style={{ padding: "8px 10px", borderBottom: "1px solid #15212e", color: "#cfdbe4", verticalAlign: "middle" }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReadinessChip({ code }: { code: string }) {
  const tone =
    code === "C1" ? { bg: "#0d3a1f", fg: "#7be39c", border: "#1c7a44" } :
    code === "C2" ? { bg: "#26350f", fg: "#cfe87a", border: "#5b7720" } :
    code === "C3" ? { bg: "#3a2810", fg: "#f0c682", border: "#825a1f" } :
                    { bg: "#3a1414", fg: "#ff9b95", border: "#7a2222" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        background: tone.bg,
        color: tone.fg,
        border: `1px solid ${tone.border}`,
        borderRadius: 2,
        fontWeight: 600,
        letterSpacing: "0.14em",
      }}
    >
      {code}
    </span>
  );
}

function SeverityChip({ sev }: { sev: string }) {
  // Mirrors the backend ALERT_SEVERITY_ENUM in backend/routes/joint.py:
  //   CRITICAL > HIGH > MODERATE > LOW
  // CRITICAL gets its own brighter red so it doesn't read as just another
  // HIGH; LOW gets a deliberate cool-blue tone instead of falling to the
  // neutral catch-all (P1-9 from the joint-cop critique).
  const norm = (sev || "").toUpperCase();
  const tone =
    norm === "CRITICAL" ? { bg: "#4a0a0a", fg: "#ffd5d0", border: "#c43a2f" } :
    norm === "HIGH"     ? { bg: "#3a1414", fg: "#ff9b95", border: "#7a2222" } :
    norm === "MODERATE" ? { bg: "#3a2810", fg: "#f0c682", border: "#825a1f" } :
    norm === "LOW"      ? { bg: "#0c2233", fg: "#9ec3df", border: "#2d6cb6" } :
                          { bg: "#1a232c", fg: "#9caab6", border: "#2c3a48" };
  return (
    <span style={{ display: "inline-block", padding: "2px 8px", background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}`, borderRadius: 2, letterSpacing: "0.12em", fontWeight: 600 }}>
      {sev}
    </span>
  );
}

function ReadinessBar({ rate }: { rate: number }) {
  const pct = Math.max(0, Math.min(1, rate)) * 100;
  const color = rate >= 0.85 ? "#7be39c" : rate >= 0.70 ? "#cfe87a" : rate >= 0.55 ? "#f0c682" : "#ff9b95";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 140 }}>
      <div style={{ flex: 1, height: 8, background: "#0a131c", border: "1px solid #1f2c39", borderRadius: 1 }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color }} />
      </div>
      <span style={{ width: 48, textAlign: "right", color: "#cfdbe4" }}>{pct.toFixed(0)}%</span>
    </div>
  );
}

function ItemList({ items }: { items: any[] }) {
  if (!items.length) return <span style={{ color: "#7e94a8" }}>—</span>;
  return (
    <span>
      {items.map((it: any, i: number) => (
        <span key={i} style={{ display: "inline-block", marginRight: 8 }}>
          {it.nomenclature}: {it.missionCapable}/{it.onHand}
        </span>
      ))}
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ padding: 24, textAlign: "center", color: "#7e94a8", fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase" }}>
      {text}
    </div>
  );
}

function num(n: number | undefined, decimals: number): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return n.toFixed(decimals);
}

function short(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 19) + "Z";
  } catch {
    return iso;
  }
}

function JointFooter({
  operator,
  subscription,
}: {
  operator: import("../api").JointOperatorFooter | null;
  subscription: string | null;
}) {
  // Operator footer surfaces the human at the SPIRE console so the partner
  // J4 can audit who released the bundle. Subscription model is shown so it
  // is unambiguous on the receiving side that this is a topic feed (full
  // MAGTF) rather than a per-operator slice.
  // Task #80 contract: surface the operator's NAME and ROLE explicitly so
  // the partner J4 can audit who released the bundle and the privilege under
  // which it was released. Billet is also shown because it's human-readable
  // ("Security Manager" reads better than "security_manager"), but role is
  // always present — never collapsed to billet.
  const op = operator
    ? `Released by ${operator.rank ? operator.rank + " " : ""}${operator.name}` +
      ` · role: ${operator.role}` +
      (operator.billet ? ` (${operator.billet})` : "") +
      ` · ${operator.unit || "—"}`
    : "Released by unknown operator";
  const sub = subscription || "TOPIC_FULL_MAGTF";
  // Flow-positioned footer: the page-level classification strip now pins
  // to the viewport bottom (task #151), so the operator footer sits in
  // normal flex flow at the end of the scroll pane instead of fixed-
  // overlaying the bottom edge.
  return (
    <footer
      style={{
        marginTop: "auto",
        borderTop: "1px solid #1f2c39",
        background: "#0a131c",
        padding: "6px 24px",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
        color: "#7e94a8",
        letterSpacing: "0.14em",
        textTransform: "uppercase",
      }}
    >
      <span>JLTC v0.1 · Sister-service viewer · Read-only OMS/UCI subscriber</span>
      <span style={{ color: "#9ec3df" }}>{op} · subscription: {sub}</span>
      <span>SPIRE → JLTC bridge: export-only (no ingest, no engagement orders)</span>
    </footer>
  );
}
