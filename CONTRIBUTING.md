# Contributing to SPIRE

## What SPIRE is, who owns it

SPIRE is built during MDM 2026 (MARCORLOGCOM AI Forum Hackathon, 27–30
April 2026) on government duty time by uniformed USMC personnel. Per
`LICENSE.md`:

- **The SPIRE application** (this repository — UI, integrations, demo
  scripts, dataset engine, hackathon-period configurations) is a
  **government work product**. Iteration during the hackathon and
  pilot occurs on duty time by USMC contributors.
- **Pre-existing Thornveil LLC IP** that SPIRE incorporates (RigRun
  routing engine, HawkStack architecture, ThermalHawk-Nano v2 weights,
  Harakat) remains Thornveil property, licensed to the USG under the
  terms in `LICENSE.md`.
- **Synthetic data** ships with the repo and contains zero real
  government data.

If you're unclear whether your contribution falls under "SPIRE
application" or "Thornveil pre-existing IP," ask the maintainer in the
PR description before merging.

## The pilot cohort

Initial development + iteration happens at MDM 2026 with:

- **Jesse Morgan** (SSgt, USMC; also Thornveil LLC) — primary developer
  + maintainer, on duty time during the hackathon.
- **CWO** (TBD) — senior maintainer, signs off on pilot direction.
- **Two SSgts** (TBD) — pilot cohort, file issues, drive iteration.

Pilot expands post-hackathon to a wider USMC operator group as the
program matures toward a HQMC I&L program of record.

## Filing issues

## Filing issues

The best path is the in-app **Report Issue** button (bottom-right).
It pre-fills your role + active view + a screenshot, and posts to the
GitHub repo. If you can't reach the app, file directly:
https://github.com/jeranaias/spire/issues/new/choose

We have three issue templates:
- **Bug** — something broke. Steps + expected + actual + screenshot.
- **Feature** — what's missing. Use case + role + scenario.
- **Incident** — operational problem (e.g. role scoping leaked
  something it shouldn't, classification banner went stale).

## What makes a good issue
- Tag the role you were operating as.
- Tag the view (SENTRY / PULSE / BASTION + sub-tab).
- Include the SPIRE version from the StatusFooter (e.g. `v1.0.0-rc1`).
- Steps to reproduce, even if rough — "I clicked X and Y happened."
- Screenshots help, log lines help more.

## What we DON'T want in issues
- Real OPSEC / classified data. SPIRE ships with a synthetic dataset;
  please reproduce against synthetic. If you've found a real-data leak,
  file it via the SECURITY.md path instead.
- Personal information beyond your GitHub handle and rank. No EDIPIs.

## Pull requests

The repo uses a simple branch model:
- `main` — protected, deploys to pilot. Requires PR review.
- `develop` — integration, where features land first.
- `feature/<short-name>` — your work.

Branch from `develop`. PR back to `develop`. Maintainer cuts a release
branch off `develop` for `main` when the cohort agrees we're shipping.

### Commit style
Match the existing tone. Look at `git log --oneline` for examples:
```
G5 GC-7: Air-gap deployment mode — comms-state pulse + queue + sync-on-restore
PULSE remediation: Monte Carlo forecast view, CONUS map, sparklines
```
- Subject: imperative, sentence case, ≤ 72 chars.
- Optional body with dashed bullets for the *why*.
- **No AI attribution**, no "Generated with …" trailers, no
  "Co-Authored-By: Claude" lines. The repo enforces this socially +
  via the maintainer review.

### Code style
- **Frontend**: TypeScript strict mode. Run `npm run build` before PR
  (the CI job will reject if `tsc -b` fails). Use the existing design
  tokens (`var(--color-*)` + `.spire-body` + `.spire-label`); don't
  introduce new colour primitives.
- **Backend**: Python 3.12+. Type-hinted. Pydantic for boundaries.
  Run `pytest dataset/tests/` before PR.
- **No emojis** in code, comments, or commit messages unless the
  maintainer explicitly asked.

### What gets your PR merged fast
1. Tied to an open issue.
2. ≤ 400 lines of diff (split larger work).
3. Tests pass (`pytest`, `npm run build`).
4. The Playwright smoke (`scripts/p4_smoke.py` and friends) still
   produces clean screenshots.
5. CHANGELOG.md updated under the `## [Unreleased]` heading.

### What gets your PR rejected
- AI attribution anywhere. Will be sent back with no review.
- New dependencies without a one-paragraph justification in the PR
  description (we run on commodity hardware in air-gap conditions —
  every 100KB of dependency matters).
- UI changes that break existing role-scoped views without explicit
  test coverage.

## Development setup
See `SPIRE_INSTALL.md` for the Docker path. For native development:

```
# backend
cd /path/to/spire
python -m venv .venv
.venv/bin/pip install -r backend/requirements.txt -r dataset/requirements.txt
.venv/bin/python -m uvicorn backend.main:app --reload --port 8700

# frontend
cd frontend
npm install
npm run dev
# open http://localhost:5173
```

Frontend dev server proxies `/api/*` to `http://127.0.0.1:8700`.

## Code of Conduct
Standard Contributor Covenant. Be useful to the cohort. Don't be a jerk
in issues or reviews.

## Maintainers
- @jeranaias (SSgt Morgan, primary developer + repo maintainer)
- CWO (TBD) — senior maintainer for pilot direction
- Two SSgts (TBD) — pilot cohort + contributors

For program-of-record handoff to HQMC I&L, the repo will migrate to a
DON-approved hosting environment (code.mil, Acquisition Innovation Hub,
or equivalent) per the LICENSE terms. This `jeranaias/spire` repository
is the active development working copy during MDM 2026 + pilot.

## License + IP
See `LICENSE.md` for the full SPIRE-application vs Thornveil-pre-existing
split. Short version: contributions to the SPIRE application are
government work product; Thornveil-licensed components stay Thornveil.
