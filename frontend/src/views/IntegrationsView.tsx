/**
 * IntegrationsView — system-of-record adapter contracts.
 *
 * Wave 1 / Task #27 — GCSS-MC. J1 IRONSIDE asked SPIRE where the data
 * actually lives. This page answers: documented field mapping against
 * the Marine Corps' real logistics system of record (GCSS-MC), polling
 * cadence, auth model, ATO posture, and failure-mode behavior. A live
 * sample endpoint backs the contract roundtrip so a judge can curl it
 * during the demo.
 *
 * This is a REFERENCE IMPLEMENTATION — the connection is intentionally
 * mocked, labeled as such, and grounded in the synthetic dataset. No
 * pretend "live" production link.
 *
 * Task #74 — Honesty pass. The first read of this page made shipped
 * claims out of unbuilt aspirations (15-min JWT, IL-5 enclave, 0400Z
 * pull, circuit breaker, sync-conflict viewer). A 10pt corner chip
 * does not scale to a CDAO conference-room projector. This pass:
 *   - Hoists a persistent CAPCO-chrome banner ("UNBUILT · PRE-
 *     COORDINATION PENDING WITH PM GCSS-MC AND THE IL-5 ENCLAVE AO")
 *     that re-prints above every claim section.
 *   - Stamps every ATO-touching card with a hard "PRE-ATO · NOT
 *     ACCREDITED" badge that survives projection scale.
 *   - Rewrites Authentication / ATO posture / Failure modes copy with
 *     explicit "Target:" / "Planned:" framing wherever the behavior is
 *     not in code today.
 *   - Aligns the Authentication card with the actual session model
 *     (12h HMAC-signed cookie; no JWT; no re-tap) — see
 *     `backend/auth.py` `SESSION_TTL_SECONDS` and `sign_session`.
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { ErrorState, LoadingState, Pressable } from "../components/ui";

const BASE = "/api";

interface SamplePayload {
  _mock: {
    label: string;
    warning: string;
    shape_version: string;
    spec_sources: string[];
    filters_applied: { limit: number; uic: string | null };
    as_of_dataset_day: string | null;
  };
  field_mapping_reference: Record<string, Record<string, string>>;
  EQUIPMENT_MASTER: Record<string, unknown>[];
  MIMMS_DAILY_READINESS: Record<string, unknown>[];
  EQUIPMENT_REPAIR_ORDER: Record<string, unknown>[];
  SUPPLY_DOC: Record<string, unknown>[];
  totals_in_canonical_dataset: Record<string, number>;
}

async function fetchSample(): Promise<SamplePayload> {
  const r = await fetch(`${BASE}/integrations/gcss-mc/sample?limit=3`, {
    credentials: "include",
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

export function IntegrationsView() {
  // Route is /integrations/gcss-mc — the slug is fixed for now (only one
  // adapter contract exists), but plumbing the param keeps us ready for
  // /integrations/palantir, /integrations/magtf-ii etc. without churn.
  const params = useParams<{ system?: string }>();
  const system = (params.system || "gcss-mc").toLowerCase();
  if (system !== "gcss-mc") {
    return (
      <ErrorState
        title="Adapter not implemented"
        description={`No reference adapter exists yet for "${system}". GCSS-MC is the only system-of-record contract documented in this build.`}
      />
    );
  }
  return <GcssMcContractPage />;
}

function GcssMcContractPage() {
  const [sample, setSample] = useState<SamplePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSample()
      .then((p) => {
        if (!cancelled) setSample(p);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="h-full overflow-y-auto bg-[var(--color-bg)]">
      {/* Sticky CAPCO-chrome unbuilt banner. Sits above the scroll
       * region so a judge sees it the instant the page paints, and
       * stays pinned while they scroll through the ATO copy. */}
      <UnbuiltBanner sticky />
      <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
        <ContractHeader />
        <FieldMappingSection sample={sample} />
        <PollingCadenceSection />
        <AuthSection />
        <AtoSection />
        <FailureModesSection />
        <SampleEndpointSection sample={sample} error={error} />
        <FooterCitations />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Persistent UNBUILT banner + PRE-ATO stamp
//
// CAPCO-style solid color block, full width, white text, no gradient. Same
// chrome the operator sees on the classification band so it reads as
// "official integrity-of-claims notice", not decorative chip. Re-printed
// above every section that touches ATO / auth / failure-mode claims so a
// projector audience cannot miss it.
// ---------------------------------------------------------------------------

