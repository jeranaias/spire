/**
 * AboutFaq — short, plain-language answers to the three pilot questions
 * (#18, #23, #24) that came in via the in-app feedback drawer:
 *
 *   1. What does SPIRE rely on?    (runtime stack, data, models, deps)
 *   2. How is it secured + sustained? (RBAC, audit chain, air-gap, plan)
 *   3. How does it communicate?    (REST API, sync, behavior in air-gap)
 *
 * Reachable from the Help overlay footer and from the ADMIN view.
 *
 * Content is intentionally short — operators don't read walls of text.
 * Anchor links along the top jump straight to a section so a pilot who
 * already knows what they're looking for doesn't have to scroll. Copy
 * is kept in sync with what's actually true after the security task
 * lands; if the answer changes, this file changes with it.
 */
import { useEffect, useRef } from "react";

export function AboutFaq({ onClose }: { onClose: () => void }) {
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    closeBtnRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prior;
    };
  }, []);

  function jump(id: string) {
    const el = dialogRef.current?.querySelector(`#${id}`);
    if (el instanceof HTMLElement) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div
      className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="m-4 flex max-h-[90vh] w-full max-w-[44rem] flex-col rounded-md border border-[var(--color-primary)] bg-[var(--color-surface)] shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="spire-about-title"
      >
        {/* Header */}
        <div className="flex items-baseline justify-between gap-2 border-b border-[var(--color-border)] px-5 py-3">
          <div>
            <div
              className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest"
            >
              About SPIRE · FAQ
            </div>
            <h2
              id="spire-about-title"
              className="mt-0.5 font-sans text-lg font-semibold text-[var(--color-text)] tracking-tight"
            >
              What does this rely on, how is it secured, how does it talk?
            </h2>
          </div>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded font-mono text-base text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
            aria-label="Close About / FAQ"
          >
            ✕
          </button>
        </div>

        {/* Anchor strip */}
        <nav
          aria-label="FAQ sections"
          className="flex flex-wrap items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-5 py-2"
        >
          {[
            { id: "relies-on", label: "Relies on" },
            { id: "secured",   label: "Secured + sustained" },
            { id: "comms",     label: "How it communicates" },
          ].map((a) => (
            <button
              key={a.id}
              onClick={() => jump(a.id)}
              className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 font-mono text-xs uppercase text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-active)] hover:text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] tracking-widest"
            >
              {a.label}
            </button>
          ))}
        </nav>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 text-[var(--color-text)]">
          <FaqSection
            id="relies-on"
            title="What does SPIRE rely on?"
            issueRef="#24"
            intro="The whole system is meant to run on one laptop with no internet — that's the point. Here's what's actually under the hood."
          >
            <FaqRow label="Runtime">
              FastAPI (Python 3.12) for the API + a React 19 + Vite single-page
              app for the UI. Both bundle into one deployable image — start the
              backend and the frontend is served from the same port.
            </FaqRow>
            <FaqRow label="Data">
              A canonical synthetic dataset is generated at boot from the
              <span className="mx-1 font-mono text-[var(--color-text)]">dataset/</span>
              engine. There is no live external data source. Custodian uploads
              are staged in a per-batch local directory and never leave the box.
            </FaqRow>
            <FaqRow label="Models">
              Classification scoring rides four engines we ship in-tree —
              rule-based, J2 patterns, regex, and an optional local LLM gate.
              ThermalHawk detection is rule-based by default; loading the
              optional Thornveil weights upgrades it to live inference. No call
              to any external model API is made by core SPIRE.
            </FaqRow>
            <FaqRow label="External dependencies in air-gap mode">
              None required. Map tiles are bundled. The optional GitHub-issue
              hand-off for in-app feedback (see "How it communicates" below) is
              the only outbound network feature, and it queues locally + replays
              on release when air-gap is engaged.
            </FaqRow>
          </FaqSection>

          <FaqSection
            id="secured"
            title="How is SPIRE secured, and how will it be sustained?"
            issueRef="#23"
            intro="Security is enforced at the API layer (not just the UI), wrapped in an audit chain, and the program plan is operator-owned, not vendor-owned."
          >
            <FaqRow label="Role-based access">
              Every API call carries an authenticated role. Out-of-scope reads
              + writes (e.g. a Maintenance Chief asking for a peer unit's
              cannibalization candidates, or anyone but a Data Custodian
              shipping a coalition release) are rejected at the route, not just
              hidden in the UI. The frontend "Out of Scope" overlays mirror
              the same enforcement so operators see why they're blocked.
            </FaqRow>
            <FaqRow label="Audit chain">
              Every operator decision — approve, reject, mark, release,
              air-gap toggle, role swap — appends a SHA-256-linked record to a
              tamper-evident chain. The fingerprint is rendered live in the
              status footer; multi-node deploys cross-verify it via vector
              clocks. The chain integrity check is exposed at
              <span className="mx-1 font-mono text-[var(--color-text)]">/api/system/audit-chain/verify</span>
              for nightly assurance.
            </FaqRow>
            <FaqRow label="Air-gap posture">
              Engaging air-gap from the top bar (Security Manager / MEF
              Commander only, with a confirmation modal) cuts outbound writes
              and routes mutations through a local queue. Releasing replays
              the queue with vector-clock conflict surfacing in Node Status.
            </FaqRow>
            <FaqRow label="Sustainment">
              SPIRE was built by Marines on duty time and is intended to stay
              that way. The pilot stand-up packages an installation guide
              (<span className="font-mono text-[var(--color-text)]">SPIRE_INSTALL.md</span>),
              a contributor on-ramp
              (<span className="font-mono text-[var(--color-text)]">CONTRIBUTING.md</span>),
              and a security report path
              (<span className="font-mono text-[var(--color-text)]">SECURITY.md</span>)
              so a unit can stand up, patch, and extend the system without an
              external vendor in the loop.
            </FaqRow>
          </FaqSection>

          <FaqSection
            id="comms"
            title="How does SPIRE communicate?"
            issueRef="#18"
            intro="One REST API serves the UI, with optional outbound features that all degrade cleanly under air-gap."
          >
            <FaqRow label="REST API">
              Everything the UI does happens over HTTP under
              <span className="mx-1 font-mono text-[var(--color-text)]">/api/*</span>.
              Each request carries the operator's role for backend RBAC. There
              are no websockets in the data plane — panels poll on a backoff
              that drops to once per minute when nothing changes, so a quiet
              installation stays quiet on the wire.
            </FaqRow>
            <FaqRow label="Optional sync">
              Multi-node deploys can sync the audit chain + canonical data
              between SPIRE instances. This is opt-in and can be disabled at
              any point by engaging air-gap mode.
            </FaqRow>
            <FaqRow label="Outbound integrations">
              The in-app Feedback drawer can optionally file straight to GitHub
              Issues when
              <span className="mx-1 font-mono text-[var(--color-text)]">SPIRE_GITHUB_TOKEN</span>
              and
              <span className="mx-1 font-mono text-[var(--color-text)]">SPIRE_GITHUB_REPO</span>
              are set. With no token, feedback still lands in the local audit
              chain and on the ADMIN telemetry surface.
            </FaqRow>
            <FaqRow label="Behavior under air-gap">
              All outbound traffic stops. Mutations queue locally and replay
              on release. Polling continues against the local backend so the
              UI keeps refreshing — there's no "frozen" state.
            </FaqRow>
          </FaqSection>
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--color-border)] px-5 py-3 text-xs text-[var(--color-text-muted)]">
          <span className="font-mono tracking-wider">
            Want a deeper dive? See
            <span className="mx-1 text-[var(--color-text-secondary)]">docs/ARCHITECTURE.md</span>
            and
            <span className="mx-1 text-[var(--color-text-secondary)]">docs/API.md</span>
            in the repo root.
          </span>
        </div>
      </div>
    </div>
  );
}

function FaqSection({
  id,
  title,
  issueRef,
  intro,
  children,
}: {
  id: string;
  title: string;
  issueRef?: string;
  intro?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mb-6 scroll-mt-4 last:mb-0">
      <div className="mb-1 flex items-baseline gap-2">
        <h3 className="font-sans text-base font-semibold text-[var(--color-text)] tracking-tight">
          {title}
        </h3>
        {issueRef && (
          <span
            className="font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest"
            title={`Pilot feedback ${issueRef}`}
          >
            answers {issueRef}
          </span>
        )}
      </div>
      {intro && (
        <p className="mb-2 text-sm text-[var(--color-text-secondary)]">
          {intro}
        </p>
      )}
      <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)]">
        {children}
      </div>
    </section>
  );
}

function FaqRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-4 border-b border-[var(--color-border)] px-3 py-2 text-sm last:border-b-0">
      <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
        {label}
      </div>
      <div className="leading-relaxed text-[var(--color-text-secondary)]">
        {children}
      </div>
    </div>
  );
}
