import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import Dashboard from "./pages/dashboard";
import UnitsList from "./pages/units/index";
import NewUnit from "./pages/units/new";
import StandaloneCalculator from "./pages/calculator";
import SyncScreen from "./pages/sync";
import UnitDetail from "./pages/units/[id]";

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
      <Route path="/units/:id" component={UnitDetail} />
      <Route path="/calculator" component={StandaloneCalculator} />
      <Route path="/sync" component={SyncScreen} />
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
