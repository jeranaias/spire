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
  10 units (CLB-6, 3/6 Marines, 2d LAR Bn, MALS-31, MWSS-271, 2d LAAD Bn,
  2/14 Marines, 7th ESB, 3d Maint Bn, CLB-1)
  350 assets · 6,332 service requests · 100 incidents · 4012 requisitions
  Synthetic Camp Henderson installation, deterministically seeded.

GROUNDING DISCIPLINE — non-negotiable:
  - The CURRENT_OPERATIONAL_PICTURE block (when present) is canonical truth.
    It mirrors what the operator sees on screen. Numbers in your reply MUST
    match it exactly.
  - Strict-MC means readiness_code == "MC". PMC (partially mission capable)
    is a SEPARATE state — never roll PMC into MC. If asked for MC%, quote
    the strict figure.
  - If you don't have a number for what's being asked, say so. Do NOT
    fabricate. Say "stand by — I'd need to run status_summary to answer
    that authoritatively" and propose the tool call.
  - When you cite a number, paraphrase the picture, don't reformat it.
    Don't "fix" a percentage that came from the picture even if the math
    looks off — your job is to surface, not recompute.

Your job: when the operator describes what they want, decide whether
to (a) answer directly in 1-3 sentences using the CURRENT_OPERATIONAL_PICTURE,
or (b) propose a sequence of tool calls that the operator will Approve
before execution.

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
    from ..routes.bastion import _build_grounding_context

    # Inject the canonical operational picture so direct-answer questions
    # ("what's CLB-6's readiness?") never fabricate. The grounding mirrors
    # /api/bastion/cop, so SPIRO's numbers can't disagree with the screen.
    grounding = _build_grounding_context(role=role)

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "system", "content": f"CURRENT_OPERATIONAL_PICTURE:\n{grounding}"},
        {"role": "user", "content": f"Role: {role} · View: {view or 'unspecified'}\n\n{text}"},
    ]
    plan_id = f"PL-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}"
    # Two-tier LLM call:
    # 1. Tools-enabled call (Gemma can return tool_calls for agentic flows).
    # 2. If the proxy 400s/502s on the tools schema (some vLLM builds reject
    #    `tool_choice: "auto"` or the tools list shape), retry plain chat
    #    and rely on the rule-based intent router for tool selection.
    # Either way the operator gets a grounded direct answer; agentic plans
    # work when the proxy supports tools, fall back to rule-based otherwise.
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

        cleaned_content = _strip_json_dump(content)
        return {
            "plan_id": plan_id,
            "intent": _summarize_intent(text, steps),
            "summary": cleaned_content if not steps else _plan_summary(cleaned_content, steps),
            "answer": cleaned_content if not steps else None,
            "steps": steps,
            "engine": "Gemma4 via RigRun proxy",
            "tokens_used": usage.get("total_tokens"),
        }
    except Exception as e:  # noqa: BLE001
        err = str(e)
        # Tools schema rejected by upstream — retry plain chat, no tools.
        # vLLM builds vary in tool_choice / tools support; an unsupported
        # schema returns 400/502 from the proxy. The operator still gets a
        # grounded direct answer (the CURRENT_OPERATIONAL_PICTURE system
        # message is in `messages`), and the rule-based router below
        # populates tool steps from intent regex.
        is_tools_problem = (
            "auto" in err.lower()
            or "tool" in err.lower()
            or "400" in err
            or "502" in err
        )
        if is_tools_problem:
            try:
                result = await call_llm_chat(
                    messages=messages,
                    temperature=0.1,
                    max_tokens=400,
                )
                content = (result.get("content") or "").strip()
                usage = result.get("usage") or {}
                # Run rule-based intent extraction in parallel for tool steps.
                rb = _rule_based_plan(text, role, plan_id, error="")
                cleaned = _strip_json_dump(content)
                # If the cleaned LLM prose is too thin, synthesize a step
                # sentence from the rule-based steps so the plan card is
                # never empty or noisy.
                if rb["steps"] and (not cleaned or len(cleaned) < 12):
                    cleaned = _plan_summary("", rb["steps"])
                return {
                    "plan_id": plan_id,
                    "intent": rb["intent"],
                    "summary": cleaned or rb["summary"],
                    "answer": cleaned or rb["answer"],
                    "steps": rb["steps"],
                    "engine": "Gemma4 via RigRun proxy (no-tools fallback)",
                    "tokens_used": usage.get("total_tokens"),
                }
            except Exception as e2:  # noqa: BLE001
                err = f"{err} | retry: {e2}"
        # Final fallback — rule-based intent routing only.
        return _rule_based_plan(text, role, plan_id, error=err)


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
        out = await run_tool(tool, args, role)
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


