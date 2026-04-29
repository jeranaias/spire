/**
 * AboutTeamView — `/about/team`.
 *
 * Honest hackathon framing:
 *   - TRL 3 disclosure card at the top: 72-hour build, proof-of-concept
 *     on synthetic data, not a fielded program.
 *   - Ideal customer (generic shape, not a named-and-confirmed unit):
 *     Marines doing distributed maritime ops under contested logistics.
 *   - The team: four active-duty Marines augmented by AI tooling and a
 *     vision. Plain-language. No "TBD individual contributor." No
 *     SBIR-Phase-II-as-if-active framing.
 *   - "What we're not claiming" stays — that's the load-bearing honesty
 *     that a J4 read-ahead will lean on.
 *
 * Keep this page short on purpose. A judge should be able to read it
 * once and walk away knowing exactly what stage this is at.
 */
import { Link } from "react-router-dom";

export function AboutTeamView() {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl p-6">
        <header className="mb-8 border-b border-[var(--color-border)] pb-4">
          <div className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
            SPIRE · About
          </div>
          <h1 className="mt-1 font-mono text-2xl font-semibold text-[var(--color-text)] tracking-wide">
            Customer &amp; team
          </h1>
          <p className="mt-2 spire-body-muted max-w-3xl">
            Who SPIRE is built for and who built it. Built in 72 hours
            for the MDM 2026 hackathon. Read this page as a snapshot,
            not a program brief.
          </p>
        </header>

        <ReadinessLevelCard />
        <IdealCustomerSection />
        <TeamSection />
        <NotClaimingSection />

        <footer className="mt-10 border-t border-[var(--color-border)] pt-4">
          <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            Related
          </div>
          <div className="mt-2 flex flex-wrap gap-3 font-mono text-sm">
            <Link
              to="/about/transition"
              className="text-[var(--color-primary)] underline-offset-2 hover:underline"
            >
              Path forward (one paragraph) →
            </Link>
            <span className="text-[var(--color-text-muted)]">·</span>
            <span className="text-[var(--color-text-muted)]">
              Press <kbd className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-1.5 text-xs">?</kbd> for help &amp; shortcuts.
            </span>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ─── Readiness-level disclosure ───────────────────────────────────────────

function ReadinessLevelCard() {
  return (
    <section
      className="mb-8 rounded-md border p-5"
      style={{
        borderColor: "var(--color-warning)",
        background:
          "linear-gradient(135deg, color-mix(in oklab, var(--color-warning) 12%, var(--color-surface)) 0%, var(--color-surface) 70%)",
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <div className="font-mono text-xs uppercase text-[var(--color-warning)] tracking-widest">
            Readiness level · honest
          </div>
          <div className="mt-1 font-mono text-lg font-semibold text-[var(--color-text)] tracking-wide">
            TRL 3 — proof of concept, synthetic data
          </div>
        </div>
        <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
          MDM 2026 · 72-hour build
        </div>
      </div>
      <p className="mt-3 spire-body-muted text-sm leading-relaxed max-w-3xl">
        SPIRE is a 72-hour hackathon prototype demonstrating the
        contested-logistics OS pattern on a deterministic synthetic
        dataset. The algorithms are real. The IL5 architecture is
        designed-in. The dataset is not — it's a seeded reproduction
        of GCSS-MC export shape, not a live feed. There is no
        production deployment, no ATO, no live integrations. Path to
        TRL 4 (relevant-environment validation) requires a real
        GCSS-MC pull-through and a sponsoring unit.
      </p>
    </section>
  );
}

// ─── Ideal customer ───────────────────────────────────────────────────────

function IdealCustomerSection() {
  return (
    <section className="mb-10">
      <SectionHeader
        eyebrow="Section 01"
        title="Ideal customer"
        subtitle="The shape of unit SPIRE is built for. Not a named pilot — a pattern."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div
          className="lg:col-span-2 rounded-md border border-[var(--color-border)] p-5"
          style={{
            background:
              "linear-gradient(135deg, color-mix(in oklab, var(--color-primary) 8%, var(--color-surface)) 0%, var(--color-surface) 70%)",
          }}
        >
          <div className="font-mono text-[11px] uppercase text-[var(--color-primary)] tracking-widest">
            Who this is built for
          </div>
          <p className="mt-3 text-sm leading-relaxed text-[var(--color-text)]">
            A Marine Corps logistics-forward billet operating under
            contested conditions — distributed maritime operations,
            EABO inside the First Island Chain, intermittent SATCOM,
            supply lines under threat. A maintenance chief or S-4
            officer who has to make a 15-second readiness call without
            a connection to higher.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-[var(--color-text-secondary)]">
            III MEF / 3d MarDiv units conducting EABO in the Indo-Pacific
            are the canonical fit. The pattern generalizes to any unit
            running Class IX maintenance on a deterministic clock with
            unreliable comms back to garrison.
          </p>
        </div>
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="font-mono text-[11px] uppercase text-[var(--color-text-muted)] tracking-widest">
            Who this is NOT built for
          </div>
          <ul className="mt-2 flex flex-col gap-2 text-xs text-[var(--color-text-secondary)] leading-snug">
            <li>
              <span className="text-[var(--color-text-muted)]">— </span>
              Garrison units with reliable network and existing GCSS-MC
              workflows that work fine.
            </li>
            <li>
              <span className="text-[var(--color-text-muted)]">— </span>
              Strategic-level enterprise dashboards. SPIRE is operator-
              first, tactical-edge first.
            </li>
            <li>
              <span className="text-[var(--color-text-muted)]">— </span>
              Joint logistics fusion at the COCOM J4 level. We're a
              MEF-down tool, not a JLOC tool.
            </li>
            <li>
              <span className="text-[var(--color-text-muted)]">— </span>
              Anyone who needs an ATO today. Not there yet.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

// ─── Team ─────────────────────────────────────────────────────────────────

function TeamSection() {
  return (
    <section className="mb-8">
      <SectionHeader
        eyebrow="Section 02"
        title="The team"
        subtitle="Four active-duty Marines, augmented by AI tooling, building toward a vision."
      />

      <div
        className="rounded-md border border-[var(--color-border)] p-5"
        style={{
          background:
            "linear-gradient(135deg, color-mix(in oklab, var(--color-primary) 5%, var(--color-surface)) 0%, var(--color-surface) 75%)",
        }}
      >
        <div className="font-mono text-[11px] uppercase text-[var(--color-primary)] tracking-widest">
          At a glance
        </div>
        <p className="mt-3 text-sm leading-relaxed text-[var(--color-text)]">
          SPIRE was designed and built by four active-duty Marines on
          duty time, augmented by AI tooling we leveraged as a force
          multiplier — for code generation, code review, and pattern
          research. No external contractors. No paid advisors. The
          warfighter perspective is on the team because the team IS
          the warfighter.
        </p>

        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
          <BulletCard
            label="What's on the team"
            items={[
              "Active-duty USMC operators — domain knowledge embedded.",
              "Engineering capacity — full-stack, classification primitives, audit-chain ledger.",
              "AI tooling as a force multiplier — local LLM for code generation + research, never as the operator.",
              "A clear vision: contested-logistics OS for distributed Marine ops.",
            ]}
          />
          <BulletCard
            label="What's not on the team — yet"
            items={[
              "A retired flag officer on an advisory board.",
              "A classified-network deployment partner.",
              "A signed pilot agreement with a named unit.",
              "A program manager. Hackathon mode, not acquisition mode.",
            ]}
            tone="muted"
          />
        </div>
      </div>
    </section>
  );
}

function BulletCard({
  label,
  items,
  tone,
}: {
  label: string;
  items: string[];
  tone?: "muted";
}) {
  const accent = tone === "muted" ? "var(--color-text-muted)" : "var(--color-primary)";
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <div
        className="font-mono text-[11px] uppercase tracking-widest"
        style={{ color: accent }}
      >
        {label}
      </div>
      <ul className="mt-2 flex flex-col gap-1.5 text-xs text-[var(--color-text-secondary)] leading-snug">
        {items.map((it, i) => (
          <li key={i}>
            <span className="text-[var(--color-text-muted)]">— </span>
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── What we're not claiming ──────────────────────────────────────────────

function NotClaimingSection() {
  return (
    <section className="mb-4">
      <SectionHeader
        eyebrow="Section 03"
        title="What we're not claiming"
        subtitle="The honest list. If it's not here, we don't have it yet."
      />
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <ul className="flex flex-col gap-2 text-sm text-[var(--color-text-secondary)] leading-snug">
          <li>
            <span className="text-[var(--color-text-muted)]">— </span>
            We are not at TRL 4. The dataset is synthetic. Validation
            in a relevant environment is the next ring.
          </li>
          <li>
            <span className="text-[var(--color-text-muted)]">— </span>
            We do not have a signed pilot LOI. We have not engaged
            MCSC LCES PMO or MCWL formally. Anything implying we have
            is wrong.
          </li>
          <li>
            <span className="text-[var(--color-text-muted)]">— </span>
            We do not have a real GCSS-MC integration. SPIRE consumes
            the export shape; live pull-through is a future-tense item.
          </li>
          <li>
            <span className="text-[var(--color-text-muted)]">— </span>
            We do not have a FedRAMP authorization, an ATO, or a
            classified-network deployment.
          </li>
          <li>
            <span className="text-[var(--color-text-muted)]">— </span>
            The SENTRY classifier is rule-based today; the LLM cascade
            is wired but the model is not loaded in this build (the
            footer chip honestly labels it "rule-based fallback").
          </li>
          <li>
            <span className="text-[var(--color-text-muted)]">— </span>
            The CRDT sync layer ships the math + UI surface; per-
            mutation vector-clock bookkeeping in the audit chain is
            the production work, not done yet.
          </li>
        </ul>
      </div>
    </section>
  );
}

// ─── Shared ───────────────────────────────────────────────────────────────

function SectionHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-4">
      <div className="font-mono text-[11px] uppercase text-[var(--color-text-muted)] tracking-widest">
        {eyebrow}
      </div>
      <h2 className="mt-1 font-mono text-lg font-semibold text-[var(--color-text)] tracking-wide">
        {title}
      </h2>
      <p className="mt-1 spire-body-muted max-w-3xl">{subtitle}</p>
    </div>
  );
}
