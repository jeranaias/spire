/**
 * SecurityView — `/security`
 *
 * The honest answer to "where do you document your session model and PKI
 * story?" Task #29 stripped the contractor jargon ("SESSION · HMAC-SHA256
 * · HttpOnly · SameSite=Lax") off the cert-selection front door because no
 * Marine reads that line and feels reassured. The primitives are still
 * real, though, and a security-minded judge or a customer's IA officer
 * will eventually ask. This page is where we put the answer.
 *
 * Sections:
 *   1. Session model           — cookie name, signing, TTL, lockout
 *   2. Cookie flags            — HttpOnly, SameSite=Lax, Secure (prod)
 *   3. RBAC source             — CAC payload → role → backend gates
 *   4. PKI / CAC story         — production target vs. demo build
 *   5. DDIL behavior           — what works offline, what queues
 *
 * Reachable both pre-login (linked from the AuthView footer) and
 * post-login (linked from the HelpOverlay). Registered OUTSIDE
 * RequireAuth so the cert-selection splash can deep-link to it without
 * forcing the visitor through sign-in first — same pattern as
 * `/joint/preview` and `/integrations/joint`.
 *
 * Pure content surface: no store dependencies, no API calls.
 */
import { Link } from "react-router-dom";
import { useSpireStore } from "../state/store";
import { ClassificationBannerStrip } from "../components/ClassificationBannerStrip";

const SECTIONS = [
  { id: "session",  label: "Session" },
  { id: "cookies",  label: "Cookie flags" },
  { id: "rbac",     label: "RBAC" },
  { id: "pki",      label: "PKI / CAC" },
  { id: "ddil",     label: "DDIL" },
];

export function SecurityView() {
  // Whether the visitor is signed in changes the "back" link target —
  // pre-login visitors came from `/auth`, post-login visitors came from
  // somewhere inside the App shell. Either way the page renders the same
  // content; only the trailing link differs.
  const currentUser = useSpireStore((s) => s.currentUser);
  const backTo = currentUser ? "/" : "/auth";
  const backLabel = currentUser ? "Back to SPIRE" : "Back to sign-in";

  return (
    <div className="flex h-screen flex-col bg-[var(--color-bg)] text-[var(--color-text)]">
      <ClassificationBannerStrip position="top" />
      <div className="flex flex-1 flex-col overflow-y-auto">
        <Header backTo={backTo} backLabel={backLabel} />
        <SectionNav />
        <div className="mx-auto w-full max-w-5xl px-6 py-6">
          <SessionSection />
          <CookieSection />
          <RbacSection />
          <PkiSection />
          <DdilSection />
          <Footer backTo={backTo} backLabel={backLabel} />
        </div>
      </div>
      <ClassificationBannerStrip position="bottom" />
    </div>
  );
}

// ─── Header ────────────────────────────────────────────────────────────────

function Header({ backTo, backLabel }: { backTo: string; backLabel: string }) {
  return (
    <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="mx-auto flex w-full max-w-5xl items-start justify-between gap-4 px-6 py-5">
        <div>
          <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-primary)]">
            SPIRE · Security &amp; identity
          </div>
          <h1 className="mt-1 font-mono text-2xl font-semibold tracking-wide text-[var(--color-text)]">
            How SPIRE handles sessions and PKI
          </h1>
          <p className="mt-2 max-w-3xl spire-body-muted">
            What this build actually does for authentication, session storage,
            role enforcement, certificate handling, and disconnected
            operation. Written for a security-minded reviewer who wants to
            see the primitives — and to be honest about what is real today
            in the demo build versus what stands up in a fielded
            deployment.
          </p>
        </div>
        <Link
          to={backTo}
          className="shrink-0 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-primary)] hover:text-[var(--color-text)]"
        >
          ← {backLabel}
        </Link>
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
            href={`#/security#${s.id}`}
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

// ─── 1 · Session model ─────────────────────────────────────────────────────

