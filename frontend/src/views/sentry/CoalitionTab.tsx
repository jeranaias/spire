/**
 * CoalitionTab — GC-5 Coalition Interoperability surface.
 *
 * "Show me what JSDF sees right now." Operator selects a partner profile
 * (FVEY_BASE, FVEY_LOG, JPN_COALITION, AUS_COALITION, PHL_COALITION) and
 * sees exactly what would ship across the wire on a release. Live-data
 * preview pulled from the same canonical dataset, scoped through the
 * coalition release engine in real time.
 *
 * Partner profile defines: authorized classifications, allowed unit
 * parents, release categories, field redactions (EDIPI, phone, serial
 * numbers, TM refs, etc.), caveats to apply, embargo days. The view
 * shows the operator (1) which units are in/out of scope, (2) sample
 * SR records redacted per the profile, (3) the partner units (e.g.
 * JGSDF 1st Logistics Brigade), (4) the distribution statement.
 *
 * Generate Release Package button writes a release event to the audit
 * chain so a security manager can later inspect every coalition share.
 */
import { useEffect, useMemo, useState } from "react";
import { api, type CoalitionProfileSummary, type CoalitionView } from "../../api";
import { useSpireStore } from "../../state/store";
import { SegmentedControl } from "../../components/SegmentedControl";
import { InsufficientPrivilege } from "../../components/InsufficientPrivilege";

