"""SPIRE AI Co-Pilot — Gemma-4-backed operator assistant.

Public API:
    plan(text, role, view, current_data) -> CopilotPlan
    execute(plan, role) -> CopilotResult
    summarize(panel, data) -> str

The pattern: operator types "Tell me what you want to do" → Gemma 4
returns a structured plan of tool calls → operator clicks Approve →
backend executes each tool, audit-logs, returns aggregated result.

Tools wrap existing SPIRE endpoints; the planner doesn't expose anything
the operator's role can't already reach via direct navigation. So the
co-pilot can never escalate scope — it can only save clicks.
"""
from .tools import TOOL_REGISTRY, run_tool
from .planner import plan, summarize, execute

__all__ = ["TOOL_REGISTRY", "run_tool", "plan", "summarize", "execute"]
