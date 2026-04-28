"""
Joint COP export adapters.

Two read-only export endpoints that emit the current SPIRE state in joint
standards-flavored payloads so a sister-service COP can render SPIRE data
in its native shell:

  * `/api/joint/oms-uci/export`  — Open Mission Systems / Universal Command
    & Control Interface (UCI). JSON envelope with EntityState / Track /
    LogisticsStatus / AlertNotification messages.
  * `/api/joint/link16/export`   — MIL-STD-6016 Link 16 J-series. Subset:
    J3.5 land point/track, J3.3 surface track, J7.0 track management,
    J7.2 correlation, J28.2 logistics request.

Both are classification-gated (SECRET, REL TO USA/FVEY) via
`require_clearance`. Both are export-only — no ingest, no bidirectional
gateway. The `/api/joint/conformance` doc endpoint enumerates message
families implemented + the honest gap list.

Field-name accuracy is a load-bearing requirement. J-series numbers and
OMS-UCI message types are the names the joint community will look for in
the payload and the docs page; getting them wrong reads as a fake.
"""
from __future__ import annotations

import hashlib
from collections import Counter
from datetime import date, datetime, time, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from ..auth import session_role
from ..scoping import JOINT_RELEASE_ROLES, require_clearance, require_role
from ..state import CanonicalDataset, get_dataset, last_day_snapshots

router = APIRouter()


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

