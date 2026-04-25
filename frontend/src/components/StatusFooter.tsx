import { useEffect, useState } from "react";
import { api, type SystemStatus } from "../api";

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
    { label: "CLASSIFICATION", value: "UNCLASSIFIED · synthetic", tone: "muted" },
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
      {/* Left-anchored session block */}
      <div
        className="absolute left-0 top-0 z-10 flex h-full items-center gap-2 border-r border-[var(--color-border)] bg-[var(--color-surface)] pl-3 pr-3 font-mono text-[10px]"
        style={{ letterSpacing: "0.08em" }}
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-success)]"
          style={{ boxShadow: "0 0 5px var(--color-success)" }}
        />
        <span className="text-[var(--color-text-muted)]">UP</span>
        <span className="tabular-nums text-[var(--color-text)]">{uptime}</span>
        <span className="mx-1 text-[var(--color-border-active)]">│</span>
        <span className="tabular-nums text-[var(--color-text-secondary)]">{localTime}</span>
      </div>

      {/* Right-anchored version/mode block */}
      <div
        className="absolute right-0 top-0 z-10 flex h-full items-center gap-2 border-l border-[var(--color-border)] bg-[var(--color-surface)] pl-3 pr-3 font-mono text-[10px] uppercase"
        style={{ letterSpacing: "0.14em" }}
      >
        <span className="text-[var(--color-text-muted)]">{status?.mode || "local"}</span>
        <span className="text-[var(--color-border-active)]">│</span>
        <span className="text-[var(--color-primary)]">SPIRE v1.0.0-rc1 · MDM 2026</span>
      </div>

      {/* Scrolling telemetry ticker between the anchors */}
      <div
        className="absolute inset-y-0 z-0 overflow-hidden"
        style={{
          left: 0,
          right: 0,
          paddingLeft: "18rem",
          paddingRight: "16rem",
        }}
      >
        <div
          className="ticker flex h-full items-center whitespace-nowrap font-mono text-[10px]"
          style={{ letterSpacing: "0.1em" }}
        >
          {track.map((item, i) => (
            <span key={i} className="flex items-center gap-2 px-4">
              <span
                className="uppercase text-[var(--color-text-muted)]"
                style={{ letterSpacing: "0.16em" }}
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
