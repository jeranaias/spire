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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  useListCatalogItems,
  useUpdateCatalogItem,
  useDeleteCatalogItem,
  useRestoreCatalogItem,
  getListCatalogItemsQueryKey,
  getListUnitsQueryKey,
  getGetDashboardSummaryQueryKey,
  getListDeficienciesQueryKey,
  getGetResupplyForecastQueryKey,
  getListRecentActivityQueryKey,
  SupplyClass,
} from "@workspace/api-client-react";
import type { CatalogItem } from "@workspace/api-client-react";
import { BookOpen, Edit, Sparkles, Trash2, Undo2, Users } from "lucide-react";
import { ToastAction } from "@/components/ui/toast";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useState, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Link } from "wouter";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const editSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  supplyClass: z.nativeEnum(SupplyClass),
  unit: z.string().trim().min(1, "Unit of issue is required"),
  nsn: z.string().optional(),
  baseDailyRate: z
    .string()
    .optional()
    .refine(
      (v) => {
        if (v == null || v.trim() === "") return true;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0;
      },
      { message: "Daily rate must be a number ≥ 0" },
    ),
  criticality: z.enum(["low", "medium", "high", "critical"]),
  notes: z.string().optional(),
});

type EditValues = z.infer<typeof editSchema>;

function invalidateCatalogDependents(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: getListCatalogItemsQueryKey() });
  queryClient.invalidateQueries({ queryKey: getListUnitsQueryKey() });
  queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  queryClient.invalidateQueries({ queryKey: getListDeficienciesQueryKey() });
  queryClient.invalidateQueries({ queryKey: getGetResupplyForecastQueryKey() });
  queryClient.invalidateQueries({ queryKey: getListRecentActivityQueryKey() });
  // Per-unit queries (supply, resupply, unit detail) — invalidate by URL prefix
  // since they're keyed by unit id.
  queryClient.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey?.[0];
      return (
        typeof k === "string" &&
        (k.startsWith("/units/") || k.startsWith("/api/units/"))
      );
    },
  });
}

