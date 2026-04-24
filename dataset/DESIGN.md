# MDM 2026 Hackathon — Synthetic Logistics Dataset Generation Engine
# Design Document for Claude Code Implementation

## Purpose
Build a Python simulation engine that generates hyper-realistic Marine Corps logistics datasets for three hackathon projects (SENTRY, PULSE, BASTION). The datasets must look like they were exported from GCSS-MC and DRRS-MC to anyone who has used those systems. Every record must be internally consistent across time, cross-referenced with other records, and free of mass duplicates.

## Output Files
1. `gcss_mc_mpr_export.xlsx` — 500+ Service Request records mimicking a GCSS-MC Maintenance Production Report. Used by SENTRY and PULSE.
2. `daily_readiness_snapshots.xlsx` — 30 days × ~500 assets = ~15,000 rows of daily fleet readiness. Used by PULSE.
3. `installation_incident_log.xlsx` — 100 incidents over 12 months at a synthetic installation. Used by BASTION.
4. `fleet_registry.xlsx` — Master equipment list (the "ground truth" fleet). Reference file.
5. `parts_catalog.xlsx` — Parts linked to fault types. Reference file.
6. `personnel_roster.xlsx` — Synthetic Marines for PII injection. Reference file.

All XLSX files should have professional formatting: navy headers, alternating row shading, frozen header rows, auto-filters, and appropriate column widths.

---

## Architecture

```
main.py                  # Orchestrator — runs all modules in order, produces final outputs
├── config.py            # All constants, probabilities, lookup tables
├── fleet.py             # Generates the fixed fleet of ~500 assets across 10 units
├── personnel.py         # Generates synthetic Marine roster for PII injection
├── lifecycle.py         # Simulates 365 days of operations per asset
├── faults.py            # Injects equipment-specific faults based on operating profiles
├── supply.py            # Generates parts requisitions and supply chain progression
├── remarks.py           # Generates realistic maintenance remarks with template system
├── sensitive.py         # Injects context-appropriate sensitive data into remarks
├── consistency.py       # Enforces cross-record consistency and validates the dataset
├── incidents.py         # Generates installation incident log for BASTION
├── export.py            # Formats and exports all XLSX files
└── data/
    ├── equipment_profiles.json    # Equipment types with fault profiles
    ├── fault_templates.json       # Remark templates per equipment/fault combo
    ├── installation_data.json     # Buildings, ECPs, response forces for BASTION
    └── unit_structure.json        # Unit T/O&E with equipment counts
```

---

## Module 1: config.py

### Constants

```python
SIMULATION_START_DATE = "2025-06-01"
SIMULATION_END_DATE = "2026-05-31"
SIMULATION_DAYS = 365
RANDOM_SEED = 42  # Reproducibility

# GCSS-MC SR number format: AAC (6 digits) + Julian date (4 digits) + sequence (4 digits)
# Example: M21670-5152-0001

# Operational tempo profiles (hours per day when operating)
OPTEMPO = {
    "high": {"operate_prob": 0.7, "hours_per_day": (4, 12), "miles_per_day": (30, 120)},
    "medium": {"operate_prob": 0.5, "hours_per_day": (2, 8), "miles_per_day": (15, 60)},
    "low": {"operate_prob": 0.3, "hours_per_day": (1, 4), "miles_per_day": (5, 25)},
    "static": {"operate_prob": 0.15, "hours_per_day": (1, 6), "miles_per_day": (0, 0)},  # generators, radars
}

# PMCS intervals (days)
PMCS_INTERVALS = {
    "A_CHECK": 7,     # Weekly
    "B_CHECK": 30,    # Monthly
    "C_CHECK": 90,    # Quarterly
    "D_CHECK": 180,   # Semi-annual
    "ANNUAL": 365,
}

# Supply status progression (realistic timeline)
SUPPLY_STATUS_PROGRESSION = [
    ("BA", "Requisition submitted", 0),           # Day 0
    ("BB", "Requisition received by supply", 1),   # Day 1
    ("BV", "Requisition validated", 2),            # Day 2
    # Then one of several paths:
    # Fast path: in-stock
    ("AS", "Material released from stock", 3),     # Day 3
    # Medium path: ordered from DLA
    ("AE", "Shipped from depot", 7),               # Day 7
    # Slow path: backordered
    ("BP", "Backordered", 5),                      # Day 5 (then long wait)
    ("COR", "Confirmed on order", 30),             # Day 30+
]

# Condition code to priority mapping (per GCSS-MC rules)
CONDITION_PRIORITY_MAP = {
    "Deadlined": ["02", "03"],    # UND A — highest
    "Degraded": ["05", "06"],     # UND B
    "Minor": ["10", "13"],        # UND C
    "Supply": ["10"],
    "Service": ["10", "13"],
}

# GCSS-MC Job Status Codes (real codes from the system)
JOB_STATUS_CODES = [
    "OPEN",
    "EQUIP ACCEPTED",
    "AWAITING MAINT",
    "WORK IN PROGRESS",
    "SHT PART",           # Short parts — waiting on supply
    "WAITING APPROVAL",
    "QC INSPECTION",
    "COMPLETED",
    "EVACUATED",          # Sent to higher echelon
]

# Defect code pairs (primary/secondary) — these are real GCSS-MC defect codes
DEFECT_CODES = {
    "engine": [("NMAJ", "ENGN"), ("SAFE", "ENGN"), ("ECON", "ENGN")],
    "transmission": [("NMAJ", "TRSM"), ("SAFE", "TRSM"), ("ECON", "TRSM")],
    "electrical": [("NMAJ", "ELEC"), ("SAFE", "ELEC"), ("MINR", "ELEC")],
    "brake": [("SAFE", "BRAK"), ("NMAJ", "BRAK")],
    "cooling": [("NMAJ", "COOL"), ("MINR", "COOL")],
    "suspension": [("NMAJ", "SUSP"), ("MINR", "SUSP")],
    "fuel": [("NMAJ", "FUEL"), ("SAFE", "FUEL")],
    "hydraulic": [("NMAJ", "HYDR"), ("SAFE", "HYDR")],
    "tire": [("NMAJ", "TIRE"), ("MINR", "TIRE")],
    "body": [("MINR", "BODY"), ("COSM", "BODY")],
    "weapon_system": [("SAFE", "WEAP"), ("NMAJ", "WEAP")],
    "fire_control": [("NMAJ", "FCTL"), ("SAFE", "FCTL")],
    "radar": [("NMAJ", "ELEC"), ("SAFE", "ELEC")],
    "comms": [("NMAJ", "COMM"), ("SAFE", "COMM")],
    "crypto": [("SAFE", "COMM"), ("NMAJ", "COMM")],
    "track": [("NMAJ", "TRAK"), ("SAFE", "TRAK")],
    "turret": [("NMAJ", "TURT"), ("SAFE", "TURT")],
    "rotor": [("SAFE", "ROTR"), ("NMAJ", "ROTR")],
    "avionics": [("NMAJ", "AVIO"), ("SAFE", "AVIO")],
    "launcher": [("SAFE", "WEAP"), ("NMAJ", "WEAP")],
    "nav_system": [("NMAJ", "NAVI"), ("SAFE", "NAVI")],
    "corrosion": [("COSM", "CORR"), ("MINR", "CORR")],
    "pmcs": [("SCHD", "PMCS")],
}

# Classification levels for sensitive content
CLASSIFICATION_LEVELS = ["UNCLASSIFIED", "CUI", "CONFIDENTIAL", "SECRET"]
```

