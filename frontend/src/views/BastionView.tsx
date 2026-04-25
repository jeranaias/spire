import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { api, type BastionAlert, type BastionCOP, type ThermalHawkSim } from "../api";
import { useSpireStore } from "../state/store";
import { InstallationSchematic } from "../components/InstallationSchematic";

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
  "2d Tank Bn":   "TANK-MP",
  "2d LAR Bn":    "LAR-MP",
  "MALS-31":      "HH-1",
  "MWSS-372":     "DL-HQ",
  "2d LAAD Bn":   "LAAD-TOC",
  "5/11 Marines": "TOC-MAIN",
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

  useEffect(() => {
    setCop(null);
    api.bastion.cop().then(setCop);
    refreshAlerts();
  }, [role]);

  async function refreshAlerts() {
    try {
      const r = await api.bastion.alerts(40);
      setAlerts(r.alerts);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    const t = window.setInterval(refreshAlerts, 5000);
    return () => window.clearInterval(t);
  }, []);

  const setFpcon = useSpireStore((s) => s.setFpcon);
  const pushToast = useSpireStore((s) => s.pushToast);
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
    setFpcon("CHARLIE");
    pushToast({
      tone: "warn",
      text: "FPCON elevated to CHARLIE · ThermalHawk UAS incident active",
      ttlMs: 4500,
    });
    // De-escalate automatically after 30s for demo purposes (production would
    // follow the response-force disposition event chain).
    window.setTimeout(() => setFpcon("BRAVO"), 30_000);
    refreshAlerts();
  }

  async function handleNL() {
    if (!nlText.trim()) return;
    const r = await api.bastion.nlQuery(nlText);
    setNlResult(r);
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

  if (!cop) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-secondary)]">
        Loading installation schematic ...
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left sidebar: alert stream */}
      <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <h3
            className="font-mono text-[10px] font-semibold uppercase text-[var(--color-text)]"
            style={{ letterSpacing: "0.18em" }}
          >
            Alert Stream
          </h3>
          <span
            className="rounded-sm border border-[var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[var(--color-text-muted)]"
            style={{ letterSpacing: "0.08em" }}
          >
            {alerts.length}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
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
            className="w-full rounded-sm border border-[var(--color-danger)] bg-[color-mix(in_oklab,var(--color-danger-muted)_40%,var(--color-surface))] px-3 py-2 font-mono text-[11px] font-semibold uppercase text-[var(--color-danger)] transition-colors hover:bg-[var(--color-danger)] hover:text-white"
            style={{ letterSpacing: "0.16em" }}
          >
            ⚠ Simulate ThermalHawk
          </button>
          <div className="mt-1.5 font-mono text-[9px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.1em" }}>
            UAS event over CLB-6 motor pool. Auto-correlates with PULSE readiness.
          </div>
        </div>
      </aside>

      {/* Center: schematic */}
      <div className="relative flex-1">
        <InstallationSchematic
          buildings={cop.buildings}
          units={cop.units}
          ecps={cop.ecps}
          rallyPoints={cop.rally_points}
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
            className="font-mono text-[9px] uppercase text-[var(--color-text-muted)]"
            style={{ letterSpacing: "0.22em" }}
          >
            Common Operating Picture
          </div>
          <div
            className="mt-0.5 font-mono text-sm font-semibold uppercase text-[var(--color-text)]"
            style={{ letterSpacing: "0.14em" }}
          >
            {cop.installation.name}
          </div>
          <div
            className="mt-0.5 font-mono text-[9px] text-[var(--color-text-secondary)]"
            style={{ letterSpacing: "0.1em" }}
          >
            {cop.buildings_count} buildings · {cop.ecps.length} ECPs · {cop.response_forces_count} RF · FPCON BRAVO
            {cop.installation.fictional && (
              <span className="ml-2 text-[var(--color-warning)]">· SYNTHETIC</span>
            )}
          </div>
        </div>

        {/* Mission HUD — top-right */}
        <MissionHUD />

        {/* NL query bar — bottom-centered so it doesn't fight with the title */}
        <div className="absolute inset-x-0 bottom-3 z-[7] flex justify-center px-3">
          <div
            className="w-full max-w-2xl rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] p-2 shadow-lg backdrop-blur"
          >
            <div className="flex items-center gap-2">
              <span
                className="pl-1.5 pr-0.5 font-mono text-[10px] uppercase text-[var(--color-text-muted)]"
                style={{ letterSpacing: "0.18em" }}
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
                className="rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-3 py-1 font-mono text-[11px] font-semibold uppercase text-white hover:bg-[var(--color-primary-hover)]"
                style={{ letterSpacing: "0.14em" }}
              >
                Submit
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
      <div className="flex items-center gap-1 font-mono text-[9px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.1em" }}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
        <span className="font-semibold" style={{ color }}>{alert.severity}</span>
        <span>· {alert.source}</span>
        {groupCount && groupCount > 1 && (
          <span
            className="rounded-sm border px-1 font-semibold tabular-nums"
            style={{
              color,
              borderColor: `color-mix(in oklab, ${color} 40%, var(--color-border))`,
              background: `color-mix(in oklab, ${color} 12%, transparent)`,
              letterSpacing: "0.05em",
            }}
          >
            ×{groupCount}
          </span>
        )}
        <span className="ml-auto tabular-nums">
          {new Date(alert.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
        </span>
      </div>
      <div className="mt-0.5 text-[12px] font-medium text-[var(--color-text)]">{alert.title}</div>
      <div className="line-clamp-2 text-[10px] text-[var(--color-text-secondary)]">{alert.body}</div>
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
        className="font-mono text-[9px] uppercase text-[var(--color-text-muted)]"
        style={{ letterSpacing: "0.18em" }}
      >
        Mission Clock
      </div>
      <div
        className="mt-0.5 font-mono text-[17px] font-semibold tabular-nums text-[var(--color-text)]"
        style={{ letterSpacing: "0.05em", lineHeight: 1 }}
      >
        {zulu}
      </div>
      <div
        className="mt-0.5 font-mono text-[9px] text-[var(--color-text-secondary)]"
        style={{ letterSpacing: "0.14em" }}
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
}: {
  alert: BastionAlert;
  sim: ThermalHawkSim | null;
  onClose: () => void;
}) {
  const role = useSpireStore((s) => s.role);
  const checklist = sim && sim.alert.id === alert.id ? sim.checklist : null;
  const [checked, setChecked] = useState<Record<string, boolean>>({});

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
              className="font-mono text-[10px] font-semibold uppercase"
              style={{ letterSpacing: "0.18em", color: SEVERITY_COLOR[alert.severity] }}
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
            <div className="mt-2 font-mono text-[11px] text-[var(--color-text-muted)]">Grid: {alert.grid}</div>
          )}
        </section>

        {alert.model_info && (
          <section className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
            <div
              className="mb-1 font-mono text-[9px] font-semibold uppercase text-[var(--color-text-muted)]"
              style={{ letterSpacing: "0.18em" }}
            >
              Detection Model
            </div>
            <div className="font-mono text-[var(--color-text)]">{alert.model_info.model}</div>
            <div className="text-[var(--color-text-secondary)]">
              {alert.model_info.parameters.toLocaleString()} parameters · {alert.model_info.architecture}
            </div>
            <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              {alert.model_info.training} · target: {alert.model_info.deployment_target}
            </div>
          </section>
        )}

        {alert.correlated_with && alert.correlated_with.length > 0 && (
          <section>
            <div
              className="mb-1 font-mono text-[9px] font-semibold uppercase text-[var(--color-text-muted)]"
              style={{ letterSpacing: "0.18em" }}
            >
              Auto-correlated with
            </div>
            {alert.correlated_with.map((c, i) => (
              <div key={i} className="rounded-sm border-l-2 border-[var(--color-primary)] bg-[var(--color-bg)] px-2 py-1 text-[11px]">
                <span className="font-mono text-[var(--color-primary)]">{c.source}</span> — {c.note}
              </div>
            ))}
          </section>
        )}

        {checklist && (
          <section>
            <div className="mb-2 text-xs font-semibold">{checklist.title}</div>
            <div
              className="mb-2 font-mono text-[9px] uppercase text-[var(--color-text-muted)]"
              style={{ letterSpacing: "0.18em" }}
            >
              Immediate (0-5 MIN)
            </div>
            <ul className="flex flex-col gap-1.5 text-[11px]">
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
              className="mb-2 mt-3 font-mono text-[9px] uppercase text-[var(--color-text-muted)]"
              style={{ letterSpacing: "0.18em" }}
            >
              Follow-on (5-30 MIN)
            </div>
            <ul className="flex flex-col gap-1.5 text-[11px]">
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
              className="mb-2 mt-3 font-mono text-[9px] uppercase text-[var(--color-text-muted)]"
              style={{ letterSpacing: "0.18em" }}
            >
              Notifications
            </div>
            <ul className="flex flex-col gap-1.5 text-[11px]">
              {checklist.notifications.map((n, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="font-mono text-[var(--color-text)]">{n.who}</span>
                  <button className="ml-auto rounded border border-[var(--color-primary)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] text-[var(--color-primary)] hover:bg-[var(--color-primary)] hover:text-white">
                    [Draft Ready] Send
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {sim && (
          <section>
            <div
              className="mb-1 font-mono text-[9px] font-semibold uppercase text-[var(--color-text-muted)]"
              style={{ letterSpacing: "0.18em" }}
            >
              Response forces dispatched
            </div>
            <div className="flex flex-wrap gap-1">
              {sim.response_forces_dispatched.map((rf) => (
                <span
                  key={rf}
                  className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-text)]"
                >
                  {rf}
                </span>
              ))}
            </div>
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
            className="font-mono text-[9px] font-semibold uppercase text-[var(--color-primary)]"
            style={{ letterSpacing: "0.18em" }}
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
          <div className="mt-2 rounded-sm bg-[var(--color-danger-muted)] p-2 text-[11px] text-[var(--color-danger)]">
            <strong>Issues:</strong>
            <ul className="ml-4 list-disc">
              {r.validation.issues.map((i: string) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        )}
        {r.validation.warnings.length > 0 && (
          <div className="mt-2 rounded-sm bg-[var(--color-warning-muted)] p-2 text-[11px] text-[var(--color-warning)]">
            <strong>Warnings:</strong>
            <ul className="ml-4 list-disc">
              {r.validation.warnings.map((w: string) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <div
          className="mt-2 font-mono text-[9px] uppercase text-[var(--color-text-muted)]"
          style={{ letterSpacing: "0.18em" }}
        >
          Approval chain
        </div>
        <div className="mt-1 flex items-center gap-1 text-[11px]">
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
        <div className="mt-2 text-[10px] italic text-[var(--color-text-muted)]">{r.engine}</div>
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text-secondary)]">
      <div className="flex items-baseline justify-between">
        <div
          className="font-mono text-[9px] font-semibold uppercase text-[var(--color-text-muted)]"
          style={{ letterSpacing: "0.18em" }}
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
        className="font-mono text-[9px] uppercase text-[var(--color-text-muted)]"
        style={{ letterSpacing: "0.16em" }}
      >
        {label}
      </div>
      <div className="font-mono text-[var(--color-text)]">{String(value)}</div>
    </div>
  );
}
