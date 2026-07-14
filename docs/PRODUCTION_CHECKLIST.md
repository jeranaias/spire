# SPIRE — Pre-Production Checklist

> Actionable remediation tracker derived from
> [`PRODUCTION_READINESS.md`](./PRODUCTION_READINESS.md). Ordered by priority.
> Each item cites the finding #, the relevant **NIST SP 800-171 Rev. 3** control,
> and the file(s) to touch. Check the box when done.
>
> Legend: **P0** = blocks handover/ATO · **P1** = high · **P2** = medium ·
> **P3** = hardening/streamlining.

---

## P0 — Blockers (do before code leaves the building)

- [ ] **Rotate the live GitHub PAT** in `.env` and treat it as exposed. Confirm no
      credential is in the working tree at handover. _(Repo facts)_
- [ ] **Push `master` to `origin`** (41 commits ahead) so the review targets
      current code. _(Repo facts)_
- [ ] **Resolve `rbac-hardening-orphan`** (238 commits) — merge the wanted work or
      delete the branch. _(Repo facts)_
- [ ] **Fix the "AES-256 at rest" claim.** Either move at-rest encryption to
      **AES-256-GCM** (SQLCipher or a validated provider) *or* correct every
      "AES-256" string to match the AES-128 reality. `persistence.py:19,34`,
      `system.py:478,1254`, `docker-compose.yml:23`. _(Finding 2 · 3.13.11)_
- [ ] **Replace the hardcoded KDF salt** (`persistence.py:54`) with a per-install
      random salt stored beside the DB. _(Finding 2 · 3.13.16)_
- [ ] **Wire signature verification into `verify_chain()`** and default audit
      signing ON with a provisioned key, so AU-9(5) is real. `audit_integrity.py:175`,
      `persistence.py:343`. _(Finding 4 · 3.3.8)_
- [ ] **Close `gcss_export`** — add the custodian role gate + unit scoping used by
      the SENTRY export path. `routes/gcss_export.py`, `main.py:197-198`.
      _(Finding 5 · 3.1.2)_
- [ ] **Make CAC auth production-real for the target deployment:** drop the DoD PKI
      trust bundle in `cac_trust/`, set `SPIRE_AUTH_MODE=cac`, implement/enable
      **CRL or OCSP** revocation (currently `skip`), and replace the one/two-hop
      chain check with full path validation (`x509.verification.PolicyBuilder`).
      `cac_auth.py:366,401`. _(Finding 3 · 3.5.2)_

## P1 — High

- [ ] **Enforce default-deny authorization.** Add a router-include-level role
      dependency; close `copilot`, `gcss`, `integrations`, `decision_bridge`, `llm`.
      _(Finding 7 · 3.1.1)_
- [ ] **Derive `/api/llm/chat` clearance from the session**, not the hardcoded
      `X-Caller-Clearance: UNCLASSIFIED`. `llm.py:364`. _(Finding 7 · 3.1.2)_
- [ ] **Make offline the default, not a flag:**
  - [ ] Bundle **PMTiles** + wire `SPIRE_TILE_ORIGIN` into the frontend so the map
        has a real offline source (`OkinawaMapCanvas.tsx:31` currently has no
        runtime override — this is a code change). _(Finding 6 · 3.13.1)_
  - [ ] Default `SPIRE_LLM_PRIMARY_DISABLE=1` (force local Ollama first).
        `llm.py:254`. _(Finding 6)_
  - [ ] Ensure `SPIRE_GITHUB_TOKEN` is unset in shipped configs; gate/remove the
        feedback phone-home. `system.py:1726`. _(Finding 6)_
- [ ] **Flip `network_monitor` from log-only to deny** for production.
      `network_monitor.py:8`. _(Finding 10 · 3.13.1)_
- [ ] **Harden containers:** add non-root `USER`, digest-pin all base images, move
      off full-Debian toward minimal/distroless. All Dockerfiles. _(Finding 8 · 3.4.2)_
- [ ] **Fix Orin installers:** replace `curl | bash` / `curl | sudo bash` with
      checksum-verified, pinned downloads; add TLS/auth to the field box (no
      cleartext `0.0.0.0:8000`). `deploy/orin/*.sh`, `spire.service:32`.
      _(Finding 8 · 3.14.1)_
- [ ] **Add CI security scanning:** SAST (CodeQL/Semgrep), `pip-audit` + `npm audit`
      (remove `--no-audit`), secret scanning (gitleaks), image scan (Trivy),
      SHA-pin actions (kill `@master`). `ci.yml`. _(Finding 9 · 3.11.2)_

## P2 — Medium

- [ ] **Default the session cookie `Secure` flag ON** behind TLS. `auth.py:300`.
      _(Finding 11 · 3.13.8)_
- [ ] **Salt the de-id hashing** (or use a keyed HMAC) so truncated identifier
      hashes aren't brute-forceable. `hashing.py:45`, `integrations/gcss_hash.py`.
      _(Finding 12 · 3.13.11)_
- [ ] **Add security headers to the `docker-compose` nginx path**
      (`frontend/nginx.conf`) to match the Fly path. _(Finding 14)_
- [ ] **Tighten CORS** off the `.*` wildcard to an allowlist. `main.py:143`.
      _(Finding 13)_
- [ ] **Decide the Ed25519/FIPS question** — keep it (justify under FIPS 186-5) or
      add an ECDSA/RSA signing fallback for strict validated-module reviews.
      _(Finding 15)_
- [ ] **Exact-pin dependencies** (`==` / lockfile-driven) and reconcile the `pandas`
      floor mismatch. _(Finding 16 · 3.4.1)_

## P3 — Hardening & streamlining

- [ ] **Stand up a FIPS-validated runtime:** rebuild on a FIPS base (UBI9 + FIPS
      provider, or a `-fips` OpenSSL image); verify crypto executes in the validated
      module. _(Finding 1 · FIPS 140-3)_
- [ ] **Fix `system_boot` logging** — `_maybe_log_boot` queries the wrong table
      (`audit_chain` → `audit_log`). `persistence.py:1017`. _(Finding 17 · 3.3.1)_
- [ ] **Strengthen chain-head pinning** to catch equal-length rewrites, and stop
      silently swallowing audit-write failures. `audit_integrity.py:320`.
      _(Finding 18)_
- [ ] **Carve `marlog/` into its own repo** (−16k LOC / −1 supply chain from the
      SPIRE review). _(Streamlining)_
- [ ] **Delete the unused `uv.lock`** or wire it into every build path.
      _(Streamlining)_
- [ ] **Delete the scrapped About + Transition pages.** _(Streamlining)_
- [ ] **Add an SBOM** (CycloneDX/SPDX) to the release artifacts. _(3.4.1)_
- [ ] **Publish a `.well-known/security.txt`** + document the ATO boundary.

---

### Progress

| Phase | Items | Done |
|---|---:|---:|
| P0 — Blockers | 8 | 0 |
| P1 — High | 8 | 0 |
| P2 — Medium | 6 | 0 |
| P3 — Hardening | 8 | 0 |