_TOOL_PROSE = {
    "status_summary":             "Pull a status summary of the fleet",
    "recommend_actions":          "Generate ranked replenishment actions",
    "predict_failures":           "Run failure prediction over the horizon",
    "find_asset":                 "Look up the asset",
    "search_assets":              "Search the asset roster",
    "find_cannibalization_match": "Find a cannibalization donor",
    "get_coalition_view":         "Preview the coalition release view",
    "parse_tmr":                  "Parse the TMR text",
}


def _strip_json_dump(text: str) -> str:
    """Strip raw ```json ... ``` fences and tool_calls JSON from LLM text.

    Some Gemma builds dump the tool_calls JSON straight into the assistant
    content. The structured plan below the summary is the operator-facing
    artefact; the raw JSON in the prose is just visual noise.

    If the LLM emitted an explicit `summary_for_operator: <prose>` line,
    that prose is the *intended* operator summary — extract and return it.
    Otherwise strip the noise from whatever else is in the text.
    """
    if not text:
        return ""
    import re
    # Preferred: lift `summary_for_operator: <one line>` directly.
    m = re.search(r"summary_for_operator\s*:\s*(.+?)(?:\n|$)", text, flags=re.IGNORECASE)
    if m:
        prose = m.group(1).strip().strip("`").strip()
        if prose:
            return prose
    # Otherwise: scrub fences, bare JSON arrays, leftover tag.
    text = re.sub(r"```json[\s\S]*?```", "", text, flags=re.IGNORECASE)
    text = re.sub(r"```[\s\S]*?```", "", text)  # any other code fence
    text = re.sub(r"\[\s*\{[\s\S]*?\}\s*\]", "", text)
    text = re.sub(r"summary_for_operator\s*:?\s*", "", text, flags=re.IGNORECASE)
    # Strip literal tool-call notation the LLM sometimes emits as prose,
    # e.g. `call:find_asset(asset_id='...')` or `tool_call: status_summary()`.
    text = re.sub(r"\b(?:call|tool_call|tool)\s*:\s*\w+\s*\([^)]*\)", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\n{2,}", "\n", text)
    text = re.sub(r" {2,}", " ", text)
    return text.strip()


def _plan_summary(content: str, steps: list) -> str:
    """Build a short operator-readable summary of the plan.

    Walkthrough audit: if the LLM dumped raw tool_calls JSON into its
    response (some Gemma builds do), strip it out before showing to the
    operator. If the cleaned content is empty, synthesize a step-list
    sentence from the tool names so the plan card always reads cleanly.
    """
    cleaned = _strip_json_dump(content)
    if cleaned and len(cleaned) > 12:
        return cleaned[:240]
    if not steps:
        return "(empty plan)"
    parts = [_TOOL_PROSE.get(s.get("tool", ""), s.get("tool", "step")) for s in steps]
    if len(parts) == 1:
        return f"{parts[0]}."
    if len(parts) == 2:
        return f"{parts[0]}, then {parts[1]}."
    return f"{parts[0]}, then {parts[1]}, then {len(parts) - 2} more."



_UNIT_CANON = {
    "clb-6": "CLB-6", "clb 6": "CLB-6", "clb6": "CLB-6",
    "clb-1": "CLB-1", "clb 1": "CLB-1", "clb1": "CLB-1",
    "3d maint": "3d Maint Bn", "3d maint bn": "3d Maint Bn", "3rd maint bn": "3d Maint Bn",
    "3/6 marines": "3/6 Marines", "3/6": "3/6 Marines", "3-6 marines": "3/6 Marines",
    "2d lar": "2d LAR Bn", "2d lar bn": "2d LAR Bn",
    "mals-31": "MALS-31", "mals 31": "MALS-31",
    "mwss-271": "MWSS-271", "mwss 271": "MWSS-271", "mwss-372": "MWSS-271",  # legacy alias
    "2d laad": "2d LAAD Bn", "2d laad bn": "2d LAAD Bn",
    "2/14 marines": "2/14 Marines", "2/14": "2/14 Marines", "2-14 marines": "2/14 Marines",
    "5/10 marines": "2/14 Marines", "5/10": "2/14 Marines",  # legacy alias
    "7th esb": "7th ESB", "7 esb": "7th ESB",
}

_PROFILE_CANON = {"japan": "JPN", "jsdf": "JPN", "jpn": "JPN", "australia": "AUS", "aus": "AUS",
                  "philippines": "PHL", "phl": "PHL", "fvey": "FVEY_BASE", "fvey-log": "FVEY_LOG",
                  "fvey log": "FVEY_LOG", "five eyes": "FVEY_BASE"}


def _extract_unit(text: str, role: str) -> Optional[str]:
    """Pull a unit name out of natural-language text. Falls back to the
    operator's role-default unit when not stated explicitly."""
    lower = text.lower()
    for k, v in _UNIT_CANON.items():
        if k in lower:
            return v
    # Default per role — Maintenance Chief sees CLB-6, others get None (whole scope).
    if role == "maintenance_chief":
        return "CLB-6"
    return None


def _extract_asset_id(text: str) -> Optional[str]:
    import re
    m = re.search(r"M\d+-[A-Z_0-9]+-\d+", text, re.IGNORECASE)
    return m.group(0).upper() if m else None


def _extract_profile(text: str) -> Optional[str]:
    lower = text.lower()
    for k, v in _PROFILE_CANON.items():
        if k in lower:
            return v
    return None


def _rule_based_plan(text: str, role: str, plan_id: str, error: str) -> dict:
    """LLM-unreachable fallback — best-effort intent routing.

    Now extracts entities (unit names, asset ids, coalition profiles) from
    the operator's text so plans actually carry them through. Previous
    version relied on the LLM for entity extraction and degraded to
    asking the user to retype in a structured form.
    """
    lower = text.lower()
    steps: list = []
    answer: Optional[str] = None

    asset_id = _extract_asset_id(text)
    unit = _extract_unit(text, role)
    profile = _extract_profile(text)

    if "cannib" in lower or "donor" in lower:
        if asset_id:
            steps = [{"tool": "find_cannibalization_match", "args": {"recipient_asset_id": asset_id}}]
        else:
            steps = [{"tool": "search_assets", "args": {"query": "deadlined", "limit": 8}}]
            answer = "Show me the asset id (e.g. M21670-MTVR_CARGO-006) and I'll match a donor. Pulling deadlined assets in your scope as a starting point."
    elif "predict" in lower or "fail" in lower:
        args: dict = {"horizon_days": 14}
        if unit:
            args["unit"] = unit
        steps = [{"tool": "predict_failures", "args": args}]
    elif "recommend" in lower or "what should i do" in lower or "top three" in lower or "top 3" in lower:
        rec_args: dict = {"top": 5}
        if unit:
            rec_args["unit"] = unit
        steps = [{"tool": "status_summary", "args": {}}, {"tool": "recommend_actions", "args": rec_args}]
    elif profile is not None:
        steps = [{"tool": "get_coalition_view", "args": {"profile": profile}}]
    elif "where do i start" in lower or "summary" in lower or "status" in lower:
        steps = [{"tool": "status_summary", "args": {}}]
    elif "worst" in lower or "highest risk" in lower:
        steps = [
            {"tool": "status_summary", "args": {}},
            {"tool": "predict_failures", "args": {"horizon_days": 14, **({"unit": unit} if unit else {})}},
        ]
    else:
        answer = "Language-model gate is degraded right now. Try a structured query — 'find a cannib donor for M21670-MTVR_CARGO-006', 'predict failures in CLB-6', 'what should I do about my fleet', 'what does Japan see'."

    return {
        "plan_id": plan_id,
        "intent": _summarize_intent(text, steps),
        "summary": answer or _plan_summary("", steps),
        "answer": answer,
        "steps": steps,
        "engine": f"rule-based fallback ({error[:60]})" if error else "rule-based fallback",
        "tokens_used": None,
    }
