"""
NL TMR parser + validator.

Rule-based extraction for the Easter-egg demo. When Gemma4 comes back,
parse_tmr_text_llm() will replace the regex-only path; today it's the only
path so the demo works offline. Validates against a synthetic installation
movement policy and returns the routed approval chain.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Synthetic installation movement policy
# ---------------------------------------------------------------------------

KNOWN_LOCATIONS = {
    "lejeune": "Camp Lejeune, NC",
    "camp lejeune": "Camp Lejeune, NC",
    "pendleton": "Camp Pendleton, CA",
    "camp pendleton": "Camp Pendleton, CA",
    "geiger": "Camp Geiger, NC",
    "camp geiger": "Camp Geiger, NC",
    "cherry point": "MCAS Cherry Point, NC",
    "beaufort": "MCAS Beaufort, SC",
    "yuma": "MCAS Yuma, AZ",
    "henderson": "Camp Henderson (synthetic)",
    "albany": "MCLB Albany, GA",
    "barstow": "MCLB Barstow, CA",
    "kinser": "Camp Kinser, Okinawa",
    "twentynine palms": "MCAGCC 29 Palms, CA",
}

EQUIPMENT_KEYWORDS = {
    "jltv": "JLTV",
    "mtvr": "MTVR_CARGO",
    "7-ton": "MTVR_CARGO",
    "7 ton": "MTVR_CARGO",
    "wrecker": "MTVR_WRECKER",
    "lvsr": "LVSR",
    "trailer": "TRAILER_M1095",
    "generator": "MEP_803A",
    "abrams": "M1A1_ABRAMS",
    "tank": "M1A1_ABRAMS",
    "m88": "M88A2_RECOVERY",
    "lav": "LAV_25",
    "osprey": "MV22B_OSPREY",
    "v-22": "MV22B_OSPREY",
    "ch-53": "CH53E_STALLION",
    "mrap": "MRAP_RG31",
    "himars": "HIMARS",
    "g/ator": "AN_TPS80_GATOR",
    "gator": "AN_TPS80_GATOR",
    "firefinder": "AN_TPQ36_FIREFINDER",
    "dozer": "D7G_DOZER",
    "tram": "TRAM",
    "rowpu": "ROWPU",
}

HAZMAT_TRIGGERS = ("hazmat", "fuel", "ammo", "ordnance", "class v", "class iii")

DAY_OF_WEEK = {
    "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
    "friday": 4, "saturday": 5, "sunday": 6,
    "mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6,
}


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

class TMRRequest(BaseModel):
    origin: Optional[str] = None
    destination: Optional[str] = None
    equipment: list = Field(default_factory=list)  # list of {type, quantity}
    scheduled_date: Optional[str] = None
    hazmat: bool = False
    escort_required: bool = False
    priority: str = "ROUTINE"  # ROUTINE | PRIORITY | URGENT
    raw_text: str = ""


class TMRValidation(BaseModel):
    ok: bool
    issues: list = Field(default_factory=list)
    warnings: list = Field(default_factory=list)


class TMRApprovalStep(BaseModel):
    role: str
    reason: str


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------

def _extract_locations(text: str) -> tuple[Optional[str], Optional[str]]:
    lower = text.lower()
    origin = destination = None
    m_from = re.search(r"from\s+([a-z\s\.]+?)(?:\s+to\s+|,|\.|$)", lower)
    m_to = re.search(r"to\s+([a-z\s\.]+?)(?:[,\.\s]{2,}|$)", lower)
    if m_from:
        for k, v in KNOWN_LOCATIONS.items():
            if k in m_from.group(1):
                origin = v
                break
    if m_to:
        for k, v in KNOWN_LOCATIONS.items():
            if k in m_to.group(1):
                destination = v
                break
    if not origin or not destination:
        # Fallback: scan the text for location tokens and take first two
        found = []
        for k, v in KNOWN_LOCATIONS.items():
            pos = lower.find(k)
            if pos >= 0:
                found.append((pos, v))
        found.sort()
        if not origin and len(found) >= 1:
            origin = found[0][1]
        if not destination and len(found) >= 2:
            destination = found[1][1]
    return origin, destination


def _extract_equipment(text: str) -> list:
    lower = text.lower()
    found: list = []
    for keyword, equip_type in EQUIPMENT_KEYWORDS.items():
        # Look for a number before the keyword
        pat = re.compile(rf"(\d+)\s+{re.escape(keyword)}", re.IGNORECASE)
        m = pat.search(lower)
        if m:
            found.append({"type": equip_type, "quantity": int(m.group(1))})
        elif keyword in lower:
            found.append({"type": equip_type, "quantity": 1})
    # Dedupe keeping max quantity per type
    by_type: dict = {}
    for e in found:
        existing = by_type.get(e["type"])
        if existing is None or e["quantity"] > existing["quantity"]:
            by_type[e["type"]] = e
    return list(by_type.values())


def _extract_date(text: str) -> Optional[str]:
    lower = text.lower()
    # Today/tomorrow
    today = datetime.utcnow().date()
    if "tomorrow" in lower:
        return (today + timedelta(days=1)).isoformat()
    if "today" in lower:
        return today.isoformat()
    # Day of week in the next 7 days
    for day_token, weekday in DAY_OF_WEEK.items():
        if re.search(rf"\b{day_token}\b", lower):
            offset = (weekday - today.weekday()) % 7
            if offset == 0:
                offset = 7
            return (today + timedelta(days=offset)).isoformat()
    # ISO date
    m = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", text)
    if m:
        return m.group(1)
    return None


def _extract_hazmat(text: str) -> bool:
    lower = text.lower()
    return any(t in lower for t in HAZMAT_TRIGGERS)


def _extract_priority(text: str) -> str:
    lower = text.lower()
    if "urgent" in lower or "emergency" in lower or "asap" in lower:
        return "URGENT"
    if "priority" in lower or "high priority" in lower:
        return "PRIORITY"
    return "ROUTINE"


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _validate(tmr: TMRRequest) -> TMRValidation:
    issues = []
    warnings = []

    if not tmr.origin:
        issues.append("Origin installation not recognized. Known installations: " + ", ".join(sorted({v for v in KNOWN_LOCATIONS.values()})))
    if not tmr.destination:
        issues.append("Destination installation not recognized.")
    if not tmr.equipment:
        issues.append("No equipment identified in request.")
    if not tmr.scheduled_date:
        warnings.append("No scheduled date detected — defaulting to next business day at approval.")

    # Policy: hazmat movement requires escort
    hazmat_equipment = tmr.hazmat or any(
        e["type"] in ("HIMARS", "M1A1_ABRAMS") for e in tmr.equipment
    )
    if hazmat_equipment and not tmr.escort_required:
        warnings.append("Hazmat or controlled-item movement detected — escort recommended per installation movement policy.")

    # Policy: Urgent requests over 50 mi require MLG G-4 approval
    if tmr.priority == "URGENT":
        warnings.append("URGENT priority routes to MEF G-4 for same-day approval.")

    # Policy: Wrong-way weekday detection (informational)
    if tmr.scheduled_date:
        try:
            d = datetime.fromisoformat(tmr.scheduled_date).date()
            if d.weekday() >= 5:
                warnings.append("Scheduled date falls on weekend — policy permits weekend moves with CO approval.")
        except ValueError:
            warnings.append("Scheduled date format unrecognized.")

    return TMRValidation(ok=not issues, issues=issues, warnings=warnings)


def _approval_chain(tmr: TMRRequest, validation: TMRValidation) -> list:
    chain = []
    chain.append({"role": "Unit CO", "reason": "Requesting unit commander approval"})
    asset_ct = sum(e["quantity"] for e in tmr.equipment) or 0
    if asset_ct >= 5 or tmr.hazmat or any(e["type"] == "M1A1_ABRAMS" for e in tmr.equipment):
        chain.append({"role": "MLG G-4", "reason": "Movement ≥ 5 assets, hazmat, or M1A1"})
    if tmr.priority == "URGENT":
        chain.append({"role": "MEF G-4", "reason": "Urgent priority — MEF G-4 authority for same-day execution"})
    if any(e["type"] in ("HIMARS", "AN_TPS80_GATOR", "AN_TPQ36_FIREFINDER") for e in tmr.equipment):
        chain.append({"role": "Regional C-UAS / Security", "reason": "Controlled item transport — coordinate with security manager"})
    chain.append({"role": "Installation PMO (receiving)", "reason": "Notify receiving installation PMO for gate access"})
    return chain


# ---------------------------------------------------------------------------
# Top-level entry point
# ---------------------------------------------------------------------------

def parse_tmr_text(text: str) -> dict:
    origin, destination = _extract_locations(text)
    equipment = _extract_equipment(text)
    scheduled = _extract_date(text)
    hazmat = _extract_hazmat(text)
    priority = _extract_priority(text)
    tmr = TMRRequest(
        origin=origin,
        destination=destination,
        equipment=equipment,
        scheduled_date=scheduled,
        hazmat=hazmat,
        escort_required=hazmat,
        priority=priority,
        raw_text=text,
    )
    validation = _validate(tmr)
    chain = _approval_chain(tmr, validation)
    return {
        "tmr": tmr.model_dump(),
        "validation": validation.model_dump(),
        "approval_chain": chain,
        "engine": "Rule-based parser (Gemma4 path pending — classification-proxy :8095)",
    }