---

## Module 2: fleet.py

### Purpose
Generate a fixed fleet of ~500 unique equipment items across 10 units. Every asset gets a permanent identity that persists throughout the simulation.

### Unit Structure

```python
UNITS = [
    {
        "uic": "M21670",
        "name": "CLB-6",
        "parent": "2d MLG",
        "location": "Camp Lejeune, NC",
        "optempo": "high",
        "deployment_status": "garrison",  # or "deployed", "field_exercise"
        "equipment": {
            "JLTV": {"tamcn": "D1196", "count": 28, "nsn_prefix": "2320"},
            "MTVR_CARGO": {"tamcn": "D0082", "count": 15, "nsn_prefix": "2320"},
            "MTVR_WRECKER": {"tamcn": "D0088", "count": 3, "nsn_prefix": "2320"},
            "LVSR": {"tamcn": "D0092", "count": 8, "nsn_prefix": "2320"},
            "TRAILER_M1095": {"tamcn": "D0218", "count": 12, "nsn_prefix": "2330"},
            "MEP_803A": {"tamcn": "B2601", "count": 4, "nsn_prefix": "6115"},  # 10kW generator
        },
    },
    {
        "uic": "M21450",
        "name": "CLB-1",
        "parent": "1st MLG",
        "location": "Camp Pendleton, CA",
        "optempo": "high",
        "deployment_status": "garrison",
        "equipment": {
            "JLTV": {"tamcn": "D1196", "count": 25, "nsn_prefix": "2320"},
            "MTVR_CARGO": {"tamcn": "D0082", "count": 18, "nsn_prefix": "2320"},
            "MTVR_WRECKER": {"tamcn": "D0088", "count": 2, "nsn_prefix": "2320"},
            "LVSR": {"tamcn": "D0092", "count": 6, "nsn_prefix": "2320"},
            "TRAILER_M1095": {"tamcn": "D0218", "count": 10, "nsn_prefix": "2330"},
            "MEP_803A": {"tamcn": "B2601", "count": 3, "nsn_prefix": "6115"},
        },
    },
    {
        "uic": "M33200",
        "name": "3d Maint Bn",
        "parent": "3d MLG",
        "location": "Camp Kinser, Okinawa",
        "optempo": "medium",
        "deployment_status": "forward_deployed",  # Triggers grid coords in remarks
        "equipment": {
            "JLTV": {"tamcn": "D1196", "count": 12, "nsn_prefix": "2320"},
            "MTVR_CARGO": {"tamcn": "D0082", "count": 10, "nsn_prefix": "2320"},
            "MRAP_RG31": {"tamcn": "D1127", "count": 6, "nsn_prefix": "2355"},
            "MEP_803A": {"tamcn": "B2601", "count": 5, "nsn_prefix": "6115"},
        },
    },
    {
        "uic": "M40120",
        "name": "2d Tank Bn",  # Before deactivation for dataset purposes
        "parent": "2d MarDiv",
        "location": "Camp Lejeune, NC",
        "optempo": "medium",
        "deployment_status": "garrison",
        "equipment": {
            "M1A1_ABRAMS": {"tamcn": "A2249", "count": 14, "nsn_prefix": "2350"},
            "JLTV": {"tamcn": "D1196", "count": 8, "nsn_prefix": "2320"},
            "M88A2_RECOVERY": {"tamcn": "A2243", "count": 4, "nsn_prefix": "2350"},
        },
    },
    {
        "uic": "M26300",
        "name": "2d LAR Bn",
        "parent": "2d MarDiv",
        "location": "Camp Lejeune, NC",
        "optempo": "medium",
        "deployment_status": "garrison",
        "equipment": {
            "LAV_25": {"tamcn": "A0076", "count": 16, "nsn_prefix": "2350"},
            "LAV_AT": {"tamcn": "A0078", "count": 8, "nsn_prefix": "2350"},
            "JLTV": {"tamcn": "D1196", "count": 6, "nsn_prefix": "2320"},
        },
    },
    {
        "uic": "M55670",
        "name": "MALS-31",
        "parent": "MAG-31",
        "location": "MCAS Beaufort, SC",
        "optempo": "high",
        "deployment_status": "garrison",
        "equipment": {
            "MV22B_OSPREY": {"tamcn": "A4822", "count": 4, "nsn_prefix": "1520"},  # SE support equipment
            "CH53E_STALLION": {"tamcn": "A4612", "count": 3, "nsn_prefix": "1520"},
            "MTVR_CARGO": {"tamcn": "D0082", "count": 6, "nsn_prefix": "2320"},
            "JLTV": {"tamcn": "D1196", "count": 4, "nsn_prefix": "2320"},
            "MEP_803A": {"tamcn": "B2601", "count": 6, "nsn_prefix": "6115"},
        },
    },
    {
        "uic": "M60230",
        "name": "MWSS-372",
        "parent": "MAG-39",
        "location": "MCAS Yuma, AZ",
        "optempo": "medium",
        "deployment_status": "garrison",
        "equipment": {
            "JLTV": {"tamcn": "D1196", "count": 10, "nsn_prefix": "2320"},
            "MTVR_CARGO": {"tamcn": "D0082", "count": 8, "nsn_prefix": "2320"},
            "TRAM": {"tamcn": "B0854", "count": 3, "nsn_prefix": "3805"},  # Tractor
            "MEP_803A": {"tamcn": "B2601", "count": 8, "nsn_prefix": "6115"},
            "ROWPU": {"tamcn": "B2984", "count": 2, "nsn_prefix": "4610"},  # Water purification
        },
    },
    {
        "uic": "M30550",
        "name": "2d LAAD Bn",
        "parent": "2d MAW",
        "location": "Camp Lejeune, NC",
        "optempo": "low",
        "deployment_status": "garrison",
        "equipment": {
            "AN_TPS80_GATOR": {"tamcn": "E1839", "count": 2, "nsn_prefix": "5840"},
            "AN_TPQ36_FIREFINDER": {"tamcn": "E0960", "count": 2, "nsn_prefix": "5840"},
            "JLTV": {"tamcn": "D1196", "count": 6, "nsn_prefix": "2320"},
            "MTVR_CARGO": {"tamcn": "D0082", "count": 4, "nsn_prefix": "2320"},
        },
    },
    {
        "uic": "M15800",
        "name": "5/11 Marines",
        "parent": "11th Marines",
        "location": "Camp Pendleton, CA",
        "optempo": "medium",
        "deployment_status": "garrison",
        "equipment": {
            "HIMARS": {"tamcn": "E1897", "count": 9, "nsn_prefix": "1055"},
            "MTVR_CARGO": {"tamcn": "D0082", "count": 12, "nsn_prefix": "2320"},
            "JLTV": {"tamcn": "D1196", "count": 8, "nsn_prefix": "2320"},
        },
    },
    {
        "uic": "M22100",
        "name": "7th ESB",
        "parent": "1st MLG",
        "location": "Camp Pendleton, CA",
        "optempo": "medium",
        "deployment_status": "garrison",
        "equipment": {
            "JLTV": {"tamcn": "D1196", "count": 10, "nsn_prefix": "2320"},
            "MTVR_CARGO": {"tamcn": "D0082", "count": 8, "nsn_prefix": "2320"},
            "D7G_DOZER": {"tamcn": "B0340", "count": 4, "nsn_prefix": "2410"},
            "TRAM": {"tamcn": "B0854", "count": 3, "nsn_prefix": "3805"},
            "MEP_803A": {"tamcn": "B2601", "count": 5, "nsn_prefix": "6115"},
        },
    },
]
```

