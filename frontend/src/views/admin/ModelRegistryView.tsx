/**
 * W1 #30 — Model registry / supply-chain index.
 *
 * Lists every model SPIRE uses with the provenance / hosting / vendor
 * jurisdiction / FedRAMP / validation summary fields. Header card
 * aggregates "supply chain at a glance" — # models, # at-risk vendor
 * jurisdictions, # without FedRAMP coverage, # with hosting gap, #
 * documented as TBD-placeholder.
 *
 * Restricted to security_manager. The backend route enforces the same
 * gate; the inline guard here keeps the rejection clean for lower
 * roles that hit the route via deep link.
 *
 * Each row → /admin/models/:id detail view. The PULSE Risk Board and
 * SENTRY Review Queue cross-link into the relevant model detail page
 * (D1 owns the in-PULSE summary, this lane owns the canonical detail).
 */
import { Link } from "react-router-dom";
import { api, type ModelRegistrySummary, type SupplyChainAtAGlance } from "../../api";
import { useSpireStore } from "../../state/store";
import { InsufficientPrivilege } from "../../components/InsufficientPrivilege";
import { ErrorState, LoadingState } from "../../components/ui";
import { ClassificationBadge } from "../../components/classification";
import { useRegistryFetch } from "./useRegistryFetch";
import { DdilFreshnessBanner, FreshnessHeader, RegistryLoadErrorTile } from "./RegistryFreshness";

export function ModelRegistryView() {
  const role = useSpireStore((s) => s.role);
  if (role !== "security_manager" && role !== "mef_commander") {
    return (
      <InsufficientPrivilege
        feature="Admin · Model Supply Chain"
        requiredRoles={["security_manager", "mef_commander"]}
        description="The per-model card surface (provenance, hosting target, FedRAMP status, vendor jurisdiction) is gated to Security Manager and MEF Commander because the aggregate exposes the SPIRE supply chain in one place."
      />
    );
  }

  // W1 #83 — fetch lifecycle (loadedAt + manual refresh + auto-refresh on
  // DDIL reconnect) lives in the shared hook so the same affordances are
  // wired identically here and on the detail page.
  const { data, error, waking, loadedAt, refreshing, refresh } = useRegistryFetch(
    () => api.system.adminModels(),
    "registry-list",
  );

  if (error && !data) {
    return (
      <ErrorState
        title="Model Registry Offline"
        description="Could not load the model supply-chain registry. The backend may be cycling."
        detail={error}
        onRetry={refresh}
        retrying={refreshing}
      />
    );
  }
  if (!data) {
    return <LoadingState size="page" label="Loading model registry …" waking={waking} />;
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-mono text-base font-semibold uppercase text-[var(--color-text)] tracking-widest">
            Admin · Model Supply Chain
          </h1>
          <div className="mt-1 spire-body-muted">
            Every model SPIRE uses, with provenance, hosting target, vendor jurisdiction, and validation history.
            Answers J2's question: "What happens when the vendor pivots or gets acquired by a foreign adversary in 18 months?"
          </div>
          <div className="mt-1 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            Registry version {data.registry_version ?? "unknown"} · maintained by {data.owner ?? "SPIRE Engineering"}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <ClassificationBadge classification="UNCLASSIFIED" />
          <FreshnessHeader loadedAt={loadedAt} refreshing={refreshing} onRefresh={refresh} />
        </div>
      </div>

      <DdilFreshnessBanner loadedAt={loadedAt} />

      {/* W1 #83 — surface the backend's `load_error` field explicitly. A
       * malformed model_registry.json used to render as the empty-state
       * tile, indistinguishable from "no models registered". */}
      {data.load_error ? (
        <RegistryLoadErrorTile message={data.load_error} />
      ) : (
        <>
          <SupplyChainHeader g={data.supply_chain_at_a_glance} />

          <div className="mt-4 mb-2 font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
            Models registered ({data.models.length})
          </div>
          <div className="flex flex-col gap-2">
            {data.models.map((m) => (
              <ModelRow key={m.id} model={m} />
            ))}
            {data.models.length === 0 && (
              <div className="rounded-sm border border-dashed border-[var(--color-border)] p-8 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
                REGISTRY EMPTY — dataset/data/model_registry.json missing or unreadable
              </div>
            )}
          </div>
        </>
      )}

      <div className="mt-6 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
        Honesty over hand-waving — placeholder fields are labelled "TBD — placeholder" rather than fabricated.
        D1 (PULSE model card with baselines) owns the in-PULSE summary; this lane owns the canonical detail.
      </div>
    </div>
  );
}

