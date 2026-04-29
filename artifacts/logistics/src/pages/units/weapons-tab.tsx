import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NumberStepper } from "@/components/ui/number-stepper";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandItem, CommandList, CommandEmpty } from "@/components/ui/command";
import {
  useUpdateUnit,
  useListWeaponSystems,
  useAddUnitWeapon,
  useUpdateUnitWeapon,
  useDeleteUnitWeapon,
  getGetUnitQueryKey,
  getListWeaponSystemsQueryKey,
  type UnitDetail,
  type AmmoPosture,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Target, Shield, ChevronsUpDown, Check } from "lucide-react";

const POSTURE_LABELS: Record<AmmoPosture, { label: string; desc: string; color: string }> = {
  combat_load: {
    label: "Combat Load",
    desc: "Issue & track against full combat load target",
    color: "bg-destructive/10 border-destructive/40 text-destructive",
  },
  assault:  {
    label: "Assault",
    desc: "Daily burn at assault rate",
    color: "bg-warning/10 border-warning/40 text-warning",
  },
  sustain:  {
    label: "Sustain",
    desc: "Daily burn at sustainment rate",
    color: "bg-success/10 border-success/40 text-success",
  },
};

interface WeaponsTabProps {
  unitId: string;
  unitDetail: UnitDetail;
}

type SupplyEntry = UnitDetail["entries"][number];

