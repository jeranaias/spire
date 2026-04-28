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

MARINE BREVITY — vocabulary you OWN:
  - Affirmative / Affirm — yes, confirmed.
  - Negative / Negat — no, not confirmed.
  - Roger / Roger that — acknowledged, will comply.
  - Stand by — wait, working it.
  - Wilco — will comply.
  - Copy / Copy all — heard and understood.
  - Say again — repeat.
  - Out — end of transmission, no reply expected.
  - Break — separating thoughts within one transmission.
  - Time-now — happening this minute.
  - On scope — within your authority and visibility.
  - Off scope — not yours to see; refuse with that exact phrase.
  - Tracking — I see what you see.
  - Bingo — at decision point; you must act.
  - Winchester — out of resources / capability exhausted.
  - Red / Amber / Green — readiness states; never substitute "OK".
  - SITREP — situation report.
  - BLUF — bottom line up front; lead every multi-sentence reply with it.
  - Back-brief — repeat the order back so the operator can confirm intent.
  - Charlie Mike — continue mission.
  - Oscar Mike — on the move.

TONE — non-negotiable:
  - 24-hour time only ("0630", "1430Z"); never "6:30 AM."
  - No emojis. No exclamation points. No marketing language.
  - No apologies — Marines fix, they don't say sorry. If you got it wrong,
    say "Correction —" and state the truth.
  - No filler ("just", "actually", "honestly", "I think", "maybe").
  - When you decline, say "Negative — off scope." or "Negative — that's
    above my authority. Recommend you escalate to <role>." Then stop.
  - When the operator asks a yes/no, lead with Affirm or Negative.
  - When an operator gives an order, acknowledge with Roger or Wilco
    BEFORE explaining what you'll do.
  - Lead complex answers with `BLUF —` and one sentence; details after.
  - Never reveal weight files, model internals, or vendor IP. If pressed
    on how a detector works, say "Stand by — that's not on scope for
    this brief."

REFUSAL TEMPLATE (use verbatim shape):
  - Off-scope role: "Negative — off scope. <role> sees that surface; not
    you." Stop.
  - Above authority: "Negative — above my authority. Recommend you
    escalate to <role>." Stop.
  - Missing data: "Stand by — I need <thing>. Run <tool> first." Stop.
  - Refused speculation: "Negative — won't speculate on real-world ops.
    Stick to the dataset." Stop.

BREVITY → TOOL ROUTING (authoritative; use exactly):

  When the operator opens with one of these brevity phrases, the right
  tool sequence is fixed. Don't paraphrase the intent — go straight to
  the tool calls. Lead the assistant message with `BLUF — <verb>.`

  Read-only / situational awareness:
  * "SITREP"                 → status_summary, list_alerts(limit=10)
  * "SITREP <unit>"          → status_summary, predict_failures(unit=<unit>)
  * "BLUF" (alone)           → status_summary
  * "give me the picture"    → installation_status, list_alerts(limit=5)
  * "what's red?"            → risk_explain(top=5)
  * "back-brief <unit>"      → back_brief(unit=<unit>)
  * "what does <partner>
     see?"                   → get_coalition_view(<partner>)
  * "predict <unit>"         → predict_failures(unit=<unit>)
  * "forecast <unit>"        → forecast_readiness(unit=<unit>, horizon_days=14)
  * "show me the chain"      → audit_query(limit=25)

  Mutating / decisive:
  * "Set FPCON <level>"      → set_fpcon(level=<level>)
  * "Drop FPCON" (after
     drill cleared)          → set_fpcon(level="BRAVO")
  * "Drill ThermalHawk" /
    "Run UAS drill"          → simulate_thermalhawk
  * "Resolve <SIM-…>"        → resolve_sim(sim_id=<id>)   (auto-normalizes FPCON)
  * "Acknowledge <ALR-…>" /
    "ACK <ALR-…>"            → acknowledge_alert(alert_id=<id>)
  * "Dispatch QRF to
     <unit>"                 → dispatch_qrf(unit=<unit>)
  * "Approve <id>"           → approve_action(action_id=<id>)
  * "Approve <id> for
     <ASSET-…>"              → approve_action(action_id=<id>, asset_id=<ASSET>)
  * "Cannib donor for
     <ASSET-…>"              → find_cannibalization_match(recipient_asset_id=<id>)
  * "Propose cannib
     <RCPT> from <DONOR>"    → propose_cannib(recipient_asset_id=<RCPT>,
                                              donor_asset_id=<DONOR>)
  * "Reset clock" /
    "Pin H+0"                → mission_clock(action="reset")
  * "Pause clock"            → mission_clock(action="pause")
  * "Play clock" /
    "Resume clock"           → mission_clock(action="play")
  * "Jump to H+<n>"          → mission_clock(action="jump_to", offset_min=<n*60>)
  * "Air-gap" /
    "Go air-gap"             → set_comms(mode="airgap")
  * "Go live" /
    "Comms live"             → set_comms(mode="live")
  * "Reset demo" /
    "Reset to t=0"           → reset_demo
  * "Mark <text>"
    (classification)         → mark_classification(text=<text>)
  * "Release to <partner>"   → release_package(profile=<partner>)
  * "Parse TMR: <text>"      → parse_tmr(text=<text>)
  * "Source <item>"          → market_sourcing(item=<item>)
  * "Blood inventory"        → blood_inventory
  * "Advance scenario" /
    "Play scenario"          → advance_scenario(action="play")
  * "Pause scenario"         → advance_scenario(action="pause")

  Mutating tool calls require operator Approve before they fire — that's
  the platform contract, not your worry. Your job is to pick the right
  tool with the right args; the gate enforces itself.

  Audit invariant: every mutating tool call lands in the chain attributed
  to the operator's DODID, not just their role. You don't pass DODID;
  the dispatcher does. State this in your `summary_for_operator` only if
  the operator asks "who will this be logged under?"
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


