import { useEffect, useState } from "react";
import { api, type SystemStatus } from "../api";
import { useSpireStore } from "../state/store";

function formatUptime(startedAt: number): string {
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function StatusFooter() {
  const [now, setNow] = useState(() => new Date());
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [startedAt] = useState(() => Date.now());
  const commsState = useSpireStore((s) => s.commsState);
  const airGap = useSpireStore((s) => s.airGapActive);
  const queueDepth = useSpireStore((s) => s.queueDepth);
  const setCommsState = useSpireStore((s) => s.setCommsState);
  const setAirGap = useSpireStore((s) => s.setAirGap);
  const setQueueDepth = useSpireStore((s) => s.setQueueDepth);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let alive = true;
    const fetch = async () => {
      try {
        const s = await api.system.status();
        if (alive) setStatus(s);
      } catch {
        /* tolerate */
      }
    };
    fetch();
    const id = setInterval(fetch, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Poll comms-state every 4s — drives the StatusFooter pulse colour and
  // keeps the air-gap toggle + queue depth in sync if changes happen
  // outside the TopBar (e.g. another operator on a sister node).
  useEffect(() => {
    let alive = true;
    const fetch = async () => {
      try {
        const c = await api.system.commsState();
        if (!alive) return;
        setCommsState(c.current_state);
        setAirGap(c.air_gap_active);
        setQueueDepth(c.queued_ops_count);
      } catch {
        /* tolerate; the StatusFooter shows the last known state */
      }
    };
    fetch();
    const id = setInterval(fetch, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [setCommsState, setAirGap, setQueueDepth]);

  const localTime = now.toLocaleTimeString([], { hour12: false });
  const uptime = formatUptime(startedAt);
  const assets = status?.dataset.assets ?? 0;
  const srs = status?.dataset.srs ?? 0;
  const llmOk = status?.llm.reachable ?? false;
  const llmModel = status?.llm.model ?? "—";
  const errs = status?.dataset.consistency_errors ?? 0;
  const fingerprint = (status?.dataset.fingerprint ?? "").slice(0, 12).toUpperCase();

  // Ticker segments — these scroll continuously in a marquee.
  // Values update every 15s; the animation re-renders softly.
  const tickerItems: { label: string; value: string; tone?: "ok" | "warn" | "muted" }[] = [
    { label: "AUDIT·SHA256", value: fingerprint || "pending", tone: "muted" },
    { label: "NETWORK", value: "0 egress", tone: "ok" },
    { label: "ENCRYPTION", value: "AES-256-GCM", tone: "ok" },
    { label: "DATASET", value: `${assets.toLocaleString()} assets · ${srs.toLocaleString()} SR`, tone: "muted" },
    { label: "INTEGRITY", value: errs === 0 ? "0 errors" : `${errs} errors`, tone: errs === 0 ? "ok" : "warn" },
    { label: "LLM", value: `${llmModel} · ${llmOk ? "online" : "standby"}`, tone: llmOk ? "ok" : "warn" },
    { label: "SENTRY·CLASSIFIER", value: "val=1.0 · 413K params", tone: "ok" },
    { label: "PULSE·RISK", value: "val=0.9974 · 8.8K params", tone: "ok" },
    { label: "CLASSIFICATION", value: "UNCLASSIFIED // SYNTHETIC DATA", tone: "muted" },
  ];

  const toneColor = (tone?: "ok" | "warn" | "muted") =>
    tone === "ok"
      ? "var(--color-success)"
      : tone === "warn"
      ? "var(--color-warning)"
      : "var(--color-text-secondary)";

  // Duplicate track so the marquee animation loops seamlessly.
  const track = [...tickerItems, ...tickerItems];

  return (
    <footer className="relative h-8 shrink-0 overflow-hidden border-t border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* Left-anchored session block — UP/clock + comms-state pulse */}
      <div
        className="absolute left-0 top-0 z-10 flex h-full items-center gap-2 border-r border-[var(--color-border)] bg-[var(--color-surface)] pl-3 pr-3 font-mono text-xs tracking-wide"
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-success)]"
          style={{ boxShadow: "0 0 5px var(--color-success)" }}
        />
        <span className="text-[var(--color-text-muted)]">UP</span>
        <span className="tabular-nums text-[var(--color-text)]">{uptime}</span>
        <span className="mx-1 text-[var(--color-border-active)]">│</span>
        <span className="tabular-nums text-[var(--color-text-secondary)]">{localTime}</span>
        <span className="mx-1 text-[var(--color-border-active)]">│</span>
        <CommsIndicator state={commsState} airGap={airGap} queueDepth={queueDepth} />
      </div>

      {/* Right-anchored version/mode block — hidden below md (768px) */}
      <div
        className="absolute right-0 top-0 z-10 hidden h-full items-center gap-2 border-l border-[var(--color-border)] bg-[var(--color-surface)] pl-3 pr-3 font-mono text-xs uppercase md:flex tracking-wider"
      >
        <span className="text-[var(--color-text-muted)]">{status?.mode || "local"}</span>
        <span className="text-[var(--color-border-active)]">│</span>
        <span className="text-[var(--color-primary)]">SPIRE v1.0.0-rc1 · MDM 2026</span>
      </div>

      {/* Scrolling telemetry ticker between the anchors. Padding values are
       * tuned so the ticker doesn't overlap the anchored blocks at any
       * breakpoint: anchored blocks are wider on desktop, so the ticker
       * gets bigger insets there. */}
      <div
        className="absolute inset-y-0 left-0 right-0 z-0 overflow-hidden pl-[14rem] pr-3 md:pl-[18rem] md:pr-[16rem]"
      >
        <div
          className="ticker flex h-full items-center whitespace-nowrap font-mono text-xs tracking-wider"
        >
          {track.map((item, i) => (
            <span key={i} className="flex items-center gap-2 px-4">
              <span
                className="uppercase text-[var(--color-text-muted)] tracking-wider"
              >
                {item.label}
              </span>
              <span className="tabular-nums" style={{ color: toneColor(item.tone) }}>
                {item.value}
              </span>
              <span className="pl-4 text-[var(--color-border-active)]">◦</span>
            </span>
          ))}
        </div>
      </div>

      {/* Fade edges so ticker text disappears cleanly into the anchored blocks */}
      <div
        className="pointer-events-none absolute left-[18rem] top-0 z-[5] h-full w-10"
        style={{
          background:
            "linear-gradient(90deg, var(--color-surface) 0%, transparent 100%)",
        }}
      />
      <div
        className="pointer-events-none absolute right-[16rem] top-0 z-[5] h-full w-10"
        style={{
          background:
            "linear-gradient(270deg, var(--color-surface) 0%, transparent 100%)",
        }}
      />
    </footer>
  );
}

// Comms-state pulse — green CONNECTED, amber DEGRADED, red DISCONNECTED.
// Air-gap mode flips to red regardless of timeline + shows queue depth.
function CommsIndicator({
  state,
  airGap,
  queueDepth,
}: {
  state: "CONNECTED" | "DEGRADED" | "DISCONNECTED";
  airGap: boolean;
  queueDepth: number;
}) {
  const effective = airGap ? "DISCONNECTED" : state;
  const colors: Record<string, string> = {
    CONNECTED: "var(--color-success)",
    DEGRADED: "var(--color-warning)",
    DISCONNECTED: "var(--color-danger)",
  };
  const c = colors[effective];
  return (
    <span
      className="flex items-center gap-1.5"
      title={airGap ? "Air-gap mode active — local writes are queued" : `Comms ${effective}`}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{
          background: c,
          boxShadow: `0 0 5px ${c}`,
          animation: effective !== "CONNECTED" ? "pulse 1.6s ease-in-out infinite" : undefined,
        }}
      />
      <span className="text-[var(--color-text-muted)]">COMMS</span>
      <span className="font-semibold uppercase tracking-wider" style={{ color: c }}>
        {airGap ? "AIRGAP" : effective}
      </span>
      {airGap && queueDepth > 0 && (
        <span
          className="ml-1 rounded-sm border px-1 font-mono text-xs tabular-nums tracking-wider"
          style={{
            color: "var(--color-warning)",
            borderColor: "color-mix(in oklab, var(--color-warning) 40%, var(--color-border))",
          }}
        >
          Q:{queueDepth}
        </span>
      )}
    </span>
  );
}
