"""
SPIRE synthetic logistics dataset — global configuration.

All constants, lookup tables, and probability distributions used across the
generation engine. Everything here is deterministic under RANDOM_SEED so the
canonical dataset is reproducible.
"""
from __future__ import annotations

from datetime import date

# ---------------------------------------------------------------------------
# Simulation window
# ---------------------------------------------------------------------------
SIMULATION_START_DATE = date(2025, 6, 1)
SIMULATION_END_DATE = date(2026, 5, 31)
SIMULATION_DAYS = (SIMULATION_END_DATE - SIMULATION_START_DATE).days + 1  # 365
RANDOM_SEED = 42

# ---------------------------------------------------------------------------
# Operational tempo profiles (hours / miles per day when operating)
# ---------------------------------------------------------------------------
OPTEMPO = {
    "high":   {"operate_prob": 0.70, "hours_per_day": (4, 12), "miles_per_day": (30, 120)},
    "medium": {"operate_prob": 0.50, "hours_per_day": (2, 8),  "miles_per_day": (15, 60)},
    "low":    {"operate_prob": 0.30, "hours_per_day": (1, 4),  "miles_per_day": (5, 25)},
    "static": {"operate_prob": 0.15, "hours_per_day": (1, 6),  "miles_per_day": (0, 0)},
}

# ---------------------------------------------------------------------------
# PMCS intervals (days). "B_CHECK" (monthly) is the default recurring PMCS.
# ---------------------------------------------------------------------------
PMCS_INTERVALS = {
    "A_CHECK": 7,
    "B_CHECK": 30,
    "C_CHECK": 90,
    "D_CHECK": 180,
    "ANNUAL": 365,
}

# ---------------------------------------------------------------------------
# Supply status progression codes (realistic timeline from GCSS-MC)
# ---------------------------------------------------------------------------
SUPPLY_STATUS_CODES = {
    "BA": "Requisition submitted",
    "BB": "Requisition received by supply",
    "BV": "Requisition validated",
    "AS": "Material released from stock",
    "AE": "Shipped from depot",
    "BP": "Backordered",
    "COR": "Confirmed on order",
    "AU": "Shipped, arrived unit",
    "D6": "Received by requisitioner",
}

# Deterministic day offsets per supply path.
SUPPLY_PATHS = {
    "fast":        [("BA", 0), ("BB", 1), ("BV", 2), ("AS", 3), ("AU", 5), ("D6", 6)],
    "medium":      [("BA", 0), ("BB", 1), ("BV", 2), ("COR", 4), ("AE", 9), ("AU", 15), ("D6", 17)],
    "slow":        [("BA", 0), ("BB", 1), ("BV", 2), ("COR", 4), ("AE", 22), ("AU", 55), ("D6", 58)],
    "backordered": [("BA", 0), ("BB", 1), ("BV", 2), ("BP", 4), ("COR", 30), ("AE", 70), ("AU", 95), ("D6", 99)],
}

# ---------------------------------------------------------------------------
# Condition → priority mapping (per GCSS-MC rules)
# ---------------------------------------------------------------------------
CONDITION_PRIORITY_MAP = {
    "Deadlined": ["02", "03"],
    "Degraded":  ["05", "06"],
    "Minor":     ["10", "13"],
    "Supply":    ["10"],
    "Service":   ["10", "13"],
}

# ---------------------------------------------------------------------------
# GCSS-MC job status codes
# ---------------------------------------------------------------------------
JOB_STATUS_CODES = [
    "OPEN",
    "EQUIP ACCEPTED",
    "AWAITING MAINT",
    "WORK IN PROGRESS",
    "SHT PART",
    "WAITING APPROVAL",
    "QC INSPECTION",
    "COMPLETED",
    "EVACUATED",
]

