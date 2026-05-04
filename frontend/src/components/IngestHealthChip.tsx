/**
 * IngestHealthChip — UIS-P5.2 health roll-up on TopBar.
 *
 * Surfaces silent ingest staleness at the global chrome level so
 * operators don't have to navigate to /admin/channels to discover
 * a tripped circuit. Polls /api/uis/channels/health-rollup every
 * 30s; the rollup is cheap (breaker state only, no real
 * connectivity probes).
 *
 * Visible states:
 *   - Hidden: ingest disabled OR no channels configured (no signal
 *     to surface).
 *   - Neutral "INGEST OK": all enabled channels healthy.
 *   - Amber "INGEST DEGRADED": consecutive_failures > 0 on at
 *     least one channel.
 *   - Rose "INGEST CIRCUIT OPEN": one or more channels have
 *     tripped breakers; operator action required.
 *
 * Click navigates to /admin/channels.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

interface RollupResponse {
  total: number;
  enabled: number;
  circuit_open: number;
  failing: Array<{
    channel_id: string;
    consecutive_failures: number;
    circuit_state: string;
    last_error: string | null;
  }>;
  stale: Array<{ channel_id: string; circuit_state: string }>;
}

const POLL_INTERVAL_MS = 30_000;

export function IngestHealthChip() {
  const [rollup, setRollup] = useState<RollupResponse | null>(null);
  const [available, setAvailable] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const resp = await fetch("/api/uis/channels/health-rollup", {
          credentials: "same-origin",
        });
        if (cancelled) return;
        if (resp.status === 503) {
          // SPIRE_INGEST_ENABLED is off — nothing to surface
          setAvailable(false);
          return;
        }
        if (resp.status === 403) {
          // Caller not in INGEST_ROLES — chip hidden for them
          setAvailable(false);
          return;
        }
        if (!resp.ok) {
          setRollup(null);
          return;
        }
        const data: RollupResponse = await resp.json();
        if (cancelled) return;
        setRollup(data);
      } catch {
        // Network blip — keep last known state
      } finally {
        if (!cancelled) {
          timer = setTimeout(tick, POLL_INTERVAL_MS);
        }
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!available) return null;
  if (rollup === null) return null;
  // Hide entirely when no channels configured — no signal to render
  if (rollup.enabled === 0) return null;

  const tone = chooseTone(rollup);
  const label = chooseLabel(rollup);
  const tooltip = buildTooltip(rollup);

  return (
    <button
      type="button"
      onClick={() => navigate("/admin/channels")}
      title={tooltip}
      className={[
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5",
        "font-mono text-[10px] uppercase tracking-widest",
        "transition-colors hover:bg-[var(--color-surface-hover)]",
        toneClasses(tone),
      ].join(" ")}
    >
      <span className={dotClasses(tone)} aria-hidden />
      <span>{label}</span>
    </button>
  );
}

type Tone = "ok" | "warn" | "danger";

function chooseTone(r: RollupResponse): Tone {
  if (r.circuit_open > 0) return "danger";
  if (r.failing.length > 0 || r.stale.length > 0) return "warn";
  return "ok";
}

function chooseLabel(r: RollupResponse): string {
  if (r.circuit_open > 0) {
    return `INGEST · ${r.circuit_open} BREAKER${r.circuit_open === 1 ? "" : "S"} OPEN`;
  }
  if (r.failing.length > 0) {
    return `INGEST · ${r.failing.length} FAILING`;
  }
  return `INGEST · ${r.enabled} OK`;
}

function buildTooltip(r: RollupResponse): string {
  const lines: string[] = [`${r.enabled} of ${r.total} channels enabled`];
  if (r.circuit_open > 0) {
    lines.push(`${r.circuit_open} circuit(s) OPEN — channel suppressed`);
  }
  if (r.failing.length > 0) {
    lines.push("");
    lines.push("Failing channels:");
    for (const f of r.failing.slice(0, 5)) {
      const err = (f.last_error ?? "").slice(0, 60);
      lines.push(`  • ${f.channel_id}: ${f.consecutive_failures}× ${err}`);
    }
    if (r.failing.length > 5) {
      lines.push(`  …and ${r.failing.length - 5} more`);
    }
  }
  lines.push("");
  lines.push("Click for /admin/channels");
  return lines.join("\n");
}

function toneClasses(tone: Tone): string {
  switch (tone) {
    case "ok":
      return "border-[var(--color-border)] bg-[var(--color-surface-elevated)] text-[var(--color-text-muted)]";
    case "warn":
      return "border-amber-700 bg-amber-950/30 text-amber-300";
    case "danger":
      return "border-rose-700 bg-rose-950/30 text-rose-300";
  }
}

function dotClasses(tone: Tone): string {
  const base = "h-1.5 w-1.5 rounded-full";
  switch (tone) {
    case "ok":
      return `${base} bg-emerald-400`;
    case "warn":
      return `${base} bg-amber-400`;
    case "danger":
      return `${base} bg-rose-400 animate-pulse`;
  }
}
