"""Decision Bridge — Task #24 ([W1] "15-second decision" hero dashboard).

Thin aggregator endpoints that pre-shape the data the five hero tiles
need: mission strap, top-3 alerts, top-3 forecasted shortages
(Class IX / Class VIII blood / Class III fuel), MC% by unit with
sparklines + 7-day delta, and audit-chain health (events/min plus the
last anomaly).

Each tile is fetched on its own cadence (alerts 10s, MC% 60s, audit 5s)
so the routes stay scoped to their consumer. The shapes here are
deliberately narrow — the upstream BASTION / PULSE / SENTRY / ADMIN
endpoints already serve the wide views; this module only collapses what
the bridge needs into stable, no-shape-mismatch payloads.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query

from ..persistence import conn, recent_entries, verify_chain
from ..scoping import allowed_units, filter_units
from ..state import get_dataset

router = APIRouter()


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _load_installation_block() -> dict:
    """Read installation metadata (name, FPCON default, mission objective)
    from the canonical installation file. Returns the same dict shape the
    BASTION cop endpoint exposes, keyed for easy spread into the mission
    tile. Tolerant of a missing file — returns sensible blanks."""
    repo_root = Path(__file__).resolve().parent.parent.parent
    path = repo_root / "dataset" / "data" / "installation_data.json"
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        inst = raw.get("installation", {}) or {}
        return inst
    except Exception:
        return {}


def _parent_command(ds) -> str:
    parents = Counter(u.parent for u in ds.units if u.parent)
    return parents.most_common(1)[0][0] if parents else "MLG"


# ---------------------------------------------------------------------------
# Mission tile — FPCON, installation, mission objective, dataset day.
# ---------------------------------------------------------------------------

@router.get("/mission")
async def mission():
    """Mission strap: installation name, FPCON default, mission objective.

    The Mission Clock on the front-end ticks on real wall-clock UTC; this
    endpoint is the source for the static context (FPCON, installation
    name, mission task) that surrounds it.
    """
    ds = get_dataset()
    inst = _load_installation_block()
    parent = _parent_command(ds)
    objective_template = inst.get("mission_objective") or ""
    ccir_templates = inst.get("ccir") or []
    installation_name = inst.get("name") or "Installation"
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None
    return {
        "fpcon_default": inst.get("fpcon_default", "BRAVO"),
        "installation_name": installation_name,
        "parent_command": parent,
        "mission_essential_task": inst.get("mission_essential_task"),
        "mission_objective": (
            objective_template.format(parent=parent, installation=installation_name)
            if objective_template else None
        ),
        "ccir": [
            t.format(parent=parent, installation=installation_name)
            for t in ccir_templates
        ],
        "dataset_day": last_day.isoformat() if last_day else None,
        "as_of": _now_iso(),
    }


# ---------------------------------------------------------------------------
# Alerts tile — top-3 by severity, plus the full severity_counts breakdown.
# ---------------------------------------------------------------------------

_SEV_RANK = {"CRITICAL": 4, "HIGH": 3, "MODERATE": 2, "LOW": 1, "INFO": 0}


# Bridge tile only ever surfaces alerts inside this rolling window. Older
# rows (e.g. a SENTRY mismark dated nine months back because the underlying
# SR was opened then) still appear deeper in BASTION, but they have no
# business pretending to be live decision context on the bridge.
_BRIDGE_ALERT_MAX_AGE_DAYS = 30


@router.get("/alerts")
async def alerts_top(role: Optional[str] = None, limit: int = Query(3, ge=1, le=10)):
    """Top-N alerts ordered by severity, then recency. Wraps the BASTION
    alert builder so the tile and the BASTION view agree on shape and
    counts.

    The bridge applies two extra filters on top of the BASTION feed:

    1. Recency cutoff — alerts older than `_BRIDGE_ALERT_MAX_AGE_DAYS`
       (anchored to the dataset day, since SR-derived alerts inherit
       `sr.open_date` for their timestamp) are dropped from the bridge.
       Without this, MODERATE SENTRY mismarks dated ~12 months back leak
       into the second/third slot and make the dashboard read as stale.
    2. Within each severity band, sort by timestamp DESCENDING (most
       recent first) instead of ascending. Combined with the recency
       cutoff this guarantees the top three rows are both current and
       severity-correct.
    """
    # Inline import to avoid module-level cycle with bastion's dataset hooks.
    from .bastion import alerts as bastion_alerts  # type: ignore[attr-defined]
    result = await bastion_alerts(limit=max(limit, 30), role=role)  # type: ignore[misc]
    items = list(result.get("alerts", []) or [])

    # Recency cutoff anchored to the dataset day so the bridge behaves
    # consistently across demo replays (where wall-clock != dataset day).
    ds = get_dataset()
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None
    if last_day is not None:
        cutoff_dt = datetime.combine(last_day, datetime.min.time()) - timedelta(days=_BRIDGE_ALERT_MAX_AGE_DAYS)
        cutoff_iso = cutoff_dt.isoformat(timespec="seconds") + "Z"
        items = [a for a in items if a.get("timestamp", "") >= cutoff_iso]

    # Stable two-pass sort: timestamp DESC first, then severity DESC.
    # Python's sort is stable, so within each severity the most recent
    # alert lands in slot 1 of that band.
    items.sort(key=lambda a: a.get("timestamp", ""), reverse=True)
    items.sort(key=lambda a: _SEV_RANK.get(a.get("severity", "INFO"), 0), reverse=True)

    # Severity counts must match the post-filter view, otherwise the tile's
    # count badge claims rows that no longer appear in the bridge feed.
    sev_counts: dict[str, int] = {}
    for a in items:
        sev_counts[a["severity"]] = sev_counts.get(a["severity"], 0) + 1

    return {
        "alerts": items[:limit],
        "severity_counts": sev_counts,
        "total": len(items),
        "as_of": _now_iso(),
    }


# ---------------------------------------------------------------------------
# Shortages tile — top-3 forecasted Class IX / VIII / III shortages with
# H+hours-to-stockout. Class IX is derived from real open requisitions;
# Class VIII (blood) and Class III (fuel) are deterministically synthesized
# off the dataset day + unit count so the demo shows the full picture
# without inventing per-record inventory the dataset doesn't carry.
# ---------------------------------------------------------------------------

def _hours_until(target: datetime, now: Optional[datetime] = None) -> int:
    now = now or datetime.utcnow()
    delta = target - now
    return max(0, int(delta.total_seconds() // 3600))


def _stable_int(seed: str, lo: int, hi: int) -> int:
    """Deterministic int in [lo, hi] from a seed string."""
    h = hashlib.sha256(seed.encode()).digest()
    n = int.from_bytes(h[:4], "big")
    return lo + (n % (hi - lo + 1))


# SR conditions that mark a requisition as mission-essential. "Deadlined"
# corresponds to NMCS (the asset is down), "Degraded" corresponds to PMC
# (the asset can fight but a primary capability is impaired). Anything
# else ("Minor", "Supply", "Service") is a routine corrective action —
# CARC paint touch-ups, lube-order top-offs, depot-paperwork rework — and
# has no place leading the Forecasted Shortages tile on the bridge.
_MISSION_ESSENTIAL_SR_CONDITIONS = {"Deadlined", "Degraded"}


def _class_ix_shortages(ds, allowed: Optional[set[str]], top: int) -> list[dict]:
    """Aggregate open requisitions by NSN. Hours-to-stockout is the wait
    between request and projected receipt (longer waits = more imminent
    consumption pressure on the unit's working stock).

    Only NSNs that are mission-essential — i.e. tied to at least one
    Deadlined (NMCS) or Degraded (PMC) Service Request — survive into
    the bridge tile. The earlier heuristic let aged Minor-condition
    requisitions (corrosion-control paint, primer, cleaning supplies)
    bubble to the top because hours-to-stockout grows with requisition
    age regardless of mission impact, which is how `PAINT, CARC GREEN`
    landed in the Hayes lead slot. Routine reqs are still surfaced
    deeper in PULSE — they're just not bridge-grade.
    """
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None
    by_nsn: dict[str, dict] = {}
    today = datetime.utcnow()
    for sr in ds.srs:
        if allowed is not None and sr.unit_name not in allowed:
            continue
        sr_is_mission_essential = sr.condition in _MISSION_ESSENTIAL_SR_CONDITIONS
        for r in sr.requisitions:
            # Open requisitions only — anything received before the last
            # dataset day is no longer a pending shortage.
            if r.received_date is not None and last_day is not None and r.received_date <= last_day:
                continue
            ordered = r.ordered_date
            entry = by_nsn.setdefault(r.nsn, {
                "nsn": r.nsn,
                "nomenclature": r.nomenclature,
                "units": set(),
                "open_count": 0,
                "max_age_days": 0,
                "first_ordered": ordered,
                # An NSN aggregate is mission-essential if ANY of its
                # contributing SRs is Deadlined / Degraded — a single
                # NMCS-blocking req is enough to put the part on the
                # bridge.
                "mission_essential": False,
            })
            entry["units"].add(sr.unit_name)
            entry["open_count"] += 1
            if sr_is_mission_essential:
                entry["mission_essential"] = True
            age = (today.date() - ordered).days if ordered else 0
            if age > entry["max_age_days"]:
                entry["max_age_days"] = age
            if entry["first_ordered"] is None or (ordered and ordered < entry["first_ordered"]):
                entry["first_ordered"] = ordered

    items: list[dict] = []
    for nsn, e in by_nsn.items():
        if not e["mission_essential"]:
            continue
        # Hours-to-stockout heuristic:
        #   nominal MILSTRIP lead time = 17 days (~408h) for medium-priority
        #   resupply. The longer the requisition has been open, the closer
        #   the unit is to consuming its working stock. We model the
        #   stockout window as `max(0, lead - age)` capped at the lead
        #   ceiling. Aged-past-lead reqs report a small positive number
        #   (8h × open_count, clamped to 1-72h) so the row remains a
        #   sortable "imminent" shortage instead of all collapsing to 0.
        lead_hours = 17 * 24 - e["max_age_days"] * 24
        if lead_hours <= 0:
            # Overdue resupply — pressure scales with how many open reqs
            # are stacked against the same NSN.
            lead_hours = max(1, min(72, 72 - e["open_count"] * 6))
        items.append({
            "kind": "class_ix",
            "label": "Class IX (Repair Parts)",
            "item": e["nomenclature"],
            "nsn": nsn,
            "units_affected": sorted(list(e["units"]))[:3],
            "units_affected_count": len(e["units"]),
            "open_requisitions": e["open_count"],
            "hours_to_stockout": int(lead_hours),
            "drill_unit": next(iter(e["units"]), None) if e["units"] else None,
        })
    items.sort(key=lambda x: x["hours_to_stockout"])
    return items[:top]


def _class_viii_shortages(ds, allowed: Optional[set[str]], top: int) -> list[dict]:
    """Class VIII (Medical / Blood) shortages — deterministic, anchored to
    the dataset day so the tile is stable across reloads. Synthesized off
    the unit roster because the canonical dataset does not carry blood
    inventory; values represent a believable medical-supply pressure tied
    to the casualty-evacuation roster."""
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else datetime.utcnow().date()
    units_in_scope = [u.name for u in filter_units(ds, None) if allowed is None or u.name in allowed]
    products = [
        ("Whole Blood (O+)", "BBI"),
        ("Whole Blood (O-)", "BBI"),
        ("Plasma (Liquid)", "BBI"),
        ("Platelets", "BBI"),
    ]
    items: list[dict] = []
    for prod, supply in products:
        # Pick a deterministic unit per product+day; this maps cleanly to
        # the responsible BAS / shock-trauma platoon for drill-through.
        if not units_in_scope:
            unit = None
        else:
            idx = _stable_int(f"{prod}|{last_day.isoformat()}", 0, len(units_in_scope) - 1)
            unit = units_in_scope[idx]
        # Hours-to-stockout: 18-72h band, deterministic per product+day.
        hours = _stable_int(f"{prod}|{last_day.isoformat()}|hrs", 18, 72)
        items.append({
            "kind": "class_viii",
            "label": "Class VIII (Blood)",
            "item": prod,
            "supply_class": supply,
            "units_affected": [unit] if unit else [],
            "units_affected_count": 1 if unit else 0,
            "hours_to_stockout": hours,
            "drill_unit": unit,
        })
    items.sort(key=lambda x: x["hours_to_stockout"])
    return items[:top]


def _class_iii_shortages(ds, allowed: Optional[set[str]], top: int) -> list[dict]:
    """Class III (Fuel / POL) shortages — deterministic, anchored to the
    dataset day. Synthesized because the canonical dataset does not
    carry tank-by-tank fuel state; values represent a believable
    consumption-pressure picture tied to vehicle operating tempo."""
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else datetime.utcnow().date()
    units_in_scope = [u.name for u in filter_units(ds, None) if allowed is None or u.name in allowed]
    products = [
        ("JP-8", "Bulk Fuel Tank A"),
        ("Diesel (DF-2)", "Motor-Pool Pad"),
        ("MOGAS", "Generator Stand"),
    ]
    items: list[dict] = []
    for prod, location in products:
        if not units_in_scope:
            unit = None
        else:
            idx = _stable_int(f"{prod}|{last_day.isoformat()}|fuel", 0, len(units_in_scope) - 1)
            unit = units_in_scope[idx]
        hours = _stable_int(f"{prod}|{last_day.isoformat()}|fuel|hrs", 24, 96)
        items.append({
            "kind": "class_iii",
            "label": "Class III (Fuel)",
            "item": prod,
            "location": location,
            "units_affected": [unit] if unit else [],
            "units_affected_count": 1 if unit else 0,
            "hours_to_stockout": hours,
            "drill_unit": unit,
        })
    items.sort(key=lambda x: x["hours_to_stockout"])
    return items[:top]


@router.get("/shortages")
async def shortages_top(role: Optional[str] = None, limit: int = Query(3, ge=1, le=10)):
    """Top-N forecasted shortages across Class IX (Repair Parts),
    Class VIII (Blood / Medical), and Class III (Fuel / POL).

    The first three slots are class-diverse — one most-imminent row from
    each of IX / VIII / III — so the tile reads as a balanced supply
    posture instead of three identical Class IX rows when one class
    dominates the open-requisition queue. Slots beyond the third fill
    in by overall hours-to-stockout ascending.
    """
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    by_class = {
        "class_ix":   _class_ix_shortages(ds, allowed, top=10),
        "class_viii": _class_viii_shortages(ds, allowed, top=10),
        "class_iii":  _class_iii_shortages(ds, allowed, top=10),
    }
    diverse: list[dict] = []
    for kind in ("class_ix", "class_viii", "class_iii"):
        bucket = by_class[kind]
        if bucket:
            diverse.append(bucket[0])
    diverse.sort(key=lambda x: x["hours_to_stockout"])

    if limit <= len(diverse):
        out = diverse[:limit]
    else:
        # Fill remaining slots with the next-most-imminent rows across
        # all classes that aren't already in the diverse seed.
        seen = {(s["kind"], s["item"]) for s in diverse}
        rest = [
            s for kind in by_class for s in by_class[kind]
            if (s["kind"], s["item"]) not in seen
        ]
        rest.sort(key=lambda x: x["hours_to_stockout"])
        out = (diverse + rest)[:limit]

    return {
        "shortages": out,
        "as_of": _now_iso(),
        "categories_present": sorted({s["kind"] for s in out}),
    }


# ---------------------------------------------------------------------------
# MC% by unit tile — top-3 lowest-MC% units with 7-day sparkline + delta.
# ---------------------------------------------------------------------------

@router.get("/mc-by-unit")
async def mc_by_unit(role: Optional[str] = None, limit: int = Query(3, ge=1, le=10)):
    """Top-N units sorted by lowest current MC%. Each row carries a 7-day
    daily MC% sparkline plus the 7-day delta vs the prior 7 days. The
    sparkline lets the operator spot a unit that is sliding even if it
    hasn't crossed threshold yet."""
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    if not ds.snapshots:
        return {"units": [], "as_of": _now_iso()}

    # Bucket snapshots by (unit, date).
    by_unit_date: dict[str, dict] = defaultdict(lambda: defaultdict(Counter))
    for s in ds.snapshots:
        if allowed is not None and s.unit_name not in allowed:
            continue
        by_unit_date[s.unit_name][s.snapshot_date][s.readiness_code] += 1

    last_day = ds.snapshots[-1].snapshot_date
    sorted_dates = sorted({s.snapshot_date for s in ds.snapshots})
    last7 = sorted_dates[-7:]
    prior7 = sorted_dates[-14:-7] if len(sorted_dates) >= 14 else sorted_dates[:max(1, len(sorted_dates) - 7)]

    rows: list[dict] = []
    for unit, by_date in by_unit_date.items():
        sparkline: list[float] = []
        for d in last7:
            c = by_date.get(d) or {}
            total = sum(c.values()) or 0
            mc_n = c.get("MC", 0) if isinstance(c, dict) else c["MC"]
            sparkline.append(round((mc_n / total) if total else 0.0, 3))
        if not sparkline:
            continue

        def _avg(window):
            vals = []
            for d in window:
                c = by_date.get(d) or {}
                total = sum(c.values()) or 0
                if total == 0:
                    continue
                vals.append((c.get("MC", 0) if isinstance(c, dict) else c["MC"]) / total)
            return sum(vals) / len(vals) if vals else 0.0

        recent = _avg(last7)
        prior = _avg(prior7)
        # Today's value (last entry of the sparkline) is the "current MC%"
        # the operator triages on.
        current = sparkline[-1]
        c_last = by_date.get(last_day) or {}
        total_last = sum(c_last.values()) or 0
        rows.append({
            "unit": unit,
            "current_mc_rate": current,
            "delta_7d": round(recent - prior, 3),
            "sparkline_7d": sparkline,
            "asset_total": total_last,
            "mc_count": (c_last.get("MC", 0) if isinstance(c_last, dict) else c_last["MC"]),
        })

    rows.sort(key=lambda r: r["current_mc_rate"])
    return {
        "units": rows[:limit],
        "as_of": _now_iso(),
        "dataset_day": last_day.isoformat(),
    }


# ---------------------------------------------------------------------------
# Audit health tile — events/min, last anomaly, total entries, chain status.
# ---------------------------------------------------------------------------

def _events_per_minute(window_minutes: int = 5) -> tuple[float, int]:
    """Compute a rolling events-per-minute rate over the last N minutes
    plus the count in that window. Reads timestamps directly off the
    audit_log table — cheap (indexed on ts)."""
    cutoff = (datetime.utcnow() - timedelta(minutes=window_minutes)).isoformat(timespec="seconds") + "Z"
    try:
        with conn() as c:
            row = c.execute(
                "SELECT COUNT(*) AS n FROM audit_log WHERE ts >= ?",
                (cutoff,),
            ).fetchone()
        n = int(row["n"]) if row else 0
    except sqlite3.OperationalError:
        # Table may be mid-init on a fresh boot.
        n = 0
    rate = n / window_minutes if window_minutes > 0 else 0.0
    return round(rate, 2), n


@router.get("/audit")
async def audit_health(window_minutes: int = Query(5, ge=1, le=60)):
    """Audit-chain pulse for the bridge tile: chain integrity, total
    entries, events/min over the last N minutes, latest entry timestamp,
    and the last detected anomaly (if the chain has ever broken)."""
    chain = verify_chain()
    rate, count_in_window = _events_per_minute(window_minutes)
    latest = recent_entries(limit=1)
    last_entry_ts = latest[0]["ts"] if latest else None
    last_entry_kind = latest[0]["kind"] if latest else None
    # "Last anomaly" — chain.broken_at_id is the only persistent anomaly
    # signal we expose. The recent-entries pull surfaces ts so the tile
    # can show "last verified" relative time.
    last_anomaly = None
    if not chain.get("ok"):
        last_anomaly = {
            "broken_at_id": chain.get("broken_at_id"),
            "as_of": _now_iso(),
        }
    return {
        "chain_ok": bool(chain.get("ok")),
        "total_entries": chain.get("entries", 0),
        "head_hash": chain.get("head_hash"),
        "events_per_minute": rate,
        "events_in_window": count_in_window,
        "window_minutes": window_minutes,
        "last_entry_at": last_entry_ts,
        "last_entry_kind": last_entry_kind,
        "last_anomaly": last_anomaly,
        "as_of": _now_iso(),
    }
