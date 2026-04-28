import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { ROLE_LABELS, useSpireStore, VIEW_SCOPE, type Density, type Role, type User } from "../state/store";
import { api, type AuthUser, type PulseDraft } from "../api";
import { formatApiError } from "../api-retry";
import { NodeStatus } from "./NodeStatus";
import { MissionClock } from "./MissionClock";
import { CommsControl } from "./CommsControl";
import { Button, DangerButton, Pressable, useIdempotentAction } from "./ui";

const tabs = [
  { to: "/sentry",  label: "SENTRY", restrict: null as Role | null },
  { to: "/pulse",   label: "PULSE",   restrict: null as Role | null },
  { to: "/bastion", label: "BASTION", restrict: null as Role | null },
  { to: "/admin",   label: "ADMIN",   restrict: "security_manager" as Role },
];

// Friendly per-tab list of authorized roles for the out-of-scope tooltip.
function authorizedRolesFor(path: string, role: Role): { allowed: boolean; allowedRoles: Role[] } {
  const scope = VIEW_SCOPE[path];
  if (!scope) return { allowed: true, allowedRoles: [] };
  return { allowed: scope.includes(role), allowedRoles: scope };
}

export function TopBar() {
  const { role, operatingMode, alertCount, currentUser } = useSpireStore();

  return (
    <header className="relative h-14 shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* Thin horizon accent below the top bar */}
      <div
        className="pointer-events-none absolute inset-x-0 -bottom-px h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, color-mix(in oklab, var(--color-primary) 40%, transparent) 12%, color-mix(in oklab, var(--color-primary) 40%, transparent) 88%, transparent 100%)",
        }}
      />
      <div className="relative flex h-full min-w-0 items-center justify-between gap-3 px-4">
        {/* B4 Mission Clock owns the centred region of the topbar.
         * Absolute-positioned + translateX to claim the geometric centre
         * without fighting the flex justify-between layout that hosts the
         * left (brand + tabs) and right (identity + chrome) groups. The
         * clock self-hides below xl so the role-pill + alert badge keep
         * priority on cramped viewports — operators on iPads can still
         * reach the controls via the /admin scenario panel (future) or by
         * widening the window. */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 xl:block">
          <MissionClock />
        </div>
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex shrink-0 items-center gap-2.5">
            <SpireMark />
            <div className="flex flex-col leading-none">
              <span
                className="font-mono text-lg font-semibold tracking-[0.2em] text-[var(--color-text)]"
                style={{ fontFeatureSettings: "'ss01'" }}
              >
                SPIRE
              </span>
              <span
                className="mt-[3px] hidden font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest lg:block"
              >
                Contested Logistics
              </span>
            </div>
          </div>
          <nav className="flex shrink-0 items-center gap-0">
            {tabs
              // ADMIN remains hidden when the role isn't security_manager
              // (it's a privileged surface, not a teaser). Other tabs render
              // even out of scope so operators can see what exists, but they
              // get the disabled treatment + tooltip.
              .filter((t) => t.restrict == null || t.restrict === role)
              .map((tab, idx) => {
                const { allowed, allowedRoles } = authorizedRolesFor(tab.to, role);
                if (!allowed) {
                  // Out-of-scope: render as a non-NavLink span so it can't be
                  // clicked into the InsufficientPrivilege wall.
                  return (
                    <span
                      key={tab.to}
                      aria-disabled="true"
                      title={`Out of scope · authorized: ${allowedRoles.map((r) => ROLE_LABELS[r]).join(", ")}`}
                      className="group relative cursor-not-allowed select-none px-3 py-2 font-mono text-sm font-semibold uppercase tracking-widest text-[var(--color-text-muted)] opacity-50"
                    >
                      <span
                        className="mr-1.5 font-mono text-xs text-[var(--color-text-muted)] tracking-wider"
                      >
                        {String(idx + 1).padStart(2, "0")}
                      </span>
                      {tab.label}
                      {/* Walkthrough audit: the "·LOCK" suffix read as
                       * "01 SENTRY · LOCK" with the dot floating between
                       * — looks like a separator typo. Replace with a
                       * proper lock glyph that visually anchors as an
                       * icon, not text. */}
                      <span
                        className="ml-1.5 text-[11px] text-[var(--color-text-muted)]"
                        aria-label="locked — out of scope for current role"
                      >
                        🔒
                      </span>
                    </span>
                  );
                }
                return (
                  <NavLink
                    key={tab.to}
                    to={tab.to}
                    className={({ isActive }) =>
                      clsx(
                        "group relative px-3 py-2 font-mono text-sm font-semibold uppercase transition-colors tracking-widest",
                        isActive
                          ? "text-[var(--color-text)]"
                          : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span
                          className="mr-1.5 font-mono text-xs text-[var(--color-text-muted)] tracking-wider"
                        >
                          {String(idx + 1).padStart(2, "0")}
                        </span>
                        {tab.label}
                        {isActive && (
                          <>
                            <span
                              className="absolute inset-x-2 -bottom-[1px] h-[2px]"
                              style={{
                                background: "var(--color-primary)",
                                boxShadow: "0 0 8px var(--color-primary)",
                              }}
                            />
                            <span className="absolute left-1 top-1/2 h-1 w-1 -translate-y-1/2 rounded-full bg-[var(--color-primary)]" />
                          </>
                        )}
                      </>
                    )}
                  </NavLink>
                );
              })}
          </nav>
        </div>

        {/* Walkthrough audit: at 1037px viewport the role selector and
         * NodeStatus chip used to overlap the BASTION tab text. The
         * right group now hides the lower-priority chrome below xl so
         * the role selector + alert badge always have room. The hidden
         * controls remain available — DensityToggle is on the help
         * overlay, AirGap mode flips via Security Manager wall, ModeBadge
         * mirrors the StatusFooter mode chip. NodeStatus also hides
         * below xl: an icon-only dot conveys no meaning without its
         * label, and would just add visual noise next to the role
         * selector. */}
        <div className="flex min-w-0 shrink items-center gap-2 overflow-hidden">
          <span className="hidden xl:contents"><NodeStatus /></span>
          <span className="hidden xl:contents"><GcssMcSyncPill /></span>
          <CommsControl />
          <span className="hidden xl:contents"><AirGapToggle /></span>
          <span className="hidden xl:contents"><DensityToggle /></span>
          <ResetDemoButton />
          <PushToJointButton role={role} />
          <DraftsBadge role={role} />
          <IdentityPill user={currentUser} role={role} />
          <span className="hidden xl:contents"><ModeBadge mode={operatingMode} /></span>
          <AlertBadge count={alertCount} />
        </div>
      </div>
    </header>
  );
}

