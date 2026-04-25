import { Routes, Route, NavLink, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { UploadTab } from "./sentry/UploadTab";
import { ProcessingTab } from "./sentry/ProcessingTab";
import { ReviewQueueTab } from "./sentry/ReviewQueueTab";
import { ExportTab } from "./sentry/ExportTab";
import { MarkTab } from "./sentry/MarkTab";
import { CoalitionTab } from "./sentry/CoalitionTab";
import { useSpireStore } from "../state/store";

export interface SentryContext {
  batchId: string | null;
  jobId: string | null;
  setBatch: (b: string | null) => void;
  setJob: (j: string | null) => void;
}

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

  const ctx: SentryContext = {
    batchId,
    jobId,
    setBatch: (b) => setBatchStore(b, jobId),
    setJob:   (j) => setBatchStore(batchId, j),
  };

  return (
    <div className="flex h-full flex-col">
      <SentrySubnav />
      <div className="flex-1 overflow-hidden">
        <Routes>
          <Route index                  element={<UploadTab ctx={ctx} />} />
          <Route path="upload"          element={<UploadTab ctx={ctx} />} />
          <Route path="processing"      element={<ProcessingTab ctx={ctx} />} />
          <Route path="review"          element={<ReviewQueueTab ctx={ctx} />} />
          <Route path="mark"            element={<MarkTab />} />
          <Route path="export"          element={<ExportTab ctx={ctx} />} />
          <Route path="coalition"       element={<CoalitionTab />} />
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
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            onClick={(e) => {
              if (t.to === "/sentry/upload") {
                e.preventDefault();
                nav("/sentry/upload");
              }
            }}
            className={({ isActive }) =>
              clsx(
                "relative px-4 py-2 font-mono text-sm font-semibold uppercase tracking-wider transition-colors",
                isActive
                  ? "text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
              )
            }
          >
            {({ isActive }) => (
              <>
                {t.label}
                {isActive && (
                  <>
                    <span
                      className="absolute inset-x-2 -bottom-[1px] h-[2px]"
                      style={{
                        background: "var(--color-primary)",
                        boxShadow: "0 0 8px var(--color-primary)",
                      }}
                    />
                    <span className="absolute left-1 top-1/2 h-1 w-1 -translate-y-1/2 rounded-full bg-[var(--color-primary)]" />
                  </>
                )}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
