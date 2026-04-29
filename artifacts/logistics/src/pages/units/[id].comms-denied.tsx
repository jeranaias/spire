import { Title } from "@/components/title";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NumberStepper } from "@/components/ui/number-stepper";
import { StatusBadge } from "@/components/status-badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ShareLinkPanel } from "@/components/share-link-panel";
import { useRoute, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  useGetUnit,
  useListBaselines,
  useCreateBaseline,
  useGetCommsDeniedForecast,
  usePublishCommsDeniedSchedule,
  useListUnitSchedules,
  getListBaselinesQueryKey,
  getListUnitSchedulesQueryKey,
  getGetDashboardOpsecPushesQueryKey,
  type ForecastLine,
  type CommsDeniedForecast,
  CommsDeniedForecastInputBurnModel,
} from "@workspace/api-client-react";
import {
  ArrowLeft,
  Flag,
  Lock,
  Printer,
  Radio,
  RadioTower,
  Send,
  Settings2,
  Shield,
  ShieldAlert,
  TrendingDown,
} from "lucide-react";
import { format } from "date-fns";
import { useState, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { buildShareUrl } from "@/lib/share-url";

const BURN_MODEL_LABELS: Record<string, string> = {
  doctrinal: "Doctrinal Only",
  observed: "Observed Only",
  "worst-of-both": "Worst-of-Both",
};

function statusColor(line: ForecastLine): string {
  if (!line.needsResupply) return "text-success";
  if (line.projectedDaysUntilStockout < 3) return "text-destructive";
  return "text-warning";
}

export default function CommsDeniedPlan() {
  const [, params] = useRoute("/units/:id/comms-denied");
  const unitId = params?.id ?? "";
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: unit } = useGetUnit(unitId, { query: { queryKey: ["unit", unitId] } });
  const { data: baselines } = useListBaselines(unitId, { query: { queryKey: ["baselines", unitId] } });
  const { data: schedules } = useListUnitSchedules(unitId, { query: { queryKey: ["schedules", unitId] } });

  const createBaseline = useCreateBaseline();
  const forecast = useGetCommsDeniedForecast();
  const publish = usePublishCommsDeniedSchedule();

  const [baselineId, setBaselineId] = useState<string>("current");
  const [horizonDays, setHorizonDays] = useState(14);
  const [burnModel, setBurnModel] = useState<CommsDeniedForecastInputBurnModel>("worst-of-both");
  const [safetyMargin, setSafetyMargin] = useState(2);
  const [resupplyLead, setResupplyLead] = useState(2);
  const [forecastResult, setForecastResult] = useState<CommsDeniedForecast | null>(null);
  const [scheduleLabel, setScheduleLabel] = useState("");
  const [newBaselineLabel, setNewBaselineLabel] = useState("");
  const [showSaveBaseline, setShowSaveBaseline] = useState(false);
  const [published, setPublished] = useState<{ id: string; shareToken: string | null } | null>(null);

  const handleForecast = useCallback(async () => {
    try {
      const result = await forecast.mutateAsync({
        unitId,
        data: {
          baselineId: baselineId === "current" ? undefined : baselineId,
          horizonDays,
          burnModel,
          safetyMarginDays: safetyMargin,
          resupplyLeadDays: resupplyLead,
        },
      });
      setForecastResult(result);
    } catch {
      toast({ title: "Forecast failed", variant: "destructive" });
    }
  }, [unitId, baselineId, horizonDays, burnModel, safetyMargin, resupplyLead, forecast, toast]);

  const handleSaveBaseline = useCallback(async () => {
    if (!newBaselineLabel.trim()) return;
    try {
      await createBaseline.mutateAsync({
        unitId,
        data: { label: newBaselineLabel.trim() },
      });
      await qc.invalidateQueries({ queryKey: getListBaselinesQueryKey(unitId) });
      toast({ title: `Baseline "${newBaselineLabel}" saved` });
      setNewBaselineLabel("");
      setShowSaveBaseline(false);
    } catch {
      toast({ title: "Failed to save baseline", variant: "destructive" });
    }
  }, [unitId, newBaselineLabel, createBaseline, qc, toast]);

  const handlePublish = useCallback(async () => {
    if (!forecastResult || !scheduleLabel.trim()) return;
    const lines = forecastResult.lines
      .filter((l) => l.needsResupply && l.recommendedQuantity > 0)
      .map((l) => ({
        itemId: l.itemId,
        itemName: l.itemName,
        supplyClass: l.supplyClass,
        unit: l.unit,
        recommendedQuantity: l.recommendedQuantity,
        recommendedDeliveryDate: l.recommendedDeliveryDate,
      }));

    try {
      const result = await publish.mutateAsync({
        unitId,
        data: {
          label: scheduleLabel.trim(),
          baselineId: baselineId === "current" ? undefined : baselineId,
          horizonDays,
          burnModel,
          safetyMarginDays: safetyMargin,
          resupplyLeadDays: resupplyLead,
          lines,
        },
      });
      await qc.invalidateQueries({ queryKey: getListUnitSchedulesQueryKey(unitId) });
      setPublished({ id: result.id, shareToken: result.shareToken ?? null });
      toast({ title: `Schedule "${result.label}" published — ${result.eventsCreated} push(es) queued` });
    } catch {
      toast({ title: "Failed to publish schedule", variant: "destructive" });
    }
  }, [forecastResult, scheduleLabel, unitId, baselineId, horizonDays, burnModel, safetyMargin, resupplyLead, publish, qc, toast]);

  const needsResupplyLines = forecastResult?.lines.filter((l) => l.needsResupply) ?? [];
  const okLines = forecastResult?.lines.filter((l) => !l.needsResupply) ?? [];

  return (
    <Layout>
      <Title title={`Comms-Denied Plan — ${unit?.unit?.name ?? "..."}`} />

      {/* Print-only header — classification banner, unit, DTG, summary */}
      <div className="hidden print:block mb-4">
        <div className="text-center font-mono font-bold text-base tracking-[0.3em] border-y-2 border-black py-1">
          UNCLASSIFIED
        </div>
        <h1 className="text-center text-lg font-mono font-bold uppercase tracking-[0.15em] mt-3">
          Comms-Denied Resupply Plan
        </h1>
        <div className="flex gap-4 text-xs font-mono mt-3 items-start">
          <div className="flex-1 grid grid-cols-2 gap-4">
            <div>
              <div className="font-bold uppercase tracking-widest">Unit</div>
              <div>{unit?.unit?.name ?? "—"}</div>
              {unit?.unit?.echelon && <div>Echelon: {unit.unit.echelon}</div>}
              {unit?.unit?.commander && <div>Cmdr: {unit.unit.commander}</div>}
            </div>
            <div className="text-right">
              <div className="font-bold uppercase tracking-widest">DTG (Printed)</div>
              <div>{format(new Date(), "ddHHmm'Z' MMM yy").toUpperCase()}</div>
            </div>
          </div>
          {published?.shareToken && (
            <div className="shrink-0 text-center" data-testid="qr-share-url-print-comms-denied">
              <div className="bg-white p-1 border border-black">
                <QRCodeSVG
                  value={buildShareUrl(published.shareToken)}
                  size={88}
                  level="M"
                  marginSize={0}
                />
              </div>
              <div className="font-bold uppercase tracking-widest text-[8px] mt-1">
                Scan to open on mobile
              </div>
            </div>
          )}
        </div>
        {unit?.unit && (
          <div className="grid grid-cols-4 gap-2 text-[10px] font-mono mt-2">
            <div className="border border-black px-2 py-1">
              <div className="font-bold uppercase tracking-widest">Location</div>
              <div className="uppercase">{unit.unit.location || "—"}</div>
            </div>
            <div className="border border-black px-2 py-1">
              <div className="font-bold uppercase tracking-widest">Climate</div>
              <div className="uppercase">{unit.unit.climate || "—"}</div>
            </div>
            <div className="border border-black px-2 py-1">
              <div className="font-bold uppercase tracking-widest">Op Tempo</div>
              <div className="uppercase">{unit.unit.opTempo || "—"}</div>
            </div>
            <div className="border border-black px-2 py-1">
              <div className="font-bold uppercase tracking-widest">Ammo Posture</div>
              <div className="uppercase">{unit.unit.ammoPosture ? unit.unit.ammoPosture.replace("_", " ") : "—"}</div>
            </div>
          </div>
        )}
        {forecastResult && (
          <div className="text-xs font-mono mt-3 p-2 border border-black">
            <span className="font-bold uppercase tracking-widest">Plan: </span>
            {forecastResult.horizonDays}d horizon ·{" "}
            {BURN_MODEL_LABELS[forecastResult.burnModel] ?? forecastResult.burnModel} ·{" "}
            {forecastResult.safetyMarginDays}d safety · {forecastResult.resupplyLeadDays}d lead
            {forecastResult.planningDate && (
              <> · from {format(new Date(forecastResult.planningDate), "ddMMMyy HHmm'Z'").toUpperCase()}</>
            )}
          </div>
        )}
      </div>

      <div className="print:hidden">
        <PageHeader
          title="Comms-Denied Plan"
          tag="OPSEC"
          subtitle={unit?.unit ? `${unit.unit.name} · Pre-coordinated resupply planning` : "Loading..."}
          right={
            <Link href={`/units/${unitId}`}>
              <Button variant="outline" size="sm" className="font-mono uppercase text-[10px] tracking-widest">
                <ArrowLeft className="w-3.5 h-3.5 mr-1.5" /> Back to Unit
              </Button>
            </Link>
          }
        />
      </div>

      <div className="grid lg:grid-cols-3 gap-6 print:block print:gap-0">
        <div className="lg:col-span-1 space-y-4 print:hidden">
          <Card className="border-border">
            <CardHeader className="border-b border-border pb-3 pt-4 px-4">
              <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
                <Settings2 className="w-3.5 h-3.5 text-primary" /> Planning Parameters
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 p-4">
              <div className="space-y-1.5">
                <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Starting Point</Label>
                <Select value={baselineId} onValueChange={setBaselineId}>
                  <SelectTrigger className="font-mono text-xs h-8">
                    <SelectValue placeholder="Current State" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="current" className="font-mono text-xs">Current State</SelectItem>
                    {(baselines ?? []).map((b) => (
                      <SelectItem key={b.id} value={b.id} className="font-mono text-xs">
                        {b.label} · {format(new Date(b.frozenAt), "ddMMMyy").toUpperCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Planning Horizon</Label>
                <NumberStepper value={horizonDays} onChange={setHorizonDays} min={1} step={1} secondaryStep={7} aria-label="Horizon days" />
                <p className="text-[10px] font-mono text-muted-foreground">days</p>
              </div>

              <div className="space-y-1.5">
                <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Burn Model</Label>
                <Select value={burnModel} onValueChange={(v) => setBurnModel(v as CommsDeniedForecastInputBurnModel)}>
                  <SelectTrigger className="font-mono text-xs h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(BURN_MODEL_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k} className="font-mono text-xs">{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Safety Margin (days)</Label>
                <NumberStepper value={safetyMargin} onChange={setSafetyMargin} min={0} step={1} aria-label="Safety margin" />
              </div>

              <div className="space-y-1.5">
                <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Resupply Lead Time (days)</Label>
                <NumberStepper value={resupplyLead} onChange={setResupplyLead} min={0} step={1} aria-label="Resupply lead days" />
              </div>

              <Button
                onClick={handleForecast}
                disabled={forecast.isPending}
                className="w-full font-mono uppercase text-xs tracking-widest"
              >
                <TrendingDown className="w-3.5 h-3.5 mr-2" />
                {forecast.isPending ? "Projecting..." : "Run Forecast"}
              </Button>
            </CardContent>
          </Card>

          <Card className="border-border">
            <CardHeader className="border-b border-border pb-3 pt-4 px-4">
              <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
                <Lock className="w-3.5 h-3.5 text-primary" /> Last Known Good Baselines
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              {(!baselines || baselines.length === 0) && (
                <p className="text-[10px] font-mono text-muted-foreground">No baselines saved yet.</p>
              )}
              {(baselines ?? []).map((b) => (
                <div key={b.id} className="flex items-start justify-between py-1 border-b border-border/50 last:border-0">
                  <div>
                    <div className="font-mono text-xs font-bold">{b.label}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {format(new Date(b.frozenAt), "ddHHmm'Z' MMM yy").toUpperCase()} · {b.snapshotData.items.length} items
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="font-mono text-[10px] h-6 px-2 text-muted-foreground"
                    onClick={() => setBaselineId(b.id)}
                  >
                    Use
                  </Button>
                </div>
              ))}

              {!showSaveBaseline ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full font-mono uppercase text-[10px] tracking-widest"
                  onClick={() => setShowSaveBaseline(true)}
                >
                  <Flag className="w-3 h-3 mr-1.5" /> Mark Last Known Good
                </Button>
              ) : (
                <div className="space-y-2">
                  <Input
                    value={newBaselineLabel}
                    onChange={(e) => setNewBaselineLabel(e.target.value)}
                    placeholder={`Pre-EMCON ${format(new Date(), "ddMMM").toUpperCase()}`}
                    className="font-mono text-xs h-8"
                    onKeyDown={(e) => e.key === "Enter" && handleSaveBaseline()}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1 font-mono uppercase text-[10px] tracking-widest"
                      onClick={handleSaveBaseline}
                      disabled={createBaseline.isPending || !newBaselineLabel.trim()}
                    >
                      {createBaseline.isPending ? "Saving..." : "Save"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="font-mono text-[10px]"
                      onClick={() => { setShowSaveBaseline(false); setNewBaselineLabel(""); }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {schedules && schedules.length > 0 && (
            <Card className="border-border">
              <CardHeader className="border-b border-border pb-3 pt-4 px-4">
                <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
                  <RadioTower className="w-3.5 h-3.5 text-primary" /> Published Schedules
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-2">
                {schedules.map((s) => (
                  <div key={s.id} className="py-2 border-b border-border/50 last:border-0">
                    <div className="font-mono text-xs font-bold">{s.label}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {s.publishedAt ? format(new Date(s.publishedAt), "ddMMMyy HHmm'Z'").toUpperCase() : "Draft"} · {s.horizonDays}d · {BURN_MODEL_LABELS[s.burnModel] ?? s.burnModel}
                    </div>
                    <Link href={`/schedules/${s.id}`}>
                      <button className="font-mono text-[10px] text-primary hover:underline mt-0.5">View schedule →</button>
                    </Link>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="lg:col-span-2 space-y-4">
          {!forecastResult ? (
            <>
              <div className="h-full min-h-[400px] border border-dashed border-border/50 rounded-sm flex flex-col items-center justify-center text-muted-foreground bg-card/30 gap-4 print:hidden">
                <Radio className="w-10 h-10 opacity-10" />
                <div className="text-center space-y-1">
                  <p className="font-mono text-xs tracking-widest uppercase">Configure parameters and run forecast</p>
                  <p className="font-mono text-[10px] text-muted-foreground/60">Pre-coordinated delivery schedule will appear here</p>
                </div>
              </div>
              <div className="hidden print:block text-xs font-mono p-4 border border-black">
                No forecast has been generated. Run a forecast on screen before printing this plan.
              </div>
            </>
          ) : (
            <>
              <Card className="border-border">
                <CardHeader className="border-b border-border pb-3 pt-4 px-4 flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
                      <ShieldAlert className="w-3.5 h-3.5 text-primary" /> Comms-Denied Forecast
                    </CardTitle>
                    <p className="font-mono text-[10px] text-muted-foreground mt-1">
                      {forecastResult.horizonDays}d horizon · {BURN_MODEL_LABELS[forecastResult.burnModel]} · {forecastResult.safetyMarginDays}d safety · from {forecastResult.planningDate ? format(new Date(forecastResult.planningDate), "ddMMMyy HHmm'Z'").toUpperCase() : "—"}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="font-mono uppercase text-[10px] tracking-widest print:hidden"
                    onClick={() => window.print()}
                  >
                    <Printer className="w-3 h-3 mr-1.5" /> Print
                  </Button>
                </CardHeader>
                <CardContent className="p-0">
                  {needsResupplyLines.length > 0 && (
                    <>
                      <div className="px-4 py-2 bg-destructive/5 border-b border-border font-mono text-[10px] uppercase tracking-widest text-destructive flex items-center gap-1.5 print:hidden">
                        <ShieldAlert className="w-3 h-3" /> {needsResupplyLines.length} item{needsResupplyLines.length !== 1 ? "s" : ""} require resupply within horizon
                      </div>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border bg-muted/20">
                            <th className="px-4 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Item</th>
                            <th className="px-4 py-2 text-right font-mono text-[10px] uppercase tracking-widest text-muted-foreground">On-Hand</th>
                            <th className="px-4 py-2 text-right font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Stockout</th>
                            <th className="px-4 py-2 text-right font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Req Qty</th>
                            <th className="px-4 py-2 text-right font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Delivery</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {needsResupplyLines.map((line) => (
                            <tr key={line.itemId} className="hover:bg-muted/10">
                              <td className="px-4 py-2.5">
                                <div className="font-mono font-bold text-xs">{line.itemName}</div>
                                <div className="font-mono text-[10px] text-muted-foreground">Class {line.supplyClass} · {line.effectiveDailyRate.toFixed(2)}/day</div>
                                <div className="font-mono text-[10px] text-muted-foreground/60">
                                  Doc: {line.doctrinalDailyRate.toFixed(2)} {line.observedDailyRate != null ? `· Obs: ${line.observedDailyRate.toFixed(2)}` : ""}
                                </div>
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums">
                                {line.startingOnHand.toFixed(1)} {line.unit}
                              </td>
                              <td className={`px-4 py-2.5 text-right font-mono text-xs tabular-nums font-bold ${statusColor(line)}`}>
                                {line.projectedStockoutDate
                                  ? format(new Date(line.projectedStockoutDate), "ddMMMyy").toUpperCase()
                                  : `D+${Math.round(line.projectedDaysUntilStockout)}`}
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums font-bold text-primary">
                                {line.recommendedQuantity.toFixed(1)} {line.unit}
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums">
                                {line.recommendedDeliveryDate
                                  ? format(new Date(line.recommendedDeliveryDate), "ddMMMyy").toUpperCase()
                                  : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                  {needsResupplyLines.length === 0 && (
                    <div className="hidden print:block px-4 py-3 border-b border-black text-xs font-mono">
                      No items require resupply within the {forecastResult.horizonDays}-day horizon. All on-hand stocks projected sufficient.
                    </div>
                  )}
                  {okLines.length > 0 && (
                    <div className="border-t border-border print:hidden">
                      <div className="px-4 py-2 bg-success/5 font-mono text-[10px] uppercase tracking-widest text-success flex items-center gap-1.5">
                        <Shield className="w-3 h-3" /> {okLines.length} item{okLines.length !== 1 ? "s" : ""} sufficient for horizon
                      </div>
                      <table className="w-full text-sm">
                        <tbody className="divide-y divide-border/50">
                          {okLines.map((line) => (
                            <tr key={line.itemId} className="hover:bg-muted/5 opacity-60">
                              <td className="px-4 py-2">
                                <div className="font-mono text-xs">{line.itemName}</div>
                                <div className="font-mono text-[10px] text-muted-foreground">Class {line.supplyClass}</div>
                              </td>
                              <td className="px-4 py-2 text-right font-mono text-xs tabular-nums">
                                {line.startingOnHand.toFixed(1)} {line.unit}
                              </td>
                              <td className="px-4 py-2 text-right font-mono text-xs tabular-nums text-success font-bold">
                                D+{Math.round(line.projectedDaysUntilStockout) >= 999 ? "∞" : Math.round(line.projectedDaysUntilStockout)}
                              </td>
                              <td className="px-4 py-2 text-right font-mono text-xs text-muted-foreground">—</td>
                              <td className="px-4 py-2 text-right font-mono text-xs text-muted-foreground">—</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>

              {needsResupplyLines.length > 0 && (
                <Card className="border-border border-primary/30 print:hidden">
                  <CardHeader className="border-b border-border pb-3 pt-4 px-4">
                    <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
                      <Send className="w-3.5 h-3.5 text-primary" /> Publish Pre-Coordinated Schedule
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    {published ? (
                      <div className="space-y-3">
                        <div className="p-3 bg-success/10 border border-success/30 rounded-sm font-mono text-xs text-success">
                          Schedule published — {needsResupplyLines.length} resupply push(es) queued. Supporting echelon can execute without further comms.
                        </div>
                        <div className="flex gap-3 items-start">
                          {published.shareToken && (
                            <div
                              className="shrink-0 bg-white p-2 border border-border rounded-sm"
                              data-testid="qr-share-url"
                              aria-label="QR code for the public share URL"
                            >
                              <QRCodeSVG
                                value={buildShareUrl(published.shareToken)}
                                size={96}
                                level="M"
                                marginSize={0}
                              />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <ShareLinkPanel
                              scheduleId={published.id}
                              shareToken={published.shareToken}
                              onTokenChange={(newToken) =>
                                setPublished((prev) => (prev ? { ...prev, shareToken: newToken } : prev))
                              }
                              invalidateKeys={[
                                getListUnitSchedulesQueryKey(unitId),
                                getGetDashboardOpsecPushesQueryKey(),
                              ]}
                            />
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Link href={`/schedules/${published.id}`}>
                            <Button size="sm" variant="outline" className="font-mono uppercase text-[10px] tracking-widest">
                              View Schedule
                            </Button>
                          </Link>
                          <Button
                            size="sm"
                            variant="outline"
                            className="font-mono uppercase text-[10px] tracking-widest"
                            onClick={() => window.print()}
                          >
                            <Printer className="w-3 h-3 mr-1.5" /> Print
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <p className="font-mono text-[10px] text-muted-foreground">
                          This will write {needsResupplyLines.length} planned resupply push{needsResupplyLines.length !== 1 ? "es" : ""} to the resupply schedule. The supporting unit can execute these without further comms with {forecastResult.unitName}.
                        </p>
                        <div className="flex gap-2 items-end">
                          <div className="flex-1 space-y-1.5">
                            <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Schedule Name</Label>
                            <Input
                              value={scheduleLabel}
                              onChange={(e) => setScheduleLabel(e.target.value)}
                              placeholder={`Pre-EMCON ${format(new Date(), "ddMMMyy").toUpperCase()}`}
                              className="font-mono text-xs h-8"
                            />
                          </div>
                          <Button
                            onClick={handlePublish}
                            disabled={publish.isPending || !scheduleLabel.trim()}
                            className="font-mono uppercase text-xs tracking-widest whitespace-nowrap"
                          >
                            <Send className="w-3.5 h-3.5 mr-2" />
                            {publish.isPending ? "Publishing..." : "Publish Schedule"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      </div>

      {/* Print-only signature block + classification footer */}
      <div className="hidden print:block mt-8">
        <div className="grid grid-cols-2 gap-8 text-xs font-mono">
          <div>
            <div className="border-b border-black h-12"></div>
            <div className="font-bold uppercase tracking-widest mt-1">
              Commander{unit?.unit?.commander ? ` (${unit.unit.commander})` : ""} — Signature / Date
            </div>
          </div>
          <div>
            <div className="border-b border-black h-12"></div>
            <div className="font-bold uppercase tracking-widest mt-1">Received By — Signature / Date</div>
          </div>
        </div>
        <div className="text-center font-mono font-bold text-base tracking-[0.3em] border-y-2 border-black py-1 mt-8">
          UNCLASSIFIED
        </div>
      </div>
    </Layout>
  );
}
