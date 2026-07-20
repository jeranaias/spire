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
from ..timeutil import utcnow


SYSTEM_PROMPT = """You are SPIRO — SPIRE's operator-assistant. Marine staff officer voice.

VOICE: direct, authoritative, no hedging. "Roger." "Negative." "Stand by." Surface danger first. Cite the dataset, never speculate. No fluff.

GROUNDING (non-negotiable):
- CURRENT_OPERATIONAL_PICTURE (when present) is truth. Numbers in your reply MUST match it exactly.
- Strict-MC = readiness_code == "MC". PMC is a separate state — never fold into MC.
- Don't fabricate numbers. If you'd need a tool, say so and propose the call.

DECIDE: (a) answer in 1-3 sentences using the picture, OR (b) propose tool calls for operator approval.

TOOL ROUTING:
- "find a cannib donor for X" → find_asset(X) then find_cannibalization_match(X)
- "what should I do about <unit>?" → status_summary then recommend_actions(unit)
- "what's worst / highest risk?" → status_summary then predict_failures
- "is X going to fail?" / "what will X look like in Nd?" → predict_failures(unit) or forecast_unit(unit, horizon_days)
- "is this CUI?" / "mark this" / "classify this <text>" → mark_text(text)
- "anything blowing up?" / "what's critical?" / "show me alerts" → list_alerts(severity)
- "tell me about CLB-X" / "walk me through X" → walk_unit(unit); optionally pair with map_select_marker(pulse_unit=X) + map_fly_to(pulse_unit=X)
- "what does Japan / JSDF / Australia / FVEY see?" → get_coalition_view(profile)
  ⚠ "what's on Miyako" / "list markers on <island>" is GEOGRAPHY → map_list_markers(island=...). NOT coalition.
- "fly to / show me / go to <X>" → map_fly_to (island=okinawa|miyako|ishigaki | pulse_unit=<unit> | label=<marker>)
- "select / focus <X> on the map" → map_select_marker
- "what's within Nkm of X" / "closest to X" → map_query_within_radius
- "where do I start?" → status_summary
- TMR submission ("move 5 MTVRs from A to B") → handled outside; don't call a tool.

BARE VERBS ("go", "do it", "execute", "proceed", "send it", "roger", "let's go" with no context) → emit a 3-step plan: status_summary, predict_failures(14d), recommend_actions(top 5). Never reply with prose alone — the operator just told you to act.

If PRIOR_PROPOSAL is present, execute THAT proposal exactly. Operator is consenting, not asking to re-plan.

OUTPUT:
- Tool calls: return them via the tools list with a one-line `summary_for_operator` (military shorthand).
- Direct answers: 1-3 sentences. Cite the specific number, asset id, unit. No "consider" or "you might."

MEMORY: conversation history below is state. "and CLB-6?" / "do that one too" / "same for X" → repeat your most recent action against the new target. No re-asking unless genuinely ambiguous.

DECISIVENESS: always end with a recommended next move. "Recommend: cannib match → expedite. Approve?" Never "would you like me to..." If a blocker exists, state it in one sentence and propose the unblock. "Dataset empty — recommend: ingest via Decision Bridge."
"""