export function WeaponsTab({ unitId, unitDetail }: WeaponsTabProps) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<{ id: string; qty: number } | null>(null);
  const [addWeaponId, setAddWeaponId] = useState("");
  const [addQty, setAddQty] = useState(1);
  const [weaponPickerOpen, setWeaponPickerOpen] = useState(false);

  const { data: weaponSystems } = useListWeaponSystems({
    query: { queryKey: getListWeaponSystemsQueryKey() },
  });

  const updateUnit  = useUpdateUnit();
  const addWeapon   = useAddUnitWeapon();
  const patchWeapon = useUpdateUnitWeapon();
  const delWeapon   = useDeleteUnitWeapon();

  const u          = unitDetail.unit;
  const ammoPosture: AmmoPosture = (u.ammoPosture as AmmoPosture) ?? "sustain";
  const isGce      = u.isGce ?? true;
  const weapons    = unitDetail.weapons ?? [];
  const entries    = unitDetail.entries ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetUnitQueryKey(unitId) });
  };

  async function handlePostureChange(posture: AmmoPosture) {
    try {
      await updateUnit.mutateAsync({
        unitId,
        data: {
          name: u.name,
          echelon: u.echelon as any,
          personnel: u.personnel,
          climate: u.climate as any,
          opTempo: u.opTempo as any,
          missionDays: u.missionDays,
          callsign: u.callsign ?? undefined,
          commander: u.commander ?? undefined,
          location: u.location ?? undefined,
          role: u.role as any,
          ammoPosture: posture,
          isGce,
        },
      });
      invalidate();
    } catch {
      toast({ title: "Failed to update posture", variant: "destructive" });
    }
  }

  async function handleGceToggle(val: boolean) {
    try {
      await updateUnit.mutateAsync({
        unitId,
        data: {
          name: u.name,
          echelon: u.echelon as any,
          personnel: u.personnel,
          climate: u.climate as any,
          opTempo: u.opTempo as any,
          missionDays: u.missionDays,
          callsign: u.callsign ?? undefined,
          commander: u.commander ?? undefined,
          location: u.location ?? undefined,
          role: u.role as any,
          ammoPosture,
          isGce: val,
        },
      });
      invalidate();
    } catch {
      toast({ title: "Failed to update GCE classification", variant: "destructive" });
    }
  }

  async function handleAddWeapon() {
    if (!addWeaponId) {
      toast({ title: "Select a weapon system", variant: "destructive" });
      return;
    }
    try {
      await addWeapon.mutateAsync({
        unitId,
        data: { weaponSystemId: addWeaponId, quantity: addQty },
      });
      invalidate();
      setAddOpen(false);
      setAddWeaponId("");
      setAddQty(1);
      toast({ title: "Weapon added" });
    } catch {
      toast({ title: "Failed to add weapon", variant: "destructive" });
    }
  }

  async function handleSaveEdit(weaponEntryId: string, qty: number) {
    try {
      await patchWeapon.mutateAsync({
        unitId,
        weaponEntryId,
        data: { quantity: qty },
      });
      invalidate();
      setEditEntry(null);
    } catch {
      toast({ title: "Failed to update quantity", variant: "destructive" });
    }
  }

  async function handleDelete(weaponEntryId: string) {
    if (!confirm("Remove this weapon from the unit?")) return;
    try {
      await delWeapon.mutateAsync({ unitId, weaponEntryId });
      invalidate();
      toast({ title: "Weapon removed" });
    } catch {
      toast({ title: "Failed to remove weapon", variant: "destructive" });
    }
  }

  // Build Class V ammo status from entries
  const classVEntries = entries.filter((e) => e.item.supplyClass === "V");

  // Which weapon systems are already added (to exclude from add dialog)
  const assignedWeaponIds = new Set(weapons.map((w) => w.weaponSystemId));
  const availableWeapons = (weaponSystems ?? []).filter(
    (ws) => !assignedWeaponIds.has(ws.id),
  );

  return (
    <div className="space-y-6">
      {/* Ammo Posture + GCE row */}
      <div className="grid md:grid-cols-3 gap-4">
        {/* Posture selector */}
        <Card className="md:col-span-2 border-border">
          <CardHeader className="pb-3 pt-4 px-4 border-b border-border">
            <CardTitle className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground flex items-center gap-2">
              <Target className="w-3.5 h-3.5" /> Ammo Posture
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <div className="grid grid-cols-3 gap-2">
              {(["combat_load", "assault", "sustain"] as AmmoPosture[]).map((p) => {
                const meta = POSTURE_LABELS[p];
                const active = ammoPosture === p;
                return (
                  <button
                    key={p}
                    type="button"
                    disabled={updateUnit.isPending}
                    onClick={() => handlePostureChange(p)}
                    className={`p-3 rounded-sm border text-left transition-all ${
                      active
                        ? meta.color + " ring-1 ring-inset ring-current"
                        : "bg-muted/30 border-border hover:bg-muted/60 text-muted-foreground"
                    }`}
                  >
                    <div className="font-mono text-[10px] font-bold uppercase tracking-widest mb-1">
                      {meta.label}
                    </div>
                    <div className="font-mono text-[9px] opacity-80 leading-relaxed">
                      {meta.desc}
                    </div>
                  </button>
                );
              })}
            </div>

            {ammoPosture === "combat_load" && (
              <div className="mt-3 p-2.5 bg-muted/40 border border-border rounded-sm font-mono text-[10px] text-muted-foreground">
                Combat load = total issue quantity. Daily equivalent = CL ÷ mission days for DOS calc.
              </div>
            )}
          </CardContent>
        </Card>

        {/* GCE / Non-GCE */}
        <Card className="border-border">
          <CardHeader className="pb-3 pt-4 px-4 border-b border-border">
            <CardTitle className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground flex items-center gap-2">
              <Shield className="w-3.5 h-3.5" /> Unit Type
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              {[
                { val: true,  label: "GCE",      desc: "Ground Combat Element — contact rates" },
                { val: false, label: "Non-GCE",  desc: "Aviation / Log / CE — reduced rates" },
              ].map(({ val, label, desc }) => (
                <button
                  key={String(val)}
                  type="button"
                  disabled={updateUnit.isPending}
                  onClick={() => handleGceToggle(val)}
                  className={`p-3 rounded-sm border text-left transition-all ${
                    isGce === val
                      ? "bg-primary/10 border-primary/40 text-primary ring-1 ring-inset ring-primary"
                      : "bg-muted/30 border-border text-muted-foreground hover:bg-muted/60"
                  }`}
                >
                  <div className="font-mono text-[10px] font-bold uppercase tracking-widest mb-1">{label}</div>
                  <div className="font-mono text-[9px] opacity-80 leading-relaxed">{desc}</div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Weapon Assignments */}
      <Card className="border-border">
        <CardHeader className="pb-3 pt-4 px-4 border-b border-border flex flex-row items-center justify-between">
          <CardTitle className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">
            Weapon Assignments ({weapons.length})
          </CardTitle>
          <Button
            size="sm"
            className="font-mono uppercase text-[10px] tracking-widest h-7"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="w-3 h-3 mr-1.5" /> Add Weapon
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {weapons.length === 0 ? (
            <div className="px-4 py-10 text-center text-muted-foreground font-mono text-xs tracking-wide">
              No weapons assigned. Add weapon systems to enable doctrinal Class V burn rates.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {weapons.map((w) => (
                <div key={w.id} className="px-4 py-3 flex items-center justify-between hover:bg-muted/20 transition-colors">
                  <div>
                    <div className="font-mono font-bold text-xs">{w.weaponName}</div>
                    <div className="font-mono text-[10px] text-muted-foreground mt-0.5 flex gap-2 items-center">
                      {w.tamcn && <span>TAMCN: {w.tamcn}</span>}
                      <span className={`px-1 py-0.5 rounded-sm border text-[9px] font-mono ${w.isGce ? "bg-primary/10 border-primary/30 text-primary" : "bg-muted border-border text-muted-foreground"}`}>
                        {w.isGce ? "GCE" : "Non-GCE"}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {editEntry?.id === w.id ? (
                      <div className="flex items-center gap-2">
                        <NumberStepper
                          value={editEntry.qty}
                          onChange={(v) => setEditEntry({ id: w.id, qty: v })}
                          min={1}
                          step={1}
                          secondaryStep={10}
                          aria-label="Quantity"
                          className="w-28"
                        />
                        <Button
                          size="sm"
                          className="h-7 font-mono text-[10px] uppercase tracking-widest"
                          onClick={() => handleSaveEdit(w.id, editEntry.qty)}
                          disabled={patchWeapon.isPending}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 font-mono text-[10px]"
                          onClick={() => setEditEntry(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <>
                        <button
                          className="font-mono text-xs tabular-nums px-2 py-1 rounded-sm border border-border hover:bg-muted/40 transition-colors"
                          onClick={() => setEditEntry({ id: w.id, qty: w.quantity })}
                        >
                          {w.quantity.toLocaleString()} ea
                        </button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive/60 hover:text-destructive"
                          onClick={() => handleDelete(w.id)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Class V Ammo Status */}
      {classVEntries.length > 0 && (
        <Card className="border-border">
          <CardHeader className="pb-3 pt-4 px-4 border-b border-border">
            <CardTitle className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">
              Class V — Ammo Status ({ammoPosture === "combat_load" ? "Combat Load Gap" : `${ammoPosture === "assault" ? "Assault" : "Sustain"} Rate · DOS`})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {classVEntries.map((e) => {
                const statusColor =
                  e.status === "green"
                    ? "text-success"
                    : e.status === "amber"
                      ? "text-warning"
                      : "text-destructive";
                const barColor =
                  e.status === "green"
                    ? "bg-success"
                    : e.status === "amber"
                      ? "bg-warning"
                      : "bg-destructive";

                // For combat_load: show on-hand vs target
                const isCombatLoad = ammoPosture === "combat_load";
                const targetQty = isCombatLoad
                  ? (e.combatLoadTarget ?? e.required)
                  : e.required;
                const pct = targetQty > 0 ? Math.min(100, (e.onHand / targetQty) * 100) : 100;

                return (
                  <div key={e.id} className="px-4 py-3 hover:bg-muted/20 transition-colors">
                    <div className="flex items-start justify-between mb-1.5">
                      <div className="flex-1 min-w-0 pr-4">
                        <div className="font-mono font-bold text-xs leading-snug">{e.item.name}</div>
                        {e.burnBreakdown && (
                          <div className="font-mono text-[9px] text-muted-foreground mt-0.5">{e.burnBreakdown}</div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        {isCombatLoad ? (
                          <>
                            <div className={`font-mono text-xs font-bold tabular-nums ${statusColor}`}>
                              {e.onHand.toLocaleString()} / {Math.round(targetQty).toLocaleString()}
                            </div>
                            <div className="font-mono text-[9px] text-muted-foreground">on-hand / target</div>
                          </>
                        ) : (
                          <>
                            <div className={`font-mono text-xs font-bold tabular-nums ${statusColor}`}>
                              {e.daysOfSupply >= 99 ? "∞" : e.daysOfSupply.toFixed(1)}d
                            </div>
                            <div className="font-mono text-[9px] text-muted-foreground tabular-nums">
                              {e.onHand.toLocaleString()} on-hand · {e.dailyConsumption.toLocaleString()} /day
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                    {/* Progress bar */}
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${barColor}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {isCombatLoad && e.shortfall > 0 && (
                      <div className="font-mono text-[9px] text-destructive mt-1">
                        Shortfall: {Math.round(e.shortfall).toLocaleString()} {e.item.unit}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {classVEntries.length === 0 && weapons.length === 0 && (
        <div className="border border-dashed border-border/50 rounded-sm p-8 text-center text-muted-foreground">
          <Target className="w-8 h-8 mx-auto mb-3 opacity-20" />
          <div className="font-mono text-xs uppercase tracking-widest mb-1">No weapon-driven ammo data</div>
          <div className="font-mono text-[10px] opacity-60">Add weapon systems and Class V catalog items to enable doctrinal burn rates.</div>
        </div>
      )}

      {/* Add Weapon Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="font-mono uppercase text-sm tracking-widest">Add Weapon System</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Weapon System</Label>
              <Popover open={weaponPickerOpen} onOpenChange={setWeaponPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={weaponPickerOpen}
                    className="w-full justify-between font-mono text-xs h-9 px-3"
                  >
                    <span className="truncate">
                      {addWeaponId
                        ? (availableWeapons.find((ws) => ws.id === addWeaponId)?.name ?? "—")
                        : "Search by name or TAMCN…"}
                    </span>
                    <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[340px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search name or TAMCN…" className="font-mono text-xs h-8" />
                    <CommandList className="max-h-52">
                      <CommandEmpty className="py-3 text-center text-xs font-mono text-muted-foreground">
                        No weapon systems found
                      </CommandEmpty>
                      {availableWeapons.map((ws) => (
                        <CommandItem
                          key={ws.id}
                          value={`${ws.name} ${ws.tamcn ?? ""}`}
                          onSelect={() => {
                            setAddWeaponId(ws.id);
                            setWeaponPickerOpen(false);
                          }}
                          className="font-mono text-xs cursor-pointer"
                        >
                          <Check className={`mr-2 h-3.5 w-3.5 ${addWeaponId === ws.id ? "opacity-100" : "opacity-0"}`} />
                          <span className="flex-1">{ws.name}</span>
                          {ws.tamcn && <span className="ml-2 text-muted-foreground">{ws.tamcn}</span>}
                        </CommandItem>
                      ))}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-1.5">
              <Label className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">Quantity</Label>
              <NumberStepper
                value={addQty}
                onChange={setAddQty}
                min={1}
                step={1}
                secondaryStep={10}
                aria-label="Quantity"
              />
            </div>
            <div className="flex gap-2 pt-2">
              <Button
                variant="outline"
                className="flex-1 font-mono uppercase text-[10px] tracking-widest"
                onClick={() => { setAddOpen(false); setAddWeaponId(""); setAddQty(1); }}
              >
                Cancel
              </Button>
              <Button
                className="flex-1 font-mono uppercase text-[10px] tracking-widest"
                onClick={handleAddWeapon}
                disabled={addWeapon.isPending || !addWeaponId}
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Add
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
