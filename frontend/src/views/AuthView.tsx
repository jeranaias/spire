import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api, type PublicAuthUser } from "../api";
import { useSpireStore } from "../state/store";
import { Button, Pressable, ErrorState, EmptyState, useIdempotentAction } from "../components/ui";
import { ClassificationBannerStrip } from "../components/ClassificationBannerStrip";

// CAC/PIV cert-selection splash. No app chrome — this surface IS the
// front door. Four mocked Marines render as smartcards; pick one, enter
// any 6-digit PIN, sign in. The real product chains cert -> OCSP ->
// PKCS11 reader; this surface fakes the visual + UX so SPIRE never
// shows a "username and password" prompt that would end the demo.
export function AuthView() {
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const signIn = useSpireStore((s) => s.signIn);
  const currentUser = useSpireStore((s) => s.currentUser);

  const [users, setUsers] = useState<PublicAuthUser[] | null>(null);
  const [usersErr, setUsersErr] = useState<string | null>(null);
  const [selectedDodid, setSelectedDodid] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pinInput = useRef<HTMLInputElement | null>(null);

  // Re-fetch the cert directory; broken out so the ErrorState retry button
  // and the initial mount can call the same path.
  function loadUsers() {
    setUsersErr(null);
    setUsers(null);
    api.auth.users()
      .then((r) => setUsers(r.users))
      .catch((e) => setUsersErr(String(e)));
  }

  // If a session is already restored from sessionStorage when the user
  // arrives at /auth (e.g. typed the path manually), skip the splash and
  // route them home.
  //
  // W1 #83: also honor `loc.state?.from` here so a 401-mid-action that
  // bounced the operator off /admin/models/:id (or any other deep route)
  // returns them to that exact page after re-auth instead of dumping them
  // on the Decision Bridge. Previously this effect always navigated to
  // "/" the moment `currentUser` flipped to non-null, which raced with
  // the submit() handler's `nav(dest)` and erased the intended target.
  useEffect(() => {
    if (currentUser) {
      const dest = loc.state?.from || "/";
      nav(dest, { replace: true });
    }
  }, [currentUser, loc, nav]);

  useEffect(() => {
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedDodid && pinInput.current) {
      pinInput.current.focus();
    }
  }, [selectedDodid]);

  function pickCert(dodid: string) {
    setSelectedDodid(dodid);
    setPin("");
    setError(null);
  }

  // Idempotent: triple-tapping "Sign in" emits exactly one login attempt
  // even on slow renders / sluggish CAC reads. Keyed on dodid+pin so a
  // second attempt with different inputs after a failure isn't blocked.
  const loginAction = useIdempotentAction(
    `auth:login:${selectedDodid ?? ""}:${pin}`,
    async () => {
      if (!selectedDodid) throw new Error("__no_cert__");
      return api.auth.login(selectedDodid, pin);
    },
    { lockoutMs: 500 },
  );
  const submitting = loginAction.pending;

  async function submit() {
    if (!selectedDodid) {
      setError("Select a certificate to continue.");
      return;
    }
    if (pin.length !== 6 || !/^\d{6}$/.test(pin)) {
      setError("PIN must be exactly 6 digits.");
      return;
    }
    setError(null);
    try {
      const r = await loginAction.run();
      if (!r) return; // Suppressed by idempotency lockout
      // Hydrate the store. The backend has set the HttpOnly cookie; the
      // store mirror keeps the UI fast on refresh.
      const u = r.user;
      signIn({
        dodid: u.dodid,
        name: u.name,
        first_name: u.first_name,
        last_name: u.last_name,
        rank: u.rank,
        rank_long: u.rank_long,
        billet: u.billet,
        unit: u.unit,
        parent_command: u.parent_command,
        branch: u.branch,
        clearance: u.clearance,
        role: u.role,
        initials: u.initials,
        cert_issuer: u.cert_issuer,
        cert_serial: u.cert_serial,
        cert_expires: u.cert_expires,
      });
      // W1 / Task #24: the Decision Bridge ("/") is the universal front
      // door. Post-login we always send the user there so the 15-second
      // commander dashboard renders before role-specific surfaces; deep
      // links (`loc.state?.from`) still take priority so a forced sign-in
      // off a protected route resumes that route. The role-default
      // landing remains reachable via the "Skip to ..." pressable on the
      // Decision Bridge header (and at `/home` as a direct fallback).
      const dest = loc.state?.from || "/";
      nav(dest, { replace: true });
    } catch (e) {
      const msg = String(e);
      // Backend returns `{detail: "invalid_pin" | "cert_not_found"}`. Surface
      // a friendly message instead of dumping the raw 4xx envelope.
      if (msg.includes("invalid_pin")) setError("Invalid PIN. Any 6 digits accepted in this demo.");
      else if (msg.includes("cert_not_found")) setError("Certificate not recognized.");
      else setError(`Sign-in failed: ${msg.slice(0, 200)}`);
    }
  }

  function onPinKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") submit();
  }

  return (
    // Column flex so the page-level marking strips pin to the very top
    // and very bottom of the viewport (DoDM 5200.01-V2). The auth surface
    // sits outside the App shell, so we mount the strips here directly —
    // the previous 10-px DEMO ENVIRONMENT chip in the corner was invisible
    // on a projector at 30ft (W2 task #28, auth-splash review F2 + F12).
    // h-screen + flex-1 + overflow-y-auto on the inner pane keeps both
    // strips locked to the viewport edges; only the cert pane scrolls.
    <div
      className="flex h-screen w-full flex-col"
      style={{
        background:
          "radial-gradient(120% 80% at 50% 0%, color-mix(in oklab, var(--color-primary) 12%, var(--color-bg)) 0%, var(--color-bg) 60%, #04060c 100%)",
      }}
    >
      <ClassificationBannerStrip position="top" />
      <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-10">
        <div className="mx-auto w-full max-w-5xl">
          {/* Banner row — DoD framing chip kept; the page-level marking
           * is now carried by the strips at top + bottom. */}
          <div className="mb-6 flex items-center justify-between gap-4">
            <div
              className="rounded-sm border px-3 py-1 font-mono text-xs uppercase tracking-widest"
              style={{
                borderColor: "color-mix(in oklab, var(--color-primary) 50%, transparent)",
                background: "color-mix(in oklab, var(--color-primary) 12%, transparent)",
                color: "var(--color-primary)",
              }}
            >
              DoD CAC/PIV Authentication
            </div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              SPIRE · Contested Logistics Engine
            </div>
          </div>

        {/* Brand block */}
        <div className="mb-8 flex items-center gap-4">
          <SpireObelisk />
          <div>
            <div
              className="font-mono text-3xl font-semibold tracking-[0.18em] text-[var(--color-text)]"
              style={{ fontFeatureSettings: "'ss01'" }}
            >
              SPIRE
            </div>
            <div className="mt-1 font-mono text-xs uppercase tracking-[0.22em] text-[var(--color-text-muted)]">
              Sustainment · Prediction · Intelligence · Readiness
            </div>
          </div>
        </div>

        <div className="mb-6">
          <h1 className="font-sans text-xl font-semibold text-[var(--color-text)]">
            Insert smartcard. Select a certificate.
          </h1>
          <p className="mt-1 font-mono text-xs uppercase tracking-wider text-[var(--color-text-secondary)]">
            CAC/PIV demo · {users ? `${users.length} certificate${users.length === 1 ? "" : "s"} loaded` : "loading certificates"} · No live PKI in this build
          </p>
        </div>

        {usersErr && (
          <div className="mb-4">
            <ErrorState
              variant="panel"
              title="CAC reader unreachable"
              description="Failed to load certificates from the CAC reader."
              detail={usersErr}
              onRetry={loadUsers}
              retryLabel="Retry CAC scan"
            />
          </div>
        )}

        {/* Task #185 — cert grid: 1col <sm, 2col sm-lg, 3col lg+. */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {users === null && !usersErr && (
            <>
              <CertSkeleton />
              <CertSkeleton />
              <CertSkeleton />
              <CertSkeleton />
            </>
          )}
          {users?.map((u) => (
            <CertCard
              key={u.dodid}
              user={u}
              selected={selectedDodid === u.dodid}
              onPick={() => pickCert(u.dodid)}
            />
          ))}
        </div>
        {users && users.length === 0 && !usersErr && (
          <div className="mt-2">
            <EmptyState
              title="No certificates found"
              description="The CAC reader did not return any certificates. Re-insert your card or contact your unit S-6."
              action={
                <Button variant="secondary" onClick={loadUsers}>
                  Rescan reader
                </Button>
              }
            />
          </div>
        )}

        {/* PIN row — appears when a cert is picked */}
        <div
          className="mt-6 rounded-md border p-5"
          style={{
            borderColor: selectedDodid
              ? "color-mix(in oklab, var(--color-primary) 60%, var(--color-border))"
              : "var(--color-border)",
            background: "color-mix(in oklab, var(--color-surface) 90%, transparent)",
          }}
        >
          <div className="flex items-end justify-between gap-4">
            <div className="min-w-0 flex-1">
              <label
                htmlFor="cac-pin"
                className="mb-1 block font-mono text-xs uppercase tracking-widest text-[var(--color-text-secondary)]"
              >
                Card PIN · 6 digits
              </label>
              <input
                id="cac-pin"
                ref={pinInput}
                inputMode="numeric"
                autoComplete="off"
                type="password"
                value={pin}
                disabled={!selectedDodid || submitting}
                onChange={(e) => {
                  // Strip non-digits, cap at 6 for clean UX.
                  const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                  setPin(v);
                  if (error) setError(null);
                }}
                onKeyDown={onPinKey}
                placeholder={selectedDodid ? "••••••" : "Pick a cert above"}
                className={`w-full rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-3 py-2 font-mono text-2xl text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] focus:outline-none disabled:opacity-50 ${selectedDodid ? "tracking-[0.5em]" : "tracking-normal"}`}
                aria-describedby="pin-hint"
              />
              <div id="pin-hint" className="mt-1 font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                Demo: any 6 digits accepted · 5 wrong PINs lock the cert in production
              </div>
            </div>
            <Button
              variant="primary"
              size="lg"
              disabled={!selectedDodid || pin.length !== 6}
              pending={submitting}
              onClick={submit}
              className="shrink-0"
            >
              {submitting ? "Verifying…" : "Sign in"}
            </Button>
          </div>
          {error && (
            <div
              className="mt-3 rounded-sm border px-3 py-2 font-mono text-xs"
              style={{
                borderColor: "var(--color-danger)",
                background: "color-mix(in oklab, var(--color-danger-muted) 25%, transparent)",
                color: "var(--color-danger)",
              }}
              role="alert"
            >
              {error}
            </div>
          )}
        </div>

        {/* Foot note — operator-relevant. Crypto/session primitives live on
            the security/about page, not the front door. */}
        <div className="mt-6 grid gap-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)] md:grid-cols-3">
          <div>12-hour shift session · cert lockout after 5 PIN failures</div>
          <div className="md:text-center">IL5-fit · local-first · no cloud egress</div>
          <div className="md:text-right">DDIL drills available post-login</div>
        </div>
        </div>
      </div>
      <ClassificationBannerStrip position="bottom" />
    </div>
  );
}

