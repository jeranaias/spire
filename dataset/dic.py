"""GCSS-MC supply tagging — DIC, ITEM_TYPE, SERVICE_ACTIVITY, DOC_STATUS.

Real-export distributions (from `dataset/data/gcss_real_profile.json`):

DIC (Document Identifier Code):
    A0A  69.4%  Requisition - Issue, with status request
    A01  21.2%  Requisition - Issue
    A2A   7.4%  Requisition - Pass Action, with status request
    A21   1.9%  Requisition - Pass Action

ITEM_TYPE:
    I       89.9%  (Inventory item)
    SECREP  10.1%  (Secondary Reparable)

SERVICE_ACTIVITY (parts):
    Issue from Inventory     59.0%
    null                     35.2%   (due-in-only requisitions)
    SECREP Exchange           3.7%
    Return to Inventory       1.5%
    Issue to Inventory        0.6%

DOC_STATUS (due-in):
    Complete    86.8%
    Cancelled   13.2%

Correlation rules (matches real data):
    SECREP items → A2A / A21 (pass-action to source-of-supply)
    Inventory items → A0A / A01
    "with status request" variants (A0A, A2A) dominate when item is being
    actively pursued.
"""
from __future__ import annotations

import random
from typing import Tuple


# ITEM_TYPE distribution.
_ITEM_TYPE_WEIGHTS: list[tuple[str, int]] = [
    ("I",      899),
    ("SECREP", 101),
]


def sample_item_type(rng: random.Random, part_cost: float | None = None) -> str:
    """Sample ITEM_TYPE. High-cost parts (>= $1500) lean SECREP — that's
    the real-world correlation observed in MCO maintenance traffic.
    Bias kept low (0.15) so the global ITEM_TYPE rate stays within ±2pp
    of the real export's I/SECREP 89.9/10.1 split (see DIC tolerance in
    `gcss_real_profile.json`).
    """
    if part_cost is not None and part_cost >= 1500 and rng.random() < 0.15:
        return "SECREP"
    types, ws = zip(*_ITEM_TYPE_WEIGHTS)
    return rng.choices(types, weights=ws)[0]


# DIC weights, conditioned on ITEM_TYPE.
_DIC_INVENTORY: list[tuple[str, int]] = [
    ("A0A", 766),  # 69.4 / (69.4 + 21.2) = 0.766 of inventory rows
    ("A01", 234),
]

_DIC_SECREP: list[tuple[str, int]] = [
    ("A2A", 794),  # 7.4 / (7.4 + 1.9) = 0.795 of secrep rows
    ("A21", 206),
]


def sample_dic(rng: random.Random, item_type: str) -> str:
    table = _DIC_SECREP if item_type == "SECREP" else _DIC_INVENTORY
    codes, ws = zip(*table)
    return rng.choices(codes, weights=ws)[0]


# SERVICE_ACTIVITY distribution (excluding null — null is for due-in-only
# rows, set externally).
_SERVICE_ACTIVITY_WEIGHTS: list[tuple[str, int]] = [
    ("Issue from Inventory", 911),  # 59.0 / 64.8 normalized over non-null rows
    ("SECREP Exchange",       57),
    ("Return to Inventory",   23),
    ("Issue to Inventory",    10),
]


def sample_service_activity(rng: random.Random, item_type: str | None = None) -> str:
    """Sample SERVICE_ACTIVITY. SECREP items always go through SECREP
    Exchange — that's their entire workflow purpose."""
    if item_type == "SECREP":
        return "SECREP Exchange"
    acts, ws = zip(*_SERVICE_ACTIVITY_WEIGHTS)
    return rng.choices(acts, weights=ws)[0]


# DOC_STATUS distribution.
_DOC_STATUS_WEIGHTS: list[tuple[str, int]] = [
    ("Complete",  868),
    ("Cancelled", 132),
]


def sample_doc_status(rng: random.Random, supply_path: str | None = None) -> str:
    """Sample DOC_STATUS. Backordered paths cancel more often (~25% vs the
    ~13% baseline) — captures the operational reality that long backorders
    eventually get cancelled out by the requesting unit."""
    if supply_path == "backordered" and rng.random() < 0.25:
        return "Cancelled"
    statuses, ws = zip(*_DOC_STATUS_WEIGHTS)
    return rng.choices(statuses, weights=ws)[0]


def sample_supply_tags(
    rng: random.Random,
    part_cost: float | None,
    supply_path: str | None,
) -> dict:
    """One-call helper that returns a dict with all four tags consistently
    correlated. Used by `dataset/supply.py` at requisition creation."""
    item_type = sample_item_type(rng, part_cost)
    return {
        "item_type": item_type,
        "dic": sample_dic(rng, item_type),
        "service_activity": sample_service_activity(rng, item_type),
        "doc_status": sample_doc_status(rng, supply_path),
    }
