/**
 * FeedbackDrawer — pilot-cohort "Report Issue" surface.
 *
 * Designed to be the lowest-friction path for a Marine using SPIRE for the
 * first time to file *any* feedback — bugs, ideas, questions, or praise.
 * Floating button bottom-right with a first-run coachmark so it's visible
 * without onboarding. Shift+F opens it from anywhere.
 *
 * Pre-fills role + view + a diagnostics block (browser, viewport, active
 * sim) so the operator never types setup context. On successful submit
 * with a GitHub token wired, the confirmation toast carries a clickable
 * link straight to the new issue.
 *
 * POST → /api/system/feedback → audit chain (always) + GitHub Issues
 * (when SPIRE_GITHUB_TOKEN is set). Submissions during air-gap are queued
 * locally per GC-7 and replay when comms restore.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useSpireStore, ROLE_LABELS } from "../state/store";

type IssueType = "bug" | "idea" | "question" | "praise";

const ISSUE_TYPES: { value: IssueType; label: string; tag: string; tagline: string; placeholder: string }[] = [
  {
    value: "bug",
    label: "Bug",
    tag: "Something's broken",
    tagline: "Something rendered wrong, crashed, or behaves contrary to what you expected.",
    placeholder: "What did you do? What did SPIRE do? What did you expect instead? Include logs if you saw any.",
  },
  {
    value: "idea",
    label: "Idea",
    tag: "Make it better",
    tagline: "A feature, a workflow change, a panel rearrangement — anything you want changed.",
    placeholder: "What would make SPIRE more useful for you? Be specific — \"this column doesn't help me\" or \"add a button to do X.\"",
  },
  {
    value: "question",
    label: "Question",
    tag: "I'm not sure how this works",
    tagline: "Anything that confused you. We'll answer in-thread and update the docs.",
    placeholder: "What were you trying to do, and what was unclear? Screenshot the screen if it helps.",
  },
  {
    value: "praise",
    label: "Praise",
    tag: "This worked well",
    tagline: "Something you used and liked. Tells us what to keep doing.",
    placeholder: "What did you use and what did it help you do?",
  },
];

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
  const [issueType, setIssueType] = useState<IssueType>("bug");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState<Severity>("minor");
  const [submitting, setSubmitting] = useState(false);

  // First-run coachmark — once-only, dismissed on first click or after 6s.
  const COACH_KEY = "spire.feedback.coach.seen";
  const [coachVisible, setCoachVisible] = useState(false);
  useEffect(() => {
    try {
      if (!localStorage.getItem(COACH_KEY)) {
        const t = setTimeout(() => setCoachVisible(true), 1200);
        const off = setTimeout(() => setCoachVisible(false), 9000);
        return () => { clearTimeout(t); clearTimeout(off); };
      }
    } catch {}
  }, []);
  function dismissCoach() {
    setCoachVisible(false);
    try { localStorage.setItem(COACH_KEY, "1"); } catch {}
  }

  // Quick-keys: Shift+F to open, Esc to close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "F" || (e.shiftKey && e.key === "f")) {
        e.preventDefault();
        setOpen((v) => !v);
        dismissCoach();
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const activeType = ISSUE_TYPES.find((t) => t.value === issueType)!;
  const showSeverity = issueType === "bug";

  // Diagnostics auto-attached to every submission. Shown to the operator
  // expandably so they know what we're sending — never hidden context.
  const diagnostics = useDiagnostics(role, location.pathname);

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
        issue_type: issueType,
        severity: showSeverity ? severity : "n/a",
        role,
        view,
        actor: role,
        diagnostics,
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
          text: `Filed · GitHub issue #${j.github_issue_number}`,
          link: { label: "View on GitHub", href: j.github_issue_url },
          ttlMs: 9000,
        });
      } else if (airGap) {
        pushToast({
          tone: "info",
          text: "Logged locally · will sync to GitHub when comms restore",
          ttlMs: 5000,
        });
      } else {
        pushToast({
          tone: "ok",
          text: `Logged · feedback ${j.id}`,
          ttlMs: 4500,
        });
      }
      setTitle("");
      setBody("");
      setSeverity("minor");
      setIssueType("bug");
      setOpen(false);
    } catch (e) {
      pushToast({ tone: "error", text: `Submit failed: ${e}` });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="pointer-events-none fixed bottom-12 right-4 z-[8500]">
        {coachVisible && (
          <div
            onClick={dismissCoach}
            className="pointer-events-auto absolute right-0 -top-[5.25rem] w-[18rem] cursor-pointer rounded-md border border-[var(--color-primary)] bg-[var(--color-surface)] p-3 shadow-2xl"
            style={{
              animation: "feedback-coach-in 280ms ease-out",
            }}
          >
            <div
              className="font-mono text-[9px] uppercase text-[var(--color-primary)]"
              style={{ letterSpacing: "0.22em" }}
            >
              Found something? Tell us.
            </div>
            <div className="mt-1 font-mono text-[11px] leading-snug text-[var(--color-text)]">
              Bug, idea, question, even praise — drop it here any time.
              Press <kbd className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1 text-[10px]">Shift</kbd>+<kbd className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1 text-[10px]">F</kbd> from anywhere.
            </div>
            <div
              className="absolute bottom-[-7px] right-6 h-3 w-3 rotate-45 border-b border-r border-[var(--color-primary)] bg-[var(--color-surface)]"
              aria-hidden="true"
            />
          </div>
        )}
        <button
          onClick={() => { setOpen(true); dismissCoach(); }}
          className="pointer-events-auto flex items-center gap-2 rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_18%,var(--color-surface))] px-3 py-2 font-mono text-[10px] font-semibold uppercase text-[var(--color-primary)] shadow-lg backdrop-blur transition-colors hover:bg-[color-mix(in_oklab,var(--color-primary)_30%,var(--color-surface))]"
          style={{
            letterSpacing: "0.18em",
            animation: coachVisible ? "feedback-pulse 1.6s ease-in-out infinite" : undefined,
          }}
          title="Report issue / idea / question (Shift+F)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L1 21h22L12 2zm0 5l7.5 12h-15L12 7zm-1 4v3h2v-3h-2zm0 5v2h2v-2h-2z" />
          </svg>
          <span>Report Issue</span>
        </button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-[8800] flex items-end justify-end bg-black/40 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="m-4 flex w-[30rem] flex-col gap-3 rounded-md border border-[var(--color-primary)] bg-[var(--color-surface)] p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-baseline justify-between">
              <div>
                <div
                  className="font-mono text-[10px] uppercase text-[var(--color-primary)]"
                  style={{ letterSpacing: "0.22em" }}
                >
                  Pilot Feedback
                </div>
                <div className="mt-0.5 spire-body-muted text-[11px]">
                  Filing as <span className="text-[var(--color-text)]">{ROLE_LABELS[role]}</span>
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

            {/* Issue-type segmented picker — sets tone + placeholder + label
             * routing on the backend. */}
            <div className="grid grid-cols-4 gap-1 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-1">
              {ISSUE_TYPES.map((t) => {
                const active = t.value === issueType;
                return (
                  <button
                    key={t.value}
                    onClick={() => setIssueType(t.value)}
                    className="rounded-sm px-2 py-1.5 font-mono text-[10px] font-semibold uppercase transition-colors"
                    style={{
                      letterSpacing: "0.16em",
                      background: active ? "var(--color-primary)" : "transparent",
                      color: active ? "white" : "var(--color-text-secondary)",
                    }}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
            <div
              className="-mt-1 font-mono text-[10px] italic text-[var(--color-text-muted)]"
              style={{ letterSpacing: "0.04em" }}
            >
              {activeType.tagline}
            </div>

            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                issueType === "bug"      ? "One-line summary (e.g. 'cordon ring drifts on zoom')"
              : issueType === "idea"     ? "Your idea in one line (e.g. 'add a fuel-truck filter to the asset list')"
              : issueType === "question" ? "Your question in one line (e.g. 'how do I queue a TMR offline?')"
              :                            "What worked well, in one line"
              }
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[12px] text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            />

            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder={activeType.placeholder}
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[12px] text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            />

            {showSeverity && (
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
            )}

            <DiagnosticsRow d={diagnostics} />

            <div className="flex items-center justify-between gap-2 pt-1">
              <span
                className="font-mono text-[9px] text-[var(--color-text-muted)]"
                style={{ letterSpacing: "0.14em" }}
              >
                Audit chain · GitHub Issues (when token set)
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

// --- Diagnostics --------------------------------------------------------

interface Diagnostics {
  user_agent: string;
  viewport: string;
  pixel_ratio: number;
  spire_version: string;
  url_hash: string;
  air_gap: boolean;
  comms_state: string;
  active_sim: string | null;
  fpcon: string | null;
  classification: string | null;
}

function useDiagnostics(role: string, pathname: string): Diagnostics {
  const airGap = useSpireStore((s) => s.airGapActive);
  const comms = useSpireStore((s) => s.commsState);
  const ref = useRef<Diagnostics>({
    user_agent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    viewport: typeof window !== "undefined" ? `${window.innerWidth}x${window.innerHeight}` : "",
    pixel_ratio: typeof window !== "undefined" ? window.devicePixelRatio : 1,
    spire_version: (window as any).__SPIRE_VERSION__ || "v1.0.0-rc1",
    url_hash: typeof window !== "undefined" ? window.location.hash : "",
    air_gap: airGap,
    comms_state: comms,
    active_sim: null,
    fpcon: document.body.dataset.fpcon || null,
    classification: document.body.dataset.classification || null,
  });
  // Refresh on key state changes.
  ref.current = {
    ...ref.current,
    air_gap: airGap,
    comms_state: comms,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    url_hash: window.location.hash,
    fpcon: document.body.dataset.fpcon || null,
    classification: document.body.dataset.classification || null,
  };
  void role; void pathname; // referenced for re-render fidelity
  return ref.current;
}

function DiagnosticsRow({ d }: { d: Diagnostics }) {
  const [show, setShow] = useState(false);
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)]">
      <button
        onClick={() => setShow((v) => !v)}
        className="flex w-full items-center justify-between px-2 py-1 font-mono text-[10px] uppercase text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        style={{ letterSpacing: "0.18em" }}
      >
        <span>Diagnostics auto-attached · {d.viewport} · {d.air_gap ? "AIR-GAP" : d.comms_state}</span>
        <span>{show ? "▾" : "▸"}</span>
      </button>
      {show && (
        <ul className="border-t border-[var(--color-border)] px-2 py-2 font-mono text-[10px] text-[var(--color-text-secondary)]">
          {Object.entries(d).map(([k, v]) => (
            <li key={k} className="flex items-baseline justify-between gap-2 py-[1px]">
              <span className="text-[var(--color-text-muted)]" style={{ letterSpacing: "0.04em" }}>{k}</span>
              <span className="truncate text-right text-[var(--color-text)]" title={String(v)}>
                {String(v ?? "—")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
  if (p.startsWith("/admin"))             return "ADMIN";
  return p || "/";
}
