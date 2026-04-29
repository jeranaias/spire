/**
 * TransitionView — `/about/transition`.
 *
 * Honest single-page replacement for the original 800-line acquisition
 * pathway treatise (SBIR Phase II → MTA-RP → fielding gantt). For a
 * 72-hour TRL 3 hackathon prototype, the prior framing implied an
 * active SBIR Phase II + named pilot + acquisition partner that do
 * not exist. Path forward is one paragraph: standard small-business
 * pipeline, IF a sponsor emerges, with the unblocks named honestly.
 */
import { Link } from "react-router-dom";

export function TransitionView() {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl p-6">
        <header className="mb-8 border-b border-[var(--color-border)] pb-4">
          <div className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
            SPIRE · Path forward
          </div>
          <h1 className="mt-1 font-mono text-2xl font-semibold text-[var(--color-text)] tracking-wide">
            What happens next
          </h1>
          <p className="mt-2 spire-body-muted max-w-3xl">
            The honest answer. One page, no gantts, no FAR citations.
            If the program advances, this page grows.
          </p>
        </header>

        <section
          className="mb-6 rounded-md border p-5"
          style={{
            borderColor: "var(--color-warning)",
            background:
              "linear-gradient(135deg, color-mix(in oklab, var(--color-warning) 12%, var(--color-surface)) 0%, var(--color-surface) 70%)",
          }}
        >
          <div className="font-mono text-xs uppercase text-[var(--color-warning)] tracking-widest">
            Today
          </div>
          <div className="mt-1 font-mono text-base font-semibold text-[var(--color-text)] tracking-wide">
            72-hour MDM 2026 hackathon prototype · TRL 3
          </div>
          <p className="mt-3 text-sm leading-relaxed text-[var(--color-text-secondary)]">
            Proof of concept on a deterministic synthetic dataset.
            Algorithms work, IL5-shaped architecture, hash-chained
            audit ledger, MIL-STD-2525D COP. No live deployment, no
            ATO, no signed pilot, no real GCSS-MC integration. That is
            the bar this build clears — nothing more.
          </p>
        </section>

        <section className="mb-6 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            If a sponsor emerges
          </div>
          <p className="mt-3 text-sm leading-relaxed text-[var(--color-text)]">
            The standard small-business path applies — SBIR Phase I
            for concept validation against a real GCSS-MC pull-through,
            Phase II for prototype hardening + ATO work, then either
            an MTA-Rapid Prototyping authority for limited operational
            fielding or a program-of-record handoff via MCSC LCES PMO.
            We are not on that path today. We have not engaged MCSC,
            MCWL, or any program office formally. This page exists to
            acknowledge the pathway exists, not to claim we are on it.
          </p>
        </section>

        <section className="mb-6 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            What we would need to advance
          </div>
          <ul className="mt-2 flex flex-col gap-2 text-sm text-[var(--color-text-secondary)] leading-snug">
            <li>
              <span className="text-[var(--color-text-muted)]">1. </span>
              A sponsoring unit willing to point a real (sanitized)
              GCSS-MC export at the ingest path and run a 30-day
              evaluation.
            </li>
            <li>
              <span className="text-[var(--color-text-muted)]">2. </span>
              A Marine Corps Warfighting Lab evaluator to red-team
              the SENTRY sanitization gate against operator-malpractice
              patterns.
            </li>
            <li>
              <span className="text-[var(--color-text-muted)]">3. </span>
              An MCSC POC who can translate operator-side requirements
              into a contract vehicle without committing color of
              money we do not have.
            </li>
            <li>
              <span className="text-[var(--color-text-muted)]">4. </span>
              Time. Everything above is a months-not-weeks
              conversation.
            </li>
          </ul>
        </section>

        <footer className="mt-8 border-t border-[var(--color-border)] pt-4">
          <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            Related
          </div>
          <div className="mt-2 flex flex-wrap gap-3 font-mono text-sm">
            <Link
              to="/about/team"
              className="text-[var(--color-primary)] underline-offset-2 hover:underline"
            >
              ← Customer &amp; team
            </Link>
          </div>
        </footer>
      </div>
    </div>
  );
}