### Asset Generation Logic

```python
class Asset:
    def __init__(self, unit, equipment_type, index):
        self.id = f"{unit['uic']}-{equipment_type}-{index:03d}"
        self.serial_number = generate_serial(equipment_type)  # See below
        self.tamcn = EQUIPMENT_DB[equipment_type]["tamcn"]
        self.nsn = generate_nsn(equipment_type)
        self.nomenclature = EQUIPMENT_DB[equipment_type]["nomenclature"]
        self.unit = unit
        self.equipment_type = equipment_type
        
        # Initial conditions (randomized within realistic bounds)
        self.fielding_date = random_date("2018-01-01", "2024-06-01")
        self.initial_hours = random_hours_for_age(self.fielding_date)
        self.initial_miles = random_miles_for_age(self.fielding_date, equipment_type)
        self.current_hours = self.initial_hours
        self.current_miles = self.initial_miles
        self.current_status = "MC"  # Start all MC, simulation will degrade some
        self.open_srs = []
        self.maintenance_history = []
        self.pmcs_due_date = calculate_next_pmcs(self.fielding_date)
```

### Serial Number Formats (equipment-specific, realistic)

```python
SERIAL_FORMATS = {
    "JLTV": "JLTV-{year:02d}-{seq:05d}",           # JLTV-22-01234
    "MTVR_CARGO": "MT-{lot:04d}-{seq:03d}",         # MT-0847-012
    "M1A1_ABRAMS": "USA-{seq:06d}",                  # USA-024871
    "LAV_25": "LAV-{year:02d}{seq:04d}",             # LAV-190234
    "MV22B_OSPREY": "168{seq:03d}",                   # 168472 (BuNo style)
    "CH53E_STALLION": "16{seq:04d}",                  # 164837 (BuNo style)
    "HIMARS": "H-{seq:05d}",                          # H-00847
    "AN_TPS80_GATOR": "EL-{seq:04d}-{mod:02d}",     # EL-0034-02
    "AN_TPQ36_FIREFINDER": "EL-{seq:04d}-{mod:02d}", # EL-0198-01
    "MEP_803A": "GEN-{seq:05d}",                      # GEN-08472
    # ... etc for all equipment types
}
```

### NSN Generation
Real NSNs are 13 digits: 4-digit FSC + 2-digit country code + 7-digit NIIN.
```python
def generate_nsn(equipment_type):
    fsc = EQUIPMENT_DB[equipment_type]["fsc"]  # e.g., "2320" for trucks
    country = "01"  # USA
    niin = f"{random.randint(100, 999)}-{random.randint(1000, 9999)}"
    return f"{fsc}-{country}-{niin}"
    # Produces: "2320-01-658-3894"
```

---

## Module 3: personnel.py

### Purpose
Generate ~200 synthetic Marines for realistic PII injection. Each Marine is a persistent identity that can appear in maintenance remarks as POCs, reporting mechanics, shop supervisors, etc.

### Data Structure

```python
class Marine:
    rank: str          # "Cpl", "Sgt", "SSgt", "GySgt", "LCpl", "Pfc"
    last_name: str     # From a diverse name list (500+ surnames)
    first_initial: str
    mos: str           # "3521" (Motor T Mechanic), "2171" (Electro-Optical Ordnance), etc.
    edipi: str         # 10-digit number
    ssn_last4: str     # 4 digits (never generate full SSNs)
    unit: str          # Assigned unit UIC
    phone_ext: str     # 4-digit DSN extension
    email: str         # firstname.lastname@usmc.mil
```

### MOS Assignment (must match equipment types)
```
Motor T units: MOS 3521 (Automotive Mechanic), 3531 (Motor Vehicle Operator)
Tank/LAV units: MOS 1812 (Tank Crewman), 2141 (AAV Mechanic), 0313 (LAV Crewman)
Artillery: MOS 0811 (Field Artillery Cannoneer), 0842 (Field Artillery Radar Operator)
Comm/EW: MOS 0621 (Radio Operator), 2629 (Signals Intelligence), 0689 (Cyber)
Aviation: MOS 6073 (Aircraft Mechanic), 6323 (Avionics Technician)
Engineers: MOS 1345 (Engineer Equipment Operator), 1371 (Combat Engineer)
General: MOS 0431 (Logistics Clerk), 3043 (Supply Admin)
```

### Name Generation
Use a large, diverse list of real surnames. Include a mix of Hispanic, Black, White, Asian, Pacific Islander names reflecting actual Marine Corps demographics. First names use initial only (standard in maintenance remarks).

---

## Module 4: lifecycle.py

### Purpose
Simulate 365 days of operations for every asset. This produces the time-series data for the daily readiness snapshots.

### Daily Loop Logic

```python
for day in range(SIMULATION_DAYS):
    current_date = SIMULATION_START_DATE + timedelta(days=day)
    
    for asset in fleet:
        # 1. Check if PMCS is due
        if asset.pmcs_due_date <= current_date:
            create_pmcs_sr(asset, current_date)
            asset.pmcs_due_date = current_date + timedelta(days=PMCS_INTERVALS["B_CHECK"])
        
        # 2. If asset is MC or PMC, it operates
        if asset.current_status in ("MC", "PMC"):
            if random.random() < asset.unit["optempo"]["operate_prob"]:
                hours = random.uniform(*asset.unit["optempo"]["hours_per_day"])
                miles = random.uniform(*asset.unit["optempo"]["miles_per_day"])
                asset.current_hours += hours
                asset.current_miles += miles
                
                # 3. Check for fault based on operating profile
                fault = check_for_fault(asset)
                if fault:
                    create_fault_sr(asset, fault, current_date)
        
        # 4. Progress any open SRs (parts delivery, repair completion, etc.)
        for sr in asset.open_srs:
            progress_sr(sr, current_date)
        
        # 5. Record daily snapshot
        record_daily_status(asset, current_date)
```

### Operational Tempo Variation
Don't use the same optempo every day. Model realistic patterns:
- Weekends: 50% reduction in operate probability
- Field exercises: 2-week blocks where units go to "high" optempo and deployment_status = "field_exercise" (triggers grid coords in remarks)
- Holiday block leave: 2 weeks in December with minimal operations
- Deployment workups: 1-month pre-deployment surge for forward-deployed units

Schedule 2-3 field exercises per unit per year and 1 deployment workup for forward-deployed units. These should be randomly placed but not overlapping within the same unit.

---

## Module 5: faults.py

### Purpose
Inject realistic faults based on equipment type, operating hours, and age. Each equipment type has a specific fault profile with probability distributions.

### Equipment Fault Profiles

