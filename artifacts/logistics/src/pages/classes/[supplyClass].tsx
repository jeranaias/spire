import { Title } from "@/components/title";
import { Layout } from "@/components/layout";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  useGetClassDetail,
  getGetClassDetailQueryKey,
  useGetDodicBreakdown,
  getGetDodicBreakdownQueryKey,
  SupplyClass,
} from "@workspace/api-client-react";
import { Link, useRoute } from "wouter";
import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  MapPin,
  Package,
  ShieldAlert,
  Target,
  Users,
} from "lucide-react";
import { Fragment, useState } from "react";
import NotFound from "@/pages/not-found";

const VALID_CLASSES = new Set<string>(Object.values(SupplyClass));

const STATUS_GLYPH = { green: "■", amber: "●", red: "◆" } as const;
const STATUS_TEXT = {
  green: "text-success",
  amber: "text-warning",
  red: "text-destructive",
} as const;
const STATUS_BORDER = {
  green: "border-success/30 bg-success/10",
  amber: "border-warning/30 bg-warning/10",
  red: "border-destructive/30 bg-destructive/10",
} as const;
const STATUS_PILL = {
  green: "bg-success/15 border-success/30 text-success",
  amber: "bg-warning/15 border-warning/30 text-warning",
  red: "bg-destructive/15 border-destructive/30 text-destructive",
} as const;