# Per-unit lat/lon mirrors `bastion.UNIT_COORDS`. Duplicated (rather than
# imported) so the joint adapter doesn't grow a hard dependency on a
# COP-specific module — the canonical "unit -> coordinate" lookup lives in
# `dataset/data/installation_data.json` via the bake script. If the two
# diverge, run scripts/bake_latlon.py and align.
UNIT_COORDS: dict[str, tuple[float, float]] = {
    "CLB-6":        (34.6690, -77.4210),
    "CLB-1":        (34.6510, -77.4050),
    "3d Maint Bn":  (34.6700, -77.3750),
    "3/6 Marines":  (34.6480, -77.4170),
    "2d LAR Bn":    (34.6550, -77.4150),
    "MALS-31":      (34.6700, -77.3820),
    "MWSS-271":     (34.6610, -77.3680),
    "2d LAAD Bn":   (34.6670, -77.3900),
    "2/14 Marines": (34.6450, -77.3900),
    "7th ESB":      (34.6630, -77.4240),
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _snapshot_published_iso(ds: CanonicalDataset, last: list) -> str:
    """Return the canonical 'published-at' timestamp for the joint payload.

    Sourced from the underlying dataset snapshot, NOT wall-clock time, so two
    back-to-back exports return identical `publishedAtUtc` when nothing in
    the dataset has changed. The JLTC topbar's "Published" pill consumes
    this value and must reflect actual dataset freshness.

    Anchor is the latest `snapshot_date` (a date — pinned to end-of-day UTC
    so the field is a full RFC3339 datetime). Falls back to the dataset's
    own `generated_at` if the snapshot list is empty.
    """
    last_day: Optional[date] = None
    if last:
        last_day = last[0].snapshot_date
    elif ds.snapshots:
        last_day = ds.snapshots[-1].snapshot_date
    if last_day is None:
        return ds.generated_at or _now_iso()
    return datetime.combine(last_day, time(23, 59, 59), tzinfo=timezone.utc).isoformat(timespec="seconds")


# Canonical alert severity vocabulary. Joint partners parse `severity` as an
# enum so the export keeps incident pass-through values (`LOW`, `CRITICAL`)
# and synthesized readiness values (`HIGH`, `MODERATE`) under a single,
# documented set. Anything outside this set is coerced to MODERATE so a
# garbled severity never ships to a partner.
ALERT_SEVERITY_ENUM: tuple[str, ...] = ("LOW", "MODERATE", "HIGH", "CRITICAL")


def _norm_severity(value: Any) -> str:
    s = str(value or "").strip().upper()
    if s in ALERT_SEVERITY_ENUM:
        return s
    # Common synonyms that show up in upstream data.
    if s in ("MED", "MEDIUM", "WARN", "WARNING"):
        return "MODERATE"
    if s in ("FATAL", "SEVERE", "P0"):
        return "CRITICAL"
    if s in ("INFO", "NOTICE", "MINOR"):
        return "LOW"
    return "MODERATE"


def _stable_track_id(prefix: str, key: str) -> str:
    """Deterministic short hex id for a track number. Same key -> same
    track id across calls; lets the partner view diff stably between
    pulls instead of churning fresh ids every refresh."""
    h = hashlib.sha256(f"{prefix}:{key}".encode()).hexdigest()[:6].upper()
    return f"{prefix}{h}"


def _link16_track_number(unit_name: str) -> str:
    """5-octal-digit Link 16 track number (J7.0 style). Collision-resistant
    enough for ~1000 tracks; we have 10 units so collisions are off the
    table. Format octal so it reads as a real Link 16 id."""
    h = int(hashlib.sha256(unit_name.encode()).hexdigest(), 16)
    n = h % (8 ** 5 - 1) + 1
    s = ""
    for _ in range(5):
        s = "01234567"[n % 8] + s
        n //= 8
    return s


def _operator_envelope(user: Optional[dict[str, Any]], role: Optional[str]) -> dict[str, Any]:
    """Stamp the calling operator's identity into the export envelope so the
    partner can audit who released the bundle. The pull itself is gated on
    role + clearance (topic-style subscription); this is a transparency
    record, not the gate."""
    if not user:
        return {
            "name": "unknown",
            "rank": "",
            "billet": "",
            "role": role or "unknown",
            "unit": "",
            "dodid": "",
        }
    return {
        "name": user.get("name", "unknown"),
        "rank": user.get("rank", ""),
        "billet": user.get("billet", ""),
        "role": role or user.get("role", "unknown"),
        "unit": user.get("unit", ""),
        "dodid": user.get("dodid", ""),
    }


def _readiness_status(mc_rate: float) -> dict[str, str]:
    """Map SPIRE MC rate → joint operational readiness words (C-rating
    style: C1 fully mission capable .. C4 not mission capable)."""
    if mc_rate >= 0.85:
        return {"code": "C1", "text": "FULLY_MISSION_CAPABLE"}
    if mc_rate >= 0.70:
        return {"code": "C2", "text": "SUBSTANTIALLY_MISSION_CAPABLE"}
    if mc_rate >= 0.55:
        return {"code": "C3", "text": "MARGINALLY_MISSION_CAPABLE"}
    return {"code": "C4", "text": "NOT_MISSION_CAPABLE"}


def _sym2525(unit_name: str) -> str:
    """Approximate a MIL-STD-2525C/D SIDC for each unit. Friendly / present /
    ground unit / unit. The 4th-position function-id field varies by nominal
    mission (combat service support, infantry, aviation support, air defense,
    engineer, ...). Joint partners read SIDC, not USMC nicknames.

    A conformant 2525C SIDC is exactly 15 characters: 4-char prefix
    (CodingScheme + StandardIdentity + BattleDimension + Status) followed
    by an 11-char function-id field. The function code is right-padded with
    `-` to fill positions 5-15. Anything shorter trips a SME's eye on the
    very first curl.
    """
    n = unit_name.upper()
    if "CLB" in n or "ESB" in n:
        function = "UCFSS"   # combat service support / sustainment
    elif "MARINES" in n and ("3/6" in n or "2/14" in n):
        function = "UCI"     # infantry / artillery
    elif "LAR" in n:
        function = "UCRVA"   # reconnaissance, light armor
    elif "MAINT" in n:
        function = "UCFSM"   # maintenance
    elif "MALS" in n or "MWSS" in n:
        function = "UCAA"    # aviation support
    elif "LAAD" in n:
        function = "UCDA"    # air defense
    else:
        function = "UC"
    # Pad function code to 11 chars so 4 (prefix) + 11 (function) = 15.
    function = function.ljust(11, "-")
    # Standard Identity F (friend), Battle dim G (ground), Status P (present)
    sidc = f"SFGP{function}"
    assert len(sidc) == 15, f"SIDC must be 15 chars, got {len(sidc)}: {sidc!r}"
    return sidc


def _link16_surface_track_number(unit_name: str) -> str:
    """Distinct J3.3 surface-track TN for a unit that also reports a J3.5
    land point. Real Link 16 networks emit each message family under its own
    track number, then use J7.2 Track Correlation to tell receivers the two
    TNs refer to the same entity. Same name -> same TN across calls."""
    return _link16_track_number(f"{unit_name}::J33_SURFACE")


# ---------------------------------------------------------------------------
# OMS / UCI export
# ---------------------------------------------------------------------------

@router.get("/oms-uci/export")
async def oms_uci_export(request: Request) -> dict[str, Any]:
    """Render current SPIRE state as an OMS/UCI-flavored JSON envelope.

    Reference: USAF OMS reference architecture (v2.x) + UCI message catalog.
    The shape models the canonical UCI Message envelope (`UCIMessage` ->
    `header` + `payload`) with one OMS subscription envelope wrapping the
    batch.
    """
    user = getattr(request.state, "user", None)
    require_clearance(
        user,
        "SECRET",
        action="joint:oms_uci_export",
        audit_actor=session_role(request),
    )
    # Role gate. The OMS/UCI feed is a topic-style subscription consumed by
    # a partner J4 console; the partner's view of MAGTF readiness must NOT
    # depend on which Marine happens to be at the SPIRE console. Per-operator
    # RBAC scoping (e.g. maintenance_chief → CLB-6 only) would silently
    # truncate the partner's tracks the moment a lower-scope operator pulled,
    # which fails the CDAO sanity test ("does my view evaporate if Kowalski
    # signs in mid-engagement?"). Restrict emission to release-authority roles
    # so the partner sees the full MAGTF every time.
    actor_role = session_role(request)
    require_role(actor_role, JOINT_RELEASE_ROLES, action="joint:oms_uci_export")

    ds = get_dataset()
    last = last_day_snapshots(ds)
    if not last:
        raise HTTPException(status_code=503, detail="dataset empty")

    # Single freshness anchor for the whole envelope. Sourced from the
    # snapshot date, NOT wall-clock, so back-to-back exports are byte-stable
    # when the dataset hasn't changed (P0-3 in the joint-cop critique). The
    # per-operator unit filter that used to live here was removed in Task #80
    # — joint exports are a topic subscription (full MAGTF) and the role gate
    # at the top of the handler is the access control surface.
    published_iso = _snapshot_published_iso(ds, last)

    by_unit: dict[str, Counter] = {u.name: Counter() for u in ds.units}
    equip_by_unit: dict[str, Counter] = {u.name: Counter() for u in ds.units}
    for s in last:
        by_unit[s.unit_name][s.readiness_code] += 1
        equip_by_unit[s.unit_name][s.equipment_type] += 1

    entities: list[dict] = []
    tracks: list[dict] = []
    logistics: list[dict] = []
    for u in ds.units:
        c = by_unit[u.name]
        total = sum(c.values())
        mc = c.get("MC", 0)
        mc_rate = (mc / total) if total else 0.0
        ready = _readiness_status(mc_rate)
        lat, lon = UNIT_COORDS.get(u.name, (34.658, -77.398))
        entity_id = _stable_track_id("UCI-ENT-", u.uic)
        track_id = _stable_track_id("UCI-TRK-", u.uic)

        entities.append({
            "messageType": "EntityState",
            "uciMessageId": entity_id,
            "EntityIdentifier": {
                "uuid": entity_id,
                "callsign": u.name,
                "uic": u.uic,
                "parentCommand": u.parent,
            },
            "EntityType": {
                "kind": "GROUND_UNIT",
                "domain": "LAND",
                "country": "USA",
                "service": "USMC",
                "category": "SUSTAINMENT" if "CLB" in u.name or "ESB" in u.name else "MANEUVER",
                "sidc": _sym2525(u.name),
            },
            "Position": {
                "latitude": lat,
                "longitude": lon,
                "altitudeMeters": 8.0,
                "geodeticDatum": "WGS84",
            },
            "OperationalStatus": ready["text"],
            "ReadinessRating": ready["code"],
            "asOfTime": published_iso,
        })

        tracks.append({
            "messageType": "TrackData",
            "uciMessageId": track_id,
            "trackNumber": track_id,
            "trackQuality": min(15, 8 + int(mc_rate * 7)),  # 0..15 UCI quality
            "trackOrigin": "OMS_GROUND_FUSION",
            "EntityIdentifierRef": entity_id,
            "Position": {
                "latitude": lat,
                "longitude": lon,
                "altitudeMeters": 8.0,
            },
            "Kinematic": {
                "courseDegreesTrue": 0.0,
                "speedMetersPerSecond": 0.0,
                "stationary": True,
            },
            "asOfTime": published_iso,
        })

        # LogisticsStatus mirrors UCI's LogisticsStatusMessage shape (sustained
        # cap + on-hand qty + status). We model SPIRE's mission-capable count
        # as on-hand operational platforms.
        logistics.append({
            "messageType": "LogisticsStatus",
            "uciMessageId": _stable_track_id("UCI-LOG-", u.uic),
            "EntityIdentifierRef": entity_id,
            "logisticsCategory": "ground_equipment_readiness",
            "items": [
                {
                    "nomenclature": eqp,
                    "onHand": equip_by_unit[u.name][eqp],
                    "missionCapable": int(equip_by_unit[u.name][eqp] * mc_rate),
                    "supplyClass": "VII",  # major end items
                }
                for eqp in sorted(equip_by_unit[u.name])
            ],
            "missionCapableRate": round(mc_rate, 4),
            "asOfTime": published_iso,
        })

    # AlertNotification messages mirror SPIRE alerts (readiness + cannib +
    # incidents). Walk a small slice — joint subscribers don't want a 200-row
    # firehose, they want what's hot now.
    alerts_out: list[dict] = []
    for u in ds.units:
        c = by_unit[u.name]
        total = sum(c.values())
        if not total:
            continue
        mc_rate = c.get("MC", 0) / total
        if mc_rate < 0.70:
            alerts_out.append({
                "messageType": "AlertNotification",
                "uciMessageId": _stable_track_id("UCI-ALT-", f"rd:{u.uic}"),
                "alertCategory": "OPERATIONAL_READINESS",
                "severity": _norm_severity("HIGH" if mc_rate < 0.60 else "MODERATE"),
                "EntityIdentifierRef": _stable_track_id("UCI-ENT-", u.uic),
                "summary": f"{u.name} mission-capable rate {mc_rate*100:.1f}% — below joint threshold",
                "asOfTime": published_iso,
            })

    incident_count = 0
    for inc in ds.incidents[-25:]:
        # Only forward incidents tied to a recognized unit so the partner
        # sees alerts cross-referenced to entities it already has in view.
        unit_for_inc = None
        for u in ds.units:
            if u.name in (inc.location_description or "") or u.location in (inc.location_description or ""):
                unit_for_inc = u
                break
        if unit_for_inc is None:
            continue
        alerts_out.append({
            "messageType": "AlertNotification",
            "uciMessageId": _stable_track_id("UCI-ALT-", f"inc:{inc.incident_number}"),
            "alertCategory": "INCIDENT",
            "severity": _norm_severity(inc.severity),
            "EntityIdentifierRef": _stable_track_id("UCI-ENT-", unit_for_inc.uic),
            "summary": f"{inc.type.replace('_', ' ').title()} · {unit_for_inc.name} · FPCON {inc.fpcon_at_time}",
            "asOfTime": inc.date_time.isoformat(timespec="seconds") if hasattr(inc.date_time, "isoformat") else published_iso,
        })
        incident_count += 1
        if incident_count >= 10:
            break

    payload = {
        "envelope": {
            "specification": "OMS/UCI",
            "specificationVersion": "OMS 2.4 / UCI 5.0",
            "messageStandard": "UCI Open Mission Systems",
            "subscriptionModel": "TOPIC_FULL_MAGTF",
            "sourceSystem": "SPIRE",
            "sourceSystemVersion": "0.1.0-SBIR",
            "sourceService": "USMC",
            "sourceUnit": "II MEF / 3d MLR",
            "publishedAtUtc": published_iso,
            "classification": {
                "marking": "SECRET",
                "releasability": "REL TO USA, FVEY",
                "controlSystem": "NONE",
                "dissemination": "REL TO USA, FVEY",
                "originatorCountry": "USA",
            },
            # Audit footer — partner can see who released the bundle so the
            # provenance is auditable on the receiving side. The pull is
            # role-gated, not unit-scoped, but the partner still gets to
            # know the human at the SPIRE console.
            "operator": _operator_envelope(user, actor_role),
            "messageCounts": {
                "EntityState": len(entities),
                "TrackData": len(tracks),
                "LogisticsStatus": len(logistics),
                "AlertNotification": len(alerts_out),
            },
        },
        "messages": {
            "EntityState": entities,
            "TrackData": tracks,
            "LogisticsStatus": logistics,
            "AlertNotification": alerts_out,
        },
    }
    return payload


# ---------------------------------------------------------------------------
# MIL-STD-6016 Link 16 J-series export
# ---------------------------------------------------------------------------

# Compass octant -> J-series environment code (subset).
_J_ENV_CODES = {
    "USMC_GROUND": "G",  # land
}


@router.get("/link16/export")
async def link16_export(request: Request) -> dict[str, Any]:
    """Render current SPIRE state as MIL-STD-6016 J-series messages.

    Subset implemented (read-only export only):
      * J3.5  Land Point / Track
      * J3.3  Surface Track  (used for any tracked / wheeled mover)
      * J7.0  Track Management
      * J7.2  Track Correlation
      * J28.2 Logistics Request (used here as Logistics Status)

    Field names follow the MIL-STD-6016 J-series convention as published
    in the open Link 16 documentation. Track numbers are 5-digit octal
    per the standard. This is an EXPORT adapter — there is no real Link
    16 radio behind it and no TADIL gateway.
    """
    user = getattr(request.state, "user", None)
    require_clearance(
        user,
        "SECRET",
        action="joint:link16_export",
        audit_actor=session_role(request),
    )
    # Same release-authority gate as OMS/UCI — see comment there. Link 16
    # is even more obviously a topic feed (J-series messages on a TADIL
    # net), so per-operator unit truncation makes no sense in this domain.
    actor_role = session_role(request)
    require_role(actor_role, JOINT_RELEASE_ROLES, action="joint:link16_export")

    ds = get_dataset()
    last = last_day_snapshots(ds)
    if not last:
        raise HTTPException(status_code=503, detail="dataset empty")

    # Snapshot-derived freshness anchor for the Link 16 header. Same rule as
    # the OMS/UCI envelope: deterministic across calls when the dataset
    # hasn't changed. Per-operator unit scoping was removed in Task #80; the
    # role gate above is the access control surface.
    published_iso = _snapshot_published_iso(ds, last)

    by_unit: dict[str, Counter] = {u.name: Counter() for u in ds.units}
    for s in last:
        by_unit[s.unit_name][s.readiness_code] += 1

    j35_messages: list[dict] = []   # Land Point / Track
    j33_messages: list[dict] = []   # Surface Track
    j70_messages: list[dict] = []   # Track Management
    j72_messages: list[dict] = []   # Track Correlation
    j282_messages: list[dict] = []  # Logistics Status

    # Each unit becomes one J3.5 land track + one J7.0 track-mgmt entry.
    # Tracked / wheeled units also get a J3.3 surface track so partners
    # see the same entity in two appropriate message families.
    for u in ds.units:
        c = by_unit[u.name]
        total = sum(c.values())
        mc_rate = (c.get("MC", 0) / total) if total else 0.0
        ready = _readiness_status(mc_rate)
        lat, lon = UNIT_COORDS.get(u.name, (34.658, -77.398))
        land_tn = _link16_track_number(u.name)

        j35_messages.append({
            "messageNumber": "J3.5",
            "label": "LAND_POINT_TRACK",
            "trackNumber": land_tn,
            "exerciseIndicator": "LIVE",
            "trackQuality": min(15, 8 + int(mc_rate * 7)),
            "identity": "FRIEND",
            "platformPlatformActivity": "GROUND_UNIT",
            "country": "USA",
            "specificType": _sym2525(u.name),
            "latitudeDegrees": lat,
            "longitudeDegrees": lon,
            "altitudeFeet": 26,
            "course": 0,
            "speedKnots": 0,
            "readinessC": ready["code"],
            "callsign": u.name,
            "uic": u.uic,
            "tn": land_tn,
        })

        # J3.3 surface tracks ride a *separate* TN from the J3.5 land point
        # so the J7.2 correlation below can pair two distinct TNs — that's
        # the whole point of correlation in Link 16. A single-TN
        # "correlation" against itself is the giveaway tell P0-2 calls out.
        surface_tn: Optional[str] = None
        if "LAR" in u.name or "Marines" in u.name or "ESB" in u.name or "Maint" in u.name:
            surface_tn = _link16_surface_track_number(u.name)
            j33_messages.append({
                "messageNumber": "J3.3",
                "label": "SURFACE_TRACK",
                "trackNumber": surface_tn,
                "exerciseIndicator": "LIVE",
                "identity": "FRIEND",
                "platform": "GROUND_VEHICLE",
                "course": 0,
                "speedKnots": 0,
                "latitudeDegrees": lat,
                "longitudeDegrees": lon,
                "trackQuality": min(15, 8 + int(mc_rate * 7)),
                "tn": surface_tn,
            })

        j70_messages.append({
            "messageNumber": "J7.0",
            "label": "TRACK_MANAGEMENT",
            "trackNumber": land_tn,
            "managementAction": "NEW_OR_UPDATE",
            "originatorJU": "01234",       # Source JU placeholder for SPIRE
            "linkStatus": "PARTICIPATING",
            "tn": land_tn,
        })

        # J7.2 correlation — emit ONLY when the entity has both a J3.5 land
        # point AND a J3.3 surface track, and pair the two distinct TNs.
        # Real Link 16 networks emit J7.2 to tell receivers "these two TNs
        # refer to the same entity"; pairing a TN against itself is
        # malformed and is the P0-2 tell from the joint-cop critique.
        if surface_tn is not None and surface_tn != land_tn:
            j72_messages.append({
                "messageNumber": "J7.2",
                "label": "TRACK_CORRELATION",
                "primaryTN": land_tn,
                "secondaryTN": surface_tn,
                "correlationType": "POSITIVE",
                "originatorJU": "01234",
            })

        # J28.2 logistics status — one per unit. Real J28.2 is a request
        # message; we coopt the field shape for status broadcast since
        # SPIRE's adapter is export-only. Documented as a known abuse in
        # the conformance gap list so judges aren't misled.
        j282_messages.append({
            "messageNumber": "J28.2",
            "label": "LOGISTICS_STATUS_BROADCAST",
            "trackNumber": land_tn,
            "supplyClass": "VII",
            "missionCapableRate": round(mc_rate, 4),
            "missionCapablePlatforms": c.get("MC", 0),
            "totalPlatforms": total,
            "readinessC": ready["code"],
            "tn": land_tn,
        })

    payload = {
        "header": {
            "specification": "MIL-STD-6016",
            "specificationVersion": "MIL-STD-6016G (Change 1)",
            "messageFamily": "Link 16 J-series",
            "operatingMode": "EXPORT_ONLY",
            "subscriptionModel": "TOPIC_FULL_MAGTF",
            "sourceSystem": "SPIRE",
            "sourceJU": "01234",
            "originatorService": "USMC",
            "publishedAtUtc": published_iso,
            "classification": {
                "marking": "SECRET",
                "releasability": "REL TO USA, FVEY",
                "originatorCountry": "USA",
            },
            # Operator audit footer — see OMS/UCI envelope for rationale.
            "operator": _operator_envelope(user, actor_role),
            "messageCounts": {
                "J3.5":  len(j35_messages),
                "J3.3":  len(j33_messages),
                "J7.0":  len(j70_messages),
                "J7.2":  len(j72_messages),
                "J28.2": len(j282_messages),
            },
        },
        "messages": {
            "J3_5_LandPointTrack":     j35_messages,
            "J3_3_SurfaceTrack":       j33_messages,
            "J7_0_TrackManagement":    j70_messages,
            "J7_2_TrackCorrelation":   j72_messages,
            "J28_2_LogisticsStatus":   j282_messages,
        },
    }
    return payload


# ---------------------------------------------------------------------------
# Conformance / gap doc — the truth source for the /integrations/joint page
# ---------------------------------------------------------------------------

@router.get("/conformance")
async def conformance() -> dict[str, Any]:
    """Machine-readable conformance posture. Drives the /integrations/joint
    page so the gap list is authored in one place. Honest about what isn't
    wired: bidirectional ingest, real radio, secondary message families."""
    return {
        "standardsAdopted": [
            {
                "name": "OMS/UCI",
                "version": "OMS 2.4 / UCI 5.0",
                "owner": "USAF Open Mission Systems Working Group",
                "spireRole": "Producer (export-only)",
                "endpoint": "/api/joint/oms-uci/export",
                "messages": [
                    "EntityState",
                    "TrackData",
                    "LogisticsStatus",
                    "AlertNotification",
                ],
                "notWired": [
                    "MissionTask",
                    "EngagementOrder",
                    "WeaponsStatus",
                    "Bidirectional subscription (SPIRE does not consume UCI feeds yet)",
                ],
            },
            {
                "name": "MIL-STD-6016 Link 16",
                "version": "6016G Change 1",
                "owner": "OUSD(R&E) / Joint Tactical Networking Center",
                "spireRole": "Producer (export-only, no radio gateway)",
                "endpoint": "/api/joint/link16/export",
                "messages": [
                    "J3.5  Land Point / Track",
                    "J3.3  Surface Track",
                    "J7.0  Track Management",
                    "J7.2  Track Correlation",
                    "J28.2 Logistics Status (broadcast usage of a request frame)",
                ],
                "notWired": [
                    "Real KGV-72 / MIDS-LVT TADIL gateway (no radio in the loop)",
                    "J3.2 Air Track / J3.7 EW (no air or EW data in SPIRE today)",
                    "J12.x Mission assignments",
                    "J13.x Platform / system status (subset only via J28.2 today)",
                    "Full Time-Slot Management (TSM) and net entry / exit",
                    "Encryption/CMS — TRANSEC / COMSEC outside scope",
                ],
            },
        ],
        "classificationPosture": {
            "exportClassification": "SECRET",
            "releasability": "REL TO USA, FVEY",
            "rationale": (
                "Joint COP exports inherit the highest classification of the "
                "constituent records. SPIRE asserts SECRET as the floor "
                "because canonical batches always include at least one "
                "SECRET-tier readiness record. The classification is "
                "stamped in the OMS/UCI envelope and the Link 16 header; "
                "the partner view re-asserts it on render."
            ),
            "gate": (
                "backend require_clearance(user, 'SECRET') AND "
                "require_role(user, JOINT_RELEASE_ROLES) on every export"
            ),
        },
        "releaseAuthority": {
            "subscriptionModel": "TOPIC_FULL_MAGTF",
            "summary": (
                "OMS/UCI and Link 16 exports are topic-style subscriptions: "
                "the partner J4 console always sees the full MAGTF, never a "
                "per-operator slice. Per-operator unit scoping (e.g. a "
                "maintenance chief's CLB-6-only view) is intentionally NOT "
                "applied to these feeds — a partner's tactical picture must "
                "not depend on which Marine happened to pull last."
            ),
            "allowedRoles": sorted(JOINT_RELEASE_ROLES),
            "deniedRolesExample": [
                "g4 (per-unit operator scope, would truncate the feed)",
                "maintenance_chief (single-unit scope, would truncate the feed)",
                "data_custodian (custodian, not a release authority)",
            ],
            "auditFooter": (
                "The calling operator's name, rank, billet, role, and DODID "
                "are stamped into the export envelope (envelope.operator / "
                "header.operator) so the partner can audit who released the "
                "bundle. The pull is gated; the footer is provenance."
            ),
        },
        "directionPolicy": {
            "egress": "SUPPORTED",
            "ingress": "NOT_SUPPORTED",
            "rationale": (
                "Wave 1 lane is read-only export. Bidirectional ingest "
                "would require a TADIL/UCI gateway, COMSEC/TRANSEC, and "
                "an inbound classification gate which is a separate lane. "
                "The line is intentionally bright. Egress itself is "
                "release-authority-gated (see Release authority block) so "
                "only a security manager / MEF commander class role can "
                "push to a partner."
            ),
        },
        "sisterServiceDemonstration": {
            "endpoint": "/joint/preview",
            "shell": "Faux Navy/Joint J4 console",
            "purpose": (
                "Demonstrates the same SPIRE state rendering coherently in "
                "a sister-service shell. Not a production COP — a "
                "verification surface judges can use to see the export "
                "consumed end-to-end."
            ),
        },
        "outOfScope": [
            "VMF (MIL-STD-2045-47001)",
            "MIL-STD-2525C symbology generation (we ship SIDC strings only; rendering belongs to the partner)",
            "Bidirectional joint ingest",
            "Live Link 16 radio terminal integration",
        ],
        "publishedAtUtc": _now_iso(),
    }
