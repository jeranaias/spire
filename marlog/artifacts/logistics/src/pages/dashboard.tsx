import { Title } from "@/components/title";
import { Layout } from "@/components/layout";
import { PageHeader, SectionHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  useGetDashboardSummary, 
  useGetResupplyForecast
} from "@workspace/api-client-react";
import { AlertCircle, Package, ShieldAlert, Users } from "lucide-react";
import { format } from "date-fns";

export default function Dashboard() {
  const { data: summary, isLoading: loadingSummary } = useGetDashboardSummary({
    query: { queryKey: ["dashboard"] }
  });
  const { data: forecast, isLoading: loadingForecast } = useGetResupplyForecast({
    query: { queryKey: ["forecast"] }
  });

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
            <Card className="border-border">
              <CardContent className="p-4 flex flex-col justify-center">
                <div className="text-[10px] text-muted-foreground font-mono mb-2 flex items-center gap-1.5 tracking-widest uppercase">
                  <ShieldAlert className="w-3.5 h-3.5" /> Units
                </div>
                <div className="text-3xl font-bold font-mono tabular-nums">{summary.unitCount}</div>
              </CardContent>
            </Card>
            <Card className="border-border">
              <CardContent className="p-4 flex flex-col justify-center">
                <div className="text-[10px] text-muted-foreground font-mono mb-2 flex items-center gap-1.5 tracking-widest uppercase">
                  <Users className="w-3.5 h-3.5" /> PAX
                </div>
                <div className="text-3xl font-bold font-mono tabular-nums">{summary.personnelCount}</div>
              </CardContent>
            </Card>
            <Card className={summary.criticalDeficiencyCount > 0 ? "border-destructive/40 bg-destructive/5" : "border-border"}>
              <CardContent className="p-4 flex flex-col justify-center">
                <div className="text-[10px] text-muted-foreground font-mono mb-2 flex items-center gap-1.5 tracking-widest uppercase">
                  <AlertCircle className="w-3.5 h-3.5" /> Crit Defs
                </div>
                <div className={`text-3xl font-bold font-mono tabular-nums ${summary.criticalDeficiencyCount > 0 ? "text-destructive" : ""}`}>
                  {summary.criticalDeficiencyCount}
                </div>
              </CardContent>
            </Card>
            <Card className="border-border">
              <CardContent className="p-4 flex flex-col justify-center">
                <div className="text-[10px] text-muted-foreground font-mono mb-2 flex items-center gap-1.5 tracking-widest uppercase">
                  <Package className="w-3.5 h-3.5" /> Resupplies
                </div>
                <div className="text-3xl font-bold font-mono tabular-nums">{summary.upcomingResupplyCount}</div>
              </CardContent>
            </Card>
          </div>

          <div className="grid md:grid-cols-2 gap-8 mb-8">
            <div>
              <SectionHeader subtitle="by supply class">Class Breakdown</SectionHeader>
              <div className="space-y-1.5">
                {summary.classBreakdown.map((cb) => (
                  <div key={cb.supplyClass} className="bg-card border border-border p-3 rounded-sm flex items-center justify-between">
                    <div className="font-mono text-xs">
                      <span className="font-bold text-primary tracking-widest mr-2">CLASS {cb.supplyClass}</span>
                      <span className="text-muted-foreground">{cb.label}</span>
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
                  </div>
                ))}
              </div>
            </div>

            <div>
              <SectionHeader subtitle="next 5 days">Critical Forecast</SectionHeader>
              {loadingForecast ? (
                <div className="h-32 bg-muted animate-pulse rounded-sm" />
              ) : forecast && forecast.length > 0 ? (
                <div className="space-y-1.5">
                  {forecast.slice(0, 5).map((f, i) => (
                    <div key={i} className="bg-card border border-border p-3 rounded-sm flex items-center justify-between">
                      <div>
                        <div className="font-mono text-xs font-bold">{f.unitName}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">Class {f.supplyClass} · {f.itemName}</div>
                      </div>
                      <div className="text-right">
                        <div className={`text-xs font-mono font-bold ${f.daysUntilStockout <= 2 ? 'text-destructive' : 'text-orange'}`}>
                          ◆ {f.daysUntilStockout} DAYS
                        </div>
                        <div className="text-[10px] text-muted-foreground font-mono">Req: {f.recommendedQuantity} {f.unit}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="bg-card border border-border p-6 rounded-sm text-center text-muted-foreground font-mono text-xs tracking-wide">
                  ■ No critical stockouts projected in next 5 days.
                </div>
              )}
            </div>
          </div>
        </>
      ) : null}
    </Layout>
  );
}
