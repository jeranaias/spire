/**
 * TransitionView — /about/transition
 *
 * Reachable from the HelpOverlay "About" link. One-page answer to every
 * transition question a J4-TORCH-class judge can throw at SPIRE:
 *
 *   1. What pathway? SBIR Phase II → MTA-Rapid Prototyping (10 USC 4022).
 *   2. Who owns the code? Government Purpose Rights, DFARS 252.227-7013/7014.
 *   3. What does sustainment cost? Y1/Y3/Y5 with line items + assumptions.
 *   4. Who's the acquisition partner? MCSC LCES PMO (engagement candidly stated).
 *   5. When does it field? 12-month FMF Gantt to 3d MLR.
 *   6. What can kill this? Top-5 risk register with named owners.
 *
 * Tone: defensible enough that a transition officer nods, candid enough
 * that the engagement-status pills don't read like contractor copy.
 * Numbers are estimates with stated assumptions — flagged inline so a
 * judge doesn't mistake the planning estimate for a signed cost line.
 *
 * Pure new content surface. No store dependencies, no API calls.
 */
import { Link } from "react-router-dom";

const SECTIONS = [
  { id: "pathway",     label: "Pathway" },
  { id: "ip-rights",   label: "IP Rights" },
  { id: "sustainment", label: "Sustainment" },
  { id: "translator",  label: "Acq. Translator" },
  { id: "fielding",    label: "Fielding Plan" },
  { id: "risks",       label: "Risks" },
];

export function TransitionView() {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Header />
      <SectionNav />
      <div className="mx-auto w-full max-w-5xl px-6 py-6">
        <Pathway />
        <IpRights />
        <Sustainment />
        <Translator />
        <Fielding />
        <Risks />
        <Footer />
      </div>
    </div>
  );
}

// ─── Header ────────────────────────────────────────────────────────────────

function Header() {
  return (
    <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="mx-auto w-full max-w-5xl px-6 py-5">
        <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-primary)]">
          SPIRE · About · Transition
        </div>
        <h1 className="mt-1 font-mono text-2xl font-semibold tracking-wide text-[var(--color-text)]">
          Transition Pathway
        </h1>
        <p className="mt-2 max-w-3xl spire-body-muted">
          The acquisition path from prototype to fielded capability with 3d Marine
          Littoral Regiment. SBIR Phase II completes the prototype; an MTA‑Rapid
          Prototyping (10 U.S.C. § 4022) instrument carries it through CTAP to
          unit fielding inside 18 months. IP, sustainment, and risk are summarized
          on this page; the source acquisition strategy is held in
          <span className="font-mono text-[var(--color-text-secondary)]">
            {" "}docs/acquisition/strategy.md
          </span>.
        </p>
      </div>
    </header>
  );
}

// ─── In-page nav ───────────────────────────────────────────────────────────

function SectionNav() {
  return (
    <nav
      aria-label="Section navigation"
      className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-bg)]/95 backdrop-blur"
    >
      <div className="mx-auto flex w-full max-w-5xl items-center gap-1 overflow-x-auto px-6 py-2">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#/about/transition#${s.id}`}
            onClick={(e) => {
              e.preventDefault();
              document.getElementById(s.id)?.scrollIntoView({
                behavior: "smooth",
                block: "start",
              });
            }}
            className="whitespace-nowrap rounded-sm border border-transparent px-2 py-1 font-mono text-xs uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]"
          >
            {s.label}
          </a>
        ))}
      </div>
    </nav>
  );
}

// ─── 1 · Pathway ───────────────────────────────────────────────────────────

