import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { TopBar } from "./components/TopBar";
import { StatusFooter } from "./components/StatusFooter";
import { StatusStrip } from "./components/StatusStrip";
import { ClassificationBannerStrip } from "./components/ClassificationBannerStrip";
import { ToastLane } from "./components/ToastLane";
import { NarrationOverlay } from "./components/NarrationOverlay";
import { ScenarioPlayerHost } from "./components/ScenarioPlayerHost";
import { ScenarioSyncBanner } from "./components/ScenarioSyncBanner";
import { FeedbackDrawer } from "./components/FeedbackDrawer";
import { HelpOverlay } from "./components/HelpOverlay";
import { Spiro } from "./components/Spiro";
import { Onboarding } from "./components/Onboarding";
import { DemoOnly } from "./state/buildMode";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FailsafePlayer } from "./components/FailsafePlayer";
import { useFailsafe } from "./state/failsafe";
import { useScenarioPlayer } from "./state/scenarioPlayer";
import { ROLE_DEFAULT_VIEW, useSpireStore, VIEW_SCOPE } from "./state/store";
import { api } from "./api";

// Vimium-style two-key chord routing. `g s` → SENTRY, `g p` → PULSE,
// `g b` → BASTION, `g a` → ADMIN. Chord window is 1500ms — operators on
// keyboards expect a beat between presses, but anything longer feels
// non-responsive. Routes that the active role can't see are skipped
// silently rather than throwing the operator into an InsufficientPrivilege
// wall via shortcut.
function useGoToShortcuts() {
  const nav = useNavigate();
  const role = useSpireStore((s) => s.role);

  useEffect(() => {
    let armed = false;
    let armedAt = 0;
    const CHORD_WINDOW_MS = 1500;

    function inField(target: EventTarget | null): boolean {
      return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      );
    }

    function go(view: string) {
      // Mirror TopBar nav semantics — if the current role can't see the
      // view, fall back to its default landing surface so we don't bounce
      // them off InsufficientPrivilege. ADMIN is special-cased: only
      // security_manager has it.
      if (view === "/admin") {
        if (role !== "security_manager") return;
        nav("/admin");
        return;
      }
      const allowed = (VIEW_SCOPE[view] ?? []).includes(role);
      if (!allowed) {
        nav(ROLE_DEFAULT_VIEW[role] ?? "/bastion");
        return;
      }
      nav(view);
    }

    function onKey(e: KeyboardEvent) {
      if (inField(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const now = performance.now();
      if (armed && now - armedAt > CHORD_WINDOW_MS) armed = false;

      if (!armed && (e.key === "g" || e.key === "G")) {
        armed = true;
        armedAt = now;
        return;
      }
      if (armed) {
        // Code review (#36/#37 deconfliction): once a chord consumes a key,
        // call preventDefault() so downstream window listeners (BastionView
        // 'F' Focus Mode, MapCanvas 'P' pitch toggle, ScenarioPlayerHost
        // 'P' play/pause) can bail on e.defaultPrevented. Without this a
        // single 'g f' keypress would both open the feedback drawer AND
        // toggle Bastion focus mode — a stage footgun.
        let consumed = true;
        switch (e.key.toLowerCase()) {
          case "s": go("/sentry"); break;
          case "p": go("/pulse"); break;
          case "b": go("/bastion"); break;
          case "a": go("/admin"); break;
          // MDM 2026 stage-pivot — `g d` jumps to the DHA RESCUE
          // hero surface. Always allowed (the route has no scope guard).
          case "d": nav("/dha-rescue"); break;
          // 'g f' opens the feedback drawer. Dispatched as a window event
          // so FeedbackDrawer can listen without duplicating the chord
          // window state. Walkthrough audit: prior shortcut was Shift+F
          // which fires every time you type a capital F.
          case "f":
            window.dispatchEvent(new CustomEvent("spire:open-feedback"));
            break;
          default:
            consumed = false;
        }
        if (consumed) e.preventDefault();
        armed = false;
      }
    }
    // Code review: register in CAPTURE phase so the chord handler always
    // fires before view-level bubble-phase listeners (BastionView 'F',
    // MapCanvas 'P'). Without this the [nav, role] dep can re-run on
    // route/role change and re-attach behind the view listeners, breaking
    // the e.defaultPrevented contract those listeners rely on.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [nav, role]);
}

// W2 Task #39 — F9 hotkey to summon the live-demo failsafe recording.
//
// Task #48 (F-01): the prior gate keyed off `loc.pathname === "/demo" ||
// "/pitch"`, which meant the moment the presenter pressed Play and the
// scenario player navigated them out to /bastion (or /sentry, /pulse,
// etc.) the F9 hotkey was no longer attached. That's exactly the window
// where the failsafe is most needed — mid-run, on a module surface, with
// the live demo hung.
//
// New gate: the hotkey is armed whenever a scenario is *loaded* in the
// scenario player (`scenarioId !== null`), regardless of route. That
// covers every state from "on /demo with the cockpit open and a scenario
// picked" through "deep into the third beat on /pulse". An operator who
// never opens /demo (working on BASTION normally) still won't have F9
// bound, so it can't be tripped accidentally during day-to-day use.
//
// We always confirm before activating (the failsafe overrides the live
// surface and judges should never see it unless the live demo died).
// Shift+F8 stage failsafe — restores the seed-42 baseline. F8 alone
// can mean "debugger pause" in some browsers, so the hotkey requires
// shift; ctrl/alt/meta combinations bypass it for browser-shortcut
// safety. Fires in the capture phase so view-level keydown listeners
// can't shadow it.
function useStageResetHotkey() {
  const pushToast = useSpireStore((s) => s.pushToast);
  useEffect(() => {
    function inField(target: EventTarget | null): boolean {
      return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      );
    }
    async function onKey(e: KeyboardEvent) {
      // Hard match: Shift+F8 only. Don't fire on F8 alone (some
      // browsers map F8 to a debugger pause) and don't fire on
      // Ctrl/Alt/Meta combos (those are reserved for browser
      // shortcuts on most platforms).
      if (e.key !== "F8" || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      if (inField(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        await api.system.resetDemo();
        pushToast({
          tone: "ok",
          text: "Failsafe — restored seed-42 baseline.",
          ttlMs: 4000,
        });
        // Refresh the active surface in place. The dataset-status
        // poll (5s) will tick downstream views off their empty-state
        // placeholders; broadcasting an explicit reset event lets
        // surfaces opt in to an immediate refetch without a route
        // change that would yank the operator out of context.
        try {
          window.dispatchEvent(new CustomEvent("spire:dataset-reset"));
        } catch { /* tolerant */ }
      } catch (err) {
        pushToast({
          tone: "error",
          text: `Failsafe reset failed: ${err instanceof Error ? err.message : String(err)}`,
          ttlMs: 6000,
        });
      }
    }
    // Capture phase so we beat any view-level keydown handlers.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pushToast]);
}

function useFailsafeHotkey() {
  // We intentionally subscribe to `scenarioId` (not `status`) so the
  // hotkey stays armed across the full lifecycle — ready / playing /
  // paused / complete — without the effect tearing down between
  // beat-status transitions.
  const scenarioLoaded = useScenarioPlayer((s) => s.scenarioId !== null);
  const openFullscreen = useFailsafe((s) => s.openFullscreen);
  const mode = useFailsafe((s) => s.mode);
  // MDM 2026 stage-pivot — when the operator session is in stage mode
  // (the on-stage demo cockpit) the F9 failsafe must be reachable from
  // any route, not just /demo and /pitch. The surrounding stage flow
  // navigates SENTRY/PULSE/BASTION/DHA RESCUE, and the presenter still
  // needs the recorded backup as a single keystroke escape hatch.
  const stageMode = useSpireStore((s) => s.stageMode);

  useEffect(() => {
    // Failsafe hotkey is armed whenever a presenter context is active:
    // a scenario is loaded, the operator session is in MDM 2026 stage
    // mode, or the route is one of the dedicated presenter surfaces
    // (/demo, /pitch). Any of these means F9 should reach the recorded
    // backup with one keystroke.
    const path = window.location.pathname;
    const presenterRoute =
      path === "/demo" ||
      path === "/pitch" ||
      path.startsWith("/demo/") ||
      path.startsWith("/pitch/");
    if (!scenarioLoaded && !stageMode && !presenterRoute) return;

    function inField(target: EventTarget | null): boolean {
      return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      );
    }

    function onKey(e: KeyboardEvent) {
      if (e.key !== "F9") return;
      if (inField(e.target)) return;
      // If failsafe is already on screen, the hotkey is a no-op — the
      // overlay's own Esc handler is the way out.
      if (mode !== "off") return;
      e.preventDefault();
      // Synchronous confirm — same pattern DangerButton/modal uses for
      // truly destructive actions. Keystroke confirms and the presenter
      // doesn't have to chase a button mid-pitch.
      const ok = window.confirm(
        "Activate failsafe? The recorded backup will replace the live demo. Press OK only if the live demo has failed.",
      );
      if (ok) openFullscreen();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scenarioLoaded, stageMode, mode, openFullscreen]);
}

export default function App() {
  // Track-G3 — reflect density onto <html data-density="..."> so the CSS
  // variable rotation in index.css applies across every view + portal.
  const density = useSpireStore((s) => s.density);
  useEffect(() => {
    document.documentElement.setAttribute("data-density", density);
    return () => {
      // Don't yank the attribute on unmount — App is the root component;
      // unmount only happens during dev-HMR full reloads.
    };
  }, [density]);

  useGoToShortcuts();
  useFailsafeHotkey();
  useStageResetHotkey();

  // Decision Bridge already shows MC%, FPCON, comms, and alert counts in
  // its tile grid — duplicating them in the StatusStrip above pushes the
  // tiles down and makes the page look busy without adding signal. Skip
  // the strip on `/` and let the bridge be the at-a-glance surface it's
  // designed to be. Every other route still gets the strip.
  const location = useLocation();
  const showStatusStrip = location.pathname !== "/";

  return (
    <div className="flex h-full flex-col overflow-x-hidden">
      {/* WCAG 2.4.1 Bypass Blocks — first focusable element on the page.
       * Hidden until focused; jumps past the chrome (TopBar, banner,
       * status strip) straight to the active view. */}
      <a href="#main" className="sr-only sr-only-focusable">
        Skip to main content
      </a>
      {/* W2 Task #28 — DoDM 5200.01-V2 page-level marking. Top strip
       * carries the FPCON badge (session state); bottom strip is the
       * plain marking band so a screenshot escaping its chrome still
       * shows the disclaimer top + bottom. */}
      <ClassificationBannerStrip position="top" showFpcon />
      <TopBar />
      {showStatusStrip && <StatusStrip />}
      <main
        id="main"
        role="main"
        // tabIndex=-1 so the skip link can move focus into the landmark
        // without giving it Tab-cycle membership.
        tabIndex={-1}
        className="min-w-0 flex-1 overflow-hidden focus:outline-none"
      >
        {/* View-scoped boundary — keeps TopBar / role switcher / banner
         * alive when a view crashes (e.g. stale chunk 503). Reviewer
         * caught the prior single outer boundary blanking the whole
         * app, contradicting the "rest of SPIRE is unaffected" copy. */}
        <ErrorBoundary scope="view">
          <Outlet />
        </ErrorBoundary>
      </main>
      <StatusFooter />
      {/* W2 Task #28 — bottom marking band. Plain (no FPCON) so it
       * stays legible under any density / marquee scroll. */}
      <ClassificationBannerStrip position="bottom" />
      <ToastLane />
      {/* W2 Task #37 — scripted scenario player. Host is render-less
       * (timer + nav + hotkeys); the overlay is the operator-facing
       * narration strip pinned to the bottom of the viewport. Both
       * mounted at the shell so they survive route changes. */}
      <ScenarioPlayerHost />
      <ScenarioSyncBanner />
      <NarrationOverlay />
      <FeedbackDrawer />
      <HelpOverlay />
      <Spiro />
      {/* Onboarding is the hackathon "judge-facing 60-second intro" —
       * customer/problem/four-views/CTA pitch deck baked into a modal.
       * Demo nights need it, pilots don't. The pilot welcome flow is
       * the StageIngestHero on the Bridge (drag in 3 GCSS-MC CSVs)
       * which happens once on first boot anyway. */}
      <DemoOnly>
        <Onboarding />
      </DemoOnly>
      {/* W2 Task #39 — recorded-backup overlay. Renders nothing until the
       * presenter opens it (via the Failsafe button on /demo or /pitch,
       * or the F9 hotkey). Mounted at the shell so it covers any view. */}
      <FailsafePlayer />
      {/* Build-mode watermark — pinned to the corner so screenshots and
       * recordings unambiguously show whether they were captured against
       * a demo or operational build. Sits behind interactive chrome
       * (z=20) and below the classification bands (z=60+) so it never
       * intercepts clicks or hides marking. Only renders in demo. */}
      <DemoOnly>
        <div
          aria-hidden
          className="pointer-events-none fixed bottom-2 right-2 z-20 select-none rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)]/70 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]"
          title="This build was started with VITE_SPIRE_BUILD=demo. Operational deployments do not show this watermark."
        >
          DEMO BUILD
        </div>
      </DemoOnly>
    </div>
  );
}
