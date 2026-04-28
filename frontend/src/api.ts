/**
 * Minimal API client for the SPIRE backend. Every call flows through this
 * module so we have one place to add telemetry / error handling / mode
 * gating once the Lite Mode toggle is fully wired.
 */

const BASE = "/api";

// Role read synchronously from the Zustand store on every call. The store
// owns the active role; we splice it onto GET requests as `?role=...` so the
// backend's scoping layer can filter per-role. POST routes also take a role
// via payload where needed.
let _getRole: () => string = () => "mef_commander";
export function registerRoleSource(fn: () => string) { _getRole = fn; }

function withRole(path: string): string {
  try {
    const role = _getRole();
    if (!role) return path;
    const sep = path.includes("?") ? "&" : "?";
    return `${path}${sep}role=${encodeURIComponent(role)}`;
  } catch {
    return path;
  }
}

// 401 listener — set by main.tsx, fired whenever any /api/* call comes back
// unauthenticated. Lets the auth gate clear the local store + redirect to
// /auth without every caller having to handle 401 individually.
let _onUnauthenticated: ((path: string) => void) | null = null;
export function registerUnauthenticatedHandler(fn: (path: string) => void) {
  _onUnauthenticated = fn;
}

// W1 DDIL dramatization — operator-controlled simulation. The interceptor
// reads from this getter on every request so changing modes mid-flight is
// immediately reflected. Kept as an opt-in registration (not a direct
// store import) to preserve the existing layering (api.ts has no Zustand
// dependency by default; main.tsx wires it).
export type DdilMode = "CONNECTED" | "LIMITED" | "INTERMITTENT" | "DISCONNECTED";

export interface DdilHandlers {
  getMode: () => DdilMode;
  // Cache a successful GET so a subsequent DISCONNECTED call can serve it.
  cacheRead: (key: string, body: unknown) => void;
  // Look up a cached read; returns the body + age in ms, or null.
  readCache: (key: string) => { body: unknown; ageMs: number } | null;
  // Queue a write that the interceptor refused to send live (because we're
  // DISCONNECTED). The actor / role are pulled from the caller so the tray
  // can attribute. Returns the queued id so callers can correlate.
  queueWrite: (op: { method: string; path: string; body?: unknown; actor: string }) => string;
  // Tell the store a cached read just served the caller. The freshness
  // badge / overlay reads from this so it can show "cached N minutes ago"
  // without each widget having to thread cache age into its props.
  noteCacheHit?: (key: string, ageMs: number, cachedAt: number) => void;
}

let _ddil: DdilHandlers | null = null;
export function registerDdilHandlers(h: DdilHandlers) { _ddil = h; }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Endpoints that must always go straight to the wire regardless of DDIL
// state — auth (so the operator can sign back in after a drill), and the
// system status / DDIL-itself endpoints (so the chrome stays honest).
function isExemptFromDdil(path: string): boolean {
  return path.startsWith("/auth/")
    || path.startsWith("/system/status")
    || path.startsWith("/system/comms/")
    || path.startsWith("/system/audit/spillage");
}

/**
 * Task-22 — typed error class so callers can branch on structured backend
 * `detail` payloads (e.g. the InsufficientClearance / DowngradeBlocked
 * responses raised by `backend/scoping.py`). Previously jsonFetch threw a
 * plain Error whose only signal was the message string, which meant the
 * spillage-prevented toast in ExportTab never fired on a real backend
 * deny. ApiError preserves both the parsed JSON body and the raw text so
 * legacy callers reading `err.message` still work.
 */
