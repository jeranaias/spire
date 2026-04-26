/**
 * Spiro — operator-facing AI assistant powered by Gemma 4. Persona: a Marine staff officer in software form. Direct, risk-averse, loyal to the operator. Backronym: S-P-I-R-O = Synthesis · Prediction · Intelligence · Readiness · Officer.
 *
 * Persistent right-edge panel (collapsible) on every view. The operator
 * describes what they want in plain English; Gemma returns a plan as a
 * list of tool calls; operator clicks Approve to execute.
 *
 * The whole point: a Marine doesn't need a tutorial. They ask SPIRO
 * what's possible. SPIRO routes them to the right action with a
 * one-click approval gate.
 *
 * Branding rationale: SPIRO extends the existing SPIRE backronym one letter
 * (S-P-I-R-O = Synthesis, Prediction, Intelligence, Readiness, Officer).
 * No trademark conflicts (unlike "Co-Pilot" which Microsoft + GitHub
 * own for AI coding assistants), and fits SPIRE's defense-grade tone.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useSpireStore } from "../state/store";

interface PlanStep { tool: string; args: Record<string, any>; id?: string; }
interface SpiroPlan {
  plan_id: string;
  intent: string;
  summary: string;
  answer: string | null;
  steps: PlanStep[];
  engine: string;
  tokens_used: number | null;
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

const SPIRO_KEY = "spire.spiro.opened";

export function Spiro() {
  const role = useSpireStore((s) => s.role);
  const location = useLocation();
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(SPIRO_KEY) === "1"; } catch { return false; }
  });
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<SpiroPlan | null>(null);
  const [result, setResult] = useState<SpiroResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  async function ask() {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    setPlan(null);
    setResult(null);
    try {
      const r = await fetch("/api/copilot/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), role, view: location.pathname }),
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const j = (await r.json()) as SpiroPlan;
      setPlan(j);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function approve() {
    if (!plan) return;
    setExecuting(true);
    setError(null);
    try {
      const r = await fetch("/api/copilot/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: plan.plan_id, steps: plan.steps, role }),
      });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const j = (await r.json()) as SpiroResult;
      setResult(j);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setExecuting(false);
    }
  }

  function reset() {
    setText("");
    setPlan(null);
    setResult(null);
    setError(null);
  }

  // Per-role example prompts. Wrapped in click-to-populate chips below so
  // a Marine doesn't have to retype them — the prior plain-<li> rendering
  // looked clickable but did nothing on click.
  const examplesForRole = (() => {
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
  })();

  function fillExample(s: string) {
    setText(s);
    // Defer focus so React paints the value first; otherwise the cursor
    // sometimes lands at position 0 before the value is committed.
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // A SPIRO step "succeeded" but produced nothing — empty actions[],
  // predictions[], candidates[], or count=0 — should NOT render as green ✓.
  // The operator needs to see that the tool returned but found nothing,
  // not assume everything went fine.
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

  // Collapsed-pill view — small button on the right edge.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="pointer-events-auto fixed right-0 top-1/2 z-[8400] -translate-y-1/2 rounded-l-md border border-r-0 border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_18%,var(--color-surface))] px-2 py-3 font-mono text-xs font-semibold uppercase text-[var(--color-primary)] shadow-lg backdrop-blur transition-all hover:px-3 hover:bg-[color-mix(in_oklab,var(--color-primary)_28%,var(--color-surface))] tracking-widest"
        style={{ writingMode: "vertical-rl" }}
        title="Open SPIRO (Ctrl+/)"
      >
        ◆ SPIRO
      </button>
    );
  }

  return (
    <aside
      className="pointer-events-auto fixed right-0 top-0 bottom-0 z-[8400] flex w-full max-w-[26rem] flex-col border-l border-[var(--color-primary)] bg-[var(--color-surface)] shadow-2xl"
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
            Tell SPIRO what you want. He plans; you approve before anything runs.
          </div>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="flex h-11 w-11 items-center justify-center rounded font-mono text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
          aria-label="Close SPIRO"
        >
          ✕
        </button>
      </div>

      {/* Input */}
      <div className="border-b border-[var(--color-border)] p-3">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              ask();
            }
          }}
          rows={3}
          placeholder={
            role === "maintenance_chief"
              ? "e.g. find a cannib donor for the deadlined MTVR M21670-MTVR_CARGO-006"
              : role === "g4"
              ? "e.g. what should I do about my fleet right now?"
              : role === "data_custodian"
              ? "e.g. what does Japan see in the next coalition release?"
              : role === "security_manager"
              ? "e.g. show me the highest-risk units across all of MEF"
              : "Tell SPIRO what you want."
          }
          className="w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 font-mono text-xs text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="font-mono text-[10px] text-[var(--color-text-muted)] tracking-wide">
            ⌘/Ctrl+Enter to ask
          </span>
          <button
            onClick={ask}
            disabled={loading || !text.trim()}
            className="rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-4 py-1.5 font-mono text-xs font-semibold uppercase text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50 tracking-widest"
          >
            {loading ? "Planning…" : "Ask"}
          </button>
        </div>
      </div>

      {/* Output area */}
      <div className="flex-1 overflow-y-auto p-3">
        {error && (
          <div className="mb-3 rounded-sm border border-[var(--color-danger)] bg-[color-mix(in_oklab,var(--color-danger-muted)_20%,transparent)] p-3 font-mono text-xs text-[var(--color-danger)]">
            {error}
          </div>
        )}

        {plan && !result && (
          <div className="flex flex-col gap-3">
            {plan.answer && !plan.steps.length && (
              <div className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] p-3 font-mono text-xs leading-relaxed text-[var(--color-text)]">
                {plan.answer}
              </div>
            )}

            {plan.steps.length > 0 && (
              <>
                <div className="rounded-sm border border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_8%,var(--color-bg))] p-3 font-mono text-xs leading-relaxed text-[var(--color-text)]">
                  {plan.summary || `Run ${plan.steps.length} tool${plan.steps.length === 1 ? "" : "s"}.`}
                </div>
                <ol className="flex flex-col gap-1.5 font-mono text-xs">
                  {plan.steps.map((s, i) => (
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
                <div className="flex items-center gap-2">
                  <button
                    onClick={approve}
                    disabled={executing}
                    className="flex-1 rounded-sm border border-[var(--color-success)] bg-[var(--color-success)] px-4 py-2 font-mono text-xs font-semibold uppercase text-white hover:opacity-90 disabled:opacity-50 tracking-widest"
                  >
                    {executing ? "Executing…" : "Approve & Run"}
                  </button>
                  <button
                    onClick={reset}
                    className="rounded-sm border border-[var(--color-border-active)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs uppercase text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] tracking-widest"
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            <div className="font-mono text-[10px] text-[var(--color-text-muted)] tracking-wide">
              engine: {plan.engine}{plan.tokens_used ? ` · ${plan.tokens_used} tokens` : ""}
            </div>
          </div>
        )}

        {result && (() => {
          // Roll up the per-step status so the header banner reads honestly
          // when one step succeeds but another returns nothing useful.
          const statuses = result.step_results.map((sr) => stepStatus(sr));
          const errorCount = statuses.filter((s) => s === "error").length;
          const emptyCount = statuses.filter((s) => s === "empty").length;
          const okCount = statuses.filter((s) => s === "ok").length;
          const overall: "ok" | "empty" | "error" =
            errorCount > 0 ? "error" : emptyCount > 0 ? "empty" : "ok";
          const headerColor =
            overall === "error" ? "var(--color-danger)"
            : overall === "empty" ? "var(--color-warning)"
            : "var(--color-success)";
          const headerMutedBg =
            overall === "error" ? "var(--color-danger-muted)"
            : overall === "empty" ? "var(--color-warning-muted)"
            : "var(--color-success-muted)";
          return (
          <div className="flex flex-col gap-2">
            <div
              className="rounded-sm border p-2 font-mono text-xs"
              style={{
                borderColor: headerColor,
                background: `color-mix(in oklab, ${headerMutedBg} 15%, transparent)`,
              }}
            >
              <span style={{ color: headerColor }}>
                {okCount}/{result.step_results.length} steps with results
              </span>
              {emptyCount > 0 && (
                <span className="ml-2 text-[var(--color-warning)]">
                  {emptyCount} returned nothing
                </span>
              )}
              {errorCount > 0 && (
                <span className="ml-2 text-[var(--color-danger)]">{errorCount} errors</span>
              )}
            </div>
            {result.step_results.map((sr, i) => {
              const st = statuses[i];
              const tone =
                st === "error" ? "var(--color-danger)"
                : st === "empty" ? "var(--color-warning)"
                : "var(--color-success)";
              const label = st === "error" ? "ERROR" : st === "empty" ? "EMPTY" : "OK";
              const glyph = st === "error" ? "✗" : st === "empty" ? "⚠" : "✓";
              return (
              <div
                key={i}
                className="rounded-sm border bg-[var(--color-bg)] p-2 font-mono text-xs"
                style={{
                  borderColor: st === "ok"
                    ? "var(--color-border)"
                    : `color-mix(in oklab, ${tone} 40%, var(--color-border))`,
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[var(--color-text)]">{sr.tool}</span>
                  <span style={{ color: tone }}>{glyph} {label}</span>
                </div>
                {st === "empty" && (
                  <div className="mt-1 text-[10px] italic text-[var(--color-warning)] tracking-wide">
                    Tool ran but produced no results — operator decision: try a different scope or accept "nothing found."
                  </div>
                )}
                <pre className="mt-1.5 max-h-[12rem] overflow-auto whitespace-pre-wrap break-words text-[10px] text-[var(--color-text-secondary)]">
                  {JSON.stringify(sr.result, null, 2).slice(0, 1200)}
                </pre>
              </div>
              );
            })}
            <button
              onClick={reset}
              className="mt-2 rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-4 py-1.5 font-mono text-xs font-semibold uppercase text-white tracking-widest"
            >
              Ask another
            </button>
          </div>
          );
        })()}

        {!plan && !result && !error && !loading && (
          <div className="font-mono text-[10px] leading-relaxed text-[var(--color-text-muted)] tracking-wide">
            <div className="mb-2 text-xs uppercase text-[var(--color-text-secondary)] tracking-widest">
              Examples · click to use
            </div>
            <ul className="flex flex-col gap-1.5">
              {examplesForRole.map((ex) => (
                <li key={ex}>
                  <button
                    type="button"
                    onClick={() => fillExample(ex)}
                    className="block w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-left font-mono text-xs text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-primary)] hover:bg-[color-mix(in_oklab,var(--color-primary)_10%,var(--color-bg))] hover:text-[var(--color-text)]"
                    title="Click to drop this example into the prompt"
                  >
                    "{ex}"
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}