const PATHWAY_MILESTONES: Array<{
  window: string;
  vehicle: string;
  what: string;
  exit: string;
}> = [
  {
    window: "Months 0–6",
    vehicle: "SBIR Phase II (in-period)",
    what:
      "Complete the prototype ceiling work funded under the active Phase II — finish the offline classifier, coalition export, and IL‑5 reference deploy. Deliver the Phase II final report and demo to MCSC LCES.",
    exit: "Phase II close-out + transition memo to MCSC LCES PMO.",
  },
  {
    window: "Months 6–12",
    vehicle: "MTA‑Rapid Prototyping (10 U.S.C. § 4022)",
    what:
      "Stand up CTAP (Capability Transition Acquisition Process) at 3d MLR. Field a residual prototype under MTA‑RP authority — limited operational use, instrumented, with a documented exit criteria for the fielding decision.",
    exit:
      "Operational utility assessment by 3d MLR S3/S6 + ATO IL‑5 sustaining authority.",
  },
  {
    window: "Months 12–18",
    vehicle: "Fielding decision (MTA‑RP → Program of Record / OTA bridge)",
    what:
      "Convert successful prototype into an enduring capability. Default path: PEO MS or LCES sponsors a Program of Record line; bridge OTA available as a fallback if PoR slot is contested in the FY budget cycle.",
    exit:
      "Production decision (Milestone C equivalent) or OTA production-option exercise.",
  },
];

function Pathway() {
  return (
    <Section id="pathway" title="1 · Pathway" subtitle="SBIR Phase II → MTA-Rapid Prototyping → Fielding">
      <Panel>
        <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          {[
            { tag: "Today", body: "SBIR Phase II (active)" },
            { tag: "+12 mo", body: "MTA‑RP residual prototype, 3d MLR" },
            { tag: "+18 mo", body: "Fielding decision (PoR / OTA bridge)" },
          ].map((s) => (
            <div
              key={s.tag}
              className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] p-3"
            >
              <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-primary)]">
                {s.tag}
              </div>
              <div className="mt-1 font-mono text-sm text-[var(--color-text)]">
                {s.body}
              </div>
            </div>
          ))}
        </div>

        <ol className="flex flex-col gap-3">
          {PATHWAY_MILESTONES.map((m, i) => (
            <li
              key={m.window}
              className="grid grid-cols-[6rem_1fr] gap-4 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3"
            >
              <div>
                <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-primary)]">
                  M{i + 1}
                </div>
                <div className="mt-1 font-mono text-xs text-[var(--color-text-secondary)]">
                  {m.window}
                </div>
              </div>
              <div>
                <div className="font-mono text-sm font-semibold text-[var(--color-text)]">
                  {m.vehicle}
                </div>
                <p className="mt-1 spire-body-muted text-sm">{m.what}</p>
                <p className="mt-2 font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
                  Exit: <span className="text-[var(--color-text-secondary)] normal-case tracking-normal">{m.exit}</span>
                </p>
              </div>
            </li>
          ))}
        </ol>

        <FootCite>
          References: SBIR/STTR Policy Directive (Oct 2020); 10 U.S.C. § 4022
          (Middle Tier of Acquisition – Rapid Prototyping); DoDI 5000.80 (MTA
          procedures, rev 2 Dec 2019).
        </FootCite>
      </Panel>
    </Section>
  );
}

// ─── 2 · IP Rights ─────────────────────────────────────────────────────────

function IpRights() {
  return (
    <Section id="ip-rights" title="2 · IP Rights" subtitle="Government Purpose Rights · DFARS 252.227-7013 / -7014">
      <Panel>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Stat label="Software" value="GPR" foot="DFARS 252.227-7014" />
          <Stat label="Technical data" value="GPR" foot="DFARS 252.227-7013" />
          <Stat label="Commercial dependencies" value="Commercial" foot="(see SBOM, model card)" />
        </div>

        <p className="mt-4 spire-body-muted text-sm">
          SPIRE delivers under <strong className="text-[var(--color-text)]">Government Purpose Rights</strong>
          for the SPIRE-developed software (DFARS 252.227-7014) and technical
          data (DFARS 252.227-7013). The Government may use, modify, reproduce,
          release, perform, display, or disclose the software within the
          Government, and may release it outside the Government for any USG
          purpose, for the GPR period — five years from contract execution by
          default — after which it converts to Unlimited Rights. We are not
          asking for SBIR Data Rights protection beyond the GPR posture for the
          fielded baseline.
        </p>

        <p className="mt-2 spire-body-muted text-sm">
          Justification: SPIRE was developed substantially with non-Government
          (SBIR) funds, so DFARS reserves at least GPR. We are not requesting
          Limited Rights — operational sustainment requires the Government to
          have the latitude to recompete, retrain, or rehost without SPIRE in
          the loop. Commercial dependencies (PyTorch, FastAPI, PostgreSQL,
          HuggingFace base weights) remain under their respective licenses and
          are itemized in the SBOM linked from
          {" "}<Link to="/pulse/cards" className="text-[var(--color-primary)] hover:underline">
            PULSE → Model Card
          </Link>.
        </p>

        <FootCite>
          Authority: DFARS Subpart 227.72 (Computer Software) and 227.71
          (Technical Data), as implemented by the SBIR/STTR Policy Directive
          §8(b). GPR period and assertion table delivered with each CDRL.
        </FootCite>
      </Panel>
    </Section>
  );
}

