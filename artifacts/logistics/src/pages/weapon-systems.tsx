import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Title } from "@/components/title";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  useListWeaponSystems,
  useUpdateWeaponDodicRate,
  getListWeaponSystemsQueryKey,
  getGetDashboardSummaryQueryKey,
  getListDeficienciesQueryKey,
  getGetResupplyForecastQueryKey,
  getListRecentActivityQueryKey,
  type WeaponSystem,
  type WeaponDodicRate,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Crosshair, Edit } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

const numericString = z
  .string()
  .refine(
    (v) => {
      const n = Number(v);
      return v.trim() !== "" && Number.isFinite(n) && n >= 0;
    },
    { message: "Must be a number ≥ 0" },
  );

const editSchema = z.object({
  gceCombatLoad: numericString,
  gceAssaultRate: numericString,
  gceSustainRate: numericString,
  nonGceCombatLoad: numericString,
  nonGceAssaultRate: numericString,
  nonGceSustainRate: numericString,
});

type EditValues = z.infer<typeof editSchema>;

interface EditingTarget {
  weapon: WeaponSystem;
  rate: WeaponDodicRate;
}

function formatRate(n: number) {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  return n.toLocaleString(undefined, {
    maximumFractionDigits: 4,
    minimumFractionDigits: 0,
  });
}

