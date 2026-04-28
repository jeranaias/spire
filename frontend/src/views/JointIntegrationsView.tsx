/**
 * JointIntegrationsView — `/integrations/joint` documentation page.
 *
 * Authored from the backend `/api/joint/conformance` payload (single source
 * of truth) so the standards / messages / gap list never drifts from what
 * the adapters actually emit. Honest about what isn't wired — bidirectional
 * ingest, real Link 16 radio, additional message families.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type JointConformance } from "../api";

// Task #152 — DoDM 5200.01-V2 page-level marking guardrail. This view
// is mounted outside the App shell (intentionally — it's authored as
// the partner-facing conformance doc and should not carry SPIRE TopBar
// chrome) so it has to render its own top + bottom UNCLASSIFIED // DEMO
// DATA strips, otherwise a judge could read a page that omits the
// disclaimer entirely.
import { ClassificationBannerStrip } from "../components/ClassificationBannerStrip";

interface State {
  loading: boolean;
  data: JointConformance | null;
  error: string | null;
}

export function JointIntegrationsView() {
  const [s, setS] = useState<State>({ loading: true, data: null, error: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await api.joint.conformance();
        if (alive) setS({ loading: false, data, error: null });
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : (e as Error).message;
        if (alive) setS({ loading: false, data: null, error: msg });
      }
    })();
    return () => { alive = false; };
  }, []);

  // Layout: outer column flex pins the canonical CAPCO classification
  // strips to the very top and bottom of the viewport (DoDM 5200.01-V2
  // page-level marking, task #151/152). This page is rendered outside the
  // SPIRE App shell, so the strip is mounted here directly. The
  // documentation surface itself scrolls in the flex-1 middle pane.
  // The strip is the canonical green CAPCO block (UNCLASSIFIED // DEMO
  // DATA // NOT FOR OPERATIONAL USE) regardless of what the
  // conformance posture says about export classification — page-level
  // marking is service-agnostic and must be visible in the first
  // frame on a 30-ft projector.
  return (
    <div className="flex h-screen w-full flex-col bg-[var(--color-bg)]">
      <ClassificationBannerStrip position="top" />
      <div className="flex-1 overflow-y-auto bg-[var(--color-bg)]">
        {s.loading ? (
          <div className="flex h-full items-center justify-center font-mono text-sm uppercase tracking-[0.18em] text-[var(--color-text-muted)]">
            Loading joint conformance posture…
          </div>
        ) : s.error || !s.data ? (
          <div className="p-8 font-mono text-sm text-[var(--color-danger)]">
            Failed to load joint conformance: {s.error ?? "unknown"}
          </div>
        ) : (
          <ConformanceBody d={s.data} />
        )}
      </div>
      <ClassificationBannerStrip position="bottom" />
    </div>
  );
}

function ConformanceBody({ d }: { d: JointConformance }) {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Header />
      <Intro />

      <Section title="Standards adopted" id="standards">
        <div className="space-y-5">
          {d.standardsAdopted.map((std) => (
            <StandardCard key={std.name} std={std} />
          ))}
        </div>
      </Section>

      <Section title="Classification posture" id="classification">
        <Field label="Export classification" value={d.classificationPosture.exportClassification} />
        <Field label="Releasability" value={d.classificationPosture.releasability} />
        <Field label="Backend gate" value={d.classificationPosture.gate} mono />
        <p className="mt-3 text-sm leading-relaxed text-[var(--color-text-secondary)]">
          {d.classificationPosture.rationale}
        </p>
      </Section>

      {d.releaseAuthority && (
        <Section title="Release authority · subscription model" id="release-authority">
          <Field label="Subscription model" value={d.releaseAuthority.subscriptionModel} mono />
          <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
            {d.releaseAuthority.summary}
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                Roles allowed to release
              </div>
              <ul className="space-y-1 text-sm text-[var(--color-text)]">
                {d.releaseAuthority.allowedRoles.map((r) => (
                  <li key={r} className="flex items-start gap-2">
                    <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" aria-hidden />
                    <span className="font-mono text-[12px]">{r}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                Roles denied (operator scope, not release authority)
              </div>
              <ul className="space-y-1 text-sm text-[var(--color-text-secondary)]">
                {d.releaseAuthority.deniedRolesExample.map((r) => (
                  <li key={r} className="flex items-start gap-2">
                    <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-warning)]" aria-hidden />
                    <span className="font-mono text-[12px]">{r}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-[var(--color-text-secondary)]">
            {d.releaseAuthority.auditFooter}
          </p>
        </Section>
      )}

      <Section title="Direction policy" id="direction">
        <div className="grid grid-cols-2 gap-4">
          <DirectionCard label="Egress (SPIRE → joint)" status={d.directionPolicy.egress} />
          <DirectionCard label="Ingress (joint → SPIRE)" status={d.directionPolicy.ingress} />
        </div>
        <p className="mt-3 text-sm leading-relaxed text-[var(--color-text-secondary)]">
          {d.directionPolicy.rationale}
        </p>
      </Section>

      <Section title="Sister-service demonstration" id="demo">
        <p className="text-sm leading-relaxed text-[var(--color-text-secondary)]">
          {d.sisterServiceDemonstration.purpose}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <a
            href={`/#${d.sisterServiceDemonstration.endpoint}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_18%,var(--color-surface))] px-3 py-2 font-mono text-xs uppercase tracking-widest text-[var(--color-primary)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-primary)_28%,var(--color-surface))]"
          >
            Open partner view ↗
          </a>
          <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Shell: {d.sisterServiceDemonstration.shell}
          </span>
        </div>
      </Section>

      <Section title="Out of scope" id="out-of-scope">
        <ul className="list-inside space-y-1 text-sm text-[var(--color-text-secondary)]">
          {d.outOfScope.map((x) => (
            <li key={x} className="flex gap-2">
              <span className="text-[var(--color-text-muted)]">·</span>
              <span>{x}</span>
            </li>
          ))}
        </ul>
      </Section>

      <footer className="mt-10 border-t border-[var(--color-border)] pt-4 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        Conformance posture published {d.publishedAtUtc} · machine-readable: <code className="text-[var(--color-text-secondary)]">/api/joint/conformance</code>
      </footer>
    </div>
  );
}

function Header() {
  return (
    <div className="mb-6">
      <div className="flex items-center justify-between">
        <h1 className="font-mono text-xl font-semibold uppercase tracking-[0.18em] text-[var(--color-text)]">
          Joint Integrations · Conformance &amp; Gap List
        </h1>
        <Link
          to="/"
          className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
        >
          ← Back to SPIRE
        </Link>
      </div>
      <div className="mt-1 font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-muted)]">
        OMS/UCI · MIL-STD-6016 Link 16 · Read-only export adapters
      </div>
    </div>
  );
}

function Intro() {
  return (
    <div className="mb-6 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm leading-relaxed text-[var(--color-text-secondary)]">
      SPIRE was built for a single service, but the COP it feeds is joint. This page documents the
      two joint export adapters SPIRE currently ships, the message families implemented, the
      classification posture, and the gap list — everything that is <em>not</em> yet wired so the
      claim line stays honest. Both adapters are <strong>export-only</strong>; SPIRE neither
      consumes joint feeds nor speaks to a real radio.
    </div>
  );
}

function Section({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mb-7">
      <h2 className="mb-3 font-mono text-sm font-semibold uppercase tracking-[0.18em] text-[var(--color-text)]">
        {title}
      </h2>
      <div>{children}</div>
    </section>
  );
}

function StandardCard({ std }: { std: NonNullable<JointConformance["standardsAdopted"]>[number] }) {
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="font-mono text-sm font-semibold uppercase tracking-widest text-[var(--color-text)]">
            {std.name}
          </div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            {std.version} · {std.owner}
          </div>
        </div>
        <span className="rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_15%,transparent)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-primary)]">
          {std.spireRole}
        </span>
      </div>
      <div className="mt-2 font-mono text-[11px] text-[var(--color-text-secondary)]">
        Endpoint: <code className="text-[var(--color-text)]">{std.endpoint}</code>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Implemented messages
          </div>
          <ul className="space-y-1 text-sm text-[var(--color-text)]">
            {std.messages.map((m: string) => (
              <li key={m} className="flex items-start gap-2">
                <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-success)]" aria-hidden />
                <span className="font-mono text-[12px]">{m}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Not wired (honest gap list)
          </div>
          <ul className="space-y-1 text-sm text-[var(--color-text-secondary)]">
            {std.notWired.map((m: string) => (
              <li key={m} className="flex items-start gap-2">
                <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-warning)]" aria-hidden />
                <span className="font-mono text-[12px]">{m}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-2 text-sm">
      <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {label}:
      </span>
      <span className={mono ? "font-mono text-[12px] text-[var(--color-text)]" : "text-[var(--color-text)]"}>
        {value}
      </span>
    </div>
  );
}

function DirectionCard({ label, status }: { label: string; status: string }) {
  const supported = status === "SUPPORTED";
  return (
    <div
      className="rounded-sm border p-3"
      style={{
        background: supported
          ? "color-mix(in oklab, var(--color-success-muted) 18%, var(--color-surface))"
          : "color-mix(in oklab, var(--color-warning-muted) 18%, var(--color-surface))",
        borderColor: supported
          ? "color-mix(in oklab, var(--color-success) 40%, var(--color-border))"
          : "color-mix(in oklab, var(--color-warning) 40%, var(--color-border))",
      }}
    >
      <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {label}
      </div>
      <div
        className="mt-1 font-mono text-sm font-semibold tracking-widest"
        style={{ color: supported ? "var(--color-success)" : "var(--color-warning)" }}
      >
        {status}
      </div>
    </div>
  );
}
