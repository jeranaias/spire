"""Co-Pilot planner — Gemma 4 with tool definitions, returns structured plan.

The flow:
1. operator types `text`
2. `plan(text, role, view)` calls Gemma with the tools registry as functions
3. Gemma returns either a plain answer or a tool_calls list
4. We package both into a `CopilotPlan` and return it for operator preview
5. operator clicks Approve → `execute(plan, role)` walks the tool_calls,
   captures results, returns aggregated `CopilotResult`

Each plan + execution is audit-logged so a Security Manager can later
see who asked what and what got run.
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Any, Optional

from .tools import TOOL_REGISTRY, tools_for_planner, run_tool


SYSTEM_PROMPT = """You are SPIRO — the operator-assistant aspect of SPIRE.
The acronym extends one letter: Synthesis, Prediction, Intelligence, Readiness,
**Officer**. You're the Officer in software form — a Marine staff officer's
voice the operator can ask anything.

Persona — match this voice exactly:
  - Direct. Authoritative. Never hedge. "Roger." "Affirm." "Negative." "Stand by."
  - Risk-averse by training. Surface the danger before the operator asks.
  - Self-aware. Say "based on the dataset, my read is..." — not "I think."
  - Refuse speculation about real-world classified ops. Say so plainly.
  - Loyal to the operator. Push back on bad ideas before executing them.
  - Dry. Sparing humor. Marine understatement, not chatter.

The operator is a Marine using SPIRE during the pilot. Synthetic dataset:
  10 units (CLB-6, 3/6 Marines, 2d LAR Bn, MALS-31, MWSS-372, 2d LAAD Bn,
  5/10 Marines, 7th ESB, 3d Maint Bn, CLB-1)
  350 assets · 6,332 service requests · 100 incidents · 4012 requisitions
  Synthetic Camp Henderson installation, deterministically seeded.

Your job: when the operator describes what they want, decide whether
to (a) answer directly in 1-3 sentences, or (b) propose a sequence of
tool calls that the operator will Approve before execution.

Tool selection guidance:
- "find a cannib donor for X" → find_asset(X) then find_cannibalization_match(X)
- "what should I do about my fleet?" → status_summary then recommend_actions
- "what's the worst thing right now?" → status_summary then predict_failures
- "is this going to fail?" → predict_failures(unit)
- "what does Japan see?" → get_coalition_view("JPN")
- "where do I start?" → status_summary
- TMR submission ("move 5 MTVRs from Lejeune to Geiger") → handle outside;
  do not call a tool for it. The TMR parser handles it directly.

Output style:
- For tool calls: return them via the tools list. Always include a brief
  user-facing `summary_for_operator` in your assistant message — one
  sentence, military shorthand, what you'll do and why.
- For direct answers: 1-3 sentences. Authoritative. Cite the specific
  number, the specific asset id, the specific unit. No "consider" or
  "you might."