```python
EQUIPMENT_PROFILES = {
    "JLTV": {
        "nomenclature": "TRUCK, UTILITY, JOINT LIGHT TACTICAL VEHICLE",
        "model": "M1280A1",
        "fsc": "2320",
        "optempo_type": "wheeled",
        "maintenance_level_default": "Organizational",
        "classification_risk": "low",
        "faults": [
            {
                "id": "JLTV_TRANS_SEAL",
                "component": "transmission",
                "description": "Transmission output seal leak",
                "defect_code": ("NMAJ", "TRSM"),
                "probability_per_1000_miles": 0.8,
                "min_miles_before_occurrence": 8000,
                "condition_impact": "Degraded",  # or "Deadlined"
                "avg_repair_hours": 16,
                "avg_parts_cost": 2400,
                "parts_needed": [
                    {"nsn": "2520-01-582-4721", "nomenclature": "SEAL, OUTPUT SHAFT", "qty": 1, "cost": 187.50},
                    {"nsn": "2520-01-582-4698", "nomenclature": "GASKET SET, TRANSMISSION", "qty": 1, "cost": 342.00},
                    {"nsn": "9150-01-578-2104", "nomenclature": "LUBRICANT, TRANSMISSION FLUID", "qty": 6, "cost": 28.50},
                ],
                "tm_reference": "TM 9-2320-391-20",
                "classified": False,
                "remark_templates": [
                    "Veh exhibited trans fluid leak from output shaft area during ops. Approx {leak_rate} on ground after overnight. Traced to output seal failure IAW {tm_ref}. Replaced seal and gasket set, refilled trans fluid. Road tested {test_miles} mi, no further leak.",
                    "Trans fluid found pooling under rear of veh during post-ops PMCS. Output seal deteriorated, metal shavings found in drain pan. Replaced output seal assy and gasket set per {tm_ref}. Fluid analysis sent to oil lab.",
                    "Operator reported slipping during gear changes at speed. Checked trans fluid level — 2 qts low. Found output seal weeping. Replaced seal, topped off fluid, test drove. Shifting normal.",
                ],
            },
            {
                "id": "JLTV_CTIS",
                "component": "tire",
                "description": "CTIS (Central Tire Inflation System) failure",
                "defect_code": ("NMAJ", "TIRE"),
                "probability_per_1000_miles": 1.2,
                "min_miles_before_occurrence": 3000,
                "condition_impact": "Degraded",
                "avg_repair_hours": 8,
                "avg_parts_cost": 890,
                "parts_needed": [
                    {"nsn": "2530-01-612-8834", "nomenclature": "VALVE, CTIS MANIFOLD", "qty": 1, "cost": 445.00},
                    {"nsn": "2530-01-612-8901", "nomenclature": "HOSE ASSY, CTIS", "qty": 2, "cost": 112.00},
                ],
                "tm_reference": "TM 9-2320-391-20",
                "classified": False,
                "remark_templates": [
                    "CTIS fault light illuminated during convoy ops. System unable to maintain {tire_psi} PSI in {tire_position} tire. Inspected manifold valve — cracked housing. Replaced manifold valve and {hose_count} hoses per {tm_ref}.",
                    "Operator reported CTIS malfunction — all four tires losing pressure simultaneously. Traced to cracked manifold valve. Replaced valve assy and tested system. All tires holding at {tire_psi} PSI highway.",
                ],
            },
            {
                "id": "JLTV_TURBO",
                "component": "engine",
                "description": "Turbocharger actuator failure",
                "defect_code": ("NMAJ", "ENGN"),
                "probability_per_1000_miles": 0.3,
                "min_miles_before_occurrence": 15000,
                "condition_impact": "Deadlined",
                "avg_repair_hours": 24,
                "avg_parts_cost": 6800,
                "parts_needed": [
                    {"nsn": "2815-01-612-4472", "nomenclature": "TURBOCHARGER ASSY", "qty": 1, "cost": 4200.00},
                    {"nsn": "2815-01-612-4398", "nomenclature": "ACTUATOR, TURBO WASTEGATE", "qty": 1, "cost": 1850.00},
                    {"nsn": "5330-01-612-4501", "nomenclature": "GASKET SET, TURBO MOUNT", "qty": 1, "cost": 245.00},
                ],
                "tm_reference": "TM 9-2320-391-20",
                "classified": False,
                "remark_templates": [
                    "Veh lost power under load on grade, black smoke from exhaust. Turbo not spooling — actuator rod seized. Deadlined. Requires turbo assy replacement per {tm_ref}. POC: {mechanic}.",
                    "Intermittent power loss reported during convoy. Turbo boost gauge reading {boost_psi} PSI (normal {normal_boost} PSI). Wastegate actuator failed open. DL'd pending turbo replacement.",
                ],
            },
            {
                "id": "JLTV_ELECTRICAL",
                "component": "electrical",
                "description": "Battery/alternator system fault",
                "defect_code": ("NMAJ", "ELEC"),
                "probability_per_1000_miles": 1.5,
                "min_miles_before_occurrence": 2000,
                "condition_impact": "Degraded",
                "avg_repair_hours": 4,
                "avg_parts_cost": 680,
                "parts_needed": [
                    {"nsn": "6140-01-612-3847", "nomenclature": "BATTERY, STORAGE", "qty": 2, "cost": 285.00},
                ],
                "tm_reference": "TM 9-2320-391-10",
                "classified": False,
                "remark_templates": [
                    "Veh failed to start during morning dispatch. Battery voltage {voltage}V under load (min 24V). Batteries past service life ({battery_months} months). Replaced both batteries per {tm_ref}.",
                    "Voltage regulator fault — alternator output {alt_amps}A (spec {spec_amps}A). Batteries draining during ops. Replaced alternator and both batteries.",
                ],
            },
            {
                "id": "JLTV_BRAKE",
                "component": "brake",
                "description": "Brake pad/rotor wear",
                "defect_code": ("SAFE", "BRAK"),
                "probability_per_1000_miles": 0.6,
                "min_miles_before_occurrence": 10000,
                "condition_impact": "Deadlined",  # Safety = always DL
                "avg_repair_hours": 6,
                "avg_parts_cost": 1200,
                "parts_needed": [
                    {"nsn": "2530-01-612-5501", "nomenclature": "PAD SET, BRAKE", "qty": 2, "cost": 340.00},
                    {"nsn": "2530-01-612-5502", "nomenclature": "ROTOR, BRAKE", "qty": 2, "cost": 290.00},
                ],
                "tm_reference": "TM 9-2320-391-20",
                "classified": False,
                "remark_templates": [
                    "Brake wear indicator triggered during PMCS. {position} pads at {pad_mm}mm (min 3mm). Rotors scored. Safety deadlined. Replacing pads and rotors {axle} axle per {tm_ref}.",
                    "Operator reported grinding noise during braking. Inspected — {position} brake pads worn to backing plate. Rotors below min thickness. DL'd for safety. Replacing all {axle} brake components.",
                ],
            },
            # ... ADD 3-5 more fault types per equipment
        ],
    },

    "M1A1_ABRAMS": {
        "nomenclature": "TANK, COMBAT, FULL TRACKED, 120MM GUN, M1A1",
        "model": "M1A1 FEP",
        "fsc": "2350",
        "optempo_type": "tracked",
        "maintenance_level_default": "Organizational",
        "classification_risk": "high",  # FCS and armor data are classified
        "faults": [
            {
                "id": "M1A1_TRACK_TENSION",
                "component": "track",
                "description": "Track tension out of specification",
                "defect_code": ("NMAJ", "TRAK"),
                "probability_per_1000_miles": 3.0,
                "min_miles_before_occurrence": 500,
                "condition_impact": "Degraded",
                "avg_repair_hours": 8,
                "avg_parts_cost": 4500,
                "parts_needed": [
                    {"nsn": "2530-01-087-4872", "nomenclature": "TRACK SHOE, W/PADS", "qty": 6, "cost": 520.00},
                    {"nsn": "2530-01-087-4891", "nomenclature": "END CONNECTOR, TRACK", "qty": 12, "cost": 85.00},
                ],
                "tm_reference": "TM 9-2350-264-20-1",
                "classified": False,
                "remark_templates": [
                    "Track tension {side} side measured {tension_in} inches (spec {spec_tension} ± 0.5 in). {shoe_count} track shoes cracked/missing pads. Replaced shoes, adjusted tension IAW {tm_ref}.",
                    "During post-ops, {side} track found loose with {throw_count} thrown end connectors. Reinstalled connectors, replaced {shoe_count} damaged shoes, retensioned to {spec_tension} in. per {tm_ref}.",
                ],
            },
            {
                "id": "M1A1_FCS",
                "component": "fire_control",
                "description": "Fire control system alignment degraded",
                "defect_code": ("SAFE", "FCTL"),
                "probability_per_1000_miles": 0.5,
                "min_miles_before_occurrence": 2000,
                "condition_impact": "Deadlined",
                "avg_repair_hours": 40,
                "avg_parts_cost": 18000,
                "parts_needed": [
                    {"nsn": "1240-01-495-XXXX", "nomenclature": "SIGHT UNIT, GUNNER PRIMARY", "qty": 1, "cost": 12000.00},
                ],
                "tm_reference": "[CLASSIFIED TM 9-2350-264-20-3]",  # This IS the sensitive data
                "classified": True,
                "maintenance_level": "Intermediate",
                "remark_templates": [
                    "FCS boresight failed during gunnery prep. Gunner's primary sight {param_desc}. Unable to maintain zero beyond {range}m. DL'd for FCS alignment per {tm_ref}. Evacuated to IMA. POC: {mechanic}.",
                    "Tank crew reported engagement accuracy degraded during live fire. FCS diagnostics show {error_code} fault in {subsystem}. Requires depot-level calibration. Evacuating to {ima_unit}.",
                ],
            },
            {
                "id": "M1A1_TURBINE",
                "component": "engine",
                "description": "AGT-1500 turbine engine FOD/performance degradation",
                "defect_code": ("NMAJ", "ENGN"),
                "probability_per_1000_miles": 0.4,
                "min_miles_before_occurrence": 3000,
                "condition_impact": "Deadlined",
                "avg_repair_hours": 72,
                "avg_parts_cost": 45000,
                "parts_needed": [
                    {"nsn": "2815-01-087-5201", "nomenclature": "ENGINE, GAS TURBINE, AGT-1500", "qty": 1, "cost": 42000.00},
                ],
                "tm_reference": "TM 9-2350-264-20-2",
                "classified": False,
                "maintenance_level": "Intermediate",
                "remark_templates": [
                    "Turbine exhaust temp exceeding {egt_temp}°C (max {max_egt}°C) at idle. Power output insufficient for grade operations. Suspected FOD damage to first stage turbine blades. DL'd pending engine R&R. Evacuated to {ima_unit}.",
                    "Engine flameout during operations. Multiple restart attempts failed. Inspection found debris in intake plenum. Turbine section damage confirmed. Requires complete powerpack R&R. Evacuating.",
                ],
            },
            # ... ADD turret, comms, NBC system faults
        ],
    },

    "AN_TPS80_GATOR": {
        "nomenclature": "RADAR SET, AN/TPS-80 G/ATOR",
        "model": "AN/TPS-80",
        "fsc": "5840",
        "optempo_type": "static",
        "maintenance_level_default": "Intermediate",
        "classification_risk": "high",  # All performance params are classified
        "faults": [
            {
                "id": "GATOR_PHASED_ARRAY",
                "component": "radar",
                "description": "Phased array calibration drift",
                "defect_code": ("NMAJ", "ELEC"),
                "probability_per_1000_hours": 1.5,
                "min_hours_before_occurrence": 200,
                "condition_impact": "Deadlined",
                "avg_repair_hours": 48,
                "avg_parts_cost": 85000,
                "parts_needed": [
                    {"nsn": "5840-01-598-7701", "nomenclature": "MODULE, TRANSMIT/RECEIVE", "qty": 1, "cost": 72000.00},
                ],
                "tm_reference": "[CLASSIFIED TM 11-5840-XXX-23]",
                "classified": True,
                "maintenance_level": "Depot",
                "remark_templates": [
                    "Phased array calibration exceeding [REDACTED] threshold during BIT. {affected_elements} T/R modules showing degraded output. System unable to maintain [REDACTED] beam accuracy. DL'd for depot-level calibration per {tm_ref}. POC: {mechanic}.",
                    "G/ATOR self-test failure during power-on sequence. Error code {error_code} — array calibration fault. Performance degraded below [REDACTED] operational threshold. Evacuating to depot.",
                ],
            },
            {
                "id": "GATOR_COOLING",
                "component": "cooling",
                "description": "Cooling system pump failure",
                "defect_code": ("NMAJ", "COOL"),
                "probability_per_1000_hours": 2.0,
                "min_hours_before_occurrence": 100,
                "condition_impact": "Deadlined",
                "avg_repair_hours": 12,
                "avg_parts_cost": 3400,
                "parts_needed": [
                    {"nsn": "4320-01-598-8201", "nomenclature": "PUMP, COOLANT, RADAR COOLING", "qty": 1, "cost": 2800.00},
                ],
                "tm_reference": "TM 11-5840-XXX-20",
                "classified": False,
                "remark_templates": [
                    "Coolant temp alarm during sustained ops. Cooling pump not cycling — motor burned out. System auto-shutdown to prevent array damage. Replaced pump assy per {tm_ref}. Coolant levels nominal after repair.",
                    "Radar shut down after {runtime_hours} hrs continuous ops. Cooling system fault — pump output zero flow. Overtemp protection activated. Pump motor seized. Ordered replacement.",
                ],
            },
        ],
    },

    "HIMARS": {
        "nomenclature": "LAUNCHER, ROCKET, M142 HIMARS",
        "model": "M142",
        "fsc": "1055",
        "optempo_type": "wheeled",
        "maintenance_level_default": "Organizational",
        "classification_risk": "high",
        "faults": [
            {
                "id": "HIMARS_LAUNCHER_RAIL",
                "component": "launcher",
                "description": "Launcher rail alignment fault",
                "defect_code": ("SAFE", "WEAP"),
                "probability_per_1000_miles": 0.3,
                "min_miles_before_occurrence": 5000,
                "condition_impact": "Deadlined",
                "avg_repair_hours": 36,
                "avg_parts_cost": 24000,
                "parts_needed": [
                    {"nsn": "1055-01-458-4201", "nomenclature": "RAIL ASSY, LAUNCHER", "qty": 1, "cost": 18500.00},
                ],
                "tm_reference": "[CLASSIFIED TM 9-1055-XXX-23]",
                "classified": True,
                "maintenance_level": "Intermediate",
                "remark_templates": [
                    "Launcher rail alignment check failed during pre-fire. Rail deflection exceeding [REDACTED] mil tolerance. Unable to achieve required [REDACTED] accuracy standard. DL'd pending IMA rail alignment per {tm_ref}. POC: {mechanic}.",
                    "FCS reported launcher indexing error during dry fire exercise. Rail assembly showing {deflection}mm lateral play (max [REDACTED]mm). Safety deadlined. Evacuating launcher module to {ima_unit}.",
                ],
            },
            {
                "id": "HIMARS_HYDRAULIC",
                "component": "hydraulic",
                "description": "Hydraulic pump degradation",
                "defect_code": ("NMAJ", "HYDR"),
                "probability_per_1000_miles": 0.5,
                "min_miles_before_occurrence": 8000,
                "condition_impact": "Degraded",
                "avg_repair_hours": 12,
                "avg_parts_cost": 5200,
                "parts_needed": [
                    {"nsn": "4320-01-458-4501", "nomenclature": "PUMP, HYDRAULIC, LAUNCHER ELEVATION", "qty": 1, "cost": 3800.00},
                    {"nsn": "4730-01-458-4502", "nomenclature": "HOSE ASSY, HYDRAULIC, HIGH PRESSURE", "qty": 2, "cost": 340.00},
                ],
                "tm_reference": "TM 9-1055-XXX-20",
                "classified": False,
                "remark_templates": [
                    "Launcher elevation cycle time degraded — {cycle_time} sec (spec {spec_time} sec). Hydraulic pump output below {flow_rate} GPM minimum. Pump showing scoring on gears. Replacing pump and associated hoses per {tm_ref}.",
                    "Hydraulic fluid leak at launcher elevation cylinder. {leak_rate} fluid loss per hour. Traced to high-pressure hose fitting. Replaced hose assy and checked system pressure — {pressure} PSI nominal.",
                ],
            },
        ],
    },

    # DEFINE SIMILAR PROFILES FOR:
    # "MTVR_CARGO" — air brake, CTIS, starter, transfer case, cooling, corrosion faults
    # "LAV_25" — engine, transmission, turret traverse, tire/wheel station, comms, hull corrosion
    # "MV22B_OSPREY" — hydraulic, proprotor gearbox, nacelle tilt, avionics, fuel system
    # "CH53E_STALLION" — rotor head, transmission, hydraulic, APU, flight control
    # "MRAP_RG31" — mine damage (historical), engine, HVAC, armor bolt, electrical
    # "MEP_803A" — generator failure, voltage regulator, fuel pump, coolant, governor
    # "D7G_DOZER" — track, blade hydraulic, engine, final drive, undercarriage
    # "ROWPU" — membrane, pump, chemical injection, frame corrosion
    # Each needs 4-6 fault types with realistic templates
}
```

