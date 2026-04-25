import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { api, type SentryJob, type SentryReviewQueue } from "../../api";
import type { SentryContext } from "../SentryView";

const FLAG_COLORS: Record<string, string> = {
  pii: "var(--color-info)",
  geo: "var(--color-primary)",
  comms: "var(--color-warning)",
  classified: "var(--color-danger)",
  controlled: "#fb923c",
};

export function ProcessingTab({ ctx }: { ctx: SentryContext }) {
  const nav = useNavigate();
  const [job, setJob] = useState<SentryJob | null>(null);
  const [queue, setQueue] = useState<SentryReviewQueue | null>(null);
  const [displayIdx, setDisplayIdx] = useState(0);
  const [counts, setCounts] = useState({ tier1: 0, tier2: 0, pii: 0, geo: 0, comms: 0, classified: 0, controlled: 0 });
  const [error, setError] = useState<string | null>(null);
  const tickRef = useRef<number | null>(null);

  useEffect(() => {
    if (!ctx.jobId || !ctx.batchId) return;
    let alive = true;
    setError(null);
    (async () => {
      try {
        const j = await api.sentry.jobStatus(ctx.jobId!);
        if (!alive) return;
        setJob(j);
        const q = await api.sentry.reviewQueue(ctx.batchId!);
        if (!alive) return;
        setQueue(q);
      } catch (e) {
        if (!alive) return;
        // Surface the failure instead of leaving the spinner up forever.
        // Backend down or the batch was wiped between Upload and Processing.
        setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [ctx.jobId, ctx.batchId]);

  // Drive the scan-line animation forward deterministically. We're NOT
  // chasing real processing time — the backend already finished — we just
  // replay the records at a demo-friendly cadence.
  useEffect(() => {
    if (!queue) return;
    const all = [...queue.auto_cleared, ...queue.flagged, ...queue.held];
    if (displayIdx >= all.length) return;
    const ms = 30; // records per 30ms = ~17fps-friendly
    tickRef.current = window.setTimeout(() => {
      setDisplayIdx((i) => {
        const rec = all[i];
        if (rec) {
          setCounts((c) => {
            const next = { ...c };
            if (rec.routed_to === "tier2_llm") next.tier2 += 1;
            else next.tier1 += 1;
            for (const f of rec.flags || []) {
              if (f in next) (next as any)[f] += 1;
            }
            return next;
          });
        }
        return i + 1;
      });
    }, ms);
    return () => {
      if (tickRef.current) window.clearTimeout(tickRef.current);
    };
  }, [queue, displayIdx]);

  if (!ctx.jobId) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-text-secondary)]">
          No active job. Return to Upload to load a batch and process it.
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <div className="max-w-md rounded-md border border-[var(--color-danger-muted)] bg-[var(--color-surface)] p-6 text-center">
          <div
            className="font-mono text-xs uppercase text-[var(--color-danger)]"
            style={{ letterSpacing: "0.22em" }}
          >
            Processing Unavailable
          </div>
          <div className="mt-2 spire-body text-sm">
            SENTRY processing pipeline did not respond. Re-load the batch from Upload to retry.
          </div>
          <div className="mt-3 font-mono text-xs text-[var(--color-text-muted)]" style={{ letterSpacing: "0.1em" }}>
            {error}
          </div>
          <button
            onClick={() => nav("/sentry/upload")}
            className="mt-4 inline-flex h-11 min-w-[44px] items-center rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-4 font-mono text-sm font-semibold uppercase text-white hover:bg-[var(--color-primary-hover)]"
            style={{ letterSpacing: "0.18em" }}
          >
            ← Back to Upload
          </button>
        </div>
      </div>
    );
  }
  if (!queue || !job) {
    return (
      <div className="flex h-full items-center justify-center p-12 text-sm text-[var(--color-text-secondary)]">
        <div className="flex items-center gap-3 font-mono text-sm" style={{ letterSpacing: "0.1em" }}>
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
          Initializing processing …
        </div>
      </div>
    );
  }

  const all = [...queue.auto_cleared, ...queue.flagged, ...queue.held];
  const processed = Math.min(all.length, displayIdx);
  const remaining = all.length - processed;
  const done = remaining === 0;
  const pct = all.length > 0 ? processed / all.length : 0;
  const recent = all.slice(Math.max(0, displayIdx - 10), displayIdx).reverse();

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {/* Subtle CRT scanline overlay across the whole processing view */}
      <div
        className="pointer-events-none absolute inset-0 z-10 overflow-hidden opacity-[0.06]"
        aria-hidden
      >
        <div
          className="crt-scan absolute inset-x-0"
          style={{
            height: "3px",
            background:
              "linear-gradient(90deg, transparent 0%, var(--color-primary) 50%, transparent 100%)",
            boxShadow: "0 0 20px var(--color-primary), 0 0 40px var(--color-primary)",
          }}
        />
      </div>

      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <div className="flex items-baseline gap-4">
          <div className="flex items-center gap-2">
            <span
              className={clsx(
                "inline-block h-2 w-2 rounded-full",
                done ? "bg-[var(--color-success)]" : "bg-[var(--color-primary)]",
              )}
              style={{
                boxShadow: done
                  ? "0 0 8px var(--color-success)"
                  : "0 0 8px var(--color-primary)",
                animation: done ? undefined : "pulse 1.4s ease-in-out infinite",
              }}
            />
            <h2
              className="font-mono text-sm font-semibold uppercase text-[var(--color-text)] tracking-widest"
            >
              {done ? "Processing · Complete" : "Processing · Live"}
            </h2>
          </div>
          <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
            Batch {ctx.batchId} · Job {ctx.jobId}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-baseline gap-1 font-mono">
            <span
              className="text-xl font-semibold tabular-nums text-[var(--color-text)] tracking-tight"
              style={{ lineHeight: 1 }}
            >
              {processed.toLocaleString()}
            </span>
            <span className="text-[var(--color-text-muted)]">/</span>
            <span
              className="tabular-nums text-[var(--color-text-secondary)] tracking-wide"
            >
              {all.length.toLocaleString()}
            </span>
            <span
              className="ml-1 text-xs uppercase text-[var(--color-text-muted)] tracking-wider"
            >
              records
            </span>
          </div>
          {done && (
            <button
              onClick={() => nav("/sentry/review")}
              className="ml-3 rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-3 py-1.5 font-mono text-sm font-semibold uppercase text-white hover:bg-[var(--color-primary-hover)]"
              style={{ letterSpacing: "0.14em" }}
            >
              Review queue →
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Raw input column */}
        <div className="flex w-[55%] flex-col overflow-hidden border-r border-[var(--color-border)]">
          <div className="bg-[var(--color-bg)] px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Raw input
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {recent.map((r, idx) => (
              <RawRecord key={r.sr_number} record={r} isMostRecent={idx === 0 && !done} />
            ))}
            {recent.length === 0 && (
              <div className="text-xs text-[var(--color-text-muted)]">Waiting to begin ...</div>
            )}
          </div>
        </div>

        {/* Sanitized column */}
        <div className="flex w-[45%] flex-col overflow-hidden">
          <div className="bg-[var(--color-bg)] px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Sanitized output
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {recent.map((r) => (
              <SanitizedRecord key={r.sr_number} record={r} />
            ))}
          </div>
        </div>
      </div>

      {/* Bottom strip */}
      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="relative h-[3px] flex-1 overflow-hidden rounded-full bg-[var(--color-bg)]">
            <div
              className="absolute inset-y-0 left-0 transition-all"
              style={{
                width: `${pct * 100}%`,
                background:
                  "linear-gradient(90deg, var(--color-primary) 0%, color-mix(in oklab, var(--color-primary) 70%, white) 100%)",
                boxShadow: "0 0 12px var(--color-primary)",
              }}
            />
            {/* Leading edge glow */}
            {!done && pct > 0 && (
              <div
                className="absolute inset-y-0 w-4"
                style={{
                  left: `calc(${pct * 100}% - 1rem)`,
                  background:
                    "linear-gradient(90deg, transparent 0%, color-mix(in oklab, var(--color-primary) 80%, white) 100%)",
                  filter: "blur(2px)",
                }}
              />
            )}
          </div>
          <span
            className="w-14 text-right font-mono text-sm font-semibold tabular-nums text-[var(--color-text)]"
            style={{ letterSpacing: "-0.01em" }}
          >
            {(pct * 100).toFixed(1)}%
          </span>
        </div>
        <div className="mt-2 flex items-center gap-6 text-sm">
          <Counter label="Tier 1 (HawkStack)" value={counts.tier1} total={processed} tone="primary" />
          <Counter label="Tier 2 (LLM)" value={counts.tier2} total={processed} tone="info" />
          <div className="ml-auto flex gap-3">
            <FlagCounter label="PII" value={counts.pii} color={FLAG_COLORS.pii} />
            <FlagCounter label="GEO" value={counts.geo} color={FLAG_COLORS.geo} />
            <FlagCounter label="COMMS" value={counts.comms} color={FLAG_COLORS.comms} />
            <FlagCounter label="CLASSIFIED" value={counts.classified} color={FLAG_COLORS.classified} />
            <FlagCounter label="CONTROLLED" value={counts.controlled} color={FLAG_COLORS.controlled} />
          </div>
        </div>
        <div className="mt-1 flex items-center gap-6 text-sm text-[var(--color-text-muted)]">
          <span>Classification discrepancies: <span className="font-mono tabular-nums text-[var(--color-warning)]">{job.mismatches}</span></span>
          <span>Aggregation risks: <span className="font-mono tabular-nums text-[var(--color-warning)]">{job.aggregation_risks.length}</span></span>
        </div>
      </div>
    </div>
  );
}