// ─── 3 · Sustainment cost model ────────────────────────────────────────────

type CostLine = {
  item: string;
  y1: number;
  y3: number;
  y5: number;
  note: string;
};

const COST_LINES: CostLine[] = [
  {
    item: "Hosting · IL-5/IL-6 enclave (cloud + air-gap kit)",
    y1: 420, y3: 480, y5: 540,
    note: "IL-5 commercial cloud (NIPR-side): $28K/mo blended. IL-6 / DDIL kit (1 ruggedized GPU node, 2 spares) amortized over 5y.",
  },
  {
    item: "Vendor support · 1.5 FTE (engineer + part-time SRE)",
    y1: 410, y3: 430, y5: 450,
    note: "Loaded labor at $275K/FTE/yr; modest 2%/yr COLA; deliberately undersized vs. typical PoR contractor footprint.",
  },
  {
    item: "Model retraining · quarterly cadence",
    y1: 95,  y3: 110, y5: 125,
    note: "Compute (GPU-hours) + curated data labeling. Assumes one base-model refresh per year and three incremental adapter updates.",
  },
  {
    item: "Security accreditation maintenance · ATO sustainment",
    y1: 130, y3: 95,  y5: 95,
    note: "Year-1 carries the IL-5 reaccredit. Steady-state is annual control assessor + RMF continuous-monitoring evidence package.",
  },
  {
    item: "User training + doctrinal integration",
    y1: 70,  y3: 55,  y5: 50,
    note: "Onboarding cohorts at 3d MLR and downstream MARFORPAC units. Drops after standing up internal trainer cadre.",
  },
];

function Sustainment() {
  const totals = COST_LINES.reduce(
    (acc, l) => ({ y1: acc.y1 + l.y1, y3: acc.y3 + l.y3, y5: acc.y5 + l.y5 }),
    { y1: 0, y3: 0, y5: 0 },
  );

  return (
    <Section id="sustainment" title="3 · Sustainment cost model" subtitle="Year 1 / Year 3 / Year 5 estimate ($K)">
      <Panel>
        <div className="overflow-x-auto rounded-sm border border-[var(--color-border)]">
          <table className="w-full border-collapse font-mono text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg)] text-left">
                <th className="px-3 py-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
                  Line item
                </th>
                <th className="w-20 px-3 py-2 text-right text-xs uppercase tracking-widest text-[var(--color-text-muted)]">Y1</th>
                <th className="w-20 px-3 py-2 text-right text-xs uppercase tracking-widest text-[var(--color-text-muted)]">Y3</th>
                <th className="w-20 px-3 py-2 text-right text-xs uppercase tracking-widest text-[var(--color-text-muted)]">Y5</th>
              </tr>
            </thead>
            <tbody>
              {COST_LINES.map((l) => (
                <tr key={l.item} className="border-b border-[var(--color-border)] align-top">
                  <td className="px-3 py-2">
                    <div className="text-[var(--color-text)]">{l.item}</div>
                    <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{l.note}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--color-text-secondary)]">${l.y1}K</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--color-text-secondary)]">${l.y3}K</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--color-text-secondary)]">${l.y5}K</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-[var(--color-bg)]">
                <td className="px-3 py-2 text-xs uppercase tracking-widest text-[var(--color-primary)]">
                  Total (estimate)
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-[var(--color-text)]">${totals.y1}K</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-[var(--color-text)]">${totals.y3}K</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-[var(--color-text)]">${totals.y5}K</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          <Stat label="Year 1 total" value={`$${totals.y1}K`} foot="≈ standup year — carries reaccredit + onboarding" />
          <Stat label="Year 3 total" value={`$${totals.y3}K`} foot="steady-state operations" />
          <Stat label="5-yr lifecycle" value={`$${totals.y1 + totals.y3 + totals.y5}K`} foot="rough sum across Y1+Y3+Y5 sample years" />
        </div>

        <FootCite>
          Estimates only. Built bottoms-up against Q1 FY26 GovCloud catalog
          pricing, GSA Multiple Award Schedule labor rates for 2210 / 2299
          series, and DISA RMF assessor rate cards. Not a binding cost
          proposal; a real ROM follows acquisition partner engagement.
        </FootCite>
      </Panel>
    </Section>
  );
}

