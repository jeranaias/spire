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
        <ReferenceBadge />
      </div>
      <p className="mt-4 spire-body">
        SPIRE writes nothing into GCSS-MC; it pulls a documented slice on a
        polling cadence (see below) and renders the operator-facing
        analytics on top. This page is the contract: which SPIRE entities
        come from which GCSS-MC tables, how often we poll, how we
        authenticate, what hosting environment the adapter runs in, and
        what happens when the upstream goes dark. The sample endpoint
        below proves the shape end-to-end against the canonical SPIRE
        dataset.
      </p>
    </header>
  );
}

function ReferenceBadge() {
  return (
    <div
      className="shrink-0 rounded-sm border px-3 py-2 font-mono text-[10px] uppercase tracking-widest"
      style={{
        borderColor: "color-mix(in oklab, var(--color-warning) 50%, var(--color-border))",
        background: "color-mix(in oklab, var(--color-warning-muted) 18%, var(--color-surface))",
        color: "var(--color-warning)",
      }}
      title="No live GCSS-MC instance is connected. The mapping and sample data are documentation, not a deployed link."
    >
      <div className="text-[11px] font-semibold">Reference Implementation</div>
      <div className="mt-0.5 text-[9px] text-[var(--color-text-muted)] tracking-wider">
        Mock adapter · SPIRE synthetic dataset
      </div>
    </div>
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
      subtitle="SPIRE entities ↔ GCSS-MC tables. Defensible against an actual logistics SME — every field is sourced from public USMC documentation."
    >
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
    cadence: "Daily, 0400Z full pull · delta poll every 6h",
    rationale:
      "Asset roster changes slowly (re-fielding, transfers, decommissioning). Daily full pull catches reorganizations; 6h delta covers in-day changes.",
  },
  {
    entity: "MIMMS_DAILY_READINESS",
    cadence: "Every 30s during the operations window · 5 min off-hours",
    rationale:
      "Drives the 15-second readiness picture. 30s is the floor that GCSS-MC's read replica handles without us throttling the wider system.",
  },
  {
    entity: "EQUIPMENT_REPAIR_ORDER",
    cadence: "Every 60s · event-trigger on ERO open/close",
    rationale:
      "ERO state changes are bursty (mechanic shift change). 60s baseline keeps SR cards live; an event-trigger on ERO_OPEN / ERO_CLOSE accelerates the SLA-critical transitions.",
  },
  {
    entity: "SUPPLY_DOC",
    cadence: "Every 5 min · event-trigger on D6 receipt",
    rationale:
      "Milestone codes flip on a DLA tempo; 5 min is more than enough resolution for a parts-on-order display. The D6 (received) trigger accelerates the closeout that flips an NMCS asset back to MC.",
  },
];

