import { useEffect, useState } from "react";
import { api, type SystemStatus } from "../api";
import { pollWithBackoff } from "../api-retry";
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

  // System status — base 15s, backs off to 60s if nothing changes. The
  // marquee labels rarely flip; aggressive polling here was the largest
  // share of the steady-state GET pressure caught in the deep-review.
  useEffect(() => {
    const ctrl = pollWithBackoff(() => api.system.status(), {
      baseMs: 15000,
      maxMs: 60000,
      onResult: (s) => setStatus(s),
    });
    return () => ctrl.stop();
  }, []);

  // Poll comms-state every 4s base — backs off to 60s when state is steady.
  // Drives the StatusFooter pulse colour and keeps the air-gap toggle + queue
  // depth in sync if changes happen outside the TopBar.
  useEffect(() => {
    const ctrl = pollWithBackoff(() => api.system.commsState(), {
      baseMs: 4000,
      maxMs: 60000,
      // Fingerprint on the three fields we actually render — ignore any
      // server-side timestamp jitter so the back-off can take hold.
      fingerprint: (c) =>
        `${c.current_state}|${c.air_gap_active ? 1 : 0}|${c.queued_ops_count}`,
      onResult: (c) => {
        setCommsState(c.current_state);
        setAirGap(c.air_gap_active);
        setQueueDepth(c.queued_ops_count);
      },
    });
    return () => ctrl.stop();
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
  // AUDIT·SHA256 and CLASSIFICATION are persistent posture indicators and
  // should NOT cycle (reviewer caught them sliding off before the operator
  // could read them). Both are pinned in the footer chrome below.
  const tickerItems: { label: string; value: string; tone?: "ok" | "warn" | "muted" }[] = [
    { label: "NETWORK", value: "0 egress", tone: "ok" },
    { label: "ENCRYPTION", value: "AES-256-GCM", tone: "ok" },
    { label: "DATASET", value: `${assets.toLocaleString()} assets · ${srs.toLocaleString()} SR`, tone: "muted" },
    { label: "INTEGRITY", value: errs === 0 ? "0 errors" : `${errs} errors`, tone: errs === 0 ? "ok" : "warn" },
    { label: "LLM", value: `${llmModel} · ${llmOk ? "online" : "standby"}`, tone: llmOk ? "ok" : "warn" },
    { label: "SENTRY·CLASSIFIER", value: "val=1.0 · 413K params", tone: "ok" },
    { label: "PULSE·RISK", value: "val=0.9974 · 8.8K params", tone: "ok" },
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
      {/* Left-anchored session block — UP/clock + comms-state pulse + audit hash.
       * Audit hash pins here so it's always visible (reviewer caught it
       * sliding off in the marquee before operators could read it). */}
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
        <span className="mx-1 hidden text-[var(--color-border-active)] lg:inline">│</span>
        <span className="hidden uppercase text-[var(--color-text-muted)] tracking-wider lg:inline">AUDIT</span>
        <span
          className="hidden tabular-nums text-[var(--color-text-secondary)] lg:inline"
          title="Append-only audit chain SHA-256 fingerprint"
        >
          {fingerprint || "pending"}
        </span>
      </div>

      {/* Right-anchored version/mode block + pinned classification posture.
       * Hidden below md (768px). Classification pins here so the operator
       * always sees the marking regardless of the ticker position. */}
      <div
        className="absolute right-0 top-0 z-10 hidden h-full items-center gap-2 border-l border-[var(--color-border)] bg-[var(--color-surface)] pl-3 pr-3 font-mono text-xs uppercase md:flex tracking-wider"
      >
        <span
          className="rounded-sm border border-[var(--color-border-active)] px-1.5 py-[1px] text-[var(--color-text-muted)] tracking-widest"
          title="Operating classification posture"
        >
          UNCLASSIFIED // SYNTHETIC
        </span>
        <span className="text-[var(--color-border-active)]">│</span>
        <span className="text-[var(--color-text-muted)]">{status?.mode || "local"}</span>
        <span className="text-[var(--color-border-active)]">│</span>
        <span className="text-[var(--color-primary)]">SPIRE v1.0.0-rc1 · MDM 2026</span>
      </div>

      {/* Scrolling telemetry ticker between the anchors. Padding values are
       * tuned so the ticker doesn't overlap the anchored blocks at any
       * breakpoint. The left anchor grew on lg breakpoints to accommodate
       * the pinned audit hash; the right anchor grew on md to accommodate
       * the pinned classification posture. */}
      <div
        className="absolute inset-y-0 left-0 right-0 z-0 overflow-hidden pl-[14rem] pr-3 md:pl-[18rem] md:pr-[20rem] lg:pl-[28rem]"
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
        className="pointer-events-none absolute left-[18rem] top-0 z-[5] hidden h-full w-10 md:block lg:left-[28rem]"
        style={{
          background:
            "linear-gradient(90deg, var(--color-surface) 0%, transparent 100%)",
        }}
      />
      <div
        className="pointer-events-none absolute right-[20rem] top-0 z-[5] hidden h-full w-10 md:block"
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