function SessionSection() {
  return (
    <Section id="session" title="1 · Session model" subtitle="What a successful sign-in actually mints.">
      <Panel>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Stat label="Cookie name" value="spire_session" foot="Single cookie, scoped to path /" />
          <Stat label="Lifetime" value="12 hours" foot="One Marine shift; no sliding refresh" />
          <Stat label="Signature" value="HMAC-SHA256" foot="Signed payload, no server-side store" />
        </div>

        <p className="mt-4 spire-body-muted text-sm">
          On a successful CAC selection + PIN, the backend mints a session
          token shaped <code className="font-mono text-[var(--color-text-secondary)]">payload_b64.signature_b64</code>.
          The payload is a small JSON object — DODID, issued-at, expires-at,
          and a random <code className="font-mono">jti</code> nonce — base64url-encoded
          and then signed with HMAC-SHA256 over the encoded bytes. Verification
          recomputes the signature with a constant-time compare and rejects
          any token whose <code className="font-mono">exp</code> has passed.
        </p>

        <p className="mt-2 spire-body-muted text-sm">
          The signing key comes from the <code className="font-mono text-[var(--color-text-secondary)]">SPIRE_SESSION_SECRET</code>
          environment variable. If it is unset (e.g. on a fresh dev box) the
          process mints a per-process random key on first use and warns
          loudly to stderr — outstanding sessions do not survive a backend
          restart in that case, which is the right failure mode for a
          missing secret. There is no hardcoded fallback shared across
          installs.
        </p>

        <p className="mt-2 spire-body-muted text-sm">
          There is no server-side session store. The cookie IS the session;
          we lean on HMAC verification + the <code className="font-mono">exp</code> claim
          for revocation by attrition. A real fielded build would add a
          server-side <code className="font-mono">jti</code> revocation list so a stolen
          session can be killed mid-shift; today the only revocation is
          logout (which clears the cookie client-side) or waiting out the
          12-hour expiry.
        </p>

        <FootCite>
          Source: <code className="font-mono">backend/auth.py</code> —
          <code className="font-mono"> sign_session</code>, <code className="font-mono">verify_session</code>,
          <code className="font-mono"> SESSION_TTL_SECONDS</code>.
        </FootCite>
      </Panel>
    </Section>
  );
}

// ─── 2 · Cookie flags ──────────────────────────────────────────────────────

function CookieSection() {
  return (
    <Section id="cookies" title="2 · Cookie flags" subtitle="What the Set-Cookie header actually carries.">
      <Panel>
        <div className="overflow-x-auto rounded-sm border border-[var(--color-border)]">
          <table className="w-full border-collapse font-mono text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg)] text-left">
                <th className="px-3 py-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">Flag</th>
                <th className="px-3 py-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">Value</th>
                <th className="px-3 py-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">Why</th>
              </tr>
            </thead>
            <tbody>
              <FlagRow
                name="HttpOnly"
                value="true"
                why="JavaScript on the page cannot read the cookie. Defends against an XSS popping the session token."
              />
              <FlagRow
                name="SameSite"
                value="Lax"
                why="Cookie is not sent on cross-site sub-requests (image, iframe, fetch from other origins). Top-level navigations from a same-site link still carry it. Mitigates CSRF without breaking the joint-COP partner-tab pattern."
              />
              <FlagRow
                name="Secure"
                value="prod: true · dev: false"
                why="Gated by the SPIRE_SESSION_SECURE env var. Off by default so the cookie works over plain HTTP on a local dev box; turned on behind a TLS-terminating proxy in any real deployment."
              />
              <FlagRow
                name="Path"
                value="/"
                why="Single cookie, app-wide. There is no multi-tenant cookie scoping — one SPIRE install, one session domain."
              />
              <FlagRow
                name="Max-Age"
                value="43200 s · 12 h"
                why="Matches the SESSION_TTL_SECONDS payload claim. Browser drops the cookie at the same moment the backend would reject it."
              />
              <FlagRow
                name="Domain"
                value="(unset)"
                why="Browser default — host-only cookie. Subdomains do not inherit the session, which is the conservative choice."
              />
            </tbody>
          </table>
        </div>

        <p className="mt-3 spire-body-muted text-sm">
          The session cookie is the only first-party cookie SPIRE sets. There
          is no separate CSRF token cookie — SameSite=Lax + state-changing
          calls being POST-only on same-origin paths is the CSRF posture for
          this build. A fielded deployment behind a corporate proxy that
          rewrites SameSite (or that hosts SPIRE on a shared cookie domain)
          should add an explicit double-submit CSRF token.
        </p>

        <FootCite>
          Source: <code className="font-mono">backend/auth.py</code> —
          <code className="font-mono"> response.set_cookie(...)</code> in
          <code className="font-mono"> /api/auth/login</code>.
        </FootCite>
      </Panel>
    </Section>
  );
}

function FlagRow({ name, value, why }: { name: string; value: string; why: string }) {
  return (
    <tr className="border-b border-[var(--color-border)] align-top">
      <td className="px-3 py-2 font-mono text-[var(--color-text)]">{name}</td>
      <td className="px-3 py-2 font-mono text-[var(--color-text-secondary)]">{value}</td>
      <td className="px-3 py-2 spire-body-muted text-sm">{why}</td>
    </tr>
  );
}

