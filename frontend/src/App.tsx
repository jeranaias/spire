import { useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { TopBar } from "./components/TopBar";
import { StatusFooter } from "./components/StatusFooter";
import { StatusStrip } from "./components/StatusStrip";
import { ClassificationBand } from "./components/ClassificationBand";
import { ToastLane } from "./components/ToastLane";
import { NarrationOverlay } from "./components/NarrationOverlay";
import { ScenarioPlayerHost } from "./components/ScenarioPlayerHost";
import { FeedbackDrawer } from "./components/FeedbackDrawer";
import { HelpOverlay } from "./components/HelpOverlay";
import { Spiro } from "./components/Spiro";
import { Onboarding } from "./components/Onboarding";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FailsafePlayer } from "./components/FailsafePlayer";
import { useFailsafe } from "./state/failsafe";
import { ROLE_DEFAULT_VIEW, useSpireStore, VIEW_SCOPE } from "./state/store";

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
        switch (e.key.toLowerCase()) {
          case "s": go("/sentry"); break;
          case "p": go("/pulse"); break;
          case "b": go("/bastion"); break;
          case "a": go("/admin"); break;
          // 'g f' opens the feedback drawer. Dispatched as a window event
          // so FeedbackDrawer can listen without duplicating the chord
          // window state. Walkthrough audit: prior shortcut was Shift+F
          // which fires every time you type a capital F.
          case "f":
            window.dispatchEvent(new CustomEvent("spire:open-feedback"));
            break;
        }
        armed = false;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav, role]);
}

// W2 Task #39 — F9 hotkey to summon the live-demo failsafe recording.
// Confined to /demo and /pitch so an operator on BASTION never trips it.
// We always confirm before activating (the failsafe overrides the live
// surface and judges should never see it unless the live demo died).
function useFailsafeHotkey() {
  const loc = useLocation();
  const openFullscreen = useFailsafe((s) => s.openFullscreen);
  const mode = useFailsafe((s) => s.mode);

  useEffect(() => {
    const presenterRoute =
      loc.pathname === "/demo" ||
      loc.pathname === "/pitch" ||
      loc.pathname.startsWith("/demo/") ||
      loc.pathname.startsWith("/pitch/");
    if (!presenterRoute) return;

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
  }, [loc.pathname, mode, openFullscreen]);
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

  return (
    <div className="flex h-full flex-col overflow-x-hidden">
      {/* WCAG 2.4.1 Bypass Blocks — first focusable element on the page.
       * Hidden until focused; jumps past the chrome (TopBar, banner,
       * status strip) straight to the active view. */}
      <a href="#main" className="sr-only sr-only-focusable">
        Skip to main content
      </a>
      <TopBar />
      <ClassificationBand />
      <StatusStrip />
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
      <ToastLane />
      {/* W2 Task #37 — scripted scenario player. Host is render-less
       * (timer + nav + hotkeys); the overlay is the operator-facing
       * narration strip pinned to the bottom of the viewport. Both
       * mounted at the shell so they survive route changes. */}
      <ScenarioPlayerHost />
      <NarrationOverlay />
      <FeedbackDrawer />
      <HelpOverlay />
      <Spiro />
      <Onboarding />
      {/* W2 Task #39 — recorded-backup overlay. Renders nothing until the
       * presenter opens it (via the Failsafe button on /demo or /pitch,
       * or the F9 hotkey). Mounted at the shell so it covers any view. */}
      <FailsafePlayer />
    </div>
  );
}
