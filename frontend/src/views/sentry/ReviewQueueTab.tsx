import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { api, type SentryReviewQueue } from "../../api";
import type { SentryContext } from "../SentryView";
import { useSpireStore } from "../../state/store";

type Column = "auto_cleared" | "flagged" | "held";
type Action = "approve" | "reject";

const FLAG_COLOR: Record<string, string> = {
  pii: "var(--color-info)",
  geo: "var(--color-primary)",
  comms: "var(--color-warning)",
  classified: "var(--color-danger)",
  controlled: "#fb923c",
};

const CLASS_COLOR: Record<string, string> = {
  UNCLASSIFIED: "var(--color-success)",
  CUI: "var(--color-warning)",
  SECRET: "var(--color-danger)",
  TOP_SECRET: "var(--color-danger)",
};

export function ReviewQueueTab({ ctx }: { ctx: SentryContext }) {
  const [queue, setQueue] = useState<SentryReviewQueue | null>(null);
  // Records resolved locally via optimistic removal so the view doesn't depend
  // on a refetch. Shape: { sr_number: "approve" | "reject" }.
  const [resolved, setResolved] = useState<Record<string, Action>>({});
  const [selected, setSelected] = useState<{ col: Column; idx: number } | null>(null);
  const [showAggregation, setShowAggregation] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const pushToast = useSpireStore((s) => s.pushToast);

  useEffect(() => {
    if (!ctx.batchId) return;
    api.sentry.reviewQueue(ctx.batchId).then(setQueue);
  }, [ctx.batchId]);

  const filteredQueue = useMemo(() => {
    if (!queue) return null;
    const cut = (xs: any[]) => xs.filter((r) => !resolved[r.sr_number]);
    return {
      ...queue,
      auto_cleared: cut(queue.auto_cleared),
      flagged: cut(queue.flagged),
      held: cut(queue.held),
      counts: {
        auto_cleared: cut(queue.auto_cleared).length,
        flagged: cut(queue.flagged).length,
        held: cut(queue.held).length,
      },
    };
  }, [queue, resolved]);

  const resolveOne = useCallback(
    async (sr: string, action: Action) => {
      setResolved((prev) => ({ ...prev, [sr]: action }));
      try {
        await api.sentry.review(sr, action);
        pushToast({
          tone: action === "approve" ? "ok" : "warn",
          text: `${sr} ${action === "approve" ? "approved" : "rejected"}`,
          undo: {
            label: "Undo",
            onUndo: () => {
              setResolved((prev) => {
                const next = { ...prev };
                delete next[sr];
                return next;
              });
              api.sentry.review(sr, action === "approve" ? "reject" : "approve").catch(() => {});
            },
          },
        });
      } catch (err) {
        // Roll back on failure
        setResolved((prev) => {
          const next = { ...prev };
          delete next[sr];
          return next;
        });
        pushToast({ tone: "error", text: `Failed to ${action} ${sr}` });
      }
    },
    [pushToast],
  );

  const runBulk = useCallback(
    async (col: Column, action: Action) => {
      if (!filteredQueue || bulkRunning) return;
      const items: any[] = (filteredQueue as any)[col];
      if (!items || items.length === 0) return;
      setBulkRunning(true);
      pushToast({ tone: "info", text: `Processing ${items.length} records…`, ttlMs: 5000 });
      // Optimistic bulk: mark all resolved immediately, fire in parallel.
      setResolved((prev) => {
        const next = { ...prev };
        for (const r of items) next[r.sr_number] = action;
        return next;
      });
      try {
        await Promise.all(
          items.map((r) => api.sentry.review(r.sr_number, action).catch(() => null)),
        );
        pushToast({
          tone: action === "approve" ? "ok" : "warn",
          text: `${items.length} records ${action === "approve" ? "approved" : "rejected"}`,
        });
      } finally {
        setBulkRunning(false);
      }
    },
    [filteredQueue, bulkRunning, pushToast],
  );

  // Keyboard: ↑/↓ moves within the currently-selected column; A approves, R rejects
  const keyRef = useRef({ resolveOne, filteredQueue, selected });
  keyRef.current = { resolveOne, filteredQueue, selected };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const { resolveOne, filteredQueue, selected } = keyRef.current;
      if (!filteredQueue || !selected) return;
      const list: any[] = (filteredQueue as any)[selected.col];
      if (!list?.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelected({ col: selected.col, idx: Math.min(list.length - 1, selected.idx + 1) });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelected({ col: selected.col, idx: Math.max(0, selected.idx - 1) });
      } else if (e.key === "a" || e.key === "A") {
        const rec = list[selected.idx];
        if (rec) resolveOne(rec.sr_number, "approve");
      } else if (e.key === "r" || e.key === "R") {
        const rec = list[selected.idx];
        if (rec) resolveOne(rec.sr_number, "reject");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ctx.batchId) {
    return <Empty msg="No processed batch. Load + process one first." />;
  }
  if (!filteredQueue) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-secondary)]">Loading review queue ...</div>;
  }

  const selectedRecord = (() => {
    if (!selected) return null;
    const list: any[] = (filteredQueue as any)[selected.col];
    return list[selected.idx] ?? null;
  })();

  const totalRemaining =
    filteredQueue.auto_cleared.length + filteredQueue.flagged.length + filteredQueue.held.length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 font-mono text-xs" style={{ letterSpacing: "0.1em" }}>
        <div className="flex items-center gap-6">
          <span className="tabular-nums text-[var(--color-text-muted)]">
            {totalRemaining} / {(queue?.auto_cleared.length ?? 0) + (queue?.flagged.length ?? 0) + (queue?.held.length ?? 0)} records
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--color-success)]" />
            Auto-cleared <span className="tabular-nums">{filteredQueue.counts.auto_cleared}</span>
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--color-warning)]" />
            Flagged <span className="tabular-nums">{filteredQueue.counts.flagged}</span>
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--color-danger)]" />
            Held <span className="tabular-nums">{filteredQueue.counts.held}</span>
          </span>
          <span className="text-[var(--color-text-muted)]">
            ↑↓ nav · A approve · R reject
          </span>
        </div>
        {queue && queue.aggregation_risks.length > 0 && (
          <button
            onClick={() => setShowAggregation((v) => !v)}
            className={clsx(
              "rounded-sm border px-2 py-[2px] font-semibold uppercase transition-colors",
              showAggregation
                ? "border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning-muted)_25%,var(--color-surface))] text-[var(--color-warning)]"
                : "border-[var(--color-warning)] text-[var(--color-warning)] hover:bg-[color-mix(in_oklab,var(--color-warning-muted)_15%,transparent)]",
            )}
            style={{ letterSpacing: "0.16em" }}
          >
            {queue.aggregation_risks.length} aggregation risk{queue.aggregation_risks.length === 1 ? "" : "s"}
          </button>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className={clsx("flex flex-1 overflow-hidden", selectedRecord && "pr-0")}>
          <ReviewColumn
            title="Auto-cleared"
            accent="var(--color-success)"
            records={filteredQueue.auto_cleared}
            selectedIdx={selected?.col === "auto_cleared" ? selected.idx : null}
            onSelect={(idx) => setSelected({ col: "auto_cleared", idx })}
            bulkAction="Approve all"
            onBulk={() => runBulk("auto_cleared", "approve")}
            bulkRunning={bulkRunning}
            onApprove={(sr) => resolveOne(sr, "approve")}
            onReject={(sr) => resolveOne(sr, "reject")}
          />
          <ReviewColumn
            title="Flagged"
            accent="var(--color-warning)"
            records={filteredQueue.flagged}
            selectedIdx={selected?.col === "flagged" ? selected.idx : null}
            onSelect={(idx) => setSelected({ col: "flagged", idx })}
            bulkAction="Approve remaining"
            onBulk={() => runBulk("flagged", "approve")}
            bulkRunning={bulkRunning}
            onApprove={(sr) => resolveOne(sr, "approve")}
            onReject={(sr) => resolveOne(sr, "reject")}
          />
          <ReviewColumn
            title="Held"
            accent="var(--color-danger)"
            records={filteredQueue.held}
            selectedIdx={selected?.col === "held" ? selected.idx : null}
            onSelect={(idx) => setSelected({ col: "held", idx })}
            onApprove={(sr) => resolveOne(sr, "approve")}
            onReject={(sr) => resolveOne(sr, "reject")}
          />
        </div>

        {selectedRecord && (
          <InspectorPane
            record={selectedRecord}
            onApprove={() => resolveOne(selectedRecord.sr_number, "approve")}
            onReject={() => resolveOne(selectedRecord.sr_number, "reject")}
            onClose={() => setSelected(null)}
          />
        )}
      </div>

      {showAggregation && queue && (
        <AggregationRiskPanel risks={queue.aggregation_risks} onClose={() => setShowAggregation(false)} />
      )}
    </div>
  );
}

