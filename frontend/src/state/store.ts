import { create } from "zustand";

export type Role =
  | "maintenance_chief"
  | "g4"
  | "mef_commander"
  | "data_custodian"
  | "security_manager";

export type OperatingMode = "full" | "lite";
export type ToastTone = "ok" | "info" | "warn" | "error";

// Information-density mode. `dense` is the existing staff layout (more
// columns, tighter padding, smaller type). `sparse` bumps font tiers, pads
// cards, hides decorative columns — for Marines on iPads in motor pools
// where tap targets and breathing room matter more than info per square inch.
export type Density = "dense" | "sparse";

// CAC/PIV identity payload. Matches `backend/auth.MOCK_USERS` shape — the
// load-bearing contract every Wave 1 lane reads. Additions only, no
// renames: once a downstream lane pins against a field name it stays.
export interface User {
  dodid: string;
  name: string;
  first_name: string;
  last_name: string;
  rank: string;
  rank_long?: string;
  billet: string;
  unit: string;
  parent_command?: string;
  branch: string;
  clearance: string;
  role: Role;
  initials: string;
  cert_issuer?: string;
  cert_serial?: string;
  cert_expires?: string;
}

export interface Toast {
  id: string;
  tone: ToastTone;
  text: string;
  // Optional "undo" lane — when present, rendered as a button that resolves the action.
  undo?: { label: string; onUndo: () => void };
  // Optional click-through link — rendered as an external-opening anchor.
  link?: { label: string; href: string };
  ttlMs?: number;
}

export type CommsState = "CONNECTED" | "DEGRADED" | "DISCONNECTED";

// DDIL mode (Disconnected, Degraded, Intermittent, Limited) — operator-
// controlled simulation that drives the API client interceptor. CONNECTED is
// the steady state and a passthrough; the other three each apply distinct
// effects (latency / loss / queue+cache). Distinct from `commsState` (which
// reflects backend-truth link health) and from `airGapActive` (a server-side
// posture toggle gated to security_manager). DDIL is local theater — it
// never reaches the backend, so it works in any operator role and is safe
// to stamp at will during demos / drills.
export type DdilMode = "CONNECTED" | "LIMITED" | "INTERMITTENT" | "DISCONNECTED";

export interface DdilQueuedWrite {
  id: string;
  method: string;
  path: string;
  body?: unknown;
  queuedAt: string;
  actor: string;
}

export interface SpireState {
  // CAC/PIV identity — null until the operator clears the cert-selection
  // splash. Every Wave 1 lane reads from here. `role` mirrors
  // `currentUser.role` and exists for backward-compat with views that
  // already destructure `role` directly.
  currentUser: User | null;
  role: Role;
  operatingMode: OperatingMode;
  alertCount: number;
  // Severity breakdown for the TopBar badge tooltip and any other consumer
  // that wants to render `30 open alerts (HIGH: 3, MODERATE: 12, INFO: 15)`.
  // Always backend-truth — set by whoever last polled `/bastion/alerts`.
  alertSeverityCounts: Record<string, number>;
  // Drill-from-alert handoff. The alert column writes the unit / building
  // it wants the map to focus on; MapCanvas reads via the BastionView
  // wiring (selectedUnit + flyToBuilding). The store version exists so a
  // future cross-view drill can survive role / view changes.
  //
  // selectedUnitId and selectedBuildingId are independent — an operator
  // commonly wants both ("unit X currently in building Y"). They are NOT
  // modelled as mutually exclusive; the alert-target resolver and the
  // direct building-click handler each write only the building field.
  selectedUnitId: string | null;
  selectedBuildingId: string | null;

  // SENTRY batch context — hoisted out of SentryView local state so that
  // switching operator role via the TopBar dropdown (which unmounts the
  // view) no longer nukes the in-flight batch.
  sentryBatchId: string | null;
  sentryJobId: string | null;

  // Cross-tab selection (Risk Board → Cannibalization, Heatmap → Risk Board, …).
  selectedAssetId: string | null;

  // FPCON indicator. BRAVO is the steady state; a ThermalHawk sim temporarily
  // escalates to CHARLIE for the duration of the incident.
  fpcon: "NORMAL" | "ALPHA" | "BRAVO" | "CHARLIE" | "DELTA";

  // GC-7 Air-gap deployment mode — comms-state + queue depth for the
  // StatusFooter pulse + TopBar toggle.
  commsState: CommsState;
  airGapActive: boolean;
  queueDepth: number;

