"""
Personnel generator -- synthetic Marines roster.

Each Marine is a persistent identity usable in maintenance remarks as POC,
reporting mechanic, or shop supervisor. Names are drawn from a diverse surname
pool reflecting Marine Corps demographics. All EDIPIs start with '99' so they
are unmistakably synthetic; SSN last-4 values are drawn from a synthetic range
and are not real.
"""
from __future__ import annotations

import random
from dataclasses import dataclass
from pathlib import Path

# Base Marine rank distribution (junior-heavy) -- adjusted per unit below.
RANK_DISTRIBUTION = [
    ("LCpl", 0.25),
    ("Cpl",  0.22),
    ("Sgt",  0.20),
    ("SSgt", 0.15),
    ("GySgt", 0.08),
    ("MSgt", 0.04),
    ("PFC",  0.05),
    ("CWO2", 0.005),
    ("CWO3", 0.005),
]

# Per-unit multiplier on the base distribution (values >1 skew toward that rank).
# Tank + LAR + aviation units carry more senior ranks; CLBs skew junior.
UNIT_RANK_MULTIPLIERS = {
    "CLB-6":        {"LCpl": 1.20, "Cpl": 1.10, "GySgt": 0.80, "MSgt": 0.70},
    "CLB-1":        {"LCpl": 1.20, "Cpl": 1.10, "GySgt": 0.80, "MSgt": 0.70},
    "3d Maint Bn":  {"SSgt": 1.20, "GySgt": 1.15, "Sgt": 1.05},
    "2d Tank Bn":   {"Sgt": 1.15, "SSgt": 1.25, "GySgt": 1.15, "MSgt": 1.20, "CWO2": 2.0, "CWO3": 2.0},
    "2d LAR Bn":    {"Sgt": 1.10, "SSgt": 1.15, "GySgt": 1.10},
    "MALS-31":      {"SSgt": 1.25, "GySgt": 1.30, "MSgt": 1.40, "CWO2": 2.5, "CWO3": 2.5},
    "MWSS-372":     {"Sgt": 1.05, "SSgt": 1.05},
    "2d LAAD Bn":   {"SSgt": 1.15, "GySgt": 1.15, "CWO2": 2.0},
    "5/11 Marines": {"Sgt": 1.10, "SSgt": 1.10, "GySgt": 1.10},
    "7th ESB":      {"LCpl": 1.15, "Cpl": 1.10},
}

# MOS assignment rules tied to unit equipment mix (simplified; real T/O&E is
# richer but this is enough to make POC lines realistic).
UNIT_MOS_MIX = {
    "CLB-6":        ["3521", "3531", "0431", "3043"],
    "CLB-1":        ["3521", "3531", "0431", "3043"],
    "3d Maint Bn":  ["3521", "3531", "0431", "2141"],
    "2d Tank Bn":   ["1812", "2141", "0431"],
    "2d LAR Bn":    ["0313", "2141", "0431"],
    "MALS-31":      ["6073", "6323", "0431"],
    "MWSS-372":     ["1345", "1371", "0431", "3521"],
    "2d LAAD Bn":   ["0842", "0689", "0431"],
    "5/11 Marines": ["0811", "0842", "0431"],
    "7th ESB":      ["1345", "1371", "0431", "3521"],
}