function SupplyChainHeader({ g }: { g: SupplyChainAtAGlance }) {
  const at_risk = g.at_risk_jurisdictions_count;
  const hostingGap = g.models_with_hosting_gap;
  // Task #82 — split the FedRAMP cell into covered / N/A in-process /
  // pending so the projector eye doesn't lock onto a yellow "5". Color
  // is reserved for the pending bucket; the other two are neutral so a
  // legitimately-N/A model doesn't read as a finding.
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
        Supply chain at a glance
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Stat label="Models registered" value={g.total_models.toString()} />
        <Stat
          label="At-risk vendor jurisdictions"
          value={at_risk.toString()}
          tone={at_risk === 0 ? "ok" : at_risk <= 1 ? "warn" : "danger"}
          subtitle={
            at_risk === 0
              ? "All vendors US-jurisdictioned"
              : g.at_risk_jurisdictions.join(", ")
          }
        />
        <Stat
          label="Hosting gap present"
          value={hostingGap.toString()}
          tone={hostingGap === 0 ? "ok" : "warn"}
          subtitle="Active impl deployed at non-target IL"
        />
        <Stat
          label="TBD-placeholder fields"
          value={g.models_with_placeholder_provenance.toString()}
          tone={g.models_with_placeholder_provenance === 0 ? "ok" : "warn"}
          subtitle="Models with un-trained / un-attested lanes"
        />
      </div>
      <FedrampSplitStat g={g} />
      <div className="mt-3 font-mono text-[11px] text-[var(--color-text-muted)] tracking-wide">
        FedRAMP coverage definition · {g.fedramp_coverage_definition}
      </div>
    </div>
  );
}

/**
 * Task #82 — three-up FedRAMP cell. Renders the same data the back-compat
 * `models_without_fedramp_coverage` carries, but split so a Marine glancing
 * at the projector reads "1 pending, 4 in-process N/A" instead of "5
 * without FedRAMP". Color reserved for the pending bucket.
 */
function FedrampSplitStat({ g }: { g: SupplyChainAtAGlance }) {
  const pending = g.models_fedramp_pending;
  const covered = g.models_fedramp_covered;
  const naInProcess = g.models_fedramp_not_applicable;
  return (
    <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
          FedRAMP posture · active implementations
        </div>
        <div className="font-mono text-[11px] uppercase text-[var(--color-text-muted)] tracking-widest">
          {g.total_models} models
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {/*
         * Color is reserved for the Pending bucket only. Covered and
         * N/A render neutral so the operator's eye lands on the
         * actual finding (pending paperwork) instead of treating
         * "N/A — first-party code" as a green/red signal.
         */}
        <FedrampBucket
          label="Covered (M / H)"
          value={covered}
          subtitle="FedRAMP Moderate or High in force"
          tone="neutral"
        />
        <FedrampBucket
          label="N/A · in-process"
          value={naInProcess}
          subtitle="First-party code, no SaaS to assess"
          tone="neutral"
        />
        <FedrampBucket
          label="Pending"
          value={pending}
          subtitle="Authorization paperwork outstanding"
          tone={pending === 0 ? "neutral" : "warn"}
        />
      </div>
    </div>
  );
}

function FedrampBucket({
  label,
  value,
  subtitle,
  tone,
}: {
  label: string;
  value: number;
  subtitle: string;
  tone: "ok" | "warn" | "neutral";
}) {
  const color =
    tone === "warn"
      ? "var(--color-warning)"
      : tone === "ok"
        ? "var(--color-success)"
        : "var(--color-text)";
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
      <div className="font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest">
        {label}
      </div>
      <div
        className="mt-1 font-mono text-2xl font-semibold tabular-nums"
        style={{ color }}
      >
        {value}
      </div>
      <div className="mt-0.5 font-mono text-[10px] text-[var(--color-text-muted)] tracking-wide">
        {subtitle}
      </div>
    </div>
  );
}