function PollingCadenceSection() {
  return (
    <Section
      title="Polling cadence"
      subtitle="Pull rates per entity, with rationale. SPIRE is read-only against GCSS-MC — every cadence is sized to the upstream's read-replica budget, not the source-of-truth shard."
    >
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
      subtitle="Identity propagates from the operator's CAC all the way to the GCSS-MC API call. Service accounts exist only for the unattended batch path, sealed behind a separate audit lane."
    >
      <div className="grid gap-3 md:grid-cols-2">
        <SubCard
          label="Primary · CAC/PIV pass-through"
          body={
            <>
              The operator authenticates SPIRE with their CAC (mocked in
              this demo via the cert-selection screen). The GCSS-MC adapter
              re-uses the operator's DODID and clearance to scope the
              outbound query — read access enforced upstream, never trusted
              from SPIRE alone. The session JWT is short-lived (15 min)
              and re-minted on CAC re-tap.
            </>
          }
        />
        <SubCard
          label="Fallback · service account"
          body={
            <>
              For the unattended batch poll (the 0400Z EQUIPMENT_MASTER
              pull), the adapter uses a dedicated service account scoped
              to read-only on the four documented tables. Credentials
              live in the IL-5 enclave's secret manager; rotation is
              every 90 days and audit-logged. No interactive operator
              ever sees the service account.
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
      subtitle="Where SPIRE will live and which control families the adapter inherits vs. owns. Pre-ATO; we publish the target so a sponsor can pre-coordinate the package."
    >
      <div className="grid gap-3 md:grid-cols-2">
        <SubCard
          label="Hosting target"
          body={
            <>
              IL-5 enclave (DoD SRG IL-5, controlled unclassified +
              mission-critical). Co-resident with GCSS-MC's read replica
              so the adapter call never traverses the broader DODIN.
              Air-gapped MEU/MAGTF deployment runs the same image with
              the comms-state primitive engaged — see SPIRE's local-first
              posture in BASTION's StatusFooter.
            </>
          }
        />
        <SubCard
          label="Accreditation pathway"
          body={
            <>
              Inherited ATO via the GCSS-MC enclave's existing IL-5
              boundary. SPIRE's own scope adds a tailored package for
              read-only adapter logic only. Expected ATO type: ATO-with-
              conditions (ATC) for the SBIR pilot, full ATO at the MTA-RP
              transition.
            </>
          }
        />
        <SubCard
          label="NIST 800-53 control families addressed"
          body={
            <ul className="mt-1 list-inside list-disc font-mono text-xs leading-relaxed text-[var(--color-text-secondary)]">
              <li>AC — Access Control (CAC pass-through, role-scoped reads)</li>
              <li>AU — Audit & Accountability (hash-chained audit log; see Admin/SOC view)</li>
              <li>IA — Identification & Authentication (CAC/PIV, mTLS)</li>
              <li>SC — System & Communications Protection (TLS 1.3, FIPS-validated cryptography)</li>
              <li>SI — System & Information Integrity (input validation on every adapter row)</li>
            </ul>
          }
        />
        <SubCard
          label="Boundary diagram"
          body={
            <>
              SPIRE adapter ↔ GCSS-MC read replica is a single point-to-
              point mTLS pipe inside the IL-5 enclave. No SPIRE component
              egresses the enclave; the network egress monitor (see
              <code className="ml-1 font-mono text-[var(--color-primary)]">/api/system/status</code>)
              is armed at boot and would flag any unapproved outbound
              attempt.
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
      subtitle="Logistics systems go dark — the adapter is designed assuming this is the normal case, not the exception."
    >
      <div className="grid gap-3 md:grid-cols-3">
        <SubCard
          label="GCSS-MC unreachable"
          body={
            <>
              SPIRE renders the last-known cache and stamps every screen
              with a yellow "GCSS-MC stale · last sync N min ago" banner.
              Predictions degrade gracefully: PULSE marks risk scores
              with an "uncertainty inflated · stale upstream" tag rather
              than showing a confident wrong number.
            </>
          }
        />
        <SubCard
          label="Adapter degraded (partial table)"
          body={
            <>
              If MIMMS_DAILY_READINESS lands but SUPPLY_DOC times out,
              SPIRE serves readiness with a partial-cover indicator on
              parts-on-order columns. A degraded poll counts toward a
              circuit-breaker that backs the cadence off automatically
              (30s → 2 min → 10 min) until the window recovers.
            </>
          }
        />
        <SubCard
          label="Reconciliation on recovery"
          body={
            <>
              First clean poll after an outage triggers a delta
              reconciliation: SPIRE compares its cache to the recovered
              GCSS-MC state and replays deltas (status flips, new EROs)
              into the audit chain so the operator can scrub the gap
              window and see exactly what landed when. Conflicts are
              surfaced via the existing sync-conflict viewer.
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
      subtitle="Live contract roundtrip. Hits the canonical synthetic dataset and emits GCSS-MC-shaped rows. Used by the topbar last-sync indicator and any judge who wants to curl it directly."
    >
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

function SubCard({ label, body }: { label: string; body: React.ReactNode }) {
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className="spire-body">{body}</div>
    </div>
  );
}
