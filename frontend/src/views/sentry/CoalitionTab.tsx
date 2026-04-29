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
import clsx from "clsx";
import { api, type CoalitionProfileSummary, type CoalitionView } from "../../api";
import { formatApiError } from "../../api-retry";
import { useSpireStore } from "../../state/store";
import { InsufficientPrivilege } from "../../components/InsufficientPrivilege";
import { Button, Pressable, ErrorState, LoadingState, fireIdempotent } from "../../components/ui";

export function CoalitionTab() {
  const role = useSpireStore((s) => s.role);
  const pushToast = useSpireStore((s) => s.pushToast);

  if (role !== "data_custodian" && role !== "security_manager" && role !== "mef_commander") {
    return (
      <InsufficientPrivilege
        feature="Coalition Release Mode"
        requiredRoles={["data_custodian", "security_manager", "mef_commander"]}
        description="Coalition release packaging touches partner-nation classification authority and is restricted to Data Custodian, Security Manager, or MEF Commander."
      />
    );
  }

  const [profiles, setProfiles] = useState<CoalitionProfileSummary[]>([]);
  const [selected, setSelected] = useState<string>("FVEY_BASE");
  const [view, setView] = useState<CoalitionView | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
  // Per-session list of releases prepared in this tab. Reviewer caught the
  // celebratory toast disappearing with no destination — so we surface a
  // "Recent Releases" panel below that operators can scroll back through,
  // with the release_id, partners, and a deep-link to the audit chain.
  const [recentReleases, setRecentReleases] = useState<{
    release_id: string;
    profile: string;
    partners: string[];
    created_at: string;
    /** F13 — manifest hash + record count surfaced so an investigator
     * can later prove what shipped, not just that something did. Older
     * cached entries (pre-F13) won't carry these; the panel renders
     * "—" so the operator can tell which rows pre-date the audit fix. */
    manifest_sha256?: string;
    record_count?: number;
  }[]>(() => {
    try {
      const raw = window.localStorage.getItem("spire.sentry.recent_releases");
      return raw ? (JSON.parse(raw) as any[]).slice(-10) : [];
    } catch {
      return [];
    }
  });
  // F2 — confirmation gate. Bright-green Generate Release used to fire on
  // a single click and immediately write to the audit chain. The
  // idempotency guard prevented double-tap but not first-tap-by-mistake.
  // Now: click opens this modal, operator types RELEASE, only then does
  // the audit event fire.
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    api.sentry.coalitionProfiles().then((r) => setProfiles(r.profiles)).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setView(null);
    setViewError(null);
    api.sentry
      .coalitionView(selected)
      .then(setView)
      .catch((e) => {
        // Walkthrough audit: prior code only surfaced the toast and left
        // the page rendering nothing below the chip row, which looked
        // exactly like 'no data for this profile' rather than 'fetch
        // failed during deploy churn'. Set viewError so the empty state
        // names the actual problem.
        setViewError(formatApiError(e));
        pushToast({ tone: "error", text: `Coalition view failed: ${formatApiError(e)}` });
      })
      .finally(() => setLoading(false));
  }, [selected, pushToast]);

  async function generateRelease() {
    if (!view) return;
    // Idempotency guard — coalition release writes to the audit chain.
    // Rapid double-tap on "Generate Release Package" must not register
    // two release events for the same profile.
    const profileKey = view.profile_key;
    await fireIdempotent(`sentry:coalition:release:${profileKey}`, async () => {
      setReleasing(true);
      try {
        const r = await api.sentry.coalitionRelease(profileKey);
        setRecentReleases((prev) => {
          const next = [
            ...prev,
            {
              release_id: r.release_id,
              profile: r.profile,
              partners: r.partners,
              created_at: r.created_at,
              manifest_sha256: r.manifest_sha256,
              record_count: r.record_count,
            },
          ].slice(-10);
          try {
            window.localStorage.setItem("spire.sentry.recent_releases", JSON.stringify(next));
          } catch {
            /* tolerant */
          }
          return next;
        });
        pushToast({
          tone: "ok",
          text: `✓ Release ${r.release_id} · ${r.record_count} records · manifest ${r.manifest_sha256.slice(0, 12)}… · audit logged`,
          ttlMs: 6000,
        });
      } catch (e) {
        pushToast({ tone: "error", text: `Release failed: ${formatApiError(e)}` });
      } finally {
        setReleasing(false);
      }
    }, 500);
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
            className="font-mono text-base font-semibold uppercase text-[var(--color-text)] tracking-widest"
          >
            Coalition Interoperability · Live Partner View
          </h2>
          <div className="mt-1 spire-body-muted">
            {(() => {
              // Template the partner name from the active profile so the
              // intro doesn't keep saying "what JSDF sees" while the operator
              // is on Philippines · AFP. Walkthrough audit: prior version
              // picked partners[0] which is USA on every FVEY profile —
              // 'Show me what USA sees' is meaningless to a US operator.
              // Pick the first non-USA partner instead so the prompt names
              // a foreign partner (the actual point of the view).
              const partners =
                view?.partners
                ?? profiles.find((p) => p.key === selected)?.partners
                ?? [];
              const foreign = partners.find((p) => p.toUpperCase() !== "USA");
              const partnerName = foreign
                ?? profiles.find((p) => p.key === selected)?.display_name
                ?? "this partner";
              return `"Show me what ${partnerName} sees right now."`;
            })()}{" "}
            Live-data preview scoped through the partner's release profile.
            Same canonical dataset; different release ceiling, different redactions, different caveats — all applied in real time.
          </div>
        </div>
        {/* Walkthrough #24 — partner tabs were colliding ("AUSTRALIA · ADF"
            overlapping "PHILIPPINES · AFP"). Use a flex-wrap row of
            buttons with explicit gap + whitespace-nowrap on each label so
            tabs that don't fit drop to a second row instead of overlapping. */}
        {profileOptions.length > 0 && (
          <div role="group" className="inline-flex flex-wrap items-center gap-1.5">
            {profileOptions.map((o) => {
              const active = o.value === selected;
              return (
                <Pressable
                  key={o.value}
                  aria-pressed={active}
                  onClick={() => setSelected(o.value)}
                  block={false}
                  className={clsx(
                    "inline-flex h-11 items-center whitespace-nowrap rounded-sm border px-3 font-mono text-sm font-semibold uppercase tracking-wider transition-colors",
                    active
                      ? "border-[var(--color-primary)] bg-[var(--color-primary)] text-white"
                      : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]",
                  )}
                >
                  {o.label}
                </Pressable>
              );
            })}
          </div>
        )}
      </div>

      {loading && (
        <LoadingState size="panel" label={`Scoping dataset for ${selected} …`} />
      )}
      {!loading && !view && viewError && (
        <ErrorState
          variant="panel"
          title="Coalition view unavailable"
          description={`Backend returned an error fetching ${selected}. The map and other views can still render — coalition redaction may be cycling during a deploy.`}
          detail={viewError}
          onRetry={() => {
            // Re-trigger the view fetch by toggling selected through itself.
            const cur = selected;
            setSelected("");
            setTimeout(() => setSelected(cur), 0);
          }}
          retryLabel="Retry profile fetch"
        />
      )}

      {view && (
        <>
          {/* Header banner — distribution statement + classification ceiling. */}
          {(() => {
            // F1 — pick the highest authorized classification as the
            // ceiling label, and decide whether the in-scope sample
            // contains records *above* that ceiling. When it does, the
            // Generate Release button tints red (instead of neutral)
            // so a Marine on JPN_COALITION (UNCLASSIFIED-only) sees a
            // red "this isn't safe yet" before clicking.
            const authCls = view.authorized_classifications ?? [];
            // Prefer the rank-derived ceiling field from the backend; fall
            // back to the last element of `authorized_classifications` only
            // for older view payloads without the explicit field.
            const ceiling =
              view.classification_ceiling ??
              (authCls.length === 0
                ? "UNCLASSIFIED"
                : (authCls[authCls.length - 1] ?? "UNCLASSIFIED"));
            const overCeiling = view.scope.sample_srs_over_ceiling ?? 0;
            const ceilingTone =
              ceiling === "UNCLASSIFIED" || ceiling === "UNCLASSIFIED//FOUO"
                ? "var(--color-success)"
                : ceiling.includes("TOP SECRET")
                  ? "var(--color-danger)"
                  : "var(--color-warning)";
            return (
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
                    <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
                      Active Coalition Profile
                    </div>
                    <div className="mt-1 font-mono text-xl font-semibold uppercase text-[var(--color-text)] tracking-wide">
                      {view.display_name}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-sm text-[var(--color-text-secondary)] tracking-wide">
                      <span>Partners: {view.partners.join(" · ")}</span>
                      {/* F1 — classification ceiling chip rendered at the
                          same eye level as the Release button. */}
                      <span
                        data-testid="coalition-ceiling-chip"
                        className="inline-flex items-center rounded-sm border px-2 py-[2px] font-mono text-xs font-semibold uppercase tracking-wider"
                        style={{
                          color: ceilingTone,
                          borderColor: ceilingTone,
                          background: `color-mix(in oklab, ${ceilingTone} 12%, transparent)`,
                        }}
                        title={`Partner is authorized up to ${ceiling}. Records above this ceiling are blocked from release.`}
                      >
                        Ceiling: {ceiling}
                      </span>
                      {view.embargo_days_after_event > 0 && (
                        <span className="text-[var(--color-warning)]">
                          Embargo: {view.embargo_days_after_event}d post-event
                        </span>
                      )}
                      {overCeiling > 0 && (
                        <span
                          className="rounded-sm border border-[var(--color-danger)] px-2 py-[2px] font-mono text-xs font-semibold uppercase text-[var(--color-danger)] tracking-wider"
                          style={{
                            background: "color-mix(in oklab, var(--color-danger) 14%, transparent)",
                          }}
                          title={`${overCeiling} record(s) in the inspected sample exceed the ${ceiling} ceiling and would be blocked.`}
                        >
                          {overCeiling} above ceiling
                        </span>
                      )}
                    </div>
                  </div>
                  {/* F2 — neutral button until the operator confirms.
                      Click opens the confirmation modal; the audit event
                      only fires after typed RELEASE inside the modal.
                      Tint red when the inspected sample contains records
                      above the ceiling — the operator should pause before
                      proceeding. */}
                  <Button
                    onClick={() => setConfirmOpen(true)}
                    disabled={releasing || confirmOpen}
                    pending={releasing}
                    variant="primary"
                    data-testid="coalition-release-button"
                    className={
                      overCeiling > 0
                        ? "border-[var(--color-danger)] bg-[var(--color-danger)] hover:brightness-110"
                        : undefined
                    }
                  >
                    {overCeiling > 0
                      ? "Generate Release Package · Review"
                      : "Generate Release Package…"}
                  </Button>
                </div>
                <div className="mt-3 spire-body-muted text-base">
                  {view.distribution_statement}
                </div>
                {view.caveats_applied.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {view.caveats_applied.map((c) => (
                      <span
                        key={c}
                        className="rounded-sm border border-[var(--color-primary)] px-2 py-[2px] font-mono text-xs uppercase text-[var(--color-primary)] tracking-wider"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Walkthrough #14 — hoist a compact Authorized Units strip
              directly under the header banner so the operator sees in-scope
              units on first paint, instead of the panel being mostly off-
              screen below the partner tabs. The full panel still renders
              below for detail. */}
          <div className="mb-4 rounded-md border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_8%,var(--color-surface))] p-3">
            <div className="mb-1 flex items-center justify-between font-mono text-xs uppercase tracking-widest">
              <span className="text-[var(--color-primary)]">
                Authorized Units · {view.allowed_units.length} in scope
              </span>
              <span className="text-[var(--color-text-muted)]">
                {view.scope.units_blocked} blocked
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 font-mono text-xs">
              {view.allowed_units.length === 0 ? (
                <span className="text-[var(--color-danger)]">
                  NO UNITS IN SCOPE FOR THIS PROFILE
                </span>
              ) : (
                view.allowed_units.map((u) => (
                  <span
                    key={u.uic}
                    className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5"
                    title={`${u.parent} · ${u.location}`}
                  >
                    {u.unit}
                  </span>
                ))
              )}
            </div>
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
              <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
                Field Redactions
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {view.field_redactions.map((f) => (
                  <span
                    key={f}
                    className="rounded-sm border border-[var(--color-warning-muted)] px-1.5 py-[1px] font-mono text-xs uppercase text-[var(--color-warning)] tracking-wider"
                  >
                    {f}
                  </span>
                ))}
                {view.field_redactions.length === 0 && (
                  <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
                    none
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Two-column layout: allowed units + partner units left, sample records right */}
          <div className="mb-4 grid grid-cols-2 gap-4">
            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
                Authorized Units ({view.allowed_units.length})
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1">
                {view.allowed_units.map((u) => (
                  <div
                    key={u.uic}
                    className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono"
                  >
                    <div className="text-sm font-semibold text-[var(--color-text)]">{u.unit}</div>
                    <div className="text-xs text-[var(--color-text-muted)] tracking-wide">
                      {u.parent} · {u.location}
                    </div>
                  </div>
                ))}
                {view.allowed_units.length === 0 && (
                  <div className="col-span-2 rounded-sm border border-dashed border-[var(--color-border)] p-4 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
                    NO UNITS IN SCOPE FOR THIS PROFILE
                  </div>
                )}
              </div>

              {view.partner_units.length > 0 && (
                <>
                  <div className="mt-4 border-t border-[var(--color-border)] pt-3 font-mono text-xs uppercase text-[var(--color-info)] tracking-widest">
                    Partner Units · Coordination
                  </div>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {view.partner_units.map((p) => (
                      <div key={p.name} className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono">
                        <div className="text-sm font-semibold text-[var(--color-text)]">{p.name}</div>
                        <div className="text-xs text-[var(--color-text-muted)] tracking-wide">
                          {p.type} {p.point_of_contact && `· LO ${p.point_of_contact}`}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <div className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
                Sample Records · Live Redacted Preview
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {view.sample_records.map((s, i) => (
                  <CoalitionSampleRecord key={i} record={s} />
                ))}
                {view.sample_records.length === 0 && (
                  <div className="rounded-sm border border-dashed border-[var(--color-border)] p-4 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
                    NO RELEASABLE RECORDS UNDER THIS PROFILE
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Walkthrough #13 — replace engineering metadata leak. Was:
              "Profile loaded from data/coalition_profiles.json".
              Walkthrough #12 — surface the inspected sample size + an
              affordance to inspect the 200-record sample. */}
          <div className="flex items-center justify-between font-mono text-xs text-[var(--color-text-muted)] tracking-widest">
            <span>
              {/* Walkthrough audit: prior format was raw ISO
                 ('2026-04-27T03:53:27Z') which read like a debug
                 timestamp. Format as 'DD MMM YYYY · HHMMz' so the
                 line reads as natural prose. */}
              Profile: {view.display_name} · loaded {(() => {
                try {
                  const d = new Date(view.as_of);
                  if (Number.isNaN(d.getTime())) return view.as_of;
                  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
                  const z = (n: number) => String(n).padStart(2, "0");
                  return `${z(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${z(d.getUTCHours())}${z(d.getUTCMinutes())}Z`;
                } catch { return view.as_of; }
              })()}
            </span>
            <span>
              Sample inspected: {view.scope.sample_srs_total_inspected} records ·{" "}
              {view.scope.sample_srs_allowed} allowed · {view.scope.sample_srs_blocked} blocked
            </span>
          </div>
        </>
      )}

      {recentReleases.length > 0 && (
        <div className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-mono text-xs uppercase text-[var(--color-success)] tracking-widest">
              Recent Releases · {recentReleases.length}
            </div>
            <Button
              onClick={() => {
                setRecentReleases([]);
                try { window.localStorage.removeItem("spire.sentry.recent_releases"); } catch { /* tolerant */ }
              }}
              variant="ghost"
              size="sm"
            >
              Clear ✕
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            {[...recentReleases].reverse().map((r) => (
              <div
                key={r.release_id}
                data-testid="coalition-recent-release"
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm"
              >
                <span className="font-semibold text-[var(--color-text)]">{r.release_id}</span>
                <span className="text-xs text-[var(--color-text-muted)] tracking-wide">
                  {r.profile} · {r.partners.join(" · ")}
                </span>
                {/* F13 — manifest hash + record count surfaced inline so an
                    investigator can later prove what shipped. The
                    truncated hash is the click-target; full hash on hover. */}
                {r.manifest_sha256 ? (
                  <span
                    data-testid="coalition-recent-manifest"
                    className="rounded-sm border border-[var(--color-border)] px-1.5 py-[1px] text-xs uppercase text-[var(--color-text-secondary)] tracking-wider"
                    title={`SHA-256 manifest: ${r.manifest_sha256}\nCovers ${r.record_count ?? "?"} in-scope SR records + redaction policy.`}
                  >
                    {r.record_count ?? "?"} recs · sha256 {r.manifest_sha256.slice(0, 12)}…
                  </span>
                ) : (
                  <span
                    className="rounded-sm border border-dashed border-[var(--color-border)] px-1.5 py-[1px] text-xs uppercase text-[var(--color-text-muted)] tracking-wider"
                    title="This release predates the manifest-hash audit fix (F13). Newer releases will record a SHA-256 over the in-scope SR set."
                  >
                    manifest —
                  </span>
                )}
                {/* Walkthrough #9 — render UTC timestamp consistently with
                    the release_id (which embeds UTC). Mixing local time +
                    UTC release_id produced two valid times for one event. */}
                <span
                  className="ml-auto text-xs text-[var(--color-text-muted)] tracking-wider"
                  title={`Local: ${new Date(r.created_at).toLocaleString("en-US")}`}
                >
                  {(() => {
                    // Walkthrough audit: prior format was 'MM/DD HH:MMZ' —
                    // no year. A coalition release log read 'in Aug or
                    // Sept some year'. Use 'DD MMM YYYY · HHMMz' to match
                    // the rest of the audit timestamps in this view.
                    const d = new Date(r.created_at);
                    if (Number.isNaN(d.getTime())) return r.created_at;
                    const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
                    const z = (n: number) => String(n).padStart(2, "0");
                    return `${z(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${z(d.getUTCHours())}${z(d.getUTCMinutes())}z`;
                  })()}
                </span>
                <span className="rounded-sm border border-[var(--color-success-muted)] px-1.5 py-[1px] text-xs uppercase text-[var(--color-success)] tracking-wider">
                  audit logged
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 font-mono text-xs italic text-[var(--color-text-muted)] tracking-wider">
            Each release_id is preserved in the SHA-256 chained audit log; downstream packagers consume the same ids.
          </div>
        </div>
      )}

      {confirmOpen && view && (
        <CoalitionReleaseConfirmModal
          view={view}
          releasing={releasing}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={async () => {
            setConfirmOpen(false);
            await generateRelease();
          }}
        />
      )}
    </div>
  );
}

// F2 — confirmation gate. The Generate Release click used to write to the
// audit chain on first tap; this modal puts a typed-RELEASE between the
// click and the audit event. It names the partner, ceiling, record count
// and caveats so the operator commits with intent (and a teammate
// looking over their shoulder can read the same summary out loud).
function CoalitionReleaseConfirmModal({
  view,
  releasing,
  onCancel,
  onConfirm,
}: {
  view: CoalitionView;
  releasing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const authCls = view.authorized_classifications ?? [];
  // Same rank-derived ceiling preference as the header banner — fall back
  // to last-element only for older view payloads.
  const ceiling =
    view.classification_ceiling ??
    (authCls.length === 0
      ? "UNCLASSIFIED"
      : (authCls[authCls.length - 1] ?? "UNCLASSIFIED"));
  const overCeiling = view.scope.sample_srs_over_ceiling ?? 0;
  // Estimate of what the audit row will record. Authoritative count comes
  // from the backend (it walks the full dataset, not the sample); this
  // gives the operator a representative figure so the confirm dialog
  // isn't blank where the count belongs.
  const inScopeSample = view.scope.sample_srs_allowed;
  const ready = typed.trim().toUpperCase() === "RELEASE" && !releasing;
  return (
    <div
      className="fixed inset-0 z-[8500] flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="coalition-release-confirm-title"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-xl"
      >
        <div
          id="coalition-release-confirm-title"
          className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--color-warning)]"
        >
          Confirm Coalition Release
        </div>
        <div className="mt-2 spire-body text-sm">
          You are about to release {view.display_name} data to{" "}
          <strong>{view.partners.join(", ")}</strong>.
        </div>

        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-xs">
          <dt className="text-[var(--color-text-muted)] tracking-wider uppercase">Partner</dt>
          <dd className="text-[var(--color-text)]">{view.partners.join(" · ")}</dd>
          <dt className="text-[var(--color-text-muted)] tracking-wider uppercase">Ceiling</dt>
          <dd
            className="font-semibold"
            style={{
              color:
                ceiling === "UNCLASSIFIED" || ceiling === "UNCLASSIFIED//FOUO"
                  ? "var(--color-success)"
                  : ceiling.includes("TOP SECRET")
                    ? "var(--color-danger)"
                    : "var(--color-warning)",
            }}
          >
            {ceiling}
          </dd>
          <dt className="text-[var(--color-text-muted)] tracking-wider uppercase">Records (est.)</dt>
          <dd className="text-[var(--color-text)]">
            ≈{inScopeSample.toLocaleString("en-US")} SR records (sampled from{" "}
            {view.scope.sample_srs_total_inspected} inspected) ·{" "}
            <span className="text-[var(--color-text-muted)]">
              backend hashes the full dataset; exact count appears in the
              audit row
            </span>
          </dd>
          {view.caveats_applied.length > 0 && (
            <>
              <dt className="text-[var(--color-text-muted)] tracking-wider uppercase">Caveats</dt>
              <dd className="text-[var(--color-text)]">
                {view.caveats_applied.join(" · ")}
              </dd>
            </>
          )}
          {view.embargo_days_after_event > 0 && (
            <>
              <dt className="text-[var(--color-text-muted)] tracking-wider uppercase">Embargo</dt>
              <dd className="text-[var(--color-warning)]">
                {view.embargo_days_after_event}d post-event
              </dd>
            </>
          )}
        </dl>

        {overCeiling > 0 && (
          <div
            className="mt-3 rounded-sm border border-[var(--color-danger)] px-3 py-2 font-mono text-xs text-[var(--color-danger)] tracking-wider"
            style={{
              background: "color-mix(in oklab, var(--color-danger) 12%, transparent)",
            }}
          >
            ⚠ {overCeiling} record(s) in the inspected sample exceed the {ceiling} ceiling.
            Those records will be blocked, but the release event itself will still fire.
          </div>
        )}

        <div className="mt-4">
          <label
            htmlFor="coalition-release-confirm-input"
            className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
          >
            Type <strong className="text-[var(--color-text)]">RELEASE</strong> to confirm
          </label>
          <input
            id="coalition-release-confirm-input"
            data-testid="coalition-release-confirm-input"
            autoFocus
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready) onConfirm();
              if (e.key === "Escape") onCancel();
            }}
            className="mt-1 w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm tracking-widest text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
            placeholder="RELEASE"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button onClick={onCancel} variant="secondary" size="sm">
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={!ready}
            pending={releasing}
            variant="primary"
            size="sm"
            data-testid="coalition-release-confirm-button"
            className={
              ready
                ? "border-[var(--color-success)] bg-[var(--color-success)] hover:brightness-110"
                : undefined
            }
          >
            Generate Release · audit log
          </Button>
        </div>
        <div className="mt-2 font-mono text-[10px] italic text-[var(--color-text-muted)] tracking-wider">
          A SHA-256 manifest of the in-scope SR set + redaction policy will be
          stamped into the audit row. The release event is irrevocable.
        </div>
      </div>
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
      <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-3 font-mono">
        <div>
          <span className="text-xl font-semibold tabular-nums text-[var(--color-success)]">
            {allowed}
          </span>
          <span className="ml-1 text-xs text-[var(--color-text-muted)] tracking-wider">
            ALLOWED
          </span>
        </div>
        <div className="text-[var(--color-border-active)]">/</div>
        <div>
          <span className="text-xl font-semibold tabular-nums text-[var(--color-danger)]">
            {blocked}
          </span>
          <span className="ml-1 text-xs text-[var(--color-text-muted)] tracking-wider">
            BLOCKED
          </span>
        </div>
      </div>
      {sampleNote && (
        <div className="mt-1 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
          {sampleNote}
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Per-record live-redacted preview with inline highlights. Mirrors the
// SENTRY ProcessingTab pattern: yellow span = generalised value, red span =
// stripped/replaced PII or controlled identifier. The original (pre-redaction)
// values are included in the preview-only payload so the operator can see the
// diff; nothing here ships in an actual release manifest.
// ---------------------------------------------------------------------------

const REDACTION_COLORS: Record<string, string> = {
  EDIPI: "var(--color-danger)",
  POC_PHONE: "var(--color-danger)",
  serial_number: "var(--color-danger)",
  tm_reference: "var(--color-warning)",
  fault_component: "var(--color-warning)",
  billet_nickname: "var(--color-warning)",
  supply_path: "var(--color-info)",
};

type SampleRecord = {
  sr_number?: string;
  unit_name?: string;
  equipment_type?: string;
  fault_component?: string;
  fault_component_original?: string;
  remark_preview?: string;
  remark_original?: string;
  redactions?: string[];
  redaction_spans?: { field: string; before: string; after: string; kind: string }[];
};

function CoalitionSampleRecord({ record }: { record: SampleRecord }) {
  const spans = record.redaction_spans ?? [];
  const remarkSpan = spans.find((s) => s.field === "remark");
  const remarkBefore = remarkSpan?.before ?? record.remark_original ?? record.remark_preview ?? "";
  const remarkAfter = remarkSpan?.after ?? record.remark_preview ?? "";
  const faultChanged =
    record.fault_component_original &&
    record.fault_component_original !== record.fault_component;

  const otherSpans = spans.filter(
    (s) => s.field !== "remark" && s.field !== "fault_component",
  );

  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-semibold text-[var(--color-text)]">{record.sr_number}</span>
        <span className="text-[var(--color-text-muted)] tracking-wide">
          {record.equipment_type?.replace(/_/g, " ")} · {record.unit_name}
        </span>
        {/* Walkthrough #15 — only render the REDACTED count when this record
            actually has at least one redaction span. Clean PMCS records with
            no redactable content used to show "REDACTED" badges spuriously. */}
        {Array.isArray(record.redaction_spans) && record.redaction_spans.length > 0 && (
          <span className="ml-auto font-mono text-xs text-[var(--color-warning)] tracking-wider">
            {record.redaction_spans.length} REDACTED
          </span>
        )}
      </div>

      {/* Walkthrough #16 — drop the Fault row entirely when there's nothing
          to render. Was: "Fault:" with empty content for most records. */}
      {(faultChanged || record.fault_component) && (
        <div className="mt-1 text-xs text-[var(--color-text-secondary)] tracking-wide">
          Fault:{" "}
          {faultChanged ? (
            <>
              <span
                className="rounded-sm px-0.5 line-through"
                style={{
                  background: "color-mix(in oklab, var(--color-danger) 15%, transparent)",
                  color: "var(--color-danger)",
                }}
                title="original value (preview only — never released)"
              >
                {record.fault_component_original}
              </span>
              <span className="mx-1 text-[var(--color-text-muted)]">→</span>
              <span
                className="rounded-sm px-0.5 font-semibold"
                style={{
                  background: "color-mix(in oklab, var(--color-warning) 25%, transparent)",
                  color: "var(--color-warning)",
                }}
                title="generalised value sent to partner"
              >
                {record.fault_component}
              </span>
            </>
          ) : (
            <span className="text-[var(--color-text)]">{record.fault_component}</span>
          )}
        </div>
      )}

      {/* Remark with inline highlights for any redacted substrings */}
      <div className="mt-1 text-xs leading-relaxed text-[var(--color-text)]">
        {remarkAfter ? (
          <RemarkDiff before={remarkBefore} after={remarkAfter} />
        ) : (
          <span className="text-[var(--color-text-muted)]">[no preview]</span>
        )}
      </div>

      {/* Per-field redaction chips for non-remark, non-fault redactions */}
      {otherSpans.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {otherSpans.map((s, i) => (
            <span
              key={i}
              className="rounded-sm border px-1.5 py-[1px] text-[10px] uppercase tracking-wider"
              style={{
                color: REDACTION_COLORS[s.kind] ?? "var(--color-warning)",
                borderColor: `color-mix(in oklab, ${REDACTION_COLORS[s.kind] ?? "var(--color-warning)"} 50%, transparent)`,
                background: `color-mix(in oklab, ${REDACTION_COLORS[s.kind] ?? "var(--color-warning)"} 10%, transparent)`,
              }}
              title={`Original: ${s.before} → After: ${s.after}`}
            >
              {s.kind} ✕ redacted
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Render a remark with inline highlights on any substring that the partner
// view does NOT contain (i.e. what was stripped or replaced). We do this by
// walking the "after" string and projecting the "before" segments alongside
// the redaction tokens we see in the after string ([PHONE REDACTED], etc).
function RemarkDiff({ before, after }: { before: string; after: string }) {
  // If the strings are identical, nothing to highlight — render plain.
  if (before === after || !before) {
    return <span>{after ? `"${after}…"` : ""}</span>;
  }
  // Strategy: look for each redaction token in `after`; the corresponding
  // segment in `before` is the original. Render the remark by interleaving
  // the unchanged context with strike-through originals + yellow tokens.
  const tokens = ["[PHONE REDACTED]", "[REDACTED]", "[SERIAL REDACTED]", "[TM REFERENCE REDACTED]"];
  const segments: { text: string; kind?: "redacted" | "original" }[] = [];

  // Walk both strings in parallel, anchored on the redaction tokens in `after`.
  let aIdx = 0;
  let bIdx = 0;
  while (aIdx < after.length) {
    const nextToken = tokens
      .map((t) => ({ t, pos: after.indexOf(t, aIdx) }))
      .filter((x) => x.pos >= 0)
      .sort((a, b) => a.pos - b.pos)[0];
    if (!nextToken) {
      // No more tokens — emit the rest of `after` as unchanged.
      segments.push({ text: after.slice(aIdx) });
      break;
    }
    // Prefix unchanged context.
    if (nextToken.pos > aIdx) {
      const chunk = after.slice(aIdx, nextToken.pos);
      segments.push({ text: chunk });
      bIdx += chunk.length;
    }
    // Locate the corresponding original-substring in `before`. We assume the
    // unchanged prefix matches up to bIdx, then the original spans until the
    // next matching context character — approximated by reading until the
    // next character that matches the post-token suffix in `after`.
    const afterAfterToken = after.slice(nextToken.pos + nextToken.t.length);
    const suffixAnchor = afterAfterToken.slice(0, 8); // first 8 chars to anchor
    let originalEnd = before.length;
    if (suffixAnchor) {
      const found = before.indexOf(suffixAnchor, bIdx);
      if (found >= 0) originalEnd = found;
    }
    const originalSegment = before.slice(bIdx, originalEnd);
    segments.push({ text: originalSegment, kind: "original" });
    segments.push({ text: nextToken.t, kind: "redacted" });
    bIdx = originalEnd;
    aIdx = nextToken.pos + nextToken.t.length;
  }

  return (
    <span>
      "
      {segments.map((s, i) =>
        s.kind === "original" ? (
          <span
            key={i}
            className="rounded-sm px-0.5 line-through"
            style={{
              background: "color-mix(in oklab, var(--color-danger) 18%, transparent)",
              color: "var(--color-danger)",
            }}
            title="original value (preview only — never released)"
          >
            {s.text}
          </span>
        ) : s.kind === "redacted" ? (
          <span
            key={i}
            className="rounded-sm px-0.5 font-semibold"
            style={{
              background: "color-mix(in oklab, var(--color-warning) 28%, transparent)",
              color: "var(--color-warning)",
            }}
            title="value stripped before partner release"
          >
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
      …"
    </span>
  );
}
