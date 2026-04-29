import { Title } from "@/components/title";
import { Layout } from "@/components/layout";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  useGetDashboardSummary,
  useGetResupplyForecast,
  useListUnits,
  useGetDashboardOpsecPushes,
  useGetDistroAudit,
  useSendDistroAuditDigest,
  usePreviewDistroAuditDigest,
  useListCommsHygieneRuns,
  useGetCommsHygieneStats,
  useGetCommsHygieneSettings,
  useUpdateCommsHygieneSettings,
  getGetDistroAuditQueryKey,
  getListCommsHygieneRunsQueryKey,
  getGetCommsHygieneStatsQueryKey,
  getGetCommsHygieneSettingsQueryKey,
  type OpsecPushTile as OpsecPushTileData,
  type DistroAuditUnit,
  type DistroAuditDigestPreview,
  type CommsHygieneRun,
  type CommsHygieneSettings,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCopyShareLink } from "@/components/share-link";
import { AlertCircle, Check, Eye, FileText, Link2, Mail, MailWarning, MapPin, Package, Pencil, Radio, Send, ShieldAlert, Target, Users } from "lucide-react";
import { format } from "date-fns";
import { Link } from "wouter";
import { useEffect, useMemo, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

const UNITS_SORT_STORAGE_KEY = "marlog:dashboard:units-sort";

const UNITS_SORT_OPTIONS = {
  worst: { label: "Worst first", subtitle: "all subordinate elements · worst first" },
  alpha: { label: "Alphabetical (A→Z)", subtitle: "all subordinate elements · alphabetical" },
  echelon: { label: "By echelon", subtitle: "all subordinate elements · by echelon" },
} as const;

type UnitsSort = keyof typeof UNITS_SORT_OPTIONS;

const ECHELON_ORDER: Record<string, number> = {
  battalion: 0,
  company: 1,
  platoon: 2,
  section: 3,
  squad: 4,
  fireteam: 5,
};

function isUnitsSort(value: string | null): value is UnitsSort {
  return value === "worst" || value === "alpha" || value === "echelon";
}

function readStoredSort(): UnitsSort {
  if (typeof window === "undefined") return "worst";
  try {
    const stored = window.localStorage.getItem(UNITS_SORT_STORAGE_KEY);
    if (isUnitsSort(stored)) return stored;
  } catch {
    // ignore (e.g. storage disabled)
  }
  return "worst";
}

export default function Dashboard() {
  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary({
    query: { queryKey: ["dashboard"] }
  });
  const { data: forecast, isLoading: loadingForecast } = useGetResupplyForecast({
    query: { queryKey: ["forecast"] }
  });
  const { data: units, isLoading: loadingUnits } = useListUnits({
    query: { queryKey: ["units"] }
  });
  const { data: opsecPushes } = useGetDashboardOpsecPushes({
    query: { queryKey: ["opsec-pushes"] }
  });
  const { data: distroAudit } = useGetDistroAudit({
    query: { queryKey: ["distro-audit"] }
  });

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const sendDigest = useSendDistroAuditDigest();
  const previewDigest = usePreviewDistroAuditDigest();
  const [digestPreview, setDigestPreview] = useState<DistroAuditDigestPreview | null>(null);

  const handlePreviewDigest = async () => {
    try {
      const result = await previewDigest.mutateAsync();
      setDigestPreview(result);
    } catch {
      toast({
        title: "Preview failed",
        description: "Could not render the digest preview. Check server logs.",
        variant: "destructive",
      });
    }
  };

  const handleSendDigest = async () => {
    try {
      const result = await sendDigest.mutateAsync();
      // Refresh the audit so the dashboard counts reflect any newly clean state.
      queryClient.invalidateQueries({ queryKey: getGetDistroAuditQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["distro-audit"] });
      // Refresh the recent-runs history so the new entry shows up immediately.
      queryClient.invalidateQueries({
        queryKey: getListCommsHygieneRunsQueryKey(),
      });
      queryClient.invalidateQueries({ queryKey: ["comms-hygiene-runs"] });
      // Refresh the stored-runs footnote so the count tick up immediately.
      queryClient.invalidateQueries({
        queryKey: getGetCommsHygieneStatsQueryKey(),
      });
      queryClient.invalidateQueries({ queryKey: ["comms-hygiene-stats"] });

      if (result.emailSent) {
        toast({
          title: "Digest sent",
          description: `Emailed ${result.invalid} malformed ${
            result.invalid === 1 ? "address" : "addresses"
          } across ${result.flagged} ${
            result.flagged === 1 ? "unit" : "units"
          }.`,
        });
        return;
      }

      if (result.reason === "no_flagged_entries") {
        toast({
          title: "Digest suppressed",
          description: `All ${result.audited} ${
            result.audited === 1 ? "unit" : "units"
          } scanned · no malformed addresses to report.`,
        });
        return;
      }

      if (result.reason === "no_recipients") {
        toast({
          title: "Digest not sent",
          description:
            "Audit ran but no recipients are configured (COMMS_HYGIENE_TO is empty).",
          variant: "destructive",
        });
        return;
      }

      if (result.reason === "smtp_not_configured") {
        toast({
          title: "Digest not sent",
          description:
            "Audit ran but SMTP is not configured on the server. Digest preview was logged instead.",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "Digest not sent",
        description: result.reason ?? "Email could not be dispatched.",
        variant: "destructive",
      });
    } catch {
      toast({
        title: "Digest failed",
        description: "Could not run the comms-hygiene digest. Check server logs.",
        variant: "destructive",
      });
    }
  };

  const [unitsSort, setUnitsSort] = useState<UnitsSort>(readStoredSort);

  useEffect(() => {
    try {
      window.localStorage.setItem(UNITS_SORT_STORAGE_KEY, unitsSort);
    } catch {
      // ignore (e.g. storage disabled)
    }
  }, [unitsSort]);

  const sortedUnits = useMemo(() => {
    if (!units) return [];
    const list = [...units];
    if (unitsSort === "alpha") {
      return list.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (unitsSort === "echelon") {
      return list.sort((a, b) => {
        const aRank = ECHELON_ORDER[a.echelon] ?? 99;
        const bRank = ECHELON_ORDER[b.echelon] ?? 99;
        return aRank - bRank || a.name.localeCompare(b.name);
      });
    }
    return list.sort(
      (a, b) => a.readiness - b.readiness || b.deficiencyCount - a.deficiencyCount,
    );
  }, [units, unitsSort]);

  return (
    <Layout>
      <Title title="Dashboard" description="Command overview" />

      <PageHeader
        title="C2 Overview"
        tag="Dashboard"
        subtitle="Sustainment picture across all subordinate elements"
        right={
          <div className="text-right">
            <div className="text-[10px] font-mono text-muted-foreground tracking-widest uppercase">DTG</div>
            <div className="font-mono font-bold text-sm tabular-nums">
              {format(new Date(), "ddHHmm'Z' MMM yy").toUpperCase()}
            </div>
          </div>
        }
      />

      {loadingSummary ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          {[1,2,3,4].map(i => (
            <div key={i} className="h-20 bg-muted animate-pulse rounded-sm" />
          ))}
        </div>
      ) : summary ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
            <Link href="/units" className="block group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
              <Card className="border-border group-hover:border-primary/50 group-hover:bg-muted/20 transition-colors h-full cursor-pointer">
                <CardContent className="p-4 flex flex-col justify-center">
                  <div className="text-[10px] text-muted-foreground font-mono mb-2 flex items-center gap-1.5 tracking-widest uppercase">
                    <ShieldAlert className="w-3.5 h-3.5" /> Units
                  </div>
                  <div className="text-3xl font-bold font-mono tabular-nums">{summary.unitCount}</div>
                </CardContent>
              </Card>
            </Link>
            <Link href="/units" className="block group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
              <Card className="border-border group-hover:border-primary/50 group-hover:bg-muted/20 transition-colors h-full cursor-pointer">
                <CardContent className="p-4 flex flex-col justify-center">
                  <div className="text-[10px] text-muted-foreground font-mono mb-2 flex items-center gap-1.5 tracking-widest uppercase">
                    <Users className="w-3.5 h-3.5" /> PAX
                  </div>
                  <div className="text-3xl font-bold font-mono tabular-nums">{summary.personnelCount}</div>
                </CardContent>
              </Card>
            </Link>
            <Link href="/units" className="block group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
              <Card className={`group-hover:bg-muted/20 transition-colors h-full cursor-pointer ${summary.criticalDeficiencyCount > 0 ? "border-destructive/40 bg-destructive/5 group-hover:bg-destructive/10" : "border-border group-hover:border-primary/50"}`}>
                <CardContent className="p-4 flex flex-col justify-center">
                  <div className="text-[10px] text-muted-foreground font-mono mb-2 flex items-center gap-1.5 tracking-widest uppercase">
                    <AlertCircle className="w-3.5 h-3.5" /> Crit Defs
                  </div>
                  <div className={`text-3xl font-bold font-mono tabular-nums ${summary.criticalDeficiencyCount > 0 ? "text-destructive" : ""}`}>
                    {summary.criticalDeficiencyCount}
                  </div>
                </CardContent>
              </Card>
            </Link>
            <Link href="/sync" className="block group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm">
              <Card className="border-border group-hover:border-primary/50 group-hover:bg-muted/20 transition-colors h-full cursor-pointer">
                <CardContent className="p-4 flex flex-col justify-center">
                  <div className="text-[10px] text-muted-foreground font-mono mb-2 flex items-center gap-1.5 tracking-widest uppercase">
                    <Package className="w-3.5 h-3.5" /> Resupplies
                  </div>
                  <div className="text-3xl font-bold font-mono tabular-nums">{summary.upcomingResupplyCount}</div>
                </CardContent>
              </Card>
            </Link>
          </div>

          <div className="grid md:grid-cols-2 gap-8 mb-8">
            <div>
              <SectionHeader subtitle="by supply class">Class Breakdown</SectionHeader>
              <div className="space-y-1.5">
                {summary.classBreakdown.map((cb) => {
                  const isClassV = cb.supplyClass === "V";
                  const href = isClassV
                    ? `/classes/${cb.supplyClass}#dodic-breakdown`
                    : `/classes/${cb.supplyClass}`;
                  return (
                    <Link
                      key={cb.supplyClass}
                      href={href}
                      className="block bg-card border border-border p-3 rounded-sm flex items-center justify-between hover:bg-primary/10 hover:border-primary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary group"
                      aria-label={
                        isClassV
                          ? `Drill into Class V regiment-wide DODIC breakdown`
                          : `Drill into Class ${cb.supplyClass} ${cb.label}`
                      }
                    >
                      <div className="font-mono text-xs">
                        <span className="font-bold text-primary tracking-widest mr-2 group-hover:underline">CLASS {cb.supplyClass}</span>
                        <span className="text-muted-foreground group-hover:text-foreground transition-colors">{cb.label}</span>
                        {isClassV && (
                          <span className="ml-2 text-[9px] px-1.5 py-0.5 border border-primary/30 text-primary/80 rounded-sm tracking-widest uppercase">
                            DODIC View
                          </span>
                        )}
                      </div>
                      <div className="flex gap-1.5">
                        <span className="px-1.5 py-0.5 bg-success/15 border border-success/30 text-success text-[10px] font-mono rounded-sm tabular-nums">
                          ■ {cb.green}
                        </span>
                        <span className="px-1.5 py-0.5 bg-warning/15 border border-warning/30 text-warning text-[10px] font-mono rounded-sm tabular-nums">
                          ● {cb.amber}
                        </span>
                        <span className="px-1.5 py-0.5 bg-destructive/15 border border-destructive/30 text-destructive text-[10px] font-mono rounded-sm tabular-nums">
                          ◆ {cb.red}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>

            <div>
              <SectionHeader subtitle="next 5 days">Critical Forecast</SectionHeader>
              {loadingForecast ? (
                <div className="h-32 bg-muted animate-pulse rounded-sm" />
              ) : forecast && forecast.length > 0 ? (
                <div className="space-y-1.5">
                  {forecast.slice(0, 5).map((f, i) => {
                    const snapshotUrl = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/units/${f.unitId}/snapshot`;
                    return (
                      <div key={i} className="relative group">
                        <Link
                          href={`/units/${f.unitId}`}
                          className="block bg-card border border-border p-3 pr-28 rounded-sm flex items-center justify-between hover:bg-muted/20 hover:border-primary/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        >
                          <div>
                            <div className="font-mono text-xs font-bold group-hover:text-primary transition-colors">{f.unitName}</div>
                            <div className="text-[10px] text-muted-foreground font-mono">Class {f.supplyClass} · {f.itemName}</div>
                          </div>
                          <div className="text-right">
                            <div className={`text-xs font-mono font-bold ${f.daysUntilStockout <= 2 ? 'text-destructive' : 'text-orange'}`}>
                              ◆ {f.daysUntilStockout} DAYS
                            </div>
                            <div className="text-[10px] text-muted-foreground font-mono">Req: {f.recommendedQuantity} {f.unit}</div>
                          </div>
                        </Link>

                        {/* Snapshot quick action — mirrors the unit cards */}
                        <a
                          href={snapshotUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open Snapshot Report"
                          className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest px-2 py-1.5 border border-border/50 bg-card text-muted-foreground/60 hover:text-foreground hover:border-foreground/40 hover:bg-muted/50 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-primary rounded-sm transition-colors"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <FileText className="w-3 h-3" />
                          Snapshot
                        </a>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="bg-card border border-border p-6 rounded-sm text-center text-muted-foreground font-mono text-xs tracking-wide">
                  ■ No critical stockouts projected in next 5 days.
                </div>
              )}
            </div>
          </div>

          {distroAudit && (
            <div className="mb-8">
              <div className="flex items-end justify-between gap-3 flex-wrap">
                <SectionHeader
                  subtitle={
                    distroAudit.flaggedUnitCount > 0
                      ? `${distroAudit.invalidEntryCount} malformed ${
                          distroAudit.invalidEntryCount === 1 ? "address" : "addresses"
                        } across ${distroAudit.flaggedUnitCount} ${
                          distroAudit.flaggedUnitCount === 1 ? "unit" : "units"
                        } · silently dropped at send time`
                      : `${distroAudit.scannedUnitCount} ${
                          distroAudit.scannedUnitCount === 1 ? "unit" : "units"
                        } scanned · all distro lists clean`
                  }
                >
                  Distribution List Audit
                </SectionHeader>
                <div className="flex items-center gap-2 mb-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handlePreviewDigest}
                    disabled={previewDigest.isPending}
                    data-testid="distro-audit-preview-digest"
                    className="font-mono uppercase text-[10px] tracking-widest"
                  >
                    <Eye
                      className={`w-3 h-3 mr-2 ${previewDigest.isPending ? "animate-pulse" : ""}`}
                    />
                    {previewDigest.isPending ? "Rendering…" : "Preview Digest"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleSendDigest}
                    disabled={sendDigest.isPending}
                    data-testid="distro-audit-send-digest"
                    className="font-mono uppercase text-[10px] tracking-widest"
                  >
                    <Send
                      className={`w-3 h-3 mr-2 ${sendDigest.isPending ? "animate-pulse" : ""}`}
                    />
                    {sendDigest.isPending ? "Sending…" : "Send Digest Now"}
                  </Button>
                </div>
              </div>
              <CommsHygieneStatus
                lastRun={distroAudit.lastRun ?? null}
                lastSuccessfulSend={distroAudit.lastSuccessfulSend ?? null}
              />
              <CommsHygieneHistory />
              {distroAudit.flaggedUnitCount > 0 ? (
                <div
                  className="bg-card border border-warning/40 rounded-sm"
                  data-testid="distro-audit-list"
                >
                  <div className="divide-y divide-border">
                    {distroAudit.units.map((u) => (
                      <DistroAuditRow key={u.unitId} unit={u} />
                    ))}
                  </div>
                </div>
              ) : (
                <div
                  className="bg-card border border-success/30 rounded-sm p-6 flex items-center gap-3"
                  data-testid="distro-audit-empty"
                >
                  <div className="w-9 h-9 shrink-0 border border-success/40 bg-success/10 text-success rounded-sm flex items-center justify-center">
                    <Check className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="font-mono font-bold text-sm tracking-wide">
                      No malformed distribution-list addresses
                    </div>
                    <div className="font-mono text-[10px] text-muted-foreground mt-1 tracking-wide">
                      Every To / CC / BCC entry across all units passes the email shape check.
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {opsecPushes && opsecPushes.length > 0 && (
            <div className="mb-8">
              <SectionHeader subtitle="pre-coordinated delivery schedules">OPSEC Pushes In Flight</SectionHeader>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {opsecPushes.map((tile) => (
                  <OpsecPushTile key={tile.scheduleId} tile={tile} />
                ))}
              </div>
            </div>
          )}

          <div className="mb-8">
            <div className="flex items-end justify-between gap-3 flex-wrap">
              <SectionHeader subtitle={UNITS_SORT_OPTIONS[unitsSort].subtitle}>
                Units Snapshot
              </SectionHeader>
              <div className="flex items-center gap-2 mb-3">
                <label
                  htmlFor="units-snapshot-sort"
                  className="text-[10px] font-mono text-muted-foreground tracking-widest uppercase"
                >
                  Sort
                </label>
                <Select
                  value={unitsSort}
                  onValueChange={(value) => {
                    if (isUnitsSort(value)) setUnitsSort(value);
                  }}
                >
                  <SelectTrigger
                    id="units-snapshot-sort"
                    aria-label="Units snapshot sort order"
                    className="h-8 w-[180px] font-mono text-xs"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(UNITS_SORT_OPTIONS) as UnitsSort[]).map((key) => (
                      <SelectItem key={key} value={key} className="font-mono text-xs">
                        {UNITS_SORT_OPTIONS[key].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="bg-card border border-border rounded-sm">
              {loadingUnits ? (
                <div className="divide-y divide-border">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="p-4 flex items-center justify-between animate-pulse">
                      <div className="flex gap-4">
                        <div className="w-10 h-10 bg-muted rounded-sm" />
                        <div className="space-y-2">
                          <div className="w-32 h-3 bg-muted rounded-sm" />
                          <div className="w-24 h-2 bg-muted rounded-sm" />
                        </div>
                      </div>
                      <div className="w-40 h-4 bg-muted rounded-sm" />
                    </div>
                  ))}
                </div>
              ) : units && units.length > 0 ? (
                <div className="divide-y divide-border">
                  {sortedUnits.map((unit) => {
                    const isCritical = unit.readiness < 60;
                    const snapshotUrl = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/units/${unit.id}/snapshot`;
                    return (
                      <div key={unit.id} className="relative group">
                        <Link
                          href={`/units/${unit.id}`}
                          data-critical={isCritical || undefined}
                          className={`relative block transition-colors p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset ${
                            isCritical
                              ? "bg-destructive/[0.04] hover:bg-destructive/10 pl-[calc(1rem-3px)] border-l-[3px] border-l-destructive"
                              : "hover:bg-muted/20"
                          }`}
                        >
                          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                            <div className="flex items-start gap-3">
                              <div
                                className={`w-10 h-10 shrink-0 border rounded-sm flex items-center justify-center transition-colors ${
                                  isCritical
                                    ? "bg-destructive/15 border-destructive/40 text-destructive group-hover:bg-destructive group-hover:text-destructive-foreground"
                                    : "bg-primary/10 border-primary/20 text-primary group-hover:bg-primary group-hover:text-primary-foreground"
                                }`}
                              >
                                <ShieldAlert className="w-5 h-5" />
                              </div>
                              <div>
                                <div className="flex items-center gap-2 flex-wrap">
                                  <h3 className="font-mono font-bold text-sm tracking-wide">{unit.name}</h3>
                                  {isCritical && (
                                    <span
                                      className="text-[10px] font-mono font-bold px-1.5 py-0.5 bg-destructive/15 text-destructive border border-destructive/40 rounded-sm tracking-widest uppercase"
                                      aria-label="Critical readiness"
                                    >
                                      ◆ Critical
                                    </span>
                                  )}
                                  {unit.callsign && (
                                    <span className="text-[10px] font-mono px-1.5 py-0.5 bg-secondary text-secondary-foreground rounded-sm tracking-widest">
                                      {unit.callsign}
                                    </span>
                                  )}
                                </div>
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[10px] text-muted-foreground font-mono tracking-wide">
                                  <div className="flex items-center gap-1"><Users className="w-3 h-3" /> {unit.personnel} PAX</div>
                                  <div className="flex items-center gap-1 uppercase"><Target className="w-3 h-3" /> {unit.echelon}</div>
                                  {unit.location && <div className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {unit.location}</div>}
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-6 md:w-56 shrink-0">
                              <div className="flex-1">
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-[10px] font-mono font-bold tracking-widest uppercase text-muted-foreground">Readiness</span>
                                  <StatusBadge value={unit.readiness} />
                                </div>
                                <Progress
                                  value={unit.readiness}
                                  className="h-1.5"
                                  indicatorClassName={
                                    unit.readiness >= 90 ? "bg-success" :
                                    unit.readiness >= 60 ? "bg-warning" : "bg-destructive"
                                  }
                                />
                              </div>

                              <div className="text-center shrink-0">
                                <div className="text-[10px] font-mono text-muted-foreground mb-0.5 tracking-widest uppercase">Defs</div>
                                <div className={`font-mono font-bold text-sm ${unit.deficiencyCount > 0 ? "text-destructive" : "text-success"}`}>
                                  {unit.deficiencyCount}
                                </div>
                              </div>
                            </div>
                          </div>
                        </Link>

                        {/* Snapshot quick action — always visible for touch compatibility */}
                        <a
                          href={snapshotUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open Snapshot Report"
                          className="absolute right-4 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest px-2 py-1.5 border border-border/50 bg-card text-muted-foreground/60 hover:text-foreground hover:border-foreground/40 hover:bg-muted/50 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-primary rounded-sm transition-colors"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <FileText className="w-3 h-3" />
                          Snapshot
                        </a>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="p-12 text-center text-muted-foreground font-mono text-xs tracking-widest uppercase">
                  No units configured.
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}

      <Dialog
        open={digestPreview !== null}
        onOpenChange={(open) => {
          if (!open) setDigestPreview(null);
        }}
      >
        <DialogContent
          className="sm:max-w-[760px] max-h-[85vh] flex flex-col"
          data-testid="distro-audit-preview-dialog"
        >
          <DialogHeader>
            <DialogTitle className="font-mono uppercase text-sm tracking-widest">
              Digest Preview
            </DialogTitle>
          </DialogHeader>
          {digestPreview && (
            <div className="flex-1 overflow-auto space-y-4">
              {digestPreview.suppressed && (
                <div
                  className="border border-success/40 bg-success/10 text-success rounded-sm p-3 font-mono text-[11px] tracking-wide flex items-center gap-2"
                  data-testid="distro-audit-preview-suppressed"
                >
                  <Check className="w-3.5 h-3.5 shrink-0" />
                  All {digestPreview.audited} {digestPreview.audited === 1 ? "unit" : "units"} scanned · digest would be suppressed at send time.
                </div>
              )}
              <div>
                <div className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground mb-1">
                  Subject
                </div>
                <div
                  className="font-mono text-xs bg-muted/30 border border-border rounded-sm px-3 py-2 break-words"
                  data-testid="distro-audit-preview-subject"
                >
                  {digestPreview.subject}
                </div>
              </div>
              <div>
                <div className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground mb-1">
                  HTML Body
                </div>
                <iframe
                  title="Digest HTML preview"
                  data-testid="distro-audit-preview-html"
                  sandbox=""
                  srcDoc={digestPreview.html}
                  className="w-full h-[420px] bg-white border border-border rounded-sm"
                />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Layout>
  );
}

interface OpsecPushTileProps {
  tile: OpsecPushTileData;
}

function OpsecPushTile({ tile }: OpsecPushTileProps) {
  const { copied, copy } = useCopyShareLink();

  return (
    <div className="relative group">
      <Link
        href={`/units/${tile.unitId}/comms-denied`}
        className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm"
      >
        <Card className="border-border group-hover:border-primary/50 group-hover:bg-muted/20 transition-colors h-full cursor-pointer">
          <CardContent className="p-4">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
                <Radio className="w-3 h-3 text-primary" /> Pre-Coordinated
              </div>
              <span className="text-[10px] font-mono px-1.5 py-0.5 bg-primary/10 text-primary border border-primary/20 rounded-sm tracking-widest">
                ACTIVE
              </span>
            </div>
            <div className="font-mono font-bold text-sm">{tile.unitName}</div>
            {tile.nextPushDate && (
              <div className="font-mono text-[10px] text-muted-foreground mt-1">
                Next push: {format(new Date(tile.nextPushDate), "ddMMMyy").toUpperCase()}
              </div>
            )}
            <div className="font-mono text-[10px] text-muted-foreground mt-0.5">
              {tile.totalPushes} push{tile.totalPushes !== 1 ? "es" : ""} planned
            </div>
            {tile.scheduleLabel && (
              <div className={`font-mono text-[10px] text-primary/70 mt-1 group-hover:text-primary transition-colors truncate ${tile.shareToken ? "pr-24" : ""}`}>
                {tile.scheduleLabel}
              </div>
            )}
          </CardContent>
        </Card>
      </Link>

      {tile.shareToken && (
        <Button
          type="button"
          variant={copied ? "default" : "outline"}
          size="sm"
          title="Copy offline handoff link"
          className="absolute right-3 bottom-3 font-mono uppercase text-[10px] tracking-widest h-7 px-2 z-10"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (tile.shareToken) copy(tile.shareToken);
          }}
          data-testid={`button-copy-share-link-${tile.scheduleId}`}
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 mr-1" /> Copied
            </>
          ) : (
            <>
              <Link2 className="w-3 h-3 mr-1" /> Copy Link
            </>
          )}
        </Button>
      )}
    </div>
  );
}

const COMMS_OUTCOME_LABEL: Record<CommsHygieneRun["outcome"], string> = {
  sent: "Digest sent",
  skipped_no_flags: "No malformed addresses — digest suppressed",
  skipped_no_recipients: "Skipped — no recipients configured",
  skipped_no_smtp: "Skipped — SMTP not configured",
  failed: "Last attempt failed",
};

function formatRecipientList(list: string[]): string {
  if (list.length === 0) return "no recipients";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} + 1 other`;
  return `${list[0]} + ${list.length - 1} others`;
}

function CommsHygieneStatus({
  lastRun,
  lastSuccessfulSend,
}: {
  lastRun: CommsHygieneRun | null;
  lastSuccessfulSend: CommsHygieneRun | null;
}) {
  // Three visual states drive the entire panel:
  // 1. Never run/sent → muted "never sent" notice
  // 2. Last attempt failed → error notice that ALSO shows the prior successful send
  //    (if any) so planners aren't left wondering whether the digest is fully broken
  // 3. Otherwise (sent or benignly skipped) → muted "last sent / last run" line
  if (!lastRun) {
    return (
      <div
        className="mb-3 px-3 py-2 border border-border/60 bg-muted/20 rounded-sm flex items-center gap-2 font-mono text-[10px] tracking-wide text-muted-foreground"
        data-testid="comms-hygiene-status-never"
      >
        <Mail className="w-3 h-3 shrink-0" />
        <span className="uppercase tracking-widest">Last digest sent:</span>
        <span>Never — comms-hygiene scheduler has not run yet.</span>
      </div>
    );
  }

  const ranAt = format(new Date(lastRun.ranAt), "yyyy-MM-dd HH:mm");
  const recipientText = formatRecipientList(lastRun.recipients);

  if (lastRun.outcome === "failed") {
    const successText = lastSuccessfulSend
      ? `Last successful send: ${format(
          new Date(lastSuccessfulSend.ranAt),
          "yyyy-MM-dd HH:mm",
        )} to ${formatRecipientList(lastSuccessfulSend.recipients)}.`
      : "No digest has ever been delivered.";
    return (
      <div
        className="mb-3 px-3 py-2 border border-destructive/50 bg-destructive/10 rounded-sm font-mono text-[11px] tracking-wide text-destructive"
        data-testid="comms-hygiene-status-failed"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="uppercase tracking-widest text-[10px]">
              Last attempt failed · {ranAt}
            </div>
            {lastRun.errorMessage && (
              <div
                className="mt-1 text-foreground break-words"
                data-testid="comms-hygiene-status-error-message"
              >
                {lastRun.errorMessage}
              </div>
            )}
            <div className="mt-1 text-muted-foreground">{successText}</div>
          </div>
        </div>
      </div>
    );
  }

  if (lastRun.outcome === "sent") {
    return (
      <div
        className="mb-3 px-3 py-2 border border-border/60 bg-muted/20 rounded-sm flex items-center gap-2 font-mono text-[10px] tracking-wide text-muted-foreground"
        data-testid="comms-hygiene-status-sent"
      >
        <Check className="w-3 h-3 text-success shrink-0" />
        <span className="uppercase tracking-widest">Last digest sent:</span>
        <span className="text-foreground">{ranAt}</span>
        <span className="text-muted-foreground/80">to {recipientText}</span>
        <span className="text-muted-foreground/60">
          ({lastRun.flaggedCount} unit{lastRun.flaggedCount === 1 ? "" : "s"} flagged
          )
        </span>
      </div>
    );
  }

  // Benign skip (no flags / no SMTP / no recipients).
  const successLine = lastSuccessfulSend
    ? `Last successful send: ${format(
        new Date(lastSuccessfulSend.ranAt),
        "yyyy-MM-dd HH:mm",
      )} to ${formatRecipientList(lastSuccessfulSend.recipients)}.`
    : "No digest has ever been delivered.";
  return (
    <div
      className="mb-3 px-3 py-2 border border-border/60 bg-muted/20 rounded-sm font-mono text-[10px] tracking-wide text-muted-foreground"
      data-testid="comms-hygiene-status-skipped"
    >
      <div className="flex items-center gap-2">
        <Mail className="w-3 h-3 shrink-0" />
        <span className="uppercase tracking-widest">Last run:</span>
        <span className="text-foreground">{ranAt}</span>
        <span>· {COMMS_OUTCOME_LABEL[lastRun.outcome]}</span>
      </div>
      <div className="mt-1 pl-5">{successLine}</div>
    </div>
  );
}

const COMMS_OUTCOME_BADGE: Record<
  CommsHygieneRun["outcome"],
  { label: string; className: string }
> = {
  sent: {
    label: "SENT",
    className: "bg-success/15 text-success border-success/40",
  },
  skipped_no_flags: {
    label: "CLEAN",
    className: "bg-muted/40 text-muted-foreground border-border",
  },
  skipped_no_recipients: {
    label: "NO RCPTS",
    className: "bg-warning/15 text-warning border-warning/40",
  },
  skipped_no_smtp: {
    label: "NO SMTP",
    className: "bg-warning/15 text-warning border-warning/40",
  },
  failed: {
    label: "FAILED",
    className: "bg-destructive/15 text-destructive border-destructive/40",
  },
};

const HISTORY_LIMIT = 10;

/**
 * Collapsible run history for the comms-hygiene scheduler. The single-run
 * status line above only ever surfaces the latest tick; this list lets
 * planners spot a streak of failures (e.g. SMTP outage) at a glance without
 * grepping logs. Persisted in `comms_hygiene_runs` so it survives restarts.
 */
function CommsHygieneHistory() {
  const { data: runs } = useListCommsHygieneRuns(
    { limit: HISTORY_LIMIT },
    { query: { queryKey: ["comms-hygiene-runs", HISTORY_LIMIT] } },
  );
  const { data: stats } = useGetCommsHygieneStats({
    query: { queryKey: ["comms-hygiene-stats"] },
  });
  const [failuresOnly, setFailuresOnly] = useState(false);

  const hasRuns = (runs?.length ?? 0) > 0;
  const failureCount = hasRuns
    ? runs!.filter((r) => r.outcome === "failed").length
    : 0;
  const visibleRuns = hasRuns
    ? failuresOnly
      ? runs!.filter((r) => r.outcome === "failed")
      : runs!
    : [];

  // The retention control is rendered regardless of whether any runs are on
  // file so admins can pre-set the override before the first scheduled tick.
  if (!hasRuns) {
    return <CommsHygieneRetentionControl stats={stats ?? null} />;
  }

  // Per-row "expires soon" detection mirrors the server's near-expiry math
  // exactly: a row is at risk when `ranAt + retentionDays` falls within
  // `nearExpiryWindowDays` of now. The server echoes both numbers back via
  // the stats endpoint so the FE doesn't have to know the env defaults.
  //
  // Disabled (and silent) when retention is off (`retentionDays <= 0`) OR
  // when the operator explicitly turned the warning off via
  // `COMMS_HYGIENE_NEAR_EXPIRY_WINDOW_DAYS=0` — the server reports
  // `nearExpiryWindowDays=0` in both cases so this single guard handles
  // them together.
  const retentionDays = stats?.retentionDays ?? 0;
  const nearExpiryWindowDays = stats?.nearExpiryWindowDays ?? 0;
  const nearExpiryEnabled = retentionDays > 0 && nearExpiryWindowDays > 0;
  const isNearExpiry = (ranAtIso: string): boolean => {
    if (!nearExpiryEnabled) return false;
    const ranAtMs = new Date(ranAtIso).getTime();
    if (!Number.isFinite(ranAtMs)) return false;
    const dayMs = 24 * 60 * 60 * 1000;
    return (
      ranAtMs <= Date.now() - (retentionDays - nearExpiryWindowDays) * dayMs
    );
  };

  return (
    <>
    <details
      className="group"
      data-testid="comms-hygiene-history"
      data-failure-count={failureCount}
    >
      <summary className="cursor-pointer select-none list-none px-3 py-2 border border-border/60 bg-muted/10 rounded-sm font-mono text-[10px] tracking-widest uppercase text-muted-foreground hover:bg-muted/20 hover:text-foreground transition-colors flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <span className="inline-block w-2 transition-transform group-open:rotate-90">
          ›
        </span>
        <span>Recent digest runs</span>
        <span
          className="text-muted-foreground/70 normal-case tracking-wide"
          data-testid="comms-hygiene-history-count"
        >
          ({visibleRuns.length} shown
          {!failuresOnly && failureCount > 0
            ? `, ${failureCount} failed`
            : ""}
          )
        </span>
      </summary>
      <div className="mt-2 flex items-center justify-end">
        <label
          className="inline-flex items-center gap-2 cursor-pointer select-none font-mono text-[10px] tracking-widest uppercase text-muted-foreground hover:text-foreground transition-colors"
          data-testid="comms-hygiene-history-failures-only-label"
        >
          <input
            type="checkbox"
            className="h-3 w-3 accent-destructive cursor-pointer"
            checked={failuresOnly}
            onChange={(e) => setFailuresOnly(e.target.checked)}
            data-testid="comms-hygiene-history-failures-only"
          />
          <span>Failures only</span>
        </label>
      </div>
      {visibleRuns.length === 0 ? (
        <div
          className="mt-2 px-3 py-4 border border-border/60 bg-card rounded-sm font-mono text-[10px] tracking-wide text-muted-foreground text-center"
          data-testid="comms-hygiene-history-empty"
        >
          No failed runs in the last {runs!.length} ticks.
        </div>
      ) : (
        <ol
          className="mt-2 border border-border/60 bg-card rounded-sm divide-y divide-border"
          data-testid="comms-hygiene-history-list"
        >
          {visibleRuns.map((run) => {
          const badge = COMMS_OUTCOME_BADGE[run.outcome];
          const nearExpiry = isNearExpiry(run.ranAt);
          return (
            <li
              key={run.id}
              className="px-3 py-2 font-mono text-[10px] tracking-wide flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3"
              data-testid={`comms-hygiene-history-row-${run.id}`}
              data-outcome={run.outcome}
              data-near-expiry={nearExpiry ? "true" : "false"}
            >
              <span
                className={`inline-flex items-center justify-center px-1.5 py-0.5 border rounded-sm text-[9px] tracking-widest shrink-0 w-[68px] ${badge.className}`}
              >
                {badge.label}
              </span>
              <span className="text-foreground tabular-nums shrink-0">
                {format(new Date(run.ranAt), "yyyy-MM-dd HH:mm")}
              </span>
              {nearExpiry && (
                <span
                  className="inline-flex items-center px-1.5 py-0.5 border border-warning/40 bg-warning/15 text-warning rounded-sm text-[9px] tracking-widest uppercase shrink-0"
                  title={`Expires within ${nearExpiryWindowDays} day${nearExpiryWindowDays === 1 ? "" : "s"} under the ${retentionDays}-day retention policy. Export before it falls off.`}
                  data-testid={`comms-hygiene-history-row-${run.id}-expires-soon`}
                >
                  Expires soon
                </span>
              )}
              <span className="text-muted-foreground shrink-0">
                {run.flaggedCount} flagged · {run.invalidCount} bad
              </span>
              <span className="text-muted-foreground/80 truncate min-w-0 flex-1">
                {run.outcome === "failed" && run.errorMessage
                  ? run.errorMessage
                  : `${formatRecipientList(run.recipients)}`}
              </span>
            </li>
          );
        })}
        </ol>
      )}
    </details>
    <CommsHygieneRetentionControl stats={stats ?? null} />
    </>
  );
}

type CommsHygieneStatsLike = {
  totalRuns: number;
  oldestRanAt: string | null;
  retentionDays: number;
  retentionDaysOverride: number | null;
  retentionDaysDefault: number;
  oldestExpiresAt: string | null;
  nearExpiryWindowDays: number;
  nearExpiryCount: number;
};

/**
 * Surfaces the stored-runs count and projected expiry of the oldest run, and
 * exposes a small inline form so admins can adjust the retention window
 * without touching `COMMS_HYGIENE_RETENTION_DAYS` or restarting the API.
 *
 * Three visual zones share a single `<div>`:
 * 1. The "Storage" footnote on the left — always rendered when stats load,
 *    even before any runs are on file, so admins can pre-set the override.
 * 2. An "OVERRIDE" pill when the value differs from the env default — makes
 *    it obvious at a glance that someone has bumped retention.
 * 3. An expandable inline form with a number input + Save / Reset buttons.
 *    Reset clears the override and falls back to the env default.
 */
function CommsHygieneRetentionControl({
  stats,
}: {
  stats: CommsHygieneStatsLike | null;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: settings } = useGetCommsHygieneSettings({
    query: { queryKey: ["comms-hygiene-settings"] },
  });
  const updateSettings = useUpdateCommsHygieneSettings();

  // Settings is the source of truth for the editor state (it includes both
  // the override and the env-default). Stats is used purely for the
  // "X runs on file" footnote on the left.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>("");

  const effective: CommsHygieneSettings | null = settings ?? null;

  if (!stats && !effective) return null;

  const retentionDays = effective?.retentionDays ?? stats?.retentionDays ?? 0;
  const retentionDaysOverride =
    effective?.retentionDaysOverride ?? stats?.retentionDaysOverride ?? null;
  const retentionDaysDefault =
    effective?.retentionDaysDefault ?? stats?.retentionDaysDefault ?? 0;

  const totalRuns = stats?.totalRuns ?? 0;
  const oldestExpiresAt = stats?.oldestExpiresAt ?? null;

  const runsLabel =
    totalRuns > 0
      ? `${totalRuns.toLocaleString()} run${totalRuns === 1 ? "" : "s"} on file`
      : "No runs on file yet";

  let detail: string;
  if (retentionDays <= 0) {
    detail = "retention disabled — nothing will fall off automatically";
  } else if (oldestExpiresAt) {
    detail = `oldest expires ${format(
      new Date(oldestExpiresAt),
      "MMM d, yyyy",
    )} (${retentionDays}-day retention)`;
  } else {
    detail = `${retentionDays}-day retention`;
  }

  // Imminent-loss callout: only meaningful when retention is on AND the
  // server actually flagged at least one row inside the warning window.
  // The server already returns 0 here when retention is disabled, so
  // honoring `retentionDays > 0` is belt-and-braces.
  const showNearExpiry =
    retentionDays > 0 && (stats?.nearExpiryCount ?? 0) > 0;
  const nearExpiryCount = stats?.nearExpiryCount ?? 0;
  const nearExpiryWindowDays = stats?.nearExpiryWindowDays ?? 0;

  const startEditing = () => {
    setDraft(
      retentionDaysOverride !== null
        ? String(retentionDaysOverride)
        : String(retentionDaysDefault),
    );
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setDraft("");
  };

  const invalidateAfterSave = () => {
    queryClient.invalidateQueries({
      queryKey: getGetCommsHygieneSettingsQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: ["comms-hygiene-settings"] });
    queryClient.invalidateQueries({
      queryKey: getGetCommsHygieneStatsQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: ["comms-hygiene-stats"] });
  };

  const handleSave = async () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      toast({
        title: "Enter a number",
        description: "Retention must be 0 or more days.",
        variant: "destructive",
      });
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650) {
      toast({
        title: "Invalid retention",
        description: "Enter a whole number between 0 and 3650 days.",
        variant: "destructive",
      });
      return;
    }
    try {
      const updated = await updateSettings.mutateAsync({
        data: { retentionDaysOverride: parsed },
      });
      invalidateAfterSave();
      setEditing(false);
      setDraft("");
      toast({
        title: "Retention updated",
        description:
          updated.retentionDays === 0
            ? "Retention disabled — old runs will no longer be pruned."
            : `Digest history will now be kept for ${updated.retentionDays} day${
                updated.retentionDays === 1 ? "" : "s"
              }.`,
      });
    } catch {
      toast({
        title: "Save failed",
        description: "Could not update retention. Check server logs.",
        variant: "destructive",
      });
    }
  };

  const handleReset = async () => {
    try {
      const updated = await updateSettings.mutateAsync({
        data: { retentionDaysOverride: null },
      });
      invalidateAfterSave();
      setEditing(false);
      setDraft("");
      toast({
        title: "Override cleared",
        description: `Falling back to the ${updated.retentionDaysDefault}-day default.`,
      });
    } catch {
      toast({
        title: "Reset failed",
        description: "Could not clear the override. Check server logs.",
        variant: "destructive",
      });
    }
  };

  return (
    <div
      className="mt-1 mb-3 px-3 py-1.5 font-mono text-[10px] tracking-wide text-muted-foreground/80"
      data-testid="comms-hygiene-retention-footnote"
      data-total-runs={totalRuns}
      data-retention-days={retentionDays}
      data-retention-days-override={
        retentionDaysOverride === null ? "" : retentionDaysOverride
      }
      data-retention-days-default={retentionDaysDefault}
      data-near-expiry-count={nearExpiryCount}
      data-near-expiry-window-days={nearExpiryWindowDays}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="uppercase tracking-widest text-muted-foreground/60">
          Storage:
        </span>
        <span data-testid="comms-hygiene-retention-total">{runsLabel}</span>
        <span className="text-muted-foreground/50">·</span>
        <span data-testid="comms-hygiene-retention-detail">{detail}</span>
        {showNearExpiry && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span
              className="text-warning"
              data-testid="comms-hygiene-retention-near-expiry"
            >
              {nearExpiryCount.toLocaleString()} run
              {nearExpiryCount === 1 ? "" : "s"} expire within{" "}
              {nearExpiryWindowDays} day
              {nearExpiryWindowDays === 1 ? "" : "s"} — export to keep
            </span>
          </>
        )}
        {retentionDaysOverride !== null && (
          <span
            className="px-1.5 py-0.5 border border-primary/40 bg-primary/10 text-primary uppercase tracking-widest text-[9px] rounded-sm"
            data-testid="comms-hygiene-retention-override-badge"
            title={`Override active — env default is ${retentionDaysDefault} day${
              retentionDaysDefault === 1 ? "" : "s"
            }`}
          >
            Override
          </span>
        )}
        {!editing && (
          <button
            type="button"
            onClick={startEditing}
            className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 border border-border/60 hover:border-primary/60 hover:bg-muted/30 rounded-sm uppercase tracking-widest text-[9px] text-muted-foreground hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            data-testid="comms-hygiene-retention-edit"
          >
            <Pencil className="w-2.5 h-2.5" /> Edit
          </button>
        )}
      </div>
      {editing && (
        <div
          className="mt-2 flex flex-wrap items-center gap-2"
          data-testid="comms-hygiene-retention-editor"
        >
          <label
            htmlFor="comms-hygiene-retention-input"
            className="uppercase tracking-widest text-[9px] text-muted-foreground/70"
          >
            Days
          </label>
          <Input
            id="comms-hygiene-retention-input"
            type="number"
            inputMode="numeric"
            min={0}
            max={3650}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={updateSettings.isPending}
            data-testid="comms-hygiene-retention-input"
            className="h-7 w-24 font-mono text-xs tabular-nums"
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={handleSave}
            disabled={updateSettings.isPending}
            data-testid="comms-hygiene-retention-save"
            className="h-7 font-mono uppercase text-[10px] tracking-widest"
          >
            {updateSettings.isPending ? "Saving…" : "Save"}
          </Button>
          {retentionDaysOverride !== null && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleReset}
              disabled={updateSettings.isPending}
              data-testid="comms-hygiene-retention-reset"
              className="h-7 font-mono uppercase text-[10px] tracking-widest"
              title={`Reset to env default (${retentionDaysDefault} day${
                retentionDaysDefault === 1 ? "" : "s"
              })`}
            >
              Reset
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={cancelEditing}
            disabled={updateSettings.isPending}
            data-testid="comms-hygiene-retention-cancel"
            className="h-7 font-mono uppercase text-[10px] tracking-widest"
          >
            Cancel
          </Button>
          <span className="basis-full text-[9px] text-muted-foreground/60 uppercase tracking-widest">
            0 disables pruning · max 3650 · env default {retentionDaysDefault}
          </span>
        </div>
      )}
    </div>
  );
}

function DistroAuditRow({ unit }: { unit: DistroAuditUnit }) {
  return (
    <div
      className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3"
      data-testid={`distro-audit-row-${unit.unitId}`}
    >
      <div className="flex items-start gap-3 min-w-0">
        <div className="w-9 h-9 shrink-0 border border-warning/40 bg-warning/10 text-warning rounded-sm flex items-center justify-center">
          <MailWarning className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/units/${unit.unitId}`}
              className="font-mono font-bold text-sm tracking-wide hover:text-primary focus:outline-none focus-visible:underline"
            >
              {unit.unitName}
            </Link>
            {unit.callsign && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 bg-secondary text-secondary-foreground rounded-sm tracking-widest">
                {unit.callsign}
              </span>
            )}
            <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 border border-border rounded-sm tracking-widest text-muted-foreground">
              {unit.echelon}
            </span>
            <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 bg-warning/15 text-warning border border-warning/40 rounded-sm tracking-widest">
              {unit.invalidCount} bad
            </span>
          </div>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {unit.invalidEntries.map((entry, i) => (
              <li
                key={`${entry.bucket}-${i}-${entry.value}`}
                className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-1 border border-border bg-muted/30 rounded-sm max-w-full"
                title={`${entry.bucket.toUpperCase()}: ${entry.value}`}
              >
                <Mail className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground uppercase tracking-widest">
                  {entry.bucket}
                </span>
                <span className="text-foreground truncate max-w-[18rem]">
                  {entry.value}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="shrink-0 self-start md:self-center">
        <Link
          href={`/units/${unit.unitId}/edit`}
          data-testid={`distro-audit-edit-${unit.unitId}`}
          className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest px-2.5 py-1.5 border border-border hover:border-primary/60 hover:bg-muted/30 rounded-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Pencil className="w-3 h-3" /> Edit Unit
        </Link>
      </div>
    </div>
  );
}