### Fault Triggering Logic

```python
def check_for_fault(asset):
    """Check if a fault occurs this operating cycle based on equipment profile."""
    profile = EQUIPMENT_PROFILES[asset.equipment_type]
    
    for fault in profile["faults"]:
        # Check minimum threshold
        if "min_miles_before_occurrence" in fault:
            if asset.current_miles < fault["min_miles_before_occurrence"]:
                continue
        if "min_hours_before_occurrence" in fault:
            if asset.current_hours < fault["min_hours_before_occurrence"]:
                continue
        
        # Calculate probability based on operating metric
        if "probability_per_1000_miles" in fault:
            daily_miles = asset.miles_today
            p = (fault["probability_per_1000_miles"] / 1000) * daily_miles
        elif "probability_per_1000_hours" in fault:
            daily_hours = asset.hours_today
            p = (fault["probability_per_1000_hours"] / 1000) * daily_hours
        
        # Age modifier: older equipment faults more
        age_years = (current_date - asset.fielding_date).days / 365
        age_modifier = 1.0 + (age_years * 0.1)  # 10% increase per year
        p *= age_modifier
        
        # Recent maintenance modifier: just-repaired equipment less likely to fault
        if asset.days_since_last_maintenance < 30:
            p *= 0.3
        
        if random.random() < p:
            return fault
    
    return None
```

