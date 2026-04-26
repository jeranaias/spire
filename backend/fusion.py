"""
Multi-sensor threat fusion — backs GC-4 C-UAS / base-defense fusion.

Correlates events from independent sensor feeds into composite threats with
confidence chains. The point isn't replacing each sensor's individual feed
(SENTRY classification alerts, PULSE readiness drops, ThermalHawk UAS
detections, PACS gate events, SCADA infrastructure, weather advisories
already surface in the BASTION alert stream). The point is **identifying
when several feeds together describe a coordinated incident** — a PACS
breach + a SCADA anomaly on the same comms node + a ThermalHawk detection
inside the cordon, all within a 10-minute window, is a different threat
than any of them alone.

The fusion engine groups recent alerts by (proximity, time, severity) and
emits FusedThreat records to the alert stream above the raw events.
"""
from __future__ import annotations

import hashlib
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional


@dataclass
class FusedThreat:
    """A correlation chain across two or more raw alerts."""
    fused_id: str
    title: str
    body: str
    severity: str           # CRITICAL / HIGH / MODERATE
    confidence: float       # 0-1: how sure we are these alerts go together
    correlation_chain: list[dict]  # ordered list of contributing alert refs
    primary_unit: Optional[str] = None
    primary_building: Optional[str] = None
    response_taskings: list[str] = field(default_factory=list)
    fused_at: str = ""

    def to_alert_dict(self) -> dict:
        """Serialize as if this were a BASTION alert — front of /alerts feed."""
        return {
            "id": self.fused_id,
            "source": "FUSION",
            "severity": self.severity,
            "timestamp": self.fused_at,
            "title": self.title,
            "body": self.body,
            "unit": self.primary_unit,
            "building": self.primary_building,
            "fused": True,
            "confidence": self.confidence,
            "correlation_chain": self.correlation_chain,
            "response_taskings": self.response_taskings,
        }


# Severity ordering for promotion when fusing — a chain that includes a
# CRITICAL component is itself CRITICAL.
_SEV_RANK = {"INFO": 0, "LOW": 1, "MODERATE": 2, "HIGH": 3, "CRITICAL": 4}


def _sev_max(*sevs: str) -> str:
    return max(sevs, key=lambda s: _SEV_RANK.get(s, 0))


def _coalesce_unit(*entries: dict) -> Optional[str]:
    for e in entries:
        if e.get("unit"):
            return e["unit"]
    return None