export function CoalitionTab() {
  const role = useSpireStore((s) => s.role);
  const pushToast = useSpireStore((s) => s.pushToast);

  if (role !== "data_custodian" && role !== "security_manager") {
    return (
      <InsufficientPrivilege
        feature="Coalition Release Mode"
        requiredRoles={["data_custodian", "security_manager"]}
        description="Coalition release packaging touches partner-nation classification authority and is restricted to Data Custodian or Security Manager."
      />
    );
  }

  const [profiles, setProfiles] = useState<CoalitionProfileSummary[]>([]);
  const [selected, setSelected] = useState<string>("FVEY_BASE");
  const [view, setView] = useState<CoalitionView | null>(null);
  const [loading, setLoading] = useState(false);
  const [releasing, setReleasing] = useState(false);

  useEffect(() => {
    api.sentry.coalitionProfiles().then((r) => setProfiles(r.profiles)).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setView(null);
    api.sentry
      .coalitionView(selected)
      .then(setView)
      .catch((e) => pushToast({ tone: "error", text: `Coalition view failed: ${e}` }))
      .finally(() => setLoading(false));
  }, [selected, pushToast]);

  async function generateRelease() {
    if (!view) return;
    setReleasing(true);
    try {
      const r = await api.sentry.coalitionRelease(view.profile_key);
      pushToast({
        tone: "ok",
        text: `Release ${r.release_id} prepared for ${r.partners.join(", ")} · audit logged`,
        ttlMs: 5000,
      });
    } catch (e) {
      pushToast({ tone: "error", text: `Release failed: ${e}` });
    } finally {
      setReleasing(false);
    }
  }

  const profileOptions = useMemo(
    () =>
      profiles.map((p) => ({
        value: p.key,
        label: p.display_name.replace(/^Five Eyes/, "FVEY").replace(/Coalition/, "").trim(),
      })),
    [profiles],
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h2
            className="font-mono text-base font-semibold uppercase text-[var(--color-text)]"
            style={{ letterSpacing: "0.2em" }}
          >
            Coalition Interoperability · Live Partner View
          </h2>
          <div className="mt-1 spire-body-muted">
            "Show me what JSDF sees right now." Live-data preview scoped through the partner's release profile.
            Same canonical dataset; different release ceiling, different redactions, different caveats — all applied in real time.
          </div>
        </div>
        {profileOptions.length > 0 && (
          <SegmentedControl value={selected} options={profileOptions} onChange={setSelected} />
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-6 font-mono text-sm text-[var(--color-text-muted)]" style={{ letterSpacing: "0.1em" }}>
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
          Scoping dataset for {selected} …
        </div>
      )}

      {view && (
        <>
          {/* Header banner — distribution statement */}
          <div
            className="mb-4 rounded-md border-l-[6px] p-4"
            style={{
              borderLeftColor: "var(--color-primary)",
              background: "color-mix(in oklab, var(--color-primary) 8%, var(--color-surface))",
              borderTop: "1px solid var(--color-border)",
              borderRight: "1px solid var(--color-border)",
              borderBottom: "1px solid var(--color-border)",
            }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <div className="font-mono text-xs uppercase text-[var(--color-text-muted)]" style={{ letterSpacing: "0.22em" }}>
                  Active Coalition Profile
                </div>
                <div className="mt-1 font-mono text-xl font-semibold uppercase text-[var(--color-text)]" style={{ letterSpacing: "0.08em" }}>
                  {view.display_name}
                </div>
                <div className="mt-1 font-mono text-sm text-[var(--color-text-secondary)]" style={{ letterSpacing: "0.04em" }}>
                  Partners: {view.partners.join(" · ")}
                  {view.embargo_days_after_event > 0 && (
                    <span className="ml-3 text-[var(--color-warning)]">
                      Embargo: {view.embargo_days_after_event}d post-event
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={generateRelease}
                disabled={releasing}
                className="rounded-sm border border-[var(--color-success)] bg-[var(--color-success)] px-4 py-2 font-mono text-sm font-semibold uppercase text-white hover:brightness-110 disabled:opacity-50"
                style={{ letterSpacing: "0.18em" }}
              >
                {releasing ? "Preparing …" : "Generate Release Package"}
              </button>
            </div>
            <div className="mt-3 spire-body-muted text-base">
              {view.distribution_statement}
            </div>
            {view.caveats_applied.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {view.caveats_applied.map((c) => (
                  <span
                    key={c}
                    className="rounded-sm border border-[var(--color-primary)] px-2 py-[2px] font-mono text-xs uppercase text-[var(--color-primary)]"
                    style={{ letterSpacing: "0.16em" }}
                  >
                    {c}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Scope summary */}
          <div className="mb-4 grid grid-cols-3 gap-3">
            <ScopeStat
              label="Units in scope"
              allowed={view.scope.units_allowed}
              blocked={view.scope.units_blocked}
            />
            <ScopeStat
              label="Sample SRs releasable"
              allowed={view.scope.sample_srs_allowed}
              blocked={view.scope.sample_srs_blocked}
              sampleNote={`(${view.scope.sample_srs_total_inspected} inspected)`}
            />
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="font-mono text-xs uppercase text-[var(--color-text-muted)]" style={{ letterSpacing: "0.22em" }}>
                Field Redactions
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {view.field_redactions.map((f) => (
                  <span
                    key={f}
                    className="rounded-sm border border-[var(--color-warning-muted)] px-1.5 py-[1px] font-mono text-xs uppercase text-[var(--color-warning)]"
                    style={{ letterSpacing: "0.16em" }}
                  >
                    {f}
                  </span>
                ))}
                {view.field_redactions.length === 0 && (
                  <span className="font-mono text-xs text-[var(--color-text-muted)]" style={{ letterSpacing: "0.1em" }}>
                    none
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Two-column layout: allowed units + partner units left, sample records right */}
          <div className="mb-4 grid grid-cols-2 gap-4">
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="font-mono text-xs uppercase text-[var(--color-primary)]" style={{ letterSpacing: "0.22em" }}>
                Authorized Units ({view.allowed_units.length})
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1">
                {view.allowed_units.map((u) => (
                  <div
                    key={u.uic}
                    className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono"
                  >
                    <div className="text-sm font-semibold text-[var(--color-text)]">{u.unit}</div>
                    <div className="text-xs text-[var(--color-text-muted)]" style={{ letterSpacing: "0.08em" }}>
                      {u.parent} · {u.location}
                    </div>
                  </div>
                ))}
                {view.allowed_units.length === 0 && (
                  <div className="col-span-2 rounded-sm border border-dashed border-[var(--color-border)] p-4 text-center font-mono text-xs text-[var(--color-text-muted)]" style={{ letterSpacing: "0.1em" }}>
                    NO UNITS IN SCOPE FOR THIS PROFILE
                  </div>
                )}
              </div>

              {view.partner_units.length > 0 && (
                <>
                  <div className="mt-4 border-t border-[var(--color-border)] pt-3 font-mono text-xs uppercase text-[var(--color-info)]" style={{ letterSpacing: "0.22em" }}>
                    Partner Units · Coordination
                  </div>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {view.partner_units.map((p) => (
                      <div key={p.name} className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono">
                        <div className="text-sm font-semibold text-[var(--color-text)]">{p.name}</div>
                        <div className="text-xs text-[var(--color-text-muted)]" style={{ letterSpacing: "0.08em" }}>
                          {p.type} {p.point_of_contact && `· LO ${p.point_of_contact}`}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="font-mono text-xs uppercase text-[var(--color-primary)]" style={{ letterSpacing: "0.22em" }}>
                Sample Records · Live Redacted Preview
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {view.sample_records.map((s, i) => (
                  <div key={i} className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-semibold text-[var(--color-text)]">{s.sr_number}</span>
                      <span className="text-[var(--color-text-muted)]" style={{ letterSpacing: "0.04em" }}>
                        {s.equipment_type} · {s.unit_name}
                      </span>
                      {(s.redactions?.length ?? 0) > 0 && (
                        <span className="ml-auto font-mono text-xs text-[var(--color-warning)]" style={{ letterSpacing: "0.16em" }}>
                          {s.redactions!.length} REDACTED
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-[var(--color-text-secondary)]" style={{ letterSpacing: "0.04em" }}>
                      Fault: {s.fault_component}
                    </div>
                    <div className="mt-1 text-xs leading-relaxed text-[var(--color-text)]">
                      {s.remark_preview ? `"${s.remark_preview}…"` : <span className="text-[var(--color-text-muted)]">[no preview]</span>}
                    </div>
                  </div>
                ))}
                {view.sample_records.length === 0 && (
                  <div className="rounded-sm border border-dashed border-[var(--color-border)] p-4 text-center font-mono text-xs text-[var(--color-text-muted)]" style={{ letterSpacing: "0.1em" }}>
                    NO RELEASABLE RECORDS UNDER THIS PROFILE
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="font-mono text-xs text-[var(--color-text-muted)]" style={{ letterSpacing: "0.18em" }}>
            View as-of {view.as_of} · Profile loaded from data/coalition_profiles.json
          </div>
        </>
      )}
    </div>
  );
}

function ScopeStat({
  label,
  allowed,
  blocked,
  sampleNote,
}: {
  label: string;
  allowed: number;
  blocked: number;
  sampleNote?: string;
}) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="font-mono text-xs uppercase text-[var(--color-text-muted)]" style={{ letterSpacing: "0.22em" }}>
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-3 font-mono">
        <div>
          <span className="text-xl font-semibold tabular-nums text-[var(--color-success)]">
            {allowed}
          </span>
          <span className="ml-1 text-xs text-[var(--color-text-muted)]" style={{ letterSpacing: "0.14em" }}>
            ALLOWED
          </span>
        </div>
        <div className="text-[var(--color-border-active)]">/</div>
        <div>
          <span className="text-xl font-semibold tabular-nums text-[var(--color-danger)]">
            {blocked}
          </span>
          <span className="ml-1 text-xs text-[var(--color-text-muted)]" style={{ letterSpacing: "0.14em" }}>
            BLOCKED
          </span>
        </div>
      </div>
      {sampleNote && (
        <div className="mt-1 font-mono text-xs text-[var(--color-text-muted)]" style={{ letterSpacing: "0.1em" }}>
          {sampleNote}
        </div>
      )}
    </div>
  );
}