---

## Module 6: remarks.py

### Purpose
Generate realistic maintenance remarks from templates. This is the critical module for realism.

### Template Processing

```python
def generate_remark(fault, asset, personnel_roster, current_date):
    """Generate a realistic maintenance remark from a fault template."""
    template = random.choice(fault["remark_templates"])
    
    # Get a mechanic from the personnel roster (same unit, appropriate MOS)
    mechanic = get_mechanic(personnel_roster, asset.unit, asset.equipment_type)
    
    # Fill template parameters
    params = {
        "tm_ref": fault["tm_reference"],
        "mechanic": f"{mechanic.rank} {mechanic.last_name} {mechanic.first_initial}. ext {mechanic.phone_ext}",
        "leak_rate": f"{random.choice(['1/2 qt', '1 qt', '2 cups', 'steady drip'])}",
        "test_miles": random.randint(5, 25),
        "tire_psi": random.choice([30, 35, 40, 45]),
        "tire_position": random.choice(["LF", "RF", "LR", "RR"]),
        "hose_count": random.randint(1, 3),
        "voltage": round(random.uniform(18, 22), 1),
        "battery_months": random.randint(18, 48),
        "alt_amps": random.randint(30, 55),
        "spec_amps": 90,
        "pad_mm": round(random.uniform(0.5, 2.5), 1),
        "position": random.choice(["front", "rear"]),
        "axle": random.choice(["front", "rear", "all"]),
        "side": random.choice(["left", "right"]),
        "tension_in": round(random.uniform(2.0, 4.0), 1),
        "spec_tension": 2.5,
        "shoe_count": random.randint(2, 8),
        "throw_count": random.randint(1, 4),
        "egt_temp": random.randint(850, 1050),
        "max_egt": 800,
        "boost_psi": random.randint(5, 12),
        "normal_boost": 22,
        "cycle_time": round(random.uniform(8, 15), 1),
        "spec_time": 5.0,
        "flow_rate": round(random.uniform(1.5, 3.0), 1),
        "pressure": random.randint(2800, 3200),
        "runtime_hours": round(random.uniform(4, 18), 1),
        "affected_elements": random.randint(2, 12),
        "error_code": f"E-{random.randint(100,999)}",
        "subsystem": random.choice(["GPS/INS", "laser rangefinder", "thermal channel", "ballistic computer"]),
        "deflection": round(random.uniform(0.3, 1.2), 1),
        "ima_unit": random.choice(["1st Maint Bn IMA", "2d Maint Bn IMA", "MCLB Albany", "MCLB Barstow"]),
        "param_desc": random.choice([
            "showing {:.1f} mil drift at 1000m".format(random.uniform(1.5, 4.0)),
            "thermal channel misaligned by {:.2f} degrees".format(random.uniform(0.05, 0.2)),
            "laser rangefinder reading {:.0f}m error at calibration distance".format(random.uniform(5, 25)),
        ]),
        "range": random.choice([800, 1000, 1500, 2000]),
        "leak_rate_hydro": random.choice(["1 qt/hr", "2 qt/hr", "steady weep", "0.5 qt/hr"]),
    }
    
    # Apply template with available params (ignore missing keys gracefully)
    remark = template
    for key, value in params.items():
        remark = remark.replace(f"{{{key}}}", str(value))
    
    return remark
```

### Remark Style Rules (to sound like a Marine wrote it)
- Use abbreviations: "veh" not "vehicle", "approx" not "approximately", "qty" not "quantity"
- TM references are always present for corrective maintenance
- Include specific measurements with units (PSI, mm, °C, volts, amps)
- Mechanics often include POC with DSN extension
- Occasionally include minor typos or informal language ("thing was leaking everywhere", "found the issue after pulling the whole manifold apart")
- Use "IAW" (in accordance with), "DL'd" (deadlined), "per" (per the reference)
- Sentences run together without proper punctuation sometimes
- Reference "post-ops", "pre-ops", "during ops", "during convoy", "during PMCS", "during gunnery prep"

---

## Module 7: sensitive.py

### Purpose
Inject context-appropriate sensitive data into maintenance remarks. Sensitivity is driven by context, not randomness.