  // B4 Mission clock + scenario timeline. Single source of truth for "what
  // time is it in the war game" — every view that wants to render a
  // phase-aware overlay reads from here. Hydrated by `<MissionClock>` at
  // 1Hz (4Hz when running fast). The clock element is the only writer.
  scenarioRunning: boolean;
  scenarioRate: number;
  scenarioOffsetMin: number;
  scenarioOffsetLabel: string;
  scenarioPhase: string;
  scenarioMaxOffsetMin: number;
  scenarioFiredEventIds: string[];

  // W1 DDIL dramatization. Operator-controlled simulation; client-side only.
  // The API client interceptor reads `ddilMode` and applies latency / loss /
  // queue+cache effects. Pending writes accumulate in `ddilQueue` while
  // DISCONNECTED; cached GET responses live in `ddilCache` so DISCONNECTED
  // reads can serve from last-known-good with a stale-data badge.
  ddilMode: DdilMode;
  ddilQueue: DdilQueuedWrite[];
  ddilCache: Record<string, { body: unknown; cachedAt: number }>;
  ddilSyncing: boolean;
  ddilLastSyncAt: number | null;
  ddilDrillActive: boolean;
  // Last cache hit served to a caller while DISCONNECTED. Used by the
  // DDIL freshness badge so the operator can see at a glance how stale
  // the data on screen actually is ("cached from H+xx:xx, n minutes
  // stale" per the W1 brief).
  ddilLastCacheHit: { key: string; cachedAt: number; servedAt: number } | null;

  // PULSE Risk Board "Draft Action" queue refresh nonce. The TopBar
  // drafts badge polls /pulse/drafts on an interval, but the operator
  // expects the count to bump immediately after they hit Draft this in
  // the modal. Bumping this counter triggers an extra fetch in the
  // badge's effect — cheaper than wiring a custom event bus.
  draftsRefreshTick: number;

  // Toast queue.
  toasts: Toast[];

  // Track-G3 — density toggle. Persisted per role in localStorage.
  density: Density;

  // MDM 2026 stage-pivot. When `stageMode` is true the chrome collapses
  // to the four hero use-case tiles for the 8-min stage demo. Activated
  // via `?stage=1` URL param (hydrated in main.tsx) and persisted to
  // localStorage so a hard reload, a fresh tab, or a popout window all
  // inherit the stage posture. Operator (non-stage) UX is byte-identical
  // when `false`. Cleared by visiting `?stage=0`.
  stageMode: boolean;

  signIn: (user: User) => void;
  signOut: () => void;
  setRole: (r: Role) => void;
  setOperatingMode: (m: OperatingMode) => void;
  setAlertCount: (n: number) => void;
  setAlertSeverityCounts: (counts: Record<string, number>) => void;
  setSelectedUnitId: (id: string | null) => void;
  setSelectedBuildingId: (id: string | null) => void;
  setSentryBatch: (batchId: string | null, jobId: string | null) => void;
  setSelectedAssetId: (id: string | null) => void;
  setFpcon: (level: SpireState["fpcon"]) => void;
  setCommsState: (s: CommsState) => void;
  setAirGap: (active: boolean) => void;
  setQueueDepth: (n: number) => void;
  setScenario: (s: {
    running: boolean;
    rate: number;
    offsetMin: number;
    offsetLabel: string;
    phase: string;
    maxOffsetMin: number;
    firedEventIds: string[];
  }) => void;
  setDdilMode: (m: DdilMode) => void;
  enqueueDdilWrite: (w: Omit<DdilQueuedWrite, "id" | "queuedAt">) => DdilQueuedWrite;
  removeDdilWrite: (id: string) => void;
  clearDdilQueue: () => void;
  cacheDdilRead: (key: string, body: unknown) => void;
  noteDdilCacheHit: (key: string, cachedAt: number) => void;
  setDdilSyncing: (b: boolean) => void;
  setDdilLastSyncAt: (n: number | null) => void;
  setDdilDrillActive: (b: boolean) => void;
  setDensity: (d: Density) => void;
  bumpDraftsRefresh: () => void;
  setStageMode: (b: boolean) => void;
  pushToast: (t: Omit<Toast, "id">) => string;
  dismissToast: (id: string) => void;
}

export const ROLE_LABELS: Record<Role, string> = {
  // Walkthrough caught long forms truncating in the TopBar dropdown at
  // common widths. Marine-shorthand fits without ellipsis; the unit
  // assignment surfaces in the role brief and on the StatusStrip.
  maintenance_chief: "Maint Chief",
  g4: "G-4 / 3d MLR",
  mef_commander: "MEF Commander",
  data_custodian: "Data Custodian",
  security_manager: "Security Mgr",
};

