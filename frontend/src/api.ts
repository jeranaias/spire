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

async function jsonFetch<T>(path: string, init?: RequestInit, injectRole = true): Promise<T> {
  const url = injectRole ? withRole(path) : path;
  const resp = await fetch(`${BASE}${url}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`${resp.status} ${resp.statusText}: ${body.slice(0, 200)}`);
  }
  return resp.json() as Promise<T>;
}

export const api = {
  system: {
    status: () => jsonFetch<SystemStatus>("/system/status"),
    commsState: () => jsonFetch<CommsStateResponse>("/system/comms/state"),
    setAirGap: (enable: boolean, reason?: string) =>
      jsonFetch<AirGapToggleResult>("/system/comms/airgap", {
        method: "POST",
        body: JSON.stringify({ enable, reason: reason ?? "operator-initiated" }),
      }, false),
    queueOp: (op_kind: string, payload: unknown, actor: string) =>
      jsonFetch<{ ok: boolean; local_id: string; queued_at: string; queue_depth: number }>(
        "/system/comms/queue",
        { method: "POST", body: JSON.stringify({ op_kind, payload, actor }) },
        false,
      ),
    adminTelemetry: () => jsonFetch<AdminTelemetry>("/system/admin/telemetry"),
    adminOutcomes: (limit = 50, kind?: string) => {
      const sp = new URLSearchParams();
      sp.set("limit", String(limit));
      if (kind) sp.set("decision_kind", kind);
      return jsonFetch<{ outcomes: DecisionOutcome[]; total: number }>(`/system/admin/outcomes?${sp}`);
    },
    adminFeedback: () => jsonFetch<{ feedback: FeedbackRecord[]; total: number }>("/system/feedback"),
  },
  pulse: {
    fleetOverview: () => jsonFetch<FleetOverview>("/pulse/fleet-overview"),
    riskBoard: (top = 20) => jsonFetch<RiskBoard>(`/pulse/risk-board?top=${top}`),
    assetDeepDive: (assetId: string) => jsonFetch<AssetDeepDive>(`/pulse/assets/${encodeURIComponent(assetId)}`),
    cannibalization: () => jsonFetch<Cannibalization>("/pulse/cannibalization"),
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
  },
  sentry: {
    demoBatch: (limit = 500) => jsonFetch<SentryBatch>(`/sentry/demo-batch?limit=${limit}`),
    process: (batchId: string) =>
      jsonFetch<{ job_id: string; batch_id: string }>(`/sentry/process/${batchId}`, { method: "POST" }),
    jobStatus: (jobId: string) => jsonFetch<SentryJob>(`/sentry/jobs/${jobId}`),
    reviewQueue: (batchId: string) => jsonFetch<SentryReviewQueue>(`/sentry/review-queue/${batchId}`),
    review: (sr: string, action: "approve" | "reject" | "modify", note = "") =>
      jsonFetch<{ ok: boolean }>(`/sentry/review/${sr}/${action}`, {
        method: "POST",
        body: JSON.stringify({ note, role: "data_custodian" }),
      }),
    mark: (text: string, release_authority = "US_ONLY") =>
      jsonFetch<MarkResult>("/sentry/mark", {
        method: "POST",
        body: JSON.stringify({ text, release_authority }),
      }),
    export: (release = "US_ONLY", format = "xlsx") =>
      jsonFetch<ExportResult>("/sentry/export", {
        method: "POST",
        body: JSON.stringify({ release_authority: release, format, include_audit: true }),
      }),
    coalitionProfiles: () =>
      jsonFetch<{ profiles: CoalitionProfileSummary[] }>("/sentry/coalition/profiles"),
    coalitionView: (profileKey: string) =>
      jsonFetch<CoalitionView>(`/sentry/coalition/${encodeURIComponent(profileKey)}`),
    coalitionRelease: (profileKey: string) =>
      jsonFetch<CoalitionReleaseResult>(`/sentry/coalition/${encodeURIComponent(profileKey)}/release`, {
        method: "POST",
        body: JSON.stringify({ actor_role: "data_custodian" }),
      }),
  },
  bastion: {
    cop: () => jsonFetch<BastionCOP>("/bastion/cop"),
    alerts: (limit = 30) => jsonFetch<{ alerts: BastionAlert[]; fused_threats?: FusedThreat[] }>(`/bastion/alerts?limit=${limit}`),
    fusedThreats: () => jsonFetch<{ fused_threats: FusedThreat[] }>("/bastion/fused-threats"),
    incidents: (limit = 50) => jsonFetch<{ incidents: any[] }>(`/bastion/incidents?limit=${limit}`),
    incidentResponse: (id: string) => jsonFetch<IncidentResponse>(`/bastion/incidents/${id}/response`),
    simulateThermalHawk: (unit = "CLB-6") =>
      jsonFetch<ThermalHawkSim>(`/bastion/simulate/thermalhawk-detection`, {
        method: "POST",
        body: JSON.stringify({ unit }),
      }),
    clearSim: (id: string) =>
      jsonFetch<{ ok: boolean }>(`/bastion/simulate/clear/${id}`, { method: "POST" }),
    nlQuery: (text: string) =>
      jsonFetch<NLQueryResult>(`/bastion/nl-query`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
  },
  llm: {
    status: () => jsonFetch<{ reachable: boolean; model_id?: string; max_context?: number }>("/llm/status"),
  },
};

// ---- Types (trimmed to what views consume) --------------------------------

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
}

export interface RiskBoard {
  assets: RiskBoardAsset[];
}

export interface AssetDeepDive {
  asset: any;
  risk: any;
  timeline: any[];
  component_counts_12mo: Record<string, number>;
  readiness_trajectory: any[];
}

export interface Cannibalization {
  open_needs: any[];
  completed_matches: any[];
  total_events: number;
}

export interface AdminEngineStat {
  correct: number;
  incorrect: number;
  total: number;
  accuracy: number;
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

export interface CommsStateResponse {
  current_state: "CONNECTED" | "DEGRADED" | "DISCONNECTED";
  as_of: string;
  recent_events: { at: string; from?: string | null; to: string; reason: string; node_id: string }[];
  queued_ops_count: number;
  last_sync_at?: string | null;
  air_gap_active: boolean;
}

export interface AirGapToggleResult {
  ok: boolean;
  air_gap_active: boolean;
  no_change?: boolean;
  engaged_at?: string;
  released_at?: string;
  replayed?: number;
  resolutions?: { local_id: string; op_kind: string; actor: string; queued_at: string; replayed_at: string; result: string }[];
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
  caveats_applied: string[];
  embargo_days_after_event: number;
  scope: {
    units_allowed: number;
    units_blocked: number;
    sample_srs_allowed: number;
    sample_srs_blocked: number;
    sample_srs_total_inspected: number;
  };
  allowed_units: { unit: string; parent: string; uic: string; location: string }[];
  sample_records: {
    sr_number?: string;
    unit_name?: string;
    equipment_type?: string;
    fault_component?: string;
    remark_preview?: string;
    redactions?: string[];
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
  mc_delta_pct: number;
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
  done: boolean;
}

export interface SentryReviewQueue {
  batch_id: string;
  auto_cleared: any[];
  flagged: any[];
  held: any[];
  counts: { auto_cleared: number; flagged: number; held: number };
  aggregation_risks: any[];
}

export interface MarkResult {
  recommended_classification: string;
  confidence: number;
  flags: string[];
  caveats_recommended: string[];
  evidence: { flag: string; evidence: string; rule: string }[];
  release_authority_requested: string;
  audit: { engine: string; timestamp: string };
}

export interface ExportResult {
  ok: boolean;
  export_id: string;
  filename?: string;
  bytes?: number;
  release_authority: string;
  format: string;
  records_exported: number;
  records_rejected: number;
  decisions_applied: number;
  redactions_applied: number;
  distribution_statement: string;
  generalized_unit_markings?: boolean;
  download_url: string;
  created_at: string;
}

export interface BastionCOPUnit {
  unit: string;
  uic: string;
  parent: string;
  location: string;
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
  correlation_chain: { source: string; id: string; title: string; timestamp: string }[];
  response_taskings: string[];
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

export interface NLQueryResult {
  intent: string;
  result: any;
}