function RawRecord({ record, isMostRecent }: { record: any; isMostRecent: boolean }) {
  const highlights = record.highlights || [];
  const remark: string = record.remark || "";

  // Render with colored spans for each highlight range (sorted by start)
  const segments: { text: string; category?: string }[] = [];
  let cursor = 0;
  const sorted = [...highlights].sort((a, b) => a.start - b.start);
  for (const h of sorted) {
    if (h.start > cursor) segments.push({ text: remark.slice(cursor, h.start) });
    segments.push({ text: remark.slice(h.start, h.end), category: h.category });
    cursor = h.end;
  }
  if (cursor < remark.length) segments.push({ text: remark.slice(cursor) });

  return (
    <div
      className={clsx(
        "relative mb-2 rounded-sm border bg-[var(--color-surface)] px-3 py-2 text-xs",
        isMostRecent
          ? "border-[var(--color-primary)] shadow-[0_0_0_1px_var(--color-primary)]"
          : "border-[var(--color-border)]",
      )}
    >
      {isMostRecent && (
        <>
          <div className="scan-line pointer-events-none absolute inset-x-0 top-0 h-full bg-gradient-to-b from-transparent via-[var(--color-primary)] to-transparent opacity-40" />
          {/* Reticle corners — tactical engagement framing */}
          <span className="pointer-events-none absolute -left-[2px] -top-[2px] h-2 w-2 border-l border-t border-[var(--color-primary)]" aria-hidden />
          <span className="pointer-events-none absolute -right-[2px] -top-[2px] h-2 w-2 border-r border-t border-[var(--color-primary)]" aria-hidden />
          <span className="pointer-events-none absolute -bottom-[2px] -left-[2px] h-2 w-2 border-b border-l border-[var(--color-primary)]" aria-hidden />
          <span className="pointer-events-none absolute -bottom-[2px] -right-[2px] h-2 w-2 border-b border-r border-[var(--color-primary)]" aria-hidden />
        </>
      )}
      <div className="mb-1 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <span className="font-mono">{record.sr_number}</span>
        <span>·</span>
        <span>{record.unit_name}</span>
        <span>·</span>
        <span>{record.equipment_type}</span>
        <span className="ml-auto font-mono">{record.source_classification}</span>
      </div>
      <div className="text-[var(--color-text)]">
        {segments.map((s, i) =>
          s.category ? (
            <span
              key={i}
              className="rounded-sm px-0.5"
              style={{
                background: `color-mix(in oklab, ${FLAG_COLORS[s.category] || "#fff"} 25%, transparent)`,
                color: FLAG_COLORS[s.category] || "inherit",
                textShadow: `0 0 8px ${FLAG_COLORS[s.category] || "#fff"}40`,
              }}
            >
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </div>
    </div>
  );
}

function SanitizedRecord({ record }: { record: any }) {
  const flags: string[] = record.flags || [];
  return (
    <div className="mb-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs">
      <div className="mb-1 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <span className="font-mono">{record.sr_number}</span>
        <span className="ml-auto font-mono" style={{ color: record.detected_classification === "UNCLASSIFIED" ? "var(--color-success)" : record.detected_classification === "CUI" ? "var(--color-warning)" : "var(--color-danger)" }}>
          {record.detected_classification}
        </span>
        {record.classification_discrepancy && (
          <span className="rounded-sm bg-[var(--color-danger-muted)] px-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-danger)]">
            MIS-MARKED
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {flags.length === 0 && (
          <span className="text-[var(--color-success)]">✓ Clean</span>
        )}
        {flags.map((f) => (
          <span
            key={f}
            className="rounded-sm px-1.5 py-0.5 text-xs font-mono"
            style={{
              background: `color-mix(in oklab, ${FLAG_COLORS[f] || "#fff"} 20%, var(--color-bg))`,
              color: FLAG_COLORS[f] || "inherit",
              border: `1px solid color-mix(in oklab, ${FLAG_COLORS[f] || "#fff"} 40%, transparent)`,
            }}
          >
            [{f.toUpperCase()} FLAGGED]
          </span>
        ))}
      </div>
      <div className="mt-1 text-sm text-[var(--color-text-muted)]">
        Routed to {record.routed_to === "tier2_llm" ? "Tier 2 LLM" : "Tier 1 classifier"} · confidence {record.confidence?.toFixed(2)}
      </div>
    </div>
  );
}

function Counter({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: "primary" | "info";
}) {
  const pct = total > 0 ? ((value / total) * 100).toFixed(0) : "0";
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-[var(--color-text-muted)]">{label}:</span>
      <span
        className="font-mono tabular-nums"
        style={{ color: tone === "primary" ? "var(--color-primary)" : "var(--color-info)" }}
      >
        {value} ({pct}%)
      </span>
    </div>
  );
}

function FlagCounter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      <span className="text-[var(--color-text-muted)]">{label}:</span>
      <span className="font-mono tabular-nums" style={{ color }}>
        {value}
      </span>
    </div>
  );
}
