"""Co-Pilot routes — operator AI assistant powered by Gemma 4.

POST /api/copilot/plan       → Gemma returns plan (steps to approve)
POST /api/copilot/execute    → walks the approved plan, returns results
POST /api/copilot/summarize  → 2-sentence panel summary on demand
GET  /api/copilot/tools      → tool registry (debugging)

Role enforcement is in `copilot/tools.py` — each tool wraps an existing
endpoint or helper and respects the same scope rules. So an operator's
co-pilot can never escalate scope. The `role` is taken from the
authenticated session, NOT from the request body, so a lower-privilege
operator can't ask the co-pilot to run with a higher role.
"""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Request

from ..auth import session_role
from ..copilot import plan as copilot_plan
from ..copilot import execute as copilot_execute
from ..copilot import summarize as copilot_summarize
from ..copilot.tools import TOOL_REGISTRY


router = APIRouter()


def _role(request: Request) -> str:
    return session_role(request) or "mef_commander"


@router.post("/plan")
async def make_plan(request: Request, payload: dict = Body(default={})):
    text = (payload.get("text") or "").strip()
    role = _role(request)
    view = payload.get("view") or ""
    current_data = payload.get("current_data")
    # `prior_proposal` is the steps[] from the previous assistant turn
    # — the frontend forwards it so an operator's "go" consents to the
    # proposal we just made instead of forcing the planner to re-decide.
    prior_proposal = payload.get("prior_proposal")
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    return await copilot_plan(
        text,
        role=role,
        view=view,
        current_data=current_data,
        prior_proposal=prior_proposal,
    )


@router.post("/execute")
async def execute_plan(request: Request, payload: dict = Body(default={})):
    plan_id = payload.get("plan_id") or "PL-AD-HOC"
    steps = payload.get("steps") or []
    role = _role(request)
    if not isinstance(steps, list) or not steps:
        raise HTTPException(status_code=400, detail="steps required")
    return await copilot_execute(plan_id=plan_id, steps=steps, role=role)


@router.post("/summarize")
async def summarize_panel(request: Request, payload: dict = Body(default={})):
    panel = payload.get("panel") or "unspecified"
    role = _role(request)
    data = payload.get("data") or {}
    # Capture economics around the summarize call so the operator sees
    # what each panel summary cost (D3). Reads the most-recent buffered
    # call after summarize returns — the deque is per-process and
    # append-only, so the last entry is the call we just issued.
    from ..inference_economics import _CALL_LOG  # noqa: SLF001
    pre_count = len(_CALL_LOG)
    summary = await copilot_summarize(panel=panel, data=data, role=role)
    economics: dict | None = None
    if len(_CALL_LOG) > pre_count:
        last = _CALL_LOG[-1]
        if last.get("call_site") == "copilot_panel_summary":
            economics = {
                "tier": last["tier"],
                "model": last["model"],
                "call_site": last["call_site"],
                "route": last["route"],
                "input_tokens": last["input_tokens"],
                "output_tokens": last["output_tokens"],
                "cost_usd": last["cost_usd"],
                "latency_ms": last["latency_ms"],
            }
    return {"summary": summary, "panel": panel, "economics": economics}


@router.get("/tools")
async def list_tools():
    """Debugging helper — exposes the tool registry shape."""
    return {
        "tools": [entry["definition"] for entry in TOOL_REGISTRY.values()],
        "count": len(TOOL_REGISTRY),
    }
