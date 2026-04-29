import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { api, type SentryReviewQueue } from "../../api";
import { formatApiError } from "../../api-retry";
import type { SentryContext } from "../SentryView";
import { useSpireStore } from "../../state/store";
import type { Role } from "../../state/store";
import {
  Button,
  IconButton,
  ErrorState,
  EmptyState,
  LoadingState,
  fireIdempotent,
  pushUndoToast,
} from "../../components/ui";
import {
  CLASS_RANK,
  CLASS_LABEL,
  CLASS_COLOR as CAPCO_COLOR,
  normalizeClassification,
  useClearance,
} from "../../components/classification";

// Walkthrough #34 — bulk-approve gates. Hard-cap below requires only modal
// click; ≥ TYPED_CONFIRM_THRESHOLD requires the operator to type the literal
// `APPROVE N` / `REJECT N` string before the action fires. Mirrors the
// destructive-confirmation pattern used elsewhere for secure-wipe.
const BULK_TYPED_CONFIRM_THRESHOLD = 50;

// PII span categories that the inspector masks by default. `geo` (MGRS) and
// `pii` (EDIPI / SSN4 / POC / ext) carry persistent identifiers; `controlled`
// (USA/USMC serials) is operationally sensitive but not PII per se. The
// presenter "REDACTED for projection" toggle masks all categories regardless.
const PII_MASK_CATEGORIES = new Set(["pii", "geo"]);

type Column = "auto_cleared" | "flagged" | "held";
type Action = "approve" | "reject";

const FLAG_COLOR: Record<string, string> = {
  pii: "var(--color-info)",
  geo: "var(--color-primary)",
  comms: "var(--color-warning)",
  classified: "var(--color-danger)",
  controlled: "#fb923c",
};

// Demo build: collapse the SECRET / TOP_SECRET swatches into the CUI
// warning color so the queue never paints a danger-red row. Synthetic
// dataset only emits UNCLASSIFIED + CUI today.
const CLASS_COLOR: Record<string, string> = {
  UNCLASSIFIED: "var(--color-success)",
  CUI: "var(--color-warning)",
  CONFIDENTIAL: "var(--color-warning)",
  SECRET: "var(--color-warning)",
  TOP_SECRET: "var(--color-warning)",
};

// Walkthrough #11 — describe each Held reason so badges have hover detail
// and operators can triage by reason rather than by mass-repeated discrepancy.
const HELD_REASON_DESCRIPTION: Record<string, string> = {
  classification_discrepancy: "Source marking and detected marking diverge — review for correctness.",
  ambiguous_pii: "Possible PII without supporting context (no EDIPI/SSN/phone). Could be a false positive.",
  novel_pattern: "Combination of evidence (controlled item + grid) the engine has not seen before.",
  low_confidence_evidence: "Multiple flag categories but classifier confidence is below 0.90.",
};