# ---------------------------------------------------------------------------
# Defect code pairs (primary / secondary). Real GCSS-MC code families.
# ---------------------------------------------------------------------------
DEFECT_CODES = {
    "engine":        [("NMAJ", "ENGN"), ("SAFE", "ENGN"), ("ECON", "ENGN")],
    "transmission":  [("NMAJ", "TRSM"), ("SAFE", "TRSM"), ("ECON", "TRSM")],
    "electrical":    [("NMAJ", "ELEC"), ("SAFE", "ELEC"), ("MINR", "ELEC")],
    "brake":         [("SAFE", "BRAK"), ("NMAJ", "BRAK")],
    "cooling":       [("NMAJ", "COOL"), ("MINR", "COOL")],
    "suspension":    [("NMAJ", "SUSP"), ("MINR", "SUSP")],
    "fuel":          [("NMAJ", "FUEL"), ("SAFE", "FUEL")],
    "hydraulic":     [("NMAJ", "HYDR"), ("SAFE", "HYDR")],
    "tire":          [("NMAJ", "TIRE"), ("MINR", "TIRE")],
    "body":          [("MINR", "BODY"), ("COSM", "BODY")],
    "weapon_system": [("SAFE", "WEAP"), ("NMAJ", "WEAP")],
    "fire_control":  [("NMAJ", "FCTL"), ("SAFE", "FCTL")],
    "radar":         [("NMAJ", "ELEC"), ("SAFE", "ELEC")],
    "comms":         [("NMAJ", "COMM"), ("SAFE", "COMM")],
    "crypto":        [("SAFE", "COMM"), ("NMAJ", "COMM")],
    "track":         [("NMAJ", "TRAK"), ("SAFE", "TRAK")],
    "turret":        [("NMAJ", "TURT"), ("SAFE", "TURT")],
    "rotor":         [("SAFE", "ROTR"), ("NMAJ", "ROTR")],
    "avionics":      [("NMAJ", "AVIO"), ("SAFE", "AVIO")],
    "launcher":      [("SAFE", "WEAP"), ("NMAJ", "WEAP")],
    "nav_system":    [("NMAJ", "NAVI"), ("SAFE", "NAVI")],
    "corrosion":     [("COSM", "CORR"), ("MINR", "CORR")],
    "pmcs":          [("SCHD", "PMCS")],
}

# ---------------------------------------------------------------------------
# Classification levels supported inside SPIRE (input-screening rejects above
# the operating level; CONFIDENTIAL+ in synthetic data gets redacted by SENTRY)
# ---------------------------------------------------------------------------
CLASSIFICATION_LEVELS = ["UNCLASSIFIED", "CUI", "CONFIDENTIAL", "SECRET"]

# ---------------------------------------------------------------------------
# MGRS templates per installation area. Grid-zone / square are realistic for
# the named operating area but the easting/northing ranges are intentionally
# offset into adjacent wilderness / open water / training-range polygons so a
# reviewer who geocodes any synthetic grid lands in a non-sensitive place,
# not on top of a real barracks or motor pool. All values remain synthetic.
# ---------------------------------------------------------------------------
MGRS_BY_AREA = {
    # CARO NC area -- shifted SW into Onslow Bight training ranges
    "Camp Lejeune, NC":     {"grid_zone": "18S", "square": "UH", "easting_range": (10000, 28000), "northing_range": (55000, 72000)},
    # Southern CA area -- shifted into marine training areas south of the base
    "Camp Pendleton, CA":   {"grid_zone": "11S", "square": "MS", "easting_range": (15000, 35000), "northing_range": (55000, 72000)},
    # Okinawa -- shifted into East China Sea training sectors
    "Camp Kinser, Okinawa": {"grid_zone": "52S", "square": "EE", "easting_range": (10000, 30000), "northing_range": (45000, 65000)},
    # SC low country -- shifted into coastal wetlands training
    "MCAS Beaufort, SC":    {"grid_zone": "17R", "square": "PP", "easting_range": (20000, 40000), "northing_range": (45000, 65000)},
    # Sonoran Desert training complex -- well clear of MCAS Yuma proper
    "MCAS Yuma, AZ":        {"grid_zone": "11S", "square": "QB", "easting_range": (40000, 60000), "northing_range": (40000, 60000)},
}

