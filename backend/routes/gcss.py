"""Alias router that exposes GCSS-MC adapter surfaces under
``/api/gcss/...`` in addition to the original
``/api/integrations/gcss-mc/...`` paths.

The export routes themselves live in :mod:`backend.routes.gcss_export`
and are mounted by :mod:`backend.main` at both prefixes; this file only
re-aliases the coverage and dictionary handlers that still live in
:mod:`backend.routes.integrations`.
"""
from __future__ import annotations

from fastapi import APIRouter

from .integrations import (
    gcss_mc_coverage_summary,
    gcss_mc_dictionary,
)


router = APIRouter()

router.add_api_route(
    "/coverage-summary",
    gcss_mc_coverage_summary,
    methods=["GET"],
    name="gcss_coverage_summary",
)
router.add_api_route(
    "/dictionary",
    gcss_mc_dictionary,
    methods=["GET"],
    name="gcss_dictionary",
)