function CertCard({
  user,
  selected,
  onPick,
}: {
  user: PublicAuthUser;
  selected: boolean;
  onPick: () => void;
}) {
  // OPSEC: cert tile renders only the fields a real CAC reader surfaces
  // pre-sign-in — name, rank, branch, masked DODID, cert metadata. We
  // deliberately omit clearance, role, billet, unit, and parent_command
  // here so a judge or passer-by glancing at the splash cannot infer
  // who holds TS//SCI vs SECRET, who's the security manager, etc.
  // Those fields are stripped server-side in `backend/auth.list_users`
  // for unauthenticated callers; this UI matches that contract.
  return (
    <Pressable
      onClick={onPick}
      aria-pressed={selected}
      aria-label={`Select certificate for ${user.name}`}
      className="group !min-h-0 text-left transition-transform"
      style={{ transform: selected ? "translateY(-1px)" : undefined }}
    >
      <div
        className="relative flex h-full items-stretch gap-4 rounded-md border p-4"
        style={{
          borderColor: selected
            ? "var(--color-primary)"
            : "var(--color-border)",
          background: selected
            ? "color-mix(in oklab, var(--color-primary) 10%, var(--color-surface))"
            : "var(--color-surface)",
          boxShadow: selected
            ? "0 0 0 1px var(--color-primary), 0 8px 24px -16px color-mix(in oklab, var(--color-primary) 60%, transparent)"
            : undefined,
        }}
      >
        {/* Branch / avatar block */}
        <div
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-sm font-mono text-xl font-semibold uppercase tracking-wider"
          style={{
            background: "color-mix(in oklab, var(--color-primary) 18%, var(--color-bg))",
            color: "var(--color-primary)",
            border: "1px solid color-mix(in oklab, var(--color-primary) 35%, transparent)",
          }}
          aria-hidden
        >
          {user.initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <div className="truncate font-sans text-base font-semibold text-[var(--color-text)]">
              {user.name}
            </div>
            <div className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              {user.branch}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] tracking-wider text-[var(--color-text-muted)]">
            <span>DODID {maskDodid(user.dodid)}</span>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--color-border)] pt-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            <span className="truncate">{user.cert_issuer ?? "DOD ID CA"}</span>
            <span className="truncate">SN {user.cert_serial ?? "—"}</span>
            <span className="truncate">EXP {user.cert_expires ?? "—"}</span>
          </div>
        </div>
        {selected && (
          <div
            className="absolute right-3 top-3 rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest"
            style={{ background: "var(--color-primary)", color: "white" }}
          >
            Selected
          </div>
        )}
      </div>
    </Pressable>
  );
}