function ReviewColumn({
  title,
  accent,
  records,
  selectedIdx,
  onSelect,
  bulkAction,
  onBulk,
  bulkRunning,
  onApprove,
  onReject,
}: {
  title: string;
  accent: string;
  records: any[];
  selectedIdx: number | null;
  onSelect: (idx: number) => void;
  bulkAction?: string;
  onBulk?: () => void;
  bulkRunning?: boolean;
  onApprove: (sr: string) => void;
  onReject: (sr: string) => void;
}) {
  return (
    <div className="flex w-1/3 flex-col overflow-hidden border-r border-[var(--color-border)] last:border-r-0">
      <div
        className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2"
        style={{ background: `color-mix(in oklab, ${accent} 12%, var(--color-surface))` }}
      >
        <div className="flex items-center gap-2 font-mono text-sm font-semibold uppercase" style={{ color: accent, letterSpacing: "0.16em" }}>
          <span className="h-2 w-2 rounded-full" style={{ background: accent, boxShadow: `0 0 5px ${accent}` }} />
          {title}
          <span className="font-mono text-sm tabular-nums text-[var(--color-text-muted)]">({records.length})</span>
        </div>
        {bulkAction && records.length > 0 && (
          <button
            onClick={onBulk}
            disabled={bulkRunning}
            className="rounded-sm border border-[var(--color-border-active)] px-2 py-[2px] font-mono text-xs font-semibold uppercase text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] disabled:opacity-40"
            style={{ letterSpacing: "0.16em" }}
          >
            {bulkRunning ? "…" : bulkAction}
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {records.map((r, idx) => (
          <ReviewCard
            key={r.sr_number}
            record={r}
            selected={selectedIdx === idx}
            onClick={() => onSelect(idx)}
            onApprove={() => onApprove(r.sr_number)}
            onReject={() => onReject(r.sr_number)}
          />
        ))}
        {records.length === 0 && (
          <div className="p-4 text-center font-mono text-xs text-[var(--color-text-muted)]" style={{ letterSpacing: "0.1em" }}>
            EMPTY
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewCard({
  record,
  selected,
  onClick,
  onApprove,
  onReject,
}: {
  record: any;
  selected: boolean;
  onClick: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const detected = record.detected_classification;
  const detectedColor = CLASS_COLOR[detected] ?? "var(--color-text-secondary)";
  return (
    <div
      onClick={onClick}
      className={clsx(
        "group relative mb-2 cursor-pointer overflow-hidden rounded-sm border bg-[var(--color-surface)] transition-all",
        selected
          ? "border-[var(--color-primary)] shadow-[0_0_0_1px_var(--color-primary)]"
          : "border-[var(--color-border)] hover:border-[var(--color-border-active)]",
      )}
    >
      {/* Banner-style classification stripe — DoDM 5200.01 convention */}
      <div
        className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1 font-mono text-sm font-semibold uppercase"
        style={{
          background: `color-mix(in oklab, ${detectedColor} 14%, var(--color-bg))`,
          color: detectedColor,
          letterSpacing: "0.16em",
        }}
      >
        <span className="h-3 w-1 rounded-[1px]" style={{ background: detectedColor }} />
        <span>{detected}</span>
        <span className="text-[var(--color-text-muted)]">←</span>
        <span className="text-[var(--color-text-muted)]">{record.source_classification}</span>
        {record.classification_discrepancy && (
          <span className="ml-auto rounded-sm border border-[var(--color-danger)] px-1 text-xs" style={{ color: "var(--color-danger)" }}>
            MIS-MARKED
          </span>
        )}
      </div>
      <div className="px-2 py-2">
        <div className="mb-1 flex items-center gap-2 font-mono text-xs" style={{ letterSpacing: "0.08em" }}>
          <span className="text-[var(--color-text)]">{record.sr_number}</span>
          <span className="text-[var(--color-text-muted)]">· {record.equipment_type}</span>
          <span className="text-[var(--color-text-muted)]">· {record.unit_name}</span>
        </div>
        <div className="line-clamp-2 text-sm text-[var(--color-text-secondary)]">{record.remark}</div>
        <div className="mt-1.5 flex items-center gap-1 text-xs">
          {(record.flags || []).map((f: string) => (
            <span
              key={f}
              className="rounded-sm border px-1 py-[1px] font-mono font-semibold uppercase"
              style={{
                color: FLAG_COLOR[f] || "var(--color-text-muted)",
                borderColor: `color-mix(in oklab, ${FLAG_COLOR[f] || "#666"} 40%, var(--color-border))`,
                background: `color-mix(in oklab, ${FLAG_COLOR[f] || "#666"} 12%, transparent)`,
                letterSpacing: "0.14em",
              }}
            >
              {f}
            </span>
          ))}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onApprove();
            }}
            title="Approve (A)"
            className="ml-auto rounded border border-[var(--color-success-muted)] px-2 py-0.5 font-mono font-semibold text-[var(--color-success)] hover:bg-[var(--color-success-muted)]"
          >
            ✓
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onReject();
            }}
            title="Reject (R)"
            className="rounded border border-[var(--color-danger-muted)] px-2 py-0.5 font-mono font-semibold text-[var(--color-danger)] hover:bg-[var(--color-danger-muted)]"
          >
            ✗
          </button>
        </div>
      </div>
    </div>
  );
}

// Detail inspector — full record with colored highlights + rule names + audit.
// Renders to the right of the three columns. Width ≈ 28rem so columns stay
// usable during review.
function InspectorPane({
  record,
  onApprove,
  onReject,
  onClose,
}: {
  record: any;
  onApprove: () => void;
  onReject: () => void;
  onClose: () => void;
}) {
  const highlights: { start: number; end: number; category: string }[] = record.highlights || [];
  const remark: string = record.remark || "";
  const segments: { text: string; category?: string }[] = [];
  let cursor = 0;
  const sorted = [...highlights].sort((a, b) => a.start - b.start);
  for (const h of sorted) {
    if (h.start > cursor) segments.push({ text: remark.slice(cursor, h.start) });
    segments.push({ text: remark.slice(h.start, h.end), category: h.category });
    cursor = h.end;
  }
  if (cursor < remark.length) segments.push({ text: remark.slice(cursor) });

  const detected = record.detected_classification;
  const detectedColor = CLASS_COLOR[detected] ?? "var(--color-text-secondary)";

  return (
    <aside className="flex w-[28rem] shrink-0 flex-col overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex items-start justify-between">
          <div>
            <div
              className="font-mono text-xs uppercase text-[var(--color-text-muted)]"
              style={{ letterSpacing: "0.22em" }}
            >
              Record Inspector
            </div>
            <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--color-text)]" style={{ letterSpacing: "0.04em" }}>
              {record.sr_number}
            </div>
            <div className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
              {record.unit_name} · {record.equipment_type}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-4 p-4">
        {/* Classification banner */}
        <div
          className="rounded-sm border-l-4 py-2 pl-3 pr-2 font-mono text-base font-semibold uppercase"
          style={{
            borderLeftColor: detectedColor,
            background: `color-mix(in oklab, ${detectedColor} 14%, var(--color-bg))`,
            color: detectedColor,
            letterSpacing: "0.18em",
          }}
        >
          {detected} <span className="text-[var(--color-text-muted)]">← {record.source_classification}</span>
          {record.classification_discrepancy && (
            <span className="ml-2 text-xs text-[var(--color-danger)]">MIS-MARKED</span>
          )}
        </div>

        {/* Remark with colored highlights */}
        <section>
          <div
            className="mb-1 font-mono text-xs uppercase text-[var(--color-text-muted)]"
            style={{ letterSpacing: "0.22em" }}
          >
            Remark · Highlighted
          </div>
          <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-base leading-relaxed text-[var(--color-text)]">
            {segments.map((s, i) =>
              s.category ? (
                <span
                  key={i}
                  className="rounded-sm px-0.5"
                  style={{
                    background: `color-mix(in oklab, ${FLAG_COLOR[s.category] || "#fff"} 28%, transparent)`,
                    color: FLAG_COLOR[s.category] || "inherit",
                  }}
                >
                  {s.text}
                </span>
              ) : (
                <span key={i}>{s.text}</span>
              ),
            )}
          </div>
        </section>

        {/* Evidence table: each highlight with its rule + category */}
        {highlights.length > 0 && (
          <section>
            <div
              className="mb-1 font-mono text-xs uppercase text-[var(--color-text-muted)]"
              style={{ letterSpacing: "0.22em" }}
            >
              Evidence · Rules Fired
            </div>
            <div className="overflow-hidden rounded-sm border border-[var(--color-border)]">
              {sorted.map((h: any, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm last:border-b-0"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="rounded-sm border px-1 font-mono text-xs font-semibold uppercase"
                      style={{
                        color: FLAG_COLOR[h.category] || "var(--color-text-muted)",
                        borderColor: `color-mix(in oklab, ${FLAG_COLOR[h.category] || "#666"} 40%, var(--color-border))`,
                        letterSpacing: "0.14em",
                      }}
                    >
                      {h.category}
                    </span>
                    <span className="font-mono text-[var(--color-text)]">{h.rule || h.pattern || "pattern match"}</span>
                  </div>
                  <span className="font-mono tabular-nums text-[var(--color-text-muted)]">
                    [{h.start}-{h.end}]
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Routing + confidence */}
        <section>
          <div
            className="mb-1 font-mono text-xs uppercase text-[var(--color-text-muted)]"
            style={{ letterSpacing: "0.22em" }}
          >
            Routing
          </div>
          <div className="flex items-center gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base">
            <span className="font-mono text-[var(--color-text)]">
              {record.routed_to === "tier2_llm" ? "Tier 2 · LLM gate" : "Tier 1 · regex ensemble"}
            </span>
            <span className="text-[var(--color-text-muted)]">·</span>
            <span className="font-mono tabular-nums text-[var(--color-text-secondary)]">
              confidence {(record.confidence ?? 0).toFixed(2)}
            </span>
          </div>
        </section>
      </div>

      <div className="sticky bottom-0 z-10 flex items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <button
          onClick={onApprove}
          className="flex-1 rounded-sm border border-[var(--color-success)] bg-[color-mix(in_oklab,var(--color-success-muted)_30%,var(--color-surface))] px-3 py-2 font-mono text-sm font-semibold uppercase text-[var(--color-success)] hover:bg-[var(--color-success)] hover:text-white"
          style={{ letterSpacing: "0.18em" }}
        >
          ✓ Approve (A)
        </button>
        <button
          onClick={onReject}
          className="flex-1 rounded-sm border border-[var(--color-danger)] bg-[color-mix(in_oklab,var(--color-danger-muted)_30%,var(--color-surface))] px-3 py-2 font-mono text-sm font-semibold uppercase text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white"
          style={{ letterSpacing: "0.18em" }}
        >
          ✗ Reject (R)
        </button>
      </div>
    </aside>
  );
}

function AggregationRiskPanel({
  risks,
  onClose,
}: {
  risks: any[];
  onClose: () => void;
}) {
  // Matrix unit × equipment_type — a cell exists when an aggregation risk is
  // flagged for that pair. Visual clustering makes the pattern jump out at a
  // glance instead of hiding in 3 text lines of a footer stripe.
  const units = Array.from(new Set(risks.map((r) => r.unit))).sort();
  const equipTypes = Array.from(new Set(risks.map((r) => r.equipment_type))).sort();
  const cell = new Map<string, any>();
  for (const r of risks) cell.set(`${r.unit}::${r.equipment_type}`, r);

  return (
    <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning-muted)_12%,var(--color-surface))] p-3">
      <div className="mb-2 flex items-center justify-between">
        <div
          className="font-mono text-sm font-semibold uppercase text-[var(--color-warning)]"
          style={{ letterSpacing: "0.2em" }}
        >
          Aggregation Risk Matrix · {risks.length} findings
        </div>
        <button
          onClick={onClose}
          className="font-mono text-xs uppercase text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          style={{ letterSpacing: "0.16em" }}
        >
          Hide ✕
        </button>
      </div>
      <div className="overflow-auto">
        <table className="min-w-full border-collapse font-mono text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-[var(--color-surface)] p-1 text-left text-[var(--color-text-muted)]" style={{ letterSpacing: "0.1em" }}>
                UNIT \ EQUIP
              </th>
              {equipTypes.map((e) => (
                <th
                  key={e}
                  className="p-1 text-left text-xs text-[var(--color-text-muted)]"
                  style={{ letterSpacing: "0.14em", transform: "rotate(-25deg)", height: 60, verticalAlign: "bottom" }}
                >
                  {e}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr key={u}>
                <td className="sticky left-0 z-10 whitespace-nowrap bg-[var(--color-surface)] px-2 py-[2px] text-[var(--color-text)]">
                  {u}
                </td>
                {equipTypes.map((e) => {
                  const r = cell.get(`${u}::${e}`);
                  if (!r) {
                    return (
                      <td key={e} className="border border-[var(--color-border)] bg-[var(--color-bg)] p-0" style={{ height: 22, width: 22 }} />
                    );
                  }
                  return (
                    <td
                      key={e}
                      title={r.warning}
                      className="cursor-help border border-[color-mix(in_oklab,var(--color-warning)_40%,var(--color-border))]"
                      style={{
                        height: 22,
                        width: 22,
                        background: "color-mix(in oklab, var(--color-warning) 40%, var(--color-bg))",
                        boxShadow: "inset 0 0 4px color-mix(in oklab, var(--color-warning) 30%, transparent)",
                      }}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 max-h-40 overflow-y-auto font-mono text-xs" style={{ letterSpacing: "0.04em" }}>
        {risks.map((r, i) => (
          <div key={i} className="py-0.5">
            <span className="text-[var(--color-text)]">{r.unit}</span>
            <span className="text-[var(--color-text-muted)]"> / </span>
            <span className="text-[var(--color-text)]">{r.equipment_type}</span>
            <span className="text-[var(--color-text-muted)]"> — {r.warning}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="flex h-full items-center justify-center p-12 text-sm text-[var(--color-text-muted)]">
      {msg}
    </div>
  );
}