### Rules

```python
SENSITIVITY_RULES = {
    # PII: appears when mechanic is listed as POC (30% of all remarks)
    "pii": {
        "trigger": "any",  # Any equipment type
        "probability": 0.30,
        "injection_method": "append_poc",
        # Appends: "POC: Cpl Davis R. / ext 4827" or "POC: SSgt Williams T. / EDIPI 1234567890"
        # 70% of PII is just name + ext (realistic)
        # 20% includes EDIPI
        # 10% includes last 4 SSN (this is the error case — Marines shouldn't do this but they do)
    },
    
    # Grid coordinates: appear ONLY when unit is deployed or in field exercise
    "grid_coords": {
        "trigger": "deployment_status in ('deployed', 'field_exercise')",
        "probability": 0.40,  # 40% of maintenance done in the field includes location
        "injection_method": "prepend_or_append",
        # Realistic MGRS for the unit's operating area:
        # Camp Lejeune area: 18S UJ xxxxx xxxxx
        # Camp Pendleton area: 11S MT xxxxx xxxxx
        # Okinawa area: 52S FE xxxxx xxxxx
        # Twentynine Palms: 11S QA xxxxx xxxxx
    },
    
    # Communications parameters: appear ONLY on comms/EW equipment or when reporting from field
    "comms": {
        "trigger": "equipment_type in ('AN_TPS80_GATOR', 'AN_TPQ36_FIREFINDER') or fault_component == 'comms'",
        "probability": 0.50,
        "injection_method": "within_remark",
        # Includes freq, callsign, net ID, or COMSEC device reference
        # Example: "COMSEC fill device KGV-72 S/N USMC-83726 failed key rollover"
        # Example: "Reported on TAD Net 30.050 MHz to BN COC"
    },
    
    # Classified TM references: appear ONLY on weapons/FCS/EW/radar equipment
    "classified_tm": {
        "trigger": "fault['classified'] == True",
        "probability": 1.0,  # Always — this is part of the fault template itself
        "injection_method": "in_template",
        # Already embedded in remark templates with [CLASSIFIED TM] format
    },
    
    # Equipment serial numbers for controlled items: appear on weapons, crypto, NVGs
    "controlled_serial": {
        "trigger": "equipment_type in ('M1A1_ABRAMS', 'HIMARS', 'AN_TPS80_GATOR', 'AN_TPQ36_FIREFINDER')",
        "probability": 0.25,
        "injection_method": "append",
        # Example: "S/N: USA-024871" or "Weapon S/N per DA Form 2062"
    },
}
```

### Grid Coordinate Generation (realistic per area)

```python
MGRS_BY_AREA = {
    "Camp Lejeune, NC": {"grid_zone": "18S", "square": "UJ", "easting_range": (20000, 40000), "northing_range": (60000, 85000)},
    "Camp Pendleton, CA": {"grid_zone": "11S", "square": "MT", "easting_range": (30000, 50000), "northing_range": (60000, 80000)},
    "Camp Kinser, Okinawa": {"grid_zone": "52S", "square": "FE", "easting_range": (30000, 50000), "northing_range": (50000, 70000)},
    "MCAS Beaufort, SC": {"grid_zone": "17S", "square": "PQ", "easting_range": (40000, 60000), "northing_range": (55000, 75000)},
    "MCAS Yuma, AZ": {"grid_zone": "11S", "square": "QA", "easting_range": (60000, 80000), "northing_range": (55000, 75000)},
}
```

---

## Module 8: supply.py

### Purpose
Generate realistic supply chain data for parts requisitions tied to fault Service Requests.

### Document Number Format
Real GCSS-MC document numbers: 6-digit AAC + 4-digit Julian date + 4-digit sequence
Example: M21670-6152-0034

### Supply Status Progression

```python
def generate_supply_chain(sr, parts_list, sr_date):
    """Generate realistic supply status progression for parts on a Service Request."""
    supply_records = []
    
    for part in parts_list:
        doc_num = f"{sr.unit_aac}-{julian_date(sr_date)}-{next_sequence():04d}"
        
        # Determine supply path based on part cost and availability
        if part["cost"] < 500:
            path = "fast"       # In stock at SSA, 1-3 days
        elif part["cost"] < 5000:
            path = "medium"     # Order from DLA, 7-21 days
        else:
            path = "slow"       # Backordered or depot-level, 30-90 days
        
        # Add random variation
        if random.random() < 0.15:
            path = "backordered"  # 15% of parts get backordered regardless
        
        supply_records.append({
            "document_number": doc_num,
            "nsn": part["nsn"],
            "nomenclature": part["nomenclature"],
            "qty_ordered": part["qty"],
            "qty_received": 0,  # Updated by lifecycle simulation
            "priority": sr.priority,
            "unit_cost": part["cost"],
            "total_cost": part["cost"] * part["qty"],
            "uoi": "EA",  # Unit of issue
            "supply_path": path,
            "status_history": generate_status_history(path, sr_date),
            "current_status": None,  # Set by status_history
            "esd": None,  # Estimated shipping date
            "ship_date": None,
            "received_date": None,
            "lkh": None,  # Last known holder (routing ID)
        })
    
    return supply_records
```

---

## Module 9: consistency.py

### Purpose
Enforce cross-record consistency. This is what separates obviously fake data from believable data.

### Consistency Rules

```python
CONSISTENCY_CHECKS = [
    # 1. If asset is NMCS, there MUST be an open SR with status "SHT PART" 
    #    AND at least one parts requisition without a received date
    "nmcs_implies_open_parts",
    
    # 2. If asset is NMCM, there MUST be an open SR with status 
    #    "WORK IN PROGRESS" or "AWAITING MAINT" or "EQUIP ACCEPTED"
    "nmcm_implies_active_sr",
    
    # 3. Days deadlined must increment correctly across daily snapshots
    "ddl_increments_daily",
    
    # 4. Hours and miles must be monotonically increasing (never decrease)
    "hours_miles_monotonic",
    
    # 5. When a part is received, SR status should transition from 
    #    "SHT PART" to "WORK IN PROGRESS" within 1-3 days
    "part_receipt_triggers_work",
    
    # 6. When repair is complete, asset status should transition from 
    #    NMC* to MC within 1-2 days (QC inspection + closeout)
    "repair_complete_transitions_mc",
    
    # 7. Condition code must match priority: 
    #    Deadlined = UND A (02/03), Degraded = UND B (05/06)
    "condition_priority_alignment",
    
    # 8. Serial numbers must be unique across entire fleet
    "unique_serial_numbers",
    
    # 9. SR numbers must be unique
    "unique_sr_numbers",
    
    # 10. If a cannibalization occurs, BOTH the recipient and donor 
    #     must show corresponding SR activity
    "cannibalization_cross_reference",
    
    # 11. Equipment in "EVACUATED" job status must show the receiving 
    #     unit in the SR owner field
    "evacuation_unit_matches",
    
    # 12. PMCS Service Requests should appear at regular intervals 
    #     (not randomly scattered)
    "pmcs_interval_regularity",
    
    # 13. No more than one active corrective maintenance SR per asset 
    #     at a time (PMCS SRs can overlap with CM SRs)
    "single_active_cm_sr",
    
    # 14. Parts cost should match the fault profile's expected range 
    #     (not wildly different)
    "parts_cost_realistic",
    
    # 15. Classification marking must be consistent with content:
    #     if remark contains [CLASSIFIED TM], marking must be >= CONFIDENTIAL
    "classification_content_alignment",
]
```