const UNBUILT_BG = "#B8460E";  // CAPCO-adjacent burnt-orange. Distinct from
                                // the SECRET red and the FPCON warning amber
                                // so it reads as its own integrity stamp.

function UnbuiltBanner({ sticky = false }: { sticky?: boolean }) {
  return (
    <div
      className={
        (sticky ? "sticky top-0 z-20 " : "") +
        "flex h-9 shrink-0 items-center justify-between px-4 py-1 font-mono text-sm font-semibold uppercase tracking-widest"
      }
      style={{ background: UNBUILT_BG, color: "#FFFFFF" }}
      role="region"
      aria-label="Integrations contract integrity-of-claims banner"
    >
      <span className="whitespace-nowrap">
        UNBUILT · REFERENCE CONTRACT ONLY · NO LIVE GCSS-MC LINK
      </span>
      <span
        className="hidden shrink-0 rounded-sm border px-2.5 py-[2px] font-mono text-xs leading-none tracking-widest sm:inline-flex"
        style={{
          borderColor: "rgba(255,255,255,0.55)",
          background: "rgba(0,0,0,0.25)",
        }}
      >
        PRE-COORDINATION PENDING · PM GCSS-MC + IL-5 ENCLAVE AO
      </span>
    </div>
  );
}

function SectionUnbuiltStrip() {
  // Compact, in-section repeat of the top banner. Lives at the top of every
  // ATO/auth/failure-mode card-grid so a screenshot of a single section is
  // never load-bearing on its own.
  return (
    <div
      className="mb-3 flex items-center justify-between gap-3 rounded-sm px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-widest"
      style={{ background: UNBUILT_BG, color: "#FFFFFF" }}
    >
      <span>Unbuilt · Pre-coordination pending with PM GCSS-MC and the IL-5 enclave AO</span>
      <span
        className="hidden shrink-0 rounded-sm border px-2 py-[1px] text-[10px] tracking-wider sm:inline-flex"
        style={{ borderColor: "rgba(255,255,255,0.55)", background: "rgba(0,0,0,0.25)" }}
      >
        PRE-ATO · NOT ACCREDITED
      </span>
    </div>
  );
}

