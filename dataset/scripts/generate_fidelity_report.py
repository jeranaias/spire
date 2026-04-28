"""Alias entry point for the GCSS-MC schema fidelity report.

Wraps ``dataset.scripts.fidelity_report`` so reviewers and CI can invoke
the report builder under either of two names:

  - ``python -m dataset.scripts.fidelity_report`` (original)
  - ``python -m dataset.scripts.generate_fidelity_report`` (this shim)

The shim writes the report to two locations:

  - ``dataset/data/gcss_fidelity_report.md`` — committed alongside the
    underlying profile JSONs so reviewers see the report next to the
    inputs that produced it.
  - ``docs/gcss_fidelity_report.md`` — discoverable copy in the project
    docs folder, alongside ``ARCHITECTURE.md`` / ``DEMO_SCRIPT.md``.
"""
from __future__ import annotations

import sys

from dataset.scripts.fidelity_report import main


if __name__ == "__main__":
    sys.exit(main())