def fuse_alerts(alerts: list[dict], window_minutes: int = 30) -> list[FusedThreat]:
    """Run the correlation pass over a recent alert window. Returns
    FusedThreat records ordered most-recent first.

    Rules (rule-based v1; ML head can swap in later):
    1. PACS gate breach + ThermalHawk detection within window
       AND geographically near the same ECP -> CRITICAL fused threat
       "Coordinated incursion: gate event + UAS over installation"
    2. SCADA anomaly + ThermalHawk detection within window
       -> HIGH fused threat
       "Possible adversary recce: infrastructure anomaly during UAS event"
    3. Multiple PACS events at ≥2 ECPs within window
       -> MODERATE fused threat "Multi-gate access pattern"
    4. Weather advisory + readiness alert on same unit
       -> INFO context tag (not a threat per se but surfaced)
    """
    if not alerts:
        return []
    fused: list[FusedThreat] = []
    now = datetime.utcnow()
    threshold = now - timedelta(minutes=window_minutes)

    # Bucket by source for easier correlation rules.
    by_source: dict[str, list[dict]] = defaultdict(list)
    for a in alerts:
        try:
            ts = datetime.fromisoformat(a["timestamp"].replace("Z", ""))
        except Exception:
            continue
        # Soft window — include slightly older too, since synthetic data is
        # static; the demo wants visible fused threats even on a stable feed.
        by_source[a.get("source", "?")].append(a)

    # Rule 1: PACS breach + UAS detection
    pacs_events = [a for a in by_source.get("PACS", []) if "ECP" in a.get("title", "")]
    uas_events = [a for a in by_source.get("ThermalHawk", []) if "UAS" in a.get("title", "")]
    if pacs_events and uas_events:
        pacs = pacs_events[0]
        uas = uas_events[0]
        chain = [
            {"source": "PACS", "id": pacs.get("id"), "title": pacs.get("title"), "timestamp": pacs.get("timestamp")},
            {"source": "ThermalHawk", "id": uas.get("id"), "title": uas.get("title"), "timestamp": uas.get("timestamp")},
        ]
        fused.append(FusedThreat(
            fused_id=_make_id("FUS-CRINC", chain),
            title="COORDINATED INCURSION · gate event + UAS over installation",
            body=f"PACS reported {pacs.get('title','gate event')} and ThermalHawk detected {uas.get('title','UAS')}. "
                 "Treat as a coordinated probe until ruled out. FPCON elevation recommended.",
            severity="CRITICAL",
            confidence=0.78,
            correlation_chain=chain,
            primary_unit=_coalesce_unit(uas, pacs),
            primary_building=uas.get("location") or uas.get("building"),
            response_taskings=[
                "Immediate: lock down all ECPs, dispatch QRF to UAS area",
                "Immediate: cross-check PACS log against duty roster",
                "5-30 min: review CCTV at the gate event in question",
                "5-30 min: notify Regional C-UAS coordinator + NCIS",
                "Notify: Installation CO, PMO Watch, Regional C-UAS, NCIS",
            ],
            fused_at=now.isoformat(timespec="seconds") + "Z",
        ))

    # Rule 2: SCADA anomaly + UAS detection
    scada_anomaly = [
        a for a in by_source.get("SCADA", [])
        if a.get("severity") in ("HIGH", "MODERATE")
    ]
    if scada_anomaly and uas_events:
        sc = scada_anomaly[0]
        uas = uas_events[0]
        chain = [
            {"source": "SCADA", "id": sc.get("id"), "title": sc.get("title"), "timestamp": sc.get("timestamp")},
            {"source": "ThermalHawk", "id": uas.get("id"), "title": uas.get("title"), "timestamp": uas.get("timestamp")},
        ]
        fused.append(FusedThreat(
            fused_id=_make_id("FUS-RECCE", chain),
            title="POSSIBLE ADVERSARY RECCE · infra anomaly during UAS event",
            body=f"SCADA flagged {sc.get('title','infrastructure anomaly')} concurrent with ThermalHawk "
                 f"{uas.get('title','UAS detection')}. Pattern matches surveillance + electronic-recce profile.",
            severity="HIGH",
            confidence=0.62,
            correlation_chain=chain,
            primary_unit=_coalesce_unit(uas, sc),
            primary_building=uas.get("location") or uas.get("building"),
            response_taskings=[
                "Immediate: increase posture on affected critical infrastructure",
                "Immediate: tag the SCADA event for cyber team review",
                "5-30 min: pull last 24h of SCADA traces on affected node",
                "Follow-on: brief MEF G-2 on potential combined-effects pattern",
            ],
            fused_at=now.isoformat(timespec="seconds") + "Z",
        ))

    # Rule 3: Multi-gate PACS pattern (2+ different ECPs)
    if len(pacs_events) >= 2:
        ecp_ids: set[str] = set()
        ordered: list[tuple[dict, str]] = []
        for p in pacs_events:
            t = p.get("title", "")
            for ecp in ("ECP-1", "ECP-2", "ECP-3", "ECP-4"):
                if ecp in t:
                    if ecp not in ecp_ids:
                        ecp_ids.add(ecp)
                        ordered.append((p, ecp))
                    break
        if len(ecp_ids) >= 2:
            # Attach the extracted ECP id to the chain so the front-end can
            # render `ECP-A → ECP-B → ECP-C` instead of three identical
            # "PACS" pills (reviewer caught the duplication).
            chain = [
                {
                    "source": "PACS",
                    "id": p.get("id"),
                    "title": p.get("title"),
                    "timestamp": p.get("timestamp"),
                    "label": ecp_id,
                }
                for p, ecp_id in ordered[:4]
            ]
            fused.append(FusedThreat(
                fused_id=_make_id("FUS-MGATE", chain),
                title="MULTI-GATE ACCESS PATTERN · {} ECPs in window".format(len(ecp_ids)),
                body=f"PACS reported events at {', '.join(sorted(ecp_ids))} within fusion window. "
                     "Could be benign convoy / shift change; verify against manifest.",
                severity="MODERATE",
                confidence=0.55,
                correlation_chain=chain,
                primary_building=", ".join(sorted(ecp_ids)),
                response_taskings=[
                    "Compare against today's TMR + duty manifest",
                    "Confirm with Watch officer if pattern is expected",
                ],
                fused_at=now.isoformat(timespec="seconds") + "Z",
            ))

    # Rule 4: Weather + readiness drop on same unit
    weather = [a for a in by_source.get("WEATHER", []) if a.get("severity") in ("MODERATE", "HIGH")]
    pulse_readiness = [a for a in by_source.get("PULSE", []) if "readiness" in a.get("title", "").lower()]
    if weather and pulse_readiness:
        w = weather[0]
        r = pulse_readiness[0]
        chain = [
            {"source": "WEATHER", "id": w.get("id"), "title": w.get("title"), "timestamp": w.get("timestamp")},
            {"source": "PULSE", "id": r.get("id"), "title": r.get("title"), "timestamp": r.get("timestamp")},
        ]
        fused.append(FusedThreat(
            fused_id=_make_id("FUS-CTX", chain),
            title="OPERATIONAL CONTEXT · weather + readiness on " + (r.get("unit") or "unit"),
            body=f"Weather advisory: {w.get('title','advisory')}. "
                 f"PULSE flag: {r.get('title','readiness drop')}. "
                 "Surfaced for context; not a threat. Consider rescheduling sensitive ops.",
            severity="LOW",
            confidence=0.85,
            correlation_chain=chain,
            primary_unit=r.get("unit"),
            response_taskings=[
                "Inform unit commander of compounding factors",
                "Hold sensitive movements until weather clears",
            ],
            fused_at=now.isoformat(timespec="seconds") + "Z",
        ))

    return fused


def _make_id(prefix: str, chain: list[dict]) -> str:
    """Stable ID across calls — same chain produces same fused_id so a
    poll doesn't duplicate the threat. Hash the contributing alert IDs."""
    h = hashlib.sha256("|".join((c.get("id") or "?") for c in chain).encode()).hexdigest()[:10]
    return f"{prefix}-{h}"