export default function CatalogManagement() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: catalogItems, isLoading } = useListCatalogItems({
    query: { queryKey: getListCatalogItemsQueryKey() },
  });

  const updateItem = useUpdateCatalogItem();
  const deleteItem = useDeleteCatalogItem();
  const restoreItem = useRestoreCatalogItem();

  const [search, setSearch] = useState("");
  const [showOnlyUnused, setShowOnlyUnused] = useState(false);
  const [editing, setEditing] = useState<CatalogItem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CatalogItem | null>(null);

  const editForm = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      name: "",
      supplyClass: SupplyClass.I,
      unit: "",
      nsn: "",
      baseDailyRate: "",
      criticality: "low",
      notes: "",
    },
  });

  const customItems = useMemo(() => {
    const all = catalogItems ?? [];
    const filtered = all.filter((c) => c.isCustom);
    const q = search.trim().toLowerCase();
    const matched = q
      ? filtered.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.supplyClass.toLowerCase().includes(q) ||
            (c.nsn ?? "").toLowerCase().includes(q),
        )
      : filtered;
    const usageFiltered = showOnlyUnused
      ? matched.filter((c) => (c.usedByUnitCount ?? 0) === 0)
      : matched;
    return usageFiltered
      .slice()
      .sort(
        (a, b) =>
          a.supplyClass.localeCompare(b.supplyClass) ||
          a.name.localeCompare(b.name),
      );
  }, [catalogItems, search, showOnlyUnused]);

  const allCustom = (catalogItems ?? []).filter((c) => c.isCustom);
  const totalCustom = allCustom.length;
  const unusedCustomCount = allCustom.filter(
    (c) => (c.usedByUnitCount ?? 0) === 0,
  ).length;

  const openEdit = (item: CatalogItem) => {
    setEditing(item);
    editForm.reset({
      name: item.name,
      supplyClass: item.supplyClass as SupplyClass,
      unit: item.unit,
      nsn: item.nsn ?? "",
      baseDailyRate:
        item.baseDailyRate > 0 ? String(item.baseDailyRate) : "",
      criticality:
        (item.criticality as "low" | "medium" | "high" | "critical") ?? "low",
      notes: item.notes ?? "",
    });
  };

  const handleEdit = async (values: EditValues) => {
    if (!editing) return;
    const trimmedName = values.name.trim();
    const trimmedUnit = values.unit.trim();
    const trimmedNsn = values.nsn?.trim() ?? "";
    const trimmedNotes = values.notes?.trim() ?? "";
    const baseDailyRate =
      values.baseDailyRate && values.baseDailyRate.trim() !== ""
        ? Number(values.baseDailyRate)
        : 0;
    const nsnToSend = trimmedNsn === "" ? null : trimmedNsn;
    const notesToSend = trimmedNotes === "" ? null : trimmedNotes;

    // Skip the round-trip (and the noisy "edited" activity entry) when the
    // submitted values match what's already on the item.
    const unchanged =
      trimmedName === editing.name &&
      values.supplyClass === editing.supplyClass &&
      trimmedUnit === editing.unit &&
      nsnToSend === (editing.nsn ?? null) &&
      baseDailyRate === editing.baseDailyRate &&
      values.criticality === editing.criticality &&
      notesToSend === (editing.notes ?? null);
    if (unchanged) {
      setEditing(null);
      return;
    }

    try {
      await updateItem.mutateAsync({
        itemId: editing.id,
        data: {
          name: trimmedName,
          supplyClass: values.supplyClass,
          unit: trimmedUnit,
          nsn: nsnToSend,
          baseDailyRate,
          criticality: values.criticality,
          notes: notesToSend,
        },
      });
      // Refresh queries that embed the item name/details (catalog list, unit
      // list, dashboard summary, deficiencies, forecast, recent activity, and
      // any per-unit supply / resupply views).
      invalidateCatalogDependents(queryClient);
      toast({ title: "Catalog item updated" });
      setEditing(null);
    } catch (e) {
      toast({ title: "Failed to update item", variant: "destructive" });
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    const deleted = confirmDelete;
    try {
      const result = await deleteItem.mutateAsync({
        itemId: deleted.id,
      });
      invalidateCatalogDependents(queryClient);

      // The server returns a short-lived restore token (~30s window). The UI
      // surfaces a 15-second Undo affordance — easily within the server's
      // grace period even with clock skew or network jitter.
      const undoWindowMs = 15_000;
      toast({
        title: `Deleted "${deleted.name}"`,
        description:
          result.affectedUnits > 0
            ? `Removed from ${result.affectedUnits} unit${result.affectedUnits === 1 ? "" : "s"}. You can undo for the next 15 seconds.`
            : "No units were tracking this item. You can undo for the next 15 seconds.",
        duration: undoWindowMs,
        action: (
          <ToastAction
            altText="Undo delete"
            onClick={async () => {
              try {
                await restoreItem.mutateAsync({ itemId: result.restoreToken });
                invalidateCatalogDependents(queryClient);
                toast({
                  title: `Restored "${deleted.name}"`,
                  description:
                    "Catalog item, supply entries, and resupply events were restored.",
                });
              } catch (err) {
                toast({
                  title: "Could not undo delete",
                  description:
                    "The undo window may have expired. Refresh the page to verify.",
                  variant: "destructive",
                });
              }
            }}
            className="font-mono uppercase text-[10px] tracking-widest"
          >
            <Undo2 className="w-3 h-3 mr-1" />
            Undo
          </ToastAction>
        ),
      });
      setConfirmDelete(null);
    } catch (e) {
      toast({ title: "Failed to delete item", variant: "destructive" });
    }
  };

  return (
    <Layout>
      <Title title="Catalog Management" />
      <PageHeader
        tag="Logistics"
        title="Catalog Management"
        subtitle="Edit or delete custom catalog items shared across all units."
      />

      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
        <div className="flex items-center gap-3 text-[10px] font-mono uppercase tracking-widest text-muted-foreground flex-wrap">
          <span className="flex items-center gap-2">
            <BookOpen className="w-3.5 h-3.5 text-primary" />
            {totalCustom} custom catalog item{totalCustom === 1 ? "" : "s"}
          </span>
          {unusedCustomCount > 0 && (
            <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
              <Sparkles className="w-3 h-3" />
              {unusedCustomCount} unused
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            type="button"
            variant={showOnlyUnused ? "default" : "outline"}
            size="sm"
            onClick={() => setShowOnlyUnused((v) => !v)}
            disabled={unusedCustomCount === 0 && !showOnlyUnused}
            aria-pressed={showOnlyUnused}
            data-testid="button-filter-unused"
            className="h-8 font-mono uppercase text-[10px] tracking-widest"
          >
            <Sparkles className="w-3 h-3 mr-1.5" />
            {showOnlyUnused ? "Showing unused" : "Show unused only"}
            {unusedCustomCount > 0 && (
              <span className="ml-1.5 tabular-nums opacity-80">
                ({unusedCustomCount})
              </span>
            )}
          </Button>
          <Input
            placeholder="Search by name, NSN, or class..."
            className="font-mono text-xs h-8 max-w-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <Card className="border-border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="text-[10px] font-mono uppercase tracking-widest bg-muted/40 text-muted-foreground border-b border-border">
              <tr>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Class</th>
                <th className="px-4 py-2.5">NSN / DODIC</th>
                <th className="px-4 py-2.5">Unit of Issue</th>
                <th className="px-4 py-2.5">Daily Rate</th>
                <th className="px-4 py-2.5">Criticality</th>
                <th className="px-4 py-2.5">Used By</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border font-mono">
              {isLoading && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center">
                    <div className="text-muted-foreground text-xs tracking-wide">
                      Loading catalog…
                    </div>
                  </td>
                </tr>
              )}
              {!isLoading && customItems.length === 0 && (() => {
                const hasSearch = search.trim() !== "";
                let primary: string;
                let secondary: string;
                if (totalCustom === 0) {
                  primary = "No custom catalog items yet.";
                  secondary =
                    "Custom items appear here when planners save them to the catalog from the unit Add Item dialog.";
                } else if (showOnlyUnused) {
                  if (unusedCustomCount === 0) {
                    primary =
                      "Every custom item is tracked by at least one unit. Catalog hygiene looks good.";
                    secondary = "Clear the filter to see all custom items.";
                  } else {
                    // Unused items exist but none match the active search.
                    primary = "No unused custom items match your search.";
                    secondary =
                      "Clear the search to see all unused items, or turn off the filter.";
                  }
                } else {
                  primary = hasSearch
                    ? "No custom catalog items match your search."
                    : "No custom catalog items yet.";
                  secondary =
                    "Custom items appear here when planners save them to the catalog from the unit Add Item dialog.";
                }
                return (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center">
                      <div className="text-muted-foreground text-xs tracking-wide">
                        {primary}
                      </div>
                      <div className="text-muted-foreground/60 text-[10px] tracking-wide mt-1">
                        {secondary}
                      </div>
                    </td>
                  </tr>
                );
              })()}
              {customItems.map((item) => {
                const isUnused = (item.usedByUnitCount ?? 0) === 0;
                return (
                <tr
                  key={item.id}
                  data-testid={`row-catalog-item-${item.id}`}
                  data-unused={isUnused ? "true" : "false"}
                  className={
                    "hover:bg-muted/20 transition-colors group " +
                    (isUnused
                      ? "bg-muted/10 text-muted-foreground/80"
                      : "")
                  }
                >
                  <td className="px-4 py-2.5 font-bold text-xs">
                    <span className="flex items-center gap-1.5 flex-wrap">
                      {item.name}
                      <span className="inline-block text-[9px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/30">
                        Custom
                      </span>
                    </span>
                    {item.notes && (
                      <span className="block text-[10px] text-muted-foreground font-normal mt-0.5">
                        {item.notes}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    <span className="inline-block text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">
                      CL {item.supplyClass}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums">
                    {item.nsn ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-xs">{item.unit}</td>
                  <td className="px-4 py-2.5 text-xs tabular-nums">
                    {item.baseDailyRate > 0
                      ? item.baseDailyRate.toFixed(2)
                      : <span className="text-muted-foreground">ref only</span>}
                  </td>
                  <td className="px-4 py-2.5 text-xs capitalize">
                    {item.criticality}
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    <UsedByCell
                      count={item.usedByUnitCount ?? 0}
                      units={item.usedByUnits ?? []}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 font-mono uppercase text-[10px] tracking-widest"
                        onClick={() => openEdit(item)}
                      >
                        <Edit className="w-3 h-3 mr-1" />
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 font-mono uppercase text-[10px] tracking-widest text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setConfirmDelete(item)}
                      >
                        <Trash2 className="w-3 h-3 mr-1" />
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Rename Dialog */}
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="font-mono uppercase text-sm tracking-widest">
              Edit Catalog Item
            </DialogTitle>
          </DialogHeader>
          <p className="text-[10px] font-mono text-muted-foreground -mt-1">
            Changes apply to every unit's supply list that tracks this item.
            On-hand counts are preserved.
          </p>
          <Form {...editForm}>
            <form
              onSubmit={editForm.handleSubmit(handleEdit)}
              className="space-y-3 pt-1"
              data-testid="form-edit-catalog-item"
            >
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={editForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="col-span-2">
                      <FormLabel className="font-mono uppercase text-[10px] tracking-widest">
                        Name *
                      </FormLabel>
                      <FormControl>
                        <Input
                          className="font-mono text-xs h-8"
                          autoFocus
                          data-testid="input-edit-name"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage className="text-[10px]" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="supplyClass"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-[10px] tracking-widest">
                        Supply Class *
                      </FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger
                            className="font-mono text-xs h-8"
                            data-testid="select-edit-supply-class"
                          >
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.values(SupplyClass).map((c) => (
                            <SelectItem
                              key={c}
                              value={c}
                              className="font-mono text-xs"
                            >
                              Class {c}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage className="text-[10px]" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="unit"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-[10px] tracking-widest">
                        Unit of Issue *
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder="ea, gal, round, case…"
                          className="font-mono text-xs h-8"
                          data-testid="input-edit-unit"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage className="text-[10px]" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="nsn"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-[10px] tracking-widest">
                        NSN / DODIC{" "}
                        <span className="text-muted-foreground">(opt)</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          placeholder="1305-01-000-0000"
                          className="font-mono text-xs h-8"
                          data-testid="input-edit-nsn"
                          {...field}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="baseDailyRate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-[10px] tracking-widest">
                        Daily Rate / Marine{" "}
                        <span className="text-muted-foreground">(opt)</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          step="any"
                          placeholder="Leave blank = ref only"
                          className="font-mono text-xs h-8"
                          data-testid="input-edit-daily-rate"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage className="text-[10px]" />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="criticality"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-mono uppercase text-[10px] tracking-widest">
                        Criticality
                      </FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger
                            className="font-mono text-xs h-8"
                            data-testid="select-edit-criticality"
                          >
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="low" className="font-mono text-xs">
                            Low
                          </SelectItem>
                          <SelectItem
                            value="medium"
                            className="font-mono text-xs"
                          >
                            Medium
                          </SelectItem>
                          <SelectItem
                            value="high"
                            className="font-mono text-xs"
                          >
                            High
                          </SelectItem>
                          <SelectItem
                            value="critical"
                            className="font-mono text-xs"
                          >
                            Critical
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem className="col-span-2">
                      <FormLabel className="font-mono uppercase text-[10px] tracking-widest">
                        Notes{" "}
                        <span className="text-muted-foreground">(opt)</span>
                      </FormLabel>
                      <FormControl>
                        <Textarea
                          rows={2}
                          className="font-mono text-xs"
                          placeholder="Optional planner notes shown beside the item name"
                          data-testid="input-edit-notes"
                          {...field}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex gap-2 pt-1">
                <Button
                  type="submit"
                  className="flex-1 font-mono uppercase text-[10px] tracking-widest"
                  disabled={updateItem.isPending}
                  data-testid="button-save-edit-catalog-item"
                >
                  {updateItem.isPending ? "Saving…" : "Save Changes"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1 font-mono uppercase text-[10px] tracking-widest"
                  onClick={() => setEditing(null)}
                  disabled={updateItem.isPending}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={!!confirmDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="font-mono uppercase text-sm tracking-widest text-destructive">
              Delete Catalog Item?
            </DialogTitle>
          </DialogHeader>
          {confirmDelete && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded border border-destructive/50 bg-destructive/10 px-3 py-2">
                <span className="text-destructive text-base leading-none mt-0.5">
                  ⚠
                </span>
                <p className="text-xs font-mono text-destructive leading-relaxed">
                  This will permanently remove{" "}
                  <span className="font-bold">{confirmDelete.name}</span> from
                  the shared catalog
                  {(confirmDelete.usedByUnitCount ?? 0) > 0 ? (
                    <>
                      {" "}and from{" "}
                      <span className="font-bold">
                        {confirmDelete.usedByUnitCount} unit
                        {confirmDelete.usedByUnitCount === 1 ? "" : "s"}
                      </span>{" "}
                      that currently track it. On-hand counts for those units
                      will be discarded.
                    </>
                  ) : (
                    <>. No units currently track this item.</>
                  )}
                </p>
              </div>
              {(confirmDelete.usedByUnits?.length ?? 0) > 0 && (
                <AffectedUnitsList units={confirmDelete.usedByUnits ?? []} />
              )}
              <p className="text-xs font-mono text-muted-foreground">
                Future resupply events for this item will also be cancelled.
                This cannot be undone.
              </p>
              <div className="flex gap-2 pt-1">
                <Button
                  variant="destructive"
                  className="flex-1 font-mono uppercase text-[10px] tracking-widest"
                  onClick={handleDelete}
                  disabled={deleteItem.isPending}
                >
                  {deleteItem.isPending ? "Deleting…" : "Delete"}
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 font-mono uppercase text-[10px] tracking-widest"
                  onClick={() => setConfirmDelete(null)}
                  disabled={deleteItem.isPending}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Layout>
  );
}

function UsedByCell({
  count,
  units,
}: {
  count: number;
  units: { id: string; name: string }[];
}) {
  if (count === 0) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide text-amber-700 dark:text-amber-400"
        data-testid="badge-unused"
        title="No unit currently tracks this item — safe to remove."
      >
        <Sparkles className="w-3 h-3" />
        Unused
      </span>
    );
  }

  const label = `${count} unit${count === 1 ? "" : "s"}`;
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide text-primary hover:bg-primary/20 transition-colors tabular-nums"
        >
          <Users className="w-3 h-3" />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-2"
      >
        <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground px-2 pt-1 pb-2">
          Tracked by {label}
        </div>
        <ul className="max-h-64 overflow-y-auto">
          {units.map((u) => (
            <li key={u.id}>
              <Link
                href={`/units/${u.id}`}
                className="block rounded px-2 py-1.5 text-xs font-mono hover:bg-muted/40 transition-colors"
              >
                {u.name}
                <span className="block text-[10px] text-muted-foreground/70 truncate">
                  {base}/units/{u.id}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function AffectedUnitsList({
  units,
}: {
  units: { id: string; name: string }[];
}) {
  const VISIBLE = 5;
  const visible = units.slice(0, VISIBLE);
  const remaining = units.length - visible.length;

  return (
    <div className="rounded border border-border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-1.5">
        <Users className="w-3 h-3" />
        Affected unit{units.length === 1 ? "" : "s"} ({units.length})
      </div>
      <ul className="space-y-0.5 font-mono text-xs">
        {visible.map((u) => (
          <li key={u.id} className="flex items-baseline gap-2">
            <span className="text-muted-foreground/60">•</span>
            <Link
              href={`/units/${u.id}`}
              className="text-foreground hover:text-primary hover:underline transition-colors truncate"
            >
              {u.name}
            </Link>
          </li>
        ))}
      </ul>
      {remaining > 0 && (
        <div className="text-[10px] font-mono text-muted-foreground mt-1.5 pl-4">
          …and {remaining} more
        </div>
      )}
    </div>
  );
}
