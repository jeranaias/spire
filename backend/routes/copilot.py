"""Co-Pilot routes — operator AI assistant powered by Gemma 4.

POST /api/copilot/plan       → Gemma returns plan (steps to approve)
POST /api/copilot/execute    → walks the approved plan, returns results
POST /api/copilot/summarize  → 2-sentence panel summary on demand
GET  /api/copilot/tools      → tool registry (debugging)

Role enforcement is in `copilot/tools.py` — each tool wraps an existing
endpoint or helper and respects the same scope rules. So an operator's
co-pilot can never escalate scope.
"""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException

from ..copilot import plan as copilot_plan
from ..copilot import execute as copilot_execute
from ..copilot import summarize as copilot_summarize
from ..copilot.tools import TOOL_REGISTRY


router = APIRouter()


@router.post("/plan")
async def make_plan(payload: dict = Body(default={})):
    text = (payload.get("text") or "").strip()
    role = payload.get("role") or "mef_commander"
    view = payload.get("view") or ""
    current_data = payload.get("current_data")
    if not text:
        raise HTTPException(status_code=400, detail="text required")
    return await copilot_plan(text, role=role, view=view, current_data=current_data)


@router.post("/execute")
async def execute_plan(payload: dict = Body(default={})):
    plan_id = payload.get("plan_id") or "PL-AD-HOC"
    steps = payload.get("steps") or []
    role = payload.get("role") or "mef_commander"
    if not isinstance(steps, list) or not steps:
        raise HTTPException(status_code=400, detail="steps required")
    return await copilot_execute(plan_id=plan_id, steps=steps, role=role)


@router.post("/summarize")
async def summarize_panel(payload: dict = Body(default={})):
    panel = payload.get("panel") or "unspecified"
    role = payload.get("role") or "mef_commander"
    data = payload.get("data") or {}
    summary = await copilot_summarize(panel=panel, data=data, role=role)
    return {"summary": summary, "panel": panel}


@router.get("/tools")
async def list_tools():
    """Debugging helper — exposes the tool registry shape."""
    return {
        "tools": [entry["definition"] for entry in TOOL_REGISTRY.values()],
        "count": len(TOOL_REGISTRY),
    }
