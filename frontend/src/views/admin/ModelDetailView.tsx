/**
 * W1 #30 — Per-model card detail view.
 *
 * Reached from /admin/models or via cross-link from in-app surfaces
 * (PULSE Risk Board, SENTRY Review Queue). The active implementation
 * gets the full card; alternate implementations render compact below.
 *
 * Restricted to security_manager. Inline guard mirrors the backend
 * MODEL_REGISTRY_ROLES gate.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  api,
  type ModelImplementation,
  type ModelRegistryDetailResponse,
} from "../../api";
import { withRetry, formatApiError } from "../../api-retry";
import { useSpireStore } from "../../state/store";
import { InsufficientPrivilege } from "../../components/InsufficientPrivilege";
import { Button, ErrorState, LoadingState } from "../../components/ui";
import { ClassificationBadge } from "../../components/classification";

export function ModelDetailView() {
  const role = useSpireStore((s) => s.role);
  const { modelId = "" } = useParams<{ modelId: string }>();

  if (role !== "security_manager") {
    return (
      <InsufficientPrivilege
        feature="Admin · Model Detail"
        requiredRoles={["security_manager"]}
        description="Per-model provenance, vendor jurisdiction, and validation history are gated to Security Manager."
      />
    );
  }

  const [data, setData] = useState<ModelRegistryDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    (async () => {
      try {
        const resp = await withRetry(() => api.system.adminModelDetail(modelId), {
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
  }, [modelId]);

  if (error && !data) {
    return (
      <ErrorState
        title="Model Card Unavailable"
        description={`Could not load model card for ${modelId}.`}
        detail={error}
        onRetry={() => window.location.reload()}
      />
    );
  }
  if (!data) {
    return <LoadingState size="page" label={`Loading model card · ${modelId} …`} waking={waking} />;
  }

  const m = data.model;
  const active = data.active_implementation_block;
  const alternates = Object.entries(m.implementations).filter(
    ([key]) => key !== m.active_implementation,
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-3">
        <Link
          to="/admin/models"
          className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest hover:text-[var(--color-primary)]"
        >
          ← Model supply chain
        </Link>
      </div>
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="font-mono text-base font-semibold uppercase text-[var(--color-text)] tracking-widest">
            {m.name}
          </h1>
          <div className="mt-1 spire-body-muted">{m.purpose}</div>
          <div className="mt-1 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            Active implementation: {m.active_implementation} · {active?.kind ?? "unknown"} ·
            registry version {data.registry_version ?? "unknown"}
          </div>
        </div>
        <div className="shrink-0">
          <ClassificationBadge level="UNCLASSIFIED" />
        </div>
      </div>

      {m.in_app_surfaces && m.in_app_surfaces.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <span className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
            Surfaces in app:
          </span>
          {m.in_app_surfaces.map((s) => (
            <Link
              key={s.route}
              to={s.route}
              className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide hover:text-[var(--color-primary)]"
            >
              {s.label} →
            </Link>
          ))}
        </div>
      )}

      {active && <ImplementationCard impl={active} headline="Active" />}

      {alternates.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
            Alternate implementations ({alternates.length})
          </div>
          <div className="flex flex-col gap-3">
            {alternates.map(([key, impl]) => (
              <ImplementationCard key={key} impl={impl} headline={`Inactive · ${key}`} />
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 flex justify-end">
        <Link to="/admin/models">
          <Button variant="secondary" size="sm">
            ← Back to supply chain
          </Button>
        </Link>
      </div>
    </div>
  );
}

function ImplementationCard({ impl, headline }: { impl: ModelImplementation; headline: string }) {
  const v = impl.validation;
  const ic = impl.inference_cost;
  const vendor = impl.vendor;
  const acc = v.holdout_accuracy;
  const accLabel =
    acc != null ? `${(acc * 100).toFixed(1)}%${v.holdout_n ? ` · n=${v.holdout_n}` : ""}` : "TBD — placeholder";
  const accTone: "ok" | "warn" | "neutral" =
    acc != null && acc >= 0.85 ? "ok" : acc != null && acc >= 0.75 ? "warn" : "neutral";
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
          {headline} · {impl.kind}
        </div>
        {impl.cross_link && (
          <Link
            to={`/admin/models/${encodeURIComponent(impl.cross_link)}`}
            className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest hover:underline"
          >
            cross-link → {impl.cross_link}
          </Link>
        )}
      </div>
      <div className="font-mono text-sm text-[var(--color-text)] tracking-wide">{impl.summary}</div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Section title="Provenance">
          <Row label="Publisher" value={impl.provenance.publisher} />
          <Row
            label="Repo / source"
            value={impl.provenance.repo_url ?? "—"}
            href={impl.provenance.repo_url?.startsWith("http") ? impl.provenance.repo_url : undefined}
          />
          <Row label="Commit / version" value={impl.provenance.commit_or_version ?? "—"} />
          <Row label="License" value={impl.provenance.license ?? "—"} />
          <Row label="Training data lineage" value={impl.provenance.training_data_lineage ?? "—"} />
        </Section>
        <Section title="Hosting target">
          <Row label="Target IL" value={impl.hosting.target} />
          <Row label="Actual deployment" value={impl.hosting.actual} />
          <Row
            label="Gap"
            value={impl.hosting.gap ?? "—"}
            tone={
              impl.hosting.gap && !impl.hosting.gap.toLowerCase().includes("none")
                ? "warn"
                : "ok"
            }
          />
        </Section>

        <Section title="FedRAMP status">
          <Row
            label="Status"
            value={impl.fedramp_status}
            tone={
              impl.fedramp_status === "moderate" || impl.fedramp_status === "high"
                ? "ok"
                : impl.fedramp_status === "not_applicable"
                  ? "neutral"
                  : "warn"
            }
          />
          {impl.fedramp_note && <Row label="Rationale" value={impl.fedramp_note} />}
        </Section>
        <Section title="Vendor risk">
          <Row label="Vendor" value={vendor.name} />
          <Row
            label="Jurisdiction"
            value={vendor.jurisdiction}
            tone={isUS(vendor.jurisdiction) ? "ok" : "warn"}
          />
          <Row label="Ownership" value={vendor.ownership ?? "—"} />
          <Row
            label="Foreign-pivot risk"
            value={vendor.foreign_pivot_risk ?? "—"}
            tone={
              vendor.foreign_pivot_risk === "low"
                ? "ok"
                : vendor.foreign_pivot_risk === "medium"
                  ? "warn"
                  : vendor.foreign_pivot_risk === "high"
                    ? "danger"
                    : "neutral"
            }
          />
          <Row
            label="Known acquisitions"
            value={
              vendor.known_acquisitions && vendor.known_acquisitions.length > 0
                ? vendor.known_acquisitions.join(", ")
                : "None on record"
            }
          />
          <Row label="Contingency" value={vendor.contingency ?? "—"} />
        </Section>

        <Section title="Validation history">
          <Row label="Last validated" value={v.last_validated_at} />
          <Row label="Holdout accuracy" value={accLabel} tone={accTone} />
          <Row label="Drift since last retrain" value={v.drift_since_last_retrain ?? "—"} />
          <Row label="Method" value={v.method ?? "—"} />
        </Section>
        <Section title="Inference cost">
          <Row
            label="Typical $ / call"
            value={ic.typical_dollars_per_call != null ? formatDollars(ic.typical_dollars_per_call) : "TBD — placeholder"}
          />
          <Row
            label="Throughput"
            value={ic.throughput_per_second != null ? `${ic.throughput_per_second}/sec` : "TBD — placeholder"}
          />
          <Row
            label="Fallback $ / call"
            value={ic.fallback_dollars_per_call != null ? formatDollars(ic.fallback_dollars_per_call) : "—"}
          />
          {ic.notes && <Row label="Notes" value={ic.notes} />}
        </Section>

        <Section title="Update policy" wide>
          <Row label="Cadence" value={impl.update_policy.cadence} />
          <Row label="Approver" value={impl.update_policy.approver} />
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className={`rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3 ${wide ? "col-span-2" : ""}`}
    >
      <div className="mb-2 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
        {title}
      </div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "danger" | "neutral";
  href?: string;
}) {
  const color =
    tone === "ok"
      ? "var(--color-success)"
      : tone === "warn"
        ? "var(--color-warning)"
        : tone === "danger"
          ? "var(--color-danger)"
          : "var(--color-text)";
  const placeholder = typeof value === "string" && value.toLowerCase().includes("tbd") && value.toLowerCase().includes("placeholder");
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2">
      <div className="font-mono text-[11px] uppercase text-[var(--color-text-muted)] tracking-widest">
        {label}
      </div>
      <div className="font-mono text-xs leading-snug tracking-wide" style={{ color: placeholder ? "var(--color-text-muted)" : color }}>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="underline hover:text-[var(--color-primary)]">
            {value}
          </a>
        ) : (
          value
        )}
        {placeholder && (
          <span className="ml-2 rounded-sm border border-[var(--color-border)] px-1 text-[10px] uppercase tracking-widest text-[var(--color-warning)]">
            placeholder
          </span>
        )}
      </div>
    </div>
  );
}

function isUS(j?: string | null): boolean {
  if (!j) return false;
  const v = j.trim().toLowerCase();
  return v === "united states" || v === "us" || v === "u.s." || v === "usa";
}

function formatDollars(v: number): string {
  if (v === 0) return "$0.00";
  if (v < 0.01) return `$${v.toFixed(5)}`;
  return `$${v.toFixed(4)}`;
}