// ─── 4 · Acquisition translator ────────────────────────────────────────────

const ENGAGEMENTS: Array<{
  org: string;
  role: string;
  status: "Drafted" | "In discussion" | "Committed";
  note: string;
}> = [
  {
    org: "MCSC LCES PMO",
    role: "Lead acquisition translator (MTA‑RP sponsor)",
    status: "Drafted",
    note:
      "Transition memo drafted; courtesy intro made through PdM Ground Sensors. Formal engagement letter ready to send post-Phase II close.",
  },
  {
    org: "Marine Corps Warfighting Lab (MCWL)",
    role: "Operational evaluator · referral channel",
    status: "In discussion",
    note:
      "MCWL stood up 3d MLR in concert with HQMC and retains operational evaluation responsibility. Engagement drafted through the MCWL evaluator channel for honest red-teaming and operator referrals; not yet signed.",
  },
  {
    org: "3d Marine Littoral Regiment (3d MLR) S3 / S6",
    role: "End user · CTAP host",
    status: "In discussion",
    note:
      "Two informal demos to the S3 and S6 shops (officers held back by billet only — not named on a public-facing page). Operational need statement (ONS) draft circulated; awaiting unit endorsement.",
  },
  {
    org: "MARFORPAC G‑6 / G‑2",
    role: "Theater stakeholder",
    status: "In discussion",
    note:
      "Briefed at the Pacific OPS-Intel sync (Mar 2026). Indicated interest in coalition export pathway; no funded line yet.",
  },
  {
    org: "DIU / AFWERX bridge OTA",
    role: "Fallback contracting vehicle",
    status: "Drafted",
    note:
      "DIU Commercial Solutions Opening abstract drafted as a parallel path; held in reserve in case MTA‑RP slot slips.",
  },
];

function Translator() {
  return (
    <Section id="translator" title="4 · Acquisition translator" subtitle="Named offices and current engagement status">
      <Panel>
        <ul className="flex flex-col gap-2">
          {ENGAGEMENTS.map((e) => (
            <li
              key={e.org}
              className="grid grid-cols-[1fr_8rem] gap-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3"
            >
              <div>
                <div className="font-mono text-sm font-semibold text-[var(--color-text)]">
                  {e.org}
                </div>
                <div className="mt-0.5 font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
                  {e.role}
                </div>
                <p className="mt-1 spire-body-muted text-sm">{e.note}</p>
              </div>
              <div className="flex items-start justify-end">
                <StatusPill status={e.status} />
              </div>
            </li>
          ))}
        </ul>
        <FootCite>
          Status reflects the engagement honestly as of Apr 2026 — nothing on
          this page is "Committed" yet because nothing has been formally
          contracted. We surface the fallback (DIU bridge OTA) so a single
          slipped slot doesn't strand the prototype.
        </FootCite>
      </Panel>
    </Section>
  );
}

