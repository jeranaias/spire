import { Title } from "@/components/title";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/page-header";
import { useLocation, useRoute, Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NumberStepper } from "@/components/ui/number-stepper";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandItem, CommandList, CommandEmpty } from "@/components/ui/command";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useGetUnit,
  useUpdateUnit,
  useAddUnitWeapon,
  useUpdateUnitWeapon,
  useDeleteUnitWeapon,
  useListWeaponSystems,
  getGetUnitQueryKey,
  getListUnitsQueryKey,
  getListWeaponSystemsQueryKey,
  Echelon,
  Climate,
  OpTempo,
  UnitRole,
} from "@workspace/api-client-react";
import type { UnitDetail } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Save, Plus, Trash2, Target, ChevronsUpDown, Check } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { validateDistroEmails } from "@workspace/distro-email";
import {
  DistroEmailFieldsCard,
  distroEmailsField,
} from "@/components/distro-email-fields";

const ECHELON_LABELS: Record<string, string> = {
  fireteam: "Fire Team",
  squad: "Squad",
  section: "Section",
  platoon: "Platoon",
  company: "Company",
  battalion: "Battalion",
  regiment: "Regiment",
  battery: "Battery",
  team: "Team",
};

const ROLE_LABELS: Record<string, string> = {
  organic: "Organic",
  attached: "Attached",
  in_support: "In Support",
};

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  callsign: z.string().optional(),
  echelon: z.nativeEnum(Echelon),
  personnel: z.coerce.number().min(1, "Must have at least 1 person"),
  commander: z.string().optional(),
  location: z.string().optional(),
  climate: z.nativeEnum(Climate),
  opTempo: z.nativeEnum(OpTempo),
  missionDays: z.coerce.number().min(1, "Must be at least 1 day"),
  role: z.nativeEnum(UnitRole),
  distroEmails: distroEmailsField,
  distroCcEmails: distroEmailsField,
  distroBccEmails: distroEmailsField,
});

export default function EditUnit() {
  const [, params] = useRoute("/units/:id/edit");
  const unitId = params?.id ?? "";

  const { data: unitDetail, isLoading } = useGetUnit(unitId, {
    query: { enabled: !!unitId, queryKey: getGetUnitQueryKey(unitId) },
  });

  if (isLoading || !unitDetail) {
    return (
      <Layout>
        <div className="mb-6 animate-pulse">
          <div className="w-16 h-3 bg-muted rounded-sm mb-4" />
          <div className="w-64 h-7 bg-muted rounded-sm mb-3" />
          <div className="w-80 h-3 bg-muted rounded-sm" />
        </div>
        <div className="space-y-3">
          <div className="h-64 bg-muted animate-pulse rounded-sm" />
          <div className="h-32 bg-muted animate-pulse rounded-sm" />
        </div>
      </Layout>
    );
  }

  return <EditUnitForm key={unitDetail.unit.id} unitId={unitId} unitDetail={unitDetail} />;
}