function SpireMark() {
  // The SPIRE obelisk — the heartbeat of the product.
  // A persistent vertical scan-line sweeps the mark every ~6s,
  // signalling the engine is alive and watching.
  return (
    <div
      className="relative"
      style={{
        width: 30,
        height: 36,
        filter:
          "drop-shadow(0 0 10px color-mix(in oklab, var(--color-primary) 45%, transparent))",
      }}
    >
      <svg
        width="30"
        height="36"
        viewBox="0 0 30 36"
        fill="none"
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient id="spire-obelisk-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="1" />
            <stop offset="100%" stopColor="var(--color-primary-hover)" stopOpacity="0.75" />
          </linearGradient>
          <linearGradient id="spire-obelisk-edge" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0.1" />
          </linearGradient>
        </defs>
        {/* Main obelisk body */}
        <path d="M15 1L26 34H4L15 1Z" fill="url(#spire-obelisk-fill)" />
        {/* Left highlight edge */}
        <path d="M15 1L4 34" stroke="url(#spire-obelisk-edge)" strokeWidth="0.6" />
        {/* Center meridian line */}
        <path d="M15 1L15 34" stroke="#0a0c13" strokeWidth="0.6" opacity="0.35" />
        {/* Base plinth */}
        <rect x="2" y="34" width="26" height="1.2" fill="var(--color-primary)" opacity="0.8" />
      </svg>
      {/* Persistent vertical scan-line — the heartbeat */}
      <div
        className="obelisk-scan pointer-events-none absolute left-0 right-0"
        style={{
          top: 0,
          height: "2px",
          background:
            "linear-gradient(90deg, transparent 0%, color-mix(in oklab, var(--color-primary) 90%, white) 50%, transparent 100%)",
          boxShadow: "0 0 6px var(--color-primary), 0 0 12px var(--color-primary)",
          mixBlendMode: "screen",
        }}
      />
    </div>
  );
}

