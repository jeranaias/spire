/**
 * FeedbackDrawer — pilot-cohort "Report Issue" surface.
 *
 * Designed to be the lowest-friction path for a Marine using SPIRE for the
 * first time to file *any* feedback — bugs, ideas, questions, or praise.
 * Floating button bottom-right with a first-run coachmark so it's visible
 * without onboarding. Press g then f to open from anywhere.
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
import { formatApiError } from "../api-retry";
import { csrfHeaders } from "../api";
import { Button, IconButton, Pressable } from "./ui";

type IssueType = "bug" | "idea" | "question" | "praise";

const ISSUE_TYPES: { value: IssueType; label: string; tag: string; tagline: string; placeholder: string }[] = [
  {
    value: "bug",
    label: "Defect",
    tag: "Defect Report",
    tagline: "System rendered wrong, crashed, or behaved contrary to expected behavior.",
    placeholder: "What were you doing. What SPIRE did. What you expected instead. Include any error message you saw.",
  },
  {
    value: "idea",
    label: "Enhancement",
    tag: "Enhancement Request",
    tagline: "A feature, workflow change, or panel rearrangement you want shipped.",
    placeholder: "Describe the change you want and what task it would support. Be specific about the surface and the operator action.",
  },
  {
    value: "question",
    label: "Inquiry",
    tag: "Inquiry",
    tagline: "Workflow that wasn't clear. Maintainers respond in-thread and update the user guide.",
    placeholder: "What you were trying to accomplish, and what was unclear or ambiguous in the UI.",
  },
  {
    value: "praise",
    label: "Endorsement",
    tag: "Positive Feedback",
    tagline: "Workflow that worked well. Tells us what to preserve.",
    placeholder: "What you used and what task it helped you complete.",
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

  // Optional submitter identity. Persisted in localStorage so an SSgt
  // doesn't retype their name on every submission. Stays optional —
  // anonymous submissions still work and show "Anonymous" in the GH
  // issue title. The pilot maintainer can scroll Issues and see real
  // contributor names instead of every issue showing as filed by the
  // PAT-holder.
  const SUBMITTER_KEY = "spire.feedback.submitter";
  const [submitter, setSubmitter] = useState<string>(() => {
    try { return localStorage.getItem(SUBMITTER_KEY) ?? ""; } catch { return ""; }
  });
  useEffect(() => {
    try {
      if (submitter.trim()) localStorage.setItem(SUBMITTER_KEY, submitter.trim());
    } catch {}
  }, [submitter]);

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

  // Quick-keys: 'g f' chord to open (dispatched by App's chord router
  // via the spire:open-feedback custom event so all chord state lives
  // in one place), Esc to close.
  //
  // Walkthrough audit: prior shortcut was Shift+F. That fires every time
  // the operator types a capital F (Shift IS how you type F), so the
  // drawer popped open mid-sentence in any input field. Switched to a
  // vimium-style 'g f' chord — matches the existing 'g s' / 'g p' /
  // 'g b' / 'g a' go-to chords in App.tsx, no modifier needed,
  // can't collide with normal typing.
  useEffect(() => {
    function onOpen() {
      setOpen((v) => !v);
      dismissCoach();
    }
    function onKey(e: KeyboardEvent) {
      // Walkthrough audit: Escape now always closes the drawer when open,
      // even if focus is inside the textarea. The previous "!inField" guard
      // was over-applied — Escape on an open modal/drawer is universal UX,
      // and operators couldn't dismiss after typing in the body field.
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("spire:open-feedback", onOpen as EventListener);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("spire:open-feedback", onOpen as EventListener);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeType = ISSUE_TYPES.find((t) => t.value === issueType)!;
  const showSeverity = issueType === "bug";

  // Lock body scroll while the drawer is open so the underlying view
  // doesn't drift when the operator scrolls inside the form.
  useEffect(() => {
    if (!open) return;
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prior;
    };
  }, [open]);

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
        submitter: submitter.trim() || null,
        diagnostics,
      };
      // Walkthrough audit (CRITICAL): prior submit didn't check r.ok and
      // didn't set a client-side timeout. When Fly cold-started the backend,
      // the POST sat behind a ~30s machine boot, then nginx returned a 502
      // HTML body, and `r.json()` either crashed parsing the HTML or
      // returned a weird object — operator saw no toast at all because the
      // catch handler swallowed the error after the form was already in a
      // half-dead state. Now: 30s AbortController, explicit r.ok check,
      // distinct error messages so the operator knows what failed.
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), 30_000);
      let r: Response;
      try {
        r = await fetch("/api/system/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...csrfHeaders() },
          credentials: "same-origin",
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
      } finally {
        window.clearTimeout(timer);
      }
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(
          `${r.status} ${r.statusText}${text ? `: ${text.slice(0, 140)}` : ""}`,
        );
      }
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
      pushToast({ tone: "error", text: `Submit failed: ${formatApiError(e)}` });
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
              className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest"
            >
              Report defect, enhancement, or inquiry
            </div>
            <div className="mt-1 font-mono text-sm leading-snug text-[var(--color-text)]">
              Bug, idea, question, even praise — drop it here any time.
              Press <kbd className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1 text-xs">g</kbd> then <kbd className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1 text-xs">f</kbd> from anywhere.
            </div>
            <div
              className="absolute bottom-[-7px] right-6 h-3 w-3 rotate-45 border-b border-r border-[var(--color-primary)] bg-[var(--color-surface)]"
              aria-hidden="true"
            />
          </div>
        )}
        {/* Quieted idle treatment. The button used to render in primary
         * blue with a tinted background, pulling eye to the bottom-right
         * corner on every page. Pilot operators glance at it once when
         * they want to file something — it doesn't need to compete with
         * map markers, alerts, and the topbar at idle. Hover + coachmark
         * still lift the contrast to primary, and the warning-triangle
         * icon is swapped for a speech-bubble (was misreading as
         * "danger / fault" rather than "tell us something"). */}
        <Button
          onClick={() => { setOpen(true); dismissCoach(); }}
          variant="secondary"
          size="md"
          className="pointer-events-auto !border-[var(--color-border)] !bg-[var(--color-surface)] !text-[var(--color-text-secondary)] shadow-md backdrop-blur hover:!border-[var(--color-primary)] hover:!bg-[color-mix(in_oklab,var(--color-primary)_18%,var(--color-surface))] hover:!text-[var(--color-primary)]"
          style={{
            animation: coachVisible ? "feedback-pulse 1.6s ease-in-out infinite" : undefined,
          }}
          title="Report issue / idea / question (press g then f)"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span>Report Issue</span>
        </Button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-[8800] flex items-end justify-end bg-black/40 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          role="presentation"
        >
          <div
            className="m-2 flex w-full max-w-[30rem] flex-col gap-3 rounded-md border border-[var(--color-primary)] bg-[var(--color-surface)] p-4 shadow-2xl sm:m-4"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="spire-feedback-title"
          >
            <div className="flex items-baseline justify-between">
              <div>
                <div
                  id="spire-feedback-title"
                  className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest"
                >
                  Pilot Feedback
                </div>
                <div className="mt-0.5 spire-body-muted text-sm">
                  Filing as <span className="text-[var(--color-text)]">{ROLE_LABELS[role]}</span>
                  &nbsp;from <span className="text-[var(--color-text)]">{friendlyView(location.pathname)}</span>
                  {airGap && (
                    <span className="ml-2 font-mono text-[var(--color-warning)]">· AIR-GAP queued</span>
                  )}
                </div>
              </div>
              <IconButton onClick={() => setOpen(false)} aria-label="Close feedback drawer">
                ✕
              </IconButton>
            </div>

            {/* Issue-type segmented picker — sets tone + placeholder + label
             * routing on the backend. */}
            <div className="grid grid-cols-4 gap-1 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-1">
              {ISSUE_TYPES.map((t) => {
                const active = t.value === issueType;
                return (
                  <Pressable
                    key={t.value}
                    onClick={() => setIssueType(t.value)}
                    block={false}
                    className="!min-h-0 rounded-sm px-2 py-1.5 font-mono text-xs font-semibold uppercase transition-colors tracking-wider"
                    style={{
                      background: active ? "var(--color-primary)" : "transparent",
                      color: active ? "white" : "var(--color-text-secondary)",
                    }}
                  >
                    {t.label}
                  </Pressable>
                );
              })}
            </div>
            <div
              className="-mt-1 font-mono text-xs italic text-[var(--color-text-muted)] tracking-wide"
            >
              {activeType.tagline}
            </div>

            <div className="flex items-center gap-2">
              <span
                className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
                style={{ minWidth: "5rem" }}
              >
                Submitted by
              </span>
              <input
                value={submitter}
                onChange={(e) => setSubmitter(e.target.value)}
                placeholder="optional · e.g. SSgt Jones, CWO Smith"
                className="flex-1 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-sm text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
                autoComplete="name"
              />
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
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-base text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            />

            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              placeholder={activeType.placeholder}
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-base text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            />

            {showSeverity && (
              <div className="flex items-center gap-2">
                <span
                  className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
                >
                  Severity
                </span>
                <div className="inline-flex overflow-hidden rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)]">
                  {SEVERITIES.map((s, i) => (
                    <Pressable
                      key={s.value}
                      onClick={() => setSeverity(s.value)}
                      block={false}
                      className="!min-h-0 px-2 py-1 font-mono text-xs font-semibold uppercase transition-colors tracking-wider"
                      style={{
                        borderLeft: i === 0 ? "none" : "1px solid var(--color-border)",
                        background: severity === s.value ? "var(--color-primary)" : "transparent",
                        color: severity === s.value ? "white" : "var(--color-text-secondary)",
                      }}
                    >
                      {s.label}
                    </Pressable>
                  ))}
                </div>
              </div>
            )}

            <DiagnosticsRow d={diagnostics} />

            <div className="flex items-center justify-between gap-2 pt-1">
              <span
                className="font-mono text-xs text-[var(--color-text-muted)] tracking-wider"
              >
                Audit chain · GitHub Issues (when token set)
              </span>
              <Button
                onClick={submit}
                disabled={!title.trim() || !body.trim()}
                pending={submitting}
                variant="primary"
                size="md"
              >
                {submitting ? "Filing …" : "Submit"}
              </Button>
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
      <Pressable
        onClick={() => setShow((v) => !v)}
        className="!min-h-0 flex w-full items-center justify-between px-2 py-1 font-mono text-xs uppercase text-[var(--color-text-muted)] hover:text-[var(--color-text)] tracking-widest"
      >
        <span>Diagnostics auto-attached · {d.viewport} · {d.air_gap ? "AIR-GAP" : d.comms_state}</span>
        <span>{show ? "▾" : "▸"}</span>
      </Pressable>
      {show && (
        <ul className="border-t border-[var(--color-border)] px-2 py-2 font-mono text-xs text-[var(--color-text-secondary)]">
          {Object.entries(d).map(([k, v]) => (
            <li key={k} className="flex items-baseline justify-between gap-2 py-[1px]">
              <span className="text-[var(--color-text-muted)] tracking-wide">{k}</span>
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
