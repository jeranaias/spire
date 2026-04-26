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

export interface SpireState {
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
  selectedUnitId: string | null;

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

  // Toast queue.
  toasts: Toast[];

  // Track-G3 — density toggle. Persisted per role in localStorage.
  density: Density;

  setRole: (r: Role) => void;
  setOperatingMode: (m: OperatingMode) => void;
  setAlertCount: (n: number) => void;
  setAlertSeverityCounts: (counts: Record<string, number>) => void;
  setSelectedUnitId: (id: string | null) => void;
  setSentryBatch: (batchId: string | null, jobId: string | null) => void;
  setSelectedAssetId: (id: string | null) => void;
  setFpcon: (level: SpireState["fpcon"]) => void;
  setCommsState: (s: CommsState) => void;
  setAirGap: (active: boolean) => void;
  setQueueDepth: (n: number) => void;
  setDensity: (d: Density) => void;
  pushToast: (t: Omit<Toast, "id">) => string;
  dismissToast: (id: string) => void;
}

export const ROLE_LABELS: Record<Role, string> = {
  // Walkthrough caught long forms truncating in the TopBar dropdown at
  // common widths. Marine-shorthand fits without ellipsis; the unit
  // assignment surfaces in the role brief and on the StatusStrip.
  maintenance_chief: "Maint Chief",
  g4: "G-4 / 2d MLG",
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
export const VIEW_SCOPE: Record<string, Role[]> = {
  "/sentry":  ["data_custodian", "security_manager"],
  "/pulse":   ["maintenance_chief", "g4", "mef_commander"],
  "/bastion": ["mef_commander", "g4", "security_manager", "maintenance_chief"],
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

const DEFAULT_ROLE: Role = "mef_commander";

// Deep-link initial role.
//
// Decision: a `?role=…` query param on the *initial* page load is honored,
// then the param is wiped from the URL so the Zustand store is the sole
// source of truth from that point forward. Subsequent role swaps (dropdown)
// must NEVER repopulate the URL — the TopBar's nav() with `replace:true`
// to ROLE_DEFAULT_VIEW already strips any stale query string. This keeps
// shareable deep-links working (`?role=g4#/bastion`) without letting URL
// state diverge from store state for the rest of the session.
//
// If the param is invalid or absent, fall back to the default. Whichever
// path we take, we strip `role` from the live URL so a refresh inherits
// only the route, never a phantom role.
// Walkthrough audit: the role used to reset to the default on every
// page reload. An operator picking 'Security Mgr', refreshing, and
// being kicked back to MEF Commander is a real frustration. Persist
// last-selected role in localStorage so refresh keeps the seat.
// URL `?role=X` still wins (single-link override for demos), and
// nothing about scope-enforcement changes — the backend always honors
// X-User-Role per request.
const ROLE_KEY = "spire.role";
function readInitialRole(): Role {
  if (typeof window === "undefined") return DEFAULT_ROLE;
  try {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get("role");
    if (raw && (raw in ROLE_LABELS)) {
      // Strip the param from the visible URL so it doesn't get echoed
      // by future navs / share-link readers / hard reloads.
      url.searchParams.delete("role");
      const cleaned = url.pathname + (url.search ? url.search : "") + url.hash;
      window.history.replaceState({}, "", cleaned);
      try { window.localStorage.setItem(ROLE_KEY, raw); } catch { /* tolerant */ }
      return raw as Role;
    }
    const stored = window.localStorage.getItem(ROLE_KEY);
    if (stored && (stored in ROLE_LABELS)) return stored as Role;
  } catch {
    /* tolerant */
  }
  return DEFAULT_ROLE;
}

const INITIAL_ROLE: Role = readInitialRole();

export const useSpireStore = create<SpireState>((set) => ({
  role: INITIAL_ROLE,
  operatingMode: "full",
  alertCount: 0,
  alertSeverityCounts: {},
  selectedUnitId: null,
  sentryBatchId: null,
  sentryJobId: null,
  selectedAssetId: null,
  fpcon: "BRAVO",
  commsState: "CONNECTED",
  airGapActive: false,
  queueDepth: 0,
  toasts: [],
  density: typeof window !== "undefined" ? loadDensity() : "dense",
  setRole: (role) => {
    try { window.localStorage.setItem(ROLE_KEY, role); } catch { /* tolerant */ }
    set({ role });
  },
  setOperatingMode: (operatingMode) => set({ operatingMode }),
  setAlertCount: (alertCount) => set({ alertCount }),
  setAlertSeverityCounts: (alertSeverityCounts) => set({ alertSeverityCounts }),
  setSelectedUnitId: (selectedUnitId) => set({ selectedUnitId }),
  setSentryBatch: (sentryBatchId, sentryJobId) => set({ sentryBatchId, sentryJobId }),
  setSelectedAssetId: (selectedAssetId) => set({ selectedAssetId }),
  setFpcon: (fpcon) => set({ fpcon }),
  setCommsState: (commsState) => set({ commsState }),
  setAirGap: (airGapActive) => set({ airGapActive }),
  setQueueDepth: (queueDepth) => set({ queueDepth }),
  setDensity: (density) => {
    saveDensity(density);
    set({ density });
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