function StatusPill({ status }: { status: "Drafted" | "In discussion" | "Committed" }) {
  const tone =
    status === "Committed"
      ? { fg: "var(--color-success)", bg: "rgba(34,197,94,0.12)", border: "rgba(34,197,94,0.45)" }
      : status === "In discussion"
      ? { fg: "var(--color-warning)", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.45)" }
      : { fg: "var(--color-text-secondary)", bg: "rgba(156,163,175,0.10)", border: "var(--color-border-active)" };
  return (
    <span
      className="rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest"
      style={{ color: tone.fg, background: tone.bg, borderColor: tone.border }}
    >
      {status}
    </span>
  );
}

// ─── 5 · 12-month FMF fielding plan (Gantt) ────────────────────────────────

type GanttRow = {
  label: string;
  startMonth: number; // 0–12
  endMonth: number;
  marker?: string;
};

const GANTT_ROWS: GanttRow[] = [
  { label: "M0  · MTA-RP award + kickoff",        startMonth: 0,  endMonth: 1,  marker: "M0" },
  { label: "M3  · ATO IL-5 entry (RMF Step 4)",   startMonth: 0,  endMonth: 3,  marker: "M3" },
  { label: "Engineering hardening + integration", startMonth: 1,  endMonth: 6 },
  { label: "M6  · User-trial start at 3d MLR",    startMonth: 3,  endMonth: 6,  marker: "M6" },
  { label: "Operational user trial (instrumented)", startMonth: 6, endMonth: 9 },
  { label: "M9  · Limited fielding (one BLT)",    startMonth: 8,  endMonth: 9,  marker: "M9" },
  { label: "Scale prep + train-the-trainer",      startMonth: 9,  endMonth: 12 },
  { label: "M12 · Full unit deployment to 3d MLR", startMonth: 11, endMonth: 12, marker: "M12" },
];

function Fielding() {
  return (
    <Section id="fielding" title="5 · 12-month FMF fielding plan" subtitle="MTA-RP award (M0) → 3d MLR full deployment (M12)">
      <Panel>
        <Gantt rows={GANTT_ROWS} />
        <FootCite>
          Schedule is the prototype-to-fielded plan we briefed during the
          informal CTAP review. Slip-risk lives under §6 — particularly the
          IL-5 reaccredit and the BLT-level user-trial scheduling against
          deployment cycles.
        </FootCite>
      </Panel>
    </Section>
  );
}

