import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  useGetSupplyHistory,
  useCreateBaseline,
  getListBaselinesQueryKey,
  SupplyHistoryItem,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Flag, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { format } from "date-fns";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { LineChart, Line, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { Link } from "wouter";

interface SupplyHistoryTabProps {
  unitId: string;
}

function Sparkline({ series }: { series: SupplyHistoryItem["series"] }) {
  if (series.length < 2) {
    return (
      <div className="h-8 w-24 flex items-center justify-center">
        <span className="text-[10px] font-mono text-muted-foreground/50">No data</span>
      </div>
    );
  }

  const data = series.map((s) => ({
    t: new Date(s.snapshotAt).getTime(),
    v: s.onHand,
  }));

  return (
    <div className="h-8 w-24">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <YAxis hide domain={["auto", "auto"]} />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.[0]) return null;
              const d = payload[0].payload as { t: number; v: number };
              return (
                <div className="bg-card border border-border rounded p-1 font-mono text-[10px]">
                  <div>{format(new Date(d.t), "ddMMMyy").toUpperCase()}</div>
                  <div className="font-bold">{d.v.toFixed(1)}</div>
                </div>
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="v"
            stroke="hsl(var(--primary))"
            strokeWidth={1.5}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function BurnRateDelta({ delta }: { delta: number | null }) {
  if (delta === null) return <span className="text-muted-foreground/50 font-mono text-[10px]">—</span>;
  const abs = Math.abs(delta).toFixed(2);
  if (delta > 0.05) {
    return (
      <span className="flex items-center gap-0.5 text-destructive font-mono text-[10px] font-bold">
        <TrendingUp className="w-3 h-3" /> +{abs} over doctrinal
      </span>
    );
  }
  if (delta < -0.05) {
    return (
      <span className="flex items-center gap-0.5 text-success font-mono text-[10px]">
        <TrendingDown className="w-3 h-3" /> {abs} under doctrinal
      </span>
    );
  }
  return (
    <span className="flex items-center gap-0.5 text-muted-foreground font-mono text-[10px]">
      <Minus className="w-3 h-3" /> On par w/ doctrinal
    </span>
  );
}

export function SupplyHistoryTab({ unitId }: SupplyHistoryTabProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const createBaseline = useCreateBaseline();

  const [showSaveBaseline, setShowSaveBaseline] = useState(false);
  const [newBaselineLabel, setNewBaselineLabel] = useState("");

  const { data: history, isLoading } = useGetSupplyHistory(
    unitId,
    { days: 30 },
    { query: { queryKey: ["supply-history", unitId] } },
  );

  const handleSaveBaseline = async () => {
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
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40 font-mono text-xs text-muted-foreground uppercase tracking-widest">
        Loading history...
      </div>
    );
  }

  const hasHistory = history && history.length > 0;
  const hasData = history?.some((h) => h.series.length > 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-mono font-bold uppercase tracking-[0.2em]">Supply History (Last 30 Days)</h2>
        <div className="flex items-center gap-2">
          <Link href={`/units/${unitId}/comms-denied`}>
            <Button size="sm" variant="outline" className="font-mono uppercase text-[10px] tracking-widest">
              Comms-Denied Plan →
            </Button>
          </Link>
          {!showSaveBaseline ? (
            <Button
              size="sm"
              variant="outline"
              className="font-mono uppercase text-[10px] tracking-widest"
              onClick={() => setShowSaveBaseline(true)}
            >
              <Flag className="w-3 h-3 mr-1.5" /> Mark Last Known Good
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Input
                value={newBaselineLabel}
                onChange={(e) => setNewBaselineLabel(e.target.value)}
                placeholder={`Pre-EMCON ${format(new Date(), "ddMMM").toUpperCase()}`}
                className="font-mono text-xs h-7 w-40"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleSaveBaseline()}
              />
              <Button
                size="sm"
                className="font-mono uppercase text-[10px] tracking-widest h-7"
                onClick={handleSaveBaseline}
                disabled={createBaseline.isPending || !newBaselineLabel.trim()}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="font-mono text-[10px] h-7"
                onClick={() => { setShowSaveBaseline(false); setNewBaselineLabel(""); }}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      </div>

      {!hasHistory || !hasData ? (
        <Card className="border-border">
          <CardContent className="py-10 flex flex-col items-center justify-center gap-3">
            <TrendingDown className="w-8 h-8 text-muted-foreground/30" />
            <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">No supply history yet</p>
            <p className="font-mono text-[10px] text-muted-foreground/60 text-center max-w-xs">
              History is captured automatically each time you update supply on-hand quantities. Make an update to start tracking.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border">
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="px-4 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Item</th>
                  <th className="px-4 py-2 text-center font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Trend</th>
                  <th className="px-4 py-2 text-right font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Observed Rate</th>
                  <th className="px-4 py-2 text-right font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Doctrinal Rate</th>
                  <th className="px-4 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Delta</th>
                  <th className="px-4 py-2 text-right font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Last Confirmed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(history ?? [])
                  .filter((h) => h.series.length > 0)
                  .sort((a, b) => {
                    if (a.supplyClass < b.supplyClass) return -1;
                    if (a.supplyClass > b.supplyClass) return 1;
                    return a.itemName.localeCompare(b.itemName);
                  })
                  .map((item) => (
                    <tr key={item.itemId} className="hover:bg-muted/10">
                      <td className="px-4 py-2.5">
                        <div className="font-mono font-bold text-xs">{item.itemName}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">Class {item.supplyClass}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex justify-center">
                          <Sparkline series={item.series} />
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums">
                        {item.observedBurnRate !== null && item.observedBurnRate !== undefined
                          ? `${item.observedBurnRate.toFixed(2)}/day`
                          : <span className="text-muted-foreground/50">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {item.doctrinaRate.toFixed(2)}/day
                      </td>
                      <td className="px-4 py-2.5">
                        <BurnRateDelta delta={item.burnRateDelta ?? null} />
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                        {item.lastConfirmedAt
                          ? format(new Date(item.lastConfirmedAt), "ddMMMyy HHmm'Z'").toUpperCase()
                          : "—"}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
