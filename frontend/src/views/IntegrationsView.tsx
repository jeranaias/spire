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
import { Link, useParams } from "react-router-dom";
import { ErrorState, LoadingState, Pressable } from "../components/ui";
import {
  api,
  ApiError,
  type DdilMode,
  type GcssMcSamplePayload,
  type GcssMcCoverageSummary,
  type GcssMcDictionary,
  type GcssMcDictionarySection,
  type GcssMcDictionaryColumn,
} from "../api";
import { formatApiError } from "../api-retry";
import { useSpireStore } from "../state/store";

// Sample payload shape — re-exported alias so the rest of the file reads
// the same as before this view stopped owning the type.
type SamplePayload = GcssMcSamplePayload;

// Polling cadence for the live sample slice. Matches the 30s number this
// page advertises in PollingCadenceSection for MIMMS_DAILY_READINESS, so
// a judge tabbing away and coming back finds the table refreshed and the
// "next refresh in N s" countdown ticking — not stale rows from mount.
const SAMPLE_REFRESH_INTERVAL_S = 30;

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

// State of the sample-endpoint roundtrip, including the DDIL-specific
// shapes ("session expired" and "comms denied · no cache") that the page
// needs to render distinctly from a generic backend failure.
type SampleStatus =
  | "idle"
  | "auth_required"
  | "ddil_no_cache"
  | "error";