function EditUnitForm({ unitId, unitDetail }: { unitId: string; unitDetail: UnitDetail }) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: weaponSystems } = useListWeaponSystems({
    query: { queryKey: getListWeaponSystemsQueryKey() },
  });

  const updateUnit = useUpdateUnit();
  const addWeapon = useAddUnitWeapon();
  const patchWeapon = useUpdateUnitWeapon();
  const delWeapon = useDeleteUnitWeapon();

  const [addOpen, setAddOpen] = useState(false);
  const [addWeaponId, setAddWeaponId] = useState("");
  const [addQty, setAddQty] = useState(1);
  const [weaponPickerOpen, setWeaponPickerOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<{ id: string; qty: number } | null>(null);

  const u = unitDetail.unit;
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: u.name,
      callsign: u.callsign ?? "",
      echelon: u.echelon as z.infer<typeof formSchema>["echelon"],
      personnel: u.personnel,
      commander: u.commander ?? "",
      location: u.location ?? "",
      climate: u.climate as z.infer<typeof formSchema>["climate"],
      opTempo: u.opTempo as z.infer<typeof formSchema>["opTempo"],
      missionDays: u.missionDays,
      role: u.role as z.infer<typeof formSchema>["role"],
      distroEmails: (u.distroEmails ?? []).join("\n"),
      distroCcEmails: (u.distroCcEmails ?? []).join("\n"),
      distroBccEmails: (u.distroBccEmails ?? []).join("\n"),
    },
  });

  const weapons = unitDetail.weapons ?? [];
  const assignedWeaponIds = new Set(weapons.map((w) => w.weaponSystemId));
  const availableWeapons = (weaponSystems ?? []).filter(
    (ws) => !assignedWeaponIds.has(ws.id),
  );

  const invalidateUnit = () => {
    queryClient.invalidateQueries({ queryKey: getGetUnitQueryKey(unitId) });
  };

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
      invalidateUnit();
      setAddOpen(false);
      setAddWeaponId("");
      setAddQty(1);
      toast({ title: "Weapon added" });
    } catch {
      toast({ title: "Failed to add weapon", variant: "destructive" });
    }
  }

  async function handleSaveWeaponQty(weaponEntryId: string, qty: number) {
    try {
      await patchWeapon.mutateAsync({
        unitId,
        weaponEntryId,
        data: { quantity: qty },
      });
      invalidateUnit();
      setEditEntry(null);
    } catch {
      toast({ title: "Failed to update quantity", variant: "destructive" });
    }
  }

  async function handleDeleteWeapon(weaponEntryId: string) {
    if (!confirm("Remove this weapon from the unit?")) return;
    try {
      await delWeapon.mutateAsync({ unitId, weaponEntryId });
      invalidateUnit();
      toast({ title: "Weapon removed" });
    } catch {
      toast({ title: "Failed to remove weapon", variant: "destructive" });
    }
  }

  async function onSubmit(values: z.infer<typeof formSchema>) {
    try {
      const {
        distroEmails: distroEmailsRaw,
        distroCcEmails: distroCcEmailsRaw,
        distroBccEmails: distroBccEmailsRaw,
        ...rest
      } = values;
      // The schema's superRefine guarantees no invalid tokens reach this point,
      // so validEmails contains every parsed entry — we just need the dedupe
      // and split that validateDistroEmails performs.
      const distroSummary = validateDistroEmails(distroEmailsRaw);
      const distroCcSummary = validateDistroEmails(distroCcEmailsRaw);
      const distroBccSummary = validateDistroEmails(distroBccEmailsRaw);
      await updateUnit.mutateAsync({
        unitId,
        data: {
          ...rest,
          callsign: values.callsign && values.callsign.trim() !== "" ? values.callsign : undefined,
          commander: values.commander && values.commander.trim() !== "" ? values.commander : undefined,
          location: values.location && values.location.trim() !== "" ? values.location : undefined,
          distroEmails: distroSummary.validEmails,
          distroCcEmails: distroCcSummary.validEmails,
          distroBccEmails: distroBccSummary.validEmails,
          // Preserve weapon-related state controlled from the Weapons tab
          ammoPosture: u.ammoPosture,
          isGce: u.isGce,
        },
      });
      queryClient.invalidateQueries({ queryKey: getListUnitsQueryKey() });
      invalidateUnit();
      toast({ title: "Unit updated" });
      setLocation(`/units/${unitId}`);
    } catch {
      toast({ title: "Failed to update unit", variant: "destructive" });
    }
  }

  return (
    <Layout>
      <Title title={`Edit ${unitDetail.unit.name}`} />

      <Link
        href={`/units/${unitId}`}
        className="inline-flex items-center text-xs font-mono text-muted-foreground hover:text-foreground transition-colors mb-4 tracking-widest uppercase"
      >
        <ArrowLeft className="w-3.5 h-3.5 mr-1.5" />
        Back to Unit
      </Link>
      <PageHeader
        title={`Edit ${unitDetail.unit.name}`}
        tag="Modify"
        subtitle="Update unit details and weapon loadout"
      />

      <div className="max-w-2xl">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <Card>
              <CardContent className="p-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-xs">Unit Name</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. 1st Platoon, Alpha Co" className="font-mono" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="callsign"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-xs">Callsign (Optional)</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. WARLORD 1" className="font-mono" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="echelon"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-xs">Echelon</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger className="font-mono">
                              <SelectValue placeholder="Select echelon" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {Object.values(Echelon).map((e) => (
                              <SelectItem key={e} value={e} className="font-mono">
                                {ECHELON_LABELS[e] ?? e}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="role"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-xs">Relationship</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger className="font-mono">
                              <SelectValue placeholder="Select relationship" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {Object.values(UnitRole).map((r) => (
                              <SelectItem key={r} value={r} className="font-mono">
                                {ROLE_LABELS[r] ?? r}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="personnel"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-xs">Personnel (PAX)</FormLabel>
                        <FormControl>
                          <Input type="number" min="1" className="font-mono" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="commander"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-xs">Commander / OIC</FormLabel>
                        <FormControl>
                          <Input placeholder="e.g. 1stLt Smith" className="font-mono" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="location"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-xs">Location</FormLabel>
                        <FormControl>
                          <Input placeholder="Grid or Base" className="font-mono" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="climate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-xs">Climate Zone</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger className="font-mono uppercase">
                              <SelectValue placeholder="Select climate" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {Object.values(Climate).map((c) => (
                              <SelectItem key={c} value={c} className="font-mono uppercase">
                                {c}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="opTempo"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-xs">Operations Tempo</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger className="font-mono uppercase">
                              <SelectValue placeholder="Select tempo" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {Object.values(OpTempo).map((o) => (
                              <SelectItem key={o} value={o} className="font-mono uppercase">
                                {o}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="missionDays"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-xs">Mission Duration (Days)</FormLabel>
                        <FormControl>
                          <Input type="number" min="1" className="font-mono" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </CardContent>
            </Card>

            <DistroEmailFieldsCard control={form.control} />

            <Card data-testid="card-weapons-section">
              <CardHeader className="pb-3 pt-4 px-4 border-b border-border flex flex-row items-center justify-between space-y-0">
                <CardTitle className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground flex items-center gap-2">
                  <Target className="w-3.5 h-3.5" />
                  Weapon Assignments ({weapons.length})
                </CardTitle>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="font-mono uppercase text-[10px] tracking-widest h-7"
                  onClick={() => setAddOpen(true)}
                  data-testid="button-add-weapon"
                >
                  <Plus className="w-3 h-3 mr-1.5" /> Add Weapon
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                {weapons.length === 0 ? (
                  <div className="px-4 py-6 text-center text-muted-foreground font-mono text-[11px] tracking-wide">
                    No weapons assigned. Add weapon systems to enable doctrinal Class V burn rates.
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {weapons.map((w) => (
                      <div
                        key={w.id}
                        className="px-4 py-3 flex items-center justify-between hover:bg-muted/20 transition-colors"
                        data-testid={`row-weapon-${w.id}`}
                      >
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
                                type="button"
                                size="sm"
                                className="h-7 font-mono text-[10px] uppercase tracking-widest"
                                onClick={() => handleSaveWeaponQty(w.id, editEntry.qty)}
                                disabled={patchWeapon.isPending}
                                data-testid={`button-save-weapon-qty-${w.id}`}
                              >
                                Save
                              </Button>
                              <Button
                                type="button"
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
                                type="button"
                                className="font-mono text-xs tabular-nums px-2 py-1 rounded-sm border border-border hover:bg-muted/40 transition-colors"
                                onClick={() => setEditEntry({ id: w.id, qty: w.quantity })}
                                data-testid={`button-edit-weapon-qty-${w.id}`}
                              >
                                {w.quantity.toLocaleString()} ea
                              </button>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 text-destructive/60 hover:text-destructive"
                                onClick={() => handleDeleteWeapon(w.id)}
                                data-testid={`button-delete-weapon-${w.id}`}
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

            <div className="flex justify-end pt-2">
              <Button
                type="submit"
                disabled={updateUnit.isPending}
                className="font-mono uppercase tracking-wider"
                data-testid="button-save-unit"
              >
                {updateUnit.isPending ? "Saving..." : <><Save className="w-4 h-4 mr-2" /> Save Changes</>}
              </Button>
            </div>
          </form>
        </Form>
      </div>

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
                    type="button"
                    variant="outline"
                    role="combobox"
                    aria-expanded={weaponPickerOpen}
                    className="w-full justify-between font-mono text-xs h-9 px-3"
                    data-testid="button-pick-weapon"
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
                type="button"
                variant="outline"
                className="flex-1 font-mono uppercase text-[10px] tracking-widest"
                onClick={() => { setAddOpen(false); setAddWeaponId(""); setAddQty(1); }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                className="flex-1 font-mono uppercase text-[10px] tracking-widest"
                onClick={handleAddWeapon}
                disabled={addWeapon.isPending || !addWeaponId}
                data-testid="button-confirm-add-weapon"
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Add
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