// Where the role dropdown lands each persona on switch. Mapped per the
// adversarial review recommendation: ops roles land on BASTION; Maintenance
// Chief on PULSE Risk Board (cannib + risk first); Data Custodian on the
// SENTRY Upload tab (the start of their pipeline).
//
// Track-G1 — Default panels per role. Lands operators on the surface
// scoped to their job, not the front door of the product. The override
// affordance (TopBar nav) keeps every other surface one click away.
export const ROLE_DEFAULT_VIEW: Record<Role, string> = {
  maintenance_chief: "/pulse/risk",
  g4: "/bastion",
  mef_commander: "/bastion",
  data_custodian: "/sentry/upload",
  security_manager: "/bastion",
};

// Roles expected to have authority on each view. If a role visits a view
// outside this set, the frontend renders an "Out-of-scope" overlay.
// Walkthrough audit: /admin was missing from this map, so the Help
// overlay's role-scope panel didn't list it as a view at all (the row
// for ADMIN never rendered, even for the role that owns it).
export const VIEW_SCOPE: Record<string, Role[]> = {
  // mef_commander added so the Okinawa walk-through can run as a single
  // role: the commander reviews the SENTRY release queue, then PULSE,
  // then BASTION. The data_custodian still owns upload; the security
  // manager still owns release/export (export role gate untouched).
  "/sentry":  ["data_custodian", "security_manager", "mef_commander"],
  "/pulse":   ["maintenance_chief", "g4", "mef_commander"],
  "/bastion": ["mef_commander", "g4", "security_manager", "maintenance_chief"],
  // mef_commander added so MajGen Hayes can drive the full SENTRY → PULSE
  // → BASTION → ADMIN walk-through in one identity (was security_manager-
  // only before). Audit + model-registry follow the same pattern.
  "/admin":   ["security_manager", "mef_commander"],
  "/admin/audit": ["security_manager", "mef_commander"],
  // W1 #30 — Model supply-chain page lives under the admin role gate.
  // Sub-routes inherit the same scope so a deep-linked /admin/models/:id
  // hits the same overlay as bare /admin for non-security_manager.
  "/admin/models": ["security_manager", "mef_commander"],
  // RD9 — real-data ingest dropzone. Scoped to data_custodian +
  // security_manager (matches INGEST_ROLES on the backend).
  // data_custodian doesn't have a demo persona seeded but the scope
  // is left in so a real pilot deployment grants it without code.
  "/admin/ingest": ["security_manager", "data_custodian"],
};

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Density localStorage — single global key. Was per-role keyed, but the
// resulting type-scale flip on every role swap read as "the font is changing
// per role" rather than as a deliberate per-seat preference. One operator,
// one density.
const DENSITY_KEY = "spire.density";
function loadDensity(): Density {
  try {
    const raw = window.localStorage.getItem(DENSITY_KEY);
    if (raw === "dense" || raw === "sparse") return raw;
  } catch {
    /* SSR / private mode tolerant */
  }
  return "dense";
}
function saveDensity(d: Density): void {
  try {
    window.localStorage.setItem(DENSITY_KEY, d);
  } catch {
    /* tolerant */
  }
}

// Stage-mode persistence — localStorage per WP-1 spec, so the stage
// posture survives a fresh tab as well as a hard reload. The presenter
// flips it on once via `?stage=1` in the URL, then any new tab opened
// during the demo (e.g. JointPreview popout) inherits stage mode
// without rerunning the URL hydration. Operator users explicitly clear
// it with `?stage=0`.
const STAGE_KEY = "spire.stageMode";
function loadStageMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STAGE_KEY) === "1";
  } catch {
    return false;
  }
}
function saveStageMode(b: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (b) window.localStorage.setItem(STAGE_KEY, "1");
    else window.localStorage.removeItem(STAGE_KEY);
  } catch {
    /* tolerant */
  }
}

const DEFAULT_ROLE: Role = "mef_commander";

// CAC identity persistence. The signed HttpOnly cookie is the server's
// source of truth; sessionStorage is a same-tab cache so refresh skips an
// extra `/api/auth/me` round-trip and the UI re-paints instantly with the
// previous identity. If the cookie is absent or expired the next /api call
// will 401 and the auth gate redirects back to the cert-selection screen.
const USER_KEY = "spire.currentUser";

function loadUser(): User | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as User;
    if (!parsed || typeof parsed !== "object" || !parsed.dodid || !parsed.role) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveUser(user: User | null): void {
  if (typeof window === "undefined") return;
  try {
    if (user) {
      window.sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    } else {
      window.sessionStorage.removeItem(USER_KEY);
    }
  } catch {
    /* tolerant */
  }
}

const INITIAL_USER: User | null = loadUser();
const INITIAL_ROLE: Role = INITIAL_USER?.role ?? DEFAULT_ROLE;