export default function WeaponSystemsAdmin() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: weaponSystems, isLoading } = useListWeaponSystems({
    query: { queryKey: getListWeaponSystemsQueryKey() },
  });

  const updateRate = useUpdateWeaponDodicRate();

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<EditingTarget | null>(null);

  const editForm = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      gceCombatLoad: "0",
      gceAssaultRate: "0",
      gceSustainRate: "0",
      nonGceCombatLoad: "0",
      nonGceAssaultRate: "0",
      nonGceSustainRate: "0",
    },
  });

  const filtered = useMemo(() => {
    const all = weaponSystems ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        (w.tamcn ?? "").toLowerCase().includes(q) ||
        w.dodics.some(
          (r) =>
            r.dodic.toLowerCase().includes(q) ||
            r.nomenclature.toLowerCase().includes(q),
        ),
    );
  }, [weaponSystems, search]);

  const totalSystems = weaponSystems?.length ?? 0;
  const totalRates = (weaponSystems ?? []).reduce(
    (n, w) => n + w.dodics.length,
    0,
  );

  const openEdit = (weapon: WeaponSystem, rate: WeaponDodicRate) => {
    setEditing({ weapon, rate });
    editForm.reset({
      gceCombatLoad: String(rate.gceCombatLoad),
      gceAssaultRate: String(rate.gceAssaultRate),
      gceSustainRate: String(rate.gceSustainRate),
      nonGceCombatLoad: String(rate.nonGceCombatLoad),
      nonGceAssaultRate: String(rate.nonGceAssaultRate),
      nonGceSustainRate: String(rate.nonGceSustainRate),
    });
  };

  const closeEdit = () => setEditing(null);

  const handleSave = async (values: EditValues) => {
    if (!editing) return;

    const next = {
      gceCombatLoad: Number(values.gceCombatLoad),
      gceAssaultRate: Number(values.gceAssaultRate),
      gceSustainRate: Number(values.gceSustainRate),
      nonGceCombatLoad: Number(values.nonGceCombatLoad),
      nonGceAssaultRate: Number(values.nonGceAssaultRate),
      nonGceSustainRate: Number(values.nonGceSustainRate),
    };

    const r = editing.rate;
    const unchanged =
      next.gceCombatLoad === r.gceCombatLoad &&
      next.gceAssaultRate === r.gceAssaultRate &&
      next.gceSustainRate === r.gceSustainRate &&
      next.nonGceCombatLoad === r.nonGceCombatLoad &&
      next.nonGceAssaultRate === r.nonGceAssaultRate &&
      next.nonGceSustainRate === r.nonGceSustainRate;

    if (unchanged) {
      closeEdit();
      return;
    }

    try {
      await updateRate.mutateAsync({
        weaponSystemId: editing.weapon.id,
        rateId: editing.rate.id,
        data: next,
      });

      // Refresh weapon list itself...
      qc.invalidateQueries({ queryKey: getListWeaponSystemsQueryKey() });
      // ...and every read that may embed weapon-driven Class V burn rates.
      qc.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      qc.invalidateQueries({ queryKey: getListDeficienciesQueryKey() });
      qc.invalidateQueries({ queryKey: getGetResupplyForecastQueryKey() });
      qc.invalidateQueries({ queryKey: getListRecentActivityQueryKey() });
      qc.invalidateQueries({
        predicate: (q) => {
          const k = q.queryKey?.[0];
          return (
            typeof k === "string" &&
            (k.startsWith("/units") ||
              k.startsWith("/api/units") ||
              k.startsWith("/dashboard") ||
              k.startsWith("/api/dashboard"))
          );
        },
      });

      toast({
        title: "DODIC rates updated",
        description: `${editing.weapon.name} / ${editing.rate.dodic}`,
      });
      closeEdit();
    } catch {
      toast({ title: "Failed to update rates", variant: "destructive" });
    }
  };

  return (
    <Layout>
      <Title title="Weapon Systems" />
      <PageHeader
        tag="Doctrine"
        title="Weapon Systems & DODIC Rates"
        subtitle="Edit doctrinal combat-load / assault / sustain burn rates per weapon-DODIC pair."
      />

      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
          <Crosshair className="w-3.5 h-3.5 text-primary" />
          {totalSystems} weapon system{totalSystems === 1 ? "" : "s"} ·{" "}
          {totalRates} DODIC rate{totalRates === 1 ? "" : "s"}
        </div>
        <Input
          placeholder="Search weapon, TAMCN, or DODIC…"
          className="font-mono text-xs h-8 max-w-sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="input-weapon-search"
        />
      </div>

      <div className="space-y-4">
        {isLoading && (
          <Card className="border-border p-10 text-center text-xs font-mono text-muted-foreground tracking-wide">
            Loading weapon systems…
          </Card>
        )}

        {!isLoading && filtered.length === 0 && (
          <Card className="border-border p-10 text-center text-xs font-mono text-muted-foreground tracking-wide">
            {search.trim()
              ? "No weapon systems match your search."
              : "No weapon systems on file."}
          </Card>
        )}

        {!isLoading &&
          filtered.map((w) => (
            <Card key={w.id} className="border-border" data-testid={`weapon-card-${w.id}`}>
              <div className="px-4 py-3 border-b border-border flex flex-col md:flex-row md:items-center md:justify-between gap-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-sm font-mono">{w.name}</span>
                  {w.tamcn && (
                    <span className="text-[10px] font-mono text-muted-foreground tracking-widest">
                      TAMCN {w.tamcn}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  {w.dodics.length} DODIC
                  {w.dodics.length === 1 ? "" : "s"}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-[10px] font-mono uppercase tracking-widest bg-muted/40 text-muted-foreground border-b border-border">
                    <tr>
                      <th className="px-4 py-2 align-bottom" rowSpan={2}>
                        DODIC
                      </th>
                      <th className="px-4 py-2 align-bottom" rowSpan={2}>
                        Nomenclature
                      </th>
                      <th
                        className="px-4 py-2 text-center border-l border-border"
                        colSpan={3}
                      >
                        GCE
                      </th>
                      <th
                        className="px-4 py-2 text-center border-l border-border"
                        colSpan={3}
                      >
                        Non-GCE
                      </th>
                      <th
                        className="px-4 py-2 text-right align-bottom"
                        rowSpan={2}
                      >
                        Actions
                      </th>
                    </tr>
                    <tr>
                      <th className="px-3 py-1.5 text-right border-l border-border">
                        Combat
                      </th>
                      <th className="px-3 py-1.5 text-right">Assault</th>
                      <th className="px-3 py-1.5 text-right">Sustain</th>
                      <th className="px-3 py-1.5 text-right border-l border-border">
                        Combat
                      </th>
                      <th className="px-3 py-1.5 text-right">Assault</th>
                      <th className="px-3 py-1.5 text-right">Sustain</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border font-mono">
                    {w.dodics.length === 0 && (
                      <tr>
                        <td
                          colSpan={9}
                          className="px-4 py-6 text-center text-xs text-muted-foreground tracking-wide"
                        >
                          No DODIC rates configured for this weapon system.
                        </td>
                      </tr>
                    )}
                    {w.dodics.map((r) => (
                      <tr
                        key={r.id}
                        className="hover:bg-muted/20 transition-colors"
                        data-testid={`dodic-row-${r.id}`}
                      >
                        <td className="px-4 py-2 text-xs font-bold tabular-nums">
                          {r.dodic}
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {r.nomenclature}
                        </td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums border-l border-border">
                          {formatRate(r.gceCombatLoad)}
                        </td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums">
                          {formatRate(r.gceAssaultRate)}
                        </td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums">
                          {formatRate(r.gceSustainRate)}
                        </td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums border-l border-border">
                          {formatRate(r.nonGceCombatLoad)}
                        </td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums">
                          {formatRate(r.nonGceAssaultRate)}
                        </td>
                        <td className="px-3 py-2 text-xs text-right tabular-nums">
                          {formatRate(r.nonGceSustainRate)}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 font-mono uppercase text-[10px] tracking-widest"
                            onClick={() => openEdit(w, r)}
                            data-testid={`button-edit-rate-${r.id}`}
                          >
                            <Edit className="w-3 h-3 mr-1" />
                            Edit
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
      </div>

      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) closeEdit();
        }}
      >
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="font-mono uppercase text-sm tracking-widest">
              Edit DODIC Rates
            </DialogTitle>
          </DialogHeader>
          {editing && (
            <p className="text-[10px] font-mono text-muted-foreground -mt-1">
              {editing.weapon.name} · DODIC{" "}
              <span className="font-bold">{editing.rate.dodic}</span> ·{" "}
              {editing.rate.nomenclature}. Changes apply immediately to every
              unit's days-of-supply calculation.
            </p>
          )}

          <Form {...editForm}>
            <form
              onSubmit={editForm.handleSubmit(handleSave)}
              className="space-y-4 pt-1"
              data-testid="form-edit-dodic-rate"
            >
              <div className="space-y-2">
                <div className="text-[10px] font-mono uppercase tracking-widest text-primary">
                  GCE (Ground Combat Element)
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <FormField
                    control={editForm.control}
                    name="gceCombatLoad"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-[10px] tracking-widest">
                          Combat Load
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            className="font-mono text-xs h-8"
                            data-testid="input-gce-combat"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage className="text-[10px]" />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editForm.control}
                    name="gceAssaultRate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-[10px] tracking-widest">
                          Assault / Day
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            className="font-mono text-xs h-8"
                            data-testid="input-gce-assault"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage className="text-[10px]" />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editForm.control}
                    name="gceSustainRate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-[10px] tracking-widest">
                          Sustain / Day
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            className="font-mono text-xs h-8"
                            data-testid="input-gce-sustain"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage className="text-[10px]" />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Non-GCE (Aviation, Logistics, etc.)
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <FormField
                    control={editForm.control}
                    name="nonGceCombatLoad"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-[10px] tracking-widest">
                          Combat Load
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            className="font-mono text-xs h-8"
                            data-testid="input-nongce-combat"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage className="text-[10px]" />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editForm.control}
                    name="nonGceAssaultRate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-[10px] tracking-widest">
                          Assault / Day
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            className="font-mono text-xs h-8"
                            data-testid="input-nongce-assault"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage className="text-[10px]" />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={editForm.control}
                    name="nonGceSustainRate"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-mono uppercase text-[10px] tracking-widest">
                          Sustain / Day
                        </FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            className="font-mono text-xs h-8"
                            data-testid="input-nongce-sustain"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage className="text-[10px]" />
                      </FormItem>
                    )}
                  />
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <Button
                  type="submit"
                  className="flex-1 font-mono uppercase text-[10px] tracking-widest"
                  disabled={updateRate.isPending}
                  data-testid="button-save-dodic-rate"
                >
                  {updateRate.isPending ? "Saving…" : "Save Changes"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1 font-mono uppercase text-[10px] tracking-widest"
                  onClick={closeEdit}
                  disabled={updateRate.isPending}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
