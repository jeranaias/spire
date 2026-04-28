import { Title } from "@/components/title";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useGetSyncStatus,
  useTriggerSync,
  useGetSyncOutbox,
  useGetSyncLastRun,
  useGetSyncRuns,
  useDismissOutboxRecord,
  useRetryOutboxRecord,
  useUpdateSyncSettings,
  getGetSyncStatusQueryKey,
  getGetSyncOutboxQueryKey,
  getGetSyncLastRunQueryKey,
  getGetSyncRunsQueryKey,
} from "@workspace/api-client-react";
import type { SyncRunSummary, SyncPushResult } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  ArrowDownUp,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Globe,
  History,
  Inbox,
  BookOpen,
  RefreshCw,
  Server,
  WifiOff,
  XCircle,
  Trash2,
  RotateCcw,
  Timer,
} from "lucide-react";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { format, formatDistanceToNow, addMinutes } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Fragment, useState } from "react";

export default function SyncScreen() {
  const isOnline = useOnlineStatus();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const { data: status, isLoading } = useGetSyncStatus({
    query: { queryKey: ["syncStatus"], refetchInterval: 10000 },
  });

  const { data: outbox, refetch: refetchOutbox } = useGetSyncOutbox({
    query: { queryKey: ["syncOutbox"], refetchInterval: 10000 },
  });

  const { data: lastRun, refetch: refetchLastRun } = useGetSyncLastRun({
    query: { queryKey: ["syncLastRun"] },
  });

  const { data: syncRuns, refetch: refetchRuns } = useGetSyncRuns({
    query: { queryKey: ["syncRuns"] },
  });

  const triggerSync = useTriggerSync();
  const dismissOutbox = useDismissOutboxRecord();
  const retryOutbox = useRetryOutboxRecord();

  const handleDismiss = async (id: string) => {
    try {
      await dismissOutbox.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getGetSyncOutboxQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetSyncStatusQueryKey() });
      refetchOutbox();
      toast({ title: "Record dismissed", description: "Outbox record permanently removed." });
    } catch {
      toast({ title: "Dismiss failed", description: "Could not remove the record.", variant: "destructive" });
    }
  };

  const handleRetry = async (id: string) => {
    try {
      await retryOutbox.mutateAsync({ id });
      queryClient.invalidateQueries({ queryKey: getGetSyncOutboxQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetSyncStatusQueryKey() });
      refetchOutbox();
      toast({ title: "Queued for retry", description: "Record moved back to pending queue." });
    } catch {
      toast({ title: "Retry failed", description: "Could not queue the record for retry.", variant: "destructive" });
    }
  };
  const updateSettings = useUpdateSyncSettings();

  const handleSync = async () => {
    if (!isOnline) {
      toast({
        title: "Offline",
        description: "Cannot sync while offline",
        variant: "destructive",
      });
      return;
    }
    try {
      await triggerSync.mutateAsync();
      queryClient.invalidateQueries({ queryKey: getGetSyncStatusQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetSyncOutboxQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetSyncLastRunQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetSyncRunsQueryKey() });
      refetchOutbox();
      refetchLastRun();
      refetchRuns();
      toast({
        title: "SPIRE Sync Complete",
        description: "Records pushed to SPIRE Master Data Management.",
      });
    } catch {
      toast({
        title: "Sync failed",
        description: "Error communicating with SPIRE.",
        variant: "destructive",
      });
    }
  };

  const allOutbox = outbox ?? [];
  const pendingOutbox = allOutbox.filter((item) => item.status === "pending");
  const failedOutbox = allOutbox.filter((item) => item.status === "failed");

  const handleAutoSyncToggle = async (enabled: boolean) => {
    try {
      await updateSettings.mutateAsync({ data: { autoSyncEnabled: enabled } });
      queryClient.invalidateQueries({ queryKey: getGetSyncStatusQueryKey() });
      toast({
        title: enabled ? "Auto-Sync Enabled" : "Auto-Sync Disabled",
        description: enabled
          ? `SPIRE will sync automatically every ${status?.autoSyncIntervalMinutes ?? 5} minutes.`
          : "Auto-sync paused. Use Sync Now to push changes manually.",
      });
    } catch {
      toast({
        title: "Settings update failed",
        description: "Could not update auto-sync setting.",
        variant: "destructive",
      });
    }
  };

  const autoSyncEnabled = status?.autoSyncEnabled ?? true;
  const autoSyncIntervalMinutes = status?.autoSyncIntervalMinutes ?? 5;

  const nextSyncAt =
    autoSyncEnabled && status?.lastSyncAt
      ? addMinutes(new Date(status.lastSyncAt), autoSyncIntervalMinutes)
      : null;
  const lastRunResults = (lastRun?.results as SyncPushResult[]) ?? [];
  const runs: SyncRunSummary[] = syncRuns ?? [];

  return (
    <Layout>
      <Title title="SPIRE Synchronization" />

      <PageHeader
        title="SPIRE Sync"
        tag="Comms"
        subtitle="SPIRE Master Data Management"
        right={
          <Button
            onClick={handleSync}
            disabled={!isOnline || triggerSync.isPending || isLoading}
            className="font-mono uppercase text-xs tracking-widest"
            variant={
              allOutbox.length > 0 ? "default" : "secondary"
            }
          >
            <RefreshCw
              className={`w-3.5 h-3.5 mr-2 ${triggerSync.isPending ? "animate-spin" : ""}`}
            />
            {triggerSync.isPending ? "Syncing..." : "Sync Now"}
          </Button>
        }
      />

      <Card className="border-border mb-6">
        <CardHeader className="border-b border-border pb-3 pt-4 px-4">
          <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
            <Globe className="w-3.5 h-3.5 text-primary" /> Connection State
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          <div className="flex flex-col md:flex-row gap-8 items-center">
            <div className="flex-1 flex flex-col items-center justify-center text-center">
              <div className="w-14 h-14 rounded-sm bg-primary/10 border border-primary/20 flex items-center justify-center mb-3 text-primary">
                <Server className="w-6 h-6" />
              </div>
              <div className="font-mono font-bold text-xs tracking-widest uppercase">
                Local Cache
              </div>
              <div className="text-[10px] font-mono text-muted-foreground mt-1 tracking-wide">
                Read/Write Active
              </div>
            </div>

            <div className="flex flex-col items-center justify-center px-4 w-full md:w-auto">
              <ArrowDownUp className="w-4 h-4 text-muted-foreground mb-2" />
              <div
                className={`h-px w-full md:w-24 ${isOnline ? "bg-primary" : "bg-destructive"}`}
              />
              <div
                className={`text-[10px] font-mono mt-2 font-bold tracking-widest ${isOnline ? "text-primary" : "text-destructive"}`}
              >
                {isOnline ? "■ CONNECTED" : "◆ DISCONNECTED"}
              </div>
            </div>

            <div className="flex-1 flex flex-col items-center justify-center text-center">
              <div
                className={`w-14 h-14 rounded-sm border flex items-center justify-center mb-3 ${isOnline ? "bg-card border-border text-foreground" : "bg-muted/30 border-border/30 text-muted-foreground"}`}
              >
                {isOnline ? (
                  <Database className="w-6 h-6" />
                ) : (
                  <WifiOff className="w-6 h-6" />
                )}
              </div>
              <div className="font-mono font-bold text-xs tracking-widest uppercase">
                {status?.upstreamSystem || "SPIRE"}
              </div>
              <div className="text-[10px] font-mono text-muted-foreground mt-1 tracking-wide">
                Master Data Management
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 pt-6 border-t border-border">
            <div>
              <div className="text-[10px] font-mono text-muted-foreground mb-1 uppercase tracking-widest">
                Pending Changes
              </div>
              <div
                className={`font-mono font-bold text-xl tabular-nums ${failedOutbox.length > 0 ? "text-destructive" : pendingOutbox.length > 0 ? "text-warning" : "text-success"}`}
              >
                {allOutbox.length}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-muted-foreground mb-1 uppercase tracking-widest">
                Last Sync
              </div>
              <div className="font-mono font-bold text-sm mt-1 tabular-nums">
                {status?.lastSyncAt
                  ? format(new Date(status.lastSyncAt), "HHmm'Z' dd MMM")
                  : "NEVER"}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-muted-foreground mb-1 uppercase tracking-widest">
                Latency
              </div>
              <div className="font-mono font-bold text-sm mt-1 tabular-nums">
                {status?.latencyMs ? `${status.latencyMs}ms` : "—"}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-mono text-muted-foreground mb-1 uppercase tracking-widest">
                Auto-Sync
              </div>
              <div className="flex items-center gap-2 mt-1">
                <Switch
                  checked={autoSyncEnabled}
                  onCheckedChange={handleAutoSyncToggle}
                  disabled={updateSettings.isPending || isLoading}
                  className="scale-90"
                />
                <span
                  className={`font-mono font-bold text-xs tracking-widest ${autoSyncEnabled ? "text-success" : "text-muted-foreground"}`}
                >
                  {autoSyncEnabled ? "ON" : "OFF"}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border mb-6">
        <CardHeader className="border-b border-border pb-3 pt-4 px-4">
          <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
            <Timer className="w-3.5 h-3.5 text-primary" /> Auto-Sync Schedule
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4">
          <div className="flex flex-col md:flex-row md:items-center gap-6">
            <div className="flex items-center gap-4">
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-1 uppercase tracking-widest">
                  Status
                </div>
                <div
                  className={`font-mono font-bold text-sm ${autoSyncEnabled ? "text-success" : "text-muted-foreground"}`}
                >
                  {autoSyncEnabled ? "■ ACTIVE" : "◆ PAUSED"}
                </div>
              </div>
              <div className="h-8 w-px bg-border" />
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-1 uppercase tracking-widest">
                  Interval
                </div>
                <div className="font-mono font-bold text-sm tabular-nums">
                  {autoSyncIntervalMinutes} min
                </div>
              </div>
              <div className="h-8 w-px bg-border" />
              <div>
                <div className="text-[10px] font-mono text-muted-foreground mb-1 uppercase tracking-widest">
                  Next Run
                </div>
                <div className="font-mono font-bold text-sm tabular-nums">
                  {!autoSyncEnabled
                    ? "—"
                    : nextSyncAt
                    ? nextSyncAt < new Date()
                      ? "Imminent"
                      : formatDistanceToNow(nextSyncAt, { addSuffix: true })
                    : "—"}
                </div>
              </div>
              {nextSyncAt && autoSyncEnabled && (
                <>
                  <div className="h-8 w-px bg-border" />
                  <div>
                    <div className="text-[10px] font-mono text-muted-foreground mb-1 uppercase tracking-widest">
                      Scheduled At
                    </div>
                    <div className="font-mono font-bold text-sm tabular-nums">
                      {format(nextSyncAt, "HHmm'Z' dd MMM")}
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="md:ml-auto text-[10px] font-mono text-muted-foreground max-w-xs">
              {autoSyncEnabled
                ? `Auto-sync runs every ${autoSyncIntervalMinutes} minutes when pending outbox records exist. Toggle off to sync only on demand.`
                : "Auto-sync is paused. Press Sync Now to push changes manually, or toggle on to resume scheduled sync."}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-3 gap-6 mb-6">
        <Card className="border-border">
          <CardHeader className="border-b border-border pb-3 pt-4 px-4">
            <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
              <Inbox className="w-3.5 h-3.5 text-warning" /> Pending Outbox
              {failedOutbox.length > 0 && (
                <span className="ml-auto font-mono text-[10px] text-destructive bg-destructive/10 border border-destructive/20 px-1.5 py-0.5 rounded-sm">
                  {failedOutbox.length} FAILED
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border max-h-80 overflow-y-auto">
              {allOutbox.length === 0 ? (
                <div className="p-6 text-center text-muted-foreground font-mono text-xs tracking-wide">
                  No records pending.
                </div>
              ) : (
                <>
                  {failedOutbox.map((item) => (
                    <div key={item.id} className="p-3 bg-destructive/5 border-l-2 border-destructive">
                      <div className="flex gap-3 items-start">
                        <XCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-[10px] text-destructive uppercase tracking-widest">
                            {item.entityKind} · {item.op} · FAILED
                          </div>
                          <div className="font-mono text-xs mt-0.5 truncate">
                            {item.itemName ?? item.entityId}
                          </div>
                          {item.unitName && (
                            <div className="text-[10px] text-muted-foreground font-mono">
                              {item.unitName}
                            </div>
                          )}
                          {item.lastError && (
                            <div className="text-[10px] text-destructive font-mono mt-0.5 break-words">
                              {item.lastError}
                            </div>
                          )}
                          <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                            {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                          </div>
                          <div className="flex gap-2 mt-2">
                            <button
                              onClick={() => handleRetry(item.id)}
                              disabled={retryOutbox.isPending || dismissOutbox.isPending}
                              className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest px-2 py-1 rounded-sm bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20 disabled:opacity-50 transition-colors"
                            >
                              <RotateCcw className="w-2.5 h-2.5" />
                              Retry Now
                            </button>
                            <button
                              onClick={() => handleDismiss(item.id)}
                              disabled={retryOutbox.isPending || dismissOutbox.isPending}
                              className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest px-2 py-1 rounded-sm bg-muted/50 border border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 transition-colors"
                            >
                              <Trash2 className="w-2.5 h-2.5" />
                              Dismiss
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                  {pendingOutbox.map((item) => (
                    <div key={item.id} className="p-3 flex gap-3 items-start">
                      <div className="w-1.5 h-1.5 rounded-full bg-warning mt-1.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-[10px] text-warning uppercase tracking-widest">
                          {item.entityKind} · {item.op}
                        </div>
                        <div className="font-mono text-xs mt-0.5 truncate">
                          {item.itemName ?? item.entityId}
                        </div>
                        {item.unitName && (
                          <div className="text-[10px] text-muted-foreground font-mono">
                            {item.unitName}
                          </div>
                        )}
                        <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                          {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                        </div>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardHeader className="border-b border-border pb-3 pt-4 px-4">
            <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
              <RefreshCw className="w-3.5 h-3.5 text-primary" /> Last Sync Result
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border max-h-72 overflow-y-auto">
              {!lastRun ? (
                <div className="p-6 text-center text-muted-foreground font-mono text-xs tracking-wide">
                  No sync run yet.
                </div>
              ) : lastRunResults.length === 0 ? (
                <div className="p-6 text-center text-muted-foreground font-mono text-xs tracking-wide">
                  Nothing was pushed in the last run.
                </div>
              ) : (
                lastRunResults.map((r) => (
                  <div key={r.outboxId} className="p-3 flex gap-3 items-start">
                    {r.success ? (
                      <CheckCircle className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div
                        className={`font-mono text-[10px] uppercase tracking-widest ${r.success ? "text-success" : "text-destructive"}`}
                      >
                        {r.entityKind} · {r.success ? "pushed" : "failed"}
                      </div>
                      <div className="font-mono text-xs mt-0.5 truncate">
                        {r.itemName ?? r.entityId}
                      </div>
                      {r.unitName && (
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {r.unitName}
                        </div>
                      )}
                      {!r.success && r.error && (
                        <div className="text-[10px] text-destructive font-mono mt-0.5">
                          {r.error}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardHeader className="border-b border-border pb-3 pt-4 px-4">
            <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
              <BookOpen className="w-3.5 h-3.5 text-primary" /> Catalog Reconciliation
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6">
            {!lastRun ? (
              <div className="text-center text-muted-foreground font-mono text-xs tracking-wide">
                Run a sync to see catalog delta.
              </div>
            ) : (
              <>
                <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest mb-4">
                  SPIRE vs Local Catalog
                </div>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
                        Matched
                      </div>
                      <div className="font-mono text-xs text-muted-foreground mt-0.5">
                        Local = SPIRE
                      </div>
                    </div>
                    <div className="font-mono font-bold text-2xl text-success tabular-nums">
                      {lastRun.catalogMatched}
                    </div>
                  </div>
                  <div className="h-px bg-border" />
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
                        New in SPIRE
                      </div>
                      <div className="font-mono text-xs text-muted-foreground mt-0.5">
                        Not in local catalog
                      </div>
                    </div>
                    <div className="font-mono font-bold text-2xl text-warning tabular-nums">
                      {lastRun.catalogNew}
                    </div>
                  </div>
                  <div className="h-px bg-border" />
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
                        Changed
                      </div>
                      <div className="font-mono text-xs text-muted-foreground mt-0.5">
                        Name / NSN / rate differs
                      </div>
                    </div>
                    <div className="font-mono font-bold text-2xl text-destructive tabular-nums">
                      {lastRun.catalogChanged}
                    </div>
                  </div>
                </div>
                <div className="mt-4 pt-4 border-t border-border text-[10px] font-mono text-muted-foreground">
                  Read-only report — local catalog is not modified.
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="border-border mb-6">
        <CardHeader className="border-b border-border pb-3 pt-4 px-4">
          <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
            <History className="w-3.5 h-3.5 text-primary" /> Sync History
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground font-mono text-xs tracking-wide">
              No sync runs recorded yet. Trigger a sync to begin.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-[10px] uppercase tracking-widest">
                    <th className="text-left px-4 py-2 w-6"></th>
                    <th className="text-left px-4 py-2">Started</th>
                    <th className="text-right px-4 py-2">Pushed</th>
                    <th className="text-right px-4 py-2">Failed</th>
                    <th className="text-right px-4 py-2">+New</th>
                    <th className="text-right px-4 py-2">Changed</th>
                    <th className="text-right px-4 py-2">Matched</th>
                    <th className="text-right px-4 py-2">Latency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {runs.map((run) => {
                    const isExpanded = expandedRunId === run.id;
                    const results = (run.results as SyncPushResult[]) ?? [];
                    const hasFailed = run.failedCount > 0;
                    return (
                      <Fragment key={run.id}>
                        <tr
                          className="hover:bg-muted/30 cursor-pointer transition-colors"
                          onClick={() =>
                            setExpandedRunId(isExpanded ? null : run.id)
                          }
                        >
                          <td className="px-4 py-3 text-muted-foreground">
                            {isExpanded ? (
                              <ChevronDown className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5" />
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="tabular-nums">
                              {format(new Date(run.startedAt), "dd MMM HH:mm:ss")}
                            </div>
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              <Clock className="w-2.5 h-2.5 inline mr-1" />
                              {formatDistanceToNow(new Date(run.startedAt), {
                                addSuffix: true,
                              })}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-success">
                            {run.pushedCount}
                          </td>
                          <td
                            className={`px-4 py-3 text-right tabular-nums ${hasFailed ? "text-destructive font-bold" : "text-muted-foreground"}`}
                          >
                            {run.failedCount}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-warning">
                            {run.catalogNew > 0 ? `+${run.catalogNew}` : "—"}
                          </td>
                          <td
                            className={`px-4 py-3 text-right tabular-nums ${run.catalogChanged > 0 ? "text-destructive" : "text-muted-foreground"}`}
                          >
                            {run.catalogChanged > 0 ? run.catalogChanged : "—"}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                            {run.catalogMatched}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                            {run.latencyMs != null ? `${run.latencyMs}ms` : "—"}
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="bg-muted/20">
                            <td colSpan={8} className="px-4 pb-4 pt-2">
                              {results.length === 0 ? (
                                <div className="text-[10px] text-muted-foreground font-mono py-2 pl-4">
                                  No per-record results for this run.
                                </div>
                              ) : (
                                <div className="divide-y divide-border/50 border border-border rounded-sm mt-1">
                                  {results.map((r) => (
                                    <div
                                      key={r.outboxId}
                                      className="flex gap-3 items-start px-3 py-2"
                                    >
                                      {r.success ? (
                                        <CheckCircle className="w-3 h-3 text-success shrink-0 mt-0.5" />
                                      ) : (
                                        <XCircle className="w-3 h-3 text-destructive shrink-0 mt-0.5" />
                                      )}
                                      <div className="min-w-0 flex-1">
                                        <span
                                          className={`text-[10px] uppercase tracking-widest mr-2 ${r.success ? "text-success" : "text-destructive"}`}
                                        >
                                          {r.entityKind} ·{" "}
                                          {r.success ? "pushed" : "failed"}
                                        </span>
                                        <span className="text-xs text-foreground">
                                          {r.itemName ?? r.entityId}
                                        </span>
                                        {r.unitName && (
                                          <span className="text-[10px] text-muted-foreground ml-2">
                                            ({r.unitName})
                                          </span>
                                        )}
                                        {!r.success && r.error && (
                                          <div className="text-[10px] text-destructive mt-0.5">
                                            {r.error}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}