function PreAtoStamp() {
  // Per-card hard stamp. Sized to remain legible at projection scale (a
  // 10pt corner chip is invisible from row 8 of a CDAO conference room).
  return (
    <div
      className="mb-2 inline-flex items-center gap-2 rounded-sm border-2 px-2 py-[2px] font-mono text-[11px] font-bold uppercase tracking-widest"
      style={{
        borderColor: UNBUILT_BG,
        color: UNBUILT_BG,
        background: "color-mix(in oklab, " + UNBUILT_BG + " 8%, var(--color-surface))",
      }}
      title="This card describes a target / planned posture. SPIRE has no ATO and no live GCSS-MC link."
    >
      PRE-ATO · NOT ACCREDITED
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — REFERENCE IMPLEMENTATION badge + plain-language summary
// ---------------------------------------------------------------------------

function ContractHeader() {
  return (
    <header className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-primary)]">
            Adapter Contract · System of Record
          </div>
          <div className="mt-1 font-mono text-2xl font-semibold tracking-wide text-[var(--color-text)]">
            GCSS-MC
          </div>
          <div className="mt-0.5 spire-body-muted">
            Global Combat Support System — Marine Corps. Logistics, supply,
            and maintenance system of record for the Operating Forces.
          </div>
        </div>
        <PreAtoStamp />
      </div>
      <p className="mt-4 spire-body">
        <span className="font-semibold text-[var(--color-text)]">
          What is built today:
        </span>{" "}
        the field mapping, the polling-cadence design, and the sample
        endpoint that emits GCSS-MC-shaped rows out of the canonical SPIRE
        synthetic dataset. SPIRE never writes upstream and there is no
        live GCSS-MC link.
      </p>
      <p className="mt-3 spire-body">
        <span className="font-semibold text-[var(--color-text)]">
          What is planned, not built:
        </span>{" "}
        the IL-5 enclave deployment, the service-account batch path, the
        circuit-breaker / reconciliation behavior, and every ATO claim on
        this page. Pre-coordination with PM GCSS-MC and the IL-5 enclave
        AO is pending. Sections that describe planned posture are stamped
        <span className="ml-1 font-semibold" style={{ color: UNBUILT_BG }}>
          PRE-ATO · NOT ACCREDITED
        </span>{" "}
        so a single screenshot can never read as "shipped".
      </p>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Field Mapping
// ---------------------------------------------------------------------------

interface MappingRow {
  spireEntity: string;
  spireField: string;
  gcssTable: string;
  gcssField: string;
  example: string;
  notes?: string;
}

const MAPPING_ROWS: MappingRow[] = [
  // EQUIPMENT_MASTER ----------------------------------------------------
  {
    spireEntity: "Asset",
    spireField: "unit_uic",
    gcssTable: "EQUIPMENT_MASTER",
    gcssField: "UIC",
    example: "M67891",
    notes: "USMC Unit Identification Code (5–6 char). Authoritative on GCSS-MC.",
  },
  {
    spireEntity: "Asset",
    spireField: "tamcn",
    gcssTable: "EQUIPMENT_MASTER",
    gcssField: "TAMCN",
    example: "B0987",
    notes: "Table of Authorized Materiel Control Number — primary item key.",
  },
  {
    spireEntity: "Asset",
    spireField: "nsn",
    gcssTable: "EQUIPMENT_MASTER",
    gcssField: "NSN",
    example: "2320-01-413-2202",
    notes: "13-char NSN. FSC + NIIN.",
  },
  {
    spireEntity: "Asset",
    spireField: "serial_number",
    gcssTable: "EQUIPMENT_MASTER",
    gcssField: "SERIAL_NO",
    example: "M07-44219",
    notes: "Per-asset identity. Joined to readiness via SERIAL_NO.",
  },
  {
    spireEntity: "Asset",
    spireField: "current_deployment_status",
    gcssTable: "EQUIPMENT_MASTER",
    gcssField: "DEPLOY_STATUS",
    example: "GARRISON",
    notes: "GARRISON / FIELD / DEPLOYED / DEPOT.",
  },
  // MIMMS_DAILY_READINESS ----------------------------------------------
  {
    spireEntity: "DailySnapshot",
    spireField: "readiness_code",
    gcssTable: "MIMMS_DAILY_READINESS",
    gcssField: "EOH_STAT",
    example: "MC",
    notes: "MC / PMC / NMCM / NMCS — same code set as MCO P4790.2.",
  },
  {
    spireEntity: "DailySnapshot",
    spireField: "current_hours",
    gcssTable: "MIMMS_DAILY_READINESS",
    gcssField: "EOH_HOURS",
    example: "4127.5",
    notes: "Engine/operating hours, decimal.",
  },
  {
    spireEntity: "DailySnapshot",
    spireField: "current_miles",
    gcssTable: "MIMMS_DAILY_READINESS",
    gcssField: "EOH_MILES",
    example: "31204",
    notes: "Wheeled/vehicle odometer.",
  },
  {
    spireEntity: "DailySnapshot",
    spireField: "days_deadlined",
    gcssTable: "MIMMS_DAILY_READINESS",
    gcssField: "DEADLINE_DAYS",
    example: "12",
    notes: "Consecutive deadline days; drives MC% rollup.",
  },
  // EQUIPMENT_REPAIR_ORDER ----------------------------------------------
  {
    spireEntity: "ServiceRequest",
    spireField: "sr_number",
    gcssTable: "EQUIPMENT_REPAIR_ORDER",
    gcssField: "ERO_NO",
    example: "M67891-2026-08431",
    notes: "Equipment Repair Order number. Joins requisitions back to maintenance jobs.",
  },
  {
    spireEntity: "ServiceRequest",
    spireField: "priority",
    gcssTable: "EQUIPMENT_REPAIR_ORDER",
    gcssField: "PD",
    example: "02",
    notes: "Priority Designator (FAD-derived). 01–05 by Force Activity Designator.",
  },
  {
    spireEntity: "ServiceRequest",
    spireField: "defect_code_primary",
    gcssTable: "EQUIPMENT_REPAIR_ORDER",
    gcssField: "DEFECT_CODE",
    example: "ENG-COOL-001",
    notes: "USMC defect-code lookup; tied to TM reference.",
  },
  {
    spireEntity: "ServiceRequest",
    spireField: "tm_reference",
    gcssTable: "EQUIPMENT_REPAIR_ORDER",
    gcssField: "TM_REF",
    example: "TM 09244A-12/1",
    notes: "Technical Manual reference for the corrective procedure.",
  },
  {
    spireEntity: "ServiceRequest",
    spireField: "maintenance_level",
    gcssTable: "EQUIPMENT_REPAIR_ORDER",
    gcssField: "MAINT_LEVEL",
    example: "Organizational",
    notes: "Org / Intermediate / Depot. Drives whether the job ships.",
  },
  // SUPPLY_DOC -----------------------------------------------------------
  {
    spireEntity: "PartRequisition",
    spireField: "document_number",
    gcssTable: "SUPPLY_DOC",
    gcssField: "DOC_NO",
    example: "M67891-26108-0042",
    notes: "MILSTRIP document number. Globally unique across DLA.",
  },
  {
    spireEntity: "PartRequisition",
    spireField: "current_status",
    gcssTable: "SUPPLY_DOC",
    gcssField: "STATUS_CODE",
    example: "BD",
    notes: "DLA milestone status code (BA/BB/BD/BF/AS1/D6/...). Pass-through.",
  },
  {
    spireEntity: "PartRequisition",
    spireField: "received_date",
    gcssTable: "SUPPLY_DOC",
    gcssField: "RDD",
    example: "2026-04-21",
    notes: "Required Delivery Date (or actual receipt when status = D6).",
  },
];

function FieldMappingSection({ sample }: { sample: SamplePayload | null }) {
  return (
    <Section
      title="Field mapping"
      subtitle="SPIRE entities ↔ GCSS-MC tables. Defensible against an actual logistics SME — every field is sourced from public USMC documentation. The mapping itself is documentation, not a deployed link."
    >
      <SectionUnbuiltStrip />
      <div className="overflow-x-auto rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)]">
        <table className="w-full min-w-[720px] font-mono text-xs">
          <thead className="bg-[color-mix(in_oklab,var(--color-primary)_8%,var(--color-surface))] text-left uppercase tracking-widest text-[var(--color-text-muted)]">
            <tr>
              <th className="px-3 py-2 font-semibold">SPIRE entity · field</th>
              <th className="px-3 py-2 font-semibold">→ GCSS-MC table · column</th>
              <th className="px-3 py-2 font-semibold">Example</th>
              <th className="px-3 py-2 font-semibold">Notes</th>
            </tr>
          </thead>
          <tbody>
            {MAPPING_ROWS.map((r, i) => (
              <tr
                key={`${r.spireEntity}.${r.spireField}.${i}`}
                className="border-t border-[var(--color-border)] align-top"
              >
                <td className="px-3 py-2 text-[var(--color-text)]">
                  <div className="text-[var(--color-text)]">{r.spireEntity}</div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">.{r.spireField}</div>
                </td>
                <td className="px-3 py-2 text-[var(--color-primary)]">
                  <div>{r.gcssTable}</div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">.{r.gcssField}</div>
                </td>
                <td className="px-3 py-2 text-[var(--color-text-secondary)] tabular-nums">
                  {r.example}
                </td>
                <td className="px-3 py-2 text-[10px] text-[var(--color-text-muted)] leading-relaxed">
                  {r.notes}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sample && (
        <p className="mt-3 spire-body-muted text-xs">
          Live mapping reference (server-derived) is also embedded in every
          response under <code className="font-mono text-[var(--color-primary)]">field_mapping_reference</code>.
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Polling cadence
// ---------------------------------------------------------------------------

interface CadenceRow {
  entity: string;
  cadence: string;
  rationale: string;
}

const CADENCE_ROWS: CadenceRow[] = [
  {
    entity: "EQUIPMENT_MASTER",
    cadence: "Target: daily full pull · delta poll every 6h",
    rationale:
      "Asset roster changes slowly (re-fielding, transfers, decommissioning). A daily full pull catches reorganizations; a 6h delta covers in-day changes. Exact wall-clock window (e.g. 0400Z) is to be negotiated with PM GCSS-MC against the read-replica's existing batch schedule — not yet set.",
  },
  {
    entity: "MIMMS_DAILY_READINESS",
    cadence: "Target: ~30s in the operations window · ~5 min off-hours",
    rationale:
      "Drives the 15-second readiness picture. 30s is the design floor we believe GCSS-MC's read replica can sustain without us throttling the wider system; the actual sustainable rate is pending a load-test under PM GCSS-MC oversight.",
  },
  {
    entity: "EQUIPMENT_REPAIR_ORDER",
    cadence: "Target: ~60s · planned event-trigger on ERO open/close",
    rationale:
      "ERO state changes are bursty (mechanic shift change). 60s baseline keeps SR cards live; the event-trigger on ERO_OPEN / ERO_CLOSE that would accelerate SLA-critical transitions is planned, not built — depends on a webhook surface PM GCSS-MC has not yet committed to.",
  },
  {
    entity: "SUPPLY_DOC",
    cadence: "Target: ~5 min · planned event-trigger on D6 receipt",
    rationale:
      "Milestone codes flip on a DLA tempo; 5 min is more than enough resolution for a parts-on-order display. The D6 (received) trigger that would accelerate the NMCS-to-MC flip is planned, not built — same webhook dependency as ERO.",
  },
];

function PollingCadenceSection() {
  return (
    <Section
      title="Polling cadence"
      subtitle="Target pull rates per entity, with rationale. SPIRE would be read-only against GCSS-MC and every cadence is sized to the upstream's read-replica budget, not the source-of-truth shard. None of these cadences run against a live GCSS-MC today."
    >
      <SectionUnbuiltStrip />
      <div className="overflow-x-auto rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)]">
        <table className="w-full min-w-[640px] font-mono text-xs">
          <thead className="bg-[color-mix(in_oklab,var(--color-primary)_8%,var(--color-surface))] text-left uppercase tracking-widest text-[var(--color-text-muted)]">
            <tr>
              <th className="px-3 py-2 font-semibold">Entity</th>
              <th className="px-3 py-2 font-semibold">Cadence</th>
              <th className="px-3 py-2 font-semibold">Rationale</th>
            </tr>
          </thead>
          <tbody>
            {CADENCE_ROWS.map((r) => (
              <tr key={r.entity} className="border-t border-[var(--color-border)] align-top">
                <td className="px-3 py-2 font-semibold text-[var(--color-primary)]">
                  {r.entity}
                </td>
                <td className="px-3 py-2 text-[var(--color-text)]">{r.cadence}</td>
                <td className="px-3 py-2 text-[10px] text-[var(--color-text-muted)] leading-relaxed">
                  {r.rationale}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

function AuthSection() {
  return (
    <Section
      title="Authentication"
      subtitle="What the SPIRE session model actually is today, and what would have to change to push identity all the way to a GCSS-MC API call."
    >
      <SectionUnbuiltStrip />
      <div className="grid gap-3 md:grid-cols-2">
        <SubCard
          label="Built today · SPIRE session"
          stamp
          body={
            <>
              <span className="font-semibold text-[var(--color-text)]">
                Built:
              </span>{" "}
              the operator picks a "smartcard" on the cert-selection
              screen and confirms a 6-digit PIN. SPIRE writes a server-
              issued, HMAC-SHA256-signed cookie (<code className="font-mono text-[var(--color-primary)]">spire_session</code>),
              <code className="ml-1 font-mono text-[var(--color-primary)]">HttpOnly</code>,
              <code className="ml-1 font-mono text-[var(--color-primary)]">SameSite=Lax</code>,
              with a fixed 12-hour TTL sized to a Marine's shift. This is
              not a JWT, there is no client-side token, and the cookie
              does not refresh on activity.
              <span className="mt-2 block text-[10px] text-[var(--color-text-muted)] tracking-wider">
                Source of record: <code className="font-mono">backend/auth.py</code>
                (<code className="font-mono">SESSION_TTL_SECONDS</code>,
                <code className="ml-1 font-mono">sign_session</code>).
                There is no real PKI, OCSP, or CAC reader in the loop —
                see Authentication on the sign-in screen.
              </span>
            </>
          }
        />
        <SubCard
          label="Target · CAC/PIV pass-through to GCSS-MC"
          stamp
          body={
            <>
              <span className="font-semibold text-[var(--color-text)]">
                Target:
              </span>{" "}
              with a real CAC reader and DoD PKI in front of SPIRE, the
              adapter would re-use the operator's authenticated DODID and
              clearance to scope every outbound GCSS-MC call — read
              access enforced upstream, never trusted from SPIRE alone.
              For the unattended batch path, the adapter would use a
              dedicated service account scoped to read-only on the four
              documented tables, with secrets in the enclave's secret
              manager and rotation/audit policy set by PM GCSS-MC.
              <span className="mt-2 block text-[10px] text-[var(--color-text-muted)] tracking-wider">
                Pre-coordination pending with PM GCSS-MC and the IL-5
                enclave AO. Rotation cadence, secret-manager choice, and
                whether session re-mint on CAC re-tap is supported are
                all open items, not shipped behavior.
              </span>
            </>
          }
        />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// ATO posture
// ---------------------------------------------------------------------------

function AtoSection() {
  return (
    <Section
      title="ATO posture"
      subtitle="Pre-ATO. The cards below describe the target accreditation package SPIRE intends to pre-coordinate with PM GCSS-MC and the IL-5 enclave AO — none of it is approved or in place today."
    >
      <SectionUnbuiltStrip />
      <div className="grid gap-3 md:grid-cols-2">
        <SubCard
          label="Hosting · target"
          stamp
          body={
            <>
              <span className="font-semibold text-[var(--color-text)]">
                Target:
              </span>{" "}
              IL-5 enclave (DoD SRG IL-5, controlled unclassified +
              mission-critical), co-resident with GCSS-MC's read replica
              so the adapter call would not traverse the broader DODIN.
              Air-gapped MEU/MAGTF deployment is intended to run the same
              image with the comms-state primitive engaged — see SPIRE's
              local-first posture in BASTION's StatusFooter.
              <span className="mt-2 block text-[10px] text-[var(--color-text-muted)] tracking-wider">
                Built today: SPIRE runs in this Replit workspace against
                the synthetic dataset. No IL-5 enclave footprint exists.
                Pre-coordination pending with PM GCSS-MC and the IL-5
                enclave AO.
              </span>
            </>
          }
        />
        <SubCard
          label="Accreditation pathway · planned"
          stamp
          body={
            <>
              <span className="font-semibold text-[var(--color-text)]">
                Planned:
              </span>{" "}
              inherit the GCSS-MC enclave's IL-5 boundary and submit a
              tailored package for SPIRE's read-only adapter logic. The
              path SPIRE intends to ask for is ATO-with-conditions (ATC)
              for an SBIR pilot, full ATO at the MTA-RP transition.
              <span className="mt-2 block text-[10px] text-[var(--color-text-muted)] tracking-wider">
                No package has been submitted, no AO has reviewed SPIRE,
                and no ATC / ATO exists. The ATC-then-ATO sequence is
                what a typical RMF pathway would look like at this scope
                — not a commitment from any AO.
              </span>
            </>
          }
        />
        <SubCard
          label="NIST 800-53 control families · target scope"
          stamp
          body={
            <>
              <span className="font-semibold text-[var(--color-text)]">
                Target:
              </span>{" "}
              SPIRE's adapter package would address the families below.
              These are scoping intent, not assessor-validated controls —
              no SCA has tested SPIRE.
              <ul className="mt-1 list-inside list-disc font-mono text-xs leading-relaxed text-[var(--color-text-secondary)]">
                <li>AC — Access Control (CAC pass-through, role-scoped reads)</li>
                <li>AU — Audit & Accountability (hash-chained audit log; see Admin/SOC view)</li>
                <li>IA — Identification & Authentication (CAC/PIV, mTLS)</li>
                <li>SC — System & Communications Protection (TLS 1.3, FIPS-validated cryptography)</li>
                <li>SI — System & Information Integrity (input validation on every adapter row)</li>
              </ul>
            </>
          }
        />
        <SubCard
          label="Boundary diagram · planned"
          stamp
          body={
            <>
              <span className="font-semibold text-[var(--color-text)]">
                Planned:
              </span>{" "}
              SPIRE adapter ↔ GCSS-MC read replica as a single point-to-
              point mTLS pipe inside the IL-5 enclave, with no SPIRE
              component egressing the enclave. A network egress monitor
              (<code className="font-mono text-[var(--color-primary)]">/api/system/status</code>)
              would flag any unapproved outbound attempt.
              <span className="mt-2 block text-[10px] text-[var(--color-text-muted)] tracking-wider">
                Today the egress monitor endpoint reflects this
                workspace, not an enclave boundary. Pre-coordination
                pending with the IL-5 enclave AO.
              </span>
            </>
          }
        />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

function FailureModesSection() {
  return (
    <Section
      title="Failure modes"
      subtitle="How the adapter is designed to behave when GCSS-MC goes dark. Logistics systems do go dark — but none of the behaviors below are wired up against a real upstream yet, because there is no real upstream wired up."
    >
      <SectionUnbuiltStrip />
      <div className="grid gap-3 md:grid-cols-3">
        <SubCard
          label="GCSS-MC unreachable · planned"
          stamp
          body={
            <>
              <span className="font-semibold text-[var(--color-text)]">
                Planned:
              </span>{" "}
              SPIRE would render the last-known cache and stamp affected
              screens with a "GCSS-MC stale · last sync N min ago"
              indicator, and PULSE risk scores would carry a "stale
              upstream — uncertainty inflated" caveat rather than show a
              confident wrong number.
              <span className="mt-2 block text-[10px] text-[var(--color-text-muted)] tracking-wider">
                Built today: SPIRE has a comms-state primitive that
                marks the whole session DDIL — see the StatusFooter.
                The per-entity stale/uncertainty tag described above is
                not yet implemented in PULSE.
              </span>
            </>
          }
        />
        <SubCard
          label="Adapter degraded · planned"
          stamp
          body={
            <>
              <span className="font-semibold text-[var(--color-text)]">
                Planned:
              </span>{" "}
              if MIMMS_DAILY_READINESS lands but SUPPLY_DOC times out,
              SPIRE would serve readiness with a partial-cover indicator
              on parts-on-order columns and a circuit-breaker would back
              the cadence off automatically (illustrative target:
              30s → 2 min → 10 min) until the window recovers.
              <span className="mt-2 block text-[10px] text-[var(--color-text-muted)] tracking-wider">
                Built today: nothing. There is no circuit-breaker, no
                partial-cover indicator, and no per-table cadence
                governor in code. The 30s/2m/10m back-off is a design
                target, not measured behavior.
              </span>
            </>
          }
        />
        <SubCard
          label="Reconciliation on recovery · planned"
          stamp
          body={
            <>
              <span className="font-semibold text-[var(--color-text)]">
                Planned:
              </span>{" "}
              the first clean poll after an outage would trigger a delta
              reconciliation — SPIRE would compare its cache to the
              recovered GCSS-MC state, replay deltas (status flips, new
              EROs) into the audit chain so the operator can scrub the
              gap window, and surface conflicts in a sync-conflict
              viewer.
              <span className="mt-2 block text-[10px] text-[var(--color-text-muted)] tracking-wider">
                Built today: nothing. The sync-conflict viewer does not
                exist as a screen, and SPIRE has no recovery-replay path
                because there is no live upstream to reconcile against.
                Pre-coordination pending with PM GCSS-MC.
              </span>
            </>
          }
        />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Sample endpoint
// ---------------------------------------------------------------------------

function SampleEndpointSection({
  sample,
  error,
}: {
  sample: SamplePayload | null;
  error: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const curl =
    `curl -sS -b "$SPIRE_COOKIE_JAR" \\\n` +
    `     "$SPIRE_BASE_URL/api/integrations/gcss-mc/sample?limit=3" \\\n` +
    `  | jq '.EQUIPMENT_MASTER, .MIMMS_DAILY_READINESS'`;

  const tableNames: (keyof Pick<
    SamplePayload,
    "EQUIPMENT_MASTER" | "MIMMS_DAILY_READINESS" | "EQUIPMENT_REPAIR_ORDER" | "SUPPLY_DOC"
  >)[] = [
    "EQUIPMENT_MASTER",
    "MIMMS_DAILY_READINESS",
    "EQUIPMENT_REPAIR_ORDER",
    "SUPPLY_DOC",
  ];

  return (
    <Section
      title="Sample endpoint"
      subtitle="Contract-shape roundtrip. Hits the canonical SPIRE synthetic dataset and emits GCSS-MC-shaped rows. Used by the topbar last-sync indicator and any judge who wants to curl it directly. The endpoint reads SPIRE's own dataset — it is not querying GCSS-MC."
    >
      <SectionUnbuiltStrip />
      <div className="rounded-sm border border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-primary)_4%,var(--color-bg))] p-3 font-mono text-xs">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="uppercase tracking-widest text-[var(--color-text-muted)]">
            GET /api/integrations/gcss-mc/sample
          </span>
          <Pressable
            block={false}
            onClick={() => {
              navigator.clipboard.writeText(curl).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                },
                () => {
                  /* clipboard denied — silent */
                },
              );
            }}
            className="!min-h-0 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] px-2.5 py-1 text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-text)]"
          >
            {copied ? "Copied" : "Copy curl"}
          </Pressable>
        </div>
        <pre className="overflow-x-auto whitespace-pre text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
{curl}
        </pre>
      </div>

      {error && !sample && (
        <div className="mt-3">
          <ErrorState
            title="Sample endpoint unreachable"
            description="The reference adapter could not be queried. The backend may be cycling or the dataset is still loading."
            detail={error}
          />
        </div>
      )}
      {!error && !sample && (
        <div className="mt-3">
          <LoadingState size="inline" label="Pulling GCSS-MC reference slice…" />
        </div>
      )}

      {sample && (
        <div className="mt-3 grid gap-3">
          <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-[var(--color-text-muted)] uppercase tracking-wider">
            <span>
              shape <span className="text-[var(--color-primary)]">{sample._mock.shape_version}</span>
            </span>
            {sample._mock.as_of_dataset_day && (
              <span>
                as-of dataset day <span className="text-[var(--color-text)]">{sample._mock.as_of_dataset_day}</span>
              </span>
            )}
            <span>
              total rows in canonical set ·{" "}
              {Object.entries(sample.totals_in_canonical_dataset)
                .map(([k, v]) => `${k}=${v.toLocaleString()}`)
                .join(", ")}
            </span>
          </div>
          {tableNames.map((t) => (
            <SampleTable key={t} title={t} rows={sample[t]} />
          ))}
        </div>
      )}
    </Section>
  );
}

function SampleTable({
  title,
  rows,
}: {
  title: string;
  rows: Record<string, unknown>[];
}) {
  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-xs text-[var(--color-text-muted)]">
        <span className="font-semibold text-[var(--color-primary)]">{title}</span>
        <span className="ml-2">no rows in current slice</span>
      </div>
    );
  }
  const cols = Object.keys(rows[0]);
  return (
    <div className="overflow-x-auto rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="border-b border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-primary)_8%,var(--color-surface))] px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-primary)]">
        {title}
      </div>
      <table className="w-full min-w-[720px] font-mono text-xs">
        <thead className="text-left uppercase tracking-widest text-[var(--color-text-muted)]">
          <tr>
            {cols.map((c) => (
              <th key={c} className="px-3 py-2 font-semibold">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-[var(--color-border)]">
              {cols.map((c) => (
                <td key={c} className="px-3 py-2 text-[var(--color-text-secondary)] tabular-nums">
                  {fmt(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return v.toLocaleString();
  return String(v);
}

// ---------------------------------------------------------------------------
// Footer / citations
// ---------------------------------------------------------------------------

function FooterCitations() {
  return (
    <footer className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-xs font-mono leading-relaxed text-[var(--color-text-muted)]">
      <div className="mb-1 uppercase tracking-widest text-[var(--color-text-secondary)]">
        Spec sources · public USMC / DoD documentation
      </div>
      <ul className="list-inside list-disc">
        <li>MCO 4400.150 — Consumer-level Supply Policy (TAMCN / NSN / UIC nomenclature).</li>
        <li>MCO P4790.2 — MIMMS readiness reporting (EOH_STAT codes, deadline counting).</li>
        <li>GCSS-MC functional description, USMC publicly-released training materials.</li>
        <li>DLA Milestone Status Codes — DLAM 4140.2 / MILSTRIP standard.</li>
        <li>NIST SP 800-53 Rev 5 control families (AC / AU / IA / SC / SI).</li>
      </ul>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Local helpers — Section + SubCard
// ---------------------------------------------------------------------------

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-3">
        <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-primary)]">
          {title}
        </div>
        {subtitle && <p className="mt-1 spire-body-muted">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function SubCard({
  label,
  body,
  stamp = false,
}: {
  label: string;
  body: React.ReactNode;
  // When `stamp` is true, the card prints the projection-scale
  // PRE-ATO · NOT ACCREDITED stamp above its label. Use on every card
  // that describes auth, ATO, or failure-mode behavior so a screenshot
  // of one card is never load-bearing on its own.
  stamp?: boolean;
}) {
  return (
    <div
      className="rounded-sm border bg-[var(--color-bg)] p-3"
      style={{
        borderColor: stamp
          ? "color-mix(in oklab, " + UNBUILT_BG + " 35%, var(--color-border))"
          : "var(--color-border)",
      }}
    >
      {stamp && <PreAtoStamp />}
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className="spire-body">{body}</div>
    </div>
  );
}
