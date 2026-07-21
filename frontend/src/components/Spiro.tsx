/**
 * Spiro — operator-facing AI assistant powered by Gemma 4. Persona: a Marine staff officer in software form. Direct, risk-averse, loyal to the operator. Backronym: S-P-I-R-O = Synthesis · Prediction · Intelligence · Readiness · Officer.
 *
 * Persistent right-edge panel (collapsible) on every view. Conversational
 * chat: operator types, presses Enter (or Send), the message lands in the
 * scrollback and the input clears. Each turn is one of:
 *   - direct answer (rendered as a normal assistant message)
 *   - plan with tool calls (rendered as an inline plan card with
 *     Approve & Run / Cancel — execution result lands as the next message
 *     from SPIRO so the audit trail reads as a transcript).
 *
 * Walkthrough caught the previous one-shot panel behavior: typing a
 * second question wiped the first. Operators expect chat semantics.
 *
 * Branding rationale: SPIRO extends the existing SPIRE backronym one letter
 * (S-P-I-R-O = Synthesis, Prediction, Intelligence, Readiness, Officer).
 * No trademark conflicts (unlike "Co-Pilot" which Microsoft + GitHub
 * own for AI coding assistants), and fits SPIRE's defense-grade tone.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useSpireStore } from "../state/store";
import { DemoOnly } from "../state/buildMode";
import { Button, IconButton, Pressable } from "./ui";
import {
  getMapBridge,
  findMarkerById,
  findMarkerByLabel,
  findMarkerByPulseUnit,
  haversineKm,
} from "../state/mapBridge";
import { OKINAWA_SCENARIO } from "../data/okinawa-scenario";
import { csrfHeaders } from "../api";

/** Clean an ollama/proxy model id into an operator-facing name. */
function prettyModel(raw: string): string {
  if (!raw) return "Local LLM";
  // "hf.co/unsloth/gemma-4-E4B-it-GGUF:Q3_K_M" -> "Gemma 4 E4B"
  const m = raw.match(/gemma-?(\d)[-_]?(e\d+b)/i);
  if (m) return `Gemma ${m[1]} ${m[2].toUpperCase()}`;
  // "qwen2.5:3b" -> "Qwen2.5 3B"
  const base = raw.split("/").pop() ?? raw;
  const [name, tag] = base.split(":");
  const nice = name.replace(/^qwen/i, "Qwen").replace(/^llama/i, "Llama");
  return tag ? `${nice} ${tag.toUpperCase()}` : nice;
}

/** Header engine label from the /api/llm/tiers probe. Reflects the tier that
 *  would actually serve the next call, so the header never claims a model the
 *  node isn't running. */
function spiroEngineLabel(tiers: {
  active_tier?: string;
  primary?: { model?: string };
  local?: { target_model?: string };
}): string {
  if (tiers.active_tier === "primary" && tiers.primary?.model) {
    return prettyModel(tiers.primary.model);
  }
  if (tiers.active_tier === "local" && tiers.local?.target_model) {
    return `${prettyModel(tiers.local.target_model)} · Local`;
  }
  return "Rule-based";
}

interface PlanStep { tool: string; args: Record<string, any>; id?: string; }
interface SpiroPlanEconomics {
  tier: string;
  model: string;
  call_site: string;
  route: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
}
interface SpiroPlan {
  plan_id: string;
  intent: string;
  summary: string;
  answer: string | null;
  steps: PlanStep[];
  engine: string;
  tokens_used: number | null;
  economics?: SpiroPlanEconomics | null;
}
interface SpiroResult {
  plan_id: string;
  executed_at: string;
  step_results: Array<{
    step: number;
    tool: string;
    args: Record<string, any>;
    result: any;
    had_error: boolean;
  }>;
  ok_count: number;
  error_count: number;
}

// One conversational turn. Plain answers and tool-plans both render as
// assistant messages; tool-plan execution results land as a separate
// assistant message so the transcript reads top-down.
type ChatMessage =
  | { id: string; kind: "user"; text: string; at: number }
  | { id: string; kind: "answer"; text: string; at: number; economics?: SpiroPlanEconomics | null }
  | { id: string; kind: "plan"; plan: SpiroPlan; at: number; status: "pending" | "approved" | "cancelled" }
  | { id: string; kind: "result"; result: SpiroResult; at: number }
  | { id: string; kind: "error"; text: string; at: number };

const SPIRO_KEY = "spire.spiro.opened";