export default function ClassDetailPage() {
  const [, params] = useRoute("/classes/:supplyClass");
  const raw = params?.supplyClass ?? "";

  if (!VALID_CLASSES.has(raw)) {
    return <NotFound />;
  }
  const supplyClass = raw as SupplyClass;

  const { data, isLoading } = useGetClassDetail(supplyClass, {
    query: { queryKey: getGetClassDetailQueryKey(supplyClass) },
  });

  const isClassV = supplyClass === SupplyClass.V;
  const { data: dodicData, isLoading: dodicLoading } = useGetDodicBreakdown({
    query: {
      queryKey: getGetDodicBreakdownQueryKey(),
      enabled: isClassV,
    },
  });

  const [expandedDodic, setExpandedDodic] = useState<Record<string, boolean>>({});

  return (
    <Layout>
      <Title
        title={`Class ${supplyClass}`}
        description={`Class ${supplyClass} drill-down across all units`}
      />

      <Link href="/">
        <Button
          variant="ghost"
          size="sm"
          className="mb-4 font-mono uppercase text-[10px] tracking-widest"
        >
          <ArrowLeft className="w-3.5 h-3.5 mr-1.5" /> Dashboard
        </Button>
      </Link>

      <PageHeader
        title={`Class ${supplyClass}`}
        tag="Supply Class"
        subtitle={
          data?.label
            ? `${data.label} — status across all subordinate elements`
            : "Status across all subordinate elements"
        }
      />

      {isLoading || !data ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 bg-muted animate-pulse rounded-sm" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
            <Card className="border-border">
              <CardContent className="p-4 flex flex-col justify-center">
                <div className="text-[10px] text-muted-foreground font-mono mb-2 flex items-center gap-1.5 tracking-widest uppercase">
                  <Package className="w-3.5 h-3.5" /> Items Tracked
                </div>
                <div className="text-3xl font-bold font-mono tabular-nums">
                  {data.totals.green + data.totals.amber + data.totals.red}
                </div>
              </CardContent>
            </Card>
            <Card
              className={
                data.totals.unitsAtRisk > 0
                  ? "border-destructive/40 bg-destructive/5"
                  : "border-border"
              }
            >
              <CardContent className="p-4 flex flex-col justify-center">
                <div className="text-[10px] text-muted-foreground font-mono mb-2 flex items-center gap-1.5 tracking-widest uppercase">
                  <AlertCircle className="w-3.5 h-3.5" /> Units At Risk
                </div>
                <div
                  className={`text-3xl font-bold font-mono tabular-nums ${data.totals.unitsAtRisk > 0 ? "text-destructive" : ""}`}
                >
                  {data.totals.unitsAtRisk}
                  <span className="text-sm text-muted-foreground font-normal">
                    {" "}
                    / {data.totals.unitsTracking}
                  </span>
                </div>
              </CardContent>
            </Card>
            <Card className="border-border">
              <CardContent className="p-4 flex flex-col justify-center">
                <div className="text-[10px] text-muted-foreground font-mono mb-2 flex items-center gap-1.5 tracking-widest uppercase">
                  <ShieldAlert className="w-3.5 h-3.5" /> Amber
                </div>
                <div className="text-3xl font-bold font-mono tabular-nums text-warning">
                  {data.totals.amber}
                </div>
              </CardContent>
            </Card>
            <Card className="border-border">
              <CardContent className="p-4 flex flex-col justify-center">
                <div className="text-[10px] text-muted-foreground font-mono mb-2 flex items-center gap-1.5 tracking-widest uppercase">
                  <ShieldAlert className="w-3.5 h-3.5" /> Red
                </div>
                <div className="text-3xl font-bold font-mono tabular-nums text-destructive">
                  {data.totals.red}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* ── Class V: Regiment-wide DODIC Breakdown ── */}
          {isClassV && (
            <div className="mb-8" id="dodic-breakdown">
              <SectionHeader subtitle="weapon-driven ammo burn aggregated across every unit">
                Regiment DODIC Breakdown
              </SectionHeader>
              {dodicLoading ? (
                <div className="h-32 bg-muted animate-pulse rounded-sm" />
              ) : !dodicData || dodicData.items.length === 0 ? (
                <div className="bg-card border border-border p-12 rounded-sm text-center text-muted-foreground font-mono text-xs tracking-widest uppercase">
                  No DODIC-coded ammunition tracked. Map weapon systems to units to populate this view.
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                    <Card className="border-border">
                      <CardContent className="p-3">
                        <div className="text-[10px] text-muted-foreground font-mono tracking-widest uppercase mb-1">DODICs</div>
                        <div className="text-2xl font-bold font-mono tabular-nums">{dodicData.totals.dodicCount}</div>
                      </CardContent>
                    </Card>
                    <Card className="border-border">
                      <CardContent className="p-3">
                        <div className="text-[10px] text-muted-foreground font-mono tracking-widest uppercase mb-1">On Hand (rds)</div>
                        <div className="text-2xl font-bold font-mono tabular-nums">{Math.round(dodicData.totals.totalOnHand).toLocaleString()}</div>
                      </CardContent>
                    </Card>
                    <Card className="border-border">
                      <CardContent className="p-3">
                        <div className="text-[10px] text-muted-foreground font-mono tracking-widest uppercase mb-1">Daily Burn</div>
                        <div className="text-2xl font-bold font-mono tabular-nums">{Math.round(dodicData.totals.totalDailyRequired).toLocaleString()}</div>
                      </CardContent>
                    </Card>
                    <Card className={dodicData.totals.totalShortfall > 0 ? "border-destructive/40 bg-destructive/5" : "border-border"}>
                      <CardContent className="p-3">
                        <div className="text-[10px] text-muted-foreground font-mono tracking-widest uppercase mb-1">Shortfall</div>
                        <div className={`text-2xl font-bold font-mono tabular-nums ${dodicData.totals.totalShortfall > 0 ? "text-destructive" : "text-success"}`}>
                          {dodicData.totals.totalShortfall > 0 ? `-${Math.round(dodicData.totals.totalShortfall).toLocaleString()}` : "0"}
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                  <div className="bg-card border border-border rounded-sm overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs font-mono">
                        <thead className="bg-muted/30 border-b border-border">
                          <tr className="text-left">
                            <th className="px-3 py-2 w-6"></th>
                            <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold">Status</th>
                            <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold">DODIC</th>
                            <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold">Nomenclature</th>
                            <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold text-right">On Hand</th>
                            <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold text-right">Daily Burn</th>
                            <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold text-right">Aggregate DOS</th>
                            <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold text-right">Shortfall</th>
                            <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold text-right">Units Short</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {dodicData.items.map((d) => {
                            const isOpen = !!expandedDodic[d.catalogItemId];
                            const dodicLabel = d.dodic || "—";
                            return (
                              <Fragment key={d.catalogItemId}>
                                <tr
                                  className="hover:bg-muted/20 transition-colors cursor-pointer"
                                  onClick={() =>
                                    setExpandedDodic((prev) => ({
                                      ...prev,
                                      [d.catalogItemId]: !prev[d.catalogItemId],
                                    }))
                                  }
                                  aria-expanded={isOpen}
                                  aria-controls={`dodic-units-${d.catalogItemId}`}
                                >
                                  <td className="px-3 py-2 text-muted-foreground">
                                    {isOpen ? (
                                      <ChevronDown className="w-3.5 h-3.5" />
                                    ) : (
                                      <ChevronRight className="w-3.5 h-3.5" />
                                    )}
                                  </td>
                                  <td className="px-3 py-2">
                                    <span className={`inline-flex items-center gap-1 border px-1.5 py-0.5 rounded-sm text-[10px] ${STATUS_PILL[d.status]}`}>
                                      {STATUS_GLYPH[d.status]}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 font-bold tracking-widest">{dodicLabel}</td>
                                  <td className="px-3 py-2 text-foreground">{d.nomenclature}</td>
                                  <td className="px-3 py-2 text-right tabular-nums">
                                    {Math.round(d.totalOnHand).toLocaleString()} {d.unit}
                                  </td>
                                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                                    {Math.round(d.totalDailyRequired).toLocaleString()} {d.unit}/d
                                  </td>
                                  <td className={`px-3 py-2 text-right tabular-nums font-bold ${STATUS_TEXT[d.status]}`}>
                                    {d.aggregateDaysOfSupply >= 999 ? "—" : `${d.aggregateDaysOfSupply} D`}
                                  </td>
                                  <td className={`px-3 py-2 text-right tabular-nums font-bold ${d.totalShortfall > 0 ? "text-destructive" : "text-success"}`}>
                                    {d.totalShortfall > 0 ? `-${Math.round(d.totalShortfall).toLocaleString()}` : "—"}
                                  </td>
                                  <td className="px-3 py-2 text-right tabular-nums">
                                    <span className={d.unitsShort > 0 ? "text-destructive font-bold" : "text-muted-foreground"}>
                                      {d.unitsShort}
                                    </span>
                                    <span className="text-muted-foreground"> / {d.unitsTracking}</span>
                                  </td>
                                </tr>
                                {isOpen && (
                                  <tr id={`dodic-units-${d.catalogItemId}`} className="bg-muted/10">
                                    <td colSpan={9} className="px-3 py-3">
                                      {d.contributingUnits.length === 0 ? (
                                        <div className="text-[10px] font-mono text-muted-foreground tracking-widest uppercase text-center py-3">
                                          No contributing units.
                                        </div>
                                      ) : (
                                        <div className="overflow-x-auto">
                                          <table className="w-full text-[11px] font-mono">
                                            <thead>
                                              <tr className="text-left text-[10px] tracking-widest uppercase text-muted-foreground">
                                                <th className="px-2 py-1 font-bold">Unit</th>
                                                <th className="px-2 py-1 font-bold uppercase">Echelon</th>
                                                <th className="px-2 py-1 font-bold text-right">On Hand</th>
                                                <th className="px-2 py-1 font-bold text-right">Daily</th>
                                                <th className="px-2 py-1 font-bold text-right">Required</th>
                                                <th className="px-2 py-1 font-bold text-right">Shortfall</th>
                                                <th className="px-2 py-1 font-bold text-right">DOS</th>
                                              </tr>
                                            </thead>
                                            <tbody className="divide-y divide-border/60">
                                              {d.contributingUnits.map((u) => (
                                                <tr key={u.unitId} className="hover:bg-muted/30 transition-colors">
                                                  <td className="px-2 py-1.5">
                                                    <Link
                                                      href={`/units/${u.unitId}`}
                                                      onClick={(e) => e.stopPropagation()}
                                                      className="hover:text-primary hover:underline"
                                                    >
                                                      {u.unitName}
                                                    </Link>
                                                    {u.callsign && (
                                                      <span className="ml-2 text-[10px] px-1 py-0.5 bg-secondary text-secondary-foreground rounded-sm tracking-widest">
                                                        {u.callsign}
                                                      </span>
                                                    )}
                                                  </td>
                                                  <td className="px-2 py-1.5 uppercase text-muted-foreground">{u.echelon}</td>
                                                  <td className="px-2 py-1.5 text-right tabular-nums">{Math.round(u.onHand).toLocaleString()}</td>
                                                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{Math.round(u.dailyRequired).toLocaleString()}</td>
                                                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{Math.round(u.required).toLocaleString()}</td>
                                                  <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${u.shortfall > 0 ? "text-destructive" : "text-success"}`}>
                                                    {u.shortfall > 0 ? `-${Math.round(u.shortfall).toLocaleString()}` : "—"}
                                                  </td>
                                                  <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${STATUS_TEXT[u.status]}`}>
                                                    {u.daysOfSupply >= 999 ? "—" : u.daysOfSupply}
                                                  </td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
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
                  </div>
                </>
              )}
            </div>
          )}

          <div className="mb-8">
            <SectionHeader subtitle="status of every unit for this class">
              Units
            </SectionHeader>
            <div className="bg-card border border-border rounded-sm">
              {data.units.length === 0 ? (
                <div className="p-12 text-center text-muted-foreground font-mono text-xs tracking-widest uppercase">
                  No units configured.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {data.units.map((u) => (
                    <Link
                      key={u.unitId}
                      href={`/units/${u.unitId}`}
                      className="block hover:bg-muted/20 transition-colors p-4 group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                    >
                      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <div className="flex items-start gap-3">
                          <div
                            className={`w-10 h-10 shrink-0 border rounded-sm flex items-center justify-center ${STATUS_BORDER[u.worstStatus]} ${STATUS_TEXT[u.worstStatus]}`}
                          >
                            <ShieldAlert className="w-5 h-5" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="font-mono font-bold text-sm tracking-wide group-hover:text-primary transition-colors">
                                {u.unitName}
                              </h3>
                              {u.callsign && (
                                <span className="text-[10px] font-mono px-1.5 py-0.5 bg-secondary text-secondary-foreground rounded-sm tracking-widest">
                                  {u.callsign}
                                </span>
                              )}
                            </div>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[10px] text-muted-foreground font-mono tracking-wide">
                              <div className="flex items-center gap-1">
                                <Users className="w-3 h-3" /> {u.personnel} PAX
                              </div>
                              <div className="flex items-center gap-1 uppercase">
                                <Target className="w-3 h-3" /> {u.echelon}
                              </div>
                              {u.location && (
                                <div className="flex items-center gap-1">
                                  <MapPin className="w-3 h-3" /> {u.location}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-4 shrink-0">
                          {u.itemCount === 0 ? (
                            <span className="text-[10px] font-mono text-muted-foreground tracking-widest uppercase">
                              No items
                            </span>
                          ) : (
                            <>
                              <div className="flex gap-1.5">
                                <span className="px-1.5 py-0.5 bg-success/15 border border-success/30 text-success text-[10px] font-mono rounded-sm tabular-nums">
                                  ■ {u.greenCount}
                                </span>
                                <span className="px-1.5 py-0.5 bg-warning/15 border border-warning/30 text-warning text-[10px] font-mono rounded-sm tabular-nums">
                                  ● {u.amberCount}
                                </span>
                                <span className="px-1.5 py-0.5 bg-destructive/15 border border-destructive/30 text-destructive text-[10px] font-mono rounded-sm tabular-nums">
                                  ◆ {u.redCount}
                                </span>
                              </div>
                              <div className="text-right min-w-[5rem]">
                                <div
                                  className={`text-xs font-mono font-bold ${STATUS_TEXT[u.worstStatus]}`}
                                >
                                  {STATUS_GLYPH[u.worstStatus]}{" "}
                                  {u.worstDaysOfSupply >= 999
                                    ? "—"
                                    : `${u.worstDaysOfSupply} D`}
                                </div>
                                <div className="text-[10px] text-muted-foreground font-mono tracking-widest uppercase">
                                  Worst DoS
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Class V: Combat Load Gap view ── */}
          {supplyClass === SupplyClass.V && data.items.some((it) => (it.combatLoadTarget ?? 0) > 0) && (
            <div className="mb-8">
              <SectionHeader subtitle="weapon-driven combat load vs on-hand — sorted by gap">
                Combat Load Gap — Class V
              </SectionHeader>
              <div className="bg-card border border-border rounded-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono">
                    <thead className="bg-muted/30 border-b border-border">
                      <tr className="text-left">
                        <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold">Status</th>
                        <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold">Unit</th>
                        <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold">DODIC / Item</th>
                        <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold">Burn Model</th>
                        <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold text-right">CL Target</th>
                        <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold text-right">On Hand</th>
                        <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold text-right">Gap</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.items
                        .filter((it) => (it.combatLoadTarget ?? 0) > 0)
                        .sort((a, b) => {
                          const gapA = Math.max(0, (a.combatLoadTarget ?? 0) - a.onHand);
                          const gapB = Math.max(0, (b.combatLoadTarget ?? 0) - b.onHand);
                          return gapB - gapA;
                        })
                        .map((it) => {
                          const target = it.combatLoadTarget ?? 0;
                          const gap = Math.max(0, target - it.onHand);
                          const pct = target > 0 ? Math.round((it.onHand / target) * 100) : 100;
                          return (
                            <tr key={it.entryId} className="hover:bg-muted/20 transition-colors">
                              <td className="px-3 py-2">
                                <span className={`inline-flex items-center gap-1 border px-1.5 py-0.5 rounded-sm text-[10px] ${STATUS_PILL[it.status]}`}>
                                  {STATUS_GLYPH[it.status]}
                                </span>
                              </td>
                              <td className="px-3 py-2">
                                <Link href={`/units/${it.unitId}`} className="hover:text-primary hover:underline">{it.unitName}</Link>
                              </td>
                              <td className="px-3 py-2 text-foreground">{it.itemName}</td>
                              <td className="px-3 py-2 text-muted-foreground text-[10px]">{it.burnBreakdown ?? "—"}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{Math.round(target).toLocaleString()} {it.unit}</td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                <span className={pct >= 100 ? "text-success" : pct >= 70 ? "text-warning" : "text-destructive"}>{it.onHand.toLocaleString()}</span>
                              </td>
                              <td className={`px-3 py-2 text-right tabular-nums font-bold ${gap > 0 ? "text-destructive" : "text-success"}`}>
                                {gap > 0 ? `-${Math.round(gap).toLocaleString()}` : "—"}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          <div className="mb-8">
            <SectionHeader subtitle="every tracked item, sorted by status">
              {supplyClass === SupplyClass.V ? "All Ammunition Items" : "Items"}
            </SectionHeader>
            {data.items.length === 0 ? (
              <div className="bg-card border border-border p-12 rounded-sm text-center text-muted-foreground font-mono text-xs tracking-widest uppercase">
                No items tracked for Class {supplyClass}.
              </div>
            ) : (
              <div className="bg-card border border-border rounded-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs font-mono">
                    <thead className="bg-muted/30 border-b border-border">
                      <tr className="text-left">
                        <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold">
                          Status
                        </th>
                        <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold">
                          Unit
                        </th>
                        <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold">
                          Item
                        </th>
                        {supplyClass === SupplyClass.V && (
                          <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold">
                            Burn Model
                          </th>
                        )}
                        <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold text-right tabular-nums">
                          On Hand
                        </th>
                        <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold text-right tabular-nums">
                          Required
                        </th>
                        <th className="px-3 py-2 text-[10px] tracking-widest uppercase text-muted-foreground font-bold text-right tabular-nums">
                          DoS
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.items.map((it) => (
                        <tr key={it.entryId} className="hover:bg-muted/20 transition-colors">
                          <td className="px-3 py-2">
                            <span
                              className={`inline-flex items-center gap-1 border px-1.5 py-0.5 rounded-sm text-[10px] tabular-nums ${STATUS_PILL[it.status]}`}
                            >
                              {STATUS_GLYPH[it.status]}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <Link
                              href={`/units/${it.unitId}`}
                              className="hover:text-primary hover:underline"
                            >
                              {it.unitName}
                            </Link>
                          </td>
                          <td className="px-3 py-2 text-foreground">
                            {it.itemName}
                          </td>
                          {supplyClass === SupplyClass.V && (
                            <td className="px-3 py-2 text-muted-foreground text-[10px]">
                              {it.burnBreakdown ?? "—"}
                            </td>
                          )}
                          <td className="px-3 py-2 text-right tabular-nums">
                            {it.onHand} {it.unit}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                            {it.required} {it.unit}
                          </td>
                          <td
                            className={`px-3 py-2 text-right tabular-nums font-bold ${STATUS_TEXT[it.status]}`}
                          >
                            {it.daysOfSupply >= 999 ? "—" : it.daysOfSupply}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </Layout>
  );
}
