// @ts-nocheck -- react-leaflet 5 type defs for Circle/CircleMarker/Tooltip
// props are broken in our TS config; runtime works correctly.
import { useEffect, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Tooltip as LTooltip, Popup, Circle, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import clsx from "clsx";
import { api, type BastionAlert, type BastionCOP, type IncidentResponse, type ThermalHawkSim } from "../api";
import { useSpireStore } from "../state/store";

// Ensure default Leaflet icons don't throw at import time
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: "#ef4444",
  HIGH: "#f87171",
  MODERATE: "#f59e0b",
  LOW: "#22c55e",
  INFO: "#3b82f6",
};

function colorForMc(rate: number): string {
  if (rate >= 0.90) return "#22c55e";
  if (rate >= 0.75) return "#f59e0b";
  if (rate >= 0.60) return "#fb923c";
  return "#ef4444";
}

export function BastionView() {
  const role = useSpireStore((s) => s.role);
  const [cop, setCop] = useState<BastionCOP | null>(null);
  const [alerts, setAlerts] = useState<BastionAlert[]>([]);
  const [selectedAlert, setSelectedAlert] = useState<BastionAlert | null>(null);
  const [sim, setSim] = useState<ThermalHawkSim | null>(null);
  const [response, setResponse] = useState<IncidentResponse | null>(null);
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

  async function triggerThermalHawk() {
    const s = await api.bastion.simulateThermalHawk("CLB-6");
    setSim(s);
    setSelectedAlert(s.alert);
    refreshAlerts();
  }

  async function handleNL() {
    if (!nlText.trim()) return;
    const r = await api.bastion.nlQuery(nlText);
    setNlResult(r);
  }

  if (!cop) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-secondary)]">Loading COP ...</div>;
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left sidebar: alert stream */}
      <aside className="flex w-80 shrink-0 flex-col overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Alert stream
          </h3>
          <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] tabular-nums text-[var(--color-text-muted)]">
            {alerts.length}
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {alerts.map((a) => (
            <AlertRow key={a.id} alert={a} selected={selectedAlert?.id === a.id} onClick={() => setSelectedAlert(a)} />
          ))}
        </div>
        <div className="border-t border-[var(--color-border)] p-3">
          <button
            onClick={triggerThermalHawk}
            className="w-full rounded border border-[var(--color-danger)] bg-[color-mix(in_oklab,var(--color-danger-muted)_40%,var(--color-surface))] px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white"
          >
            ⚠ Simulate ThermalHawk detection
          </button>
          <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
            Drops a UAS event over CLB-6 motor pool. Auto-correlates with PULSE readiness.
          </div>
        </div>
      </aside>

      {/* Center: map */}
      <div className="relative flex-1">
        <MapContainer
          center={[cop.center.lat, cop.center.lon]}
          zoom={13}
          scrollWheelZoom
          className="h-full w-full"
          style={{ background: "var(--color-bg)" }}
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            subdomains="abcd"
            attribution="© OpenStreetMap contributors © CARTO"
          />

          {/* Units */}
          {cop.units.map((u) => {
            const color = colorForMc(u.mc_rate);
            const radius = 8 + Math.min(20, u.total_equipment / 4);
            const hasAlert = u.alerts.length > 0 || (u.mc_rate < 0.70);
            return (
              <g key={u.unit}>
                {hasAlert && (
                  <Circle
                    center={[u.lat, u.lon]}
                    radius={radius * 200}
                    pathOptions={{ color, fillColor: color, fillOpacity: 0.05, weight: 1, opacity: 0.4, dashArray: "4 4" }}
                  />
                )}
                <CircleMarker
                  center={[u.lat, u.lon]}
                  radius={radius}
                  pathOptions={{ color, fillColor: color, fillOpacity: 0.6, weight: 2 }}
                >
                  <LTooltip direction="top" offset={[0, -radius]} opacity={1}>
                    <div style={{ color: "var(--color-text)", fontSize: 11 }}>
                      <strong>{u.unit}</strong> · {(u.mc_rate * 100).toFixed(0)}% MC · {u.total_equipment} assets
                    </div>
                  </LTooltip>
                  <Popup>
                    <div style={{ minWidth: 220 }}>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{u.unit}</div>
                      <div style={{ fontSize: 11, color: "#6b7280" }}>
                        {u.parent} · {u.location}
                      </div>
                      <div style={{ marginTop: 6, fontFamily: "monospace", fontSize: 12 }}>
                        MC: {(u.mc_rate * 100).toFixed(1)}% ({u.mc_count}/{u.total_equipment})
                      </div>
                      <div style={{ marginTop: 4, fontSize: 11 }}>
                        PMC {u.pmc_count} · NMCM {u.nmcm_count} · NMCS {u.nmcs_count}
                      </div>
                      {u.data_integrity_flags > 0 && (
                        <div style={{ marginTop: 4, color: "#f59e0b", fontSize: 11 }}>
                          ⚠ {u.data_integrity_flags} data-quality flag{u.data_integrity_flags === 1 ? "" : "s"}
                        </div>
                      )}
                    </div>
                  </Popup>
                </CircleMarker>
              </g>
            );
          })}

          {/* ThermalHawk simulation rendering */}
          {sim && <ThermalHawkOverlay sim={sim} />}
        </MapContainer>

        {/* NL query bar */}
        <div className="absolute inset-x-0 top-0 z-[500] p-3">
          <div className="mx-auto max-w-2xl rounded-md border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_92%,transparent)] p-2 shadow-lg backdrop-blur">
            <div className="flex items-center gap-2">
              <span className="px-2 text-xs text-[var(--color-text-muted)]">🔍</span>
              <input
                value={nlText}
                onChange={(e) => setNlText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleNL()}
                placeholder='Ask BASTION... e.g. "Submit TMR Lejeune to Geiger 5 MTVRs Wednesday urgent"'
                className="flex-1 bg-transparent text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
              />
              <button
                onClick={handleNL}
                className="rounded border border-[var(--color-primary)] bg-[var(--color-primary)] px-3 py-1 text-xs text-white hover:bg-[var(--color-primary-hover)]"
              >
                Submit
              </button>
            </div>
            {nlResult && <NLResultPanel result={nlResult} onClose={() => setNlResult(null)} />}
          </div>
        </div>

        {/* Installation info footer */}
        <div className="absolute bottom-3 left-3 z-[500] rounded border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-surface)_92%,transparent)] px-3 py-1.5 text-[10px] text-[var(--color-text-muted)] backdrop-blur">
          {cop.installation.name} · {cop.buildings_count} buildings · {cop.ecps.length} ECPs · {cop.response_forces_count} response forces
          {cop.installation.fictional && <span className="ml-2 text-[var(--color-warning)]">⚠ synthetic</span>}
        </div>
      </div>

      {/* Right sidebar: response panel */}
      {selectedAlert && (
        <ResponsePanel
          alert={selectedAlert}
          sim={sim}
          onClose={() => {
            setSelectedAlert(null);
            setResponse(null);
          }}
        />
      )}
    </div>
  );
}

