import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import { TopBar } from "./components/TopBar";
import { StatusFooter } from "./components/StatusFooter";
import { ClassificationBand } from "./components/ClassificationBand";
import { ToastLane } from "./components/ToastLane";
import { FeedbackDrawer } from "./components/FeedbackDrawer";
import { HelpOverlay } from "./components/HelpOverlay";
import { Aide } from "./components/Aide";
import { useSpireStore } from "./state/store";

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

  return (
    <div className="flex h-full flex-col overflow-x-hidden">
      <TopBar />
      <ClassificationBand />
      <main className="min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
      <StatusFooter />
      <ToastLane />
      <FeedbackDrawer />
      <HelpOverlay />
      <Aide />
    </div>
  );
}