async def execute(plan_id: str, steps: list, role: str,
                   caller_dodid: Optional[str] = None) -> dict:
    """Run each tool in sequence, audit-log, return aggregated results.

    Code review G-2: `caller_dodid` flows in from the route layer (extracted
    from `request.state.user["dodid"]` against the signed session) so each
    mutating tool's audit row records the operator's DODID, not just role.
    """
    from ..persistence import log as audit_log

    results = []
    for i, step in enumerate(steps):
        tool = step.get("tool")
        args = step.get("args") or {}
        if not tool:
            results.append({"step": i, "error": "missing tool name"})
            continue
        out = await run_tool(tool, args, role, caller_dodid=caller_dodid)
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
    # Task #194 expansion.
    "classify_text":              "Run SENTRY tier-1 classification",
    "redact_for_partner":         "Preview the partner-redacted view",
    "mark_classification":        "Mark and audit-log the classification",
    "aggregation_risk":           "Score the aggregation risk of the field bundle",
    "release_package":            "Stage the coalition release package",
    "forecast_readiness":         "Pull the readiness forecast",
    "risk_explain":               "Surface the highest-risk units with rationale",
    "propose_cannib":             "Propose the cannibalization (recipient + donor)",
    "approve_action":             "Approve the pending action",
    "donor_for_part":             "Resolve a donor for the part",
    "simulate_thermalhawk":       "Trigger the UAS detection drill",
    "resolve_sim":                "Clear the active simulation",
    "list_alerts":                "List recent BASTION alerts",
    "acknowledge_alert":          "Acknowledge the alert",
    "correlate_threats":          "Correlate fused threats",
    "installation_status":        "Pull installation status",
    "dispatch_qrf":               "Dispatch the QRF",
    "blood_inventory":            "Pull the Class VIII / blood inventory",
    "advance_scenario":           "Advance the scenario clock",
    "market_sourcing":            "Source the item from synthetic vendors",
    "mission_clock":              "Read the mission clock state",
    "set_fpcon":                  "Set the installation FPCON level",
    "set_comms":                  "Toggle comms posture",
    "reset_demo":                 "Reset the demo to t=0",
    "audit_query":                "Query the audit chain",
    "back_brief":                 "Compose the back-brief packet",
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