function uid() { return Math.random().toString(36).slice(2, 10); }

export function Spiro() {
  const role = useSpireStore((s) => s.role);
  const location = useLocation();
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(SPIRO_KEY) === "1"; } catch { return false; }
  });
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<"plan" | "execute" | null>(null);
  const [rawOpen, setRawOpen] = useState<Record<string, boolean>>({});
  // Active engine label, resolved from whatever model the node actually serves
  // (SPIRE ships model-optional; the header must not claim a model that isn't
  // loaded). Falls back to a neutral name until the probe returns.
  const [engineLabel, setEngineLabel] = useState("SPIRE Officer");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/llm/tiers", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((t) => {
        if (cancelled || !t) return;
        setEngineLabel(spiroEngineLabel(t));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Persist open state.
  useEffect(() => {
    try { localStorage.setItem(SPIRO_KEY, open ? "1" : "0"); } catch {}
  }, [open]);

  // Ctrl+/ to toggle SPIRO panel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "/") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Auto-scroll to the bottom whenever a message lands.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  // Map-selection bridge — the BASTION map's MarkerDrawer dispatches
  // `spire:map-selection` whenever a marker is selected/cleared. We
  // capture the marker id so the next planner request can include the
  // selection context, and we listen for `spire:open-spiro` (fired by
  // the drawer's "Ask SPIRO" button) to open the panel + pre-fill.
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  useEffect(() => {
    function onSelection(ev: Event) {
      const detail = (ev as CustomEvent).detail || {};
      setSelectedMarkerId(detail.markerId ?? null);
    }
    function onOpen(ev: Event) {
      const detail = (ev as CustomEvent).detail || {};
      setOpen(true);
      if (typeof detail.prompt === "string") {
        setText(detail.prompt);
        // Defer focus until after the panel transition.
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    }
    window.addEventListener("spire:map-selection", onSelection);
    window.addEventListener("spire:open-spiro", onOpen);
    return () => {
      window.removeEventListener("spire:map-selection", onSelection);
      window.removeEventListener("spire:open-spiro", onOpen);
    };
  }, []);

  // Focus the input whenever the panel opens.
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Walk the message log backwards to find the most recent assistant
  // turn that proposed tools but the operator never executed. That
  // proposal is forwarded to the planner so a follow-up "go" / "do it"
  // consents to it instead of forcing a re-plan.
  function lastUnexecutedProposal(): PlanStep[] | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.kind === "user") continue;
      if (m.kind === "result") return null;
      if (m.kind === "plan") {
        if (m.status === "approved" || m.status === "cancelled") return null;
        return m.plan.steps;
      }
      if (m.kind === "answer" || m.kind === "error") continue;
    }
    return null;
  }

  // Project the message log into the OpenAI-shape {role, content} pairs
  // SPIRO's planner expects. Only user prompts and assistant answers
  // count — plan/result/error rows are operator-facing chrome that
  // wouldn't help the model. Cap to the most recent 10 turns to bound
  // the token cost; the backend re-clips to the same length defensively.
  function historyForPlanner(): { role: "user" | "assistant"; content: string }[] {
    const turns: { role: "user" | "assistant"; content: string }[] = [];
    for (const m of messages) {
      if (m.kind === "user") {
        turns.push({ role: "user", content: m.text });
      } else if (m.kind === "answer") {
        turns.push({ role: "assistant", content: m.text });
      }
    }
    return turns.slice(-10);
  }

  async function send(overrideText?: string) {
    const t = (overrideText ?? text).trim();
    if (!t || pending) return;
    const userMsg: ChatMessage = { id: uid(), kind: "user", text: t, at: Date.now() };
    // Snapshot history BEFORE the new user message lands in state so we
    // don't double-count the current prompt — the backend takes
    // `history` (prior turns) and `text` (current) as separate inputs.
    const priorHistory = historyForPlanner();
    setMessages((m) => [...m, userMsg]);
    if (!overrideText) setText("");
    setPending("plan");
    try {
      // Map-selection context: when an operator clicks a marker on the
      // BASTION map, the next SPIRO turn carries that marker as
      // explicit context so follow-ups like "and how about this one?"
      // resolve against the on-screen selection.
      const sel = selectedMarkerId ? findMarkerById(selectedMarkerId) : null;
      const map_selection = sel
        ? {
            id: sel.id,
            label: sel.label,
            parent: sel.parent,
            island: sel.island,
            pulse_unit: sel.pulseUnit ?? null,
            coords: sel.coords,
          }
        : null;
      const r = await fetch("/api/copilot/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...csrfHeaders() },
        credentials: "same-origin",
        body: JSON.stringify({
          text: t,
          role,
          view: location.pathname,
          prior_proposal: lastUnexecutedProposal(),
          history: priorHistory,
          map_selection,
        }),
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const j = (await r.json()) as SpiroPlan;
      const replyId = uid();
      if (j.steps && j.steps.length > 0) {
        setMessages((m) => [
          ...m,
          { id: replyId, kind: "plan", plan: j, at: Date.now(), status: "pending" },
        ]);
      } else {
        setMessages((m) => [
          ...m,
          {
            id: replyId,
            kind: "answer",
            text: (j.answer || j.summary || "").trim() || "(no response)",
            at: Date.now(),
            economics: j.economics ?? null,
          },
        ]);
      }
    } catch (e: any) {
      setMessages((m) => [
        ...m,
        { id: uid(), kind: "error", text: `SPIRO unreachable — ${String(e).slice(0, 200)}`, at: Date.now() },
      ]);
    } finally {
      setPending(null);
    }
  }

  // Run a map_* tool against the live MapBridge. Returns the
  // step_results-shaped record the chat transcript expects.
  function runMapStep(step: PlanStep, idx: number): {
    step: number;
    tool: string;
    args: Record<string, any>;
    result: any;
    had_error: boolean;
  } {
    const bridge = getMapBridge();
    try {
      switch (step.tool) {
        case "map_fly_to": {
          // Accept either {island}, {marker_id}, {pulse_unit}, {label},
          // or {lng,lat,zoom}. Resolve to coordinates and fly.
          const a = step.args || {};
          let coords: [number, number] | null = null;
          let zoom: number | undefined = a.zoom;
          if (typeof a.lng === "number" && typeof a.lat === "number") {
            coords = [a.lng, a.lat];
          } else if (typeof a.island === "string") {
            const presets: Record<string, { center: [number, number]; zoom: number }> = {
              okinawa: { center: [127.85, 26.45], zoom: 9 },
              miyako: { center: [125.31, 24.79], zoom: 11 },
              ishigaki: { center: [124.16, 24.4], zoom: 11 },
            };
            const p = presets[a.island.toLowerCase()];
            if (p) { coords = p.center; zoom = zoom ?? p.zoom; }
          } else if (typeof a.marker_id === "string") {
            const m = findMarkerById(a.marker_id);
            if (m) { coords = m.coords; zoom = zoom ?? 12; }
          } else if (typeof a.pulse_unit === "string") {
            const m = findMarkerByPulseUnit(a.pulse_unit);
            if (m) { coords = m.coords; zoom = zoom ?? 12; }
          } else if (typeof a.label === "string") {
            const m = findMarkerByLabel(a.label);
            if (m) { coords = m.coords; zoom = zoom ?? 12; }
          }
          if (!coords) {
            return { step: idx, tool: step.tool, args: a, had_error: true,
              result: { error: "could_not_resolve_target" } };
          }
          if (bridge) bridge.flyTo(coords[0], coords[1], zoom);
          return { step: idx, tool: step.tool, args: a, had_error: false,
            result: { coords, zoom: zoom ?? null, bridge_attached: !!bridge } };
        }
        case "map_select_marker": {
          const a = step.args || {};
          let id: string | null = null;
          if (typeof a.marker_id === "string") id = a.marker_id;
          else if (typeof a.label === "string") {
            const m = findMarkerByLabel(a.label);
            id = m?.id ?? null;
          } else if (typeof a.pulse_unit === "string") {
            const m = findMarkerByPulseUnit(a.pulse_unit);
            id = m?.id ?? null;
          }
          if (!id) return { step: idx, tool: step.tool, args: a, had_error: true,
            result: { error: "could_not_resolve_target" } };
          if (bridge) {
            bridge.selectMarker(id);
            const m = findMarkerById(id);
            if (m) bridge.flyTo(m.coords[0], m.coords[1], 12);
          }
          return { step: idx, tool: step.tool, args: a, had_error: false,
            result: { selected_id: id, bridge_attached: !!bridge } };
        }
        case "map_list_markers": {
          const a = step.args || {};
          const filter = (a.island || "").toLowerCase();
          const list = OKINAWA_SCENARIO
            .filter((m) => !filter || m.island === filter)
            .map((m) => ({
              id: m.id, label: m.label, parent: m.parent,
              island: m.island, pulse_unit: m.pulseUnit ?? null,
              coords: m.coords,
            }));
          return { step: idx, tool: step.tool, args: a, had_error: false,
            result: { count: list.length, markers: list } };
        }
        case "map_query_within_radius": {
          const a = step.args || {};
          const km = Number(a.radius_km) || 100;
          let center: [number, number] | null = null;
          if (typeof a.lng === "number" && typeof a.lat === "number") {
            center = [a.lng, a.lat];
          } else if (typeof a.marker_id === "string") {
            center = findMarkerById(a.marker_id)?.coords ?? null;
          } else if (typeof a.label === "string") {
            center = findMarkerByLabel(a.label)?.coords ?? null;
          }
          if (!center) return { step: idx, tool: step.tool, args: a, had_error: true,
            result: { error: "could_not_resolve_center" } };
          const within = OKINAWA_SCENARIO
            .map((m) => ({ marker: m, km: haversineKm(center!, m.coords) }))
            .filter((x) => x.km <= km)
            .sort((a, b) => a.km - b.km)
            .map((x) => ({
              id: x.marker.id, label: x.marker.label, parent: x.marker.parent,
              island: x.marker.island, pulse_unit: x.marker.pulseUnit ?? null,
              distance_km: Math.round(x.km * 10) / 10,
            }));
          return { step: idx, tool: step.tool, args: a, had_error: false,
            result: { center, radius_km: km, count: within.length, matches: within } };
        }
        default:
          return { step: idx, tool: step.tool, args: step.args || {}, had_error: true,
            result: { error: `unknown_map_tool: ${step.tool}` } };
      }
    } catch (e: any) {
      return { step: idx, tool: step.tool, args: step.args || {}, had_error: true,
        result: { error: String(e).slice(0, 200) } };
    }
  }

  async function approve(planMsgId: string, plan: SpiroPlan) {
    if (pending) return;
    setPending("execute");
    setMessages((m) =>
      m.map((x) => (x.id === planMsgId && x.kind === "plan" ? { ...x, status: "approved" } : x)),
    );
    try {
      // Partition: map_* steps run client-side via the MapBridge; the
      // rest go to the backend tool registry. Both flows feed into a
      // single SpiroResult so the transcript reads as one approval.
      const mapSteps = plan.steps.filter((s) => s.tool.startsWith("map_"));
      const backendSteps = plan.steps.filter((s) => !s.tool.startsWith("map_"));
      const stepResults: any[] = mapSteps.map((s, i) => runMapStep(s, i));
      let backendResult: SpiroResult | null = null;
      if (backendSteps.length > 0) {
        const r = await fetch("/api/copilot/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...csrfHeaders() },
          credentials: "same-origin",
          body: JSON.stringify({ plan_id: plan.plan_id, steps: backendSteps, role }),
        });
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        backendResult = (await r.json()) as SpiroResult;
        // Renumber backend step indices so they line up after the map
        // steps in the merged transcript.
        const offset = mapSteps.length;
        for (const sr of backendResult.step_results) {
          stepResults.push({ ...sr, step: sr.step + offset });
        }
      }
      const ok_count = stepResults.filter((s) => !s.had_error).length;
      const error_count = stepResults.length - ok_count;
      const merged: SpiroResult = {
        plan_id: plan.plan_id,
        executed_at: backendResult?.executed_at ?? new Date().toISOString(),
        step_results: stepResults,
        ok_count,
        error_count,
      };
      setMessages((m) => [...m, { id: uid(), kind: "result", result: merged, at: Date.now() }]);
    } catch (e: any) {
      setMessages((m) => [
        ...m,
        { id: uid(), kind: "error", text: `Execute failed — ${String(e).slice(0, 200)}`, at: Date.now() },
      ]);
    } finally {
      setPending(null);
    }
  }

  function cancelPlan(planMsgId: string) {
    setMessages((m) =>
      m.map((x) => (x.id === planMsgId && x.kind === "plan" ? { ...x, status: "cancelled" } : x)),
    );
  }

  function clearChat() {
    setMessages([]);
  }

  // Per-role example prompts surface only when the chat is empty so they
  // don't clutter an in-progress transcript.
  const examplesForRole = useMemo(() => {
    if (role === "maintenance_chief") {
      return [
        "find a cannib donor for M21670-MTVR_CARGO-006",
        "what should I do about my fleet right now?",
        "predict failures in the next 14 days",
      ];
    }
    if (role === "g4") {
      return [
        "what should I do about my fleet right now?",
        "predict failures in the next 14 days",
        "show me the highest-risk units across all of MEF",
      ];
    }
    if (role === "data_custodian") {
      return [
        "what does Japan see in the next coalition release?",
        "what does Australia see in the next release?",
        "what should I do about my fleet right now?",
      ];
    }
    if (role === "security_manager") {
      return [
        "show me the highest-risk units across all of MEF",
        "predict failures in the next 14 days",
        "where do I start?",
      ];
    }
    return [
      "find a cannib donor for M21670-MTVR_CARGO-006",
      "what should I do about my fleet right now?",
      "what does Japan see?",
      "predict failures in the next 14 days",
      "where do I start?",
    ];
  }, [role]);

  function fillExample(s: string) {
    setText(s);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // Step-result statuses so the transcript can render OK/EMPTY/ERROR with
  // an honest tone — empty results aren't successes.
  function isEmptyResult(r: any): boolean {
    if (r == null) return true;
    if (typeof r !== "object") return false;
    if (typeof (r as any).count === "number" && (r as any).count === 0) return true;
    for (const k of ["actions", "predictions", "candidates", "matches", "results", "items", "donors", "assets"]) {
      const v = (r as any)[k];
      if (Array.isArray(v) && v.length === 0) return true;
    }
    return false;
  }
  function stepStatus(sr: { had_error: boolean; result: any }): "ok" | "empty" | "error" {
    if (sr.had_error) return "error";
    if (sr.result && (sr.result as any).error) return "error";
    if (isEmptyResult(sr.result)) return "empty";
    return "ok";
  }

  // Per-tool operator-readable formatter. Returns a one-line summary of the
  // tool's result so the chat reads like a conversation, not a JSON dump.
  // The raw JSON stays accessible via the SHOW RAW toggle for engineering
  // sanity-checks.
  function formatResult(tool: string, r: any): string | null {
    if (!r || typeof r !== "object") return null;
    if (r.error) return String(r.error);
    try {
      switch (tool) {
        case "status_summary": {
          const worst: any[] = r.worst_units || [];
          const head = worst[0];
          const dead = r.deadlined_in_scope ?? r.deadlined ?? "?";
          const tail = worst.slice(1, 3).map((u) => `${u.unit} ${u.mc_pct}%`).join(", ");
          if (!head) return `${r.your_assets ?? "?"} assets in scope · ${dead} deadlined.`;
          return `${dead} deadlined · worst: ${head.unit} ${head.mc_pct}% MC (${head.mc} MC / ${head.pmc} PMC / ${head.nmcm} NMCM / ${head.nmcs} NMCS / ${head.total} total)${tail ? ` · also ${tail}` : ""}.`;
        }
        case "recommend_actions": {
          const acts: any[] = r.actions || [];
          if (!acts.length) return "No recommendations in scope.";
          const top = acts.slice(0, 3).map((a) =>
            `${a.title || a.kind} (${a.unit_name || a.asset_id || "?"}, $${a.cost_usd}, +${(a.mc_delta_pct * 100).toFixed(0)}% conf ${(a.confidence * 100).toFixed(0)}%)`
          ).join(" · ");
          return `${acts.length} ranked actions: ${top}${acts.length > 3 ? ` · +${acts.length - 3} more` : ""}.`;
        }
        case "predict_failures": {
          const preds: any[] = r.predictions || [];
          if (!preds.length) return `No failures predicted in next ${r.horizon_days || "?"}d.`;
          return `${preds.length} predicted failures within ${r.horizon_days || "?"}d (top: ${preds[0]?.asset_id || "?"} ${preds[0]?.component || ""}).`;
        }
        case "find_asset": {
          const a = r.asset || r;
          const eq = (a.equipment_type || "?").replace(/_/g, " ");
          return `${a.asset_id || "?"}: ${eq} · ${a.unit_name || "?"} · ${a.current_status || a.status || "?"}.`;
        }
        case "search_assets": {
          const items: any[] = r.matches || r.assets || [];
          return `${items.length} assets matched${items[0] ? ` (e.g. ${items[0].asset_id})` : ""}.`;
        }
        case "find_cannibalization_match": {
          const cands: any[] = r.candidates || [];
          if (!cands.length) return "No donor candidates found.";
          const c = cands[0];
          return `${cands.length} donor candidates · best: ${c.donor_asset_id || c.asset_id} (${c.unit_name || "?"}).`;
        }
        case "get_coalition_view": {
          // Walkthrough audit: prior format used unit_count/asset_count/
          // redaction_count fields the API never returned. Read what the
          // payload actually carries: allowed_units list + sample count
          // + applied caveats.
          const partners = Array.isArray(r.partners) ? r.partners.join(", ") : "?";
          const ucount = r.unit_count ?? (Array.isArray(r.allowed_units) ? r.allowed_units.length : "?");
          return `${r.display_name || r.profile || "?"} (${partners}): ${ucount} units in scope · ${r.sample_count ?? "?"} sample records · ${(r.caveats_applied || []).length} caveats applied.`;
        }
      }
    } catch { /* fall through to null */ }
    return null;
  }

  // Collapsed-pill view — small button on the right edge.
  //
  // Quiet idle. The vertical SPIRO tab used to render in primary blue
  // with a 18% tint, holding the right edge against view content. It's
  // an opener tab, not a primary control — neutral chrome at idle keeps
  // the eye on the surface. Hover + active use lift it back to primary
  // so the affordance is unmistakable.
  if (!open) {
    return (
      <Pressable
        onClick={() => setOpen(true)}
        block={false}
        className="pointer-events-auto fixed right-0 top-1/2 z-[8400] !min-h-0 -translate-y-1/2 rounded-l-md border border-r-0 border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-3 font-mono text-xs font-semibold uppercase text-[var(--color-text-secondary)] shadow-md backdrop-blur transition-all hover:px-3 hover:border-[var(--color-primary)] hover:bg-[color-mix(in_oklab,var(--color-primary)_18%,var(--color-surface))] hover:text-[var(--color-primary)] tracking-widest"
        style={{ writingMode: "vertical-rl" }}
        title="Open SPIRO (Ctrl+/)"
        aria-label="Open SPIRO assistant (Ctrl+/)"
      >
        ◆ SPIRO
      </Pressable>
    );
  }

  return (
    <aside
      // Walkthrough audit (round 2): SPIRO at top: 56px (just below
      // TopBar) covered the classification banner (the legal/audit
      // 'UNCLASSIFIED // SYNTHETIC DATA' green strip that sits between
      // TopBar and main content). Push SPIRO below the banner so the
      // banner stays visible end-to-end. 88px = 56px TopBar + 32px band.
      className="pointer-events-auto fixed right-0 bottom-0 z-[8400] flex w-full max-w-[26rem] flex-col border-l border-[var(--color-primary)] bg-[var(--color-surface)] shadow-2xl"
      style={{ top: "5.5rem" }}
      role="complementary"
      aria-label="SPIRO"
    >
      {/* Header */}
      <div className="flex items-baseline justify-between border-b border-[var(--color-border)] px-4 py-3">
        <div>
          <div className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
            ◆ SPIRO · {engineLabel}
          </div>
          <DemoOnly>
            <div className="mt-0.5 font-mono text-[10px] text-[var(--color-text-muted)] tracking-wide">
              Tell SPIRO what you want. SPIRO plans; you approve before anything runs.
            </div>
          </DemoOnly>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <Button onClick={clearChat} variant="ghost" size="sm" title="Clear conversation">
              Clear
            </Button>
          )}
          <IconButton onClick={() => setOpen(false)} aria-label="Close SPIRO">
            ✕
          </IconButton>
        </div>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3">
        {messages.length === 0 && (
          <DemoOnly>
            <div className="font-mono text-[10px] leading-relaxed text-[var(--color-text-muted)] tracking-wide">
              <div className="mb-2 text-xs uppercase text-[var(--color-text-secondary)] tracking-widest">
                Examples · click to use
              </div>
              <ul className="flex flex-col gap-1.5">
                {examplesForRole.map((ex) => (
                  <li key={ex}>
                    <Pressable
                      onClick={() => fillExample(ex)}
                      className="!min-h-0 block w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-left font-mono text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-primary)] hover:bg-[color-mix(in_oklab,var(--color-primary)_10%,var(--color-bg))] hover:text-[var(--color-text)]"
                      title="Click to drop this example into the prompt"
                    >
                      "{ex}"
                    </Pressable>
                  </li>
                ))}
              </ul>
            </div>
          </DemoOnly>
        )}

        <div className="flex flex-col gap-2.5">
          {messages.map((m, i) => {
            if (m.kind === "user") {
              return (
                <div key={m.id} className="self-end max-w-[88%] rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_15%,var(--color-bg))] px-3 py-1.5 font-mono text-xs leading-relaxed text-[var(--color-text)]">
                  {m.text}
                </div>
              );
            }
            if (m.kind === "answer") {
              // Quick-action chips appear under the most-recent answer
              // only — gives the operator a click-out from a chat dead end
              // ("Stand by. State your requirement.") into a real plan.
              const isLatestAnswer = i === messages.length - 1;
              return (
                <div key={m.id} className="self-start max-w-[92%] rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs leading-relaxed text-[var(--color-text)]">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="font-mono text-[10px] font-semibold uppercase text-[var(--color-primary)] tracking-widest">◆ SPIRO</div>
                  </div>
                  <div>{m.text}</div>
                  {isLatestAnswer && pending === null && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <QuickChip label="Status" onClick={() => send("where do I start?")} disabled={pending !== null} />
                      <QuickChip label="Predict failures" onClick={() => send("predict failures in 14 days")} disabled={pending !== null} />
                      <QuickChip label="Recommend actions" onClick={() => send("what should I do about my fleet?")} disabled={pending !== null} />
                      <QuickChip label="Run all" onClick={() => send("go")} disabled={pending !== null} />
                    </div>
                  )}
                </div>
              );
            }
            if (m.kind === "error") {
              return (
                <div key={m.id} className="self-start max-w-[92%] rounded-sm border border-[var(--color-danger)] bg-[color-mix(in_oklab,var(--color-danger-muted)_20%,transparent)] px-3 py-2 font-mono text-xs leading-relaxed text-[var(--color-danger)]">
                  {m.text}
                </div>
              );
            }
            if (m.kind === "plan") {
              const p = m.plan;
              return (
                <div key={m.id} className="self-start w-full rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_8%,var(--color-bg))] px-3 py-2 font-mono text-xs leading-relaxed text-[var(--color-text)]">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="font-mono text-[10px] font-semibold uppercase text-[var(--color-primary)] tracking-widest">◆ SPIRO · proposed plan</div>
                  </div>
                  <div className="mb-2">{p.summary || `Run ${p.steps.length} tool${p.steps.length === 1 ? "" : "s"}.`}</div>
                  <ol className="mb-2 flex flex-col gap-1">
                    {p.steps.map((s, i) => (
                      <li key={i} className="flex gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
                        <span className="font-semibold text-[var(--color-primary)]">{i + 1}.</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-[var(--color-text)]">{s.tool}</div>
                          {Object.keys(s.args || {}).length > 0 && (
                            <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]" title={JSON.stringify(s.args)}>
                              {JSON.stringify(s.args)}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                  {m.status === "pending" && (
                    <div className="flex items-center gap-2">
                      <Button
                        onClick={() => approve(m.id, p)}
                        disabled={pending !== null}
                        pending={pending === "execute"}
                        variant="primary"
                        size="md"
                        fullWidth
                        className="!border-[var(--color-success)] !bg-[var(--color-success)]"
                      >
                        {pending === "execute" ? "Executing…" : "Approve & Run"}
                      </Button>
                      <Button
                        onClick={() => cancelPlan(m.id)}
                        disabled={pending !== null}
                        variant="secondary"
                        size="md"
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                  {m.status === "approved" && (
                    <div className="font-mono text-[10px] text-[var(--color-success)] tracking-widest uppercase">✓ Approved · executed</div>
                  )}
                  {m.status === "cancelled" && (
                    <div className="font-mono text-[10px] text-[var(--color-text-muted)] tracking-widest uppercase">— Cancelled</div>
                  )}
                </div>
              );
            }
            // result
            const r = m.result;
            const statuses = r.step_results.map((sr) => stepStatus(sr));
            const errorCount = statuses.filter((s) => s === "error").length;
            const emptyCount = statuses.filter((s) => s === "empty").length;
            const okCount = statuses.filter((s) => s === "ok").length;
            const overall: "ok" | "empty" | "error" = errorCount > 0 ? "error" : emptyCount > 0 ? "empty" : "ok";
            const headerColor = overall === "error" ? "var(--color-danger)" : overall === "empty" ? "var(--color-warning)" : "var(--color-success)";
            return (
              <div key={m.id} className="self-start w-full flex flex-col gap-2">
                <div
                  className="rounded-sm border p-2 font-mono text-xs"
                  style={{ borderColor: headerColor, background: `color-mix(in oklab, ${headerColor} 10%, var(--color-bg))` }}
                >
                  <span style={{ color: headerColor }}>{okCount}/{r.step_results.length} steps with results</span>
                  {emptyCount > 0 && (<span className="ml-2 text-[var(--color-warning)]">{emptyCount} returned nothing</span>)}
                  {errorCount > 0 && (<span className="ml-2 text-[var(--color-danger)]">{errorCount} errors</span>)}
                </div>
                {r.step_results.map((sr, i) => {
                  const st = statuses[i];
                  const tone = st === "error" ? "var(--color-danger)" : st === "empty" ? "var(--color-warning)" : "var(--color-success)";
                  const label = st === "error" ? "ERROR" : st === "empty" ? "EMPTY" : "OK";
                  const glyph = st === "error" ? "✗" : st === "empty" ? "⚠" : "✓";
                  const prose = st === "ok" ? formatResult(sr.tool, sr.result) : null;
                  const rawKey = `${m.id}:${i}`;
                  const showRaw = rawOpen[rawKey] === true;
                  return (
                    <div
                      key={i}
                      className="rounded-sm border bg-[var(--color-bg)] p-2 font-mono text-xs"
                      style={{ borderColor: st === "ok" ? "var(--color-border)" : `color-mix(in oklab, ${tone} 40%, var(--color-border))` }}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[var(--color-text)]">{sr.tool}</span>
                        <span style={{ color: tone }}>{glyph} {label}</span>
                      </div>
                      {st === "empty" && (
                        <div className="mt-1 text-[10px] italic text-[var(--color-warning)] tracking-wide">
                          Tool ran but produced no results — try a different scope or accept "nothing found."
                        </div>
                      )}
                      {prose && (
                        <div className="mt-1.5 text-[11px] leading-snug text-[var(--color-text)]">
                          {prose}
                        </div>
                      )}
                      <Pressable
                        onClick={() => setRawOpen((s) => ({ ...s, [rawKey]: !showRaw }))}
                        block={false}
                        className="!min-h-0 mt-1.5 text-[10px] font-mono uppercase tracking-widest text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
                      >
                        {showRaw ? "▾ HIDE RAW JSON" : "▸ SHOW RAW JSON"}
                      </Pressable>
                      {showRaw && (
                        <pre className="mt-1.5 max-h-[14rem] overflow-auto whitespace-pre-wrap break-words text-[10px] text-[var(--color-text-secondary)]">
                          {JSON.stringify(sr.result, null, 2).slice(0, 1500)}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {pending === "plan" && (
            <div className="self-start max-w-[60%] rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs leading-relaxed text-[var(--color-text-muted)]">
              <span className="inline-block h-1.5 w-1.5 mr-1.5 rounded-full bg-[var(--color-primary)] animate-pulse" />
              SPIRO is thinking…
            </div>
          )}
        </div>
      </div>

      {/* Composer — Enter sends, Shift+Enter newline. */}
      <div className="border-t border-[var(--color-border)] p-3">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder={
            role === "maintenance_chief"
              ? "Ask SPIRO… e.g. find a cannib donor for M21670-MTVR_CARGO-006"
              : role === "g4"
              ? "Ask SPIRO… e.g. what should I do about my fleet right now?"
              : role === "data_custodian"
              ? "Ask SPIRO… e.g. what does Japan see in the next coalition release?"
              : role === "security_manager"
              ? "Ask SPIRO… e.g. show me the highest-risk units across all of MEF"
              : "Ask SPIRO…"
          }
          className="w-full resize-none rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-xs text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="font-mono text-[10px] text-[var(--color-text-muted)] tracking-wide">
            Enter to send · Shift+Enter for newline
          </span>
          <Button
            onClick={() => send()}
            disabled={!text.trim()}
            pending={pending === "plan"}
            variant="primary"
            size="sm"
          >
            {pending === "plan" ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </aside>
  );
}

// QuickChip — small click-out shown under the latest SPIRO answer when
// the model returned prose instead of a plan. Lets the operator dispatch
// a deterministic intent ("status", "predict failures", "recommend
// actions", "run all") without having to retype.
function QuickChip({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-primary)] transition-colors hover:border-[var(--color-primary)] hover:bg-[color-mix(in_oklab,var(--color-primary)_10%,var(--color-surface))] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}

