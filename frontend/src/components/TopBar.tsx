import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { ROLE_LABELS, useSpireStore, VIEW_SCOPE, type Density, type Role, type User } from "../state/store";
import { api, type AuthUser } from "../api";
import { formatApiError } from "../api-retry";
import { MissionClock } from "./MissionClock";
import { CommsControl } from "./CommsControl";
import { SystemStatusChip } from "./SystemStatusChip";
import { StageCluster } from "./StageCluster";
import { NotificationsChip } from "./NotificationsChip";
import { Button, Pressable, useIdempotentAction } from "./ui";

type Tab = { to: string; label: string; restrict: Role | null };

// Operator chrome — the historical nav. ADMIN is privileged-only and
// stays gated to security_manager.
const OPERATOR_TABS: Tab[] = [
  { to: "/sentry",  label: "SENTRY",  restrict: null },
  { to: "/pulse",   label: "PULSE",   restrict: null },
  { to: "/bastion", label: "BASTION", restrict: null },
  { to: "/admin",   label: "ADMIN",   restrict: "security_manager" as Role },
];

// MDM 2026 stage-pivot — when `stageMode` is on, the primary nav spine
// is the four hero use-cases (SENTRY/PULSE/BASTION/DHA RESCUE), no
// ADMIN. The AUDIT pill on the right of the bar still routes the
// presenter to /admin/audit for the closing beat, but the privileged
// ADMIN landing surface is intentionally not exposed as a tab on stage
// so the audience sees the four-module spine and nothing else.
const STAGE_TABS: Tab[] = [
  { to: "/sentry",     label: "SENTRY",     restrict: null },
  { to: "/pulse",      label: "PULSE",      restrict: null },
  { to: "/bastion",    label: "BASTION",    restrict: null },
  { to: "/dha-rescue", label: "DHA RESCUE", restrict: null },
];

// Friendly per-tab list of authorized roles for the out-of-scope tooltip.
function authorizedRolesFor(path: string, role: Role): { allowed: boolean; allowedRoles: Role[] } {
  const scope = VIEW_SCOPE[path];
  if (!scope) return { allowed: true, allowedRoles: [] };
  return { allowed: scope.includes(role), allowedRoles: scope };
}