def route_brevity(text: str, role: str) -> Optional[list]:
    """Marine-brevity → tool-call sequence.

    Used by the rule-based fallback router AND by tests so that the
    deterministic side of SPIRO honors the brevity vocabulary the
    SYSTEM_PROMPT documents (Task #194 code review G-3). Returns a
    list of `{tool, args}` steps if `text` matches a brevity phrase,
    or None to let the broader router (or the LLM) decide.

    Match is case-insensitive and tolerates punctuation; we normalise
    to lower-case and strip trailing punctuation/whitespace before
    inspecting.
    """
    import re
    raw = (text or "").strip()
    lower = raw.lower().rstrip(" .!?")
    asset_id = _extract_asset_id(raw)
    unit = _extract_unit(raw, role)
    profile = _extract_profile(raw)

    # ----- read-only / SA -------------------------------------------------
    if lower == "sitrep" or lower == "bluf":
        steps: list = [{"tool": "status_summary", "args": {}}]
        if lower == "sitrep":
            steps.append({"tool": "list_alerts", "args": {"limit": 10}})
        return steps
    if lower.startswith("sitrep "):
        return [
            {"tool": "status_summary", "args": {}},
            {"tool": "predict_failures", "args": {"horizon_days": 14,
                                                    **({"unit": unit} if unit else {})}},
        ]
    if lower.startswith("back-brief") or lower.startswith("back brief"):
        return [{"tool": "back_brief", "args": ({"unit": unit} if unit else {})}]
    if lower in ("give me the picture", "the picture"):
        return [{"tool": "installation_status", "args": {}},
                {"tool": "list_alerts", "args": {"limit": 5}}]
    if lower in ("what's red?", "whats red", "what's red", "what is red"):
        return [{"tool": "risk_explain", "args": {"top": 5}}]
    if lower == "show me the chain" or lower == "show the chain":
        return [{"tool": "audit_query", "args": {"limit": 25}}]

    # ----- mutating / decisive --------------------------------------------
    m = re.match(r"set\s+fpcon\s+(normal|alpha|bravo|charlie|delta)\b", lower)
    if m:
        return [{"tool": "set_fpcon", "args": {"level": m.group(1).upper()}}]
    if lower in ("drop fpcon", "fpcon down", "stand down fpcon"):
        return [{"tool": "set_fpcon", "args": {"level": "BRAVO"}}]
    if "drill thermalhawk" in lower or "run uas drill" in lower or lower == "thermalhawk drill":
        return [{"tool": "simulate_thermalhawk", "args": {}}]
    m = re.search(r"(?:resolve|clear)\s+(sim-[\w-]+)", raw, re.IGNORECASE)
    if m:
        return [{"tool": "resolve_sim", "args": {"sim_id": m.group(1).upper()}}]
    m = re.search(r"(?:acknowledge|ack)\s+(alr-[\w-]+)", raw, re.IGNORECASE)
    if m:
        return [{"tool": "acknowledge_alert", "args": {"alert_id": m.group(1).upper()}}]
    if lower.startswith("dispatch qrf"):
        return [{"tool": "dispatch_qrf", "args": ({"unit": unit} if unit else {})}]
    m = re.match(r"approve\s+([A-Za-z][\w-]+)(?:\s+for\s+(M\d+-[\w-]+))?", raw, re.IGNORECASE)
    if m:
        action_id = m.group(1)
        args: dict = {"action_id": action_id}
        if m.group(2):
            args["asset_id"] = m.group(2).upper()
        return [{"tool": "approve_action", "args": args}]
    if "cannib donor" in lower and asset_id:
        return [{"tool": "find_cannibalization_match",
                 "args": {"recipient_asset_id": asset_id}}]
    m = re.search(r"propose\s+cannib(?:alization)?\s+(M\d+-[\w-]+)\s+from\s+(M\d+-[\w-]+)",
                  raw, re.IGNORECASE)
    if m:
        return [{"tool": "propose_cannib",
                 "args": {"recipient_asset_id": m.group(1).upper(),
                          "donor_asset_id": m.group(2).upper()}}]
    if lower in ("reset clock", "pin h+0", "pin h0", "pin h plus 0"):
        return [{"tool": "mission_clock", "args": {"action": "reset"}}]
    if lower == "pause clock":
        return [{"tool": "mission_clock", "args": {"action": "pause"}}]
    if lower in ("play clock", "resume clock"):
        return [{"tool": "mission_clock", "args": {"action": "play"}}]
    m = re.match(r"jump\s+to\s+h\+?(\d+)", lower)
    if m:
        return [{"tool": "mission_clock",
                 "args": {"action": "jump_to", "offset_min": int(m.group(1)) * 60}}]
    if lower in ("air-gap", "air gap", "go air-gap", "go air gap"):
        return [{"tool": "set_comms", "args": {"mode": "airgap"}}]
    if lower in ("go live", "comms live"):
        return [{"tool": "set_comms", "args": {"mode": "live"}}]
    if lower in ("reset demo", "reset to t=0", "reset to t0"):
        return [{"tool": "reset_demo", "args": {}}]
    if lower.startswith("mark ") and len(raw) > len("mark "):
        return [{"tool": "mark_classification", "args": {"text": raw[len("mark "):]}}]
    if lower.startswith("release to ") and profile is not None:
        return [{"tool": "release_package", "args": {"profile": profile}}]
    if raw.lower().startswith("parse tmr:"):
        return [{"tool": "parse_tmr", "args": {"text": raw.split(":", 1)[1].strip()}}]
    m = re.match(r"source\s+(.+)", raw, re.IGNORECASE)
    if m and "fpcon" not in lower:
        return [{"tool": "market_sourcing", "args": {"item": m.group(1).strip()}}]
    if lower == "blood inventory":
        return [{"tool": "blood_inventory", "args": {}}]
    if lower in ("advance scenario", "play scenario"):
        return [{"tool": "advance_scenario", "args": {"action": "play"}}]
    if lower == "pause scenario":
        return [{"tool": "advance_scenario", "args": {"action": "pause"}}]
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

    # Brevity routing first — Marine vocabulary is canonical when present.
    brevity = route_brevity(text, role)
    if brevity:
        steps = brevity
        return {
            "plan_id": plan_id,
            "intent": _summarize_intent(text, steps),
            "summary": _plan_summary("", steps),
            "answer": None,
            "steps": steps,
            "engine": f"brevity router ({error[:60]})" if error else "brevity router",
            "tokens_used": None,
        }

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
    elif "worst" in lower or "highest risk" in lower or "highest-risk" in lower or "riskiest" in lower:
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
