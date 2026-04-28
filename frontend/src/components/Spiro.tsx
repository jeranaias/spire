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
import { Button, IconButton, Pressable } from "./ui";

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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  async function send(overrideText?: string) {
    const t = (overrideText ?? text).trim();
    if (!t || pending) return;
    const userMsg: ChatMessage = { id: uid(), kind: "user", text: t, at: Date.now() };
    setMessages((m) => [...m, userMsg]);
    if (!overrideText) setText("");
    setPending("plan");
    try {
      const r = await fetch("/api/copilot/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: t,
          role,
          view: location.pathname,
          prior_proposal: lastUnexecutedProposal(),
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

  async function approve(planMsgId: string, plan: SpiroPlan) {
    if (pending) return;
    setPending("execute");
    setMessages((m) =>
      m.map((x) => (x.id === planMsgId && x.kind === "plan" ? { ...x, status: "approved" } : x)),
    );
    try {
      const r = await fetch("/api/copilot/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: plan.plan_id, steps: plan.steps, role }),
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const j = (await r.json()) as SpiroResult;
      setMessages((m) => [...m, { id: uid(), kind: "result", result: j, at: Date.now() }]);
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
  if (!open) {
    return (
      <Pressable
        onClick={() => setOpen(true)}
        block={false}
        className="pointer-events-auto fixed right-0 top-1/2 z-[8400] !min-h-0 -translate-y-1/2 rounded-l-md border border-r-0 border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_18%,var(--color-surface))] px-2 py-3 font-mono text-xs font-semibold uppercase text-[var(--color-primary)] shadow-lg backdrop-blur transition-all hover:px-3 hover:bg-[color-mix(in_oklab,var(--color-primary)_28%,var(--color-surface))] tracking-widest"
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
            ◆ SPIRO · SPIRE Officer · Gemma 4
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-[var(--color-text-muted)] tracking-wide">
            Tell SPIRO what you want. SPIRO plans; you approve before anything runs.
          </div>
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
                    <CostBadge econ={m.economics} />
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
                    <CostBadge econ={p.economics} />
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
            onClick={send}
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

// D3 — per-call cost surfaced inline next to the SPIRO output. Tier
// abbreviation makes the badge readable at a glance ("T1 · $0.0002")
// rather than overwhelming the chat bubble. Hidden if the call ran
// rule-only (cost == 0 and tier0_rule).
function CostBadge({ econ }: { econ?: { tier: string; cost_usd: number; latency_ms: number; model: string; call_site: string } | null }) {
  if (!econ) return null;
  const tierShort: Record<string, string> = {
    tier0_rule: "T0",
    tier1_small: "T1",
    tier2_mid: "T2",
    tier3_frontier: "T3",
  };
  const tone =
    econ.tier === "tier3_frontier" ? "var(--color-danger)" :
    econ.tier === "tier2_mid" ? "var(--color-warning)" :
    econ.tier === "tier1_small" ? "var(--color-primary)" :
    "var(--color-success)";
  const cost = econ.cost_usd === 0
    ? "$0"
    : econ.cost_usd >= 0.01
      ? `$${econ.cost_usd.toFixed(3)}`
      : `$${econ.cost_usd.toFixed(5).replace(/0+$/, "").replace(/\.$/, ".0")}`;
  return (
    <span
      className="rounded-sm border px-1.5 py-[1px] font-mono text-[10px] tabular-nums tracking-wider"
      style={{
        color: tone,
        borderColor: `color-mix(in oklab, ${tone} 40%, var(--color-border))`,
        background: `color-mix(in oklab, ${tone} 6%, transparent)`,
      }}
      title={`${econ.model} · ${econ.call_site} · ${econ.latency_ms.toFixed(0)} ms`}
    >
      {tierShort[econ.tier] || econ.tier} · {cost}
    </span>
  );
}