export function TopBar() {
  // operatingMode + alertCount are still surfaced — they migrated into
  // SystemStatusChip and (for the stage backstop) the standalone
  // AlertBadge below, but we still need to read them for the destructure.
  const { role, alertCount, currentUser, stageMode } = useSpireStore();

  return (
    // Walkthrough audit (#36 from the in-app feedback drawer): the
    // MissionClock dropdown was being clipped by view content because
    // the centered MissionClock wrapper one level down uses
    // `-translate-x-1/2 -translate-y-1/2` which creates a CSS stacking
    // context. The dropdown's z-[8500] is therefore scoped to that
    // transformed wrapper, not the document — so StatusStrip + view
    // content (which paint later in DOM order) covered it. Lifting the
    // whole TopBar to z-[60] keeps it above StatusStrip / view content
    // while staying well below toasts (z-[8900-9100]), modals
    // (z-[8800]), and banner strips so those still cover the bar.
    <header data-testid="topbar-root" className="relative z-[60] h-14 shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      {/* Thin horizon accent below the top bar */}
      <div
        className="pointer-events-none absolute inset-x-0 -bottom-px h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent 0%, color-mix(in oklab, var(--color-primary) 40%, transparent) 12%, color-mix(in oklab, var(--color-primary) 40%, transparent) 88%, transparent 100%)",
        }}
      />
      <div className="relative flex h-full min-w-0 items-center justify-between gap-3 px-4">
        {/* MissionClock owns the centred region — full clock at xl+ only.
         * Below xl, the right group renders a CompactMissionClock at lg/md
         * and (at sm) the System chip dropdown's Mission timeline row is
         * the fallback. Absolute-positioned so it claims the geometric
         * centre without fighting the flex justify-between layout. */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 xl:block">
          <MissionClock />
        </div>
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex min-w-0 shrink items-center gap-2.5">
            <SpireMark />
            <div className="flex min-w-0 flex-col leading-none">
              <span
                className="font-mono text-lg font-semibold tracking-[0.2em] text-[var(--color-text)]"
                style={{ fontFeatureSettings: "'ss01'" }}
              >
                SPIRE
              </span>
              {/* Tagline truncates instead of pushing the right group on
               * narrow viewports. min-w-0 on the parent column lets the
               * truncate take effect inside the flex row. */}
              <span
                className="mt-[3px] hidden min-w-0 max-w-[14rem] truncate font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest lg:block"
                title="Contested Logistics"
              >
                Contested Logistics
              </span>
            </div>
          </div>
          <nav className="flex shrink-0 items-center gap-0">
            {(stageMode ? STAGE_TABS : OPERATOR_TABS)
              // ADMIN remains hidden when the role isn't security_manager
              // (it's a privileged surface, not a teaser). Other tabs render
              // even out of scope so operators can see what exists, but they
              // get the disabled treatment + tooltip.
              // Stage mode swaps ADMIN for DHA RESCUE so the four-module
              // spine matches the Decision Bridge tile order.
              .filter((t) => t.restrict == null || t.restrict === role)
              .map((tab) => {
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
                      {/* Tab numerals removed in TopBar declutter — the
                       * "01/02/03" prefix added decoration that the spec
                       * called noise. Module identity is carried by the
                       * label itself. */}
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
                        {/* Tab numerals dropped — see disabled-tab branch. */}
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

        {/* TopBar declutter (Task #184) — the right group is the stable
         * spine. Operator mode condenses the old 6-pill cluster
         * (NodeStatus + GcssMcSync + AirGap + Density + ModeBadge +
         * Drafts/Alerts) into 3 group-chips:
         *   • SystemStatusChip  — sync · gcss · backend mode + drawer
         *   • NotificationsChip — drafts + alerts (with tabbed dropdown)
         *   • IdentityPill      — now also hosts Air-gap, Density and a
         *                         comms posture summary in its dropdown
         * CommsControl stays inline because the comms posture is safety-
         * critical and an operator should not have to open a menu to see
         * the current posture. PushToJoint stays at xl+ where there is
         * room for the dedicated CTA.
         *
         * Stage mode replaces operator chrome with StageCluster (Failsafe
         * + Reset + Audit) and keeps the AlertBadge backstop so a stage
         * presenter sees the alert count even with the dropdown closed. */}
        <div className="flex min-w-0 shrink items-center gap-2 overflow-hidden">
          {/* CompactMissionClock for the cramped 1024–1279px range — the
           * full centred MissionClock only renders at xl+. At sm the
           * System chip dropdown's Mission timeline row is the fallback. */}
          {!stageMode && (
            <span className="hidden md:inline-flex xl:hidden">
              <MissionClock compact />
            </span>
          )}
          {!stageMode && <SystemStatusChip />}
          <CommsControl />
          {!stageMode && <PushToJointButton role={role} />}
          {!stageMode && <NotificationsChip />}
          {stageMode && (
            <span className="hidden md:inline-flex xl:hidden">
              <MissionClock compact />
            </span>
          )}
          {stageMode && <StageCluster />}
          {/* MDM 2026 stage-pivot — multi-presenter handoff (WP-8). The
           * 4-up chip strip sits inline with the right group only in
           * stage mode and offers one-click identity swaps so the next
           * presenter can take the mic without re-PINning. */}
          {stageMode && <IdentityChips currentDodid={currentUser?.dodid ?? null} />}
          <IdentityPill user={currentUser} role={role} />
          {/* Stage-mode AlertBadge backstop — keeps the urgent count
           * visible without requiring the presenter to open the
           * NotificationsChip (which doesn't render in stage). */}
          {stageMode && <AlertBadge count={alertCount} />}
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
// MDM 2026 stage-pivot — single-purpose AUDIT chip rendered in the
// TopBar right group only when the store is in `stageMode`. The host
// uses this to drop into `/admin/audit` after the BASTION beat, so the
// audience sees the hash-chained record was being written the whole
// time. The actual scope check on AuditView is bypassed in stage mode
// (any role can land on the page) — see AuditView.
function IdentityChips({ currentDodid }: { currentDodid: string | null }) {
  const [users, setUsers] = useState<AuthUser[] | null>(null);
  const [busyDodid, setBusyDodid] = useState<string | null>(null);
  const nav = useNavigate();
  const signIn = useSpireStore((s) => s.signIn);
  const pushToast = useSpireStore((s) => s.pushToast);

  // Fetch the cert directory once on mount. Quiet-fail (just hide the
  // strip) if it errors — IdentityPill is still available for swaps.
  useEffect(() => {
    let cancelled = false;
    // `directory()` is the post-login variant of /auth/users that returns
    // the full AuthUser shape (role, billet, last_name) — the chips need
    // last_name + billet to render and `swap` posts the role-aware login.
    api.auth.directory()
      .then((r) => { if (!cancelled) setUsers(r.users); })
      .catch(() => { if (!cancelled) setUsers([]); });
    return () => { cancelled = true; };
  }, []);

  if (!users || users.length === 0) return null;

  async function swap(target: AuthUser) {
    if (busyDodid) return;
    if (target.dodid === currentDodid) return;
    setBusyDodid(target.dodid);
    try {
      let u;
      try {
        const qr = await api.auth.quickSwitch(target.dodid);
        u = qr.user;
      } catch {
        const r = await api.auth.login(target.dodid, "000000");
        u = r.user;
      }
      signIn({
        dodid: u.dodid, name: u.name, first_name: u.first_name, last_name: u.last_name,
        rank: u.rank, rank_long: u.rank_long, billet: u.billet, unit: u.unit,
        parent_command: u.parent_command, branch: u.branch, clearance: u.clearance,
        role: u.role, initials: u.initials, cert_issuer: u.cert_issuer,
        cert_serial: u.cert_serial, cert_expires: u.cert_expires,
      });
      pushToast({
        tone: "ok",
        text: `Signed in as ${u.rank} ${u.last_name} · ${ROLE_LABELS[u.role as Role]}`,
        ttlMs: 3500,
      });
      // Always land on Decision Bridge so the new role's permissions
      // resolve cleanly (matches IdentityPill behaviour).
      nav("/", { replace: true });
    } catch (e) {
      pushToast({ tone: "error", text: `Identity switch failed: ${formatApiError(e)}` });
    } finally {
      setBusyDodid(null);
    }
  }

  return (
    <div
      className="hidden lg:inline-flex shrink-0 items-center gap-1 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5"
      role="group"
      aria-label="Stage presenter handoff"
    >
      {users.map((u) => {
        const active = u.dodid === currentDodid;
        const busy = busyDodid === u.dodid;
        return (
          <Pressable
            key={u.dodid}
            onClick={() => swap(u)}
            block={false}
            disabled={active || !!busyDodid}
            aria-label={`Switch to ${u.rank} ${u.last_name} · ${ROLE_LABELS[u.role as Role] ?? u.role}`}
            aria-pressed={active}
            title={`${u.rank} ${u.last_name} · ${ROLE_LABELS[u.role as Role] ?? u.role}${active ? " (active)" : ""}`}
            className={
              "!min-h-0 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm px-2 font-mono text-[10px] uppercase tracking-widest transition-colors " +
              (active
                ? "border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_20%,var(--color-surface))] text-[var(--color-text)]"
                : "border border-transparent text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]")
            }
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{
                background: active ? "var(--color-primary)" : "var(--color-text-muted)",
                boxShadow: active ? "0 0 6px var(--color-primary)" : undefined,
              }}
              aria-hidden
            />
            <span className="font-mono tabular-nums">{u.initials}</span>
            <span className="hidden xl:inline truncate max-w-[6rem]">{u.last_name}</span>
            {busy && (
              <span className="ml-1 font-mono text-[9px] text-[var(--color-text-muted)]">…</span>
            )}
          </Pressable>
        );
      })}
    </div>
  );
}

function IdentityPill({ user, role }: { user: User | null; role: Role }) {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  // MDM 2026 stage-pivot — when the session is in stage mode the
  // identity-swap menu prefers the additive `quick-switch` endpoint
  // over the PIN login path. quick-switch re-issues the cookie without
  // requiring a 6-digit PIN, so the on-stage swap is one click. If the
  // backend doesn't have the env var enabled the call 404s and we fall
  // back to the existing login(target.dodid, "000000") path.
  const stageMode = useSpireStore((s) => s.stageMode);
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
      // Stage mode → try the no-PIN quick-switch first. If the backend
      // 404s (env var off, or older deploy), fall through to the
      // any-6-digit-PIN login path so the presenter still gets a swap.
      // Operator (non-stage) sessions go straight to login() — they
      // shouldn't even know quick-switch exists.
      let u;
      if (stageMode) {
        try {
          const qr = await api.auth.quickSwitch(target.dodid);
          u = qr.user;
        } catch {
          const r = await api.auth.login(target.dodid, "000000");
          u = r.user;
        }
      } else {
        const r = await api.auth.login(target.dodid, "000000");
        u = r.user;
      }
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
        data-testid="topbar-identity-pill"
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
           * bar; these menu items are the in-app, one-click entry.
           *
           * MDM 2026 stage-pivot — suppressed in stage mode. The four
           * hero use-case tabs are the only nav surface during the 8-min
           * stage demo; /pitch and /demo are operator/dev affordances
           * that would muddy the on-stage choice surface. */}
          {!stageMode && <div className="border-b border-[var(--color-border)] py-1">
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
          </div>}

          {/* Operator settings — TopBar declutter (Task #184). The Air-gap
           * toggle, density preference, and comms-posture summary used to
           * each have their own pill in the right group. They're now
           * scoped to this menu so the bar stays tight without losing the
           * operator-only controls. AirGapToggle keeps its own role gate
           * (returns null for roles that can't engage), so the section's
           * header may sit above just Density + Comms for some operators.
           * Hidden in stage mode (the cluster runs the show). */}
          {!stageMode && (
            <OperatorSettingsSection role={role} />
          )}

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

// PushToJointButton — opens the OMS/UCI sister-service viewer in a new
// tab. Visible to roles that can release a SECRET//REL bundle. Other
// roles don't see it so we don't tease an InsufficientClearance gate.
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



/**
 * OperatorSettingsSection — embedded inside IdentityPill's dropdown.
 *
 * Holds the three controls that used to be standalone chips in the right
 * group:
 *   - Air-gap toggle (security_manager / mef_commander only)
 *   - Information-density radio (Dense / Sparse, all roles)
 *   - Comms posture summary — read-only, points at CommsControl chip
 *
 * The Air-gap toggle preserves its confirm-modal flow (the underlying
 * setAirGap API requires a reason and the toast logs the engage/release
 * for the SOC view). Density flips locally and persists to localStorage.
 */
function OperatorSettingsSection({ role }: { role: Role }) {
  const airGapAllowed = role === "security_manager" || role === "mef_commander";
  const airGap = useSpireStore((s) => s.airGapActive);
  const setAirGap = useSpireStore((s) => s.setAirGap);
  const setQueueDepth = useSpireStore((s) => s.setQueueDepth);
  const queueDepth = useSpireStore((s) => s.queueDepth);
  const pushToast = useSpireStore((s) => s.pushToast);
  const density = useSpireStore((s) => s.density);
  const setDensity = useSpireStore((s) => s.setDensity);
  const ddilMode = useSpireStore((s) => s.ddilMode);
  const [airGapConfirm, setAirGapConfirm] = useState(false);

  const airGapAction = useIdempotentAction(
    `topbar:air-gap:${airGap ? "release" : "engage"}`,
    async () => {
      setAirGapConfirm(false);
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
    <div
      className="border-b border-[var(--color-border)] py-1"
      data-testid="identity-operator-settings"
    >
      <div className="px-4 pt-2 pb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        Operator settings
      </div>

      {airGapAllowed && (
        <div className="flex items-center justify-between gap-3 px-4 py-1.5">
          <div className="flex min-w-0 flex-col">
            <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-secondary)]">
              Air-gap
            </span>
            <span className="font-mono text-[10px] tracking-wider text-[var(--color-text-muted)]">
              {airGap
                ? `Engaged · ${queueDepth} op${queueDepth === 1 ? "" : "s"} queued`
                : "Released · writes pass through"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setAirGapConfirm(true)}
            data-testid="identity-airgap-toggle"
            className={clsx(
              "shrink-0 rounded-sm border px-2 py-1 font-mono text-[11px] uppercase tracking-widest transition-colors",
              airGap
                ? "border-[var(--color-danger)] bg-[color-mix(in_oklab,var(--color-danger-muted)_25%,transparent)] text-[var(--color-danger)]"
                : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)]",
            )}
            aria-pressed={airGap}
            aria-label={airGap ? "Release air-gap" : "Engage air-gap"}
            title={airGap ? "Release air-gap and replay queued ops" : "Engage air-gap (confirm required)"}
          >
            {airGap ? "ENGAGED" : "RELEASE"}
          </button>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 px-4 py-1.5">
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-secondary)]">
            Density
          </span>
          <span className="font-mono text-[10px] tracking-wider text-[var(--color-text-muted)]">
            {density === "dense" ? "Staff layout — more columns" : "Field layout — bigger tap targets"}
          </span>
        </div>
        <div
          role="radiogroup"
          aria-label="Information density"
          className="flex shrink-0 overflow-hidden rounded-sm border border-[var(--color-border)]"
        >
          {(["dense", "sparse"] as Density[]).map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={density === d}
              onClick={() => setDensity(d)}
              data-testid={`identity-density-${d}`}
              className={clsx(
                "px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors",
                density === d
                  ? "bg-[color-mix(in_oklab,var(--color-primary)_18%,var(--color-surface))] text-[var(--color-primary)]"
                  : "bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
              )}
            >
              {d === "dense" ? "Dense" : "Sparse"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 px-4 py-1.5">
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-secondary)]">
            Comms posture
          </span>
          <span className="font-mono text-[10px] tracking-wider text-[var(--color-text-muted)]">
            Change posture from the COMMS chip in the top bar.
          </span>
        </div>
        <span
          className="shrink-0 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[10px] tabular-nums uppercase tracking-widest text-[var(--color-text-secondary)]"
          aria-live="polite"
        >
          {ddilMode}
        </span>
      </div>

      {airGapConfirm && (
        <div
          className="fixed inset-0 z-[8800] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => !airGapAction.pending && setAirGapConfirm(false)}
          role="presentation"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="m-4 max-w-md rounded-md border border-[var(--color-warning)] bg-[var(--color-surface)] p-5 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="airgap-id-confirm-title"
          >
            <div id="airgap-id-confirm-title" className="font-mono text-xs uppercase text-[var(--color-warning)] tracking-widest">
              {airGap ? "Release air-gap" : "Engage air-gap"}
            </div>
            <h2 className="mt-1 font-sans text-lg font-semibold text-[var(--color-text)]">
              {airGap ? "Replay queued ops and reconnect?" : "Cut outbound writes and queue locally?"}
            </h2>
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
              {airGap
                ? `Releasing will replay ${queueDepth} queued operation${queueDepth === 1 ? "" : "s"} to the upstream node and resume normal sync. Conflicts surface in System chip as vector-clock pairs.`
                : "Engaging will route every mutation to the local queue. SPIRE keeps operating, but partner nodes won't see your writes until release."}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setAirGapConfirm(false)}>
                Cancel
              </Button>
              <Button
                variant="warning"
                onClick={() => airGapAction.run()}
                pending={airGapAction.pending}
              >
                {airGap ? "Release" : "Engage"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
