import { useState } from "react";
import { Routes, Route, NavLink, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { UploadTab } from "./sentry/UploadTab";
import { ProcessingTab } from "./sentry/ProcessingTab";
import { ReviewQueueTab } from "./sentry/ReviewQueueTab";
import { ExportTab } from "./sentry/ExportTab";
import { MarkTab } from "./sentry/MarkTab";

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
];

export function SentryView() {
  const [batchId, setBatchId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const ctx: SentryContext = {
    batchId,
    jobId,
    setBatch: setBatchId,
    setJob: setJobId,
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
        </Routes>
      </div>
    </div>
  );
}

function SentrySubnav() {
  const nav = useNavigate();
  return (
    <div className="h-10 shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4">
      <div className="flex h-full items-center gap-1">
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
                "rounded-sm px-3 py-1 text-xs font-medium transition-colors",
                isActive
                  ? "bg-[var(--color-surface-hover)] text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]",
              )
            }
          >
            {t.label}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