// ─── 3 · RBAC ──────────────────────────────────────────────────────────────

function RbacSection() {
  return (
    <Section id="rbac" title="3 · RBAC source" subtitle="Where the role on every request comes from.">
      <Panel>
        <ol className="flex flex-col gap-3">
          <Step n={1} title="CAC selection at sign-in">
            The cert-selection splash returns the four mocked Marine identities
            from <code className="font-mono">/api/auth/users</code>. Each one carries a fixed
            role (g4, maintenance_chief, security_manager, mef_commander) and a
            unit chain (CLB-Det → 3d MLR → 3d MarDiv → III MEF → MARFORPAC). In a
            fielded build, the role + unit derive from the CAC's authorization
            attributes after CRL/OCSP validation — but the cookie payload shape
            does not change.
          </Step>
          <Step n={2} title="Session middleware re-hydrates user state">
            On every <code className="font-mono">/api/*</code> call (excluding
            <code className="font-mono"> /api/auth/*</code> and the bare
            <code className="font-mono"> /api/system/status</code> health probe), the session
            middleware verifies the cookie, looks up the identity in the mock
            directory, and attaches the full record to
            <code className="font-mono"> request.state.user</code>. Anonymous calls to
            authenticated endpoints get a clean 401 — the frontend
            <code className="font-mono"> UnauthenticatedBridge</code> catches it and bounces
            the operator back to <code className="font-mono">/auth</code>, preserving the intended
            destination so deep links survive a re-auth.
          </Step>
          <Step n={3} title="Per-route role gates">
            Backend handlers call <code className="font-mono">require_role(user, ROLE_SET, capability)</code>
            from <code className="font-mono">backend/scoping.py</code>. The capability sets are
            named (<code className="font-mono">AUDIT_READ_ROLES</code>,
            <code className="font-mono"> SECURE_WIPE_ROLES</code>,
            <code className="font-mono"> AIRGAP_ROLES</code>,
            <code className="font-mono"> SCENARIO_CONTROL_ROLES</code>,
            <code className="font-mono"> MODEL_REGISTRY_ROLES</code>, etc.) and a denied call
            raises an HTTP 403 that the audit chain stamps. The
            <code className="font-mono"> tests/test_role_gates.py</code> suite walks every
            (role × view) combination so a code-review-time scoping change
            cannot quietly grant a role new privileges.
          </Step>
          <Step n={4} title="Frontend mirror, never the source of truth">
            The frontend <code className="font-mono">VIEW_SCOPE</code> map and the
            <code className="font-mono"> ScopeGuard</code> route wrappers exist to keep the operator
            from typing a URL they cannot use, but they are decorative — every
            authoritative role check happens server-side. Hiding a button never
            substitutes for gating the endpoint.
          </Step>
        </ol>

        <FootCite>
          Source: <code className="font-mono">backend/auth.py</code> (session middleware),
          <code className="font-mono"> backend/scoping.py</code> (capability sets +
          <code className="font-mono"> require_role</code>), <code className="font-mono">tests/test_role_gates.py</code>
          (full role-matrix coverage).
        </FootCite>
      </Panel>
    </Section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[2.5rem_1fr] gap-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="flex items-start justify-center">
        <span className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] px-2 py-0.5 font-mono text-xs uppercase tracking-widest text-[var(--color-primary)]">
          {n}
        </span>
      </div>
      <div>
        <div className="font-mono text-sm font-semibold text-[var(--color-text)]">{title}</div>
        <div className="mt-1 spire-body-muted text-sm">{children}</div>
      </div>
    </li>
  );
}

// ─── 4 · PKI / CAC ─────────────────────────────────────────────────────────

function PkiSection() {
  return (
    <Section id="pki" title="4 · PKI / CAC story" subtitle="The honest gap between the demo build and a fielded build.">
      <Panel>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <PkiColumn
            tone="warning"
            title="Demo build (this app)"
            blurb="What you are looking at right now."
            items={[
              "Cert selection is a four-up mock smartcard reader. The four Marines exist in MOCK_USERS; no real x.509 cert is parsed.",
              "Any 6-digit numeric PIN clears. The frontend hint says so. There is no PIN-fail counter on the server because there is no real cert to lock.",
              "There is no live OCSP responder, no CRL polling, no DoD PKI root chain validation. The demo build cannot tell a revoked CAC from a valid one.",
              "Sign-in mints the same HMAC-signed cookie a fielded build would. The session contract is real; the identity it binds is mocked.",
            ]}
          />
          <PkiColumn
            tone="success"
            title="Fielded build (production target)"
            blurb="What stands up before any real CAC sees this app."
            items={[
              "Smartcard read via PKCS#11 (or the native Windows CSP on a CAC-enabled workstation). The cert chain validates against the DoD Root CA bundle (DoD Root CA 3 / 6 + intermediates).",
              "Revocation: OCSP stapling primary, CRL fallback for DDIL — a denied OCSP response or a hit on a cached CRL kills the sign-in and stamps the audit chain.",
              "PIN entry happens at the smartcard — not in our text input. Five wrong PINs lock the cert at the card, not at the application.",
              "Role + unit derive from the CAC's authorization attributes (DoD EDIPI + MILCONNECT-style attribute claims), not from a mocked directory. The cookie payload shape does not change.",
            ]}
          />
        </div>

        <CalloutBox tone="warning" title="What this means for a reviewer">
          <p className="spire-body-muted text-sm">
            If you are evaluating SPIRE as a candidate for a fielded
            deployment, the PKI gap above is the largest single delta between
            the demo and a real install. The application contract — session
            cookie shape, RBAC enforcement, audit chain stamping — is
            deliberately the same on both sides of that line, so the work to
            cut over is "swap the identity provider," not "rewrite the auth
            stack."
          </p>
        </CalloutBox>

        <FootCite>
          Source: <code className="font-mono">backend/auth.py</code> docstring +
          <code className="font-mono"> /api/auth/login</code> (PIN handling), and the
          comments in <code className="font-mono">frontend/src/views/AuthView.tsx</code> that
          mark the surface as visual-only.
        </FootCite>
      </Panel>
    </Section>
  );
}

function PkiColumn({
  tone,
  title,
  blurb,
  items,
}: {
  tone: "warning" | "success";
  title: string;
  blurb: string;
  items: string[];
}) {
  const accent = tone === "success" ? "var(--color-success)" : "var(--color-warning)";
  return (
    <div
      className="rounded-md border p-4"
      style={{
        borderColor: accent,
        background: `linear-gradient(135deg, color-mix(in oklab, ${accent} 10%, var(--color-surface)) 0%, var(--color-surface) 65%)`,
      }}
    >
      <div
        className="font-mono text-[11px] uppercase tracking-widest"
        style={{ color: accent }}
      >
        {title}
      </div>
      <p className="mt-1 spire-body-muted text-sm">{blurb}</p>
      <ul className="mt-3 flex flex-col gap-2 font-mono text-xs leading-snug text-[var(--color-text-secondary)]">
        {items.map((it, i) => (
          <li key={i}>
            <span className="text-[var(--color-text-muted)]">— </span>
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── 5 · DDIL behavior ────────────────────────────────────────────────────

function DdilSection() {
  return (
    <Section id="ddil" title="5 · DDIL behavior" subtitle="What works when SATCOM goes intermittent or drops entirely.">
      <Panel>
        <p className="spire-body-muted text-sm">
          Denied / Disrupted / Intermittent / Limited connectivity is a first-
          class operator state in SPIRE, not an error path. Every authenticated
          operator can move the DDIL dial themselves — there is no admin
          posture toggle gating it — because the goal is realistic in-stage
          drills, not access control.
        </p>

        <div className="mt-4 overflow-x-auto rounded-sm border border-[var(--color-border)]">
          <table className="w-full border-collapse font-mono text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg)] text-left">
                <th className="px-3 py-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">Mode</th>
                <th className="px-3 py-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">Reads</th>
                <th className="px-3 py-2 text-xs uppercase tracking-widest text-[var(--color-text-muted)]">Writes</th>
              </tr>
            </thead>
            <tbody>
              <DdilRow
                mode="CONNECTED"
                reads="Pass straight through to the wire. Successful responses are cached against the operator's last-known-good window (10-minute TTL) so the next degradation step has data."
                writes="Pass straight through. Audit chain stamps as normal."
              />
              <DdilRow
                mode="LIMITED"
                reads="Pass through with synthetic latency. Operator sees the freshness badge tick but no failures."
                writes="Pass through. No queueing."
              />
              <DdilRow
                mode="INTERMITTENT"
                reads="A fraction of reads drop with a synthetic 'packet dropped' error; the rest return live data. Cached reads remain available as a fall-back via explicit retry."
                writes="A fraction of writes drop with the same posture. The operator sees which write failed and can retry."
              />
              <DdilRow
                mode="DISCONNECTED"
                reads="Served from the local last-known-good cache. A read for a key that was never cached returns a clean 'no cached data for this read' error — we never silently fabricate."
                writes="Queued client-side with a stable local id. The audit chain still records the queued intent. Operators replay the queue when CONNECTED is restored."
              />
            </tbody>
          </table>
        </div>

        <p className="mt-3 spire-body-muted text-sm">
          A small set of endpoints is DDIL-exempt by design — system status,
          DDIL itself, and audit/health probes — so the chrome stays honest
          even when the rest of the surface is degraded. The exempt list
          lives in <code className="font-mono">frontend/src/api.ts</code>; nothing classified is on it.
        </p>

        <CalloutBox tone="info" title="What DDIL does NOT do">
          <ul className="flex flex-col gap-1.5 spire-body-muted text-sm">
            <li>
              <span className="text-[var(--color-text-muted)]">— </span>
              It does not change role gates. A queued write that the operator
              is not authorized to perform is rejected when it replays —
              authorization travels with the request.
            </li>
            <li>
              <span className="text-[var(--color-text-muted)]">— </span>
              It does not extend the session. A 12-hour shift remains a 12-hour
              shift even if the operator was disconnected for part of it.
            </li>
            <li>
              <span className="text-[var(--color-text-muted)]">— </span>
              It does not silently downgrade classification. If a cached read
              is unavailable for a higher-classification key, the operator
              sees the error — they do not see a lower-classification fallback.
            </li>
          </ul>
        </CalloutBox>

        <FootCite>
          Source: <code className="font-mono">frontend/src/api.ts</code> (interceptor), 
          <code className="font-mono"> frontend/src/state/store.ts</code> (DDIL mode + cache), 
          <code className="font-mono"> backend/routes/system.py</code> (system status / DDIL-exempt
          health probe).
        </FootCite>
      </Panel>
    </Section>
  );
}

function DdilRow({ mode, reads, writes }: { mode: string; reads: string; writes: string }) {
  return (
    <tr className="border-b border-[var(--color-border)] align-top">
      <td className="px-3 py-2 font-mono text-xs uppercase tracking-widest text-[var(--color-primary)]">{mode}</td>
      <td className="px-3 py-2 spire-body-muted text-sm">{reads}</td>
      <td className="px-3 py-2 spire-body-muted text-sm">{writes}</td>
    </tr>
  );
}

// ─── Footer ────────────────────────────────────────────────────────────────

function Footer({ backTo, backLabel }: { backTo: string; backLabel: string }) {
  return (
    <footer className="mt-10 border-t border-[var(--color-border)] pt-4">
      <div className="font-mono text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
        Related
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-sm">
        <Link
          to="/about/transition"
          className="text-[var(--color-primary)] underline-offset-2 hover:underline"
        >
          Transition pathway · SBIR → MTA-RP →
        </Link>
        <span className="text-[var(--color-text-muted)]">·</span>
        <Link
          to="/about/team"
          className="text-[var(--color-primary)] underline-offset-2 hover:underline"
        >
          Warfighter customer &amp; team →
        </Link>
        <span className="text-[var(--color-text-muted)]">·</span>
        <Link
          to={backTo}
          className="text-[var(--color-primary)] underline-offset-2 hover:underline"
        >
          ← {backLabel}
        </Link>
      </div>
      <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-muted)]">
        Last reviewed against the codebase: April 2026.
      </p>
    </footer>
  );
}

// ─── Shared primitives (mirrors TransitionView's presentation language) ───

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
    <section id={id} className="mb-10 scroll-mt-24">
      <div className="mb-4">
        <h2 className="font-mono text-lg font-semibold tracking-wide text-[var(--color-text)]">
          {title}
        </h2>
        <p className="mt-1 spire-body-muted max-w-3xl">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      {children}
    </div>
  );
}

function Stat({ label, value, foot }: { label: string; value: string; foot?: string }) {
  return (
    <div className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] p-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className="mt-1 font-mono text-sm text-[var(--color-text)]">{value}</div>
      {foot && (
        <div className="mt-1 font-mono text-[11px] tracking-wider text-[var(--color-text-muted)]">
          {foot}
        </div>
      )}
    </div>
  );
}

function FootCite({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-[var(--color-border)] pt-3 font-mono text-[11px] tracking-wider text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}

function CalloutBox({
  tone,
  title,
  children,
}: {
  tone: "warning" | "info";
  title: string;
  children: React.ReactNode;
}) {
  const accent = tone === "warning" ? "var(--color-warning)" : "var(--color-primary)";
  return (
    <div
      className="mt-4 rounded-sm border p-3"
      style={{
        borderColor: accent,
        background: `color-mix(in oklab, ${accent} 10%, var(--color-surface))`,
      }}
    >
      <div
        className="font-mono text-[11px] uppercase tracking-widest"
        style={{ color: accent }}
      >
        {title}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}