async def plan(
    text: str,
    role: str,
    view: str = "",
    current_data: Optional[dict] = None,
    prior_proposal: Optional[list] = None,
    history: Optional[list] = None,
    map_selection: Optional[dict] = None,
) -> dict:
    """Ask Gemma 4 for a plan in response to the operator's text.

    `prior_proposal`, when present, is the steps[] array from the previous
    assistant turn — used so an operator's "go" / "do it" consents to the
    exact tools that were proposed instead of forcing a re-plan.

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

    plan_id = f"PL-{utcnow().strftime('%Y%m%d-%H%M%S')}"

    # Action-verb shortcut: bare "go" / "do it" / "execute" with no further
    # context resolves deterministically without a Gemma round-trip. If a
    # prior assistant turn proposed tools, we consent to that exact list;
    # otherwise we run the standard 3-step (status_summary, predict_failures,
    # recommend_actions). Skipping the LLM here is cheaper, deterministic,
    # and survives any proxy hiccups during a live demo.
    shortcut = _action_verb_shortcut(text, role, plan_id, prior_proposal)
    if shortcut is not None:
        from ..inference_economics import record_call
        rule_entry = record_call(
            tier="tier0_rule",
            model="deterministic action-verb router",
            input_tokens=0, output_tokens=0,
            latency_ms=0.0, call_site="copilot_plan",
            route="action_verb_shortcut", role=role,
        )
        shortcut["economics"] = {
            "tier": "tier0_rule",
            "model": rule_entry["model"],
            "call_site": "copilot_plan",
            "route": "action_verb_shortcut",
            "input_tokens": 0,
            "output_tokens": 0,
            "cost_usd": 0.0,
            "latency_ms": 0.0,
        }
        return shortcut

    # Inject the canonical operational picture so direct-answer questions
    # ("what's CLB-6's readiness?") never fabricate. The grounding mirrors
    # /api/bastion/cop, so SPIRO's numbers can't disagree with the screen.
    grounding = _build_grounding_context(role=role)

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "system", "content": f"CURRENT_OPERATIONAL_PICTURE:\n{grounding}"},
    ]
    if prior_proposal:
        messages.append({
            "role": "system",
            "content": (
                "PRIOR_PROPOSAL — the last assistant turn proposed these "
                "tools and the operator has not yet executed them:\n"
                f"{json.dumps(prior_proposal)[:1200]}"
            ),
        })

    # MAP_SELECTION — when the operator has clicked a marker on the
    # BASTION map, that marker becomes the implicit subject of the
    # next turn. Follow-ups like "and this one?" / "tell me about
    # it" should resolve here instead of asking the operator to
    # name the unit again.
    if map_selection:
        try:
            messages.append({
                "role": "system",
                "content": (
                    "MAP_SELECTION — operator has this marker selected on "
                    "the BASTION map. Resolve referential follow-ups "
                    "('this one', 'that unit', 'it', 'and CLB-1?') "
                    "against this context unless the operator names a "
                    f"different target:\n{json.dumps(map_selection)[:600]}"
                ),
            })
        except Exception:
            pass

    # Conversation memory — replay the last N turns so SPIRO can resolve
    # follow-up references ("and the second one?", "what about CLB-6?",
    # "do that one too"). Token cost is bounded: at most 10 turns and
    # ~1.6 KB of text per turn after truncation.
    if history:
        try:
            clipped: list[dict] = []
            # Keep the most-recent 10 turns. The frontend already filters
            # to user/answer/error roles before sending; we sanitize again
            # in case the payload was synthesized by some other client.
            for h in history[-10:]:
                if not isinstance(h, dict):
                    continue
                role_field = h.get("role")
                content = (h.get("content") or "")[:1600]
                if role_field not in ("user", "assistant") or not content.strip():
                    continue
                clipped.append({"role": role_field, "content": content})
            messages.extend(clipped)
        except Exception:
            # Memory injection is best-effort. A malformed history
            # payload should never block the current request.
            pass

    messages.append(
        {"role": "user", "content": f"Role: {role} · View: {view or 'unspecified'}\n\n{text}"},
    )
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
            tier="tier2_mid",
            call_site="copilot_plan",
            role=role,
        )
        content = (result.get("content") or "").strip()
        usage = result.get("usage") or {}
        economics = result.get("economics") or {}
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
            "economics": economics or None,
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
                    # No-tools fallback uses tier1 since we're not asking
                    # the model to function-call any more — cheaper rung
                    # is sufficient when we're only producing prose.
                    tier="tier1_small",
                    call_site="copilot_plan",
                    role=role,
                    route="fallback",
                )
                content = (result.get("content") or "").strip()
                usage = result.get("usage") or {}
                economics = result.get("economics") or {}
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
                    "economics": economics or None,
                }
            except Exception as e2:  # noqa: BLE001
                err = f"{err} | retry: {e2}"
        # Final fallback — rule-based intent routing only.
        plan = _rule_based_plan(text, role, plan_id, error=err)
        # Tier-0 economics: rule-engine produced the plan, $0 spent.
        from ..inference_economics import record_call
        rule_entry = record_call(
            tier="tier0_rule",
            model="deterministic regex / lookup",
            input_tokens=0, output_tokens=0,
            latency_ms=0.0, call_site="copilot_plan",
            route="fallback", role=role,
        )
        plan["economics"] = {
            "tier": "tier0_rule",
            "model": rule_entry["model"],
            "call_site": "copilot_plan",
            "route": "fallback",
            "input_tokens": 0,
            "output_tokens": 0,
            "cost_usd": 0.0,
            "latency_ms": 0.0,
        }
        return plan


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
        "executed_at": utcnow().isoformat(timespec="seconds") + "Z",
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
            # Panel summary is a 2-sentence Q→A — tier1 SLM is plenty.
            tier="tier1_small",
            call_site="copilot_panel_summary",
            role=role,
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
    "mark_text":                  "Run the SENTRY classifier on the draft text",
    "forecast_unit":              "Run the readiness forecast",
    "list_alerts":                "Pull the active alerts in scope",
    "walk_unit":                  "Walk the unit's readiness picture",
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
    # e.g. `call:find_asset(asset_id='...')` or `tool_call: status_summary()`
    # or `call:status_summary{}` (some Gemma builds use braces).
    # Walkthrough audit (live test): live planner returned
    # `call:status_summary{}` for 'highest-risk units' query — earlier
    # regex only covered parens.
    text = re.sub(r"\b(?:call|tool_call|tool)\s*:\s*\w+\s*[(\[{][^)\]}]*[)\]}]", "", text, flags=re.IGNORECASE)
    # Also catch the bare 'call:tool_name' with no parens at all
    text = re.sub(r"\b(?:call|tool_call|tool)\s*:\s*\w+", "", text, flags=re.IGNORECASE)
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

# Walkthrough audit: prior values were 'JPN' / 'AUS' / 'PHL' (short
# country codes), but the backend's coalition_view endpoint expects
# the full profile key 'JPN_COALITION' / 'AUS_COALITION' /
# 'PHL_COALITION'. SPIRO's 'what does Japan see?' planning step then
# returned 'unknown profile JPN'. Keys now match the dataset's
# coalition_profiles.json.
_PROFILE_CANON = {
    "japan": "JPN_COALITION", "jsdf": "JPN_COALITION", "jpn": "JPN_COALITION",
    "australia": "AUS_COALITION", "aus": "AUS_COALITION", "adf": "AUS_COALITION",
    "philippines": "PHL_COALITION", "phl": "PHL_COALITION", "afp": "PHL_COALITION",
    "fvey-log": "FVEY_LOG", "fvey log": "FVEY_LOG",
    "fvey": "FVEY_BASE", "five eyes": "FVEY_BASE",
}


import re as _re

# Bare action verbs the operator might issue with no further context —
# "go", "do it", "execute", "proceed", etc. When matched, the planner
# returns a deterministic plan instead of asking Gemma to re-decide.
# Word boundaries on both sides; trailing punctuation tolerated.
_ACTION_VERB_RE = _re.compile(
    r"^\s*(?:"
    # Bare "go" / "execute" / etc. — optionally followed by casual filler
    # like "go for it", "execute it", "send it", "run it now".
    r"go(?:\s+(?:for\s+it|for\s+real|now|already))?|"
    r"do\s+it(?:\s+(?:already|now))?|"
    # "do all of that shit" / "do all that stuff" / "do everything" /
    # "do the whole thing" — Marine-speak the operator actually types.
    r"do\s+all(?:\s+(?:of\s+)?(?:that|this|it|the|the\s+above))?(?:\s+(?:shit|stuff|things?|of\s+it))?|"
    r"do\s+everything|do\s+the\s+(?:thing|whole\s+thing|works)|"
    r"handle\s+(?:it|that|all\s+of\s+(?:it|that))|"
    r"make\s+it\s+happen|"
    r"execute|execute\s+(?:it|that|all|now)|"
    r"run|run\s+(?:it|that|all|now)|"
    r"proceed|proceed\s+with\s+(?:it|that)|"
    r"kick(?:\s+it)?\s+off|"
    r"send(?:\s+it)?|fire\s+(?:it\s+)?off|"
    r"affirm|affirmative|roger(?:\s+that)?|gtg|good\s+to\s+go|"
    r"let'?s\s+(?:go|do\s+(?:it|this|that)|roll)|"
    r"do\s+the\s+thing"
    r")\s*[.!]*\s*$",
    flags=_re.IGNORECASE,
)


def _default_action_steps(role: str) -> list:
    """Standard 3-step plan when an operator says 'go' with no specifics."""
    args: dict = {"horizon_days": 14}
    rec_args: dict = {"top": 5}
    # Maintenance Chief is scoped to CLB-6; let the chief's "go" focus there.
    if role == "maintenance_chief":
        args["unit"] = "CLB-6"
        rec_args["unit"] = "CLB-6"
    return [
        {"tool": "status_summary", "args": {}},
        {"tool": "predict_failures", "args": args},
        {"tool": "recommend_actions", "args": rec_args},
    ]


def _action_verb_shortcut(
    text: str,
    role: str,
    plan_id: str,
    prior_proposal: Optional[list],
) -> Optional[dict]:
    """If the operator's text is a bare action verb, return a deterministic
    plan without consulting the LLM. Honors a prior-turn proposal when
    present (the operator is consenting to what was offered, not asking
    for a re-plan)."""
    if not _ACTION_VERB_RE.match(text or ""):
        return None
    # Consent path — use whatever the assistant just proposed.
    if prior_proposal and isinstance(prior_proposal, list) and len(prior_proposal) > 0:
        steps = []
        for s in prior_proposal:
            if not isinstance(s, dict):
                continue
            tool = s.get("tool")
            if not tool:
                continue
            steps.append({"tool": tool, "args": s.get("args") or {}})
        if steps:
            return {
                "plan_id": plan_id,
                "intent": "consent_to_prior",
                "summary": "Executing the prior proposal — " + _plan_summary("", steps),
                "answer": None,
                "steps": steps,
                "engine": "action-verb shortcut (prior-proposal consent)",
                "tokens_used": None,
            }
    # No prior proposal — run the standard 3-step.
    steps = _default_action_steps(role)
    return {
        "plan_id": plan_id,
        "intent": "default_action",
        "summary": _plan_summary("", steps),
        "answer": None,
        "steps": steps,
        "engine": "action-verb shortcut (default 3-step)",
        "tokens_used": None,
    }


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

    # Pull the first quoted span (single or double) for tools that act on
    # operator-supplied prose — mark_text especially. Longest-quote wins
    # so 'is "<long stuff>" CUI?' captures the long stuff.
    quoted: Optional[str] = None
    qm = _re.findall(r'"([^"]{4,})"|“([^”]{4,})”|‘([^’]{4,})’', text)
    if qm:
        quoted = max((q for tup in qm for q in tup if q), key=len, default=None)

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
    elif (
        "is this cui" in lower or "mark this" in lower or "mark draft" in lower
        or "classify this" in lower or "should this be classified" in lower
        or " cui?" in lower or "marking for" in lower
    ) and quoted:
        steps = [{"tool": "mark_text", "args": {"text": quoted}}]
    elif (
        "forecast" in lower or "what will" in lower or "going to drop" in lower
        or "headed on readiness" in lower or "where are we headed" in lower
        or "look like in" in lower or "monte carlo" in lower
    ):
        f_args: dict = {"horizon_days": 14}
        if unit:
            f_args["unit"] = unit
        steps = [{"tool": "forecast_unit", "args": f_args}]
    elif (
        "blowing up" in lower or "what's critical" in lower or "whats critical" in lower
        or "show me alerts" in lower or "show me the alerts" in lower
        or "any alerts" in lower or "active alerts" in lower
        or ("alerts" in lower and ("right now" in lower or "open" in lower or "active" in lower))
    ):
        l_args: dict = {"limit": 10}
        if "critical" in lower:
            l_args["severity"] = "CRITICAL"
        elif "high" in lower:
            l_args["severity"] = "HIGH"
        steps = [{"tool": "list_alerts", "args": l_args}]
    elif (
        "tell me about" in lower or "walk me through" in lower
        or "walk through" in lower or "everything about" in lower
        or "the picture on" in lower
    ) and unit:
        steps = [{"tool": "walk_unit", "args": {"unit": unit}}]
    elif _re.search(r"\b(fly|zoom|pan|move|center|go|jump|navigate)\b.*\b(to|on)\b", lower) or "show me" in lower or "show on map" in lower or "on the map" in lower:
        # Map fly_to / select. Pull an island name first; fall back to a
        # PULSE unit; fall back to a quoted label.
        island = None
        for k in ("okinawa", "miyako", "ishigaki"):
            if k in lower:
                island = k
                break
        if island:
            steps = [{"tool": "map_fly_to", "args": {"island": island}}]
        elif unit:
            steps = [
                {"tool": "map_select_marker", "args": {"pulse_unit": unit}},
                {"tool": "map_fly_to", "args": {"pulse_unit": unit}},
            ]
        elif quoted:
            steps = [{"tool": "map_fly_to", "args": {"label": quoted}}]
        else:
            answer = "Tell me where — an island (Okinawa / Miyako / Ishigaki), a unit (CLB-1, CLB-6), or a marker label."
    elif (
        "list markers" in lower or "list everything" in lower
        or "what's on miyako" in lower or "whats on miyako" in lower
        or "what's on ishigaki" in lower or "whats on ishigaki" in lower
        or ("markers" in lower and ("miyako" in lower or "ishigaki" in lower or "okinawa" in lower))
        or "what's in the picture" in lower or "whats in the picture" in lower
    ):
        island = None
        for k in ("okinawa", "miyako", "ishigaki"):
            if k in lower:
                island = k
                break
        args2 = {"island": island} if island else {}
        steps = [{"tool": "map_list_markers", "args": args2}]
    elif (
        "within" in lower and "km" in lower
    ) or "closest" in lower or "nearest" in lower:
        # Try unit/label/island as center.
        center_args: dict = {"radius_km": 100}
        # Pull a number with unit km
        m_km = _re.search(r"(\d+)\s*km", lower)
        if m_km:
            center_args["radius_km"] = int(m_km.group(1))
        if unit:
            mk = None  # client side resolves; pass label for now
            # Use a label heuristic: pulse_unit isn't on map_query_within_radius schema,
            # but a marker_id could be. Simplest path: tell the operator we need
            # an explicit center if no quoted label was provided.
            center_args["label"] = unit
        elif quoted:
            center_args["label"] = quoted
        else:
            answer = "Tell me the center — a unit, a quoted marker label, or lng/lat."
        if "label" in center_args:
            steps = [{"tool": "map_query_within_radius", "args": center_args}]
    elif "where do i start" in lower or "summary" in lower or "status" in lower:
        steps = [{"tool": "status_summary", "args": {}}]
    elif "worst" in lower or "highest risk" in lower or "highest-risk" in lower or "riskiest" in lower:
        steps = [
            {"tool": "status_summary", "args": {}},
            {"tool": "predict_failures", "args": {"horizon_days": 14, **({"unit": unit} if unit else {})}},
        ]
    else:
        answer = "Language-model gate is degraded right now. Try a structured query — 'find a cannib donor for M21670-MTVR_CARGO-006', 'predict failures in CLB-6', 'what should I do about my fleet', 'what does Japan see', 'forecast CLB-1', 'tell me about CLB-6', 'show me the alerts', or 'is this CUI: <text>'."

    return {
        "plan_id": plan_id,
        "intent": _summarize_intent(text, steps),
        "summary": answer or _plan_summary("", steps),
        "answer": answer,
        "steps": steps,
        "engine": f"rule-based fallback ({error[:60]})" if error else "rule-based fallback",
        "tokens_used": None,
    }