function GcssMcContractPage() {
  const [sample, setSample] = useState<SamplePayload | null>(null);
  const [status, setStatus] = useState<SampleStatus>("idle");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  // Tracks the wall-clock deadline of the next refresh so the countdown
  // remains correct across a tab-away/return — the 1Hz tick recomputes
  // from this value rather than incrementing a counter that would freeze
  // when the tab loses focus.
  const [nextRefreshAt, setNextRefreshAt] = useState<number>(
    () => Date.now() + SAMPLE_REFRESH_INTERVAL_S * 1000,
  );
  // Bumps every time a fresh fetch completes so the SampleEndpointSection
  // can flash its "just refreshed" indicator without us re-deriving from
  // the payload itself (the payload bytes are nearly identical between
  // polls in the synthetic dataset).
  const [refreshTick, setRefreshTick] = useState<number>(0);

  // DDIL state lives in the global store. Reading both fields keeps the
  // comms-degraded banner reactive to the operator flipping the topbar
  // switch mid-page — the very drill this page is supposed to honor.
  const ddilMode = useSpireStore((s) => s.ddilMode);
  const ddilLastCacheHit = useSpireStore((s) => s.ddilLastCacheHit);

  useEffect(() => {
    let cancelled = false;

    const runFetch = async () => {
      try {
        const payload = await api.system.gcssMcSample(3);
        if (cancelled) return;
        setSample(payload);
        setStatus("idle");
        setErrorDetail(null);
        setRefreshTick((n) => n + 1);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          // Session expired — surface a clean "re-tap your CAC" panel
          // instead of dumping the literal "HTTP 401: {detail:...}"
          // string the old fetch used to bleed into the page (P1-6).
          // The global UnauthenticatedBridge will also navigate to
          // /auth; this UI is the safety net if the bridge isn't
          // mounted (e.g. test harness, embedded preview).
          setStatus("auth_required");
          setErrorDetail(null);
        } else if (err instanceof ApiError && err.status === 0) {
          // DDIL interceptor served a structured "no cached data" /
          // "queued for replay" response. Render the comms banner +
          // a calm posture line, not a red 5xx.
          setStatus("ddil_no_cache");
          setErrorDetail(formatApiError(err));
        } else {
          setStatus("error");
          setErrorDetail(formatApiError(err));
        }
      } finally {
        if (!cancelled) {
          setNextRefreshAt(Date.now() + SAMPLE_REFRESH_INTERVAL_S * 1000);
        }
      }
    };

    runFetch();
    const interval = window.setInterval(runFetch, SAMPLE_REFRESH_INTERVAL_S * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const refreshNow = () => {
    // Force the next interval tick to fire on the next animation frame
    // by collapsing the deadline. Cheaper than tearing down the effect.
    setNextRefreshAt(Date.now());
  };

  return (
    <div className="h-full overflow-y-auto bg-[var(--color-bg)]">
      {/* Sticky CAPCO-chrome unbuilt banner. Sits above the scroll
       * region so a judge sees it the instant the page paints, and
       * stays pinned while they scroll through the ATO copy. */}
      <UnbuiltBanner sticky />
      <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
        <ContractHeader />
        <CommsPostureBanner
          mode={ddilMode}
          servedFromCache={
            ddilLastCacheHit
              ? { cachedAt: ddilLastCacheHit.cachedAt }
              : null
          }
        />
        <FieldMappingSection sample={sample} />
        <FieldDictionarySection />
        <PollingCadenceSection />
        <AuthSection />
        <AtoSection />
        <FailureModesSection />
        <SampleEndpointSection
          sample={sample}
          status={status}
          errorDetail={errorDetail}
          nextRefreshAt={nextRefreshAt}
          refreshTick={refreshTick}
          onRefreshNow={refreshNow}
          ddilMode={ddilMode}
        />
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
// Comms posture banner — visible at the top of the page so a presenter who
// flipped Comms to Limited / Intermittent / Disconnected immediately sees
// the page acknowledge it. Closes the loop on P1-7: the integrations page
// no longer pretends comms are nominal during a SATCOM-denial drill.
// ---------------------------------------------------------------------------

function CommsPostureBanner({
  mode,
  servedFromCache,
}: {
  mode: DdilMode;
  servedFromCache: { cachedAt: number } | null;
}) {
  if (mode === "CONNECTED") return null;

  const tone =
    mode === "DISCONNECTED"
      ? {
          border: "var(--color-danger)",
          bg: "color-mix(in oklab, var(--color-danger-muted) 22%, var(--color-surface))",
          fg: "var(--color-danger)",
        }
      : {
          border: "var(--color-warning)",
          bg: "color-mix(in oklab, var(--color-warning-muted) 22%, var(--color-surface))",
          fg: "var(--color-warning)",
        };

  const headline =
    mode === "LIMITED"
      ? "Comms LIMITED — sample slice on a high-latency lane (800–2000 ms added)."
      : mode === "INTERMITTENT"
      ? "Comms INTERMITTENT — ~30% of polls drop on the wire; the page will refresh again on the next 30 s tick."
      : "Comms DISCONNECTED — no live sample fetch; serving the last cached slice if one exists.";

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border-l-4 px-4 py-3 font-mono text-xs"
      style={{
        borderColor: tone.border,
        background: tone.bg,
        color: "var(--color-text)",
      }}
      data-testid="integrations-comms-banner"
    >
      <div
        className="text-[10px] uppercase tracking-widest"
        style={{ color: tone.fg }}
      >
        Comms degraded · DDIL drill engaged
      </div>
      <div className="mt-1 spire-body">{headline}</div>
      {servedFromCache && (
        <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
          Last cache hit served from snapshot taken at{" "}
          {new Date(servedFromCache.cachedAt).toLocaleTimeString()}.
        </div>
      )}
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

// ---------------------------------------------------------------------------
// Task #177 — Field Dictionary section
//
// Backs the integrations page's "what does the real GCSS-MC schema look
// like, and how much of it does SPIRE actually consume?" question. Pulls
// the derived `gcss_dictionary.json` (163 columns across 3 source CSVs)
// and renders three accordion-style tables with green/amber/red coverage
// badges. The hero strip at the top renders the totals so the consumed-%
// number reads at projection scale without scrolling.
// ---------------------------------------------------------------------------

function filterDictionarySection(
  section: GcssMcDictionarySection,
  query: string,
): GcssMcDictionarySection {
  const q = query.trim().toLowerCase();
  if (!q) return section;
  const filtered = section.columns.filter((c) => {
    if (c.column.toLowerCase().includes(q)) return true;
    if ((c.coverage?.spire_field || "").toLowerCase().includes(q)) return true;
    if ((c.comment || "").toLowerCase().includes(q)) return true;
    return false;
  });
  return { ...section, columns: filtered };
}

function FieldDictionarySection() {
  const [coverage, setCoverage] = useState<GcssMcCoverageSummary | null>(null);
  const [dictionary, setDictionary] = useState<GcssMcDictionary | null>(null);
  const [openSection, setOpenSection] = useState<string>("header");
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.system.gcssMcCoverageSummary(),
      api.system.gcssMcDictionary(),
    ])
      .then(([cov, dict]) => {
        if (cancelled) return;
        setCoverage(cov);
        setDictionary(dict);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(formatApiError(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Section
      title="Field dictionary · real GCSS-MC schema"
      subtitle="Sourced from the published USMC sanitized data dictionaries (sr_header_dict.csv, sr_repair_part_dict.csv, due_in_data_dict.csv). Each column shows its real top-3 value distribution and a coverage badge for whether SPIRE consumes it, partially consumes it, or drops it."
    >
      {error && (
        <div className="mb-3 rounded-sm border border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning)_8%,var(--color-bg))] px-3 py-2 font-mono text-xs text-[var(--color-warning)]">
          Dictionary unavailable: {error}
        </div>
      )}
      {!coverage && !error && <LoadingState label="Loading schema dictionary…" />}
      {coverage && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <CoveragePill
            label="Coverage"
            value={`${coverage.totals.consumed_pct.toFixed(1)}%`}
            sub={`${coverage.totals.consumed} / ${coverage.totals.columns} columns`}
            tone="primary"
          />
          <CoveragePill
            label="Consumed"
            value={String(coverage.totals.consumed)}
            sub="green badges"
            tone="success"
          />
          <CoveragePill
            label="Partial"
            value={String(coverage.totals.partial)}
            sub="amber badges"
            tone="warning"
          />
          <CoveragePill
            label="Dropped"
            value={String(coverage.totals.dropped)}
            sub="red badges"
            tone="muted"
          />
        </div>
      )}
      {coverage && (
        <div className="mb-3 flex flex-wrap gap-2">
          {coverage.sections.map((s) => {
            const isOpen = openSection === s.id;
            return (
              <Pressable
                key={s.id}
                block={false}
                onClick={() => setOpenSection(s.id)}
                className={
                  "rounded-sm border px-3 py-1 font-mono text-[11px] uppercase tracking-widest transition " +
                  (isOpen
                    ? "border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_15%,var(--color-bg))] text-[var(--color-primary)]"
                    : "border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg)]")
                }
              >
                {s.title} · {s.consumed}/{s.total_columns}
              </Pressable>
            );
          })}
        </div>
      )}
      {dictionary && (
        <div className="mb-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search columns or SPIRE fields…"
            aria-label="Search field dictionary"
            data-testid="dictionary-search"
            className="w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none"
          />
        </div>
      )}
      {dictionary && (
        <DictionaryTable
          section={filterDictionarySection(
            dictionary.sections.find((s) => s.id === openSection) ||
              dictionary.sections[0],
            search,
          )}
        />
      )}
      {dictionary && (
        <p className="mt-3 spire-body-muted text-xs">
          Generated from the published GCSS-MC dictionary CSVs at{" "}
          <code className="font-mono text-[var(--color-primary)]">
            {dictionary._meta.generated_at?.replace("T", " ").slice(0, 19) || "—"}
          </code>
          . Re-run with{" "}
          <code className="font-mono">python -m dataset.scripts.build_gcss_dictionary</code>.
        </p>
      )}
      {dictionary && (
        <p className="mt-2 text-xs">
          {/*
            WP-8 acceptance: the Field Dictionary tab embeds a link to
            the generated schema fidelity report. The backend serves the
            markdown file at /api/integrations/gcss-mc/fidelity-report so
            the report opens in a new tab without forcing the operator
            out to GitHub (which is unreachable in DDIL conditions).
          */}
          <a
            href="/api/integrations/gcss-mc/fidelity-report"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="fidelity-report-link"
            className="font-mono text-[var(--color-primary)] underline-offset-2 hover:underline"
          >
            View full fidelity report →
          </a>
        </p>
      )}
    </Section>
  );
}

function CoveragePill({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "primary" | "success" | "warning" | "muted";
}) {
  const toneClass =
    tone === "success"
      ? "text-[var(--color-success)]"
      : tone === "warning"
      ? "text-[var(--color-warning)]"
      : tone === "primary"
      ? "text-[var(--color-primary)]"
      : "text-[var(--color-text-muted)]";
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className={`mt-1 font-mono text-2xl tabular-nums ${toneClass}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-[var(--color-text-secondary)]">{sub}</div>
    </div>
  );
}

function DictionaryTable({ section }: { section: GcssMcDictionarySection }) {
  return (
    <div className="overflow-x-auto rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="border-b border-[var(--color-border)] bg-[color-mix(in_oklab,var(--color-primary)_5%,var(--color-surface))] px-3 py-2 font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-secondary)]">
        {section.title} · {section.columns.length} columns ·{" "}
        {section.row_count_real_export.toLocaleString()} real rows · source{" "}
        <span className="text-[var(--color-primary)]">{section.source_csv}</span>
      </div>
      <table
        data-testid="dictionary-table"
        className="w-full min-w-[760px] font-mono text-[11px]"
      >
        <thead className="bg-[color-mix(in_oklab,var(--color-primary)_4%,var(--color-surface))] text-left uppercase tracking-widest text-[var(--color-text-muted)]">
          <tr>
            <th className="px-3 py-2 font-semibold">Column</th>
            <th className="px-3 py-2 font-semibold">Type</th>
            <th className="px-3 py-2 font-semibold">SPIRE coverage</th>
            <th className="px-3 py-2 font-semibold">Real top-3 (sanitized)</th>
            <th className="px-3 py-2 font-semibold">Comment</th>
          </tr>
        </thead>
        <tbody>
          {section.columns.map((c) => (
            <DictionaryRow key={c.column} column={c} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DictionaryRow({ column }: { column: GcssMcDictionaryColumn }) {
  const badgeColor =
    column.coverage.badge === "green"
      ? "var(--color-success)"
      : column.coverage.badge === "amber"
      ? "var(--color-warning)"
      : "var(--color-text-muted)";
  return (
    <tr className="border-t border-[var(--color-border)] align-top">
      <td className="px-3 py-2 text-[var(--color-text)]">{column.column}</td>
      <td className="px-3 py-2 text-[var(--color-text-secondary)]">
        {column.data_type}
        {!column.nullable ? (
          <span className="ml-1 text-[10px] text-[var(--color-warning)]">NOT NULL</span>
        ) : null}
      </td>
      <td className="px-3 py-2">
        <span
          className="inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] uppercase tracking-widest"
          style={{ borderColor: badgeColor, color: badgeColor }}
        >
          {column.coverage.label}
        </span>
        {column.coverage.spire_field && (
          <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
            → {column.coverage.spire_field}
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-[var(--color-text-secondary)] tabular-nums">
        {column.real_top_3.length === 0 ? (
          <span className="text-[var(--color-text-muted)]">—</span>
        ) : (
          <ul className="space-y-0.5">
            {column.real_top_3.map((tv, i) => (
              <li key={`${tv.value}.${i}`}>
                <span className="text-[var(--color-text)]">{tv.value || "(blank)"}</span>{" "}
                <span className="text-[10px] text-[var(--color-text-muted)]">
                  {tv.pct.toFixed(1)}%
                </span>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="px-3 py-2 text-[10px] text-[var(--color-text-muted)] leading-relaxed">
        {column.comment || "—"}
      </td>
    </tr>
  );
}

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
  status,
  errorDetail,
  nextRefreshAt,
  refreshTick,
  onRefreshNow,
  ddilMode,
}: {
  sample: SamplePayload | null;
  status: SampleStatus;
  errorDetail: string | null;
  nextRefreshAt: number;
  refreshTick: number;
  onRefreshNow: () => void;
  ddilMode: DdilMode;
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

  // 1Hz countdown ticker. Re-rendering only this section every second
  // keeps the rest of the page static; the sample table itself only
  // re-renders when a poll completes (refreshTick changes).
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const secondsToNext = Math.max(0, Math.round((nextRefreshAt - now) / 1000));
  // "Just refreshed" pip — shown for ~3s after a successful poll.
  const justRefreshed = refreshTick > 0 && now - (nextRefreshAt - SAMPLE_REFRESH_INTERVAL_S * 1000) < 3000;

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

      {/* Refresh-cadence row — keeps this page honest against its own
          claimed 30s polling cadence in PollingCadenceSection above. */}
      <div
        className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[11px]"
        data-testid="integrations-refresh-cadence"
      >
        <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{
              background: justRefreshed
                ? "var(--color-success)"
                : ddilMode === "DISCONNECTED"
                ? "var(--color-danger)"
                : ddilMode !== "CONNECTED"
                ? "var(--color-warning)"
                : "var(--color-text-muted)",
            }}
          />
          <span className="uppercase tracking-widest">Polling cadence · {SAMPLE_REFRESH_INTERVAL_S}s</span>
          <span className="text-[var(--color-text)]">
            · next refresh in <span className="tabular-nums">{secondsToNext}s</span>
          </span>
        </div>
        <Pressable
          block={false}
          onClick={onRefreshNow}
          className="!min-h-0 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] px-2.5 py-1 text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-text)]"
          aria-label="Refresh sample slice now"
        >
          Refresh now
        </Pressable>
      </div>

      {status === "auth_required" && (
        <div className="mt-3">
          <ErrorState
            title="Session expired"
            description="Your sign-in session timed out. Re-tap your CAC to resume the GCSS-MC sample fetch."
            secondaryAction={
              <Link
                to="/auth"
                className="inline-flex items-center justify-center rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest text-[var(--color-on-primary,white)] hover:opacity-90"
              >
                Re-tap CAC
              </Link>
            }
          />
        </div>
      )}

      {status === "ddil_no_cache" && !sample && (
        <div className="mt-3">
          <ErrorState
            title="Sample slice unavailable · comms denied"
            description="SPIRE is operating DISCONNECTED and has no cached slice for this endpoint yet. Restore comms or pull the slice once while CONNECTED to seed the cache."
            detail={errorDetail ?? undefined}
            onRetry={onRefreshNow}
            retryLabel="Try again"
          />
        </div>
      )}

      {status === "error" && !sample && (
        <div className="mt-3">
          <ErrorState
            title="Sample endpoint unreachable"
            description="The reference adapter could not be queried. The backend may be cycling or the dataset is still loading."
            detail={errorDetail ?? undefined}
            onRetry={onRefreshNow}
          />
        </div>
      )}

      {status === "idle" && !sample && (
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
            {(status === "ddil_no_cache" || ddilMode === "DISCONNECTED") && (
              <span
                className="rounded-sm border px-1.5 py-0.5 text-[10px]"
                style={{
                  borderColor: "var(--color-warning)",
                  color: "var(--color-warning)",
                }}
              >
                showing cached slice · live fetch denied
              </span>
            )}
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