# Diverse surname pool -- expanded mix reflecting actual Marine Corps demographics.
SURNAMES = [
    # A
    "Acosta", "Adams", "Aguilar", "Alvarez", "Anderson", "Andrade", "Arroyo",
    # B
    "Baker", "Barajas", "Barrera", "Bautista", "Bell", "Bennett", "Black", "Bonilla", "Brown", "Bryant",
    # C
    "Cabrera", "Calderon", "Campos", "Cantu", "Cardenas", "Carlson", "Carter", "Castillo", "Castro",
    "Chavez", "Chen", "Cho", "Choi", "Clark", "Coleman", "Collins", "Contreras", "Cooper", "Cortez",
    "Cruz", "Cuevas", "Curry",
    # D
    "Davis", "Delgado", "Diaz", "Dixon", "Dominguez", "Duarte", "Duong",
    # E
    "Edwards", "Elliott", "Escobar", "Espinoza", "Evans",
    # F
    "Farris", "Ferguson", "Fernandez", "Figueroa", "Fisher", "Flores", "Fonoti", "Ford", "Foster",
    "Franco", "Franklin",
    # G
    "Galindo", "Gallardo", "Garcia", "Gaytan", "Gibson", "Gil", "Gonzales", "Gonzalez", "Gorospe",
    "Graham", "Green", "Guerrero", "Gutierrez",
    # H
    "Hall", "Hamilton", "Harris", "Harrison", "Hayes", "He", "Henderson", "Henry", "Hernandez", "Herrera",
    "Hill", "Ho", "Hoang", "Holmes", "Howard", "Huang", "Hughes",
    # I-J
    "Ibarra", "Ingram", "Jackson", "James", "Jenkins", "Jimenez", "Jin", "Johnson", "Jones", "Juarez",
    # K
    "Kamaka", "Kang", "Kaulana", "Kawamura", "Kim", "King", "Knight", "Kuhio",
    # L
    "Lara", "Lee", "Leong", "Lewis", "Lim", "Lin", "Liu", "Lopez", "Lucero", "Luna",
    # M
    "Macalino", "Maka", "Malave", "Maldonado", "Marquez", "Martin", "Martinez", "Mason", "Mateo", "McCoy",
    "Medina", "Mendoza", "Miller", "Mitchell", "Molina", "Montoya", "Moore", "Morales", "Morgan", "Morris",
    "Munoz", "Murphy",
    # N-O
    "Nava", "Navarro", "Nelson", "Nguyen", "Nichols", "Nunez", "O'Brien", "Ochoa", "Ogbonna", "Okafor",
    "Olivares", "Ontiveros", "Ortega", "Ortiz", "Oyama",
    # P
    "Pacheco", "Padilla", "Palacios", "Park", "Parker", "Patel", "Perez", "Perry", "Peters", "Peterson",
    "Phillips", "Phung", "Pierre", "Powell", "Price", "Pulu",
    # Q-R
    "Quezada", "Quintana", "Ramirez", "Ramos", "Reed", "Reyes", "Reynolds", "Rios", "Rivera", "Robinson",
    "Rodriguez", "Rogers", "Rojas", "Rosales", "Ross", "Ruiz", "Russell",
    # S
    "Saldana", "Salinas", "Sanchez", "Sanders", "Santos", "Scott", "Serrano", "Silva", "Simmons",
    "Smith", "Soliai", "Solis", "Soto", "Stephens", "Stewart", "Sullivan",
    # T
    "Talaifua", "Tam", "Tamayo", "Taylor", "Thomas", "Thompson", "Tiongson", "Tobin", "Torres", "Tran",
    "Tsosie", "Tupua", "Turner",
    # U-V
    "Underwood", "Uribe", "Valdez", "Vargas", "Vasquez", "Vazquez", "Velasquez", "Vera", "Vo",
    # W
    "Wade", "Wagner", "Walker", "Wallace", "Walton", "Wang", "Ward", "Washington", "Watson", "Webb",
    "White", "Williams", "Wilson", "Wong", "Woods", "Wright", "Wu",
    # X-Z
    "Xiong", "Yamamoto", "Yang", "Yazzie", "Yi", "Young", "Zamora", "Zhang", "Zhao", "Zimmerman",
]

FIRST_INITIALS = list("ABCDEFGHJKLMNPRSTVW")


FIRST_NAMES = [
    "Alex", "Brian", "Carlos", "Daniel", "Eric", "Frank", "George", "Henry",
    "Ivan", "Jacob", "Kyle", "Luis", "Marcus", "Nathan", "Owen", "Peter",
    "Quinn", "Ryan", "Samuel", "Thomas", "Victor", "Wesley",
    "Amanda", "Brianna", "Christina", "Diana", "Elena", "Fatima",
    "Gabrielle", "Hannah", "Isabella", "Jasmine", "Keri", "Lauren", "Maria",
    "Natalie", "Olivia", "Priya", "Rachel", "Sofia", "Tiffany", "Vanessa",
]


