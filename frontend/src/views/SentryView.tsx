import { Routes, Route, NavLink, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { UploadTab } from "./sentry/UploadTab";
import { ProcessingTab } from "./sentry/ProcessingTab";
import { ReviewQueueTab } from "./sentry/ReviewQueueTab";
import { ExportTab } from "./sentry/ExportTab";
import { MarkTab } from "./sentry/MarkTab";
import { CoalitionTab } from "./sentry/CoalitionTab";
import { useSpireStore } from "../state/store";
import { UseCaseStrip } from "../components/UseCaseStrip";
import { AwaitingIngestEmpty } from "../components/AwaitingIngestEmpty";
import { useDatasetStatus } from "../hooks/useDatasetStatus";

export interface SentryContext {
  batchId: string | null;
  jobId: string | null;
  setBatch: (b: string | null) => void;
  setJob: (j: string | null) => void;
}

// Pipeline stages — the order is load-bearing. The numeric prefix in
// SentrySubnav reads from this array's index, and the operator's mental
// model of "step 1 → step 6" depends on it. New stages get appended; do
// not insert in the middle without rewiring the operator-facing copy
// in MarkTab / ExportTab / CoalitionTab next-step hints.
const tabs = [
  { to: "/sentry/upload",     label: "Upload" },
  { to: "/sentry/processing", label: "Processing" },
  { to: "/sentry/review",     label: "Review Queue" },
  { to: "/sentry/mark",       label: "Mark Draft" },
  { to: "/sentry/export",     label: "Export" },
  { to: "/sentry/coalition",  label: "Coalition" },
];

export function SentryView() {
  // Batch context lives in the Zustand store so role switches (which unmount
  // SentryView) and tab nav don't wipe the in-flight batch.
  const batchId = useSpireStore((s) => s.sentryBatchId);
  const jobId = useSpireStore((s) => s.sentryJobId);
  const setBatchStore = useSpireStore((s) => s.setSentryBatch);
  // Task #183 — stage live-ingest mode. The SENTRY upload→batch
  // pipeline (Upload, Processing) is *additive* and operates on the
  // operator's CUI-tagging batch, not the GCSS-MC dataset, so it
  // remains reachable in empty-boot mode. The data-dependent tabs
  // (Review Queue, Mark Draft, Export, Coalition) cross-reference
  // the dataset singleton and are gated with the standard
  // "Awaiting GCSS-MC ingest" placeholder until ingest completes.
  const datasetStatus = useDatasetStatus().status;
  const isEmpty = datasetStatus?.empty === true;

  const ctx: SentryContext = {
    batchId,
    jobId,
    setBatch: (b) => setBatchStore(b, jobId),
    setJob:   (j) => setBatchStore(batchId, j),
  };

  // Helper — wrap a data-dependent tab so it falls back to the
  // Awaiting placeholder while the dataset singleton is empty.
  // Upload + Processing intentionally do *not* use this gate so
  // the Task #177 batch-classification path keeps working from
  // the moment SPIRE boots, even before any GCSS-MC ingest.
  const gated = (node: React.ReactNode) =>
    isEmpty ? (
      <AwaitingIngestEmpty
        surface="SENTRY"
        description="The review queue, mark-draft canvas, export builder, and coalition release pipelines all cross-reference the live GCSS-MC dataset. Drop the three sanitized CSVs into DECISION BRIDGE to populate this view. The Upload and Processing tabs above remain available for batch CUI tagging."
      />
    ) : (
      node
    );

  return (
    <div className="flex h-full flex-col">
      {/* Single h1 per view for screen-reader document outline. */}
      <h1 className="sr-only">SENTRY · Classification &amp; Release</h1>
      <UseCaseStrip number="14" title="SENTRY" subtitle="CUI AUTO-TAGGING — DoDM 5200.01" accent="var(--color-info)" />
      <SentrySubnav />
      <div className="flex-1 overflow-hidden">
        <Routes>
          <Route index                  element={<UploadTab ctx={ctx} />} />
          <Route path="upload"          element={<UploadTab ctx={ctx} />} />
          <Route path="processing"      element={<ProcessingTab ctx={ctx} />} />
          <Route path="review"          element={gated(<ReviewQueueTab ctx={ctx} />)} />
          <Route path="mark"            element={gated(<MarkTab />)} />
          <Route path="export"          element={gated(<ExportTab ctx={ctx} />)} />
          <Route path="coalition"       element={gated(<CoalitionTab />)} />
        </Routes>
      </div>
    </div>
  );
}

function SentrySubnav() {
  const nav = useNavigate();
  return (
    <div className="h-10 shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4">
      <div className="flex h-full items-center gap-0">
        {tabs.map((t, i) => (
          <div key={t.to} className="flex h-full items-center">
            <NavLink
              to={t.to}
              onClick={(e) => {
                if (t.to === "/sentry/upload") {
                  e.preventDefault();
                  nav("/sentry/upload");
                }
              }}
              className={({ isActive }) =>
                clsx(
                  "relative flex h-full items-center gap-2 px-3 py-2 font-mono text-sm font-semibold uppercase tracking-wider transition-colors",
                  isActive
                    ? "text-[var(--color-text)]"
                    : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
                )
              }
            >
              {({ isActive }) => (
                <>
                  {/* Step number — load-bearing for the pipeline narrative.
                     Active step gets the primary accent; others stay muted
                     so the flow reads at a glance without competing with
                     the active-tab signal. */}
                  <span
                    className={clsx(
                      "inline-flex h-4 min-w-[1rem] items-center justify-center rounded-sm border px-1 text-[10px] tabular-nums leading-none",
                      isActive
                        ? "border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_18%,transparent)] text-[var(--color-primary)]"
                        : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]",
                    )}
                    aria-hidden
                  >
                    {i + 1}
                  </span>
                  <span>{t.label}</span>
                  {isActive && (
                    <>
                      <span
                        className="absolute inset-x-2 -bottom-[1px] h-[2px]"
                        style={{
                          background: "var(--color-primary)",
                          boxShadow: "0 0 8px var(--color-primary)",
                        }}
                      />
                    </>
                  )}
                </>
              )}
            </NavLink>
            {i < tabs.length - 1 && (
              <span
                aria-hidden
                className="select-none px-0.5 font-mono text-xs text-[var(--color-text-muted)]"
              >
                ›
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
