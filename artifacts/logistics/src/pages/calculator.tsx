import { Title } from "@/components/title";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NumberStepper } from "@/components/ui/number-stepper";
import { useState } from "react";
import { Calculator, FileText, Printer, Settings2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Climate, OpTempo, useCalculateRequirements, useListUnits, CalculationResult } from "@workspace/api-client-react";
import { PushToSpireButton } from "@/components/push-to-spire-button";

export default function StandaloneCalculator() {
  const { data: units } = useListUnits({ query: { queryKey: ["units"] } });
  const defaultUnit = units?.[0];
  const calculate = useCalculateRequirements();
  
  const [personnel, setPersonnel] = useState(40);
  const [days, setDays] = useState(14);
  const [climate, setClimate] = useState<Climate>("temperate");
  const [tempo, setTempo] = useState<OpTempo>("sustained");
  
  const [result, setResult] = useState<CalculationResult | null>(null);

  const handleCalculate = async () => {
    if (!defaultUnit) return;
    try {
      const res = await calculate.mutateAsync({
        unitId: defaultUnit.id,
        data: {
          days,
          personnel,
          climate,
          opTempo: tempo
        }
      });
      setResult(res);
    } catch (e) {
      console.error("Calc failed", e);
    }
  };

  return (
    <Layout>
      <Title title="Calculator" />

      <PageHeader
        title="Calculator"
        tag="Logistics"
        subtitle="Quick sustainment requirements planning"
      />

      <div className="grid lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-1 h-fit border-border">
          <CardHeader className="border-b border-border pb-3 pt-4 px-4">
            <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
              <Settings2 className="w-3.5 h-3.5 text-primary" /> Parameters
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 p-4">
            <div className="space-y-1.5">
              <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Personnel (PAX)</Label>
              <NumberStepper
                value={personnel}
                onChange={setPersonnel}
                min={1}
                step={1}
                aria-label="Personnel"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Days</Label>
              <NumberStepper
                value={days}
                onChange={setDays}
                min={1}
                step={1}
                aria-label="Days"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Climate</Label>
              <Select value={climate} onValueChange={(v: Climate) => setClimate(v)}>
                <SelectTrigger className="font-mono uppercase h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.values(Climate).map(c => <SelectItem key={c} value={c} className="font-mono uppercase text-xs">{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Op Tempo</Label>
              <Select value={tempo} onValueChange={(v: OpTempo) => setTempo(v)}>
                <SelectTrigger className="font-mono uppercase h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.values(OpTempo).map(o => <SelectItem key={o} value={o} className="font-mono uppercase text-xs">{o}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            
            <Button onClick={handleCalculate} disabled={calculate.isPending || !defaultUnit} className="w-full font-mono uppercase text-xs tracking-widest mt-2">
              <Calculator className="w-3.5 h-3.5 mr-2" /> Calculate
            </Button>
            
            {!defaultUnit && (
              <p className="text-[10px] text-destructive font-mono text-center tracking-wide">Requires at least one unit registered.</p>
            )}
          </CardContent>
        </Card>

        <div className="lg:col-span-2">
          {result ? (
            <Card className="border-border">
              <CardHeader className="border-b border-border pb-3 pt-4 px-4 flex flex-row items-center justify-between">
                <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
                  <FileText className="w-3.5 h-3.5 text-primary" /> Requirements Bill
                </CardTitle>
                <div className="flex items-center gap-2">
                  <PushToSpireButton
                    sourceKind="calculator"
                    sourceId={defaultUnit?.id}
                    scenario={{ personnel, days, climate, opTempo: tempo }}
                    contextLabel={`${personnel} pax · ${days} days · ${climate}/${tempo}`}
                    disabled={!defaultUnit}
                  />
                  <Button variant="outline" size="sm" className="font-mono uppercase text-[10px] tracking-widest h-7 px-2" onClick={() => window.print()} data-testid="button-print-bill">
                    <Printer className="w-3 h-3 mr-1.5" /> Print
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="px-4 py-3 bg-muted/30 border-b border-border grid grid-cols-2 md:grid-cols-4 gap-4 font-mono">
                  <div>
                    <span className="text-[10px] text-muted-foreground block mb-0.5 uppercase tracking-widest">PAX</span>
                    <span className="font-bold text-sm tabular-nums">{result.personnel}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-muted-foreground block mb-0.5 uppercase tracking-widest">Days</span>
                    <span className="font-bold text-sm tabular-nums">{result.days}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-muted-foreground block mb-0.5 uppercase tracking-widest">Climate</span>
                    <span className="font-bold text-sm uppercase">{result.climate}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-muted-foreground block mb-0.5 uppercase tracking-widest">Tempo</span>
                    <span className="font-bold text-sm uppercase">{result.opTempo}</span>
                  </div>
                </div>
                
                <div className="divide-y divide-border">
                  {result.lines.map((line, i) => (
                    <div key={i} className="px-4 py-3 flex items-center justify-between hover:bg-muted/20 transition-colors">
                      <div>
                        <div className="font-mono font-bold text-sm">{line.item.name}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          Class {line.item.supplyClass}{line.item.nsn ? ` · NSN: ${line.item.nsn}` : ''}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono font-bold text-sm tabular-nums">{line.totalRequired.toFixed(1)} {line.item.unit}</div>
                        <div className="font-mono text-[10px] text-muted-foreground tabular-nums">{line.dailyConsumption.toFixed(2)}/day</div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="h-full min-h-[400px] border border-dashed border-border/50 rounded-sm flex flex-col items-center justify-center text-muted-foreground bg-card/30 gap-4">
              <Calculator className="w-10 h-10 opacity-10" />
              <div className="text-center space-y-1">
                <p className="font-mono text-xs tracking-widest uppercase">Configure parameters and run calculation</p>
                <p className="font-mono text-[10px] text-muted-foreground/60">A bill of materials will appear here</p>
              </div>
              <Button
                onClick={handleCalculate}
                disabled={calculate.isPending || !defaultUnit}
                variant="outline"
                className="font-mono uppercase text-xs tracking-widest"
              >
                <Calculator className="w-3.5 h-3.5 mr-2" />
                {calculate.isPending ? "Calculating..." : "Run Calculation"}
              </Button>
              {!defaultUnit && (
                <p className="text-[10px] text-destructive font-mono tracking-wide">Requires at least one unit registered.</p>
              )}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