// IdentityPill replaces the previous role-selector dropdown. The role is no
// longer operator-switchable from the chrome — it's derived from the
// signed-in CAC identity. The pill renders the identity (avatar initials,
// rank/name, role badge) as a read-only display, with a click-to-open
// dropdown that exposes Sign Out. If no `currentUser` is in the store the
// pill renders a placeholder; this branch is unreachable during normal use
// (RequireAuth gates every authenticated route) but keeps the component
// resilient during sign-out animations.
function IdentityPill({ user, role }: { user: User | null; role: Role }) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // Stage-day affordance: presenters need to swap CAC identity mid-demo
  // (Hayes for the commander walk, Park for the SENTRY sanitization beat)
  // without the 4-step sign-out → cert-pick → PIN → sign-in dance under
  // stage lights. The dropdown lazy-fetches the cert directory the first
  // time it opens and renders the other identities as one-click switches.
  // The mock backend accepts any 6-digit PIN, so we send "000000" for
  // these in-app swaps and surface a toast explaining the auth path.
  //
  // We cache the FULL directory (not pre-filtered) and derive the swap
  // targets from the current `user.dodid` on render. Pre-filtering on
  // fetch turned stale on the second swap: after Hayes→Park, the cached
  // list still excluded Hayes and included Park, so the third swap had a
  // self-row and missed the original commander.
  const [allCertUsers, setAllCertUsers] = useState<AuthUser[] | null>(null);
  const [certFetchFailed, setCertFetchFailed] = useState(false);
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const nav = useNavigate();
  const signOut = useSpireStore((s) => s.signOut);
  const signIn = useSpireStore((s) => s.signIn);
  const pushToast = useSpireStore((s) => s.pushToast);

  // Lazy-load the cert directory the first time the dropdown opens. If a
  // prior fetch failed we retry on the next open instead of permanently
  // hiding the section — a transient /api/auth/users miss shouldn't lock
  // the presenter out for the rest of the session.
  useEffect(() => {
    if (!open) return;
    if (allCertUsers !== null && !certFetchFailed) return;
    let cancelled = false;
    // Use the authenticated `directory()` variant — the unauthenticated
    // `users()` endpoint strips role/billet/last_name (Task #27 / F1)
    // and the swap menu needs those to render the role label and the
    // post-swap toast. The session cookie is present here, so the
    // backend returns the full `AuthUser` records.
    api.auth.directory()
      .then((r) => {
        if (cancelled) return;
        setAllCertUsers(r.users);
        setCertFetchFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setCertFetchFailed(true);
      });
    return () => { cancelled = true; };
  }, [open, allCertUsers, certFetchFailed]);

  // Derived on every render so post-swap the menu reflects the NEW current
  // identity (excludes self, includes everyone else).
  const switchTargets: AuthUser[] = allCertUsers
    ? allCertUsers.filter((u) => u.dodid !== user?.dodid)
    : [];

  async function switchIdentity(target: AuthUser) {
    if (switchingTo) return;
    setSwitchingTo(target.dodid);
    try {
      // Mock auth: any 6-digit PIN clears. We use 000000 for the in-app
      // swap so the presenter doesn't have to retype on stage. The real
      // sign-in flow (cert + PIN entry) remains the only path from /auth.
      const r = await api.auth.login(target.dodid, "000000");
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
      setOpen(false);
      pushToast({
        tone: "ok",
        text: `Signed in as ${u.rank} ${u.last_name} · ${ROLE_LABELS[u.role as Role]}`,
        ttlMs: 3500,
      });
      // Always land on Decision Bridge after a swap so the new role's
      // permissions resolve cleanly (e.g. swapping into security_manager
      // unlocks /admin in the topbar without a stale render).
      nav("/", { replace: true });
    } catch (e) {
      pushToast({ tone: "error", text: `Identity switch failed: ${formatApiError(e)}` });
    } finally {
      setSwitchingTo(null);
    }
  }

  function openPresenterRoute(path: string) {
    setOpen(false);
    nav(path);
  }

  // Click-outside + Escape to close.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrap.current) return;
      if (!wrap.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Wrapped in useIdempotentAction so a triple-tap on Sign out emits exactly
  // one logout request even on a sluggish render. `signingOut` mirrors the
  // hook's pending so the menu item disables visually.
  const signOutAction = useIdempotentAction(
    "auth:signout",
    async () => {
      try {
        await api.auth.logout();
      } catch (e) {
        // Logout 4xx/5xx isn't fatal — clear locally anyway so the operator
        // doesn't get stranded in an authenticated chrome with no session.
        pushToast({ tone: "warn", text: `Sign-out request failed locally: ${formatApiError(e)}` });
      } finally {
        signOut();
        setOpen(false);
        nav("/auth", { replace: true });
      }
    },
    { lockoutMs: 500 },
  );
  async function doSignOut() {
    setSigningOut(true);
    try {
      await signOutAction.run();
    } finally {
      setSigningOut(false);
    }
  }

  if (!user) {
    return (
      <div
        className="flex h-11 shrink-0 items-center gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 font-mono text-xs uppercase tracking-wider text-[var(--color-text-muted)]"
        title="Not signed in"
      >
        <span className="h-6 w-6 rounded-sm border border-[var(--color-border)]" aria-hidden />
        <span>NOT SIGNED IN</span>
      </div>
    );
  }

  const roleLabel = ROLE_LABELS[role];
  return (
    <div ref={wrap} className="relative shrink-0">
      <Pressable
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu — ${user.name}, ${user.billet}`}
        title={`Signed in as ${user.name} · ${user.billet}`}
        block={false}
        className="!min-h-0 flex h-11 max-w-[18rem] items-center gap-2 rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_10%,var(--color-surface))] pl-1.5 pr-2 font-mono text-xs uppercase tracking-wider text-[var(--color-primary)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-primary)_18%,var(--color-surface))]"
      >
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-[11px] font-semibold"
          style={{
            background: "color-mix(in oklab, var(--color-primary) 28%, var(--color-bg))",
            color: "var(--color-primary)",
            border: "1px solid color-mix(in oklab, var(--color-primary) 45%, transparent)",
          }}
          aria-hidden
        >
          {user.initials}
        </span>
        <span className="flex min-w-0 flex-col items-start leading-tight">
          <span className="max-w-[9.5rem] truncate text-[12px] font-semibold tracking-wider">
            {user.rank} {user.last_name}
          </span>
          <span className="max-w-[9.5rem] truncate text-[10px] font-normal tracking-widest text-[var(--color-text-secondary)]">
            {roleLabel}
          </span>
        </span>
        <svg
          className="ml-0.5 h-3 w-3 text-[var(--color-primary)]"
          viewBox="0 0 12 12"
          fill="currentColor"
          aria-hidden
        >
          <path d="M2 4l4 4 4-4H2z" />
        </svg>
      </Pressable>

      {open && (
        <div
          role="menu"
          aria-label="Account menu"
          className="absolute right-0 top-[calc(100%+6px)] z-[8500] w-72 rounded-md border border-[var(--color-border-active)] bg-[var(--color-surface)] shadow-2xl"
        >
          {/* Identity card */}
          <div className="border-b border-[var(--color-border)] p-4">
            <div className="flex items-center gap-3">
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm font-mono text-base font-semibold"
                style={{
                  background: "color-mix(in oklab, var(--color-primary) 22%, var(--color-bg))",
                  color: "var(--color-primary)",
                  border: "1px solid color-mix(in oklab, var(--color-primary) 40%, transparent)",
                }}
                aria-hidden
              >
                {user.initials}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-sans text-sm font-semibold text-[var(--color-text)]">
                  {user.name}
                </div>
                <div className="truncate font-mono text-[11px] uppercase tracking-wider text-[var(--color-text-secondary)]">
                  {user.billet} · {user.unit}
                </div>
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              <div>
                <dt>Role</dt>
                <dd className="mt-0.5 font-semibold text-[var(--color-text)]">{roleLabel}</dd>
              </div>
              <div>
                <dt>Clearance</dt>
                <dd className="mt-0.5 font-semibold text-[var(--color-text)]">{user.clearance}</dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd className="mt-0.5 font-semibold text-[var(--color-text)]">{user.branch}</dd>
              </div>
            </dl>
            <div className="mt-3 grid grid-cols-1 gap-1 border-t border-[var(--color-border)] pt-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              <div className="flex items-center justify-between gap-2">
                <span>DODID</span>
                <span className="font-semibold text-[var(--color-text-secondary)]">{user.dodid}</span>
              </div>
              {user.cert_serial && (
                <div className="flex items-center justify-between gap-2">
                  <span>Cert SN</span>
                  <span className="font-semibold text-[var(--color-text-secondary)]">{user.cert_serial}</span>
                </div>
              )}
              {user.cert_expires && (
                <div className="flex items-center justify-between gap-2">
                  <span>Cert Exp</span>
                  <span className="font-semibold text-[var(--color-text-secondary)]">{user.cert_expires}</span>
                </div>
              )}
            </div>
          </div>

          {/* Switch identity — stage-day affordance. Lists the other CAC
           * identities so the presenter can swap from MEF Commander to
           * Security Manager (for the SENTRY beat) without leaving the
           * surface they're walking. The mock backend's any-6-digit-PIN
           * rule lets us send 000000 under the hood; the toast surfaces
           * the new identity so the audience sees the role change.
           * Hidden if the cert directory failed to load (offline / API
           * error) so the menu degrades to the Sign-out-only state. */}
          {switchTargets && switchTargets.length > 0 && (
            <div className="border-b border-[var(--color-border)] py-1">
              <div className="px-4 pt-2 pb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                Switch identity
              </div>
              {switchTargets.map((t) => {
                const busy = switchingTo === t.dodid;
                return (
                  <Pressable
                    key={t.dodid}
                    role="menuitem"
                    onClick={() => switchIdentity(t)}
                    disabled={!!switchingTo}
                    aria-label={`Switch to ${t.name}, ${t.billet}`}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-[color-mix(in_oklab,var(--color-primary)_8%,transparent)]"
                  >
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm font-mono text-[11px] font-semibold"
                      style={{
                        background: "color-mix(in oklab, var(--color-primary) 18%, var(--color-bg))",
                        color: "var(--color-primary)",
                        border: "1px solid color-mix(in oklab, var(--color-primary) 35%, transparent)",
                      }}
                      aria-hidden
                    >
                      {t.initials}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col leading-tight">
                      <span className="truncate font-sans text-[12px] font-semibold text-[var(--color-text)]">
                        {t.rank} {t.last_name}
                      </span>
                      <span className="truncate font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-secondary)]">
                        {ROLE_LABELS[t.role as Role]}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                      {busy ? "…" : "→"}
                    </span>
                  </Pressable>
                );
              })}
            </div>
          )}

          {/* Presenter shortcuts — the canonical way to reach /pitch and
           * /demo from inside the app. Avoids the typed-URL footgun
           * caught in walkthrough Run C: a bare /pitch (no hash) loads
           * the SPA index and falls through to the Decision Bridge. The
           * index.html safety-net script catches that case in the URL
           * bar; these menu items are the in-app, one-click entry. */}
          <div className="border-b border-[var(--color-border)] py-1">
            <div className="px-4 pt-2 pb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              Presenter
            </div>
            <Pressable
              role="menuitem"
              onClick={() => openPresenterRoute("/pitch")}
              aria-label="Open the SPIRE pitch deck"
              className="flex w-full items-center justify-between gap-2 px-4 py-2 font-mono text-xs uppercase tracking-widest text-[var(--color-text-secondary)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-primary)_8%,transparent)] hover:text-[var(--color-text)]"
            >
              <span>Open pitch deck</span>
              <span className="font-mono text-[10px] tracking-widest text-[var(--color-text-muted)]">/#/pitch</span>
            </Pressable>
            <Pressable
              role="menuitem"
              onClick={() => openPresenterRoute("/demo")}
              aria-label="Open the SPIRE demo cockpit"
              className="flex w-full items-center justify-between gap-2 px-4 py-2 font-mono text-xs uppercase tracking-widest text-[var(--color-text-secondary)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-primary)_8%,transparent)] hover:text-[var(--color-text)]"
            >
              <span>Open demo cockpit</span>
              <span className="font-mono text-[10px] tracking-widest text-[var(--color-text-muted)]">/#/demo</span>
            </Pressable>
          </div>

          <Pressable
            role="menuitem"
            onClick={doSignOut}
            disabled={signingOut}
            aria-label="Sign out and clear session"
            className="flex w-full items-center justify-between gap-2 px-4 py-3 font-mono text-xs uppercase tracking-widest text-[var(--color-danger)] transition-colors hover:bg-[color-mix(in_oklab,var(--color-danger-muted)_15%,transparent)]"
          >
            <span>{signingOut ? "Signing out…" : "Sign out · clear session"}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </Pressable>
        </div>
      )}
    </div>
  );
}

function ModeBadge({ mode }: { mode: "full" | "lite" }) {
  const isFull = mode === "full";
  return (
    <div
      className="hidden shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-xs uppercase tracking-wider md:flex"
      style={{
        borderColor: isFull
          ? "color-mix(in oklab, var(--color-success) 35%, var(--color-border))"
          : "color-mix(in oklab, var(--color-warning) 35%, var(--color-border))",
        backgroundColor: isFull
          ? "color-mix(in oklab, var(--color-success-muted) 15%, transparent)"
          : "color-mix(in oklab, var(--color-warning-muted) 15%, transparent)",
      }}
      title={isFull ? "Local backend online" : "Reduced-feature lite mode"}
    >
      <span
        className="relative flex h-2 w-2"
        aria-hidden
      >
        <span
          className={clsx(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
            isFull ? "bg-[var(--color-success)]" : "bg-[var(--color-warning)]",
          )}
        />
        <span
          className={clsx(
            "relative inline-flex h-2 w-2 rounded-full",
            isFull ? "bg-[var(--color-success)]" : "bg-[var(--color-warning)]",
          )}
        />
      </span>
      <span
        style={{
          color: isFull ? "var(--color-success)" : "var(--color-warning)",
        }}
      >
        {isFull ? "LOCAL" : "LITE"}
      </span>
    </div>
  );
}

// PULSE Risk Board "Draft Action" surface in the chrome.
//
// Backstory: the Draft Action modal used to fire a green toast and write
// nothing — clicking the headline CTA proved the page was theatre. Now
// every Draft this click POSTs to /pulse/draft-action which writes both
// a pulse_drafts row AND an audit_log entry. This badge is the operator-
// facing receipt: the count goes up immediately (store nonce bump), the
// popover lists every held draft with the asset, kind, MC delta, and
// creation time, and a Dismiss button archives the draft (writing a
// second audit row). Click on a draft row navigates to the Risk Board
// pre-selected on that asset so the operator can drill from "I drafted
// X" back to "X is the asset I drafted on."
//
// Visible for the PULSE roles (maintenance_chief, g4, mef_commander). For
// data_custodian / security_manager the surface they care about is the
// SOC audit view, which already shows draft rows under the
// pulse_draft_action / pulse_draft_dismiss kinds.
function DraftsBadge({ role }: { role: Role }) {
  const allowed = role === "maintenance_chief" || role === "g4" || role === "mef_commander";
  const refreshTick = useSpireStore((s) => s.draftsRefreshTick);
  const pushToast = useSpireStore((s) => s.pushToast);
  const setSelectedAssetId = useSpireStore((s) => s.setSelectedAssetId);
  const bumpDrafts = useSpireStore((s) => s.bumpDraftsRefresh);
  const nav = useNavigate();
  const [drafts, setDrafts] = useState<PulseDraft[]>([]);
  const [unreachable, setUnreachable] = useState(false);
  const [open, setOpen] = useState(false);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);

  // Poll every 15s while the role is allowed; also re-fetch when the
  // store nonce bumps (operator just hit Draft this).
  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function tick() {
      try {
        const r = await api.pulse.drafts("held");
        if (cancelled) return;
        setDrafts(r.drafts);
        setUnreachable(false);
      } catch {
        if (cancelled) return;
        setUnreachable(true);
      } finally {
        if (!cancelled) timer = setTimeout(tick, 15_000);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [allowed, refreshTick]);

  // Click-outside + Escape close the popover.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrap.current) return;
      if (!wrap.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!allowed) return null;

  const count = drafts.length;
  const tone = unreachable ? "var(--color-warning)"
    : count === 0 ? "var(--color-text-muted)"
    : "var(--color-primary)";

  async function dismiss(draftId: string) {
    if (dismissing) return;
    setDismissing(draftId);
    try {
      await api.pulse.dismissDraft(draftId);
      // Optimistic local strip — the next poll round-trips the source of
      // truth back in.
      setDrafts((prev) => prev.filter((d) => d.draft_id !== draftId));
      bumpDrafts();
      pushToast({ tone: "ok", text: `Draft ${draftId} dismissed`, ttlMs: 3000 });
    } catch (e) {
      pushToast({ tone: "error", text: `Dismiss failed: ${formatApiError(e)}` });
    } finally {
      setDismissing(null);
    }
  }

  function openOnAsset(d: PulseDraft) {
    setSelectedAssetId(d.asset_id);
    setOpen(false);
    nav("/pulse/risk");
  }

  return (
    <div ref={wrap} className="relative shrink-0">
      <Pressable
        onClick={() => setOpen((v) => !v)}
        block={false}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${count} draft action${count === 1 ? "" : "s"} held`}
        title={unreachable
          ? "Drafts queue unreachable — backend may be offline"
          : count === 0
            ? "No drafts held — Risk Board Draft Action lands here"
            : `${count} draft action${count === 1 ? "" : "s"} held · click to review`}
        className="!min-h-0 flex h-11 shrink-0 items-center gap-1.5 rounded-sm border bg-[var(--color-bg)] px-2 font-mono text-xs uppercase tracking-wider"
        style={{
          borderColor: count > 0
            ? "color-mix(in oklab, var(--color-primary) 45%, var(--color-border))"
            : "var(--color-border)",
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: tone }} aria-hidden>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M9 13h6" />
          <path d="M9 17h4" />
        </svg>
        <span style={{ color: tone }}>DRAFTS</span>
        <span className="tabular-nums" style={{ color: tone }}>
          {String(count).padStart(2, "0")}
        </span>
      </Pressable>
      {open && (
        <div
          role="menu"
          aria-label="Held drafts"
          className="absolute right-0 top-[calc(100%+6px)] z-[8500] w-[28rem] max-w-[92vw] rounded-md border border-[var(--color-border-active)] bg-[var(--color-surface)] shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
            <div>
              <div className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
                Risk Board · Held Drafts
              </div>
              <div className="mt-0.5 font-mono text-[10px] uppercase text-[var(--color-text-muted)] tracking-widest">
                Persisted with audit row · no auto-approval workflow
              </div>
            </div>
            <span
              className="rounded-sm border border-[var(--color-border)] px-1.5 py-[1px] font-mono text-[10px] tabular-nums tracking-widest text-[var(--color-text-secondary)]"
              title="Held drafts in this view"
            >
              {count}
            </span>
          </div>
          {unreachable && (
            <div className="border-b border-[var(--color-border)] px-4 py-2 font-mono text-[11px] text-[var(--color-warning)] tracking-wide">
              Drafts service unreachable — list may be stale.
            </div>
          )}
          {count === 0 && !unreachable && (
            <div className="px-4 py-6 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wide">
              No drafts held. Use the Draft Action button on the PULSE Risk Board to queue one.
            </div>
          )}
          {count > 0 && (
            <ul className="max-h-[60vh] divide-y divide-[var(--color-border)] overflow-y-auto">
              {drafts.map((d) => (
                <li key={d.draft_id} className="p-3">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 font-mono text-[11px] uppercase tracking-widest">
                        <span className="font-semibold text-[var(--color-primary)]">
                          {d.kind?.toUpperCase()}
                        </span>
                        <button
                          type="button"
                          onClick={() => openOnAsset(d)}
                          className="font-semibold text-[var(--color-text)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-primary)]"
                          title="Open this asset on the Risk Board"
                        >
                          {d.asset_id}
                        </button>
                        {d.unit_name && (
                          <span className="text-[var(--color-text-muted)]">· {d.unit_name}</span>
                        )}
                      </div>
                      <div className="mt-1 font-mono text-xs text-[var(--color-text)] tracking-wide">
                        {d.title}
                      </div>
                      <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                        {d.draft_id} · by {d.actor} · {formatDraftAge(d.created_at)}
                        {d.mc_delta_pct != null && (
                          <> · MC +{(d.mc_delta_pct * 100).toFixed(0)}</>
                        )}
                        {d.cost_usd != null && (
                          <> · ${d.cost_usd.toLocaleString("en-US")}</>
                        )}
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => dismiss(d.draft_id)}
                      pending={dismissing === d.draft_id}
                      disabled={!!dismissing}
                      title="Archive this draft (writes an audit row)"
                    >
                      Dismiss
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function formatDraftAge(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    if (!isFinite(t)) return iso;
    const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  } catch {
    return iso;
  }
}

function AlertBadge({ count }: { count: number }) {
  const tone =
    count === 0 ? "muted" :
    count < 3   ? "warning" :
                  "danger";
  const color =
    tone === "muted"   ? "var(--color-text-muted)" :
    tone === "warning" ? "var(--color-warning)" :
                         "var(--color-danger)";
  return (
    <div
      className="flex shrink-0 items-center gap-1 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs uppercase tracking-wider"
      title={`${count} active alert${count === 1 ? "" : "s"}`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style={{ color }}>
        <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />
      </svg>
      <span className="tabular-nums" style={{ color }}>
        {String(count).padStart(2, "0")}
      </span>
    </div>
  );
}

// Air-gap posture toggle. When engaged, the StatusFooter pulses red and any
// mutation goes through the local queue endpoint. When released, the queue
// flushes to the master and the toggle returns to green/connected. Restricted
// to security_manager + mef_commander since toggling air-gap is a posture
// decision, not a routine click. Walkthrough caught a one-click toggle as
// risky — added a confirmation modal so the operator confirms intent.
function AirGapToggle() {
  const role = useSpireStore((s) => s.role);
  const airGap = useSpireStore((s) => s.airGapActive);
  const setAirGap = useSpireStore((s) => s.setAirGap);
  const setQueueDepth = useSpireStore((s) => s.setQueueDepth);
  const pushToast = useSpireStore((s) => s.pushToast);
  const queueDepth = useSpireStore((s) => s.queueDepth);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const allowed = role === "security_manager" || role === "mef_commander";
  if (!allowed) return null;

  // E1 hardening: idempotent commit. Triple-tapping the modal Engage/Release
  // button used to fire three setAirGap mutations; now it fires one and the
  // 250ms lockout swallows the rest.
  const commitAction = useIdempotentAction(
    `topbar:air-gap:${airGap ? "release" : "engage"}`,
    async () => {
      setConfirmOpen(false);
      try {
        const r = await api.system.setAirGap(!airGap, "operator-confirmed");
        setAirGap(r.air_gap_active);
        if (r.air_gap_active) {
          pushToast({ tone: "warn", text: "Air-gap engaged — local writes will be queued", ttlMs: 4000 });
        } else if (r.replayed != null) {
          pushToast({
            tone: "ok",
            text: `Air-gap released — ${r.replayed} queued op${r.replayed === 1 ? "" : "s"} replayed`,
            ttlMs: 5000,
          });
          setQueueDepth(0);
        }
      } catch (e) {
        pushToast({ tone: "error", text: `Air-gap toggle failed: ${formatApiError(e)}` });
      }
    },
  );

  return (
    <>
      {/* E1: composes <Button> for consistent touch target (44×44 floor) +
       * focus ring; status dot + colour palette stays unique to this chrome. */}
      <Button
        variant="secondary"
        size="md"
        onClick={() => setConfirmOpen(true)}
        title={airGap ? "Air-gap engaged — click to release and replay queued ops" : "Click to engage air-gap mode (confirm required)"}
        className={clsx(
          "shrink-0 px-2.5 text-xs tracking-wider",
          airGap
            ? "border-[var(--color-danger)] bg-[color-mix(in_oklab,var(--color-danger-muted)_25%,transparent)] text-[var(--color-danger)]"
            : "border-[var(--color-border)] bg-transparent text-[var(--color-text-secondary)]",
        )}
        leadingIcon={
          <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
            {airGap && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-danger)] opacity-60" />
            )}
            <span
              className="relative inline-flex h-2 w-2 rounded-full"
              style={{ background: airGap ? "var(--color-danger)" : "var(--color-success)" }}
            />
          </span>
        }
      >
        AIR-GAP{airGap ? " ON" : ""}
      </Button>
      {confirmOpen && (
        <div
          className="fixed inset-0 z-[8800] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setConfirmOpen(false)}
          role="presentation"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="m-4 max-w-md rounded-md border border-[var(--color-warning)] bg-[var(--color-surface)] p-5 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="airgap-confirm-title"
          >
            <div id="airgap-confirm-title" className="font-mono text-xs uppercase text-[var(--color-warning)] tracking-widest">
              {airGap ? "Release air-gap" : "Engage air-gap"}
            </div>
            <h2 className="mt-1 font-sans text-lg font-semibold text-[var(--color-text)]">
              {airGap ? "Replay queued ops and reconnect?" : "Cut outbound writes and queue locally?"}
            </h2>
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
              {airGap
                ? `Releasing will replay ${queueDepth} queued operation${queueDepth === 1 ? "" : "s"} to the upstream node and resume normal sync. Conflicts surface in Node Status as vector-clock pairs.`
                : "Engaging will route every mutation to the local queue. SPIRE keeps operating, but partner nodes won't see your writes until release. Use during simulated SATCOM loss or real comms-degraded posture."}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="warning"
                onClick={() => commitAction.run()}
                pending={commitAction.pending}
              >
                {airGap ? "Release" : "Engage"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Track-G3 density toggle. Two modes:
//   • Dense  — current staff layout, more columns, tighter padding.
//   • Sparse — field/iPad layout, larger tap targets, bigger type, fewer
//     columns. Persisted per role in localStorage via the Zustand slice.
//
// Rendered as a compact pill dropdown to match the existing chrome rhythm.
// GcssMcSyncPill — last-sync indicator for the GCSS-MC reference adapter
// (Wave-1 lane #27). Polls /api/integrations/gcss-mc/last-sync every 7s
// and shows "GCSS-MC · synced 14s ago". Click navigates to the integration
// contract page so a judge can drill from "is the data fresh?" to "what
// is the contract?" in one click.
//
// The indicator is intentionally low-contrast — the connection is mocked
// (REFERENCE IMPLEMENTATION), so it must not read as a green production-
// quality "everything is healthy" sticker. The label "REF" suffix and
// the muted slate styling keep it honest.
function GcssMcSyncPill() {
  const nav = useNavigate();
  const [age, setAge] = useState<number | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const r = await api.system.gcssMcLastSync();
        if (cancelled) return;
        setAge(r.age_seconds);
        setUnreachable(false);
      } catch {
        if (cancelled) return;
        setUnreachable(true);
      } finally {
        if (!cancelled) timer = setTimeout(tick, 7000);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const label = unreachable
    ? "GCSS-MC · STALE"
    : age == null
      ? "GCSS-MC · syncing…"
      : `GCSS-MC · ${formatAge(age)}`;

  const tone = unreachable ? "var(--color-warning)" : "var(--color-text-secondary)";
  const dot = unreachable ? "var(--color-warning)" : "var(--color-success)";

  return (
    <Pressable
      onClick={() => nav("/integrations/gcss-mc")}
      block={false}
      aria-label={`${label} — open GCSS-MC integration contract`}
      title={`${label}. Reference implementation — mocked link to GCSS-MC. Click to open the adapter contract.`}
      className="!min-h-0 flex h-11 shrink-0 items-center gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 font-mono text-[10px] uppercase tracking-widest hover:border-[var(--color-primary)]"
    >
      <span
        className="relative inline-flex h-2 w-2"
        aria-hidden
      >
        <span
          className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-50"
          style={{ background: dot }}
        />
        <span
          className="relative inline-flex h-2 w-2 rounded-full"
          style={{ background: dot }}
        />
      </span>
      <span style={{ color: tone }}>{label}</span>
      <span
        className="rounded-sm border px-1 text-[9px] font-semibold tracking-widest"
        style={{
          borderColor: "color-mix(in oklab, var(--color-warning) 45%, var(--color-border))",
          color: "var(--color-warning)",
          background: "color-mix(in oklab, var(--color-warning-muted) 15%, transparent)",
        }}
        title="Reference Implementation — connection is mocked"
      >
        REF
      </span>
    </Pressable>
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `synced ${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `synced ${m}m ago`;
  const h = Math.floor(m / 60);
  return `synced ${h}h ago`;
}

function DensityToggle() {
  const density = useSpireStore((s) => s.density);
  const setDensity = useSpireStore((s) => s.setDensity);
  const next: Density = density === "dense" ? "sparse" : "dense";
  // Label = CURRENT state, not the next one. Reviewer caught the prior
  // build appearing to show the destination state ("DENSE" while currently
  // sparse, click to swap). Visible text always reflects the live store
  // value; the click action is described in the tooltip.
  const currentLabel = density === "dense" ? "DENSE" : "SPARSE";
  const nextLabel = next === "dense" ? "DENSE" : "SPARSE";
  return (
    <Button
      variant="secondary"
      size="md"
      onClick={() => setDensity(next)}
      aria-label={`Information density: currently ${currentLabel}. Click to switch to ${nextLabel}.`}
      title={`Currently ${currentLabel}. Click to switch to ${nextLabel}.`}
      className="px-2.5 text-xs tracking-wider border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-secondary)]"
      leadingIcon={
        <span aria-hidden className="text-[var(--color-text-muted)]">
          {density === "dense" ? "▦" : "▤"}
        </span>
      }
    >
      {currentLabel}
    </Button>
  );
}

// "Push to Joint COP" — opens the OMS/UCI sister-service viewer in a new
// tab. Visible to roles that can release a SECRET//REL bundle (i.e. the
// roles whose clearance gate can satisfy the joint export endpoint). For
// other roles the button is hidden so we don't tease an action that would
// just spawn a tab full of "InsufficientClearance."
function PushToJointButton({ role }: { role: Role }) {
  const allowed = role === "security_manager" || role === "mef_commander" || role === "data_custodian";
  if (!allowed) return null;
  function openPartner() {
    // HashRouter: deep links use the #/ prefix.
    const url = new URL(window.location.href);
    url.hash = "#/joint/preview";
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }
  return (
    <Button
      variant="secondary"
      size="md"
      onClick={openPartner}
      aria-label="Push current SPIRE state to the Joint COP partner viewer (opens in a new tab)"
      title="Push to Joint COP — opens the sister-service OMS/UCI viewer in a new tab"
      className="hidden xl:inline-flex px-2.5 text-xs tracking-wider border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_10%,var(--color-surface))] text-[var(--color-primary)] hover:bg-[color-mix(in_oklab,var(--color-primary)_18%,var(--color-surface))]"
      leadingIcon={
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12h14" />
          <path d="M13 5l7 7-7 7" />
        </svg>
      }
    >
      JOINT COP
    </Button>
  );
}

// Task #25 — Reset-to-clean-demo affordance.
//
// Shark Tank cycles through the demo multiple times: practice, dry-run,
// judges. Without a one-click reset the presenter has to re-seed by
// hand, which means the next pass starts at a non-deterministic state
// (alerts left acked, simulator triggered, air-gap maybe still on).
//
// Hidden for every role except the demo operator (g4) — the identity
// the presenter signs in as. The backend gate (`require_role` against
// {"g4"}) is the truth source; this visibility check is UX hygiene so
// other roles don't see a button they can't use.
//
// `<DangerButton confirm="modal">` matches the AirGapToggle precedent
// for one-keystroke confirms on truly destructive actions, and the
// idempotent action wrapper prevents a triple-tap from firing three
// resets back-to-back. The reset itself returns in well under the
// 3-second budget the task calls for (it's a memory wipe + re-seed of
// in-process state, not a full dataset regeneration — the dataset is
// already deterministic under seed 42 from boot, never mutated at
// runtime, so the next pass is bit-identical without re-running the
// 30–60 s synthetic generator).
function ResetDemoButton() {
  const role = useSpireStore((s) => s.role);
  const setAlertCount = useSpireStore((s) => s.setAlertCount);
  const setAirGap = useSpireStore((s) => s.setAirGap);
  const setQueueDepth = useSpireStore((s) => s.setQueueDepth);
  const pushToast = useSpireStore((s) => s.pushToast);
  const nav = useNavigate();

  // Hook order must be stable across renders, so the visibility check
  // moved BELOW every hook call. The component still renders nothing for
  // non-operator roles — but every hook is called every render.
  const action = useIdempotentAction(
    "topbar:reset-demo",
    async () => {
      try {
        const r = await api.system.resetDemo();
        // Mirror the wiped state into the local store so the chrome doesn't
        // briefly re-render with stale alert counts / air-gap chrome.
        // (Even on partial failure, these store fields reflect the steps
        // that DID succeed: air-gap + queue clears are unconditional.)
        setAlertCount(0);
        setAirGap(false);
        setQueueDepth(0);
        const seconds = (r.duration_ms / 1000).toFixed(2);
        if (r.ok) {
          pushToast({
            tone: "ok",
            text: `SPIRE reset to clean demo state in ${seconds}s — alerts cleared, simulator reset, mission clock at H+0.`,
            ttlMs: 5000,
          });
        } else {
          // Partial reset (HTTP 207). Surface which steps failed so the
          // presenter knows whether to retry or push past it.
          const stepNames = r.failed_steps.map((s) => s.step).join(", ") || "unknown";
          pushToast({
            tone: "warn",
            text: `Demo reset partial (${seconds}s) — ${r.failed_steps.length} step${r.failed_steps.length === 1 ? "" : "s"} failed: ${stepNames}. Other state was reset; try once more or proceed.`,
            ttlMs: 9000,
          });
        }
        // Land back on the hero dashboard so the next demo pass starts
        // at the canonical entry surface — even on partial failure, the
        // operator wants to see the post-reset surface.
        nav("/", { replace: true });
      } catch (e) {
        pushToast({
          tone: "error",
          text: `Reset failed: ${formatApiError(e)}`,
        });
      }
    },
    { lockoutMs: 750 },
  );

  // Operator role only. Other roles never see the affordance.
  if (role !== "g4") return null;

  return (
    <DangerButton
      size="md"
      confirm="modal"
      modalPrompt={
        "Reset SPIRE to clean demo state — clears alerts, restarts mission " +
        "clock, re-seeds simulator. Continue?"
      }
      pending={action.pending}
      onConfirm={() => action.run()}
      title="Return SPIRE to a known t=0 demo state (operator-only)"
      aria-label="Reset SPIRE to clean demo state"
      className="shrink-0 px-2.5 text-xs tracking-wider"
      leadingIcon={
        // Counter-clockwise arrow — the universal "reset to start" glyph.
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <polyline points="3 4 3 10 9 10" />
        </svg>
      }
    >
      {action.pending ? "RESETTING…" : "RESET DEMO"}
    </DangerButton>
  );
}