function ModelRow({ model }: { model: ModelRegistrySummary }) {
  const acc = model.holdout_accuracy;
  return (
    <Link
      to={`/admin/models/${encodeURIComponent(model.id)}`}
      className="block rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-3 transition hover:border-[var(--color-primary)]"
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-mono text-base font-semibold text-[var(--color-text)] tracking-wide">
          {model.name}
        </div>
        <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
          {model.active_kind ?? "unknown"} · {model.active_implementation}
        </div>
      </div>
      <div className="mt-1 font-mono text-sm text-[var(--color-text-secondary)] tracking-wide">
        {model.purpose}
      </div>
      <div className="mt-2 grid grid-cols-4 gap-2 font-mono text-xs">
        <Field label="Hosting" value={`${model.hosting_target ?? "—"} → ${model.hosting_actual ?? "—"}`} tone={model.hosting_gap_present ? "warn" : "ok"} />
        <Field
          label="FedRAMP"
          value={(model.fedramp_status ?? "—").toString()}
          tone={
            (model.fedramp_status === "moderate" || model.fedramp_status === "high")
              ? "ok"
              : model.fedramp_status === "not_applicable"
                ? "neutral"
                : "warn"
          }
        />
        <Field
          label="Vendor"
          value={`${model.vendor_name ?? "—"} · ${model.vendor_jurisdiction ?? "—"}`}
          // Task #82 — when the canonical jurisdictions array is present
          // (e.g. Alphabet US + DeepMind UK) every entry must be US for
          // the row to read green. A single non-US partner downgrades to
          // warn so the page doesn't paint a foreign-co-publisher vendor
          // as US-only.
          tone={isAllUS(model.vendor_jurisdictions, model.vendor_jurisdiction) ? "ok" : "warn"}
        />
        <Field
          label="Last validated"
          value={
            acc != null
              ? `${model.last_validated_at ?? "—"} · ${(acc * 100).toFixed(1)}%`
              : (model.last_validated_at ?? "TBD — placeholder")
          }
          tone={acc != null && acc >= 0.85 ? "ok" : acc != null && acc >= 0.75 ? "warn" : "neutral"}
        />
      </div>
      {model.in_app_surfaces.length > 0 && (
        <div className="mt-2 font-mono text-[11px] text-[var(--color-text-muted)] tracking-wider">
          Surfaces in app: {model.in_app_surfaces.map((s) => s.label).join(" · ")}
        </div>
      )}
    </Link>
  );
}

function Stat({
  label,
  value,
  tone,
  subtitle,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "danger";
  subtitle?: string;
}) {
  const color =
    tone === "ok"
      ? "var(--color-success)"
      : tone === "warn"
        ? "var(--color-warning)"
        : tone === "danger"
          ? "var(--color-danger)"
          : "var(--color-text)";
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
        {label}
      </div>
      <div className="mt-1 font-mono text-xl font-semibold tabular-nums" style={{ color }}>
        {value}
      </div>
      {subtitle && (
        <div className="mt-1 font-mono text-[11px] text-[var(--color-text-muted)] tracking-wide">
          {subtitle}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn" | "danger" | "neutral";
}) {
  const color =
    tone === "ok"
      ? "var(--color-success)"
      : tone === "warn"
        ? "var(--color-warning)"
        : tone === "danger"
          ? "var(--color-danger)"
          : "var(--color-text-secondary)";
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
      <div className="font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-xs tracking-wide" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function isUS(j?: string | null): boolean {
  if (!j) return false;
  const v = j.trim().toLowerCase();
  return (
    v === "united states" ||
    v === "us" ||
    v === "u.s." ||
    v === "usa" ||
    v === "u.s.a." ||
    v === "united states of america"
  );
}

/**
 * Task #82 — green only if every canonical jurisdiction in the vendor's
 * list is US-aligned. Falls back to the single string when the canonical
 * list isn't published.
 */
function isAllUS(list?: string[] | null, fallback?: string | null): boolean {
  const candidates = list && list.length > 0 ? list : (fallback ? [fallback] : []);
  if (candidates.length === 0) return false;
  return candidates.every((j) => isUS(j));
}