function AlertRow({ alert, selected, onClick }: { alert: BastionAlert; selected: boolean; onClick: () => void }) {
  const color = SEVERITY_COLOR[alert.severity] || SEVERITY_COLOR.INFO;
  return (
    <div
      onClick={onClick}
      className={clsx(
        "mb-1.5 cursor-pointer rounded-sm border-l-4 bg-[var(--color-surface)] px-2 py-1.5 transition-colors",
        selected ? "border border-[var(--color-primary)]" : "border-r border-t border-b border-[var(--color-border)]",
      )}
      style={{ borderLeftColor: color }}
    >
      <div className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
        <span className="font-semibold" style={{ color }}>{alert.severity}</span>
        <span>· {alert.source}</span>
        <span className="ml-auto font-mono">{new Date(alert.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
      </div>
      <div className="mt-0.5 text-xs font-medium text-[var(--color-text)]">{alert.title}</div>
      <div className="line-clamp-2 text-[10px] text-[var(--color-text-secondary)]">{alert.body}</div>
    </div>
  );
}

function ThermalHawkOverlay({ sim }: { sim: ThermalHawkSim }) {
  const map = useMap();
  // Drone track — fake moving dot; we place the start near the alert's grid.
  // For v1 we just plot a hot dot at CLB-6 motor pool offset.
  const center: [number, number] = [34.6690, -77.4210]; // CLB-6 MP
  const [pos, setPos] = useState<[number, number]>(center);

  useEffect(() => {
    // Sweep the drone 600m east over 6s
    let ms = 0;
    const id = window.setInterval(() => {
      ms += 100;
      const t = Math.min(1, ms / 6000);
      setPos([center[0] + t * 0.002, center[1] + t * 0.008]);
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    map.flyTo(center, 15, { duration: 1.2 });
  }, [map]);

  return (
    <>
      {sim.cordon_zones.map((cz) => (
        <Circle
          key={cz.radius_m}
          center={center}
          radius={cz.radius_m}
          pathOptions={{
            color: cz.radius_m <= 300 ? "#ef4444" : cz.radius_m <= 500 ? "#f59e0b" : "#3b82f6",
            fillOpacity: 0.04,
            weight: 1,
            dashArray: "3 6",
          }}
        />
      ))}
      <CircleMarker
        center={pos}
        radius={6}
        pathOptions={{ color: "#ef4444", fillColor: "#fca5a5", fillOpacity: 0.95, weight: 2, className: "animate-pulse" }}
      >
        <LTooltip permanent direction="top">
          <span style={{ color: "#ef4444", fontWeight: 600 }}>UAS</span>
        </LTooltip>
      </CircleMarker>
    </>
  );
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
  const checklist = sim && sim.alert.id === alert.id ? sim.checklist : null;
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  function toggle(key: string) {
    setChecked((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  return (
    <aside className="flex w-[400px] shrink-0 flex-col overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: SEVERITY_COLOR[alert.severity] }}>
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
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Detection model
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
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
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
            <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              Immediate (0-5 MIN)
            </div>
            <ul className="flex flex-col gap-1.5 text-[11px]">
              {checklist.immediate.map((item, i) => (
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
            <div className="mt-3 mb-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              Follow-on (5-30 MIN)
            </div>
            <ul className="flex flex-col gap-1.5 text-[11px]">
              {checklist.followon.map((item, i) => (
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
            <div className="mt-3 mb-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
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
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Response forces dispatched
            </div>
            <div className="flex flex-wrap gap-1">
              {sim.response_forces_dispatched.map((rf) => (
                <span
                  key={rf}
                  className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-mono text-[var(--color-text)]"
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
      <div className="mt-2 rounded-md border border-[var(--color-primary)] bg-[var(--color-surface)] p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-primary)]">
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
        <div className="mt-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
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
    <div className="mt-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text-secondary)]">
      <div className="flex items-baseline justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
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
      <div className="text-[9px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className="font-mono text-[var(--color-text)]">{String(value)}</div>
    </div>
  );
}