---

## Module 10: incidents.py

### Purpose
Generate 100 installation incidents for BASTION over 12 months.

### Incident Distribution (realistic)
```python
INCIDENT_TYPES = {
    # Mundane (70% of incidents)
    "FALSE_FIRE_ALARM": {"probability": 0.15, "severity": "LOW", "response_time_range": (5, 30)},
    "POV_ACCIDENT": {"probability": 0.12, "severity": "LOW", "response_time_range": (10, 45)},
    "MEDICAL_EMERGENCY": {"probability": 0.10, "severity": "MODERATE", "response_time_range": (3, 15)},
    "DOMESTIC_DISTURBANCE": {"probability": 0.08, "severity": "LOW", "response_time_range": (8, 30)},
    "LARCENY_THEFT": {"probability": 0.06, "severity": "LOW", "response_time_range": (15, 60)},
    "DUI_CHECKPOINT": {"probability": 0.05, "severity": "LOW", "response_time_range": (10, 20)},
    "NOISE_COMPLAINT": {"probability": 0.04, "severity": "LOW", "response_time_range": (15, 45)},
    "WILDLIFE_HAZARD": {"probability": 0.05, "severity": "LOW", "response_time_range": (10, 30)},
    "UTILITY_FAILURE": {"probability": 0.05, "severity": "MODERATE", "response_time_range": (15, 120)},
    
    # Serious (25% of incidents)
    "PERIMETER_BREACH": {"probability": 0.05, "severity": "HIGH", "response_time_range": (3, 15)},
    "UAS_SIGHTING": {"probability": 0.04, "severity": "HIGH", "response_time_range": (2, 10)},
    "HAZMAT_SPILL": {"probability": 0.04, "severity": "MODERATE", "response_time_range": (10, 60)},
    "SUSPICIOUS_PACKAGE": {"probability": 0.03, "severity": "HIGH", "response_time_range": (5, 20)},
    "STRUCTURAL_DAMAGE": {"probability": 0.03, "severity": "MODERATE", "response_time_range": (15, 45)},
    "CYBER_INCIDENT": {"probability": 0.03, "severity": "HIGH", "response_time_range": (5, 30)},
    "WEAPONS_DISCHARGE": {"probability": 0.02, "severity": "HIGH", "response_time_range": (2, 10)},
    
    # Critical (5% of incidents)
    "ACTIVE_THREAT": {"probability": 0.01, "severity": "CRITICAL", "response_time_range": (1, 5)},
    "CBRN_ALARM": {"probability": 0.01, "severity": "CRITICAL", "response_time_range": (2, 10)},
    "MAJOR_FIRE": {"probability": 0.02, "severity": "CRITICAL", "response_time_range": (3, 15)},
    "MASS_CASUALTY": {"probability": 0.01, "severity": "CRITICAL", "response_time_range": (2, 10)},
}
```

### Installation Data (synthetic Camp Butler-type)
Generate 50+ buildings, 4 ECPs, rally points, casualty collection points, ammo supply points. Each building has an ID, name, grid coord, occupancy, and function. Generate a building database in `data/installation_data.json`.

### Incident Record Structure
```python
{
    "incident_number": "INC-2025-0042",
    "date_time": "2025-09-15T03:42:00",
    "type": "UAS_SIGHTING",
    "severity": "HIGH",
    "location_building": "ASP-1",
    "location_grid": "18S UJ 34521 72104",
    "location_description": "Ammunition Supply Point, NE corner of installation",
    "initial_report": "Sentry at ECP-3 reported small quadcopter-type aircraft observed over ASP at approximately 200ft AGL, heading east. Red and green navigation lights visible. No markings observed. Duration of sighting approximately 45 seconds before aircraft departed to the northeast.",
    "fpcon_at_time": "BRAVO",
    "fpcon_change": "CHARLIE",
    "response_force": "PMO Patrol WATCHDOG-3, QRF RAIDER-1",
    "response_time_minutes": 4,
    "actions_taken": "Giant Voice activated. ECPs 3 and 4 locked down. QRF dispatched to ASP perimeter. CCTV recordings captured and preserved. Regional C-UAS coordinator notified. NCIS notified for investigation.",
    "casualties": 0,
    "property_damage_usd": 0,
    "resolution": "Area swept by QRF and PMO. No UAS recovered. CCTV footage shows small commercial-type quadcopter. FPCON returned to BRAVO after 4 hours. Investigation ongoing by NCIS.",
    "lessons_learned": "ECP-3 sentry lacked night vision capability to track UAS departure vector. Recommend NVG issue to all ECP sentries during FPCON BRAVO and above.",
    "reported_by": "Sgt Rodriguez M., Post 3 Sentry",
    "watch_officer": "Capt Chen S., SDO",
}
```

---

## Module 11: export.py

### Purpose
Format and export all data to professionally formatted XLSX files.

### Formatting Requirements
- Navy blue headers (#1B365D) with white bold text
- Alternating row shading (light blue #F2F6FA / white)
- Frozen header rows and auto-filters on all columns
- Column widths auto-sized to content
- Condition-based cell coloring:
  - Readiness: MC=green, PMC=yellow, NMCM=orange, NMCS=red
  - Classification: UNCLASSIFIED=green, CUI=yellow, CONFIDENTIAL=orange, SECRET=red
  - Risk score: 0-25=green, 26-50=yellow, 51-75=orange, 76-100=red
  - Severity: LOW=green, MODERATE=yellow, HIGH=orange, CRITICAL=red
- Boolean columns (contains_pii, etc.) colored red when TRUE
- Sheet names: "MPR Export", "Daily Readiness", "Incident Log", etc.
- Add a "Dataset Metadata" sheet with generation timestamp, record counts, and distribution statistics

---

## Execution Order

```
1. config.py          — Load all constants and lookup tables
2. fleet.py           — Generate fixed fleet of ~500 assets
3. personnel.py       — Generate ~200 synthetic Marines
4. lifecycle.py       — Simulate 365 days (calls faults.py, supply.py, remarks.py, sensitive.py)
5. consistency.py     — Validate all cross-record consistency rules
6. incidents.py       — Generate 100 installation incidents (independent of fleet sim)
7. export.py          — Format and export all XLSX files
```

---

## Testing Criteria

After generation, verify:
- [ ] Zero duplicate serial numbers across entire fleet
- [ ] Zero duplicate SR numbers
- [ ] All NMCS assets have open parts requisitions
- [ ] All NMCM assets have active maintenance SRs
- [ ] Hours/miles never decrease for any asset
- [ ] Days deadlined increment correctly
- [ ] Condition codes match priorities
- [ ] Classification markings match content
- [ ] Grid coordinates only appear on deployed/field exercise records
- [ ] COMSEC references only appear on comms/EW equipment
- [ ] Classified TM references only appear on weapons/radar/EW SRs
- [ ] PII appears in ~30% of remarks
- [ ] Overall fleet MC rate is realistic (75-85% across all units)
- [ ] No unit has 100% MC rate (unrealistic)
- [ ] No unit has below 50% MC rate (would trigger command attention)
- [ ] PMCS SRs appear at regular intervals per asset
- [ ] Supply status progression follows realistic timelines
- [ ] At least 5 cannibalization events are present in the dataset

---

## Dependencies
- Python 3.10+
- openpyxl (XLSX creation and formatting)
- pandas (data manipulation)
- numpy (random distributions)
- No external APIs, no network calls, fully offline
