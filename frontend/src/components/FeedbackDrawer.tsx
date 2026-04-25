/**
 * FeedbackDrawer — pilot-cohort "Report Issue" surface.
 *
 * Floating button bottom-right. Opens a drawer with title + body + severity
 * picker + the operator's current role + view auto-detected. Submit POSTs
 * to /api/system/feedback which logs locally to the audit chain and (when
 * SPIRE_GITHUB_TOKEN is set) creates a GitHub issue on the configured repo.
 *
 * Pilot cohort uses this every day. CWO triages the resulting GitHub
 * issues. Feedback that fires while air-gapped is queued locally per GC-7
 * and replays when comms restore.
 */
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useSpireStore, ROLE_LABELS } from "../state/store";

const SEVERITIES = [
  { value: "cosmetic", label: "Cosmetic" },
  { value: "minor",    label: "Minor" },
  { value: "major",    label: "Major" },
  { value: "critical", label: "Critical" },
] as const;

type Severity = typeof SEVERITIES[number]["value"];

export function FeedbackDrawer() {
  const role = useSpireStore((s) => s.role);
  const airGap = useSpireStore((s) => s.airGapActive);
  const pushToast = useSpireStore((s) => s.pushToast);
  const location = useLocation();

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<Severity>("minor");
  const [submitting, setSubmitting] = useState(false);

  // Quick-keys: F to open, Esc to close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "F" || (e.shiftKey && e.key === "f")) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function submit() {
    if (!title.trim() || !body.trim()) {
      pushToast({ tone: "warn", text: "Title and description required" });
      return;
    }
    setSubmitting(true);
    try {
      const view = friendlyView(location.pathname);
      const payload = {
        title: title.trim(),
        body: body.trim(),
        severity,
        role,
        view,
        actor: role,
      };
      const r = await fetch("/api/system/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j.github_issue_url) {
        pushToast({
          tone: "ok",
          text: `Feedback filed · GitHub issue #${j.github_issue_number} created`,
          ttlMs: 5000,
        });
      } else if (airGap) {
        pushToast({
          tone: "info",
          text: "Feedback logged locally · will sync when comms restore",
          ttlMs: 5000,
        });
      } else {
        pushToast({
          tone: "ok",
          text: `Feedback ${j.id} logged · maintainer notified`,
          ttlMs: 4500,
        });
      }
      setTitle("");
      setBody("");
      setSeverity("minor");
      setOpen(false);
    } catch (e) {
      pushToast({ tone: "error", text: `Submit failed: ${e}` });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="pointer-events-auto fixed bottom-12 right-4 z-[8500] flex items-center gap-2 rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_18%,var(--color-surface))] px-3 py-2 font-mono text-[10px] font-semibold uppercase text-[var(--color-primary)] shadow-lg backdrop-blur transition-colors hover:bg-[color-mix(in_oklab,var(--color-primary)_30%,var(--color-surface))]"
        style={{ letterSpacing: "0.18em" }}
        title="Report issue / file feedback (Shift+F)"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2L1 21h22L12 2zm0 5l7.5 12h-15L12 7zm-1 4v3h2v-3h-2zm0 5v2h2v-2h-2z" />
        </svg>
        <span>Report Issue</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[8800] flex items-end justify-end bg-black/40 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="m-4 flex w-[28rem] flex-col gap-3 rounded-md border border-[var(--color-primary)] bg-[var(--color-surface)] p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-baseline justify-between">
              <div>
                <div
                  className="font-mono text-[10px] uppercase text-[var(--color-primary)]"
                  style={{ letterSpacing: "0.22em" }}
                >
                  Pilot Feedback · Report Issue
                </div>
                <div className="mt-0.5 spire-body-muted text-[11px]">
                  Filed as <span className="text-[var(--color-text)]">{ROLE_LABELS[role]}</span>
                  &nbsp;from <span className="text-[var(--color-text)]">{friendlyView(location.pathname)}</span>
                  {airGap && (
                    <span className="ml-2 font-mono text-[var(--color-warning)]">· AIR-GAP queued</span>
                  )}
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="rounded px-2 py-1 font-mono text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="One-line summary (e.g. 'cordon ring drifts on zoom')"
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[12px] text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            />

            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder="Steps to reproduce + what you expected vs what happened. Logs help. We read these every day."
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[12px] text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            />

            <div className="flex items-center gap-2">
              <span
                className="font-mono text-[10px] uppercase text-[var(--color-text-muted)]"
                style={{ letterSpacing: "0.18em" }}
              >
                Severity
              </span>
              <div className="inline-flex overflow-hidden rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)]">
                {SEVERITIES.map((s, i) => (
                  <button
                    key={s.value}
                    onClick={() => setSeverity(s.value)}
                    className="px-2 py-1 font-mono text-[10px] font-semibold uppercase transition-colors"
                    style={{
                      letterSpacing: "0.16em",
                      borderLeft: i === 0 ? "none" : "1px solid var(--color-border)",
                      background: severity === s.value ? "var(--color-primary)" : "transparent",
                      color: severity === s.value ? "white" : "var(--color-text-secondary)",
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <span
                className="font-mono text-[9px] text-[var(--color-text-muted)]"
                style={{ letterSpacing: "0.14em" }}
              >
                Logs to audit chain · creates GitHub issue when token is set
              </span>
              <button
                onClick={submit}
                disabled={submitting || !title.trim() || !body.trim()}
                className="rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-4 py-1.5 font-mono text-[11px] font-semibold uppercase text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
                style={{ letterSpacing: "0.18em" }}
              >
                {submitting ? "Filing …" : "Submit"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function friendlyView(pathname: string): string {
  const p = pathname.replace(/^\/?#?\/?/, "/");
  if (p.startsWith("/sentry/upload"))     return "SENTRY · Upload";
  if (p.startsWith("/sentry/processing")) return "SENTRY · Processing";
  if (p.startsWith("/sentry/review"))     return "SENTRY · Review Queue";
  if (p.startsWith("/sentry/mark"))       return "SENTRY · Mark Draft";
  if (p.startsWith("/sentry/export"))     return "SENTRY · Export";
  if (p.startsWith("/sentry/coalition"))  return "SENTRY · Coalition";
  if (p.startsWith("/sentry"))            return "SENTRY";
  if (p.startsWith("/pulse/overview"))    return "PULSE · Fleet Overview";
  if (p.startsWith("/pulse/risk"))        return "PULSE · Risk Board";
  if (p.startsWith("/pulse/cannib"))      return "PULSE · Cannibalization";
  if (p.startsWith("/pulse/forecast"))    return "PULSE · Forecast";
  if (p.startsWith("/pulse"))             return "PULSE";
  if (p.startsWith("/bastion"))           return "BASTION";
  return p || "/";
}
