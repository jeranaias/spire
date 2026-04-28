import { Title } from "@/components/title";
import { Layout } from "@/components/layout";
import { StatusCell, StatusBadge } from "@/components/status-badge";
import { useRoute } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  useGetUnit, 
  useUpdateUnit, 
  useDeleteUnit, 
  useGetUnitSupply, 
  useUpsertUnitSupply,
  useDeleteUnitSupply,
  useCopySupplyFromUnit,
  useCalculateRequirements, 
  useListUnitResupply, 
  useCreateResupplyEvent,
  useListCatalogItems,
  useListUnits,
  getGetUnitQueryKey,
  getGetUnitSupplyQueryKey,
  getListUnitResupplyQueryKey,
  getListCatalogItemsQueryKey,
  SupplyClass,
  Echelon,
  Climate,
  OpTempo
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Calculator, Calendar, Edit, FileText, Package, Plus, Save, Settings2, Trash2, X } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NumberStepper } from "@/components/ui/number-stepper";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useState, useEffect } from "react";
import { format } from "date-fns";

const resupplyFormSchema = z.object({
  supplyClass: z.nativeEnum(SupplyClass),
  itemId: z.string().optional(),
  quantity: z.coerce.number().min(0),
  unit: z.string().min(1),
  scheduledFor: z.string().min(1),
  assignedTo: z.string().optional(),
  notes: z.string().optional(),
});

