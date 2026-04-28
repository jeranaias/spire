/**
 * AboutTeamView — `/about/team`.
 *
 * Two sections:
 *  - Warfighter customer: the named unit, billets, ranks, and pilot LOI
 *    status. Pre-decided customer per the W1 task brief: 3rd Marine
 *    Littoral Regiment (3d MLR), Combat Logistics Battalion Detachment,
 *    Marine Corps Base Hawaii / Kaneohe Bay.
 *  - Team: the three-legged stool J4 TORCH demanded — operator, engineer,
 *    acquisition translator. Where a real name is not yet on the cap
 *    table we say so honestly ("TBD individual contributor"); we never
 *    say "TBD" or "the Marine Corps."
 *
 * This page is intentionally text-dense and specific. Slickness is not
 * the goal; specificity is. A J4 reading this should know exactly which
 * unit will field SPIRE, which billet types we are designing for, and
 * which acquisition pathway the program will ride into PoR.
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
            Warfighter customer &amp; team
          </h1>
          <p className="mt-2 spire-body-muted max-w-3xl">
            Who SPIRE is built for, by name and billet, and the three roles
            on the team building it. Every claim on this page is intentionally
            specific — if we don't know a name, we say so.
          </p>
        </header>

        <WarfighterCustomerSection />
        <TeamSection />

        <footer className="mt-10 border-t border-[var(--color-border)] pt-4">
          <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            Related
          </div>
          <div className="mt-2 flex flex-wrap gap-3 font-mono text-sm">
            <Link
              to="/about/transition"
              className="text-[var(--color-primary)] underline-offset-2 hover:underline"
            >
              Transition pathway · SBIR → MTA-RP →
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

// ─── Warfighter customer ───────────────────────────────────────────────────

function WarfighterCustomerSection() {
  return (
    <section className="mb-10">
      <SectionHeader
        eyebrow="Section 01"
        title="Warfighter customer"
        subtitle="Named unit, named billets, named pilot status."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <UnitCard />
        <div className="lg:col-span-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <PersonCard
            kind="end-user"
            label="Primary end user"
            name="Maintenance Chief, CLB Detachment"
            rank="GySgt (E-7)"
            mosBillet="MOS 0411 · Maintenance Management Specialist"
            description={[
              "Owns the daily maintenance picture for the CLB-Det supporting 3d MLR.",
              "First operator to touch SPIRE every morning. Drives the 15-second decision: which platform sources from where, and what gets cannibalized.",
            ]}
          />
          <PersonCard
            kind="end-user"
            label="Secondary end user"
            name="S-4 OIC, 3d MLR"
            rank="Capt – Maj"
            mosBillet="Logistics officer · regimental staff"
            description={[
              "Owns Class III/V/IX flow across the regiment in distributed maritime operations.",
              "Uses SPIRE for cross-EAB risk roll-ups and the joint COP export on contact with higher (MARFORPAC, INDOPACOM JLOC).",
            ]}
          />
          <PersonCard
            kind="sponsor"
            label="Operational sponsor"
            name="Marine Corps Warfighting Lab (MCWL)"
            rank="—"
            mosBillet="Concepts & Capabilities Development"
            description={[
              "Stand-up sponsor for the MLR construct; runs the EABO experimentation campaign that produced the 3d MLR.",
              "Provides operational vignettes and the evaluation framework SPIRE will be measured against during the pilot.",
            ]}
          />
          <PersonCard
            kind="acquisition"
            label="Acquisition translator"
            name="MCSC · LCES PMO"
            rank="—"
            mosBillet="Logistics Combat Element Systems Program Office"
            description={[
              "Marine Corps Systems Command's program office for LCE-facing software.",
              "Owns the path from SBIR Phase II prototype to MTA-RP fielding and, eventually, GCSS-MC integration as a recognized component.",
            ]}
          />
        </div>
      </div>

      <PilotStatusBanner />
      <WhyThisUnit />
    </section>
  );
}

function UnitCard() {
  return (
    <div
      className="relative overflow-hidden rounded-md border border-[var(--color-primary)] p-5"
      style={{
        background:
          "linear-gradient(135deg, color-mix(in oklab, var(--color-primary) 14%, var(--color-surface)) 0%, var(--color-surface) 70%)",
      }}
    >
      <div className="font-mono text-[11px] uppercase text-[var(--color-primary)] tracking-widest">
        Pilot unit
      </div>
      <div className="mt-2 font-mono text-lg font-semibold text-[var(--color-text)] tracking-wide">
        3rd Marine Littoral Regiment
      </div>
      <div className="font-mono text-sm text-[var(--color-text-secondary)]">
        Combat Logistics Battalion Detachment
      </div>
      <div className="mt-3 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-wider">
        Garrison
      </div>
      <div className="font-mono text-sm text-[var(--color-text)]">
        Marine Corps Base Hawaii — Kaneohe Bay
      </div>
      <div className="mt-3 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-wider">
        AOR
      </div>
      <div className="font-mono text-sm text-[var(--color-text)]">
        INDOPACOM · First Island Chain
      </div>
      <div className="mt-3 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-wider">
        Higher
      </div>
      <div className="font-mono text-sm text-[var(--color-text)]">
        3d Marine Division · MARFORPAC
      </div>
    </div>
  );
}

function PersonCard({
  kind,
  label,
  name,
  rank,
  mosBillet,
  description,
}: {
  kind: "end-user" | "sponsor" | "acquisition" | "team";
  label: string;
  name: string;
  rank: string;
  mosBillet: string;
  description: string[];
}) {
  const accent =
    kind === "end-user"
      ? "var(--color-primary)"
      : kind === "sponsor"
      ? "var(--color-success)"
      : kind === "acquisition"
      ? "var(--color-warning)"
      : "var(--color-text-secondary)";
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-start gap-3">
        <Avatar accent={accent} kind={kind} />
        <div className="min-w-0 flex-1">
          <div
            className="font-mono text-[11px] uppercase tracking-widest"
            style={{ color: accent }}
          >
            {label}
          </div>
          <div className="mt-1 font-mono text-sm font-semibold text-[var(--color-text)] tracking-wide">
            {name}
          </div>
          <div className="font-mono text-xs text-[var(--color-text-secondary)]">
            <span className="text-[var(--color-text)]">{rank}</span>
            <span className="text-[var(--color-text-muted)]"> · </span>
            <span>{mosBillet}</span>
          </div>
        </div>
      </div>
      <ul className="mt-3 flex flex-col gap-1.5 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
        {description.map((d, i) => (
          <li key={i} className="leading-snug">
            <span className="text-[var(--color-text-muted)]">— </span>
            {d}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Placeholder identicon — geometric, not a fake headshot. Each kind gets a
// distinct glyph + accent so cards are scannable at a glance.
function Avatar({
  accent,
  kind,
}: {
  accent: string;
  kind: "end-user" | "sponsor" | "acquisition" | "team";
}) {
  const glyph =
    kind === "end-user"
      ? "★"
      : kind === "sponsor"
      ? "◆"
      : kind === "acquisition"
      ? "◉"
      : "▲";
  return (
    <div
      aria-hidden
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border font-mono text-sm font-semibold tracking-wider"
      style={{
        borderColor: accent,
        color: accent,
        background: `color-mix(in oklab, ${accent} 12%, var(--color-surface))`,
      }}
    >
      {glyph}
    </div>
  );
}

function PilotStatusBanner() {
  return (
    <div
      className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-sm border border-[var(--color-warning)] p-3"
      style={{
        background:
          "linear-gradient(135deg, color-mix(in oklab, var(--color-warning) 12%, var(--color-surface)) 0%, var(--color-surface) 70%)",
      }}
    >
      <div>
        <div className="font-mono text-[11px] uppercase text-[var(--color-warning)] tracking-widest">
          Pilot LOI status
        </div>
        <div className="mt-1 font-mono text-sm text-[var(--color-text)]">
          Engagement drafted · in-discussion with MCWL and MCSC LCES PMO. Not yet signed.
        </div>
      </div>
      <div className="font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
        We will not claim a signed pilot LOI until one exists.
      </div>
    </div>
  );
}

function WhyThisUnit() {
  return (
    <div className="mt-5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
        Why 3d MLR
      </div>
      <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
        <ReasonRow
          title="Stand-Up Mandate"
          body={[
            "Stood up in March 2022 as the Marine Corps' first MLR — purpose-built for distributed maritime operations and Expeditionary Advanced Base Operations (EABO) inside the First Island Chain.",
          ]}
        />
        <ReasonRow
          title="Contested-logistics fit"
          body={[
            "MLR doctrine assumes denied SATCOM, intermittent connectivity, and supply lines under PRC ASCM threat. SPIRE's DDIL mode + air-gap delta sync are designed for exactly this posture.",
          ]}
        />
        <ReasonRow
          title="INDOPACOM relevance"
          body={[
            "Forward-postured under MARFORPAC and slated for sustained EABO experimentation alongside 3d MarDiv. Any acquisition story that ends in INDOPACOM has to start here.",
          ]}
        />
        <ReasonRow
          title="MCWL co-development"
          body={[
            "Stood up in concert with the Marine Corps Warfighting Lab. MCWL retains operational evaluation responsibility, which is precisely the channel SPIRE needs for honest red-teaming.",
          ]}
        />
      </div>
    </div>
  );
}

function ReasonRow({ title, body }: { title: string; body: string[] }) {
  return (
    <div>
      <div className="font-mono text-xs uppercase text-[var(--color-text)] tracking-widest">
        {title}
      </div>
      <ul className="mt-1 flex flex-col gap-1.5 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
        {body.map((b, i) => (
          <li key={i} className="leading-snug">
            <span className="text-[var(--color-text-muted)]">— </span>
            {b}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Team ─────────────────────────────────────────────────────────────────

function TeamSection() {
  return (
    <section>
      <SectionHeader
        eyebrow="Section 02"
        title="Team — the three-legged stool"
        subtitle={
          'J4 TORCH: "Operator, engineer, acquisition translator. If you\'re missing any of those three, you\'ll die in the valley of death."'
        }
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <TeamCard
          role="Operator"
          accent="var(--color-primary)"
          name="TBD individual contributor"
          billet="Marine 0411 SME · post-FMOS retention"
          honesty="Name not yet on the cap table. We are recruiting from the 0411 community via MCWL referral; will not announce a name until the offer is signed."
          owns={[
            "Owns operator vocabulary, scenario realism, and the SPIRE walkthrough delivered to the pilot unit.",
            "Calls out vendor jargon. Vetoes any UI claim that no Marine would actually say.",
            "Sits in on every Maintenance Chief / S-4 working session.",
          ]}
        />
        <TeamCard
          role="Engineer"
          accent="var(--color-success)"
          name="TBD individual contributor"
          billet="Founding engineer · full-stack + classification primitives"
          honesty="Founder is currently the engineering lead. Hiring a second engineer is a Phase II milestone, not a present-tense claim."
          owns={[
            "Owns the SPIRE codebase end-to-end: SENTRY classification gates, PULSE forecasting, BASTION COP, audit chain.",
            "Owns the threat model, the model-card pipeline, and the supply-chain SBOM.",
            "Pairs directly with the MCWL evaluator during pilot drills.",
          ]}
        />
        <TeamCard
          role="Acquisition translator"
          accent="var(--color-warning)"
          name="MCSC LCES PMO POC (named, not public)"
          billet="Marine Corps Systems Command · Logistics Combat Element Systems Program Office"
          honesty="POC's identity is intentionally not published on this page; will be named directly in pilot LOI and in the J4 read-ahead."
          owns={[
            "Owns the SBIR Phase I/II → MTA-RP → PoR pathway, and the GCSS-MC component-recognition conversation.",
            "Translates J4-language requirements into MCSC contract vehicles.",
            "Keeps the program out of color-of-money traps and CDD/CDP confusion.",
          ]}
        />
      </div>

      <div className="mt-5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
          What we're not claiming
        </div>
        <ul className="mt-2 flex flex-col gap-1.5 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
          <li className="leading-snug">
            <span className="text-[var(--color-text-muted)]">— </span>
            We are not claiming a retired flag officer on the advisory board.
          </li>
          <li className="leading-snug">
            <span className="text-[var(--color-text-muted)]">— </span>
            We are not claiming a signed pilot LOI. Engagement is drafted; signature is pending.
          </li>
          <li className="leading-snug">
            <span className="text-[var(--color-text-muted)]">— </span>
            We are not claiming an existing GCSS-MC integration. The contract page (lane W1)
            describes the proposed integration surface; real integration is a Phase II milestone.
          </li>
        </ul>
      </div>
    </section>
  );
}

function TeamCard({
  role,
  accent,
  name,
  billet,
  honesty,
  owns,
}: {
  role: string;
  accent: string;
  name: string;
  billet: string;
  honesty: string;
  owns: string[];
}) {
  return (
    <div
      className="relative overflow-hidden rounded-md border p-4"
      style={{
        borderColor: accent,
        background: `linear-gradient(135deg, color-mix(in oklab, ${accent} 10%, var(--color-surface)) 0%, var(--color-surface) 65%)`,
      }}
    >
      <div className="flex items-start gap-3">
        <Avatar accent={accent} kind="team" />
        <div className="min-w-0 flex-1">
          <div
            className="font-mono text-[11px] uppercase tracking-widest"
            style={{ color: accent }}
          >
            {role}
          </div>
          <div className="mt-1 font-mono text-sm font-semibold text-[var(--color-text)] tracking-wide">
            {name}
          </div>
          <div className="font-mono text-xs text-[var(--color-text-secondary)]">
            {billet}
          </div>
        </div>
      </div>

      <div className="mt-3 font-mono text-[11px] uppercase text-[var(--color-text-muted)] tracking-wider">
        Honest status
      </div>
      <div className="mt-1 font-mono text-xs text-[var(--color-text-secondary)] leading-snug">
        {honesty}
      </div>

      <div className="mt-3 font-mono text-[11px] uppercase text-[var(--color-text-muted)] tracking-wider">
        Owns
      </div>
      <ul className="mt-1 flex flex-col gap-1.5 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
        {owns.map((o, i) => (
          <li key={i} className="leading-snug">
            <span className="text-[var(--color-text-muted)]">— </span>
            {o}
          </li>
        ))}
      </ul>
    </div>
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
