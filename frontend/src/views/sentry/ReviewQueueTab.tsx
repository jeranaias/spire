import { useEffect, useState } from "react";
import clsx from "clsx";
import { api, type SentryReviewQueue } from "../../api";
import type { SentryContext } from "../SentryView";

type Column = "auto_cleared" | "flagged" | "held";

export function ReviewQueueTab({ ctx }: { ctx: SentryContext }) {
  const [queue, setQueue] = useState<SentryReviewQueue | null>(null);
  const [selected, setSelected] = useState<{ col: Column; idx: number } | null>(null);

  useEffect(() => {
    if (!ctx.batchId) return;
    api.sentry.reviewQueue(ctx.batchId).then(setQueue);
  }, [ctx.batchId]);

  if (!ctx.batchId) {
    return <Empty msg="No processed batch. Load + process one first." />;
  }
  if (!queue) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-secondary)]">Loading review queue ...</div>;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-xs">
        <div className="flex items-center gap-6">
          <span className="text-[var(--color-text-muted)]">
            {queue.auto_cleared.length + queue.flagged.length + queue.held.length} records
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--color-success)]" />
            Auto-cleared {queue.counts.auto_cleared}
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--color-warning)]" />
            Flagged {queue.counts.flagged}
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--color-danger)]" />
            Held {queue.counts.held}
          </span>
          {queue.aggregation_risks.length > 0 && (
            <span className="ml-auto rounded-sm bg-[var(--color-warning-muted)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-warning)]">
              {queue.aggregation_risks.length} aggregation risk{queue.aggregation_risks.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <ReviewColumn
          title="Auto-cleared"
          accent="var(--color-success)"
          records={queue.auto_cleared}
          selectedIdx={selected?.col === "auto_cleared" ? selected.idx : null}
          onSelect={(idx) => setSelected({ col: "auto_cleared", idx })}
          bulkAction="Approve all"
        />
        <ReviewColumn
          title="Flagged"
          accent="var(--color-warning)"
          records={queue.flagged}
          selectedIdx={selected?.col === "flagged" ? selected.idx : null}
          onSelect={(idx) => setSelected({ col: "flagged", idx })}
          bulkAction="Approve remaining"
        />
        <ReviewColumn
          title="Held"
          accent="var(--color-danger)"
          records={queue.held}
          selectedIdx={selected?.col === "held" ? selected.idx : null}
          onSelect={(idx) => setSelected({ col: "held", idx })}
        />
      </div>

      {queue.aggregation_risks.length > 0 && (
        <AggregationRiskPanel risks={queue.aggregation_risks} />
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
}: {
  title: string;
  accent: string;
  records: any[];
  selectedIdx: number | null;
  onSelect: (idx: number) => void;
  bulkAction?: string;
}) {
  return (
    <div className="flex w-1/3 flex-col overflow-hidden border-r border-[var(--color-border)] last:border-r-0">
      <div
        className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2"
        style={{ background: `color-mix(in oklab, ${accent} 12%, var(--color-surface))` }}
      >
        <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: accent }}>
          <span className="h-2 w-2 rounded-full" style={{ background: accent }} />
          {title}
          <span className="font-mono text-xs tabular-nums text-[var(--color-text-muted)]">({records.length})</span>
        </div>
        {bulkAction && records.length > 0 && (
          <button className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            {bulkAction}
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
          />
        ))}
        {records.length === 0 && (
          <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">Empty.</div>
        )}
      </div>
    </div>
  );
}

function ReviewCard({ record, selected, onClick }: { record: any; selected: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className={clsx(
        "mb-2 cursor-pointer rounded-sm border bg-[var(--color-surface)] px-2 py-2 text-xs transition-colors",
        selected
          ? "border-[var(--color-primary)] bg-[var(--color-surface-hover)]"
          : "border-[var(--color-border)] hover:border-[var(--color-border-active)] hover:bg-[var(--color-surface-hover)]",
      )}
    >
      <div className="mb-1 flex items-center gap-2 text-[10px]">
        <span className="font-mono text-[var(--color-text)]">{record.sr_number}</span>
        <span className="text-[var(--color-text-muted)]">· {record.equipment_type}</span>
        <span className="ml-auto font-mono">
          <span className="text-[var(--color-text-muted)]">{record.source_classification} →</span>{" "}
          <span
            style={{
              color:
                record.detected_classification === "UNCLASSIFIED"
                  ? "var(--color-success)"
                  : record.detected_classification === "CUI"
                    ? "var(--color-warning)"
                    : "var(--color-danger)",
            }}
          >
            {record.detected_classification}
          </span>
        </span>
      </div>
      <div className="line-clamp-2 text-[var(--color-text-secondary)]">{record.remark}</div>
      <div className="mt-1 flex items-center gap-1 text-[10px]">
        {(record.flags || []).map((f: string) => (
          <span
            key={f}
            className="rounded-sm px-1 font-mono"
            style={{
              color: `var(--color-${f === "pii" ? "info" : f === "classified" ? "danger" : "warning"})`,
              background: "color-mix(in oklab, currentColor 15%, transparent)",
            }}
          >
            {f}
          </span>
        ))}
        <button
          onClick={(e) => {
            e.stopPropagation();
            api.sentry.review(record.sr_number, "approve");
          }}
          className="ml-auto rounded border border-[var(--color-success-muted)] px-2 py-0.5 text-[var(--color-success)] hover:bg-[var(--color-success-muted)]"
        >
          ✓
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            api.sentry.review(record.sr_number, "reject");
          }}
          className="rounded border border-[var(--color-danger-muted)] px-2 py-0.5 text-[var(--color-danger)] hover:bg-[var(--color-danger-muted)]"
        >
          ✗
        </button>
      </div>
    </div>
  );
}

function AggregationRiskPanel({ risks }: { risks: any[] }) {
  return (
    <div className="shrink-0 border-t border-[var(--color-warning-muted)] bg-[color-mix(in_oklab,var(--color-warning-muted)_10%,var(--color-surface))] p-3">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-warning)]">
        Aggregation risks detected ({risks.length})
      </div>
      {risks.slice(0, 3).map((r, i) => (
        <div key={i} className="text-xs text-[var(--color-text-secondary)]">
          <span className="font-mono text-[var(--color-text)]">{r.unit}</span> /{" "}
          <span className="font-mono">{r.equipment_type}</span>: {r.warning}
        </div>
      ))}
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