export function ReviewQueueTab({ ctx }: { ctx: SentryContext }) {
  const [queue, setQueue] = useState<SentryReviewQueue | null>(null);
  // Records resolved locally via optimistic removal so the view doesn't depend
  // on a refetch. Shape: { sr_number: "approve" | "reject" }.
  const [resolved, setResolved] = useState<Record<string, Action>>({});
  const [selected, setSelected] = useState<{ col: Column; idx: number } | null>(null);
  const [showAggregation, setShowAggregation] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  // Surfacing the load failure was missing — backend would 400 on a stale
  // role param mismatch and the view would sit on "Loading review queue ..."
  // forever. Tracked separately from `queue` so the retry button has its own
  // affordance + the loading state is unambiguous.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const role = useSpireStore((s) => s.role) as Role;
  const pushToast = useSpireStore((s) => s.pushToast);

  useEffect(() => {
    if (!ctx.batchId) return;
    let cancelled = false;
    setQueue(null);
    setLoadError(null);
    api.sentry
      .reviewQueue(ctx.batchId)
      .then((q) => {
        if (cancelled) return;
        setQueue(q);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(formatApiError(e));
      });
    return () => {
      cancelled = true;
    };
    // Refetch on role swap so the URL/store are always in sync; previously a
    // role change after first load left the queue stale and any in-flight
    // request rejected by the backend's role-scoping filter.
  }, [ctx.batchId, role, retryCount]);

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

  // Wrapped in fireIdempotent — triple-tapping Approve on the same SR
  // emits exactly one /review request. Keyed per (sr, action) so a
  // subsequent Reject on the same SR after Approve is a different key
  // and is allowed through.
  const resolveOne = useCallback(
    async (sr: string, action: Action) =>
      fireIdempotent(`sentry:review:${sr}:${action}`, async () => {
        setResolved((prev) => ({ ...prev, [sr]: action }));
        try {
          await api.sentry.review(sr, action);
          // Destructive contract: route through pushUndoToast so the
          // ≥5s undo floor is enforced (the store's default TTL is 3s,
          // which is below the W0 spec).
          pushUndoToast({
            tone: action === "approve" ? "ok" : "warn",
            text: `${sr} ${action === "approve" ? "approved" : "rejected"}`,
            onUndo: () => {
              setResolved((prev) => {
                const next = { ...prev };
                delete next[sr];
                return next;
              });
              fireIdempotent(
                `sentry:review:${sr}:${action === "approve" ? "reject" : "approve"}`,
                () => api.sentry.review(sr, action === "approve" ? "reject" : "approve"),
              ).catch(() => {});
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
      }),
    [pushToast],
  );

  // Walkthrough #22 — confirmation modal for bulk-approve. The action sits
  // dangerously close to the column-header bulk button; a misclick used to
  // fire the bulk approval with no audit prompt. Now we stage the request
  // and surface a confirmation modal that names the count + audit posture.
  const [bulkConfirm, setBulkConfirm] = useState<{ col: Column; action: Action; count: number } | null>(null);

  const runBulk = useCallback(
    async (col: Column, action: Action) => {
      if (!filteredQueue || bulkRunning) return;
      const items: any[] = (filteredQueue as any)[col];
      if (!items || items.length === 0) return;
      setBulkRunning(true);
      pushToast({ tone: "info", text: `Processing ${items.length} records…`, ttlMs: 5000 });
      // Capture the SR list so the undo handler can revert resolved-state
      // and emit a counter-action without re-reading column state.
      const srNumbers = items.map((r) => r.sr_number as string);
      // Optimistic bulk: mark all resolved immediately, then fire one
      // server-side bulk request that writes ONE chained audit entry
      // naming every SR (vs the prior fan-out of N independent rows).
      setResolved((prev) => {
        const next = { ...prev };
        for (const sr of srNumbers) next[sr] = action;
        return next;
      });
      try {
        await fireIdempotent(
          `sentry:review:bulk:${col}:${action}:${srNumbers.length}:${srNumbers[0] ?? ""}`,
          () => api.sentry.reviewBulk(action, srNumbers, col),
        ).catch((err) => {
          // Roll back on failure so the queue redraws and the operator can retry.
          setResolved((prev) => {
            const next = { ...prev };
            for (const sr of srNumbers) delete next[sr];
            return next;
          });
          pushToast({ tone: "error", text: `Bulk ${action} failed: ${formatApiError(err)}` });
          throw err;
        });
        // Destructive contract: bulk approve/reject also gets an undo toast
        // with the ≥5s floor. Undo fires the inverse bulk request (one entry,
        // not N) and clears local resolved state.
        pushUndoToast({
          tone: action === "approve" ? "ok" : "warn",
          text: `${items.length} records ${action === "approve" ? "approved" : "rejected"} · 1 audit entry`,
          onUndo: () => {
            const inverse: Action = action === "approve" ? "reject" : "approve";
            setResolved((prev) => {
              const next = { ...prev };
              for (const sr of srNumbers) delete next[sr];
              return next;
            });
            fireIdempotent(
              `sentry:review:bulk:${col}:${inverse}:${srNumbers.length}:${srNumbers[0] ?? ""}:undo`,
              () => api.sentry.reviewBulk(inverse, srNumbers, col, "undo"),
            ).catch(() => {});
          },
        });
      } catch {
        // Already toasted in the catch above; swallow so React doesn't log.
      } finally {
        setBulkRunning(false);
      }
    },
    [filteredQueue, bulkRunning, pushToast],
  );

  // Walkthrough #22 — bulk action goes through the confirmation modal.
  const requestBulk = useCallback(
    (col: Column, action: Action) => {
      if (!filteredQueue) return;
      const items: any[] = (filteredQueue as any)[col];
      if (!items || items.length === 0) return;
      setBulkConfirm({ col, action, count: items.length });
    },
    [filteredQueue],
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

  // Walkthrough #35 — page classification banner. Reflects the highest
  // classification across every record currently visible (auto_cleared +
  // flagged + held + the inspector selection), mirroring the export-banner
  // pattern in `backend/routes/sentry.py:831`. Re-derives on every queue
  // mutation so resolving the last SECRET record drops the page back to CUI
  // automatically — the banner cannot lie about what the operator is
  // actually staring at. Declared *before* the loading/error early-returns
  // so React's hook order stays stable across renders.
  const pageClassification = useMemo(() => {
    let bestRank = 0;
    let bestKey = "UNCLASSIFIED";
    const consider = (raw: any) => {
      if (!raw) return;
      const norm = normalizeClassification(String(raw));
      const r = CLASS_RANK[norm];
      if (r > bestRank) {
        bestRank = r;
        bestKey = norm;
      }
    };
    const sweep = (xs: any[] | undefined) => {
      if (!xs) return;
      for (const r of xs) {
        consider(r.detected_classification);
        consider(r.source_classification);
      }
    };
    if (filteredQueue) {
      sweep(filteredQueue.auto_cleared);
      sweep(filteredQueue.flagged);
      sweep(filteredQueue.held);
      if (selected) {
        const list: any[] = (filteredQueue as any)[selected.col] ?? [];
        const rec = list[selected.idx];
        if (rec) {
          consider(rec.detected_classification);
          consider(rec.source_classification);
        }
      }
    }
    return bestKey as keyof typeof CAPCO_COLOR;
  }, [filteredQueue, selected]);

  if (!ctx.batchId) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <EmptyState
          title="No processed batch"
          description="Load and process a batch from the Upload tab to populate the review queue."
        />
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <ErrorState
          title="Review queue failed to load"
          description="Backend rejected the queue request. This is usually a stale role scope — switch role and back, or click retry."
          detail={loadError}
          onRetry={() => setRetryCount((n) => n + 1)}
        />
      </div>
    );
  }
  if (!filteredQueue) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingState size="page" label="Loading review queue …" />
      </div>
    );
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
      {/* Walkthrough #35 — top sticky classification banner (CAPCO color
          block per DoDM 5200.01). Mirrored at the bottom of the page so a
          screenshot from any scroll position carries marking. */}
      <ClassificationStripe classification={pageClassification} position="top" />

      <div className="sticky top-0 z-[40] flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 font-mono text-xs tracking-wider">
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
            {/* Walkthrough #27 — Held = red end-to-end. Header strip dot
                used to show orange while card borders + the column accent
                were red, which read as two different states. */}
            <span
              className="mr-1 inline-block h-2 w-2 rounded-full bg-[var(--color-danger)]"
              style={{ boxShadow: "0 0 4px var(--color-danger)" }}
            />
            Held <span className="tabular-nums">{filteredQueue.counts.held}</span>
          </span>
          <span className="text-[var(--color-text-muted)]">
            ↑↓ nav · A approve · R reject
          </span>
        </div>
        {queue && queue.aggregation_risks.length > 0 && (
          <Button
            onClick={() => setShowAggregation((v) => !v)}
            variant="warning"
            size="sm"
            // Walkthrough #36 — same red glow as the Held column dot so the
            // warning count reads as urgent even before the operator clicks.
            // The matrix also renders inline (left rail) so this button only
            // toggles the prose detail panel and is no longer the only way
            // to surface the matrix.
            style={{
              boxShadow: "0 0 6px color-mix(in oklab, var(--color-danger) 60%, transparent)",
            }}
          >
            {queue.aggregation_risks.length} aggregation risk{queue.aggregation_risks.length === 1 ? "" : "s"}
          </Button>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden tracking-wider">
        {/* Walkthrough #36 — when aggregation_risks fire, the matrix lives
            in the left rail of the queue (always-on, judge-visible) instead
            of being hidden behind a button a 12-second Marine will not
            click. The detail prose panel still toggles below. */}
        {queue && queue.aggregation_risks.length > 0 && (
          <AggregationRiskRail risks={queue.aggregation_risks} />
        )}
        <div className={clsx("flex flex-1 overflow-hidden", selectedRecord && "pr-0")}>
          <ReviewColumn
            title="Auto-cleared"
            accent="var(--color-success)"
            records={filteredQueue.auto_cleared}
            selectedIdx={selected?.col === "auto_cleared" ? selected.idx : null}
            onSelect={(idx) => setSelected({ col: "auto_cleared", idx })}
            bulkAction="Approve all"
            onBulk={() => requestBulk("auto_cleared", "approve")}
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
            onBulk={() => requestBulk("flagged", "approve")}
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

      {/* Walkthrough #20 — aggregation matrix renders matrix-first, prose
          below, anchored at the bottom of the queue. */}
      {showAggregation && queue && (
        <AggregationRiskPanel risks={queue.aggregation_risks} onClose={() => setShowAggregation(false)} />
      )}

      {/* Walkthrough #35 — bottom sticky classification banner. */}
      <ClassificationStripe classification={pageClassification} position="bottom" />

      {/* Walkthrough #22 — bulk-action confirmation modal. */}
      {bulkConfirm && (
        <BulkConfirmModal
          col={bulkConfirm.col}
          action={bulkConfirm.action}
          count={bulkConfirm.count}
          onCancel={() => setBulkConfirm(null)}
          onConfirm={() => {
            const c = bulkConfirm;
            setBulkConfirm(null);
            void runBulk(c.col, c.action);
          }}
        />
      )}
    </div>
  );
}

// Walkthrough #35 — sticky CAPCO classification stripe rendered at the top
// and bottom of the Review Queue page. Required on every screen that
// renders SECRET-adjacent content so a screenshot or projector frame
// always carries marking. Color comes from CAPCO_COLOR in
// components/classification/levels.ts so the stripe matches the badge.
function ClassificationStripe({
  classification,
  position,
}: {
  classification: keyof typeof CAPCO_COLOR;
  position: "top" | "bottom";
}) {
  const colors = CAPCO_COLOR[classification] ?? CAPCO_COLOR.UNCLASSIFIED;
  const label = CLASS_LABEL[classification] ?? "UNCLASSIFIED";
  return (
    <div
      role="status"
      aria-label={`Page classification ${label}`}
      className={clsx(
        "sticky z-[60] flex items-center justify-center font-mono text-[11px] font-bold uppercase tracking-[0.18em]",
        position === "top" ? "top-0" : "bottom-0",
      )}
      style={{
        background: colors.bg,
        color: colors.fg,
        padding: "3px 12px",
        borderTop: position === "bottom" ? "1px solid rgba(0,0,0,0.25)" : undefined,
        borderBottom: position === "top" ? "1px solid rgba(0,0,0,0.25)" : undefined,
      }}
    >
      <span>// {label} //</span>
    </div>
  );
}

// Walkthrough #36 — left-rail aggregation matrix. Renders the unit ×
// equipment_type matrix the same way `AggregationRiskPanel` does, but
// docked into the queue layout so it is visible the moment the page loads
// rather than gated behind a button.
function AggregationRiskRail({ risks }: { risks: any[] }) {
  const units = useMemo(() => Array.from(new Set(risks.map((r) => r.unit))).sort(), [risks]);
  const equipTypes = useMemo(
    () => Array.from(new Set(risks.map((r) => r.equipment_type))).sort(),
    [risks],
  );
  const cell = useMemo(() => {
    const m = new Map<string, any>();
    for (const r of risks) m.set(`${r.unit}::${r.equipment_type}`, r);
    return m;
  }, [risks]);
  return (
    <aside
      className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning-muted)_14%,var(--color-surface))]"
      aria-label="Aggregation risk matrix"
    >
      <div className="border-b border-[color-mix(in_oklab,var(--color-warning)_40%,var(--color-border))] px-2 py-2">
        <div className="flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-widest text-[var(--color-warning)]">
          <span
            className="inline-block h-2 w-2 rounded-full bg-[var(--color-danger)]"
            style={{ boxShadow: "0 0 5px var(--color-danger)" }}
          />
          Agg. risk
          <span className="tabular-nums text-[var(--color-text-muted)]">({risks.length})</span>
        </div>
        <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
          unit × equipment
        </div>
      </div>
      <div className="flex-1 overflow-auto p-2">
        <table className="border-collapse font-mono text-[10px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-transparent p-1 text-left text-[var(--color-text-muted)]" />
              {equipTypes.map((e) => (
                <th
                  key={e}
                  className="p-0 text-left text-[10px] text-[var(--color-text-muted)]"
                  style={{
                    transform: "rotate(-45deg)",
                    transformOrigin: "bottom left",
                    height: 60,
                    width: 14,
                    verticalAlign: "bottom",
                    whiteSpace: "nowrap",
                  }}
                  title={e}
                >
                  {e.length > 18 ? `${e.slice(0, 16)}…` : e}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {units.map((u) => (
              <tr key={u}>
                <td
                  className="sticky left-0 z-10 max-w-[7rem] truncate whitespace-nowrap bg-transparent px-1 py-[1px] text-[var(--color-text)]"
                  title={u}
                >
                  {u}
                </td>
                {equipTypes.map((e) => {
                  const r = cell.get(`${u}::${e}`);
                  if (!r) {
                    return (
                      <td
                        key={e}
                        className="border border-[var(--color-border)] bg-[var(--color-bg)] p-0"
                        style={{ height: 14, width: 14 }}
                      />
                    );
                  }
                  return (
                    <td
                      key={e}
                      title={r.warning}
                      className="cursor-help border border-[color-mix(in_oklab,var(--color-warning)_40%,var(--color-border))]"
                      style={{
                        height: 14,
                        width: 14,
                        background: "color-mix(in oklab, var(--color-danger) 50%, var(--color-bg))",
                        boxShadow: "inset 0 0 4px color-mix(in oklab, var(--color-danger) 40%, transparent)",
                      }}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </aside>
  );
}

// Walkthrough #22 / #34 — confirmation modal so a stray click on the column-
// header bulk button never silently approves 374 records. The earlier modal's
// copy promised "an entry" but the implementation wrote N — fixed: one
// `sentry_bulk_review` chain entry containing the SR list. For counts ≥
// BULK_TYPED_CONFIRM_THRESHOLD the operator must type the literal
// "APPROVE N" / "REJECT N" string, which prevents an accidental enter-press
// from clearing the entire auto-cleared column.
function BulkConfirmModal({
  col,
  action,
  count,
  onCancel,
  onConfirm,
}: {
  col: Column;
  action: Action;
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const verb = action === "approve" ? "approve" : "reject";
  const colLabel = col === "auto_cleared" ? "auto-cleared" : col === "flagged" ? "flagged" : "held";
  const requireTyped = count >= BULK_TYPED_CONFIRM_THRESHOLD;
  const typedTarget = `${action.toUpperCase()} ${count}`;
  const [typed, setTyped] = useState("");
  const canConfirm = !requireTyped || typed.trim() === typedTarget;
  return (
    <div
      className="fixed inset-0 z-[8500] flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-xl"
      >
        <div className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--color-warning)]">
          Confirm Bulk {action === "approve" ? "Approval" : "Rejection"}
        </div>
        <div className="mt-2 spire-body text-sm">
          {action === "approve" ? "Approve" : "Reject"} all <strong>{count.toLocaleString("en-US")}</strong>{" "}
          {colLabel} records?
        </div>
        <div className="mt-2 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
          One <span className="text-[var(--color-text)]">sentry_bulk_review</span> entry
          containing every SR will be written to the SHA-256 chained audit
          log. Individual undo is available for ≥5 s after this completes.
        </div>
        {requireTyped && (
          <div className="mt-3">
            <div className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-danger)]">
              Type <span className="rounded-sm bg-[var(--color-danger-muted)] px-1 text-[var(--color-text)]">{typedTarget}</span> to confirm
            </div>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={typedTarget}
              aria-label={`Type ${typedTarget} to confirm bulk ${verb}`}
              className="mt-1 w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-sm tracking-wider text-[var(--color-text)] outline-none focus:border-[var(--color-danger)]"
            />
            <div className="mt-1 font-mono text-[10px] tracking-wider text-[var(--color-text-muted)]">
              Bulk size ≥ {BULK_TYPED_CONFIRM_THRESHOLD} requires typed confirmation. The string is exact-match (case + space).
            </div>
          </div>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button onClick={onCancel} variant="secondary" size="sm">
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={!canConfirm}
            variant="primary"
            size="sm"
            className={clsx(
              action === "approve"
                ? "border-[var(--color-success)] bg-[var(--color-success)] hover:brightness-110"
                : "border-[var(--color-danger)] bg-[var(--color-danger)] hover:brightness-110",
              !canConfirm && "cursor-not-allowed opacity-50",
            )}
          >
            Confirm {verb} {count.toLocaleString("en-US")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Walkthrough #28 — differentiate the badge by severity. Marking errors
// (UNCLASSIFIED → CUI) are warning orange; spillage risks (UNCLASSIFIED
// → SECRET) are danger red and louder. Keeps the text label distinct so
// the audit trail shows the *kind* of mismatch, not just "MIS-MARKED".
function MismatchBadge({ severity }: { severity: string }) {
  const isSpillage = severity === "spillage_risk";
  const color = isSpillage ? "var(--color-danger)" : "var(--color-warning)";
  const label = isSpillage ? "SPILLAGE RISK" : "MARKING ERROR";
  return (
    <span
      className="ml-auto rounded-sm border px-1 font-semibold tracking-wider"
      style={{
        color,
        borderColor: color,
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
        boxShadow: isSpillage ? `0 0 6px ${color}` : undefined,
      }}
      title={
        isSpillage
          ? "Source marked UNCLASSIFIED but engine recommends SECRET-or-higher. Potential spillage."
          : "Source marking does not match recommended marking. Likely under-marking error."
      }
    >
      {label}
    </span>
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
        <div className="flex items-center gap-2 font-mono text-sm font-semibold uppercase tracking-wider" style={{ color: accent }}>
          <span className="h-2 w-2 rounded-full" style={{ background: accent, boxShadow: `0 0 5px ${accent}` }} />
          {title}
          <span className="font-mono text-sm tabular-nums text-[var(--color-text-muted)]">({records.length})</span>
        </div>
        {bulkAction && records.length > 0 && (
          <Button onClick={onBulk} disabled={bulkRunning} pending={bulkRunning} variant="secondary" size="sm">
            {bulkAction}
          </Button>
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
          <div className="p-4 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
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
      {/* Walkthrough #29 — flip the arrow direction so the prose reads
          "orig: UNCLASSIFIED → recommend: CUI" rather than the ambiguous
          "CUI ← UNCLASSIFIED" that scanned as a downgrade. Walkthrough #28
          differentiates marking_error vs spillage_risk badge severity. */}
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] px-2 py-1 font-mono text-xs font-semibold uppercase tracking-wider"
        style={{
          background: `color-mix(in oklab, ${detectedColor} 14%, var(--color-bg))`,
          color: detectedColor,
        }}
      >
        <span className="h-3 w-1 rounded-[1px]" style={{ background: detectedColor }} />
        <span className="text-[var(--color-text-muted)]">orig:</span>
        <span className="text-[var(--color-text)]">{record.source_classification}</span>
        <span className="text-[var(--color-text-muted)]">→</span>
        <span className="text-[var(--color-text-muted)]">recommend:</span>
        <span style={{ color: detectedColor }}>{detected}</span>
        {record.classification_discrepancy && (
          <MismatchBadge severity={record.mismatch_severity ?? "marking_error"} />
        )}
      </div>
      <div className="px-2 py-2">
        <div className="mb-1 flex items-center gap-2 font-mono text-xs tracking-wide">
          <span className="text-[var(--color-text)]">{record.sr_number}</span>
          <span className="text-[var(--color-text-muted)]">· {record.equipment_type.replace(/_/g, " ")}</span>
          <span className="text-[var(--color-text-muted)]">· {record.unit_name}</span>
        </div>
        <div className="line-clamp-2 text-sm text-[var(--color-text-secondary)]">{record.remark}</div>
        {/* Walkthrough #11 — surface diversified Held reasons as badges so
            the operator can triage the queue by reason kind. */}
        {Array.isArray(record.held_reasons) && record.held_reasons.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1 text-xs">
            {record.held_reasons.map((r: string) => (
              <span
                key={r}
                className="rounded-sm border border-[var(--color-danger-muted)] px-1 py-[1px] font-mono font-semibold uppercase tracking-wider text-[var(--color-danger)]"
                title={HELD_REASON_DESCRIPTION[r] ?? r}
              >
                {r.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        )}
        <div className="mt-1.5 flex items-center gap-1 text-xs">
          {(record.flags || []).map((f: string) => (
            <span
              key={f}
              className="rounded-sm border px-1 py-[1px] font-mono font-semibold uppercase tracking-wider"
              style={{
                color: FLAG_COLOR[f] || "var(--color-text-muted)",
                borderColor: `color-mix(in oklab, ${FLAG_COLOR[f] || "#666"} 40%, var(--color-border))`,
                background: `color-mix(in oklab, ${FLAG_COLOR[f] || "#666"} 12%, transparent)`,
              }}
            >
              {f}
            </span>
          ))}
          <IconButton
            onClick={(e) => { e.stopPropagation(); onApprove(); }}
            aria-label="Approve"
            title="Approve (A)"
            variant="secondary"
            size="sm"
            className="ml-auto border-[var(--color-success-muted)] text-[var(--color-success)] hover:bg-[var(--color-success-muted)]"
          >
            <span aria-hidden>✓</span>
          </IconButton>
          <IconButton
            onClick={(e) => { e.stopPropagation(); onReject(); }}
            aria-label="Reject"
            title="Reject (R)"
            variant="secondary"
            size="sm"
            className="border-[var(--color-danger-muted)] text-[var(--color-danger)] hover:bg-[var(--color-danger-muted)]"
          >
            <span aria-hidden>✗</span>
          </IconButton>
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
  // Walkthrough #31 — per-record audit-entry viewer modal so the audit
  // chain claims in the chrome are backed by inspectable artifacts.
  const [auditOpen, setAuditOpen] = useState(false);
  // W1 #30 — gate the model-card cross-link on role; supply-chain page
  // is restricted to security_manager.
  const role = useSpireStore((s) => s.role);
  // Walkthrough #37 — PII masking. The inspector renders highlighted PII
  // spans (EDIPI, POC, MGRS) as opaque blocks by default. The operator can
  // click-to-reveal each individual span only if their clearance meets the
  // record's detected classification. The presenter can also flip the
  // header "REDACTED for projection" toggle to mask everything (regardless
  // of category, regardless of clearance) for stage projection.
  const clearance = useClearance();
  const recordClass = normalizeClassification(
    record.detected_classification ?? record.source_classification ?? "UNCLASSIFIED",
  );
  const canRevealPII = clearance.can(recordClass);
  const [projectionMode, setProjectionMode] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  // Reset reveal-state on record change so revealed spans from one record
  // never carry over visually to another. Projection mode is preserved on
  // purpose — the presenter sets it once for the demo and it should stick.
  useEffect(() => {
    setRevealed(new Set());
  }, [record.sr_number]);
  const highlights: { start: number; end: number; category: string }[] = record.highlights || [];
  const remark: string = record.remark || "";
  const segments: { text: string; category?: string; idx: number }[] = [];
  let cursor = 0;
  const sorted = [...highlights].sort((a, b) => a.start - b.start);
  sorted.forEach((h, i) => {
    if (h.start > cursor) segments.push({ text: remark.slice(cursor, h.start), idx: -1 });
    segments.push({ text: remark.slice(h.start, h.end), category: h.category, idx: i });
    cursor = h.end;
  });
  if (cursor < remark.length) segments.push({ text: remark.slice(cursor), idx: -1 });

  const detected = record.detected_classification;
  const detectedColor = CLASS_COLOR[detected] ?? "var(--color-text-secondary)";

  return (
    <aside className="flex w-[28rem] shrink-0 flex-col overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex items-start justify-between">
          <div>
            <div
              className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
            >
              Record Inspector
            </div>
            <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--color-text)] tracking-wide">
              {record.sr_number}
            </div>
            <div className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
              {record.unit_name} · {record.equipment_type}
            </div>
          </div>
          <IconButton onClick={onClose} aria-label="Close inspector" variant="ghost" size="sm">
            <span aria-hidden>✕</span>
          </IconButton>
        </div>
        {/* Walkthrough #37 — projection/redaction toggle. When ON, every
            highlighted span renders as a black block regardless of category
            or operator clearance — safe for projector / camera. */}
        <div className="mt-2 flex items-center justify-between gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1">
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            {projectionMode
              ? "REDACTED for projection · all spans masked"
              : canRevealPII
                ? "PII masked · click to reveal"
                : `PII masked · ${recordClass} clearance required to reveal`}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={projectionMode}
            aria-label="Toggle projection redaction"
            onClick={() => setProjectionMode((v) => !v)}
            className={clsx(
              "rounded-sm border px-2 py-[2px] font-mono text-[10px] font-semibold uppercase tracking-widest transition-colors",
              projectionMode
                ? "border-[var(--color-danger)] bg-[var(--color-danger)] text-white"
                : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:border-[var(--color-danger)]",
            )}
          >
            {projectionMode ? "REDACTED ✓" : "REDACT for projection"}
          </button>
        </div>
      </div>
      <div className="flex flex-col gap-4 p-4">
        {/* Classification banner */}
        <div
          className="rounded-sm border-l-4 py-2 pl-3 pr-2 font-mono text-base font-semibold uppercase tracking-widest"
          style={{
            borderLeftColor: detectedColor,
            background: `color-mix(in oklab, ${detectedColor} 14%, var(--color-bg))`,
            color: detectedColor,
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
            className="mb-1 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
          >
            Remark · Highlighted
          </div>
          <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-base leading-relaxed text-[var(--color-text)]">
            {segments.map((s, i) => {
              if (!s.category) return <span key={i}>{s.text}</span>;
              const isPii = PII_MASK_CATEGORIES.has(s.category);
              const shouldMask =
                projectionMode || (isPii && !revealed.has(s.idx));
              const flagColor = FLAG_COLOR[s.category] || "#fff";
              if (shouldMask) {
                // Black-block redaction. Width matches the underlying token
                // length so layout doesn't reflow when the operator reveals.
                const blockWidth = `${Math.max(2, s.text.length)}ch`;
                return (
                  <span
                    key={i}
                    role={canRevealPII && !projectionMode ? "button" : undefined}
                    tabIndex={canRevealPII && !projectionMode ? 0 : -1}
                    title={
                      projectionMode
                        ? "Masked for projection"
                        : canRevealPII
                          ? `Click to reveal ${s.category.toUpperCase()} span`
                          : `Reveal blocked — ${recordClass} clearance required`
                    }
                    aria-label={
                      projectionMode
                        ? `Redacted ${s.category} span`
                        : canRevealPII
                          ? `Reveal ${s.category} span`
                          : `Masked ${s.category} span (insufficient clearance)`
                    }
                    onClick={() => {
                      if (projectionMode || !canRevealPII) return;
                      setRevealed((prev) => {
                        const next = new Set(prev);
                        next.add(s.idx);
                        return next;
                      });
                    }}
                    onKeyDown={(e) => {
                      if (projectionMode || !canRevealPII) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setRevealed((prev) => {
                          const next = new Set(prev);
                          next.add(s.idx);
                          return next;
                        });
                      }
                    }}
                    className={clsx(
                      "mx-px inline-block select-none align-baseline rounded-sm",
                      canRevealPII && !projectionMode && "cursor-pointer",
                    )}
                    style={{
                      background: "#0a0a0a",
                      color: "#0a0a0a",
                      minWidth: blockWidth,
                      borderBottom: `2px solid ${flagColor}`,
                      lineHeight: 1.1,
                    }}
                  >
                    {"█".repeat(Math.max(2, s.text.length))}
                  </span>
                );
              }
              const revealedSpan = (
                <span
                  key={i}
                  className="rounded-sm px-0.5"
                  style={{
                    background: `color-mix(in oklab, ${flagColor} 28%, transparent)`,
                    color: flagColor,
                  }}
                  title={
                    isPii
                      ? `Revealed ${s.category.toUpperCase()} span — click again to re-mask`
                      : undefined
                  }
                  onClick={
                    isPii
                      ? () => {
                          setRevealed((prev) => {
                            const next = new Set(prev);
                            next.delete(s.idx);
                            return next;
                          });
                        }
                      : undefined
                  }
                  role={isPii ? "button" : undefined}
                  tabIndex={isPii ? 0 : -1}
                >
                  {s.text}
                </span>
              );
              return revealedSpan;
            })}
          </div>
        </section>

        {/* Evidence table: each highlight with its rule + category */}
        {highlights.length > 0 && (
          <section>
            <div
              className="mb-1 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
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
                      className="rounded-sm border px-1 font-mono text-xs font-semibold uppercase tracking-wider"
                      style={{
                        color: FLAG_COLOR[h.category] || "var(--color-text-muted)",
                        borderColor: `color-mix(in oklab, ${FLAG_COLOR[h.category] || "#666"} 40%, var(--color-border))`,
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
            className="mb-1 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
          >
            Routing
          </div>
          <div className="flex items-center gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-base">
            {/* Walkthrough #7 — single source of truth: record.routed_to +
                record.confidence are the canonical fields; no other component
                re-derives them. Walkthrough #32 — operator-readable text. */}
            <span className="font-mono text-[var(--color-text)]">
              {record.routed_to === "tier2_llm" ? "Language Model Reviewer" : "Pattern Engine"}
            </span>
            <span className="text-[var(--color-text-muted)]">·</span>
            <span className="font-mono tabular-nums text-[var(--color-text-secondary)]">
              confidence {(record.confidence ?? 0).toFixed(2)}
            </span>
            {/* W1 #30 — cross-link from the SENTRY classifier surface to
             * the canonical model card. The supply-chain page is gated
             * to security_manager, so render the link only for that role
             * to avoid sending other operators to InsufficientPrivilege. */}
            {role === "security_manager" && (
              <a
                href="#/admin/models/sentry-classifier"
                className="font-mono text-xs uppercase tracking-widest text-[var(--color-primary)] hover:underline"
                title="Open the SENTRY classifier model card (supply chain, FedRAMP, validation history)"
              >
                Model card →
              </a>
            )}
            {record.routing_locked && (
              <span
                className="ml-auto font-mono text-xs text-[var(--color-text-muted)] tracking-wider"
                title="Routing decision is locked at processing time and persisted with the record."
              >
                LOCKED
              </span>
            )}
          </div>
        </section>
      </div>

      {/* Walkthrough #31 — audit-chain viewer button. */}
      <div className="px-4 pb-2">
        <Button onClick={() => setAuditOpen(true)} variant="secondary" size="sm" fullWidth>
          ↧ View audit chain entry for {record.sr_number}
        </Button>
      </div>

      <div className="sticky bottom-0 z-10 flex items-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface)] p-3">
        <Button
          onClick={onApprove}
          variant="secondary"
          fullWidth
          className="border-[var(--color-success)] bg-[color-mix(in_oklab,var(--color-success-muted)_30%,var(--color-surface))] text-[var(--color-success)] hover:bg-[var(--color-success)] hover:text-white"
        >
          ✓ Approve (A)
        </Button>
        <Button
          onClick={onReject}
          variant="secondary"
          fullWidth
          className="border-[var(--color-danger)] bg-[color-mix(in_oklab,var(--color-danger-muted)_30%,var(--color-surface))] text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white"
        >
          ✗ Reject (R)
        </Button>
      </div>

      {auditOpen && (
        <AuditChainModal subjectId={record.sr_number} onClose={() => setAuditOpen(false)} />
      )}
    </aside>
  );
}

// Walkthrough #31 — per-record audit-chain modal. Pulls /sentry/audit/{sr}
// and shows hash + prev_hash + ts + actor + payload for every chain entry
// touching this subject so the operator can verify the trail without
// trawling a 500-row recent_entries dump.
function AuditChainModal({ subjectId, onClose }: { subjectId: string; onClose: () => void }) {
  const [data, setData] = useState<{ entries: any[]; count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.sentry.auditFor(subjectId)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setError(formatApiError(e)); });
    return () => { cancelled = true; };
  }, [subjectId]);
  return (
    <div
      className="fixed inset-0 z-[8500] flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3">
          <div>
            <div className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
              Audit Chain · SHA-256 hash-linked
            </div>
            <div className="mt-0.5 font-mono text-sm font-semibold text-[var(--color-text)]">
              Subject: {subjectId}
            </div>
          </div>
          <IconButton onClick={onClose} aria-label="Close audit chain" variant="ghost" size="sm">
            <span aria-hidden>✕</span>
          </IconButton>
        </div>
        <div className="max-h-[64vh] overflow-y-auto p-4 font-mono text-xs">
          {error && (
            <ErrorState
              variant="inline"
              title="Audit chain unavailable"
              description="Failed to load audit chain."
              detail={error}
              onRetry={() => {
                setError(null);
                api.sentry.auditFor(subjectId)
                  .then((r) => setData(r))
                  .catch((e) => setError(formatApiError(e)));
              }}
            />
          )}
          {!error && !data && <div className="text-[var(--color-text-muted)]">Loading …</div>}
          {data && data.entries.length === 0 && (
            <div className="text-[var(--color-text-muted)]">
              No audit entries yet for this subject. The chain is written when
              a marking decision, review action, or release event fires.
            </div>
          )}
          {data && data.entries.map((e, i) => {
            // Task #25 — surface the operator's name (from the chain
            // payload) in addition to the role string. The role alone
            // ("g4", "security_manager") doesn't tell an investigator
            // who actually keyed the decision; the payload now carries
            // actor_name + actor_dodid + actor_unit + actor_cert_serial
            // so the modal renders a proper Marine identity.
            const p = e.payload || {};
            const operatorName =
              typeof p.actor_name === "string" && p.actor_name.trim()
                ? p.actor_name
                : null;
            const operatorDodid =
              typeof p.actor_dodid === "string" && p.actor_dodid.trim()
                ? p.actor_dodid
                : null;
            const operatorUnit =
              typeof p.actor_unit === "string" && p.actor_unit.trim()
                ? p.actor_unit
                : null;
            const operatorCert =
              typeof p.actor_cert_serial === "string" && p.actor_cert_serial.trim()
                ? p.actor_cert_serial
                : null;
            return (
              <div
                key={i}
                className="mb-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2"
              >
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="text-[var(--color-primary)]">{e.kind}</span>
                  <span className="text-[var(--color-text-muted)]">{e.ts}</span>
                  <span className="ml-auto text-[var(--color-text-muted)]">
                    role: {e.actor}
                  </span>
                </div>
                {(operatorName || operatorDodid || operatorUnit || operatorCert) && (
                  <div className="mb-1 text-[var(--color-text)]">
                    operator:{" "}
                    <span className="font-semibold">
                      {operatorName || "(unknown)"}
                    </span>
                    {operatorDodid && (
                      <span className="ml-2 text-[var(--color-text-muted)]">
                        DODID {operatorDodid}
                      </span>
                    )}
                    {operatorUnit && (
                      <span className="ml-2 text-[var(--color-text-muted)]">
                        · {operatorUnit}
                      </span>
                    )}
                    {operatorCert && (
                      <span className="ml-2 text-[var(--color-text-muted)]">
                        · cert {operatorCert}
                      </span>
                    )}
                  </div>
                )}
                <div className="break-all text-[var(--color-text-muted)]">prev_hash: {e.prev_hash}</div>
                <div className="break-all text-[var(--color-text)]">self_hash: {e.self_hash}</div>
                {p && Object.keys(p).length > 0 && (
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[var(--color-text-secondary)]">
                    {JSON.stringify(p, null, 2)}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
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
          className="font-mono text-sm font-semibold uppercase text-[var(--color-warning)] tracking-widest"
        >
          Aggregation Risk Matrix · {risks.length} findings
        </div>
        <Button onClick={onClose} variant="ghost" size="sm">
          Hide ✕
        </Button>
      </div>
      <div className="overflow-auto">
        <table className="min-w-full border-collapse font-mono text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-[var(--color-surface)] p-1 text-left text-[var(--color-text-muted)] tracking-wider">
                UNIT \ EQUIP
              </th>
              {equipTypes.map((e) => (
                <th
                  key={e}
                  className="p-1 text-left text-xs text-[var(--color-text-muted)] tracking-wider"
                  style={{ transform: "rotate(-25deg)", height: 60, verticalAlign: "bottom" }}
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
      <div className="mt-2 max-h-40 overflow-y-auto font-mono text-xs tracking-wide">
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