# ---------------------------------------------------------------------------
# Sensitivity injection rules (consumed by sensitive.py).
# Keyed by rule name; drives SENTRY's training-label synthesis too.
# ---------------------------------------------------------------------------
SENSITIVITY_RULES = {
    "pii": {
        "description": "Full name + ext, EDIPI, or SSN-last-4 in POC line",
        "probability": 0.30,
        "method": "append_poc",
        # Distribution of PII "flavors":
        "flavors": {"name_ext": 0.70, "name_edipi": 0.20, "name_ssn4": 0.10},
    },
    "grid_coords": {
        "description": "MGRS 10-digit grid for the unit's operating area",
        "probability": 0.40,
        "method": "prepend_or_append",
        "trigger_deployment_status": ("deployed", "field_exercise"),
    },
    "comms": {
        "description": "Radio frequency / COMSEC device reference / net ID / callsign",
        "probability": 0.50,
        "method": "within_remark",
        "trigger_equipment_types": ("AN_TPS80_GATOR", "AN_TPQ36_FIREFINDER"),
        "trigger_fault_component": ("comms", "crypto"),
    },
    "classified_tm": {
        "description": "Reference to classified TM (synthetic number, obvious placeholder)",
        "probability": 1.0,  # deterministic when fault.classified == True
        "method": "in_template",
    },
    "controlled_serial": {
        "description": "Controlled-item serial number on weapons / crypto / NVG-bearing systems",
        "probability": 0.25,
        "method": "append",
        "trigger_equipment_types": ("M1A1_ABRAMS", "HIMARS", "AN_TPS80_GATOR", "AN_TPQ36_FIREFINDER"),
    },
}

# ---------------------------------------------------------------------------
# Field exercise / deployment workup defaults. Generator uses these to set
# deployment_status windows on the calendar.
# ---------------------------------------------------------------------------
CALENDAR_EVENTS = {
    "field_exercise_count_per_unit": (2, 3),
    "field_exercise_duration_days": (10, 18),
    "deployment_workup_duration_days": 28,
    "block_leave_start": date(2025, 12, 20),
    "block_leave_end":   date(2026, 1, 3),
    "weekend_optempo_modifier": 0.50,
}

# ---------------------------------------------------------------------------
# Global tuning constants -- calibrated so the final fleet MC rate sits in
# the spec's 75-85% target band across all units.
# ---------------------------------------------------------------------------
FAULT_PROBABILITY_SCALE = 0.42   # Calibrated to match GAO-25-108679 ground-vehicle MC bands
BACKORDER_RATE = 0.08            # Fraction of parts that backorder regardless of cost
WIP_DAYS_PER_LABOR_HOUR = 0.12   # Calendar days a WIP SR stays open per labor hour
QC_INSPECTION_CLOSE_CHANCE = 0.75  # Per-day chance that a QC SR closes out

# ---------------------------------------------------------------------------
# Data-quality injection targets. The consistency gate EXPECTS ~2.6% of records
# to carry data-quality defects — this is what PULSE's data quality gate
# catches and surfaces to the user.
# ---------------------------------------------------------------------------
DATA_QUALITY_DEFECT_TARGETS = {
    "hours_decreased":       {"target_count": 8,  "per_batch_of": 500},  # operator entry error
    "serial_tamcn_mismatch": {"target_count": 3,  "per_batch_of": 500},  # asset misreported
    "unknown_defect_code":   {"target_count": 2,  "per_batch_of": 500},  # code outside code table
}

# ---------------------------------------------------------------------------
# Cannibalization targets — the consistency layer guarantees at least this
# many canib events across the 365-day window.
# ---------------------------------------------------------------------------
MIN_CANNIBALIZATION_EVENTS = 5

# ---------------------------------------------------------------------------
# Output targets. These are the sizes PULSE and SENTRY expect.
# ---------------------------------------------------------------------------
OUTPUT_TARGETS = {
    "fleet_size":      500,
    "personnel_count": 200,
    "incident_count":  100,
    "mpr_record_min":  500,
}

# ---------------------------------------------------------------------------
# Release authority -> sanitization rule overlays. Used by SENTRY export.
# ---------------------------------------------------------------------------
RELEASE_AUTHORITIES = ["U.S. Only", "FVEY", "NATO", "Specific Partner"]
