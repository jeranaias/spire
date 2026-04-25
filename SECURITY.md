# Security Policy

SPIRE is a defense-intelligence-grade product targeting IL5 deployment,
developed during MDM 2026 by uniformed USMC personnel on duty time and
in pilot iteration with a small Marine Corps cohort. Vulnerability
reports are taken seriously and processed before feature work.

## Reporting a vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, email `jesse@thornveil.ai` (PGP key on request) with:
- A description of the vulnerability and its impact.
- Steps to reproduce against the synthetic dataset.
- Affected SPIRE version (from the StatusFooter or `git rev-parse HEAD`).
- Whether you believe a real DoD deployment is at risk.

You'll get an acknowledgement within 48 hours. Patch + advisory
timeline is usually 7–14 days for high-severity issues.

## What we consider in-scope
- Role scoping bypass (a role seeing data outside its authorization).
- Audit chain integrity (any path that lets a mutation skip the chain
  or allows a chain entry to be silently rewritten).
- Classification banner / FPCON spoofing.
- Coalition release path (any path that ships a record outside the
  authorized release profile).
- Air-gap mode escape (a write that succeeds while the toggle is
  engaged should be impossible).
- AES-256 at-rest encryption (`SPIRE_DB_PASSPHRASE`) — any path that
  reads plaintext when the passphrase is set.

## What we consider out-of-scope (for now)
- Brute-force or rate-limiting concerns on the demo `/api/*` endpoints.
  Production deployment puts these behind the customer's existing IL5
  reverse proxy / API gateway.
- Tile-provider attribution / map-data licensing — covered by the
  CartoDB Dark Matter free tier; production will swap to a bundled
  PMTiles file.
- Synthetic dataset leakage — by design the dataset is fictitious
  and contains no PII / OPSEC.

## Responsible disclosure timeline
1. Day 0: Report received, acknowledgement sent.
2. Day 1–3: Triage, severity assigned, reproduction confirmed.
3. Day 4–10: Patch developed + reviewed.
4. Day 11–14: Patched release tagged + advisory drafted.
5. Day 15+: Coordinated public disclosure via GitHub Security Advisory.

For a critical issue (active exploitation, RCE on the backend, audit
chain forgery), we shorten this to 72 hours and publish an emergency
patch.

## What you'll get
- Public credit in the advisory unless you ask not to be named.
- An invitation to the pilot cohort if you want to dig deeper.

## Bug bounty
SPIRE is pre-revenue. We do not run a paid bounty today. If we land a
program of record, security researchers who participated meaningfully
during pilot will be invited to a paid bounty program at that time.
