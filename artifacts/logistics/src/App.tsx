import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import Dashboard from "./pages/dashboard";
import UnitsList from "./pages/units/index";
import NewUnit from "./pages/units/new";
import EditUnit from "./pages/units/edit";
import StandaloneCalculator from "./pages/calculator";
import SyncScreen from "./pages/sync";
import SpirePrsPage from "./pages/spire-prs";
import UnitDetail from "./pages/units/[id]";
import UnitSnapshot from "./pages/units/[id].snapshot";
import CommsDeniedPlan from "./pages/units/[id].comms-denied";
import ClassDetailPage from "./pages/classes/[supplyClass]";
import CatalogManagement from "./pages/catalog";
import WeaponSystemsAdmin from "./pages/weapon-systems";
import ScheduleDetailPage from "./pages/schedules/[scheduleId]";
import SharedSchedulePage from "./pages/schedules/share";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 1000 * 60 * 60 * 24, // 24h
      staleTime: 1000 * 60 * 5, // 5m
      networkMode: "offlineFirst",
      refetchOnWindowFocus: true,
    },
    mutations: {
      networkMode: "offlineFirst",
    }
  }
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/units" component={UnitsList} />
      <Route path="/units/new" component={NewUnit} />
      <Route path="/units/:id/edit" component={EditUnit} />
      <Route path="/units/:id/snapshot" component={UnitSnapshot} />
      <Route path="/units/:id/comms-denied" component={CommsDeniedPlan} />
      <Route path="/units/:id" component={UnitDetail} />
      <Route path="/classes/:supplyClass" component={ClassDetailPage} />
      <Route path="/calculator" component={StandaloneCalculator} />
      <Route path="/catalog" component={CatalogManagement} />
      <Route path="/weapon-systems" component={WeaponSystemsAdmin} />
      <Route path="/sync" component={SyncScreen} />
      <Route path="/spire-prs" component={SpirePrsPage} />
      <Route path="/schedules/:scheduleId" component={ScheduleDetailPage} />
      <Route path="/s/:shareToken" component={SharedSchedulePage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
