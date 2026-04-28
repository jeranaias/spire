# SPIRE — Replit Environment

## Overview

SPIRE (Sanitization, Prediction, Intelligence, Readiness Engine) is a contested-logistics operating system designed to provide sanitization, prediction, intelligence, and readiness capabilities. Originally built for USMC pilots, its primary purpose is to offer a robust operating system for contested logistics environments.

Key capabilities include:
- Generating synthetic canonical datasets.
- Providing a REST API and a dynamic frontend.
- Implementing a comprehensive authentication system with role-based access control.
- Managing classification and export controls for sensitive data.
- Integrating with external logistics systems (GCSS-MC, OMS-UCI, MIL-STD-6016).
- Simulating communication states for disaster preparedness drills.
- Maintaining a model registry for AI/ML supply chain transparency.
- Offering a "Decision Bridge" dashboard for critical decision-making.
- Supporting scenario-based vignettes for training and demonstrations, including in-app presentation tools.

## User Preferences

- I want iterative development.
- I prefer clear and concise communication.
- Ask before making major changes.
- Do not make changes to the folder `dataset/`.
- Do not make changes to the file `backend/auth.MOCK_USERS`.

## System Architecture

The SPIRE application features a clear separation between its backend and frontend components, designed for scalability and maintainability.

### UI/UX Decisions
- **Frontend Technologies**: React 19, Vite 8, TypeScript, Tailwind 4, MapLibre, Recharts, Zustand, React Router.
- **Authentication UI**: CAC cert-selection splash with mocked Marine roles, identity pill, and role badges in the TopBar, including specific UI elements for classification, operational indicators, and role-based access.
- **Classification Display**: Visual representation of data classification levels.
- **Joint COP Preview**: A simulated Navy/Joint "JLTC" shell with distinct styling and communication control for disaster preparedness drills.
- **Decision Bridge**: A 6x2 grid layout optimized for 1920x1080 resolution.
- **Stage Mode**: An 8-minute demo UI (`?stage=1`) collapsing SPIRE to four hero use-case tiles (SENTRY, PULSE, BASTION, DHA RESCUE), with presenter role-hopping capabilities and rehearsal aids.

