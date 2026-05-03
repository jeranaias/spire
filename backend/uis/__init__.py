"""SPIRE Universal Ingest Service (UIS).

One pipeline that handles the messy reality of any tabular feed and a
tiny per-source declarative spec. Replaces bespoke parsers across
GCSS-MC ECP/UTIL/SR-header (today) and DRRS-MC, MILES, TPS-D, etc.
(future) with one ingest pipeline + N declarative AdapterSpecs.

Public surface kept narrow on purpose:

    from backend.uis.adapters.spec import AdapterSpec, ColumnSpec
    from backend.uis.canonical.schema import IDM
    from backend.uis.pipeline import run_pipeline

Everything else is implementation detail. See
docs/UNIVERSAL_INGEST_DESIGN.md for the architecture contract.
"""
from __future__ import annotations
