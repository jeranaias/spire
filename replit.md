# SPIRE — Replit Environment

## Overview

SPIRE (Sanitization, Prediction, Intelligence, Readiness Engine) is a contested-logistics operating system designed to provide sanitization, prediction, intelligence, and readiness capabilities, originally built for USMC pilots. The project aims to offer a robust operating system for contested logistics environments.

Key capabilities include:
- Generating synthetic canonical datasets.
- Serving a REST API.
- Providing a dynamic frontend for user interaction.
- Implementing a comprehensive authentication system with role-based access control.
- Managing classification and export controls for sensitive data.
- Integrating with external logistics systems (GCSS-MC, OMS-UCI, MIL-STD-6016).
- Simulating various communication states for disaster preparedness drills.
- Maintaining a model registry for AI/ML supply chain transparency.
- Offering a "Decision Bridge" dashboard for critical decision-making.
- Supporting scenario-based vignettes for training and demonstration purposes.
- Providing an in-app pitch deck and live-demo failsafe mechanisms for presentations.

## User Preferences

- I want iterative development.
- I prefer clear and concise communication.
- Ask before making major changes.
- Do not make changes to the folder `dataset/`.
- Do not make changes to the file `backend/auth.MOCK_USERS`.

## System Architecture

The SPIRE application is built with a clear separation between its backend and frontend components, designed for scalability and maintainability.

### UI/UX Decisions
- **Frontend Framework**: React 19 with Vite 8 and TypeScript.
- **Styling**: Tailwind 4 for utility-first CSS.
- **Mapping**: MapLibre for geographical data visualization.
- **Charting**: Recharts for data representation.
- **State Management**: Zustand for reactive state management.
- **Routing**: React Router for navigation.
- **Authentication UI**: CAC cert-selection splash at `/#/auth` with mocked Marine roles.
- **TopBar**: Features identity pill, role badge, sign-out, and specific operational indicators like `GcssMcSyncPill` and `MissionClock`.
- **Classification Display**: `ClassificationBadge.tsx` for visual representation of data classification levels.
- **Joint COP Preview**: Faux Navy/Joint "JLTC" shell (`JointPreviewView`) with a distinct steel-blue palette and fouled-anchor mark.
- **Decision Bridge**: 6x2 grid layout designed to fit without vertical scroll at 1920x1080 resolution.

### Technical Implementations
- **Backend Framework**: FastAPI (Python 3.12) for high-performance API services.
- **Dataset Generation**: Synthetic canonical dataset generated at boot by the `dataset/` engine.
- **Authentication**: HMAC-SHA256-signed `HttpOnly` `SameSite=Lax` cookie (`spire_session`, 12h TTL) for session management. Role-based access control derived from signed-in cert with server-side validation using `request.state.user.role`.
- **Classification Enforcement**: Server-side gates in `backend/scoping.py` (`require_clearance`, `require_no_downgrade`) ensuring data integrity and access control. Classification stamps applied to all exported artifacts and HTTP headers.
- **Integrations Contract Pages**: Reference implementation (`IntegrationsView.tsx`) detailing field mapping, polling cadence, auth, ATO posture, and failure modes for GCSS-MC.
- **Mission Clock and Scenario Timeline**: Process-wide singleton managing `running`, `rate`, anchor wall-clock, and an event registry. Decoupled from real wall time (1 wall-second = 1 scenario-minute at 1x).
- **Reset-to-Clean-Demo**: Server-side endpoint (`POST /api/system/admin/reset-demo`) to return SPIRE to a known t=0 state without regenerating the full dataset, preserving determinism.
- **Audit Logging**: Hash-chained SQLite audit table (`backend/persistence.py`) with a Security-Manager-only SOC-shaped view (`AuditView.tsx`) featuring filters, pagination, and export.
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
- **PULSE Risk Board Drafts**: The Risk Board "Draft Action" CTA persists candidate actions to a real `pulse_drafts` SQLite table via `POST /api/pulse/draft-action` (writes a `pulse_draft_action` row to the hash-chained audit log). A `DraftsBadge` in `TopBar.tsx` (between `PushToJointButton` and `IdentityPill`, scoped to maintenance_chief / g4 / mef_commander) polls `GET /api/pulse/drafts` every 15 s and re-fetches on the `draftsRefreshTick` store nonce; its popover lists held drafts and dismisses via `POST /api/pulse/drafts/{id}/dismiss` (also audit-logged). Toast copy ("…held in Drafts (DRAFT-…)") is honest about the absence of an approval workflow — no more "awaiting approval" claims.

### System Design Choices
- **Development Environment Setup**: Frontend (Vite dev server) listens on `0.0.0.0:5000` and proxies `/api/*` to the backend. Backend (FastAPI) listens on `127.0.0.1:8000`. Two Replit workflows run side by side: `Frontend` (webview, port 5000) and `Backend` (console, port 8000). `vite.config.ts` already sets `server.allowedHosts: true` so the proxied iframe origin is trusted.
- **Production / Deploy**: `vm` deployment target; build step runs `npm install && npm run build` inside `frontend/`, and the run command starts `uvicorn backend.main:app --host 0.0.0.0 --port 5000` — FastAPI then serves `frontend/dist/` from `/` and the API from `/api/*` on the same origin.
- **CORS Configuration**: Widened (`allow_origin_regex=".*"`, `allow_credentials=False`) for Replit's proxied iframe origin.
- **Single Source of Truth**: Backend serves as the truth source for authentication, classification, and scenario state.
- **Modularity**: Design system primitives for classification, dedicated modules for scenario management, and separate routes for different functionalities.
- **Determinism**: Canonical seeded dataset ensures bit-identical content across boots; runtime artifacts are deterministic in structure but anchored to the H+0 pin moment.
- **Security**: Strict role-based gating for sensitive actions and views, audit logging for all critical operations, and classification enforcement for data handling.

## External Dependencies

- **Vite**: Frontend build tool.
- **Tailwind CSS**: Utility-first CSS framework.
- **MapLibre**: Open-source library for interactive maps.
- **Recharts**: Composable charting library built with React.
- **Zustand**: Small, fast, and scalable bearbones state-management solution.
- **React Router**: Declarative routing for React.
- **Uvicorn**: ASGI server for FastAPI.
- **GCSS-MC**: External logistics system integrated for data exchange (reference implementation only).
- **OMS-UCI**: External system for Joint COP export.
- **MIL-STD-6016 (Link 16)**: External standard for Joint COP export.
- **Gemma 4 26B FP8**: Self-hosted LLM model (`copilot-llm`) as part of the model registry.
- **Thornveil proprietary**: Proprietary model (`thermalhawk-detector`) listed in the model registry.