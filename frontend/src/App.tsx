import { Outlet } from "react-router-dom";
import { TopBar } from "./components/TopBar";
import { StatusFooter } from "./components/StatusFooter";
import { ClassificationBand } from "./components/ClassificationBand";
import { ToastLane } from "./components/ToastLane";
import { FeedbackDrawer } from "./components/FeedbackDrawer";
import { HelpOverlay } from "./components/HelpOverlay";

export default function App() {
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
    </div>
  );
}