export class ApiError extends Error {
  public status: number;
  public body: unknown;
  public rawBody: string;
  constructor(status: number, statusText: string, rawBody: string, body: unknown) {
    super(`${status} ${statusText}: ${rawBody.slice(0, 200)}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.rawBody = rawBody;
  }
}

async function jsonFetch<T>(path: string, init?: RequestInit, injectRole = true): Promise<T> {
  const url = injectRole ? withRole(path) : path;
  const method = (init?.method || "GET").toUpperCase();
  const isRead = method === "GET";

  // ---- W1 DDIL interceptor (pre-fetch effects) -------------------------
  // The interceptor sits in front of the actual fetch and applies the
  // operator-controlled DDIL mode. Latency is simulated, intermittent
  // failures get one retry, DISCONNECTED diverts reads to the cache and
  // writes to the local queue. Exempt endpoints bypass entirely so the
  // operator can always sign back in / inspect status during a drill.
  const ddilExempt = isExemptFromDdil(path);
  const ddilMode = !ddilExempt && _ddil ? _ddil.getMode() : "CONNECTED";
  const cacheKey = `${method} ${path}`;

  if (!ddilExempt && _ddil && ddilMode !== "CONNECTED") {
    if (ddilMode === "DISCONNECTED") {
      if (isRead) {
        const hit = _ddil.readCache(cacheKey);
        if (hit) {
          const cachedAt = Date.now() - hit.ageMs;
          try { _ddil.noteCacheHit?.(cacheKey, hit.ageMs, cachedAt); } catch { /* tolerant */ }
          return hit.body as T;
        }
        throw new ApiError(
          0,
          "DDIL Disconnected",
          "no cached data available — comms denied",
          { detail: "DDIL DISCONNECTED · no cached data for this read", ddil: "disconnected" },
        );
      }
      // Write — queue it locally and surface a clean error so callers
      // know not to optimistically render a success.
      const id = _ddil.queueWrite({
        method,
        path,
        body: init?.body ? safeParseBody(init.body) : undefined,
        actor: _getRole(),
      });
      throw new ApiError(
        0,
        "DDIL Queued",
        `write queued locally as ${id} — will replay on reconnect`,
        { detail: "DDIL DISCONNECTED · write queued for replay", ddil: "queued", local_id: id },
      );
    }
    if (ddilMode === "LIMITED") {
      // High-latency lane: 800–2000ms before the actual fetch.
      await sleep(800 + Math.floor(Math.random() * 1200));
    }
    if (ddilMode === "INTERMITTENT") {
      // ~30% of calls drop visibly — the spec ("~30% of API calls fail
      // with retry") asks for an operator-felt failure rate near 30%, not
      // a silent auto-retry that masks the loss to ~9%. The caller sees
      // an ApiError; their UI shows the failure and they can re-issue,
      // which is the "retry" the operator narrates during the demo.
      await sleep(120 + Math.floor(Math.random() * 280));
      if (Math.random() < 0.3) {
        throw new ApiError(
          503,
          "DDIL Intermittent",
          "transient packet loss — request dropped on the wire",
          { detail: "DDIL INTERMITTENT · packet dropped", ddil: "intermittent" },
        );
      }
    }
  }

  const isFormData =
    typeof FormData !== "undefined" && init?.body instanceof FormData;
  const baseHeaders: Record<string, string> = isFormData
    ? {}
    : { "Content-Type": "application/json" };
  const resp = await fetch(`${BASE}${url}`, {
    credentials: "include",
    ...init,
    headers: { ...baseHeaders, ...((init?.headers as Record<string, string>) || {}) },
  });
  if (resp.status === 401 && !path.startsWith("/auth/")) {
    // Auth gate took over — surface a clean, recognizable error so callers
    // (or their ErrorBoundaries) don't render half-loaded data.
    if (_onUnauthenticated) {
      try { _onUnauthenticated(path); } catch { /* tolerant */ }
    }
    throw new ApiError(401, "Unauthorized", "session expired or missing", {
      detail: "session expired or missing",
    });
  }
  if (!resp.ok) {
    const rawBody = await resp.text();
    let parsed: unknown = null;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      parsed = null;
    }
    throw new ApiError(resp.status, resp.statusText, rawBody, parsed);
  }
  const body = (await resp.json()) as T;
  if (isRead && !ddilExempt && _ddil) {
    // Always cache successful reads — the cache is what makes a future
    // DISCONNECTED transition serve last-known-good rather than throw.
    try { _ddil.cacheRead(cacheKey, body); } catch { /* tolerant */ }
  }
  return body;
}

function safeParseBody(body: BodyInit): unknown {
  try {
    if (typeof body === "string") return JSON.parse(body);
  } catch {
    /* tolerant */
  }
  return undefined;
}

/**
 * Replay a queued DDIL write directly against the wire. Bypasses the
 * interceptor by stamping a header so the comms switcher can drain the
 * queue when transitioning back to CONNECTED. Returns the parsed body or
 * throws on failure (caller decides what to do with conflicts).
 */
export async function replayQueuedWrite(write: {
  method: string;
  path: string;
  body?: unknown;
}): Promise<unknown> {
  const url = withRole(write.path);
  const init: RequestInit = {
    method: write.method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  };
  if (write.body !== undefined) init.body = JSON.stringify(write.body);
  const resp = await fetch(`${BASE}${url}`, init);
  if (!resp.ok) {
    const rawBody = await resp.text();
    let parsed: unknown = null;
    try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch { /* tolerant */ }
    throw new ApiError(resp.status, resp.statusText, rawBody, parsed);
  }
  try { return await resp.json(); } catch { return null; }
}

export const api = {
  auth: {
    // List the four mocked CAC identities for the cert-selection screen.
    // Unauthenticated callers see the trimmed `PublicAuthUser` shape
    // (no clearance / role / billet / unit / parent_command) — see
    // `backend/auth.list_users`. The in-app identity switcher uses the
    // authenticated `directory()` variant below to recover the full
    // payload it needs to render role labels.
    users: () => jsonFetch<{ users: PublicAuthUser[] }>("/auth/users", undefined, false),
    // Same `/auth/users` endpoint, but typed for the post-login
    // identity switcher: when the session cookie is present the backend
    // returns the full `AuthUser` records (role / billet / etc).
    directory: () => jsonFetch<{ users: AuthUser[] }>("/auth/users", undefined, false),
    // PIN: any 6-digit numeric (UI illusion only).
    login: (dodid: string, pin: string) =>
      jsonFetch<{ ok: boolean; user: AuthUser; expires_at: number }>(
        "/auth/login",
        { method: "POST", body: JSON.stringify({ dodid, pin }) },
        false,
      ),
    logout: () => jsonFetch<{ ok: boolean }>("/auth/logout", { method: "POST" }, false),
    me: () => jsonFetch<{ user: AuthUser }>("/auth/me", undefined, false),
    /**
     * MDM 2026 stage-pivot — re-issue a session cookie for a different
     * MOCK identity without requiring a PIN re-entry. Backend route is
     * additive (`POST /api/auth/quick-switch`) and gated by the
     * `SPIRE_DEMO_QUICK_SWITCH=1` env var. Returns 404 if disabled or
     * 404 on unknown DODID.
     *
     * The IdentityPill prefers this when the store is in `stageMode` so
     * the presenter can swap CAC identity on stage with one click.
     */
    quickSwitch: (dodid: string) =>
      jsonFetch<{ ok: boolean; user: AuthUser; expires_at: number }>(
        "/auth/quick-switch",
        { method: "POST", body: JSON.stringify({ dodid }) },
        false,
      ),
  },
  system: {
    status: () => jsonFetch<SystemStatus>("/system/status"),
    /**
     * Task-22 — front-end-side spillage record. Called by `<ClassifiedExport>`
     * when a user clicks an export they're not cleared for; the protected
     * call is never attempted, so this is the only path that surfaces the
     * intent in the audit chain.
     */
    spillagePrevented: (detail: {
      action: string;
      required_classification: string;
      user_clearance?: string;
      surface?: string;
    }) =>
      jsonFetch<{ ok: boolean; logged: boolean }>("/system/audit/spillage", {
        method: "POST",
        body: JSON.stringify(detail),
      }),
    /**
     * MDM 2026 stage-pivot — append an audit chain entry for a DHA
     * RESCUE operator action (Advance to H+72, approve market
     * sourcing, etc.). Backend at `POST /api/system/dha-rescue/audit`
     * stamps the entry with the session DODID + role.
     */
    dhaRescueAudit: (detail: {
      action: string;
      advance_to_hour?: number;
      recommendation_id?: string;
      subject_id?: string;
    }) =>
      jsonFetch<{ ok: boolean; logged: boolean; action: string }>(
        "/system/dha-rescue/audit",
        { method: "POST", body: JSON.stringify(detail) },
      ),
    datasetInfo: () => jsonFetch<DatasetInfo>("/system/dataset-info"),
    commsState: () => jsonFetch<CommsStateResponse>("/system/comms/state"),
    setAirGap: (enable: boolean, reason?: string) =>
      jsonFetch<AirGapToggleResult>("/system/comms/airgap", {
        method: "POST",
        body: JSON.stringify({
          enable,
          reason: reason ?? "operator-initiated",
          actor_role: _getRole(),
        }),
      }, false),
    queueOp: (op_kind: string, payload: unknown, actor: string) =>
      jsonFetch<{ ok: boolean; local_id: string; queued_at: string; queue_depth: number }>(
        "/system/comms/queue",
        { method: "POST", body: JSON.stringify({ op_kind, payload, actor }) },
        false,
      ),
    // B4 — Mission clock + scenario timeline. State is read-only; control
    // is gated to operator roles backend-side (see SCENARIO_CONTROL_ROLES).
    scenarioState: () => jsonFetch<ScenarioState>("/system/scenario/state", undefined, false),
    scenarioControl: (
      action: ScenarioControlAction,
      opts: { rate?: number; offset_min?: number } = {},
    ) =>
      jsonFetch<ScenarioState>(
        "/system/scenario/control",
        { method: "POST", body: JSON.stringify({ action, ...opts }) },
        false,
      ),
    // W2 Task #37 — Scripted scenario engine. Reads the canonical blood
    // vignette config (beats, narration, view targets, expected per-beat
    // durations). Read-only; the player at /demo polls this once on
    // entry and walks the timeline locally. The backend mission-clock
    // continues to be the source of truth for scenario time + injector
    // dispatch — the player just steers the FE through the beats.
    scenarioBloodVignette: () =>
      jsonFetch<BloodScenarioMeta>("/system/scenario/blood-h72", undefined, false),
    // Round-4 — pull the injected events buffer for the DHA RESCUE
    // surface so the operator can see scripted alerts/forecasts/
    // requisitions/toasts that fired this run. Backed by
    // /api/system/scenario/blood-h72/feed.
    scenarioBloodFeed: (sinceOffsetMin?: number, kinds?: string[], limit = 100) => {
      const sp = new URLSearchParams();
      if (typeof sinceOffsetMin === "number" && Number.isFinite(sinceOffsetMin)) {
        sp.set("since_offset_min", String(sinceOffsetMin));
      }
      if (kinds && kinds.length > 0) sp.set("kind", kinds.join(","));
      sp.set("limit", String(limit));
      const qs = sp.toString();
      return jsonFetch<BloodScenarioFeed>(
        `/system/scenario/blood-h72/feed${qs ? `?${qs}` : ""}`,
        undefined,
        false,
      );
    },
    adminTelemetry: () => jsonFetch<AdminTelemetry>("/system/admin/telemetry"),
    adminOutcomes: (limit = 50, kind?: string) => {
      const sp = new URLSearchParams();
      sp.set("limit", String(limit));
      if (kind) sp.set("decision_kind", kind);
      return jsonFetch<{ outcomes: DecisionOutcome[]; total: number }>(`/system/admin/outcomes?${sp}`);
    },
    adminFeedback: () => jsonFetch<{ feedback: FeedbackRecord[]; total: number }>("/system/feedback"),
    /**
     * SOC-shaped audit query — backs `/admin/audit`. Filter params are
     * comma-joined where the backend accepts a list (actors / kinds /
     * resource); empty strings are skipped so the URL stays compact.
     */
    auditQuery: (params: AuditQueryParams = {}, opts?: { signal?: AbortSignal }) => {
      const sp = new URLSearchParams();
      if (params.actors?.length)  sp.set("actors",  params.actors.join(","));
      if (params.kinds?.length)   sp.set("kinds",   params.kinds.join(","));
      if (params.resource?.length) sp.set("resource", params.resource.join(","));
      if (params.classification)  sp.set("classification", params.classification);
      if (params.after)           sp.set("after",  params.after);
      if (params.before)          sp.set("before", params.before);
      if (params.q)               sp.set("q",      params.q);
      if (params.only_anomalies)  sp.set("only_anomalies", "true");
      if (params.only_role_only)  sp.set("only_role_only", "true");
      sp.set("limit",  String(params.limit  ?? 100));
      sp.set("offset", String(params.offset ?? 0));
      return jsonFetch<AuditQueryResult>(
        `/system/admin/audit?${sp.toString()}`,
        opts?.signal ? { signal: opts.signal } : undefined,
      );
    },
    // W1 #30 — model registry / supply-chain page. Restricted server-side
    // to security_manager via MODEL_REGISTRY_ROLES.
    adminModels: () => jsonFetch<ModelRegistryListResponse>("/system/admin/models"),
    adminModelDetail: (modelId: string) =>
      jsonFetch<ModelRegistryDetailResponse>(`/system/admin/models/${encodeURIComponent(modelId)}`),
    // D3 — inference economics. window_seconds bounds the rolling
    // (calls/min, $/min) numbers; defaults to 60s on the backend.
    inferenceEconomics: (windowSeconds = 60) =>
      jsonFetch<InferenceEconomics>(`/system/admin/inference-economics?window_seconds=${windowSeconds}`),
    inferenceExtrapolate: (
      params: {
        force_size?: number;
        calls_per_marine_per_day?: number;
        tier_mix?: Record<string, number>;
      },
      opts?: { signal?: AbortSignal },
    ) =>
      jsonFetch<InferenceExtrapolation>("/system/admin/inference-economics/extrapolate", {
        method: "POST",
        body: JSON.stringify(params),
        signal: opts?.signal,
      }, false),
    syncState: () => jsonFetch<SyncStateResponse>("/system/sync/state"),
    syncConflicts: () => jsonFetch<SyncConflictsResponse>("/system/sync/conflicts"),
    syncResolve: (conflictId: string, winner: "local" | "peer", actor: string) =>
      jsonFetch<SyncConflict>(`/system/sync/resolve/${encodeURIComponent(conflictId)}`, {
        method: "POST",
        body: JSON.stringify({ winner, actor }),
      }, false),
    syncSeedConflict: (actor: string) =>
      jsonFetch<SyncConflict>("/system/sync/seed-conflict", {
        method: "POST",
        body: JSON.stringify({ actor_role: actor }),
      }, false),
    // Per-identity onboarding-intro pref (DODID-scoped, read off the signed
    // session). 'seen' === true means "don't show the 60-sec intro again
    // for this Marine".
    getOnboardingIntroSeen: () =>
      jsonFetch<{ seen: boolean }>("/system/prefs/onboarding-intro", undefined, false),
    setOnboardingIntroSeen: (seen: boolean) =>
      jsonFetch<{ ok: boolean; seen: boolean }>("/system/prefs/onboarding-intro", {
        method: "POST",
        body: JSON.stringify({ seen }),
      }, false),
    // Per-identity TopBar chip visibility (Task #193). DODID-scoped via
    // the signed session cookie. The client treats this as a mirror —
    // localStorage is the same-tab cache, this endpoint is the
    // cross-device source of truth.
    getTopbarChips: () =>
      jsonFetch<{ chips: Record<string, boolean> }>("/system/prefs/topbar-chips", undefined, false),
    setTopbarChips: (chips: Record<string, boolean>) =>
      jsonFetch<{ ok: boolean; chips: Record<string, boolean> }>("/system/prefs/topbar-chips", {
        method: "POST",
        body: JSON.stringify({ chips }),
      }, false),
    // Wave-1 lane #27 — GCSS-MC reference adapter freshness ping.
    // Backed by /api/integrations/gcss-mc/last-sync. Polled by the topbar
    // pill; intentionally mock + deterministic across polls.
    gcssMcLastSync: () =>
      jsonFetch<GcssMcLastSync>("/integrations/gcss-mc/last-sync", undefined, false),
    // Task #76 — system-of-record sample slice. Goes through jsonFetch so
    // the DDIL interceptor applies (the integrations page is the one
    // place that documents failure modes — it must respect the SATCOM
    // denial drill, not silently bypass it).
    gcssMcSample: (limit = 3) =>
      jsonFetch<GcssMcSamplePayload>(
        `/integrations/gcss-mc/sample?limit=${limit}`,
        undefined,
        false,
      ),
    // Task #166 — sibling integrations subpages (TC-AIMS-II, MIMMS,
    // AESIP/LMP, GFEBS) reach for these. Each routes through jsonFetch
    // so the DDIL interceptor applies on every integration page, not
    // just GCSS-MC. The shared `_mock` block on every payload labels
    // it REFERENCE IMPLEMENTATION so a curl reviewer cannot mistake
    // any of them for a live source-of-record link.
    tcAimsIiSample: (limit = 3) =>
      jsonFetch<SiblingSamplePayload>(
        `/integrations/tc-aims-ii/sample?limit=${limit}`,
        undefined,
        false,
      ),
    mimmsSample: (limit = 3) =>
      jsonFetch<SiblingSamplePayload>(
        `/integrations/mimms/sample?limit=${limit}`,
        undefined,
        false,
      ),
    aesipLmpSample: (limit = 3) =>
      jsonFetch<SiblingSamplePayload>(
        `/integrations/aesip-lmp/sample?limit=${limit}`,
        undefined,
        false,
      ),
    gfebsSample: (limit = 3) =>
      jsonFetch<SiblingSamplePayload>(
        `/integrations/gfebs/sample?limit=${limit}`,
        undefined,
        false,
      ),
    // Task #177 — GCSS-MC schema-fidelity work. Backs the Field Dictionary
    // section that proves SPIRE's coverage against the real 163-column
    // schema. Pulled once on the Integrations page, no polling needed.
    gcssMcCoverageSummary: () =>
      jsonFetch<GcssMcCoverageSummary>(
        "/integrations/gcss-mc/coverage-summary",
        undefined,
        false,
      ),
    gcssMcDictionary: (section?: "header" | "parts" | "due_in") =>
      jsonFetch<GcssMcDictionary>(
        section
          ? `/integrations/gcss-mc/dictionary?section=${section}`
          : "/integrations/gcss-mc/dictionary",
        undefined,
        false,
      ),
    // Task #25 — return SPIRE to a clean t=0 demo state. Gated server-side
    // to the demo operator (g4); the topbar reset button is hidden for
    // every other role so this client method is never reachable from the
    // chrome unless the operator is signed in.
    resetDemo: () =>
      jsonFetch<ResetDemoResult>("/system/admin/reset-demo", { method: "POST" }, false),
    // Task #183 — stage live-ingest mode. Read-only descriptor of the
    // current dataset (empty? source? counts?). Used by every view to
    // decide whether to render the "awaiting GCSS-MC ingest" empty state
    // or the populated dashboards.
    datasetStatus: () => jsonFetch<DatasetStatus>("/system/dataset-status"),
    // Drag-drop hydration — POST the three sanitized GCSS-MC CSVs.
    // Form fields are named `header`, `sr_parts`, `due_in` to match
    // the backend route's `UploadFile = File(...)` signature exactly.
    stageIngest: (files: { header: File; sr_parts: File; due_in: File }) => {
      const fd = new FormData();
      fd.append("header", files.header, files.header.name);
      fd.append("sr_parts", files.sr_parts, files.sr_parts.name);
      fd.append("due_in", files.due_in, files.due_in.name);
      return jsonFetch<StageIngestResult>(
        "/system/stage-ingest",
        { method: "POST", body: fd },
        false,
      );
    },
  },
  pulse: {
    fleetOverview: () => jsonFetch<FleetOverview>("/pulse/fleet-overview"),
    riskBoard: (top = 20) => jsonFetch<RiskBoard>(`/pulse/risk-board?top=${top}`),
    assetDeepDive: (assetId: string) => jsonFetch<AssetDeepDive>(`/pulse/assets/${encodeURIComponent(assetId)}`),
    cannibalization: () => jsonFetch<Cannibalization>("/pulse/cannibalization"),
    // Task-42 — route the propose POST through jsonFetch so the DDIL
    // interceptor applies (DISCONNECTED → queue for replay,
    // INTERMITTENT → may drop with a warn, LIMITED → latency
    // dramatization). Previously CannibalizationTab + RecommendPanel
    // each issued raw fetch("/api/pulse/cannibalization/propose", …),
    // bypassing the interceptor and silently exiting the "we work
    // when comms are yellow" demo on this page.
    cannibalizationPropose: (
      input: {
        recipient_sr: string;
        donor_asset_id: string;
        // Task #41 — backend accepts donor_sr as a legacy alias alongside
        // donor_asset_id; pass it when the donor row exposes one so the
        // server can cross-check both identifiers in the self-cannib guard.
        donor_sr?: string;
        nsn: string;
      },
      opts?: { signal?: AbortSignal },
    ) =>
      jsonFetch<{ ok: boolean; event_id?: string; impact?: string }>(
        "/pulse/cannibalization/propose",
        {
          method: "POST",
          body: JSON.stringify(input),
          signal: opts?.signal,
        },
      ),
    forecast: (unit?: string, window = 14) =>
      jsonFetch<Forecast>(`/pulse/forecast?window=${window}${unit ? `&unit=${encodeURIComponent(unit)}` : ""}`),
    feedback: (assetId: string, correct: boolean, note = "") =>
      jsonFetch<{ ok: boolean }>(`/pulse/feedback/${encodeURIComponent(assetId)}`, {
        method: "POST",
        body: JSON.stringify({ correct, note }),
      }),
    recommendActions: (params: { unit?: string; asset_id?: string; top?: number } = {}) => {
      const sp = new URLSearchParams();
      if (params.unit) sp.set("unit", params.unit);
      if (params.asset_id) sp.set("asset_id", params.asset_id);
      sp.set("top", String(params.top ?? 5));
      return jsonFetch<RecommendActionsResponse>(`/pulse/recommend-actions?${sp}`);
    },
    predictFailures: (params: { unit?: string; asset_id?: string; horizon_days?: number; threshold?: number } = {}) => {
      const sp = new URLSearchParams();
      if (params.unit) sp.set("unit", params.unit);
      if (params.asset_id) sp.set("asset_id", params.asset_id);
      sp.set("horizon_days", String(params.horizon_days ?? 14));
      sp.set("threshold", String(params.threshold ?? 0.4));
      return jsonFetch<PredictFailuresResponse>(`/pulse/predict-failures?${sp}`);
    },
    modelCard: () => jsonFetch<ModelCard>("/pulse/model-card"),
    // Draft Action persistence — Risk Board CTA writes through here so the
    // click survives a refresh and shows up in the TopBar drafts badge.
    draftAction: (body: {
      asset_id: string;
      kind: string;
      title: string;
      unit_name?: string;
      description?: string;
      cost_usd?: number | null;
      mc_delta_pct?: number | null;
      time_to_effect_hours?: number | null;
      artifact?: Record<string, unknown> | null;
    }) =>
      jsonFetch<{ ok: boolean; draft: PulseDraft }>("/pulse/draft-action", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    drafts: (status: "held" | "dismissed" | "expired" = "held") =>
      jsonFetch<{ drafts: PulseDraft[]; count: number; status: string }>(
        `/pulse/drafts?status=${status}`,
      ),
    dismissDraft: (draftId: string) =>
      jsonFetch<{ ok: boolean; draft_id: string; status: string }>(
        `/pulse/drafts/${encodeURIComponent(draftId)}/dismiss`,
        { method: "POST" },
      ),
    approveDraft: (draftId: string) =>
      jsonFetch<{
        ok: boolean;
        draft_id: string;
        status: string;
        execution: {
          kind: string | null;
          status: string;
          proposal_id?: string;
          note?: string;
        };
      }>(
        `/pulse/drafts/${encodeURIComponent(draftId)}/approve`,
        { method: "POST" },
      ),
    rejectDraft: (draftId: string, reason = "") =>
      jsonFetch<{ ok: boolean; draft_id: string; status: string; reason: string }>(
        `/pulse/drafts/${encodeURIComponent(draftId)}/reject`,
        { method: "POST", body: JSON.stringify({ reason }) },
      ),
  },
  sentry: {
    demoBatch: (limit = 500) => jsonFetch<SentryBatch>(`/sentry/demo-batch?limit=${limit}`),
    process: (batchId: string) =>
      jsonFetch<{ job_id: string; batch_id: string }>(`/sentry/process/${batchId}`, { method: "POST" }),
    jobStatus: (jobId: string, role?: string) =>
      jsonFetch<SentryJob>(
        `/sentry/jobs/${jobId}${role ? `?role=${encodeURIComponent(role)}` : ""}`,
      ),
    reviewQueue: (batchId: string, role?: string) =>
      jsonFetch<SentryReviewQueue>(
        `/sentry/review-queue/${batchId}${role ? `?role=${encodeURIComponent(role)}` : ""}`,
      ),
    review: (sr: string, action: "approve" | "reject" | "modify", note = "") =>
      jsonFetch<{ ok: boolean }>(`/sentry/review/${sr}/${action}`, {
        method: "POST",
        body: JSON.stringify({ note, role: "data_custodian" }),
      }),
    // Bulk review — N records, one chained audit entry. Replaces the
    // earlier client-side fan-out that emitted N independent review POSTs
    // (and N independent audit rows) for a single operator click.
    reviewBulk: (
      action: "approve" | "reject",
      srNumbers: string[],
      column = "",
      note = "",
    ) =>
      jsonFetch<{ ok: boolean; count: number; sr_numbers: string[]; audit_kind: string }>(
        "/sentry/review/bulk",
        {
          method: "POST",
          body: JSON.stringify({ action, sr_numbers: srNumbers, column, note }),
        },
      ),
    mark: (text: string, release_authority = "US_ONLY") =>
      jsonFetch<MarkResult>("/sentry/mark", {
        method: "POST",
        body: JSON.stringify({ text, release_authority }),
      }),
    // Walkthrough #6 — pass batch_id so the export covers the same batch
    // the operator just processed (was: server fell through to canonical
    // 2,251 records when batch_id was absent).
    export: (release = "US_ONLY", format = "xlsx", batchId?: string | null) =>
      jsonFetch<ExportResult>("/sentry/export", {
        method: "POST",
        body: JSON.stringify({
          release_authority: release,
          format,
          include_audit: true,
          batch_id: batchId ?? null,
        }),
      }),
    coalitionProfiles: () =>
      jsonFetch<{ profiles: CoalitionProfileSummary[] }>("/sentry/coalition/profiles"),
    coalitionView: (profileKey: string) =>
      jsonFetch<CoalitionView>(`/sentry/coalition/${encodeURIComponent(profileKey)}`),
    coalitionRelease: (
      profileKey: string,
      opts?: { acknowledgedOverCeiling?: boolean; overCeilingCount?: number },
    ) =>
      jsonFetch<CoalitionReleaseResult>(`/sentry/coalition/${encodeURIComponent(profileKey)}/release`, {
        method: "POST",
        body: JSON.stringify({
          actor_role: _getRole(),
          // Task #154 — record the over-ceiling acknowledgement on the
          // audit row. Defaults preserve old call-site behavior (no
          // acknowledgement, count 0) for callers that haven't been
          // updated.
          acknowledged_over_ceiling: !!opts?.acknowledgedOverCeiling,
          over_ceiling_count: opts?.overCeilingCount ?? 0,
        }),
      }),
    // Walkthrough #31 — per-subject audit-chain viewer.
    auditFor: (subjectId: string, limit = 50) =>
      jsonFetch<{ subject_id: string; entries: any[]; count: number }>(
        `/sentry/audit/${encodeURIComponent(subjectId)}?limit=${limit}`,
      ),
  },
  bastion: {
    cop: () => jsonFetch<BastionCOP>("/bastion/cop"),
    alerts: (limit = 30) =>
      jsonFetch<BastionAlertsResponse>(`/bastion/alerts?limit=${limit}`),
    fusedThreats: () => jsonFetch<{ fused_threats: FusedThreat[] }>("/bastion/fused-threats"),
    alertAction: (id: string, action: "ack" | "snooze" | "resolve" | "unack") =>
      jsonFetch<{ ok: boolean; alert_id: string; state: AlertState | null }>(
        `/bastion/alerts/${encodeURIComponent(id)}/${action}`,
        { method: "POST", body: JSON.stringify({}) },
      ),
    incidents: (limit = 50) => jsonFetch<{ incidents: any[] }>(`/bastion/incidents?limit=${limit}`),
    incidentResponse: (id: string) => jsonFetch<IncidentResponse>(`/bastion/incidents/${id}/response`),
    simulateThermalHawk: (unit = "CLB-6") =>
      jsonFetch<ThermalHawkSim>(`/bastion/simulate/thermalhawk-detection`, {
        method: "POST",
        body: JSON.stringify({ unit }),
      }),
    clearSim: (id: string) =>
      jsonFetch<{ ok: boolean }>(`/bastion/simulate/clear/${id}`, { method: "POST" }),
    thermalhawkFeedFrame: (frame: number) =>
      jsonFetch<ThermalHawkFeedFrame>(`/bastion/thermalhawk/feed?frame=${frame}`),
    thermalhawkFeedInfo: () =>
      jsonFetch<ThermalHawkFeedInfo>(`/bastion/thermalhawk/feed/info`),
    nlQuery: (text: string) =>
      jsonFetch<NLQueryResult>(`/bastion/nl-query`, {
        method: "POST",
        body: JSON.stringify({ text, role: _getRole() }),
      }),
  },
  llm: {
    status: () => jsonFetch<{ reachable: boolean; model_id?: string; max_context?: number }>("/llm/status"),
  },
  joint: {
    omsUci: () => jsonFetch<JointOmsUciExport>("/joint/oms-uci/export"),
    link16: () => jsonFetch<JointLink16Export>("/joint/link16/export"),
    conformance: () => jsonFetch<JointConformance>("/joint/conformance"),
  },
  decisionBridge: {
    mission: () => jsonFetch<DecisionBridgeMission>("/decision-bridge/mission"),
    alerts: (limit = 3) =>
      jsonFetch<DecisionBridgeAlerts>(`/decision-bridge/alerts?limit=${limit}`),
    shortages: (limit = 3) =>
      jsonFetch<DecisionBridgeShortages>(`/decision-bridge/shortages?limit=${limit}`),
    mcByUnit: (limit = 3) =>
      jsonFetch<DecisionBridgeMcByUnit>(`/decision-bridge/mc-by-unit?limit=${limit}`),
    audit: (windowMinutes = 5) =>
      jsonFetch<DecisionBridgeAudit>(`/decision-bridge/audit?window_minutes=${windowMinutes}`),
  },
};

// ---- Types (trimmed to what views consume) --------------------------------

// CAC/PIV identity payload — mirrors `backend/auth.MOCK_USERS`. Kept in
// sync with `frontend/src/state/store.ts` `User`. This is the *full*
// post-login payload returned by `/api/auth/login`, `/api/auth/me`, and
// the authenticated re-fetch of `/api/auth/users` from the in-app
// identity switcher.
export interface AuthUser {
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
  role: "maintenance_chief" | "g4" | "mef_commander" | "data_custodian" | "security_manager";
  initials: string;
  cert_issuer?: string;
  cert_serial?: string;
  cert_expires?: string;
}

/**
 * Trimmed cert-directory shape returned by `/api/auth/users` to
 * unauthenticated callers (i.e. the cert-selection splash). A real CAC
 * reader surfaces name/rank/branch/cert metadata + masked DODID; it does
 * NOT broadcast clearance, role, billet, unit, or parent_command before
 * sign-in. Stripping those fields server-side means a judge or passer-by
 * looking at the splash — or scraping the open endpoint — cannot
 * enumerate who holds TS//SCI vs SECRET, who's the security manager,
 * etc. Task #27 / auth-cac-splash F1.
 */
export interface PublicAuthUser {
  dodid: string;
  name: string;
  rank: string;
  branch: string;
  initials: string;
  cert_issuer?: string;
  cert_serial?: string;
  cert_expires?: string;
}

export interface SystemStatus {
  mode: string;
  version: string;
  backend_time_local: string;
  dataset: {
    seed: number;
    fingerprint: string;
    units: number;
    assets: number;
    personnel: number;
    srs: number;
    snapshots: number;
    requisitions: number;
    incidents: number;
    cannibalization_events: number;
    consistency_errors: number;
    data_quality_defects: Record<string, number>;
  };
  llm: { reachable: boolean; model: string; max_context: number };
  features: Record<string, boolean>;
  // Walkthrough audit: footer chips used to hardcode '0 egress',
  // 'AES-256-GCM', 'val=1.0 · 413K params', etc. The backend exposes
  // each value already; the frontend just needed the schema to consume
  // them. These fields are optional (older builds/deploys may omit).
  security?: {
    audit_chain_intact: boolean;
    audit_entries: number;
    audit_head_hash: string;
    encrypted_at_rest: boolean;
  };
  network_egress?: {
    armed: boolean;
    unapproved_attempts: number;
    recent: unknown[];
  };
  models?: {
    sentry_loaded: boolean;
    sentry_path: string | null;
    pulse_loaded: boolean;
    pulse_path: string | null;
    errors: string[];
  };
}

// Walkthrough #JOB-B (review #52 / #30) — single source of truth for the
// dataset's last day. PULSE heatmap "as of" + Forecast "TODAY" pin both
// read this so they line up with SENTRY/BASTION date stamps. Mission Clock
// in BASTION continues to show real wall-clock UTC (operating mission
// time, intentionally separate from the dataset stamp).
export interface DatasetInfo {
  dataset_last_day: string | null;
  dataset_first_day: string | null;
  // Walkthrough audit: installation_name + parent_command surface
  // through here so StatusStrip / mission summary copy reads from data
  // instead of hardcoding 'Camp Henderson · 2d MLG'.
  installation_name?: string | null;
  parent_command?: string | null;
  mission_essential_task?: string | null;
  mission_objective?: string | null;
  ccir?: string[];
  snapshot_days: number;
  fingerprint: string;
  build_id: string;
  as_of: string | null;
  generated_at: string;
  seed: number;
}

// Task #183 — stage live-ingest mode. Shape mirrors backend
// `state.dataset_status()`. The frontend uses `empty` to gate between
// the populated dashboards and the "awaiting GCSS-MC ingest" hero card.
export interface DatasetStatus {
  empty: boolean;
  source: string | null;          // "seed-42" | "stage-ingest" | "empty"
  ingested_at: string | null;     // ISO-8601
  ingested_by: string | null;     // actor DODID or "lifespan"
  ingest_hash: string | null;     // sha256 trunc-16 of the 3 source files
  counts: {
    units: number;
    assets: number;
    srs: number;
    snapshots: number;
    incidents: number;
    requisitions: number;
  };
  generated_at: string;
  seed: number;
}

// Response shape from POST /api/system/stage-ingest. Used by the
// DECISION BRIDGE hero card to surface post-hydration counts.
export interface StageIngestResult {
  ok: boolean;
  ingest_hash: string;
  elapsed_ms: number;
  actor: { role: string; dodid: string | null };
  source_files: Record<
    "header" | "sr_parts" | "due_in",
    { name: string; bytes: number; rows_parsed: number }
  >;
  counts: DatasetStatus["counts"];
  ingest_report: {
    rows_total: number;
    rows_kept: number;
    rows_filtered_pmcs: number;
    rows_with_warnings: number;
    schema_warnings: string[];
    defect_code_trailing_period_normalized: number;
    date_parse_failures: number;
  };
}

// Domain endpoints can return an empty-state envelope under stage
// live-ingest mode. The frontend branches on `empty: true` and renders
// the "awaiting GCSS-MC ingest" placeholder instead of unpacking the
// usual payload. Wrap the existing payload type with this union at the
// call site to keep type-narrowing precise.
export interface EmptyEnvelope {
  empty: true;
  message: string;
}

export function isEmptyEnvelope(payload: unknown): payload is EmptyEnvelope {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "empty" in payload &&
    (payload as { empty?: unknown }).empty === true
  );
}

// Task #76 — sample-endpoint payload for the GCSS-MC reference adapter.
// Shape mirrors `backend/integrations.py::sample_gcss_mc_slice`. Lives in
// api.ts so the IntegrationsView and any future curl-fixture builder share
// one type.
export interface GcssMcSamplePayload {
  _mock: {
    label: string;
    warning: string;
    shape_version: string;
    spec_sources: string[];
    filters_applied: { limit: number; uic: string | null };
    as_of_dataset_day: string | null;
  };
  field_mapping_reference: Record<string, Record<string, string>>;
  EQUIPMENT_MASTER: Record<string, unknown>[];
  MIMMS_DAILY_READINESS: Record<string, unknown>[];
  EQUIPMENT_REPAIR_ORDER: Record<string, unknown>[];
  SUPPLY_DOC: Record<string, unknown>[];
  totals_in_canonical_dataset: Record<string, number>;
}

// Task #166 — sibling integrations sample-endpoint payloads. Every page
// shares the same `_mock` envelope shape so the integrity-of-claims story
// (REFERENCE IMPLEMENTATION, not live) reads identically no matter which
// adapter a curl reviewer hits. Per-target rows live under their canonical
// table key (TC-AIMS movement records, MIMMS daily readiness, etc.).
export interface SiblingMockBlock {
  label: string;
  system: string;
  warning: string;
  shape_version: string;
  spec_sources: string[];
}
// All sibling adapters (TC-AIMS-II, MIMMS, AESIP/LMP, GFEBS) share the
// same envelope: a `_mock` block, an optional totals-in-canonical-set
// summary, and one or more table arrays keyed by their canonical name
// (e.g. MOVEMENT_RECORDS, MIMMS_DAILY_READINESS, MATERIAL_MASTER,
// FUNDING_LINES_OPEN). The view walks `tableKeys` from its spec map, so
// a single index-signature type is the right shape — per-system
// interfaces would force casts at every call site.
export interface SiblingSamplePayload {
  _mock: SiblingMockBlock;
  totals_in_canonical_dataset?: Record<string, number>;
  [tableKey: string]: unknown;
}

// Wave-1 lane #27 — GCSS-MC reference adapter freshness.
export interface GcssMcLastSync {
  system: string;
  system_long_name: string;
  environment: string;
  connection_state: string;
  last_sync_at: string;
  age_seconds: number;
  run_id: string;
  records_pulled: {
    asset_master: number;
    readiness_status: number;
    service_requests_open: number;
    supply_documents_open: number;
  };
  next_poll_at: string;
  polling_interval_seconds_nominal: number;
  label_warning: string;
}

// Task #177 — schema-fidelity surfaces. The dictionary endpoint serves the
// derived `dataset/data/gcss_dictionary.json`; the coverage-summary
// endpoint rolls up the consumed/partial/dropped column counts so the
// Integrations hero card can render a single honest pill.
export interface GcssMcCoverageSection {
  id: string;
  title: string;
  total_columns: number;
  consumed: number;
  partial: number;
  dropped: number;
  row_count_real_export: number;
}

export interface GcssMcCoverageSummary {
  generated_at: string | null;
  totals: {
    columns: number;
    consumed: number;
    partial: number;
    dropped: number;
    consumed_pct: number;
  };
  sections: GcssMcCoverageSection[];
}

export interface GcssMcDictionaryTopValue {
  value: string;
  count: number;
  pct: number;
}

export interface GcssMcDictionaryColumn {
  column: string;
  data_type: string;
  nullable: boolean;
  comment: string;
  real_top_3: GcssMcDictionaryTopValue[];
  coverage: {
    level: "consumed" | "partial" | "dropped";
    spire_field: string;
    badge: "green" | "amber" | "red";
    label: string;
  };
}

export interface GcssMcDictionarySection {
  id: string;
  title: string;
  source_csv: string;
  row_count_real_export: number;
  columns: GcssMcDictionaryColumn[];
}

export interface GcssMcDictionary {
  _meta: {
    source: string;
    generated_at: string;
    real_profile: string;
  };
  sections: GcssMcDictionarySection[];
}

export interface HeroMetrics {
  fleet_mc_rate: number;
  fleet_mc_delta_7d: number;
  critical_assets: number;
  parts_on_order: number;
  avg_days_nmc: number;
}

export interface HeatmapUnit {
  unit: string;
  uic: string;
  location: string;
  total_equipment: number;
  rates: Record<string, number | null>;
  equipment_breakdown: Record<string, number>;
}

export interface PulseAlert {
  id: string;
  kind: string;
  severity: string;
  timestamp: string;
  title: string;
  body: string;
}

export interface FleetOverview {
  hero_metrics: HeroMetrics;
  heatmap: HeatmapUnit[];
  equipment_types: string[];
  alerts: PulseAlert[];
  as_of: string;
}

export interface RiskBoardAsset {
  asset_id: string;
  risk_score: number | null;
  band: string;
  primary_factor: string;
  contributing_factors: { factor: string; weighted: number; raw: number }[];
  predicted_failure: string | null;
  equipment_type: string;
  unit_name: string;
  serial_number?: string;
  tamcn?: string;
  current_hours?: number;
  current_miles?: number;
  days_since_maintenance?: number;
  open_sr_count?: number;
  fault_count_30d?: number;
  fault_buckets_30d?: number[];
}

export interface RiskBoard {
  assets: RiskBoardAsset[];
  as_of: string;
}

export interface AssetDeepDive {
  asset: any;
  risk: any;
  timeline: any[];
  component_counts_12mo: Record<string, number>;
  readiness_trajectory: any[];
}

export interface StrippableDonor {
  asset_id: string;
  unit: string;
  equipment_type: string;
  current_status: string;
  days_in_status: number;
  donor_fault_classes: string[];
  strip_reason: string;
  priority: number;
  unit_mc_rate: number;
  unit_mc_count: number;
  unit_total: number;
  // Task #161 -- sub-component slot the donated NSN physically lives in on
  // the donor hull (e.g. "Right rear hub assembly"). Sourced from the
  // equipment_type BOM via backend/bom.py.
  slot?: string;
}

export interface Cannibalization {
  open_needs: any[];
  completed_matches: any[];
  total_events: number;
  // Task #40 -- per-recipient SR strippable donor pool keyed by sr_number.
  // Replaces the broken "other open NMCS needs on the same NSN" derivation
  // (those donors did not actually have the part -- they were waiting for it).
  strippable_donors?: Record<string, StrippableDonor[]>;
}

export interface SyncStateResponse {
  node_id: string;
  peer_node_id: string;
  local_clock: Record<string, number>;
  peer_clock: Record<string, number>;
  events_logged: number;
  conflicts_pending: number;
  compare: "before" | "after" | "equal" | "concurrent" | "no_peer_data";
}

export interface SyncEventBrief {
  event_id: string;
  actor: string;
  at: string;
  clock: Record<string, number>;
  payload: Record<string, unknown>;
}

export interface SyncConflict {
  id: string;
  record_id: string;
  op_kind: string;
  local_event: SyncEventBrief;
  peer_event: SyncEventBrief;
  detected_at: string;
  resolved_at: string | null;
  winner: "local" | "peer" | null;
  resolved_by?: string;
}

export interface SyncConflictsResponse {
  pending: SyncConflict[];
  all: SyncConflict[];
  node_id: string;
}

export interface AdminEngineStat {
  correct: number;
  incorrect: number;
  total: number;
  accuracy: number;
}

export interface InferenceCallEntry {
  ts: string;
  tier: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  latency_ms: number;
  call_site: string;
  route: string;
  role: string | null;
  error: string | null;
  cost_usd: number;
}

export interface InferenceTierRate {
  label: string;
  model: string;
  input_per_1k_usd: number;
  output_per_1k_usd: number;
  p50_latency_ms: number;
  served_locally: boolean;
  notes: string;
}

export interface InferenceTierBucket {
  calls: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  errors: number;
}

export interface InferenceTopSite {
  call_site: string;
  calls: number;
  total_cost_usd: number;
  total_tokens: number;
  avg_latency_ms: number;
  avg_cost_usd: number;
  tiers: Record<string, number>;
}

export interface InferenceEconomics {
  as_of: string;
  rate_card: Record<string, InferenceTierRate>;
  tier_order: string[];
  total_calls: number;
  total_cost_usd: number;
  window_seconds: number;
  recent: {
    calls: number;
    calls_per_minute: number;
    cost_per_minute_usd: number;
    avg_latency_ms: number;
  };
  by_tier: Record<string, InferenceTierBucket>;
  top_call_sites: InferenceTopSite[];
  recent_calls: InferenceCallEntry[];
}

export interface InferenceExtrapolationTier {
  tier: string;
  share: number;
  cost_per_call_usd: number;
  calls_per_day: number;
  daily_cost_usd: number;
}

export interface InferenceExtrapolation {
  force_size: number;
  calls_per_marine_per_day: number;
  ref_input_tokens: number;
  ref_output_tokens: number;
  tier_mix: Record<string, number>;
  by_tier: InferenceExtrapolationTier[];
  daily_calls_total: number;
  blended_cost_per_call_usd: number;
  daily_cost_usd: number;
  annual_cost_usd: number;
  cost_per_marine_per_day_usd: number;
  cost_per_marine_per_year_usd: number;
  all_frontier_daily_cost_usd: number;
  all_frontier_annual_cost_usd: number;
  savings_vs_all_frontier_pct: number;
}

export interface AdminTelemetry {
  total_outcomes: number;
  by_engine: Record<string, AdminEngineStat>;
  by_decision_kind: Record<string, AdminEngineStat>;
  rolling_accuracy: { bucket_end: string; n: number; accuracy: number }[];
  overall_accuracy?: number;
  retraining_recommended: boolean;
  as_of: string;
}

export interface DecisionOutcome {
  id: string;
  decision_kind: string;
  decision_id: string;
  decided_by: string;
  was_correct: boolean;
  observed_at: string;
  notes: string;
  scoring_engine: string;
  logged_at: string;
}

// W1 #30 — Model registry / supply-chain page.
export interface ModelInAppSurface {
  label: string;
  route: string;
}

export interface ModelAuthorization {
  // Task #138 — machine-readable status. Active impls now carry
  // "pre_fielding" with structured ao/package/expiration text instead of
  // bare "TBD — placeholder". Older registry entries (and inactive impls
  // still flagged as placeholder) leave it undefined.
  status?: string | null;
  ao?: string | null;
  package_id?: string | null;
  expiration?: string | null;
  note?: string | null;
}

export interface ModelRegistrySummary {
  id: string;
  name: string;
  purpose: string;
  active_implementation: string;
  active_kind?: string | null;
  hosting_target?: string | null;
  hosting_actual?: string | null;
  hosting_gap_present: boolean;
  authorization?: ModelAuthorization | null;
  fedramp_status?: string | null;
  vendor_name?: string | null;
  vendor_jurisdiction?: string | null;
  vendor_jurisdictions?: string[];
  vendor_foreign_pivot_risk?: string | null;
  last_validated_at?: string | null;
  holdout_accuracy?: number | null;
  in_app_surfaces: ModelInAppSurface[];
}

export interface SupplyChainAtAGlance {
  total_models: number;
  at_risk_jurisdictions: string[];
  at_risk_jurisdictions_count: number;
  // Task #82 — split FedRAMP into honest buckets so the projector doesn't
  // read "all five lack FedRAMP" as the headline. Color is reserved for
  // `models_fedramp_pending` only.
  models_fedramp_covered: number;
  models_fedramp_not_applicable: number;
  models_fedramp_pending: number;
  // Back-compat: equals not_applicable + pending. Kept for any old callers
  // — the new UI splits the bucket explicitly.
  models_without_fedramp_coverage: number;
  models_with_hosting_gap: number;
  models_with_placeholder_provenance: number;
  fedramp_coverage_definition: string;
}

export interface ModelRegistryListResponse {
  registry_version?: string;
  owner?: string;
  models: ModelRegistrySummary[];
  supply_chain_at_a_glance: SupplyChainAtAGlance;
  load_error?: string | null;
}

export interface ModelImplementation {
  kind: string;
  active?: boolean;
  summary: string;
  cross_link?: string;
  provenance: {
    publisher: string;
    repo_url?: string;
    commit_or_version?: string;
    license?: string;
    training_data_lineage?: string;
  };
  hosting: {
    target: string;
    actual: string;
    gap?: string;
  };
  // Task #82 — IL-5 *authorization* is distinct from IL-5 *hosting target*.
  // Optional so older registry entries without the block keep rendering.
  authorization?: ModelAuthorization;
  fedramp_status: string;
  fedramp_note?: string;
  vendor: {
    name: string;
    jurisdiction: string;
    // Canonical multi-jurisdiction list — populated for vendors that span
    // more than one country (e.g. Alphabet US + DeepMind UK).
    jurisdictions?: string[];
    ownership?: string;
    known_acquisitions?: string[];
    foreign_pivot_risk?: string;
    contingency?: string;
  };
  validation: {
    last_validated_at: string;
    holdout_accuracy?: number | null;
    holdout_n?: number | null;
    drift_since_last_retrain?: string;
    method?: string;
  };
  inference_cost: {
    typical_dollars_per_call?: number | null;
    throughput_per_second?: number | null;
    fallback_dollars_per_call?: number | null;
    notes?: string;
  };
  update_policy: {
    cadence: string;
    approver: string;
  };
}

export interface ModelRegistryDetail {
  id: string;
  name: string;
  purpose: string;
  active_implementation: string;
  in_app_surfaces?: ModelInAppSurface[];
  implementations: Record<string, ModelImplementation>;
}

export interface ModelRegistryDetailResponse {
  registry_version?: string;
  model: ModelRegistryDetail;
  active_implementation_block: ModelImplementation | null;
  // Task #130 — backend resolves friendly slugs (e.g. "pulse-risk")
  // to the canonical registry id ("pulse-risk-scorer") so the legend
  // link in PULSE Forecast lands on a real detail page.
  resolved_model_id?: string;
}

export interface FeedbackRecord {
  id: string;
  title: string;
  body: string;
  severity: string;
  role: string;
  view: string;
  submitted_at: string;
  github_issue_url?: string | null;
  github_issue_number?: number;
}

export interface AuditQueryParams {
  actors?: string[];
  kinds?: string[];
  resource?: string[];
  classification?: string;
  after?: string;
  before?: string;
  q?: string;
  only_anomalies?: boolean;
  only_role_only?: boolean;
  limit?: number;
  offset?: number;
}

export interface AuditIdentity {
  dodid: string;
  name: string;
  rank: string;
  role: string;
  unit: string;
}

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  kind: string;
  subject_id: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  self_hash: string;
  chain_ok: boolean;
  anomaly_tag: "broken_chain" | "spillage_prevented" | "downgrade_blocked" | "blocked_or_error" | null;
  classification: string;
  model_invoked: string;
  source_ip: string;
  outcome: "success" | "blocked" | "error";
  identity: AuditIdentity;
}

export interface AuditQueryResult {
  rows: AuditEntry[];
  total: number;
  head_hash: string;
  broken_at_id: number | null;
  anomaly_count: number;
  role_only_count: number;
  kinds_in_view: string[];
  actors_in_view: string[];
  limit: number;
  offset: number;
  facets: {
    actors: { actor: string; count: number }[];
    kinds:  { kind:  string; count: number }[];
  };
  storage: {
    encrypted_at_rest: boolean;
    db_path: string;
  };
}

export interface CommsStateResponse {
  current_state: "CONNECTED" | "DEGRADED" | "DISCONNECTED";
  as_of: string;
  recent_events: { at: string; from?: string | null; to: string; reason: string; node_id: string }[];
  queued_ops_count: number;
  last_sync_at?: string | null;
  air_gap_active: boolean;
}

// B4 — Mission clock + scenario timeline. Polled by the topbar element.
export interface ScenarioEvent {
  event_id: string;
  offset_min: number;
  title: string;
  payload: Record<string, unknown>;
  fired_at_offset: number | null;
  fired_wall: string | null;
}

export interface ScenarioPhase {
  offset_min: number;
  label: string;
}

export interface ScenarioState {
  now_wall: string;
  running: boolean;
  rate: number;
  allowed_rates: number[];
  offset_min: number;
  offset_label: string;
  phase: string;
  phase_started_at_offset_min: number;
  max_offset_min: number;
  phases: ScenarioPhase[];
  fired_events: ScenarioEvent[];
  upcoming_events: ScenarioEvent[];
  registry_count: number;
}

export type ScenarioControlAction = "play" | "pause" | "set_rate" | "seek" | "reset";

export interface AirGapToggleResult {
  ok: boolean;
  air_gap_active: boolean;
  no_change?: boolean;
  engaged_at?: string;
  released_at?: string;
  replayed?: number;
  resolutions?: { local_id: string; op_kind: string; actor: string; queued_at: string; replayed_at: string; result: string }[];
}

// Task #25 — shape returned by `/system/admin/reset-demo`. The summary
// counts let the toast and any future presenter overlay show what was
// actually wiped (handy when the operator runs the reset twice in a row
// and the second pass shows zeros — confirms the first pass landed).
//
// `ok=false` + a populated `failed_steps` array indicates a partial
// reset. The backend returns HTTP 207 (Multi-Status) in that case;
// 207 is in `Response.ok`'s 200–299 range so `jsonFetch` parses it
// just like a 200, leaving the FE to read `ok`/`failed_steps` to
// decide success vs. warning toast.
export interface ResetDemoResult {
  ok: boolean;
  reset_at: string;
  duration_ms: number;
  summary: {
    bastion: { alert_states_cleared?: number; active_sims_cleared?: number; error?: string };
    air_gap_released: boolean;
    queued_ops_dropped: number;
    comms_timeline_regenerated: boolean;
    decision_outcomes_cleared: number;
    feedback_log_cleared: number;
    mission_clock: { h0_at?: string; offset_seconds?: number; last_reset_by?: string | null; error?: string };
    duration_ms: number;
  };
  failed_steps: { step: string; error: string }[];
  next_step: string;
}

export interface CoalitionProfileSummary {
  key: string;
  display_name: string;
  partners: string[];
  distribution: string;
  embargo_days: number;
}

export interface CoalitionView {
  profile_key: string;
  display_name: string;
  partners: string[];
  distribution_statement: string;
  authorized_classifications: string[];
  /** Rank-derived ceiling label (e.g. "UNCLASSIFIED", "CUI") backed by
   *  `classification_rank()`, so callers don't have to assume the
   *  `authorized_classifications` array is sorted ascending. */
  classification_ceiling?: string;
  caveats_applied: string[];
  embargo_days_after_event: number;
  scope: {
    units_allowed: number;
    units_blocked: number;
    sample_srs_allowed: number;
    sample_srs_blocked: number;
    sample_srs_total_inspected: number;
    /** Count (within the inspected sample) of records whose source
     * classification exceeds the profile's authorized ceiling. Drives
     * the red-tint signal on the Generate Release button (F1). */
    sample_srs_over_ceiling?: number;
    /** Capped drill-down list of the over-ceiling records (SR number +
     * source classification) so the confirmation modal can show the
     * operator *which* records they're acknowledging instead of just a
     * count. (Task #154.) */
    sample_srs_over_ceiling_list?: { sr_number: string; classification: string }[];
  };
  allowed_units: { unit: string; parent: string; uic: string; location: string }[];
  sample_records: {
    sr_number?: string;
    unit_name?: string;
    equipment_type?: string;
    fault_component?: string;
    fault_component_original?: string;
    remark_preview?: string;
    remark_original?: string;
    redactions?: string[];
    redaction_spans?: {
      field: string;
      before: string;
      after: string;
      kind: string;
    }[];
  }[];
  partner_units: { name: string; type: string; point_of_contact?: string }[];
  field_redactions: string[];
  as_of: string;
}

export interface CoalitionReleaseResult {
  ok: boolean;
  release_id: string;
  profile: string;
  partners: string[];
  distribution_statement: string;
  caveats_applied: string[];
  audit_logged: boolean;
  created_at: string;
  /** SHA-256 over the sorted in-scope SR ID set + the profile's
   * redaction policy + the profile key. Stored in the audit row so an
   * investigator can later prove what shipped, not just that something
   * did. (F13.) */
  manifest_sha256: string;
  /** Number of in-scope SR records covered by the manifest hash. */
  record_count: number;
  /** Inherited classification ceiling stamped onto the audit row. */
  classification?: string;
  /** Task #154 — over-ceiling sample count the operator was prompted on
   * (0 means the acknowledgement gate never applied). */
  over_ceiling_sample_count?: number;
  /** Task #154 — whether the operator ticked the over-ceiling
   * acknowledgement checkbox before typing RELEASE. Stamped onto the
   * audit row alongside the manifest hash. */
  over_ceiling_acknowledged?: boolean;
}

export interface FailurePrediction {
  component: string;
  probability: number;
  predicted_window_days: number;
  confidence: number;
  engine: string;
  mtbf_hours: number;
  mttr_days?: number;
  criticality: string;
  common_failure_modes: string[];
}

export interface PredictedFailureAsset {
  asset_id: string;
  unit_name: string;
  equipment_type: string;
  current_hours: number;
  predictions: FailurePrediction[];
}

export interface PredictFailuresResponse {
  assets: PredictedFailureAsset[];
  horizon_days: number;
  threshold: number;
  engine: string;
  as_of: string;
}

export interface RecommendedAction {
  kind: "cannibalize" | "expedite" | "cross_level" | "redistribute";
  title: string;
  description: string;
  cost_usd: number;
  time_to_effect_hours: number;
  /** Expected MC-rate delta as a 0..1 fraction (0.6 = +60 percentage points). */
  mc_delta_pct: number;
  /** Confidence as a 0..1 fraction. */
  confidence: number;
  score: number;
  artifact: Record<string, unknown>;
  approval_roles: string[];
}

export interface RecommendActionsAsset {
  asset_id: string;
  unit_name: string;
  equipment_type: string;
  risk_score?: number;
  primary_factor?: string;
  actions: RecommendedAction[];
}

export interface RecommendActionsResponse {
  assets: RecommendActionsAsset[];
  as_of: string;
}

export interface PulseDraft {
  draft_id: string;
  asset_id: string;
  unit_name: string;
  kind: string;
  title: string;
  description: string;
  cost_usd: number | null;
  mc_delta_pct: number | null;
  time_to_effect_hours: number | null;
  artifact: Record<string, unknown>;
  actor: string;
  status: "held" | "dismissed" | "expired";
  created_at: string;
}

export interface ModelCardBaseline {
  key: string;
  name: string;
  source: string;
  is_model: boolean;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  n: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  mission_weighted: number;
}

export interface ModelCardDriftPoint {
  period: string;
  n: number;
  nmc_rate: number;
  avg_days_deadlined: number;
}

export interface ModelCardDriftAlert {
  feature: string;
  feature_label: string;
  last_period: string;
  z_score: number;
  delta_pct: number | null;
}

export interface ModelCard {
  engine: {
    public_label: string;
    internal_id: string;
    weights_path: string | null;
    errors: string[];
  };
  loss_function: {
    headline: string;
    details: string;
    weights: { false_positive: number; false_negative: number };
    horizon_days: number;
  };
  tradeoffs: string[];
  baselines: ModelCardBaseline[];
  split: {
    train_start: string;
    train_end: string;
    train_n: number;
    val_start: string;
    val_end: string;
    val_n: number;
    test_start: string;
    test_end: string;
    test_n: number;
    split_method: string;
    holdout_integrity: string;
  };
  confusion_matrix: {
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    n: number;
    split: string;
  };
  drift: {
    series: ModelCardDriftPoint[];
    alerts: ModelCardDriftAlert[];
    method: string;
  };
  last_validation: {
    date: string;
    validator: string;
    validator_role: string;
    methodology: string;
    methodology_link: string;
  };
  canonical_model_card_url: string;
  // Task #130 — same calibration metric the Forecast tab reports.
  // Lets the model-card detail page render the regression-band coverage
  // (and its 50/80/95 reliability bins) without a second round-trip
  // to /forecast.
  forecast_calibration?: {
    coverage_p10_p90: number | null;
    coverage_n: number;
    coverage_target: number;
    methodology: string;
    reliability_bins: { nominal: number; realized: number | null; n: number }[];
    window_days: number;
    backtest_days: number;
  };
  as_of: string;
}

export interface Forecast {
  unit: string;
  history: { date: string; mc_rate: number; pmc_rate: number; nmc_rate: number }[];
  projection: {
    date: string;
    projected_mc_rate: number;
    confidence_lower: number;
    confidence_upper: number;
    p10: number;
    p50: number;
    p90: number;
    cross_probability: number;
  }[];
  paths: number[][];
  threshold: number;
  threshold_cross_date: string | null;
  cross_probabilities: { date: string; p: number }[];
  as_of?: string;
  data_window_days?: number;
  coverage_p10_p90?: number | null;
  coverage_n?: number;
  coverage_target?: number;
  model_card_url?: string;
}

export interface SentryBatch {
  batch_id: string;
  source: string;
  created_at: string;
  record_count: number;
  status: string;
  schema_detected: Record<string, string>;
  data_quality: {
    passed: number;
    flagged: number;
    flags: { type: string; count: number }[];
  };
  preview: {
    sr_number: string;
    equipment_type: string;
    unit_name: string;
    remark_preview: string;
    source_classification: string;
  }[];
  jobs: string[];
  // Set when an upload is detected as a real GCSS-MC SR-header export.
  // Backed by `backend/integrations/sentry_gcss_adapter.IngestReport`.
  // Absent for canonical demo seeds and generic CSV/XLSX/JSON uploads.
  gcss_ingest_report?: GcssIngestReport;
}

export interface GcssIngestReport {
  rows_total: number;
  rows_kept: number;
  rows_filtered_pmcs: number;
  rows_with_warnings: number;
  defect_code_trailing_period_normalized: number;
  date_parse_failures: number;
  schema_warnings: string[];
  unique_sr_numbers: number;
  adapter: string;
  // "enforced" when no clear (non-hashed) UICs were accepted.
  sanitization_gate: "enforced" | string;
}

// Task #67 — `scope` is the role-scoping descriptor SENTRY routes return
// so the FE can render an honest "Showing N of M (CLB-6 only)" footer.
// `unrestricted=true` means the caller's role sees the entire batch.
export interface SentryScope {
  role: string;
  unrestricted: boolean;
  allowed_units: string[];
  total_records: number;
  scoped_records: number;
  label: string;
}

export interface SentryJob {
  job_id: string;
  batch_id: string;
  records_processed: number;
  total: number;
  tier1_handled: number;
  tier2_handled: number;
  flag_counts: Record<string, number>;
  classification_counts: Record<string, number>;
  mismatches: number;
  aggregation_risks: any[];
  // Task #65: backend wall-time for the synchronous classification pass
  // and which engines were actually invoked. tier2_handled is "would-route"
  // when engine_used === "rule_based_only" (the LLM tier is offline).
  engine_seconds?: number;
  engine_used?: "rule_based_only" | "rule_based_plus_model";
  sentry_model_loaded?: boolean;
  pulse_model_loaded?: boolean;
  done: boolean;
  scope?: SentryScope;
}

export interface SentryReviewQueue {
  batch_id: string;
  auto_cleared: any[];
  flagged: any[];
  held: any[];
  counts: { auto_cleared: number; flagged: number; held: number };
  aggregation_risks: any[];
  scope?: SentryScope;
}

export interface MarkResult {
  recommended_classification: string;
  confidence: number;
  flags: string[];
  caveats_recommended: string[];
  evidence: { flag: string; evidence: string; rule: string }[];
  release_authority_requested: string;
  // Walkthrough #4 — release-authority validator output.
  release_compatibility?: {
    status: "ok" | "warn" | "block";
    issues: string[];
  };
  // Task-61 — engine-derived distribution + single REL TO so the panel
  // stops rendering a hardcoded "Distribution C" for every sample.
  distribution_statement?: {
    letter: string;
    label: string;
    description: string;
  };
  rel_to_caveat?: string;
  // Caveats the engine auto-added (and the evidence that triggered them),
  // surfaced so the operator can see what was self-introduced.
  auto_caveats?: {
    caveat: string;
    evidence: string;
    rule: string;
    reason: string;
  }[];
  audit: {
    engine: string;
    engine_version?: string;
    timestamp: string;
    // Chain index returned by the backend's append-only audit table.
    // Lets the right-pane "Audit trail" panel render the same row id
    // an investigator sees in the audit-log viewer.
    chain_index?: number;
    chain_subject?: string;
    input_hash?: string;
    actor_dodid?: string;
    actor_name?: string;
    actor_role?: string;
  };
}

export interface ExportResult {
  ok: boolean;
  export_id: string;
  filename?: string;
  bytes?: number;
  release_authority: string;
  format: string;
  // Walkthrough #6 — input batch size for record-count clarity.
  records_input?: number;
  records_exported: number;
  records_rejected: number;
  decisions_applied: number;
  redactions_applied: number;
  distribution_statement: string;
  // Walkthrough #5 — independent fields.
  rel_to_caveat?: string;
  distribution_authority?: string;
  // Task-172 — content-driven letter + dominant-evidence "why". The selector
  // now aggregates the union of `sensitive_flags_oracle` across the included
  // records, so a CUI bundle with controlled-item serials gets B (not C).
  distribution_letter?: string;
  distribution_reason?: string;
  distribution_evidence_flags?: string[];
  generalized_unit_markings?: boolean;
  download_url: string;
  created_at: string;
  // Task-22 — bundle classification auto-inherited from the highest source
  // classification across included records. The FE badge + clearance gate
  // read this; the backend re-checks on /download.
  classification?: string;
  classification_banner?: string;
  // Task-69 — release-compatibility validator output. `status="warn"` carries
  // a populated `release_warnings` array the FE renders as a yellow banner;
  // `status="block"` cases raise 403 (release_blocked) and never reach here.
  release_compatibility?: {
    status: "ok" | "warn" | "block";
    issues: string[];
    caveats: string[];
  };
  release_warnings?: string[];
}

export interface BastionCOPUnit {
  unit: string;
  uic: string;
  parent: string;
  location: string;
  home_building: string | null;  // building.id where this unit's HQ/MP sits
  lat: number;
  lon: number;
  total_equipment: number;
  mc_rate: number;
  mc_count: number;
  pmc_count: number;
  nmcm_count: number;
  nmcs_count: number;
  equipment_breakdown: Record<string, number>;
  alerts: { kind: string; severity: string }[];
  data_integrity_flags: number;
}

export interface Building {
  id: string;
  name: string;
  type: string;
  grid: string;
  lat?: number;
  lon?: number;
  occupancy_capacity: number;
  current_occupancy: number;
  floors: number;
  hazmat_present: boolean;
  critical_infrastructure: boolean;
  nearest_rally_point: string;
  utilities?: Record<string, string>;
  notes?: string;
}

export interface RallyPoint {
  id: string;
  name: string;
  grid: string;
  lat?: number;
  lon?: number;
  capacity: number;
}

export interface ECP {
  id: string;
  name: string;
  grid: string;
  lat?: number;
  lon?: number;
  status: string;
  lanes_in: number;
  lanes_out: number;
  commercial_access?: boolean;
  notes?: string;
}

export interface BastionCOP {
  installation: { name: string; description: string; fictional: boolean };
  center: { lat: number; lon: number };
  units: BastionCOPUnit[];
  buildings: Building[];
  buildings_count: number;
  ecps: ECP[];
  rally_points: RallyPoint[];
  response_forces_count: number;
  as_of: string;
}

export interface FusedThreat {
  id: string;
  source: "FUSION";
  severity: "CRITICAL" | "HIGH" | "MODERATE" | "LOW" | "INFO";
  timestamp: string;
  title: string;
  body: string;
  unit?: string | null;
  building?: string | null;
  fused: true;
  confidence: number;
  correlation_chain: { source: string; id: string; title: string; timestamp: string; label?: string }[];
  response_taskings: string[];
}

export interface AlertState {
  status: "acknowledged" | "snoozed" | "resolved";
  at: string;
  snooze_until?: string;
}

export interface BastionAlert {
  id: string;
  source: string;
  severity: string;
  timestamp: string;
  title: string;
  body: string;
  unit?: string;
  location?: string;
  grid?: string;
  correlated_with?: any[];
  fpcon_recommended?: string;
  model_info?: any;
  response_available?: boolean;
  // Per-alert state baked in by the backend so the front-end never has
  // to infer ack / snooze / resolve from local component state.
  _state?: AlertState;
}

export interface BastionAlertsResponse {
  alerts: BastionAlert[];
  fused_threats?: FusedThreat[];
  total: number;
  severity_counts: Record<string, number>;
}

export interface IncidentResponse {
  incident_number: string;
  type: string;
  severity: string;
  location: string;
  location_grid: string;
  fpcon_at_time: string;
  fpcon_change: string | null;
  initial_report: string;
  checklist: {
    title: string;
    immediate: string[];
    followon: string[];
    notifications: { who: string; draft_ready: boolean }[];
  };
  response_force_assigned: string;
  estimated_response_minutes: number;
}

export interface ThermalHawkSim {
  sim_id: string;
  alert: BastionAlert;
  checklist: IncidentResponse["checklist"];
  cordon_zones: { radius_m: number; label: string }[];
  response_forces_dispatched: string[];
}

export interface ThermalHawkFeedBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

export interface ThermalHawkFeedFrame {
  frame_idx: number;
  frame_png_b64: string;
  boxes: ThermalHawkFeedBox[];
  latency_ms: number;
  source: string;
  source_path: string | null;
  score_threshold: number;
  frame_count_in_loop: number;
  input_size: number;
  source_size: [number, number];
}

export interface ThermalHawkFeedInfo {
  model_loaded: boolean;
  frame_count_in_loop: number;
  source: string;
  default_score_threshold: number;
  model_metadata: {
    model?: string;
    parameters?: number;
    architecture?: string;
    training?: string;
    deployment_target?: string;
    validation_map_50_95?: number;
  };
}

export interface NLQueryResult {
  intent: string;
  result: any;
}

// ---- Joint COP export types ------------------------------------------------
//
// Mirrors the OMS/UCI + MIL-STD-6016 export envelopes. Loose `any` for the
// individual message payloads — joint partner views render them tabularly,
// not via strongly-typed access.

export interface JointClassification {
  marking: string;
  releasability: string;
  controlSystem?: string;
  dissemination?: string;
  originatorCountry?: string;
}

export interface JointOperatorFooter {
  name: string;
  rank: string;
  billet: string;
  role: string;
  unit: string;
  dodid: string;
}

export interface JointOmsUciEnvelope {
  specification: string;
  specificationVersion: string;
  messageStandard: string;
  subscriptionModel?: string;
  sourceSystem: string;
  sourceSystemVersion: string;
  sourceService: string;
  sourceUnit: string;
  // Wall-clock at which the SPIRE scenario state was last advanced
  // (mission-clock anchor). Freezes when the scenario is paused so the
  // JLTC "Published T-Ns" pill can stop counting and the operator can
  // see SPIRE's clock has stopped. See backend/scenario.published_wall_iso.
  publishedAtUtc: string;
  // Data-as-of moment for the readiness numbers in this envelope —
  // sourced from the dataset snapshot, distinct from publishedAtUtc.
  // The JLTC topbar renders this as a sibling "As-of" pill.
  asOfUtc?: string;
  classification: JointClassification;
  operator?: JointOperatorFooter;
  messageCounts: Record<string, number>;
}

export interface JointOmsUciExport {
  envelope: JointOmsUciEnvelope;
  messages: {
    EntityState: any[];
    TrackData: any[];
    LogisticsStatus: any[];
    AlertNotification: any[];
  };
}

export interface JointLink16Header {
  specification: string;
  specificationVersion: string;
  messageFamily: string;
  operatingMode: string;
  subscriptionModel?: string;
  sourceSystem: string;
  sourceJU: string;
  originatorService: string;
  // See JointOmsUciEnvelope for the publishedAtUtc / asOfUtc split.
  publishedAtUtc: string;
  asOfUtc?: string;
  classification: JointClassification;
  operator?: JointOperatorFooter;
  messageCounts: Record<string, number>;
}

export interface JointLink16Export {
  header: JointLink16Header;
  messages: {
    J3_5_LandPointTrack: any[];
    J3_3_SurfaceTrack: any[];
    J7_0_TrackManagement: any[];
    J7_2_TrackCorrelation: any[];
    J28_2_LogisticsStatus: any[];
  };
}

export interface JointStandardEntry {
  name: string;
  version: string;
  owner: string;
  spireRole: string;
  endpoint: string;
  messages: string[];
  notWired: string[];
}

export interface JointReleaseAuthority {
  subscriptionModel: string;
  summary: string;
  allowedRoles: string[];
  deniedRolesExample: string[];
  auditFooter: string;
}

export interface JointConformance {
  standardsAdopted: JointStandardEntry[];
  classificationPosture: {
    exportClassification: string;
    releasability: string;
    rationale: string;
    gate: string;
  };
  releaseAuthority?: JointReleaseAuthority;
  directionPolicy: {
    egress: string;
    ingress: string;
    rationale: string;
  };
  sisterServiceDemonstration: {
    endpoint: string;
    shell: string;
    purpose: string;
  };
  outOfScope: string[];
  publishedAtUtc: string;
}

// Task-24 — Decision Bridge ("15-second decision" hero dashboard).
// Each tile drives off a narrow aggregator under /api/decision-bridge/*.

export interface DecisionBridgeMission {
  fpcon_default: "NORMAL" | "ALPHA" | "BRAVO" | "CHARLIE" | "DELTA";
  installation_name: string;
  parent_command: string;
  mission_essential_task?: string | null;
  mission_objective?: string | null;
  ccir: string[];
  dataset_day: string | null;
  as_of: string;
}

export interface DecisionBridgeAlerts {
  alerts: BastionAlert[];
  severity_counts: Record<string, number>;
  total: number;
  as_of: string;
}

export interface DecisionBridgeShortage {
  kind: "class_ix" | "class_viii" | "class_iii";
  label: string;
  item: string;
  nsn?: string;
  location?: string;
  units_affected: (string | null)[];
  units_affected_count: number;
  open_requisitions?: number;
  hours_to_stockout: number;
  drill_unit: string | null;
  // Class IX justification — populated only for class_ix rows.
  // Tells the operator *why* an NSN landed on the bridge: the NMCS /
  // PMC SR counts feeding it and the oldest open requisition's age.
  nmcs_sr_count?: number;
  pmc_sr_count?: number;
  max_age_days?: number;
}

export interface DecisionBridgeShortages {
  shortages: DecisionBridgeShortage[];
  categories_present: string[];
  as_of: string;
}

export interface DecisionBridgeMcUnit {
  unit: string;
  current_mc_rate: number;
  delta_7d: number;
  sparkline_7d: number[];
  asset_total: number;
  mc_count: number;
}

export interface DecisionBridgeMcByUnit {
  units: DecisionBridgeMcUnit[];
  as_of: string;
  dataset_day?: string;
}

export interface DecisionBridgeAudit {
  chain_ok: boolean;
  total_entries: number;
  head_hash?: string;
  events_per_minute: number;
  events_in_window: number;
  window_minutes: number;
  last_entry_at: string | null;
  last_entry_kind: string | null;
  last_anomaly: { broken_at_id: number; as_of: string } | null;
  as_of: string;
}

// W2 Task #37 — Blood vignette metadata served by /api/scenario/blood-h72.
// The scenario engine FE polls this once on /demo entry to get the beat
// list (narration, view targets, expected per-beat dwell). Mirrors the
// shape returned by `backend/scenario_blood.scenario_meta()`. Unknown
// keys are tolerated — the player only reads the fields it knows about.
export interface BloodScenarioBeatMeta {
  beat_id: string;
  event_id: string;
  offset_min: number;
  phase: string;
  title: string;
  /** Dotted view target (e.g. "bastion.map", "pulse.forecast"). The
   * player resolves this to a concrete /-route via VIEW_ROUTE_MAP. */
  view: string;
  overlay: {
    highlight?: string;
    callouts?: string[];
  };
  narration: string;
  expected_duration_seconds_at_1x: number;
  inject_kinds: string[];
  sources: string[];
  /** Per-beat classification (Task #50) — stamped on the cockpit
   * timeline row + narration overlay so a single screenshot of the
   * presenter surface self-marks. Defaults to "CUI" when absent. */
  classification?: string;
}

export interface BloodScenarioMeta {
  loaded?: boolean;
  scenario_id: string;
  version: string;
  title: string;
  summary: string;
  duration_minutes: number;
  phases: { offset_min: number; label: string }[];
  beats: BloodScenarioBeatMeta[];
  speed_validation?: {
    presenter_narration_total_seconds?: number;
    rehearsal_dwell_seconds_per_beat?: number;
  };
  global_sources?: string[];
}

// Round-4 — events buffer served by /api/system/scenario/blood-h72/feed.
// One row per scripted injection (alert / forecast / requisition / toast).
// The consumer only treats `kind`, `offset_min`, `beat_id`, `payload` as
// authoritative; unknown keys are tolerated.
export interface BloodScenarioFeedEvent {
  kind: string;
  offset_min: number;
  beat_id?: string;
  event_id?: string;
  phase?: string;
  payload?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface BloodScenarioFeed {
  scenario_id: string;
  events: BloodScenarioFeedEvent[];
  as_of: string;
}