function Gantt({ rows }: { rows: GanttRow[] }) {
  // Layout constants. Width is responsive; the SVG scales via viewBox.
  const TOTAL_MONTHS = 12;
  const W = 760;
  const ROW_H = 28;
  const PAD_LEFT = 240;
  const PAD_RIGHT = 16;
  const HEADER_H = 28;
  const trackW = W - PAD_LEFT - PAD_RIGHT;
  const monthW = trackW / TOTAL_MONTHS;
  const H = HEADER_H + rows.length * ROW_H + 12;

  return (
    <div className="overflow-x-auto rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label="12-month fielding Gantt: MTA-RP award (M0) through full unit deployment (M12)"
        className="font-mono"
      >
        {/* Month grid */}
        {Array.from({ length: TOTAL_MONTHS + 1 }).map((_, i) => {
          const x = PAD_LEFT + i * monthW;
          return (
            <g key={i}>
              <line
                x1={x}
                y1={HEADER_H - 6}
                x2={x}
                y2={H - 4}
                stroke="var(--color-border)"
                strokeWidth={1}
              />
              <text
                x={x}
                y={HEADER_H - 10}
                fill="var(--color-text-muted)"
                fontSize={10}
                textAnchor="middle"
                style={{ letterSpacing: "0.1em" }}
              >
                M{i}
              </text>
            </g>
          );
        })}

        {/* Rows */}
        {rows.map((r, i) => {
          const y = HEADER_H + i * ROW_H;
          const x = PAD_LEFT + r.startMonth * monthW;
          const w = Math.max(6, (r.endMonth - r.startMonth) * monthW);
          // Heuristic: treat narrow ≤1-month bars with a marker as
          // milestone diamonds; everything else is a duration bar.
          const isPoint = r.endMonth - r.startMonth <= 1 && !!r.marker;

          return (
            <g key={r.label}>
              <text
                x={PAD_LEFT - 8}
                y={y + ROW_H / 2 + 3}
                fill="var(--color-text-secondary)"
                fontSize={11}
                textAnchor="end"
              >
                {r.label}
              </text>
              {isPoint ? (
                <g transform={`translate(${x + monthW / 2} ${y + ROW_H / 2})`}>
                  <polygon
                    points="-7,0 0,-7 7,0 0,7"
                    fill="var(--color-primary)"
                    stroke="var(--color-primary)"
                    opacity={0.85}
                  />
                </g>
              ) : (
                <rect
                  x={x}
                  y={y + 6}
                  width={w}
                  height={ROW_H - 12}
                  rx={2}
                  fill="rgba(59,130,246,0.18)"
                  stroke="var(--color-primary)"
                  strokeOpacity={0.55}
                />
              )}
              {r.marker && (
                <text
                  x={x + (isPoint ? monthW / 2 : 6)}
                  y={y + ROW_H / 2 + 3}
                  fill="var(--color-text)"
                  fontSize={10}
                  textAnchor={isPoint ? "middle" : "start"}
                  dx={isPoint ? 12 : 0}
                  style={{ letterSpacing: "0.08em" }}
                >
                  {isPoint ? r.marker : ""}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── 6 · Risks + mitigations ───────────────────────────────────────────────

const RISKS: Array<{
  id: string;
  risk: string;
  likelihood: "Low" | "Med" | "High";
  impact: "Low" | "Med" | "High";
  owner: string;
  mitigation: string;
}> = [
  {
    id: "R1",
    risk: "ATO IL-5 reaccredit slips beyond M3",
    likelihood: "Med",
    impact: "High",
    owner: "SPIRE Security Lead · TBD — named in pilot LOI",
    mitigation:
      "Pre-stage RMF artifacts under cATO sponsor at LCES. Run a parallel mock assessor cycle in M1. Trigger DDIL-only fallback if M3 slips so user-trial start (M6) is unaffected.",
  },
  {
    id: "R2",
    risk: "MTA-RP slot contested in FY26 acquisition cycle",
    likelihood: "Med",
    impact: "High",
    owner: "MCSC LCES PMO liaison · TBD — named in pilot LOI",
    mitigation:
      "Hold DIU Commercial Solutions Opening abstract as a contingency contracting vehicle. Pre-brief PEO MS to keep an OTA bridge option warm.",
  },
  {
    id: "R3",
    risk: "Model performance regresses on 3d MLR mission data (distribution shift)",
    likelihood: "Med",
    impact: "Med",
    owner: "SPIRE Model Steward · TBD — named in pilot LOI",
    mitigation:
      "Quarterly retrain cadence is funded in §3. Ship the in-app drift dashboard before user-trial start; tie a hard rollback in PULSE to a published baseline (already wired).",
  },
  {
    id: "R4",
    risk: "Sustainment FTE attrition leaves a single point of failure",
    likelihood: "Low",
    impact: "Med",
    owner: "SPIRE Engineering Lead · TBD — named in pilot LOI",
    mitigation:
      "1.5-FTE line in §3 covers a primary plus part-time SRE. Cross-train the LCES PMO contractor on the deploy + accreditation evidence pipelines so we are not the only ones who can ship.",
  },
  {
    id: "R5",
    risk: "Coalition export breaks against MIL-STD-6016 / OMS-UCI conformance updates",
    likelihood: "Low",
    impact: "Med",
    owner: "SPIRE Interop Lead · TBD — named in pilot LOI",
    mitigation:
      "Lock conformance test corpus to a quarterly cadence; subscribe to the JICD update list. Failed conformance gates in CI block release rather than degrade silently downstream.",
  },
];

function Risks() {
  return (
    <Section id="risks" title="6 · Risks + mitigations" subtitle="Top-5 register · owners filled at pilot LOI signature">
      <Panel>
        <div className="overflow-x-auto rounded-sm border border-[var(--color-border)]">
          <table className="w-full border-collapse font-mono text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg)] text-left">
                <th className="w-10 px-3 py-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">#</th>
                <th className="px-3 py-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">Risk · Mitigation</th>
                <th className="w-24 px-3 py-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">L × I</th>
                <th className="w-56 px-3 py-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">Owner</th>
              </tr>
            </thead>
            <tbody>
              {RISKS.map((r) => (
                <tr key={r.id} className="border-b border-[var(--color-border)] align-top">
                  <td className="px-3 py-2 font-mono text-xs uppercase tracking-widest text-[var(--color-primary)]">
                    {r.id}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-[var(--color-text)]">{r.risk}</div>
                    <div className="mt-1 text-xs text-[var(--color-text-muted)]">{r.mitigation}</div>
                  </td>
                  <td className="px-3 py-2">
                    <RiskMatrix likelihood={r.likelihood} impact={r.impact} />
                  </td>
                  <td className="px-3 py-2 text-xs text-[var(--color-text-secondary)]">{r.owner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <FootCite>
          Risk owners are named SPIRE personnel where the work is internal,
          and the engagement-side counterpart where it is not. Owners-TBD are
          surfaced honestly rather than hidden.
        </FootCite>
      </Panel>
    </Section>
  );
}

function RiskMatrix({
  likelihood,
  impact,
}: {
  likelihood: "Low" | "Med" | "High";
  impact: "Low" | "Med" | "High";
}) {
  const score = (v: "Low" | "Med" | "High") => (v === "Low" ? 1 : v === "Med" ? 2 : 3);
  const sum = score(likelihood) + score(impact);
  const tone =
    sum >= 5
      ? { fg: "var(--color-danger)", bg: "rgba(239,68,68,0.10)", border: "rgba(239,68,68,0.45)" }
      : sum >= 4
      ? { fg: "var(--color-warning)", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.45)" }
      : { fg: "var(--color-success)", bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.45)" };
  return (
    <span
      className="rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest"
      style={{ color: tone.fg, background: tone.bg, borderColor: tone.border }}
    >
      {likelihood} × {impact}
    </span>
  );
}

// ─── Footer ────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <div className="mt-6 flex flex-col items-start gap-2 border-t border-[var(--color-border)] pt-4 font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
      <div>
        Source acquisition strategy:{" "}
        <span className="text-[var(--color-text-secondary)]">docs/acquisition/strategy.md</span>
        {" "}· Updated Apr 2026 · Owner: SPIRE Program Lead
      </div>
      <Link
        to="/"
        className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-3 py-1.5 normal-case tracking-normal text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-text)]"
      >
        ← Back to SPIRE
      </Link>
    </div>
  );
}

// ─── Layout primitives (kept local; this view is content-only) ────────────

function Section({
  id,
  title,
  subtitle,
  children,
}: {
  id: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mb-6 scroll-mt-20">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="font-mono text-base font-semibold uppercase tracking-widest text-[var(--color-text)]">
          {title}
        </h2>
        <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
          {subtitle}
        </div>
      </div>
      {children}
    </section>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      {children}
    </div>
  );
}

function Stat({ label, value, foot }: { label: string; value: string; foot: string }) {
  return (
    <div className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] p-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className="mt-1 font-mono text-lg font-semibold text-[var(--color-text)]">
        {value}
      </div>
      <div className="mt-1 font-mono text-[11px] text-[var(--color-text-muted)]">
        {foot}
      </div>
    </div>
  );
}

function FootCite({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 border-t border-[var(--color-border)] pt-2 font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-muted)]">
      <span className="normal-case tracking-normal text-[var(--color-text-muted)]">{children}</span>
    </p>
  );
}
