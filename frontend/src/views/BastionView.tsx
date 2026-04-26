import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { api, type BastionAlert, type BastionCOP, type ThermalHawkSim } from "../api";
import { withRetry, pollWithBackoff } from "../api-retry";
import { useSpireStore } from "../state/store";
import { MapCanvas } from "../components/MapCanvas";
import { FusedThreatsPanel } from "../components/FusedThreatsPanel";
import { CollapsiblePanel } from "../components/CollapsiblePanel";

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: "#ef4444",
  HIGH: "#f87171",
  MODERATE: "#f59e0b",
  LOW: "#22c55e",
  INFO: "#3b82f6",
};

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
  const [cop, setCop] = useState<BastionCOP | null>(null);
  const [alerts, setAlerts] = useState<BastionAlert[]>([]);
  const [selectedAlert, setSelectedAlert] = useState<BastionAlert | null>(null);
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null);
  const [sim, setSim] = useState<ThermalHawkSim | null>(null);
  const [nlText, setNlText] = useState("");
  const [nlResult, setNlResult] = useState<any | null>(null);
  const [nlSubmitting, setNlSubmitting] = useState(false);
  const [copError, setCopError] = useState<string | null>(null);
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

  async function refreshAlerts() {
    try {
      const r = await withRetry(() => api.bastion.alerts(40));
      setAlerts(r.alerts);
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
        onResult: (r) => setAlerts(r.alerts),
        onError: (e) => console.warn("BASTION alert refresh failed:", e),
      },
    );
    return () => ctrl.stop();
  }, []);

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

  async function triggerThermalHawk() {
    const s = await api.bastion.simulateThermalHawk("CLB-6");
    setSim(s);
    setSelectedAlert(s.alert);
    setSelectedUnit("CLB-6");
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
  }

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

  async function handleNL() {
    if (!nlText.trim() || nlSubmitting) return;
    setNlSubmitting(true);
    setNlResult(null);
    try {
      const r = await api.bastion.nlQuery(nlText);
      setNlResult(r);
    } catch (e) {
      pushToast({
        tone: "error",
        text: `Natural-language query failed — ${String(e).slice(0, 90)}`,
        ttlMs: 5000,
      });
    } finally {
      setNlSubmitting(false);
    }
  }

  function onUnitClick(unitName: string) {
    setSelectedUnit(unitName);
    // Promote the most relevant alert for that unit, if any
    const unitAlerts = alerts.filter((a) => a.unit === unitName);
    if (unitAlerts.length > 0) setSelectedAlert(unitAlerts[0]);
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
        <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <h3
            className="font-mono text-xs font-semibold uppercase text-[var(--color-text)] tracking-widest"
          >
            Alert Stream
          </h3>
          <span
            className="rounded-sm border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-xs tabular-nums text-[var(--color-text-muted)] tracking-wide"
          >
            {alerts.length}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {/* Track-G2 — Fused threats live at the top of the alert sidebar.
           * Security Manager wants them on cold (it's their job to triage
           * cross-sensor correlations). MEF Commander wants the alert wall
           * not to be visually pre-empted by a CRITICAL fused-threat block
           * before they've had a chance to scan the room. Collapse for
           * MEF Commander; expand for Security Manager. */}
          <div className="mb-2">
            <CollapsiblePanel
              view="bastion"
              panel="fused"
              defaultCollapsedFor={{ mef_commander: true, security_manager: false }}
              header={
                <span
                  className="font-mono uppercase text-[var(--color-danger)]"
                  style={{ fontSize: "var(--text-xs)", letterSpacing: "var(--tracking-widest)" }}
                >
                  ◆ Fused Threats · GC-4
                </span>
              }
              collapsedSummary={
                <span>
                  Cross-sensor correlations. Click ▾ to expand.
                </span>
              }
            >
              <FusedThreatsPanel />
            </CollapsiblePanel>
          </div>
          {dedupeAlerts(alerts).map((a) => (
            <AlertRow
              key={a.id}
              alert={a}
              groupCount={a._groupCount}
              justArrived={recentAlertIds.has(a.id)}
              selected={selectedAlert?.id === a.id}
              onClick={() => {
                setSelectedAlert(a);
                if (a.unit) setSelectedUnit(a.unit);
              }}
            />
          ))}
        </div>
        <div className="border-t border-[var(--color-border)] p-3">
          <button
            onClick={triggerThermalHawk}
            className="w-full rounded-sm border border-[var(--color-danger)] bg-[color-mix(in_oklab,var(--color-danger-muted)_40%,var(--color-surface))] px-3 py-2 font-mono text-sm font-semibold uppercase text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)] hover:text-white tracking-wider"
          >
            ⚠ Simulate ThermalHawk
          </button>
          <div className="mt-1.5 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            UAS event over CLB-6 motor pool. Auto-correlates with PULSE readiness.
          </div>
        </div>
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
        />

        {/* Installation title badge — top-left */}
        <div
          className="pointer-events-none absolute left-3 top-3 z-[6] rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] px-3 py-2 backdrop-blur"
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
            className="mt-0.5 font-mono text-xs text-[var(--color-text-secondary)] tracking-wider"
          >
            {cop.buildings_count} buildings · {cop.ecps.length} ECPs · {cop.response_forces_count} RF · FPCON BRAVO
            {cop.installation.fictional && (
              <span className="ml-2 text-[var(--color-warning)]">// SYNTHETIC DATA</span>
            )}
          </div>
        </div>

        {/* Mission HUD — top-right */}
        <MissionHUD />

        {/* Track-G1 — G-4 command summary card. Three columns of "what
         * matters in the next 30 seconds": MC% per scoped unit, top alerts,
         * top fused threats. Renders only for the G-4 role and only when no
         * alert is selected (so it doesn't fight with the response panel). */}
        {role === "g4" && !selectedAlert && (
          <G4CommandSummary alerts={alerts} onAlertClick={(a) => setSelectedAlert(a)} />
        )}

        {/* NL query bar — bottom-centered so it doesn't fight with the title */}
        <div className="absolute inset-x-0 bottom-3 z-[7] flex justify-center px-3">
          <div
            className="w-full max-w-2xl rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] p-2 shadow-lg backdrop-blur"
          >
            <div className="flex items-center gap-2">
              <span
                className="pl-1.5 pr-0.5 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
              >
                ASK·BASTION
              </span>
              <input
                value={nlText}
                onChange={(e) => setNlText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleNL()}
                placeholder='e.g. "Submit TMR Lejeune to Geiger 5 MTVRs Wednesday urgent"'
                className="flex-1 bg-transparent text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
              />
              <button
                onClick={handleNL}
                disabled={nlSubmitting || !nlText.trim()}
                className="inline-flex h-11 min-w-[44px] items-center rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-4 font-mono text-sm font-semibold uppercase text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50 tracking-wider"
              >
                {nlSubmitting ? "Working …" : "Submit"}
              </button>
            </div>
            {nlResult && <NLResultPanel result={nlResult} onClose={() => setNlResult(null)} />}
          </div>
        </div>
      </div>

      {/* Right sidebar: response panel */}
      {selectedAlert && (
        <ResponsePanel
          alert={selectedAlert}
          sim={sim}
          onClose={() => {
            setSelectedAlert(null);
          }}
          onResolveSim={() => {
            setSim(null);
            // The FPCON useEffect listening on `sim` handles de-escalation.
            pushToast({
              tone: "ok",
              text: "Sim resolved · FPCON returning to BRAVO · cordons clearing",
              ttlMs: 3500,
            });
          }}
        />
      )}
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
}: {
  alert: BastionAlert;
  selected: boolean;
  onClick: () => void;
  groupCount?: number;
  justArrived?: boolean;
}) {
  const color = SEVERITY_COLOR[alert.severity] || SEVERITY_COLOR.INFO;
  return (
    <div
      onClick={onClick}
      className={clsx(
        "relative mb-1.5 cursor-pointer overflow-hidden rounded-sm border-l-4 bg-[var(--color-surface)] px-2 py-1.5 transition-colors",
        selected ? "border border-[var(--color-primary)]" : "border-r border-t border-b border-[var(--color-border)]",
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
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
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
          >
            ×{groupCount}
          </span>
        )}
        <span className="ml-auto tabular-nums">
          {new Date(alert.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
        </span>
      </div>
      <div className="mt-0.5 text-base font-medium text-[var(--color-text)]">{alert.title}</div>
      <div className="line-clamp-2 text-xs text-[var(--color-text-secondary)]">{alert.body}</div>
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
    try {
      const key = "spire.bastion.notify_audit";
      const prior = JSON.parse(window.localStorage.getItem(key) || "[]");
      prior.push({
        who,
        alert_id: alert.id,
        at: new Date().toISOString(),
        actor: role,
      });
      window.localStorage.setItem(key, JSON.stringify(prior.slice(-200)));
    } catch {
      /* tolerant — private mode etc */
    }
    pushToast({
      tone: "ok",
      text: `Notification sent · ${who} · audit logged`,
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
            <div className="mt-1 text-xs text-[var(--color-text-muted)]">
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
                      onClick={() => sendNotification(n.who)}
                      disabled={isSent}
                      className="ml-auto rounded border px-2 py-0.5 text-xs transition-colors disabled:cursor-not-allowed"
                      style={{
                        borderColor: isSent ? "var(--color-success)" : "var(--color-primary)",
                        background: isSent
                          ? "color-mix(in oklab, var(--color-success-muted) 30%, transparent)"
                          : "var(--color-surface)",
                        color: isSent ? "var(--color-success)" : "var(--color-primary)",
                      }}
                    >
                      {isSent ? "✓ Sent" : "[Draft Ready] Send"}
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

function NLResultPanel({ result, onClose }: { result: any; onClose: () => void }) {
  if (result.intent === "tmr_submission") {
    const r = result.result;
    return (
      <div className="mt-2 rounded-sm border border-[var(--color-primary)] bg-[var(--color-surface)] p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <div
            className="font-mono text-xs font-semibold uppercase text-[var(--color-primary)] tracking-widest"
          >
            Parsed as TMR
          </div>
          <button onClick={onClose} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            ✕
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <KV label="Origin" value={r.tmr.origin || "—"} />
          <KV label="Destination" value={r.tmr.destination || "—"} />
          <KV label="Equipment" value={(r.tmr.equipment || []).map((e: any) => `${e.quantity} × ${e.type}`).join(", ") || "—"} />
          <KV label="Scheduled" value={r.tmr.scheduled_date || "—"} />
          <KV label="Priority" value={r.tmr.priority} />
          <KV label="Hazmat" value={r.tmr.hazmat ? "Yes" : "No"} />
        </div>
        {r.validation.issues.length > 0 && (
          <div className="mt-2 rounded-sm bg-[var(--color-danger-muted)] p-2 text-sm text-[var(--color-danger)]">
            <strong>Issues:</strong>
            <ul className="ml-4 list-disc">
              {r.validation.issues.map((i: string) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        )}
        {r.validation.warnings.length > 0 && (
          <div className="mt-2 rounded-sm bg-[var(--color-warning-muted)] p-2 text-sm text-[var(--color-warning)]">
            <strong>Warnings:</strong>
            <ul className="ml-4 list-disc">
              {r.validation.warnings.map((w: string) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <div
          className="mt-2 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
        >
          Approval chain
        </div>
        <div className="mt-1 flex items-center gap-1 text-sm">
          {r.approval_chain.map((s: any, i: number) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-[var(--color-text-muted)]">→</span>}
              <span
                title={s.reason}
                className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 font-mono"
              >
                {s.role}
              </span>
            </span>
          ))}
        </div>
        <div className="mt-2 text-xs italic text-[var(--color-text-muted)]">{r.engine}</div>
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text-secondary)]">
      <div className="flex items-baseline justify-between">
        <div
          className="font-mono text-xs font-semibold uppercase text-[var(--color-text-muted)] tracking-widest"
        >
          {result.intent}
        </div>
        <button onClick={onClose} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          ✕
        </button>
      </div>
      <div className="mt-1">{result.result?.note || JSON.stringify(result.result, null, 2)}</div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: any }) {
  return (
    <div>
      <div
        className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-wider"
      >
        {label}
      </div>
      <div className="font-mono text-[var(--color-text)]">{String(value)}</div>
    </div>
  );
}

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
                  {rate == null ? "—" : `${(rate * 100).toFixed(0)}%`}
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