function CertSkeleton() {
  return (
    <div className="h-[140px] animate-pulse rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]" />
  );
}

// Mask DODID the same way DEERS / a real CAC reader does on the
// cert-selection screen — last 4 visible, everything else masked. The
// previous "first 3, last 2" mask leaked far more entropy than the
// regulation-standard "last 4" pattern operators recognize from CACs,
// LES forms, and PIV certs. Task #27 / auth-cac-splash F6.
function maskDodid(dodid: string): string {
  if (!dodid) return dodid;
  if (dodid.length <= 4) return dodid;
  return `${"•".repeat(dodid.length - 4)}${dodid.slice(-4)}`;
}

function SpireObelisk() {
  return (
    <div
      className="relative"
      style={{
        width: 44,
        height: 52,
        filter:
          "drop-shadow(0 0 12px color-mix(in oklab, var(--color-primary) 50%, transparent))",
      }}
    >
      <svg width="44" height="52" viewBox="0 0 30 36" fill="none">
        <defs>
          <linearGradient id="auth-obelisk" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="1" />
            <stop offset="100%" stopColor="var(--color-primary-hover)" stopOpacity="0.75" />
          </linearGradient>
        </defs>
        <path d="M15 1L26 34H4L15 1Z" fill="url(#auth-obelisk)" />
        <path d="M15 1L4 34" stroke="#fff" strokeOpacity="0.5" strokeWidth="0.6" />
        <path d="M15 1L15 34" stroke="#0a0c13" strokeOpacity="0.35" strokeWidth="0.6" />
        <rect x="2" y="34" width="26" height="1.2" fill="var(--color-primary)" opacity="0.85" />
      </svg>
    </div>
  );
}