### Technical Implementations
- **Backend Framework**: FastAPI (Python 3.12) for high-performance API services.
- **Dataset Generation**: Synthetic canonical dataset generated at boot by the `dataset/` engine.
- **Authentication**: HMAC-SHA256-signed `HttpOnly` `SameSite=Lax` cookie (`spire_session`, 12h TTL) for session management. Role-based access control derived from signed-in cert with server-side validation using `request.state.user.role`.
- **Classification Enforcement**: Server-side gates in `backend/scoping.py` (`require_clearance`, `require_no_downgrade`) ensuring data integrity and access control. Classification stamps applied to all exported artifacts and HTTP headers.
- **Integrations**: Reference implementation (`IntegrationsView.tsx`) detailing field mapping, polling cadence, auth, ATO posture, and failure modes for GCSS-MC. Includes a Field Dictionary section that pulls the derived 163-column GCSS-MC schema from `dataset/data/gcss_dictionary.json` (built from the sanitized dictionary CSVs in `tmp/gcss-mc/`, which are gitignored) and renders coverage badges (consumed / partial / dropped). Backed by `/api/integrations/gcss-mc/coverage-summary` and `/api/integrations/gcss-mc/dictionary`. Includes schema-aligned export adapters (`backend/routes/integrations.py`) and SENTRY GCSS ingest adapters (`backend/integrations/sentry_gcss_adapter.py`).
- **Schema Fidelity Tooling** (`dataset/scripts/`): `profile_gcss_real.py` and `profile_gcss_synth.py` produce field-distribution profiles; `build_gcss_dictionary.py` joins the sanitized dictionary CSVs with the real top-3 values and writes `dataset/data/gcss_dictionary.json`; `fidelity_report.py` writes the side-by-side `dataset/data/gcss_fidelity_report.md` (Jaccard + total-variation distance per field).
- **Mission Clock and Scenario Timeline**: Process-wide singleton managing `running`, `rate`, anchor wall-clock, and an event registry. Decoupled from real wall time (1 wall-second = 1 scenario-minute at 1x).
- **Reset-to-Clean-Demo**: Server-side endpoint (`POST /api/system/admin/reset-demo`) to return SPIRE to a known t=0 state without regenerating the full dataset, preserving determinism. As of Task #194 the reset also clears SPIRO ephemeral tool state (FPCON ladder back to BRAVO, QRF dispatches dropped) via `backend/copilot/tools.reset_tools_state()`.
- **SPIRO Tool Catalog (Task #194)**: SPIRO ships with 33 tools across 7 surfaces (Asset/Fleet legacy, SENTRY, PULSE, BASTION, DHA RESCUE, System, Audit). New for #194: 25 tools added on top of the original 8, every mutating tool emits a `spiro.<tool>` audit row, and the SYSTEM_PROMPT in `backend/copilot/planner.py` carries a Marine brevity vocabulary block (Affirm/Negative/Roger/BLUF/24h time/no apologies) plus four refusal templates. Frontend composer chips per role live in `frontend/src/components/Spiro.tsx::examplesForRole`. Catalog at `docs/SPIRO_TOOL_CATALOG.md`. Tests: `backend/tests/test_spiro_brevity.py`, `backend/tests/test_spiro_tools.py`, `tests/playwright/spiro_brevity.spec.ts`.
- **Audit Logging**: Hash-chained SQLite audit table (`backend/persistence.py`) with a Security-Manager-only SOC-shaped view (`AuditView.tsx`) featuring filters, pagination, and export. Successful joint COP exports are stamped into the chain as `joint_export_released` rows (Task #102) via `backend/routes/joint.py::_log_joint_release` — payload carries `protocol` (`OMS/UCI` / `Link 16`), `subscription_model`, `classification`, per-message-family `message_counts`, and the operator envelope (role, dodid, name) so a security manager can answer "who released the MAGTF picture at HH:MM yesterday?". The SOC view renders these rows as `Joint export — OMS/UCI` / `Joint export — Link 16` while keeping the raw `kind` for filter chips.
- **Joint COP Export Adapters**: Read-only adapters for OMS-UCI and MIL-STD-6016 (Link 16) in `backend/routes/joint.py`, enforcing `SECRET` clearance for exports.
- **DDIL Mode Dramatization**: Frontend-only simulation of SATCOM-denial drills (Limited, Intermittent, Disconnected states) using an API client interceptor in `frontend/src/api.ts`.
- **Model Registry**: Hand-maintained JSON registry (`dataset/data/model_registry.json`) for AI/ML model supply chain transparency, exposed via dedicated backend routes and frontend views.
- **Decision Bridge Polling**: Polling with backoff for various tiles (alerts 10s, audit 5s, mc-by-unit 60s, shortages 30s, mission 60s).
- **Blood / Class VIII H+72 Vignette**: Data-driven scenario (`blood-h72.scenario.json`) with JSON loader, validator, and hook module for scenario ticker dispatch.
- **In-app Pitch Deck**: `/pitch` route with slide chrome, keyboard navigation, and presenter mode for in-app presentations.
- **Live-demo Failsafe**: Presenter-only escape hatch (`FailsafePlayer.tsx`) to swap live demo with a pre-recorded video, accessible via dedicated button or `F9` hotkey. Asset at `frontend/public/demo-failsafe.mp4` is a 60s motion-graphic stop-gap (5 title cards in SPIRE chrome) — recommend re-recording on demo hardware before stage.
- **Hash-Redirect Safety Net**: Inline script in `frontend/index.html` rewrites bare `/pitch`, `/pitch/`, `/demo`, `/demo/` URLs to the hash form (`/#/pitch`, `/#/demo`) before React boots, since SPIRE uses HashRouter. Preserves search query and never blocks app boot on failure.
- **In-app Identity Switcher**: `IdentityPill` dropdown in `TopBar.tsx` exposes a Switch Identity section with one-click swaps between the four mock CAC certs. Lazy-fetches the cert directory on first open, caches the full list (re-derives swap targets per render to stay correct after mid-demo switches), retries on transient fetch failure, and uses the mock backend's any-6-digit-PIN policy with `"000000"` for in-app swaps. Includes Presenter shortcuts (Open pitch deck, Open demo cockpit) and Sign out.
- **Stable Session Secret**: `SPIRE_SESSION_SECRET` env var pins the HMAC key used by `backend/auth.py` to sign the `spire_session` cookie. Without it the key is regenerated on every backend restart, invalidating outstanding sessions and bouncing presenters back to `/auth`. Backend logs a hint to set the env var when falling back to an ephemeral key.
- **Slider Debounce + AbortController**: Inference Economics slider in `InferenceEconomicsTab.tsx` wraps the extrapolation POST in a 180ms debounce and AbortController so fast drags can't race themselves into a transient 502. Expected `AbortError` on superseded requests is suppressed from the UI error state.
- **PULSE Risk Board Drafts + Approver Flow**: The Risk Board "Draft Action" CTA persists candidate actions to a real `pulse_drafts` SQLite table via `POST /api/pulse/draft-action` (writes a `pulse_draft_action` row to the hash-chained audit log). The notifications chip in `TopBar.tsx` (`NotificationsChip.tsx`, scoped to maintenance_chief / g4 / mef_commander) polls `GET /api/pulse/drafts` every 15 s and re-fetches on the `draftsRefreshTick` store nonce. Held drafts support a real two-actor workflow: the originator sees only **Dismiss** (`POST /api/pulse/drafts/{id}/dismiss`); a different user in {g4, maintenance_chief, mef_commander} sees **Approve** / **Reject** (`POST /api/pulse/drafts/{id}/approve` and `/reject`). Self-approval is hard-blocked (`403 SelfApprovalForbidden`) and re-acting on a non-held draft returns `409 DraftNotHeld`. Both transitions write `pulse_draft_approve` / `pulse_draft_reject` audit rows. Approving a `cannibalize` draft re-validates the artifact (recipient_sr / donor_sr / nsn) and synchronously executes the existing cannibalization-propose flow — the audit row's payload includes `execution.proposal_id` (PROP-…) and the new `cannibalization_propose` row carries `from_draft_id` so the chain links draft → proposal. Toast copy reads "…held in Drafts (DRAFT-…) — awaiting approver review." Held-queue rotation (Task #144): every `/pulse/drafts` request lazy-ticks `expire_stale_pulse_drafts()` which moves rows past `SPIRE_DRAFT_TTL_HOURS` (default 72h) or beyond `SPIRE_DRAFT_CAP_PER_UNIT` (default 25) to status `expired` with a matching `pulse_draft_expire` audit row (conditional UPDATE + rowcount==1 guard so concurrent sweeps can't double-audit). The popover hides expired drafts by default but offers a "Show expired" toggle (`data-testid="notifications-show-expired"`) that opt-in fetches `?status=expired`; the badge counter remains the held count.
- **Stage Live-Ingest Mode** (Task #183): `SPIRE_BOOT_EMPTY=1` env flag causes `backend.main.lifespan` to skip `load_dataset()` so SPIRE boots with an empty dataset singleton (`backend/state.py::init_empty_dataset`). DECISION BRIDGE then renders a drag-drop hero card (`StageIngestHero.tsx`) with three named slots (header / sr_parts / due_in); on submit it POSTs to `/api/system/stage-ingest` (RBAC-gated to `data_custodian` / `security_manager`, 60s wall-clock timeout, sanitization gate that flags un-hashed TAMCN / SR_NUMBER / SERIAL_NUMBER / OWNER_UNIT) and atomically swaps the singleton via `swap_dataset()`. While empty, BASTION / PULSE / SENTRY render the "Awaiting GCSS-MC ingest" placeholder (`AwaitingIngestEmpty.tsx`) instead of fetching populated data; their backend routes return an `{empty: true, message}` envelope (type-guarded by `isEmptyEnvelope` in `frontend/src/api.ts`). The `useDatasetStatus` hook polls `/api/system/dataset-status` every 5 s. **Shift+F8** is a capture-phase global failsafe that POSTs to `/api/system/admin/reset-demo` (extended to also rehydrate the dataset singleton from the seed-42 baseline) and toasts `Failsafe — restored seed-42 baseline`. Synthetic 6-row CSV stand-ins for CI live in `tests/fixtures/stage_ingest/`; the real sanitized GCSS-MC export is **never** committed. Operator runbook: `docs/stage-rehearsal.md`.
- **Per-asset Bill of Materials (Task #161)**: `backend/bom.py` augments canonical Asset records at runtime with an installed-component list (NSN + slot + serviceable state) derived from `dataset/data/equipment_profiles.json`. Core fault parts (the lead NSN of each fault block) are installed on every hull; sub-variant optional parts are present on ~80% of hulls keyed deterministically by `sha256(asset_id|nsn)`, so two JLTVs of different sub-variants no longer report identical BOMs. The PULSE `/cannibalization` endpoint filters strippable donors via `asset_carries_nsn_serviceable(donor, recipient_nsn, donor_open_classes)` instead of the old equipment-type proxy, and surfaces a `slot` label (e.g. "Right rear hub assembly") on each donor card. The `/cannibalization/propose` endpoint applies the same gate so a hand-rolled POST cannot smuggle a logically impossible donor into the audit chain (rejects with `DonorBomMismatch`). Augmentation lives outside `dataset/` to honor the canonical-fixtures rule.
- **Dynamic Features**: Includes a live-demo failsafe, in-app pitch deck, and identity switching capabilities.

### System Design Choices
- **Development Environment**: Frontend (Vite dev server on `0.0.0.0:5000`) proxies API requests to Backend (FastAPI on `127.0.0.1:8000`).
- **Production Deployment**: `uvicorn backend.main:app --host 0.0.0.0 --port 5000` serves the frontend from `/` and API from `/api/*`. Deployment is via a single Docker container.
- **CORS Configuration**: Widened for Replit's proxied iframe origin.
- **Single Source of Truth**: Backend serves as the authoritative source for authentication, classification, and scenario state.
- **Modularity**: Designed with clear modules for classification, scenario management, and distinct functionalities.
- **Determinism**: Canonical seeded dataset ensures consistent content across boots, with deterministic runtime artifacts.
- **Security**: Strict role-based gating, audit logging, and classification enforcement are central to the system's security posture.

## External Dependencies

- **Vite**: Frontend build tool.
- **Tailwind CSS**: Utility-first CSS framework.
- **MapLibre**: Open-source library for interactive maps.
- **Recharts**: Composable React charting library.
- **Zustand**: State-management solution.
- **React Router**: Declarative routing for React.
- **Uvicorn**: ASGI server for FastAPI.
- **GCSS-MC**: External logistics system (reference implementation).
- **OMS-UCI**: External system for Joint COP export.
- **MIL-STD-6016 (Link 16)**: External standard for Joint COP export.
- **Gemma 4 26B FP8**: Self-hosted LLM model (`copilot-llm`).
- **Thornveil proprietary**: Proprietary model (`thermalhawk-detector`).