export const useSpireStore = create<SpireState>((set) => ({
  currentUser: INITIAL_USER,
  role: INITIAL_ROLE,
  operatingMode: "full",
  alertCount: 0,
  alertSeverityCounts: {},
  selectedUnitId: null,
  selectedBuildingId: null,
  sentryBatchId: null,
  sentryJobId: null,
  selectedAssetId: null,
  fpcon: "BRAVO",
  commsState: "CONNECTED",
  airGapActive: false,
  queueDepth: 0,
  scenarioRunning: false,
  scenarioRate: 1,
  scenarioOffsetMin: 0,
  scenarioOffsetLabel: "H+000:00",
  scenarioPhase: "Pre-conflict",
  scenarioMaxOffsetMin: 96 * 60,
  scenarioFiredEventIds: [],
  ddilMode: "CONNECTED",
  ddilQueue: [],
  ddilCache: {},
  ddilSyncing: false,
  ddilLastSyncAt: null,
  ddilDrillActive: false,
  ddilLastCacheHit: null,
  draftsRefreshTick: 0,
  toasts: [],
  density: typeof window !== "undefined" ? loadDensity() : "dense",
  stageMode: typeof window !== "undefined" ? loadStageMode() : false,
  signIn: (user) => {
    saveUser(user);
    set({ currentUser: user, role: user.role });
  },
  signOut: () => {
    saveUser(null);
    // Reset transient view selections so the next operator doesn't inherit
    // the previous one's drill-down context.
    set({
      currentUser: null,
      selectedUnitId: null,
      selectedBuildingId: null,
      sentryBatchId: null,
      sentryJobId: null,
      selectedAssetId: null,
    });
  },
  setRole: (role) => set({ role }),
  setOperatingMode: (operatingMode) => set({ operatingMode }),
  setAlertCount: (alertCount) => set({ alertCount }),
  setAlertSeverityCounts: (alertSeverityCounts) => set({ alertSeverityCounts }),
  setSelectedUnitId: (selectedUnitId) => set({ selectedUnitId }),
  setSelectedBuildingId: (selectedBuildingId) => set({ selectedBuildingId }),
  setSentryBatch: (sentryBatchId, sentryJobId) => set({ sentryBatchId, sentryJobId }),
  setSelectedAssetId: (selectedAssetId) => set({ selectedAssetId }),
  setFpcon: (fpcon) => set({ fpcon }),
  setCommsState: (commsState) => set({ commsState }),
  setAirGap: (airGapActive) => set({ airGapActive }),
  setQueueDepth: (queueDepth) => set({ queueDepth }),
  setScenario: (s) =>
    set({
      scenarioRunning: s.running,
      scenarioRate: s.rate,
      scenarioOffsetMin: s.offsetMin,
      scenarioOffsetLabel: s.offsetLabel,
      scenarioPhase: s.phase,
      scenarioMaxOffsetMin: s.maxOffsetMin,
      scenarioFiredEventIds: s.firedEventIds,
    }),
  setDdilMode: (ddilMode) => set({ ddilMode }),
  enqueueDdilWrite: (w) => {
    const entry: DdilQueuedWrite = {
      ...w,
      id: `DDIL-${uid().toUpperCase()}`,
      queuedAt: new Date().toISOString(),
    };
    set((s) => ({ ddilQueue: [...s.ddilQueue, entry] }));
    return entry;
  },
  removeDdilWrite: (id) => set((s) => ({ ddilQueue: s.ddilQueue.filter((q) => q.id !== id) })),
  clearDdilQueue: () => set({ ddilQueue: [] }),
  cacheDdilRead: (key, body) =>
    set((s) => ({ ddilCache: { ...s.ddilCache, [key]: { body, cachedAt: Date.now() } } })),
  noteDdilCacheHit: (key, cachedAt) =>
    set({ ddilLastCacheHit: { key, cachedAt, servedAt: Date.now() } }),
  setDdilSyncing: (ddilSyncing) => set({ ddilSyncing }),
  setDdilLastSyncAt: (ddilLastSyncAt) => set({ ddilLastSyncAt }),
  setDdilDrillActive: (ddilDrillActive) => set({ ddilDrillActive }),
  setDensity: (density) => {
    saveDensity(density);
    set({ density });
  },
  bumpDraftsRefresh: () => set((s) => ({ draftsRefreshTick: s.draftsRefreshTick + 1 })),
  setStageMode: (stageMode) => {
    saveStageMode(stageMode);
    set({ stageMode });
  },
  pushToast: (t) => {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    const ttl = t.ttlMs ?? 3000;
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
    }, ttl);
    return id;
  },
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));