export default function UnitDetail() {
  const [, params] = useRoute("/units/:id");
  const unitId = params?.id || "";
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: unitDetail, isLoading } = useGetUnit(unitId, { query: { enabled: !!unitId, queryKey: getGetUnitQueryKey(unitId) } });
  const { data: supply } = useGetUnitSupply(unitId, { query: { enabled: !!unitId, queryKey: getGetUnitSupplyQueryKey(unitId) } });
  const { data: resupplies } = useListUnitResupply(unitId, { query: { enabled: !!unitId, queryKey: getListUnitResupplyQueryKey(unitId) } });

  const deleteUnit = useDeleteUnit();
  const upsertSupply = useUpsertUnitSupply();
  const deleteSupply = useDeleteUnitSupply();
  const copyFromUnit = useCopySupplyFromUnit();
  const createResupply = useCreateResupplyEvent();
  const calculate = useCalculateRequirements();

  const { data: catalogItems } = useListCatalogItems({ query: { queryKey: getListCatalogItemsQueryKey() } });
  const { data: allUnits } = useListUnits();

  const [confirmRemoveItemId, setConfirmRemoveItemId] = useState<string | null>(null);
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [addItemSearch, setAddItemSearch] = useState("");
  const [copyFromOpen, setCopyFromOpen] = useState(false);

  const [calcDays, setCalcDays] = useState(14);
  const [calcPax, setCalcPax] = useState<number | undefined>(undefined);
  const [calcResult, setCalcResult] = useState<any>(null);

  const resupplyForm = useForm<z.infer<typeof resupplyFormSchema>>({
    resolver: zodResolver(resupplyFormSchema),
    defaultValues: {
      supplyClass: SupplyClass.I,
      quantity: 0,
      unit: "cases",
      scheduledFor: new Date().toISOString().slice(0, 16),
      assignedTo: "",
      notes: "",
    }
  });

  const handleDelete = async () => {
    if (!confirm("Are you sure you want to delete this unit? This cannot be undone.")) return;
    try {
      await deleteUnit.mutateAsync({ unitId });
      toast({ title: "Unit deleted" });
      setLocation("/units");
    } catch (e) {
      toast({ title: "Error deleting unit", variant: "destructive" });
    }
  };

  const handleRemoveItem = async (itemId: string) => {
    try {
      await deleteSupply.mutateAsync({ unitId, itemId });
      queryClient.invalidateQueries({ queryKey: getGetUnitSupplyQueryKey(unitId) });
      queryClient.invalidateQueries({ queryKey: getGetUnitQueryKey(unitId) });
      queryClient.invalidateQueries({ queryKey: getListUnitResupplyQueryKey(unitId) });
      setConfirmRemoveItemId(null);
      toast({ title: "Item removed from unit" });
    } catch (e) {
      toast({ title: "Failed to remove item", variant: "destructive" });
    }
  };

  const handleAddItem = async (itemId: string) => {
    try {
      await upsertSupply.mutateAsync({ unitId, data: { itemId, onHand: 0 } });
      queryClient.invalidateQueries({ queryKey: getGetUnitSupplyQueryKey(unitId) });
      queryClient.invalidateQueries({ queryKey: getGetUnitQueryKey(unitId) });
      setAddItemOpen(false);
      setAddItemSearch("");
      toast({ title: "Item added to unit" });
    } catch (e) {
      toast({ title: "Failed to add item", variant: "destructive" });
    }
  };

  const handleCopyFromUnit = async (sourceUnitId: string) => {
    try {
      const result = await copyFromUnit.mutateAsync({ unitId, data: { sourceUnitId } });
      queryClient.invalidateQueries({ queryKey: getGetUnitSupplyQueryKey(unitId) });
      queryClient.invalidateQueries({ queryKey: getGetUnitQueryKey(unitId) });
      setCopyFromOpen(false);
      if (result.added === 0) {
        toast({ title: "No new items to copy", description: "All items from the source unit are already tracked here." });
      } else {
        toast({
          title: `${result.added} item${result.added === 1 ? "" : "s"} copied`,
          description: result.skipped > 0 ? `${result.skipped} item${result.skipped === 1 ? "" : "s"} already tracked were skipped.` : undefined,
        });
      }
    } catch (e) {
      toast({ title: "Failed to copy supply list", variant: "destructive" });
    }
  };

  const handleUpdateOnHand = async (itemId: string, currentOnHand: number, newOnHand: number) => {
    if (newOnHand === currentOnHand) return;
    try {
      await upsertSupply.mutateAsync({
        unitId,
        data: { itemId, onHand: newOnHand }
      });
      queryClient.invalidateQueries({ queryKey: getGetUnitSupplyQueryKey(unitId) });
      queryClient.invalidateQueries({ queryKey: getGetUnitQueryKey(unitId) });
    } catch (e) {
      toast({ title: "Failed to update quantity", variant: "destructive" });
    }
  };

  const onSubmitResupply = async (values: z.infer<typeof resupplyFormSchema>) => {
    try {
      await createResupply.mutateAsync({ unitId, data: { ...values, scheduledFor: new Date(values.scheduledFor).toISOString() } });
      queryClient.invalidateQueries({ queryKey: getListUnitResupplyQueryKey(unitId) });
      toast({ title: "Resupply scheduled" });
    } catch (e) {
      toast({ title: "Error scheduling resupply", variant: "destructive" });
    }
  };

  const handleCalc = async () => {
    if (!unitDetail) return;
    try {
      const res = await calculate.mutateAsync({
        unitId,
        data: {
          days: calcDays,
          personnel: calcPax,
          climate: unitDetail.unit.climate,
          opTempo: unitDetail.unit.opTempo
        }
      });
      setCalcResult(res);
    } catch (e) {
      toast({ title: "Calculation failed", variant: "destructive" });
    }
  };

  if (isLoading) return <Layout><div className="p-8 text-center font-mono text-xs tracking-widest">Loading...</div></Layout>;
  if (!unitDetail) return <Layout><div className="p-8 text-center font-mono text-xs text-destructive">Unit not found</div></Layout>;

  const u = unitDetail.unit;

  return (
    <Layout>
      <Title title={u.name} />

      <div className="mb-6">
        <Link href="/units" className="inline-flex items-center text-xs font-mono text-muted-foreground hover:text-foreground transition-colors mb-4 tracking-widest uppercase">
          <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
          Units
        </Link>
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-mono font-bold uppercase tracking-[0.12em] flex items-center gap-3 flex-wrap">
              {u.name}
              {u.callsign && (
                <span className="text-xs px-2 py-0.5 bg-secondary text-secondary-foreground rounded-sm font-mono tracking-widest">
                  {u.callsign}
                </span>
              )}
            </h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[10px] text-muted-foreground font-mono uppercase tracking-widest">
              <span>{u.echelon}</span>
              <span className="text-primary">·</span>
              <span>{u.personnel} PAX</span>
              {u.commander && <><span className="text-primary">·</span><span>{u.commander}</span></>}
              {u.location && <><span className="text-primary">·</span><span>LOC: {u.location}</span></>}
              <span className="text-primary">·</span>
              <span>{u.climate}</span>
              <span className="text-primary">·</span>
              <span>{u.opTempo}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href={`/units/${unitId}/edit`}>
              <Button variant="outline" size="sm" className="font-mono uppercase text-[10px] tracking-widest" disabled>
                <Edit className="w-3 h-3 mr-1.5" /> Edit
              </Button>
            </Link>
            <Button variant="destructive" size="sm" className="font-mono uppercase text-[10px] tracking-widest" onClick={handleDelete} disabled={deleteUnit.isPending}>
              <Trash2 className="w-3 h-3 mr-1.5" /> Delete
            </Button>
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-4 gap-4 mb-8">
        <Card className="md:col-span-3 border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-mono font-bold uppercase tracking-widest text-muted-foreground">Combat Readiness</span>
              <StatusBadge value={u.readiness} />
            </div>
            <Progress
              value={u.readiness}
              className="h-2 mb-4"
              indicatorClassName={
                u.readiness >= 90 ? "bg-success" :
                u.readiness >= 75 ? "bg-warning" :
                u.readiness >= 60 ? "bg-orange" : "bg-destructive"
              }
            />
            <div className="grid grid-cols-4 gap-1.5 mt-3">
              {unitDetail.supplyByClass.map(cls => {
                const tier = cls.status === 'green' ? 'green' : cls.status === 'amber' ? 'amber' : 'red';
                const tierCls = {
                  green:  'bg-success/10 border-success/30 text-success',
                  amber:  'bg-warning/10 border-warning/30 text-warning',
                  orange: 'bg-orange/10 border-orange/30 text-orange',
                  red:    'bg-destructive/10 border-destructive/30 text-destructive',
                }[tier];
                return (
                  <div key={cls.supplyClass} className={`p-2 rounded-sm border text-center ${tierCls}`}>
                    <div className="text-[10px] font-mono font-bold tracking-widest">CL {cls.supplyClass}</div>
                    <div className="text-[10px] font-mono opacity-80 tabular-nums">{cls.worstDaysOfSupply}d</div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-4 flex flex-col justify-center h-full text-center">
            <div className="text-[10px] font-mono text-muted-foreground mb-1 uppercase tracking-widest">Deficiencies</div>
            <div className={`text-4xl font-mono font-bold tabular-nums ${u.deficiencyCount > 0 ? 'text-destructive' : 'text-success'}`}>
              {u.deficiencyCount}
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="supply" className="w-full">
        <TabsList className="mb-6 bg-transparent border-b border-border w-full justify-start rounded-none p-0 h-auto gap-0">
          <TabsTrigger value="supply" className="font-mono uppercase text-[10px] tracking-widest rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent px-4 py-2.5 text-muted-foreground">
            <Package className="w-3.5 h-3.5 mr-1.5" /> Supply On-Hand
          </TabsTrigger>
          <TabsTrigger value="resupply" className="font-mono uppercase text-[10px] tracking-widest rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent px-4 py-2.5 text-muted-foreground">
            <Calendar className="w-3.5 h-3.5 mr-1.5" /> Resupply Schedule
          </TabsTrigger>
          <TabsTrigger value="calculator" className="font-mono uppercase text-[10px] tracking-widest rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent px-4 py-2.5 text-muted-foreground">
            <Calculator className="w-3.5 h-3.5 mr-1.5" /> Calculator
          </TabsTrigger>
        </TabsList>

        <TabsContent value="supply" className="mt-0 outline-none">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xs font-mono font-bold uppercase tracking-[0.2em]">Supply On-Hand</h2>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="font-mono uppercase text-[10px] tracking-widest" onClick={() => setCopyFromOpen(true)}>
                Copy from unit...
              </Button>
              <Button size="sm" className="font-mono uppercase text-[10px] tracking-widest" onClick={() => { setAddItemSearch(""); setAddItemOpen(true); }}>
                <Plus className="w-3 h-3 mr-1.5" /> Add Item
              </Button>
            </div>
          </div>

          {/* Add Item Dialog */}
          <Dialog open={addItemOpen} onOpenChange={(open) => { setAddItemOpen(open); if (!open) setAddItemSearch(""); }}>
            <DialogContent className="sm:max-w-[480px]">
              <DialogHeader>
                <DialogTitle className="font-mono uppercase text-sm tracking-widest">Add Supply Item</DialogTitle>
              </DialogHeader>
              <div className="pt-2 space-y-3">
                <Input
                  placeholder="Search items..."
                  className="font-mono text-xs h-8"
                  value={addItemSearch}
                  onChange={(e) => setAddItemSearch(e.target.value)}
                  autoFocus
                />
                <div className="max-h-72 overflow-y-auto divide-y divide-border border border-border rounded-sm">
                  {(() => {
                    const tracked = new Set((supply ?? []).map(e => e.itemId));
                    const available = (catalogItems ?? []).filter(c =>
                      !tracked.has(c.id) &&
                      (addItemSearch === "" ||
                        c.name.toLowerCase().includes(addItemSearch.toLowerCase()) ||
                        c.supplyClass.toLowerCase().includes(addItemSearch.toLowerCase()))
                    ).sort((a, b) => a.supplyClass.localeCompare(b.supplyClass) || a.name.localeCompare(b.name));

                    if (available.length === 0) {
                      return (
                        <div className="px-4 py-6 text-center text-muted-foreground text-xs font-mono tracking-wide">
                          {tracked.size === (catalogItems?.length ?? 0) ? "All catalog items are already on this unit." : "No items match."}
                        </div>
                      );
                    }
                    return available.map(c => (
                      <button
                        key={c.id}
                        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-muted/40 transition-colors text-left"
                        onClick={() => handleAddItem(c.id)}
                        disabled={upsertSupply.isPending}
                      >
                        <div>
                          <span className="font-mono font-bold text-xs">{c.name}</span>
                          {c.nsn && <span className="ml-2 text-[10px] text-muted-foreground font-mono">{c.nsn}</span>}
                        </div>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border ml-2 shrink-0">
                          CL {c.supplyClass}
                        </span>
                      </button>
                    ));
                  })()}
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* Copy from Unit Dialog */}
          <Dialog open={copyFromOpen} onOpenChange={setCopyFromOpen}>
            <DialogContent className="sm:max-w-[480px]">
              <DialogHeader>
                <DialogTitle className="font-mono uppercase text-sm tracking-widest">Copy from unit...</DialogTitle>
              </DialogHeader>
              <p className="text-xs font-mono text-muted-foreground pt-1 pb-2">
                Items from the selected unit that are not already on this unit will be added at 0 on-hand.
              </p>
              <div className="max-h-72 overflow-y-auto divide-y divide-border border border-border rounded-sm">
                {(() => {
                  const otherUnits = (allUnits ?? []).filter(u => u.id !== unitId);
                  if (otherUnits.length === 0) {
                    return (
                      <div className="px-4 py-6 text-center text-muted-foreground text-xs font-mono tracking-wide">
                        No other units available.
                      </div>
                    );
                  }
                  return otherUnits.map(u => (
                    <button
                      key={u.id}
                      className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/40 transition-colors text-left"
                      onClick={() => handleCopyFromUnit(u.id)}
                      disabled={copyFromUnit.isPending}
                    >
                      <div>
                        <span className="font-mono font-bold text-xs">{u.name}</span>
                        {u.callsign && <span className="ml-2 text-[10px] text-muted-foreground font-mono">{u.callsign}</span>}
                      </div>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border ml-2 shrink-0 capitalize">
                        {u.echelon}
                      </span>
                    </button>
                  ));
                })()}
              </div>
            </DialogContent>
          </Dialog>

          {/* Confirm Remove Dialog */}
          {(() => {
            const removeEntry = supply?.find(e => e.itemId === confirmRemoveItemId);
            const hasStock = removeEntry && removeEntry.onHand > 0;
            return (
              <Dialog open={!!confirmRemoveItemId} onOpenChange={(open) => { if (!open) setConfirmRemoveItemId(null); }}>
                <DialogContent className="sm:max-w-[360px]">
                  <DialogHeader>
                    <DialogTitle className="font-mono uppercase text-sm tracking-widest text-destructive">Remove Item?</DialogTitle>
                  </DialogHeader>
                  {hasStock && (
                    <div className="flex items-start gap-2 rounded border border-destructive/50 bg-destructive/10 px-3 py-2 mt-1">
                      <span className="text-destructive text-base leading-none mt-0.5">⚠</span>
                      <p className="text-xs font-mono text-destructive leading-relaxed">
                        This item has <span className="font-bold">{removeEntry!.onHand} {removeEntry!.item.unit}</span> on hand — removing it will discard that count permanently.
                      </p>
                    </div>
                  )}
                  <p className="text-xs font-mono text-muted-foreground pt-1">
                    This will remove the item from this unit's supply list and cancel any future resupply events for it. This cannot be undone.
                  </p>
                  <div className="flex gap-2 pt-2">
                    <Button variant="destructive" size="sm" className="font-mono uppercase text-[10px] tracking-widest flex-1"
                      onClick={() => confirmRemoveItemId && handleRemoveItem(confirmRemoveItemId)}
                      disabled={deleteSupply.isPending}>
                      Remove
                    </Button>
                    <Button variant="outline" size="sm" className="font-mono uppercase text-[10px] tracking-widest flex-1"
                      onClick={() => setConfirmRemoveItemId(null)}>
                      Cancel
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            );
          })()}

          <Card className="border-border">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-[10px] font-mono uppercase tracking-widest bg-muted/40 text-muted-foreground border-b border-border">
                  <tr>
                    <th className="px-4 py-2.5">Item</th>
                    <th className="px-4 py-2.5">Class</th>
                    <th className="px-4 py-2.5">On Hand</th>
                    <th className="px-4 py-2.5">Daily Burn</th>
                    <th className="px-4 py-2.5">DOS</th>
                    <th className="px-4 py-2.5">Shortfall</th>
                    <th className="px-4 py-2.5 text-right">Status</th>
                    <th className="px-4 py-2.5 w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border font-mono">
                  {supply?.slice().sort((a, b) => {
                    const cls = a.item.supplyClass.localeCompare(b.item.supplyClass);
                    if (cls !== 0) return cls;
                    const name = a.item.name.localeCompare(b.item.name);
                    if (name !== 0) return name;
                    return a.item.id.localeCompare(b.item.id);
                  }).map((entry) => {
                    const isClassIX = entry.item.supplyClass === "IX";
                    return (
                    <tr key={entry.id} className={`hover:bg-muted/20 transition-colors group ${isClassIX ? 'opacity-70' : ''}`}>
                      <td className="px-4 py-2.5 font-bold text-xs">
                        {entry.item.name}
                        {isClassIX && (
                          <span className="ml-2 inline-block text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">
                            Ref only — not in DOS
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs">{entry.item.supplyClass}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1">
                          <NumberStepper
                            value={entry.onHand}
                            onChange={(val) => handleUpdateOnHand(entry.itemId, entry.onHand, val)}
                            min={0}
                            step={1}
                            aria-label={`${entry.item.name} on hand`}
                          />
                          <span className="text-[10px] text-muted-foreground">{entry.item.unit}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-xs tabular-nums">{isClassIX ? '—' : entry.dailyConsumption.toFixed(2)}</td>
                      <td className="px-4 py-2.5">
                        {isClassIX ? (
                          <span className="text-xs text-muted-foreground">n/a</span>
                        ) : (
                          <span className={`text-xs tabular-nums ${entry.daysOfSupply < 2 ? 'text-destructive font-bold' : entry.daysOfSupply < 5 ? 'text-warning font-bold' : ''}`}>
                            {entry.daysOfSupply.toFixed(1)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {isClassIX ? (
                          <span className="text-muted-foreground text-xs">—</span>
                        ) : entry.shortfall > 0 ? (
                          <span className="text-destructive font-bold text-xs tabular-nums">{entry.shortfall.toFixed(1)}</span>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {isClassIX ? (
                          <span className="text-muted-foreground text-xs">—</span>
                        ) : (
                          <StatusCell
                            value={Math.min(100, Math.round((entry.onHand / Math.max(entry.dailyConsumption * 14, 0.01)) * 100))}
                          />
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        <button
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive p-1 rounded"
                          title="Remove item"
                          onClick={() => setConfirmRemoveItemId(entry.itemId)}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                  {(!supply || supply.length === 0) && (
                    <tr>
                      <td colSpan={8} className="px-4 py-10 text-center font-mono">
                        <div className="text-muted-foreground text-xs tracking-wide">No items tracked yet</div>
                        <div className="text-muted-foreground/60 text-[10px] tracking-wide mt-1">Use <span className="font-bold">Add Item</span> to build this unit's supply list from the catalog.</div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="resupply" className="mt-0 outline-none">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xs font-mono font-bold uppercase tracking-[0.2em]">Scheduled Deliveries</h2>
            <Dialog>
              <DialogTrigger asChild>
                <Button size="sm" className="font-mono uppercase text-[10px] tracking-widest">
                  <Plus className="w-3 h-3 mr-1.5" /> Plan Resupply
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-[425px]">
                <DialogHeader>
                  <DialogTitle className="font-mono uppercase text-sm tracking-widest">Plan Resupply Event</DialogTitle>
                </DialogHeader>
                <Form {...resupplyForm}>
                  <form onSubmit={resupplyForm.handleSubmit(onSubmitResupply)} className="space-y-4 pt-4">
                    <FormField
                      control={resupplyForm.control}
                      name="supplyClass"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="font-mono uppercase text-[10px] tracking-widest">Supply Class</FormLabel>
                          <Select onValueChange={field.onChange} defaultValue={field.value}>
                            <FormControl>
                              <SelectTrigger className="font-mono text-xs"><SelectValue /></SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {Object.values(SupplyClass).map(c => <SelectItem key={c} value={c} className="font-mono text-xs">Class {c}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="grid grid-cols-2 gap-4">
                      <FormField
                        control={resupplyForm.control}
                        name="quantity"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="font-mono uppercase text-[10px] tracking-widest">Quantity</FormLabel>
                            <FormControl><Input type="number" className="font-mono text-xs h-8" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={resupplyForm.control}
                        name="unit"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="font-mono uppercase text-[10px] tracking-widest">Unit</FormLabel>
                            <FormControl><Input placeholder="cases, gals, etc" className="font-mono text-xs h-8" {...field} /></FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                    <FormField
                      control={resupplyForm.control}
                      name="scheduledFor"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="font-mono uppercase text-[10px] tracking-widest">Scheduled Time</FormLabel>
                          <FormControl><Input type="datetime-local" className="font-mono text-xs h-8" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={resupplyForm.control}
                      name="assignedTo"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="font-mono uppercase text-[10px] tracking-widest">Assigned To (Optional)</FormLabel>
                          <FormControl><Input placeholder="Vehicle / Unit" className="font-mono text-xs h-8" {...field} /></FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button type="submit" className="w-full font-mono uppercase text-xs tracking-widest" disabled={createResupply.isPending}>
                      Save Resupply
                    </Button>
                  </form>
                </Form>
              </DialogContent>
            </Dialog>
          </div>

          <Card className="border-border">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-[10px] font-mono uppercase tracking-widest bg-muted/40 text-muted-foreground border-b border-border">
                  <tr>
                    <th className="px-4 py-2.5">DTG (Scheduled)</th>
                    <th className="px-4 py-2.5">Class</th>
                    <th className="px-4 py-2.5">Quantity</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">Assigned To</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border font-mono">
                  {resupplies?.map((r) => (
                    <tr key={r.id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2.5 font-bold text-xs tabular-nums">{format(new Date(r.scheduledFor), "ddHHmm'Z' MMM yy").toUpperCase()}</td>
                      <td className="px-4 py-2.5 text-xs">Class {r.supplyClass}</td>
                      <td className="px-4 py-2.5 text-xs tabular-nums">{r.quantity} {r.unit}</td>
                      <td className="px-4 py-2.5">
                        <span className={`px-1.5 py-0.5 text-[10px] rounded-sm uppercase tracking-widest border font-mono ${
                          r.status === 'delivered'   ? 'bg-success/15 text-success border-success/30' :
                          r.status === 'in_transit'  ? 'bg-primary/15 text-primary border-primary/30' :
                          r.status === 'cancelled'   ? 'bg-destructive/15 text-destructive border-destructive/30' :
                          'bg-muted text-muted-foreground border-border'
                        }`}>
                          {r.status.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{r.assignedTo || '—'}</td>
                    </tr>
                  ))}
                  {(!resupplies || resupplies.length === 0) && (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground text-xs font-mono tracking-wide">
                        No upcoming resupplies scheduled.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </TabsContent>

        <TabsContent value="calculator" className="mt-0 outline-none">
          <div className="grid lg:grid-cols-3 gap-6">
            <Card className="h-fit border-border">
              <CardHeader className="border-b border-border pb-3 pt-4 px-4">
                <CardTitle className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Unit Context Params</CardTitle>
                <CardDescription className="font-mono text-[10px] tracking-wide">Run scenario calculations for this unit</CardDescription>
              </CardHeader>
              <CardContent className="p-4 space-y-4">
                <div className="space-y-1.5">
                  <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Days to plan</Label>
                  <NumberStepper
                    value={calcDays}
                    onChange={setCalcDays}
                    min={1}
                    step={1}
                    secondaryStep={7}
                    aria-label="Days to plan"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">PAX Override (Optional)</Label>
                  <NumberStepper
                    value={calcPax ?? u.personnel}
                    onChange={(val) => setCalcPax(val)}
                    min={1}
                    step={1}
                    secondaryStep={5}
                    aria-label="PAX override"
                  />
                  {calcPax === undefined && (
                    <p className="text-[10px] text-muted-foreground font-mono">Using unit default: {u.personnel}</p>
                  )}
                </div>
                <div className="text-[10px] font-mono text-muted-foreground mt-4 p-3 bg-muted/50 rounded-sm border border-border">
                  <div>Climate: <span className="font-bold uppercase text-foreground">{u.climate}</span></div>
                  <div>Tempo: <span className="font-bold uppercase text-foreground">{u.opTempo}</span></div>
                </div>
                <Button onClick={handleCalc} disabled={calculate.isPending} className="w-full font-mono uppercase text-xs tracking-widest">
                  <Calculator className="w-3.5 h-3.5 mr-2" /> Calculate Req
                </Button>
              </CardContent>
            </Card>

            <div className="lg:col-span-2">
              {calcResult ? (
                <Card className="border-border">
                  <CardHeader className="border-b border-border pb-3 pt-4 px-4">
                    <CardTitle className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Requirement Bill</CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="px-4 py-3 bg-muted/30 border-b border-border grid grid-cols-2 gap-4 font-mono">
                      <div>
                        <span className="text-[10px] text-muted-foreground block mb-0.5 uppercase tracking-widest">Effective PAX</span>
                        <span className="font-bold text-sm tabular-nums">{calcResult.personnel}</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-muted-foreground block mb-0.5 uppercase tracking-widest">Duration</span>
                        <span className="font-bold text-sm tabular-nums">{calcResult.days} DAYS</span>
                      </div>
                    </div>
                    <div className="divide-y divide-border">
                      {calcResult.lines.map((line: any, i: number) => (
                        <div key={i} className="px-4 py-3 flex items-center justify-between hover:bg-muted/20 transition-colors">
                          <div>
                            <div className="font-mono font-bold text-xs">{line.item.name}</div>
                            <div className="font-mono text-[10px] text-muted-foreground">Class {line.item.supplyClass}</div>
                          </div>
                          <div className="text-right">
                            <div className="font-mono font-bold text-sm tabular-nums">{line.totalRequired.toFixed(1)} {line.item.unit}</div>
                            <div className="font-mono text-[10px] text-muted-foreground tabular-nums">
                              vs On-Hand: {supply?.find(s => s.itemId === line.item.id)?.onHand || 0}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <div className="h-full min-h-[300px] border border-dashed border-border/50 rounded-sm flex flex-col items-center justify-center text-muted-foreground bg-card/30">
                  <Calculator className="w-10 h-10 mb-4 opacity-10" />
                  <p className="font-mono text-[10px] tracking-widest uppercase">Run calculation to generate bill</p>
                </div>
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </Layout>
  );
}