@dataclass
class Marine:
    edipi: str
    rank: str
    last_name: str
    first_name: str
    first_initial: str
    mos: str
    unit_name: str
    phone_ext: str
    ssn_last4: str

    @property
    def display(self) -> str:
        """Standard maintenance-remark POC form, e.g. 'Cpl Davis R.'."""
        return f"{self.rank} {self.last_name} {self.first_initial}."

    @property
    def email(self) -> str:
        """USMC email convention: firstname.lastname@usmc.mil."""
        return f"{self.first_name.lower()}.{self.last_name.lower()}@usmc.mil"


def _weighted_rank(rng: random.Random, unit_name: str = "") -> str:
    multipliers = UNIT_RANK_MULTIPLIERS.get(unit_name, {})
    adjusted = [(rank, weight * multipliers.get(rank, 1.0)) for rank, weight in RANK_DISTRIBUTION]
    total = sum(w for _, w in adjusted)
    r = rng.random() * total
    acc = 0.0
    for rank, weight in adjusted:
        acc += weight
        if r <= acc:
            return rank
    return adjusted[-1][0]


def _synthetic_edipi(seq: int, rng: random.Random) -> str:
    """Obvious-synthetic EDIPI: starts with '99' so reviewers immediately
    recognize it as not-real. Real EDIPIs never start with 99."""
    suffix = f"{seq:04d}{rng.randint(10, 99)}"
    return f"99{suffix[-8:]}"


def _synthetic_ssn4(rng: random.Random) -> str:
    """Last four digits only, never real full SSN. Drawn from a synthetic
    range; presence of leading zero is a tell that this is synthetic."""
    return f"{rng.randint(1000, 9999)}"


def generate_personnel(units: list, count: int, seed: int) -> list[Marine]:
    """Distribute `count` synthetic Marines across units proportional to
    equipment count (bigger shops get bigger rosters)."""
    rng = random.Random(seed + 1)

    total_assets = sum(len(u.assets) for u in units)
    roster: list[Marine] = []
    seq = 1

    for u in units:
        share = max(5, round(count * len(u.assets) / total_assets))
        mos_mix = UNIT_MOS_MIX.get(u.name, ["0431"])
        for _ in range(share):
            first_name = rng.choice(FIRST_NAMES)
            marine = Marine(
                edipi=_synthetic_edipi(seq, rng),
                rank=_weighted_rank(rng, u.name),
                last_name=rng.choice(SURNAMES),
                first_name=first_name,
                first_initial=first_name[0],
                mos=rng.choice(mos_mix),
                unit_name=u.name,
                phone_ext=f"{rng.randint(4000, 4999)}",
                ssn_last4=_synthetic_ssn4(rng),
            )
            roster.append(marine)
            seq += 1

    return roster


def get_mechanic(roster: list[Marine], unit_name: str, rng: random.Random) -> Marine:
    """Pick a random Marine from the unit's shop (preferred MOS 35xx/21xx/60xx
    if available; fall back to any Marine in the unit; fall back to any
    Marine if the unit has no roster entry)."""
    in_unit = [m for m in roster if m.unit_name == unit_name]
    if not in_unit:
        return rng.choice(roster)
    wrenches = [m for m in in_unit if m.mos.startswith(("35", "21", "60", "13"))]
    return rng.choice(wrenches) if wrenches else rng.choice(in_unit)


if __name__ == "__main__":
    from config import RANDOM_SEED, OUTPUT_TARGETS
    from fleet import generate_fleet

    units, _ = generate_fleet(RANDOM_SEED)
    roster = generate_personnel(units, OUTPUT_TARGETS["personnel_count"], RANDOM_SEED)
    print(f"Generated {len(roster)} Marines across {len(units)} units.")
    from collections import Counter
    ranks = Counter(m.rank for m in roster)
    print(f"Rank distribution: {dict(ranks)}")
    print("Sample entries:")
    for m in roster[:5]:
        print(f"  {m.display} MOS {m.mos} ({m.unit_name}) ext {m.phone_ext} EDIPI {m.edipi} email {m.email}")
