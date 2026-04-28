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
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ModelRegistryListResponse, type ModelRegistrySummary, type SupplyChainAtAGlance } from "../../api";
import { withRetry, formatApiError } from "../../api-retry";
import { useSpireStore } from "../../state/store";
import { InsufficientPrivilege } from "../../components/InsufficientPrivilege";
import { ErrorState, LoadingState } from "../../components/ui";
import { ClassificationBadge } from "../../components/classification";

export function ModelRegistryView() {
  const role = useSpireStore((s) => s.role);
  if (role !== "security_manager") {
    return (
      <InsufficientPrivilege
        feature="Admin · Model Supply Chain"
        requiredRoles={["security_manager"]}
        description="The per-model card surface (provenance, hosting target, FedRAMP status, vendor jurisdiction) is gated to Security Manager because the aggregate exposes the SPIRE supply chain in one place."
      />
    );
  }

  const [data, setData] = useState<ModelRegistryListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await withRetry(() => api.system.adminModels(), {
          onAttempt: (attempt) => {
            if (!cancelled) setWaking(attempt > 1);
          },
        });
        if (cancelled) return;
        setData(resp);
        setWaking(false);
      } catch (e) {
        if (cancelled) return;
        setError(formatApiError(e));
        setWaking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error && !data) {
    return (
      <ErrorState
        title="Model Registry Offline"
        description="Could not load the model supply-chain registry. The backend may be cycling."
        detail={error}
        onRetry={() => window.location.reload()}
      />
    );
  }
  if (!data) {
    return <LoadingState size="page" label="Loading model registry …" waking={waking} />;
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <div>
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
        <div className="shrink-0">
          <ClassificationBadge classification="UNCLASSIFIED" />
        </div>
      </div>

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

      <div className="mt-6 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
        Honesty over hand-waving — placeholder fields are labelled "TBD — placeholder" rather than fabricated.
        D1 (PULSE model card with baselines) owns the in-PULSE summary; this lane owns the canonical detail.
      </div>
    </div>
  );
}

function SupplyChainHeader({ g }: { g: SupplyChainAtAGlance }) {
  const at_risk = g.at_risk_jurisdictions_count;
  const fedrampUncovered = g.models_without_fedramp_coverage;
  const hostingGap = g.models_with_hosting_gap;
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
        Supply chain at a glance
      </div>
      <div className="grid grid-cols-5 gap-3">
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
          label="Without FedRAMP M/H"
          value={fedrampUncovered.toString()}
          tone={fedrampUncovered === 0 ? "ok" : "warn"}
          subtitle="Includes 'not_applicable' (auditor sees the count)"
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
      <div className="mt-3 font-mono text-[11px] text-[var(--color-text-muted)] tracking-wide">
        FedRAMP coverage definition · {g.fedramp_coverage_definition}
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
          tone={isUS(model.vendor_jurisdiction) ? "ok" : "warn"}
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
  return v === "united states" || v === "us" || v === "u.s." || v === "usa";
}