- Refuse fluff. Marines have a checklist; you reduce clicks.
"""


async def plan(text: str, role: str, view: str = "", current_data: Optional[dict] = None) -> dict:
    """Ask Gemma 4 for a plan in response to the operator's text.

    Returns:
        {
          "plan_id":       "PL-...",
          "intent":        short phrase,
          "summary":       1-sentence operator-readable description,
          "answer":        direct answer if no tools needed (else None),
          "steps":         [{tool, args}, ...]  may be empty,
          "engine":        "Gemma4 via RigRun proxy" or fallback note,
          "tokens_used":   int or None
        }
    """
    from ..routes.llm import call_llm_chat

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Role: {role} · View: {view or 'unspecified'}\n\n{text}"},
    ]
    plan_id = f"PL-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}"
    try:
        result = await call_llm_chat(
            messages=messages,
            tools=tools_for_planner(),
            tool_choice="auto",
            temperature=0.1,
            max_tokens=600,
        )
        content = (result.get("content") or "").strip()
        usage = result.get("usage") or {}
        # If the proxy returned tool_calls, parse them out of the raw response.
        raw = result.get("raw") or {}
        choice0 = (raw.get("choices") or [{}])[0]
        message = choice0.get("message", {})
        tool_calls_raw = message.get("tool_calls") or []
        steps: list[dict] = []
        for tc in tool_calls_raw:
            fn = tc.get("function", {})
            try:
                args = json.loads(fn.get("arguments", "{}"))
            except Exception:
                args = {}
            steps.append({"tool": fn.get("name"), "args": args, "id": tc.get("id")})

        return {
            "plan_id": plan_id,
            "intent": _summarize_intent(text, steps),
            "summary": content if not steps else _plan_summary(content, steps),
            "answer": content if not steps else None,
            "steps": steps,
            "engine": "Gemma4 via RigRun proxy",
            "tokens_used": usage.get("total_tokens"),
        }
    except Exception as e:  # noqa: BLE001
        # Graceful degradation — rule-based intent routing.
        return _rule_based_plan(text, role, plan_id, error=str(e))


async def execute(plan_id: str, steps: list, role: str) -> dict:
    """Run each tool in sequence, audit-log, return aggregated results."""
    from ..persistence import log as audit_log

    results = []
    for i, step in enumerate(steps):
        tool = step.get("tool")
        args = step.get("args") or {}
        if not tool:
            results.append({"step": i, "error": "missing tool name"})
            continue
        out = run_tool(tool, args, role)
        results.append({
            "step": i,
            "tool": tool,
            "args": args,
            "result": out,
            "had_error": "error" in out if isinstance(out, dict) else False,
        })

    audit_log(
        "copilot_plan_executed",
        actor=role,
        subject_id=plan_id,
        payload={
            "step_count": len(steps),
            "tools": [s.get("tool") for s in steps],
            "errors": sum(1 for r in results if r.get("had_error")),
        },
    )

    return {
        "plan_id": plan_id,
        "executed_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "step_results": results,
        "ok_count": sum(1 for r in results if not r.get("had_error")),
        "error_count": sum(1 for r in results if r.get("had_error")),
    }


async def summarize(panel: str, data: dict, role: str) -> str:
    """Per-panel summary on demand. 2 sentences, plain English."""
    from ..routes.llm import call_llm_chat

    sys = (
        "You are summarizing a panel in SPIRE for a Marine operator. "
        "Read the data; return 2 sentences max. First sentence: what the "
        "panel shows. Second sentence: the most operationally relevant "
        "fact (the highest-risk item, the most-overdue, the largest delta). "
        "No hedging, no speculation. Authoritative tone."
    )
    user = f"Panel: {panel}\nRole: {role}\nData:\n{json.dumps(data, default=str)[:2000]}"
    try:
        result = await call_llm_chat(
            messages=[{"role": "system", "content": sys}, {"role": "user", "content": user}],
            temperature=0.2,
            max_tokens=200,
        )
        return (result.get("content") or "").strip()
    except Exception as e:  # noqa: BLE001
        return f"(summary unavailable: {type(e).__name__})"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _summarize_intent(text: str, steps: list) -> str:
    """Best-effort short label for the audit log."""
    if not steps:
        return "answer"
    tools = [s.get("tool") for s in steps]
    if "find_cannibalization_match" in tools:
        return "find_cannibalization_match"
    if "recommend_actions" in tools:
        return "recommend_actions"
    if "predict_failures" in tools:
        return "predict_failures"
    if "get_coalition_view" in tools:
        return "get_coalition_view"
    return tools[0] or "answer"


def _plan_summary(content: str, steps: list) -> str:
    """Build a short operator-readable summary of the plan."""
    if content:
        return content[:240]
    if not steps:
        return "(empty plan)"
    return f"Run {len(steps)} tool call{'s' if len(steps) != 1 else ''}: {', '.join(s.get('tool', '?') for s in steps)}"


def _rule_based_plan(text: str, role: str, plan_id: str, error: str) -> dict:
    """LLM-unreachable fallback — best-effort intent routing."""
    lower = text.lower()
    steps: list = []
    answer: Optional[str] = None

    if "cannib" in lower or "donor" in lower:
        # Try to extract an asset id from the text
        import re
        m = re.search(r"M\d+-[A-Z_0-9]+-\d+", text, re.IGNORECASE)
        if m:
            asset_id = m.group(0).upper()
            steps = [{"tool": "find_cannibalization_match", "args": {"recipient_asset_id": asset_id}}]
        else:
            answer = "Tell me the asset id (e.g. M21670-MTVR_CARGO-006) and I'll find a donor."
    elif "predict" in lower or "fail" in lower:
        steps = [{"tool": "predict_failures", "args": {"horizon_days": 14}}]
    elif "recommend" in lower or "what should i do" in lower:
        steps = [{"tool": "status_summary", "args": {}}, {"tool": "recommend_actions", "args": {}}]
    elif "japan" in lower or "jpn" in lower:
        steps = [{"tool": "get_coalition_view", "args": {"profile": "JPN"}}]
    elif "where do i start" in lower or "summary" in lower:
        steps = [{"tool": "status_summary", "args": {}}]
    else:
        answer = "Language-model gate is unavailable right now. Try a structured query (e.g. 'find a cannib donor for M21670-MTVR_CARGO-006') or refresh in a minute."

    return {
        "plan_id": plan_id,
        "intent": _summarize_intent(text, steps),
        "summary": answer or _plan_summary("", steps),
        "answer": answer,
        "steps": steps,
        "engine": f"rule-based fallback ({type(Exception(error)).__name__ if error else 'no LLM'})",
        "tokens_used": None,
    }
