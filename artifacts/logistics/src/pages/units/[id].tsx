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
  useUpdateUnitSupplyEntry,
  useUpdateCustomSupplyItem,
  usePromoteCustomSupplyItem,
  useDeleteUnitSupply,
  useRestoreUnitSupply,
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
  getGetDashboardSummaryQueryKey,
  getListDeficienciesQueryKey,
  getGetResupplyForecastQueryKey,
  getListRecentActivityQueryKey,
  SupplyClass,
  Echelon,
  Climate,
  OpTempo,
  UnitRole
} from "@workspace/api-client-react";
import { ToastAction } from "@/components/ui/toast";
import { Undo2 } from "lucide-react";
import { WeaponsTab } from "./weapons-tab";

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

function RoleBadge({ role }: { role: string }) {
  if (role === "in_support") {
    return (
      <span className="inline-flex items-center text-[9px] font-mono px-1.5 py-0.5 rounded-sm border bg-warning/15 border-warning/40 text-warning tracking-widest uppercase">
        In Support
      </span>
    );
  }
  if (role === "attached") {
    return (
      <span className="inline-flex items-center text-[9px] font-mono px-1.5 py-0.5 rounded-sm border bg-primary/10 border-primary/30 text-primary tracking-widest uppercase">
        Attached
      </span>
    );
  }
  return (
    <span className="inline-flex items-center text-[9px] font-mono px-1.5 py-0.5 rounded-sm border bg-muted border-border text-muted-foreground tracking-widest uppercase">
      Organic
    </span>
  );
}
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, ArrowLeft, Calculator, Calendar, Clock, Edit, FileText, Mail, Package, Plus, Save, Settings2, Target, Trash2, X } from "lucide-react";
import { validateDistroEmailList, type DistroEmailValidation } from "@workspace/distro-email";
import { SupplyHistoryTab } from "@/components/supply-history-tab";
import { Link, useLocation } from "wouter";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { format, formatDistanceToNow } from "date-fns";
import { PushToSpireButton } from "@/components/push-to-spire-button";

const resupplyFormSchema = z.object({
  supplyClass: z.nativeEnum(SupplyClass),
  itemId: z.string().optional(),
  quantity: z.coerce.number().min(0),
  unit: z.string().min(1),
  scheduledFor: z.string().min(1),
  assignedTo: z.string().optional(),
  notes: z.string().optional(),
});

const customItemFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  supplyClass: z.nativeEnum(SupplyClass),
  unit: z.string().min(1, "Unit of issue is required"),
  onHand: z.coerce.number().min(0, "On hand must be ≥ 0"),
  nsn: z.string().optional(),
  baseDailyRate: z.string().optional(),
  criticality: z.enum(["low", "medium", "high", "critical"]).optional(),
  saveToCatalog: z.boolean().optional(),
});

const editCustomItemFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
  supplyClass: z.nativeEnum(SupplyClass),
  unit: z.string().min(1, "Unit of issue is required"),
  nsn: z.string().optional(),
  baseDailyRate: z.string().optional(),
  criticality: z.enum(["low", "medium", "high", "critical"]),
});

interface DistroBucket {
  /** Stable key for test ids ("to" | "cc" | "bcc"). */
  key: "to" | "cc" | "bcc";
  /** Visible label ("To", "CC", "BCC"). */
  label: string;
  /** Validation summary for this bucket. */
  summary: DistroEmailValidation;
}

function buildDistroBuckets(
  to: readonly string[] | undefined,
  cc: readonly string[] | undefined,
  bcc: readonly string[] | undefined,
): DistroBucket[] {
  // Use validateDistroEmailList (per-array-element semantics) so the flag
  // matches what the API's normalizeDistroEmails and the schedule mailto
  // pipeline's partitionDistroEmails actually reject. Joining + re-splitting
  // would silently break a stored entry like "a@x.com,b@y.com" into two
  // valid-looking tokens while send-time logic drops the original entry.
  return [
    { key: "to", label: "To", summary: validateDistroEmailList(to) },
    { key: "cc", label: "CC", summary: validateDistroEmailList(cc) },
    { key: "bcc", label: "BCC", summary: validateDistroEmailList(bcc) },
  ];
}

function DistributionListCard({
  unitId,
  distroEmails,
  distroCcEmails,
  distroBccEmails,
}: {
  unitId: string;
  distroEmails: string[];
  distroCcEmails: string[];
  distroBccEmails: string[];
}) {
  const buckets = buildDistroBuckets(distroEmails, distroCcEmails, distroBccEmails);
  const totalRecipients = buckets.reduce((acc, b) => acc + b.summary.tokens.length, 0);
  const totalInvalid = buckets.reduce((acc, b) => acc + b.summary.invalidCount, 0);
  const totalValid = buckets.reduce((acc, b) => acc + b.summary.validCount, 0);

  return (
    <Card className="border-border mb-8" data-testid="card-distribution-list">
      <CardHeader className="border-b border-border pb-3 pt-4 px-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Mail className="w-3.5 h-3.5 text-muted-foreground" />
            <CardTitle className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">
              Distribution List
            </CardTitle>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {totalInvalid > 0 ? (
              <span
                className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded-sm border bg-destructive/10 border-destructive/40 text-destructive"
                data-testid="badge-distro-invalid-count"
                title="Malformed entries will be skipped when emailing a schedule. Edit the unit to fix them."
              >
                <AlertTriangle className="w-3 h-3" />
                {totalInvalid} Invalid
              </span>
            ) : null}
            <span
              className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
              data-testid="text-distro-valid-count"
            >
              {totalValid} Valid · {totalRecipients} Total
            </span>
            <Link href={`/units/${unitId}/edit`}>
              <Button
                variant="outline"
                size="sm"
                className="font-mono uppercase text-[10px] tracking-widest h-7"
                data-testid="button-edit-distro-emails"
              >
                <Edit className="w-3 h-3 mr-1.5" /> Edit
              </Button>
            </Link>
          </div>
        </div>
        <CardDescription className="font-mono text-[10px] tracking-wide pt-1">
          Pre-fills the To / CC / BCC fields when emailing a schedule. Malformed
          entries are flagged here and silently dropped at send time.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 space-y-3">
        {totalRecipients === 0 ? (
          <p
            className="font-mono text-[10px] tracking-wide text-muted-foreground"
            data-testid="text-distro-empty"
          >
            No distribution list addresses on file. Add some on the edit screen
            so schedules can be emailed straight from this unit.
          </p>
        ) : (
          <div className="space-y-3">
            {buckets.map((bucket) => (
              <DistroBucketRow key={bucket.key} bucket={bucket} />
            ))}
            {totalInvalid > 0 && (
              <p
                className="font-mono text-[10px] tracking-wide text-destructive border-t border-destructive/30 pt-2"
                data-testid="text-distro-invalid-help"
              >
                {totalInvalid === 1
                  ? "1 entry doesn't look like an email address (expected name@domain) and will be skipped when a schedule is emailed."
                  : `${totalInvalid} entries don't look like email addresses (expected name@domain) and will be skipped when a schedule is emailed.`}{" "}
                Edit the unit to clean them up.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DistroBucketRow({ bucket }: { bucket: DistroBucket }) {
  const { key, label, summary } = bucket;
  if (summary.tokens.length === 0) {
    return (
      <div
        className="flex items-center gap-3"
        data-testid={`row-distro-${key}`}
      >
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground w-8 shrink-0">
          {label}
        </span>
        <span
          className="font-mono text-[10px] tracking-wide text-muted-foreground/70 italic"
          data-testid={`text-distro-${key}-empty`}
        >
          (empty)
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3" data-testid={`row-distro-${key}`}>
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground w-8 shrink-0 pt-1">
        {label}
      </span>
      <div className="flex flex-wrap gap-1 flex-1 min-w-0">
        {summary.tokens.map((t) => (
          <span
            key={t.value}
            className={
              "font-mono text-[10px] px-1.5 py-0.5 rounded-sm border break-all " +
              (t.valid
                ? "bg-muted/30 border-border text-foreground/80"
                : "bg-destructive/10 border-destructive/40 text-destructive")
            }
            title={
              t.valid
                ? t.value
                : `Not a valid email (expected name@domain): ${t.value}`
            }
            data-testid={
              t.valid
                ? `chip-distro-${key}-valid-${t.value}`
                : `chip-distro-${key}-invalid-${t.value}`
            }
          >
            {!t.valid && (
              <AlertTriangle className="inline w-2.5 h-2.5 mr-0.5 -mt-0.5" />
            )}
            {t.value}
            {!t.valid && (
              <span className="ml-1 uppercase tracking-widest text-[8px]">
                invalid
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function UnitDetail() {
  const [, params] = useRoute("/units/:id");
  const unitId = params?.id || "";
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const snapshotUrl = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/units/${unitId}/snapshot`;
  const { toast } = useToast();

  const { data: unitDetail, isLoading } = useGetUnit(unitId, { query: { enabled: !!unitId, queryKey: getGetUnitQueryKey(unitId) } });
  const { data: supply } = useGetUnitSupply(unitId, { query: { enabled: !!unitId, queryKey: getGetUnitSupplyQueryKey(unitId) } });
  const { data: resupplies } = useListUnitResupply(unitId, { query: { enabled: !!unitId, queryKey: getListUnitResupplyQueryKey(unitId) } });

  const deleteUnit = useDeleteUnit();
  const upsertSupply = useUpsertUnitSupply();
  const updateSupplyEntry = useUpdateUnitSupplyEntry();
  const updateCustomSupply = useUpdateCustomSupplyItem();
  const promoteCustomSupply = usePromoteCustomSupplyItem();
  const deleteSupply = useDeleteUnitSupply();
  const restoreSupply = useRestoreUnitSupply();
  const copyFromUnit = useCopySupplyFromUnit();
  const createResupply = useCreateResupplyEvent();
  const calculate = useCalculateRequirements();

  const { data: catalogItems } = useListCatalogItems({ query: { queryKey: getListCatalogItemsQueryKey() } });
  const { data: allUnits } = useListUnits();

  const [confirmRemoveItemId, setConfirmRemoveItemId] = useState<string | null>(null);
  const [addItemOpen, setAddItemOpen] = useState(false);
  const [addItemMode, setAddItemMode] = useState<"catalog" | "custom">("catalog");
  const [addItemSearch, setAddItemSearch] = useState("");
  const [copyFromOpen, setCopyFromOpen] = useState(false);
  const [editItemId, setEditItemId] = useState<string | null>(null);
  const [editOverrideItemId, setEditOverrideItemId] = useState<string | null>(null);
  const [editOverrideValue, setEditOverrideValue] = useState<string>("");

  const customItemForm = useForm<z.infer<typeof customItemFormSchema>>({
    resolver: zodResolver(customItemFormSchema),
    defaultValues: {
      name: "",
      supplyClass: SupplyClass.I,
      unit: "",
      onHand: 0,
      nsn: "",
      baseDailyRate: "",
      criticality: "low",
      saveToCatalog: false,
    },
  });

  const editCustomItemForm = useForm<z.infer<typeof editCustomItemFormSchema>>({
    resolver: zodResolver(editCustomItemFormSchema),
    defaultValues: {
      name: "",
      supplyClass: SupplyClass.I,
      unit: "",
      nsn: "",
      baseDailyRate: "",
      criticality: "low",
    },
  });

  const editingEntry = supply?.find(e => e.itemId === editItemId);

  useEffect(() => {
    if (editingEntry) {
      editCustomItemForm.reset({
        name: editingEntry.item.name,
        supplyClass: editingEntry.item.supplyClass as SupplyClass,
        unit: editingEntry.item.unit,
        nsn: editingEntry.item.nsn ?? "",
        baseDailyRate:
          editingEntry.item.baseDailyRate > 0
            ? String(editingEntry.item.baseDailyRate)
            : "",
        criticality: (editingEntry.item.criticality as "low" | "medium" | "high" | "critical") ?? "low",
      });
    }
  }, [editItemId, editingEntry?.item.id]);

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

  const invalidateAfterSupplyChange = (alsoCatalog: boolean) => {
    queryClient.invalidateQueries({ queryKey: getGetUnitSupplyQueryKey(unitId) });
    queryClient.invalidateQueries({ queryKey: getGetUnitQueryKey(unitId) });
    queryClient.invalidateQueries({ queryKey: getListUnitResupplyQueryKey(unitId) });
    queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListDeficienciesQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetResupplyForecastQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListRecentActivityQueryKey() });
    if (alsoCatalog) {
      queryClient.invalidateQueries({ queryKey: getListCatalogItemsQueryKey() });
    }
  };

  const handleRemoveItem = async (itemId: string) => {
    try {
      const result = await deleteSupply.mutateAsync({ unitId, itemId });
      invalidateAfterSupplyChange(result.removedCatalogItem);
      setConfirmRemoveItemId(null);

      // The server returns a short-lived restore window (~30s). The UI
      // surfaces a 15-second Undo affordance — comfortably inside the server's
      // grace period even with clock skew or network jitter.
      const undoWindowMs = 15_000;
      const onHandNote =
        result.hadOnHand > 0
          ? ` Discarded ${result.hadOnHand} on hand.`
          : "";
      const resupplyNote =
        result.cancelledResupplyEvents > 0
          ? ` Cancelled ${result.cancelledResupplyEvents} future resupply event${result.cancelledResupplyEvents === 1 ? "" : "s"}.`
          : "";
      toast({
        title: `Removed "${result.removedItemName}"`,
        description: `${onHandNote}${resupplyNote} You can undo for the next 15 seconds.`.trim(),
        duration: undoWindowMs,
        action: (
          <ToastAction
            altText="Undo remove"
            onClick={async () => {
              try {
                await restoreSupply.mutateAsync({ unitId, itemId });
                invalidateAfterSupplyChange(result.removedCatalogItem);
                toast({
                  title: `Restored "${result.removedItemName}"`,
                  description:
                    "Supply entry, on-hand count, and future resupply events were restored.",
                });
              } catch (err) {
                toast({
                  title: "Could not undo remove",
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

  const handleAddCustomItem = async (values: z.infer<typeof customItemFormSchema>) => {
    try {
      const baseDailyRate = values.baseDailyRate && values.baseDailyRate.trim() !== ""
        ? parseFloat(values.baseDailyRate)
        : undefined;
      await upsertSupply.mutateAsync({
        unitId,
        data: {
          onHand: values.onHand,
          customItem: {
            name: values.name,
            supplyClass: values.supplyClass,
            unit: values.unit,
            nsn: values.nsn && values.nsn.trim() !== "" ? values.nsn : undefined,
            baseDailyRate: baseDailyRate != null && !isNaN(baseDailyRate) ? baseDailyRate : undefined,
            criticality: values.criticality,
          },
          saveToCatalog: values.saveToCatalog,
        },
      });
      queryClient.invalidateQueries({ queryKey: getGetUnitSupplyQueryKey(unitId) });
      queryClient.invalidateQueries({ queryKey: getGetUnitQueryKey(unitId) });
      if (values.saveToCatalog) {
        queryClient.invalidateQueries({ queryKey: getListCatalogItemsQueryKey() });
      }
      setAddItemOpen(false);
      customItemForm.reset();
      toast({ title: "Custom item added to unit" });
    } catch (e) {
      toast({ title: "Failed to add custom item", variant: "destructive" });
    }
  };

  const handlePromoteCustomItem = async () => {
    if (!editItemId || !editingEntry) return;
    const itemName = editingEntry.item.name;
    if (!confirm(`Promote "${itemName}" to the shared catalog? It will appear in every unit's catalog picker and can no longer be edited from a single unit.`)) {
      return;
    }
    try {
      await promoteCustomSupply.mutateAsync({ unitId, itemId: editItemId });
      queryClient.invalidateQueries({ queryKey: getGetUnitSupplyQueryKey(unitId) });
      queryClient.invalidateQueries({ queryKey: getGetUnitQueryKey(unitId) });
      queryClient.invalidateQueries({ queryKey: getListCatalogItemsQueryKey() });
      setEditItemId(null);
      toast({ title: `${itemName} promoted to catalog`, description: "Now available to every unit." });
    } catch (e) {
      toast({ title: "Failed to promote item", variant: "destructive" });
    }
  };

  const handleEditCustomItem = async (values: z.infer<typeof editCustomItemFormSchema>) => {
    if (!editItemId) return;
    try {
      const baseDailyRate = values.baseDailyRate && values.baseDailyRate.trim() !== ""
        ? parseFloat(values.baseDailyRate)
        : null;
      await updateCustomSupply.mutateAsync({
        unitId,
        itemId: editItemId,
        data: {
          name: values.name,
          supplyClass: values.supplyClass,
          unit: values.unit,
          nsn: values.nsn && values.nsn.trim() !== "" ? values.nsn : null,
          baseDailyRate: baseDailyRate != null && !isNaN(baseDailyRate) ? baseDailyRate : null,
          criticality: values.criticality,
        },
      });
      queryClient.invalidateQueries({ queryKey: getGetUnitSupplyQueryKey(unitId) });
      queryClient.invalidateQueries({ queryKey: getGetUnitQueryKey(unitId) });
      queryClient.invalidateQueries({ queryKey: getListCatalogItemsQueryKey() });
      setEditItemId(null);
      toast({ title: "Custom item updated" });
    } catch (e) {
      toast({ title: "Failed to update custom item", variant: "destructive" });
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
      await updateSupplyEntry.mutateAsync({
        unitId,
        itemId,
        data: { onHand: newOnHand }
      });
      queryClient.invalidateQueries({ queryKey: getGetUnitSupplyQueryKey(unitId) });
      queryClient.invalidateQueries({ queryKey: getGetUnitQueryKey(unitId) });
    } catch (e) {
      toast({ title: "Failed to update quantity", variant: "destructive" });
    }
  };

  const handleUpdateRequiredOverride = async (itemId: string, _onHand: number, overrideValue: number | null) => {
    try {
      await updateSupplyEntry.mutateAsync({
        unitId,
        itemId,
        data: { requiredOverride: overrideValue }
      });
      queryClient.invalidateQueries({ queryKey: getGetUnitSupplyQueryKey(unitId) });
      queryClient.invalidateQueries({ queryKey: getGetUnitQueryKey(unitId) });
      setEditOverrideItemId(null);
      toast({
        title: overrideValue === null
          ? "Requirement reset to auto-computed"
          : overrideValue === 0
            ? "Item marked as not a requirement"
            : `Required quantity set to ${overrideValue}`
      });
    } catch (e) {
      toast({ title: "Failed to update required quantity", variant: "destructive" });
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

  if (isLoading) return (
    <Layout>
      <div className="mb-6 animate-pulse">
        <div className="w-16 h-3 bg-muted rounded-sm mb-4" />
        <div className="w-64 h-7 bg-muted rounded-sm mb-3" />
        <div className="w-80 h-3 bg-muted rounded-sm" />
      </div>
      <div className="grid md:grid-cols-4 gap-4 mb-8">
        <div className="md:col-span-3 h-32 bg-muted animate-pulse rounded-sm" />
        <div className="h-32 bg-muted animate-pulse rounded-sm" />
      </div>
      <div className="space-y-3">
        {[1,2,3,4].map(i => (
          <div key={i} className="h-12 bg-muted animate-pulse rounded-sm" />
        ))}
      </div>
    </Layout>
  );
  if (!unitDetail) return (
    <Layout>
      <div className="p-12 text-center flex flex-col items-center gap-4">
        <div className="font-mono text-xs text-destructive tracking-widest uppercase">Unit not found</div>
        <Link href="/units" className="font-mono text-[10px] uppercase tracking-widest text-primary hover:underline">← Back to Units</Link>
      </div>
    </Layout>
  );

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
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 mt-2">
              <RoleBadge role={u.role} />
              <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">
                {ECHELON_LABELS[u.echelon] ?? u.echelon}
              </span>
              <span className="text-primary text-[10px]">·</span>
              <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">{u.personnel} PAX</span>
              {u.commander && (
                <>
                  <span className="text-primary text-[10px]">·</span>
                  <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">{u.commander}</span>
                </>
              )}
              {u.location && (
                <>
                  <span className="text-primary text-[10px]">·</span>
                  <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">LOC: {u.location}</span>
                </>
              )}
              <span className="text-primary text-[10px]">·</span>
              <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">{u.climate}</span>
              <span className="text-primary text-[10px]">·</span>
              <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-widest">{u.opTempo}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a href={snapshotUrl} target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm" className="font-mono uppercase text-[10px] tracking-widest">
                <FileText className="w-3 h-3 mr-1.5" /> Snapshot
              </Button>
            </a>
            <PushToSpireButton
              sourceKind="supply"
              sourceId={unitId}
              contextLabel={`${u.callsign} supply snapshot`}
              size="default"
            />
            <Link href={`/units/${unitId}/edit`}>
              <Button variant="outline" size="sm" className="font-mono uppercase text-[10px] tracking-widest" data-testid="button-edit-unit">
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
                u.readiness >= 60 ? "bg-warning" : "bg-destructive"
              }
            />
            <div className="grid grid-cols-4 gap-1.5 mt-3">
              {unitDetail.supplyByClass.map(cls => {
                const tier = cls.status;
                const tierCls = {
                  green: 'bg-success/10 border-success/30 text-success',
                  amber: 'bg-warning/10 border-warning/30 text-warning',
                  red:   'bg-destructive/10 border-destructive/30 text-destructive',
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

      <DistributionListCard
        unitId={unitId}
        distroEmails={u.distroEmails}
        distroCcEmails={u.distroCcEmails}
        distroBccEmails={u.distroBccEmails}
      />

      <Tabs defaultValue="supply" className="w-full">
        <TabsList className="mb-6 bg-transparent border-b border-border w-full justify-start rounded-none p-0 h-auto gap-0">
          <TabsTrigger value="supply" className="font-mono uppercase text-[10px] tracking-widest rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent px-4 py-2.5 text-muted-foreground">
            <Package className="w-3.5 h-3.5 mr-1.5" /> Supply On-Hand
          </TabsTrigger>
          <TabsTrigger value="resupply" className="font-mono uppercase text-[10px] tracking-widest rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent px-4 py-2.5 text-muted-foreground">
            <Calendar className="w-3.5 h-3.5 mr-1.5" /> Resupply Schedule
          </TabsTrigger>
          <TabsTrigger value="history" className="font-mono uppercase text-[10px] tracking-widest rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent px-4 py-2.5 text-muted-foreground">
            <Clock className="w-3.5 h-3.5 mr-1.5" /> History
          </TabsTrigger>
          <TabsTrigger value="calculator" className="font-mono uppercase text-[10px] tracking-widest rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent px-4 py-2.5 text-muted-foreground">
            <Calculator className="w-3.5 h-3.5 mr-1.5" /> Calculator
          </TabsTrigger>
          <TabsTrigger value="weapons" className="font-mono uppercase text-[10px] tracking-widest rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent px-4 py-2.5 text-muted-foreground">
            <Target className="w-3.5 h-3.5 mr-1.5" /> Class V / Weapons
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
          <Dialog open={addItemOpen} onOpenChange={(open) => {
            setAddItemOpen(open);
            if (!open) {
              setAddItemSearch("");
              setAddItemMode("catalog");
              customItemForm.reset();
            }
          }}>
            <DialogContent className="sm:max-w-[520px]">
              <DialogHeader>
                <DialogTitle className="font-mono uppercase text-sm tracking-widest">Add Supply Item</DialogTitle>
              </DialogHeader>

              {/* Mode toggle */}
              <div className="flex border border-border rounded-sm overflow-hidden mt-1">
                <button
                  className={`flex-1 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-colors ${addItemMode === "catalog" ? "bg-primary text-primary-foreground" : "bg-transparent text-muted-foreground hover:bg-muted/40"}`}
                  onClick={() => setAddItemMode("catalog")}
                  type="button"
                >
                  Pick from Catalog
                </button>
                <button
                  className={`flex-1 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-colors border-l border-border ${addItemMode === "custom" ? "bg-primary text-primary-foreground" : "bg-transparent text-muted-foreground hover:bg-muted/40"}`}
                  onClick={() => setAddItemMode("custom")}
                  type="button"
                >
                  Add Custom Item
                </button>
              </div>

              {addItemMode === "catalog" ? (
                <div className="pt-1 space-y-3">
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
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-mono font-bold text-xs">{c.name}</span>
                              {c.isCustom && (
                                <span className="inline-block text-[9px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/30">
                                  Custom
                                </span>
                              )}
                            </div>
                            {c.nsn && <span className="text-[10px] text-muted-foreground font-mono">{c.nsn}</span>}
                          </div>
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border ml-2 shrink-0">
                            CL {c.supplyClass}
                          </span>
                        </button>
                      ));
                    })()}
                  </div>
                </div>
              ) : (
                <Form {...customItemForm}>
                  <form onSubmit={customItemForm.handleSubmit(handleAddCustomItem)} className="space-y-3 pt-1">
                    <div className="grid grid-cols-2 gap-3">
                      <FormField
                        control={customItemForm.control}
                        name="name"
                        render={({ field }) => (
                          <FormItem className="col-span-2">
                            <FormLabel className="font-mono uppercase text-[10px] tracking-widest">Item Name *</FormLabel>
                            <FormControl>
                              <Input placeholder="e.g. Chem Light, Green" className="font-mono text-xs h-8" {...field} autoFocus />
                            </FormControl>
                            <FormMessage className="text-[10px]" />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={customItemForm.control}
                        name="supplyClass"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="font-mono uppercase text-[10px] tracking-widest">Supply Class *</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value}>
                              <FormControl>
                                <SelectTrigger className="font-mono text-xs h-8"><SelectValue /></SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {Object.values(SupplyClass).map(c => (
                                  <SelectItem key={c} value={c} className="font-mono text-xs">Class {c}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage className="text-[10px]" />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={customItemForm.control}
                        name="unit"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="font-mono uppercase text-[10px] tracking-widest">Unit of Issue *</FormLabel>
                            <FormControl>
                              <Input placeholder="ea, gal, round, case…" className="font-mono text-xs h-8" {...field} />
                            </FormControl>
                            <FormMessage className="text-[10px]" />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={customItemForm.control}
                        name="onHand"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="font-mono uppercase text-[10px] tracking-widest">On Hand *</FormLabel>
                            <FormControl>
                              <Input type="number" min={0} step="any" className="font-mono text-xs h-8" {...field} />
                            </FormControl>
                            <FormMessage className="text-[10px]" />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={customItemForm.control}
                        name="nsn"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="font-mono uppercase text-[10px] tracking-widest">NSN / DODIC <span className="text-muted-foreground">(opt)</span></FormLabel>
                            <FormControl>
                              <Input placeholder="1305-01-000-0000" className="font-mono text-xs h-8" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={customItemForm.control}
                        name="baseDailyRate"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="font-mono uppercase text-[10px] tracking-widest">Daily Rate / Marine <span className="text-muted-foreground">(opt)</span></FormLabel>
                            <FormControl>
                              <Input type="number" min={0} step="any" placeholder="Leave blank = ref only" className="font-mono text-xs h-8" {...field} />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={customItemForm.control}
                        name="criticality"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="font-mono uppercase text-[10px] tracking-widest">Criticality <span className="text-muted-foreground">(opt)</span></FormLabel>
                            <Select onValueChange={field.onChange} value={field.value ?? "low"}>
                              <FormControl>
                                <SelectTrigger className="font-mono text-xs h-8"><SelectValue /></SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="low" className="font-mono text-xs">Low</SelectItem>
                                <SelectItem value="medium" className="font-mono text-xs">Medium</SelectItem>
                                <SelectItem value="high" className="font-mono text-xs">High</SelectItem>
                                <SelectItem value="critical" className="font-mono text-xs">Critical</SelectItem>
                              </SelectContent>
                            </Select>
                          </FormItem>
                        )}
                      />
                    </div>

                    <FormField
                      control={customItemForm.control}
                      name="saveToCatalog"
                      render={({ field }) => (
                        <FormItem className="flex flex-row items-start gap-2 pt-1">
                          <FormControl>
                            <Checkbox
                              checked={field.value}
                              onCheckedChange={field.onChange}
                              className="mt-0.5"
                            />
                          </FormControl>
                          <div>
                            <FormLabel className="font-mono text-[10px] tracking-widest cursor-pointer">Save to catalog for other units</FormLabel>
                            <p className="text-[10px] text-muted-foreground font-mono">Makes this item available in the catalog picker for all units.</p>
                          </div>
                        </FormItem>
                      )}
                    />

                    <Button type="submit" className="w-full font-mono uppercase text-xs tracking-widest" disabled={upsertSupply.isPending}>
                      {upsertSupply.isPending ? "Adding…" : "Add Custom Item"}
                    </Button>
                  </form>
                </Form>
              )}
            </DialogContent>
          </Dialog>

          {/* Edit Custom Item Dialog */}
          <Dialog
            open={!!editItemId}
            onOpenChange={(open) => {
              if (!open) {
                setEditItemId(null);
                editCustomItemForm.reset();
              }
            }}
          >
            <DialogContent className="sm:max-w-[520px]">
              <DialogHeader>
                <DialogTitle className="font-mono uppercase text-sm tracking-widest">Edit Custom Item</DialogTitle>
              </DialogHeader>
              <p className="text-[10px] font-mono text-muted-foreground tracking-wide pt-1">
                These changes apply to this unit's tracked item. On-hand quantity is edited directly in the supply table.
              </p>
              <Form {...editCustomItemForm}>
                <form onSubmit={editCustomItemForm.handleSubmit(handleEditCustomItem)} className="space-y-3 pt-1">
                  <div className="grid grid-cols-2 gap-3">
                    <FormField
                      control={editCustomItemForm.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem className="col-span-2">
                          <FormLabel className="font-mono uppercase text-[10px] tracking-widest">Item Name *</FormLabel>
                          <FormControl>
                            <Input placeholder="e.g. Chem Light, Green" className="font-mono text-xs h-8" {...field} autoFocus />
                          </FormControl>
                          <FormMessage className="text-[10px]" />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={editCustomItemForm.control}
                      name="supplyClass"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="font-mono uppercase text-[10px] tracking-widest">Supply Class *</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger className="font-mono text-xs h-8"><SelectValue /></SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {Object.values(SupplyClass).map(c => (
                                <SelectItem key={c} value={c} className="font-mono text-xs">Class {c}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage className="text-[10px]" />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={editCustomItemForm.control}
                      name="unit"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="font-mono uppercase text-[10px] tracking-widest">Unit of Issue *</FormLabel>
                          <FormControl>
                            <Input placeholder="ea, gal, round, case…" className="font-mono text-xs h-8" {...field} />
                          </FormControl>
                          <FormMessage className="text-[10px]" />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={editCustomItemForm.control}
                      name="nsn"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="font-mono uppercase text-[10px] tracking-widest">NSN / DODIC <span className="text-muted-foreground">(opt)</span></FormLabel>
                          <FormControl>
                            <Input placeholder="1305-01-000-0000" className="font-mono text-xs h-8" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={editCustomItemForm.control}
                      name="baseDailyRate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="font-mono uppercase text-[10px] tracking-widest">Daily Rate / Marine <span className="text-muted-foreground">(opt)</span></FormLabel>
                          <FormControl>
                            <Input type="number" min={0} step="any" placeholder="Leave blank = ref only" className="font-mono text-xs h-8" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={editCustomItemForm.control}
                      name="criticality"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="font-mono uppercase text-[10px] tracking-widest">Criticality</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger className="font-mono text-xs h-8"><SelectValue /></SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="low" className="font-mono text-xs">Low</SelectItem>
                              <SelectItem value="medium" className="font-mono text-xs">Medium</SelectItem>
                              <SelectItem value="high" className="font-mono text-xs">High</SelectItem>
                              <SelectItem value="critical" className="font-mono text-xs">Critical</SelectItem>
                            </SelectContent>
                          </Select>
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="flex gap-2 pt-2">
                    <Button
                      type="submit"
                      className="flex-1 font-mono uppercase text-xs tracking-widest"
                      disabled={updateCustomSupply.isPending || promoteCustomSupply.isPending}
                      data-testid="button-save-custom-item"
                    >
                      {updateCustomSupply.isPending ? "Saving…" : "Save Changes"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="font-mono uppercase text-xs tracking-widest"
                      onClick={() => setEditItemId(null)}
                    >
                      Cancel
                    </Button>
                  </div>

                  <div className="border-t border-border pt-3 mt-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-0.5">
                        <p className="font-mono uppercase text-[10px] tracking-widest font-bold">
                          Promote to Catalog
                        </p>
                        <p className="text-[10px] font-mono text-muted-foreground tracking-wide leading-relaxed">
                          Share this item with every unit. Once promoted it can no longer be edited from a single unit.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="font-mono uppercase text-[10px] tracking-widest shrink-0"
                        onClick={handlePromoteCustomItem}
                        disabled={promoteCustomSupply.isPending || updateCustomSupply.isPending}
                        data-testid="button-promote-custom-item"
                      >
                        {promoteCustomSupply.isPending ? "Promoting…" : "Promote"}
                      </Button>
                    </div>
                  </div>
                </form>
              </Form>
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
                        This item has <span className="font-bold">{removeEntry!.onHand} {removeEntry!.item.unit}</span> on hand — removing it will drop that count.
                      </p>
                    </div>
                  )}
                  <p className="text-xs font-mono text-muted-foreground pt-1">
                    This will remove the item from this unit's supply list and cancel any future resupply events for it. You'll have 15 seconds to undo from the toast.
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
                    <th className="px-4 py-2.5">Required</th>
                    <th className="px-4 py-2.5">Daily Burn</th>
                    <th className="px-4 py-2.5">DOS</th>
                    <th className="px-4 py-2.5">Shortfall</th>
                    <th className="px-4 py-2.5 text-right">Status</th>
                    <th className="px-3 py-2.5 w-16"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border font-mono">
                  {(() => {
                    const catalogLoaded = catalogItems !== undefined;
                    const globalCatalogIds = new Set((catalogItems ?? []).map(c => c.id));
                    return supply?.slice().sort((a, b) => {
                    const cls = a.item.supplyClass.localeCompare(b.item.supplyClass);
                    if (cls !== 0) return cls;
                    const name = a.item.name.localeCompare(b.item.name);
                    if (name !== 0) return name;
                    return a.item.id.localeCompare(b.item.id);
                  }).map((entry) => {
                    const isRefOnly = entry.item.supplyClass === "IX" || (entry.item.isCustom && entry.item.baseDailyRate === 0);
                    const isNotRequirement = entry.isRequirement === false;
                    const isBlankOut = isRefOnly || isNotRequirement;
                    const isUnitScopedCustom = catalogLoaded && entry.item.isCustom && !globalCatalogIds.has(entry.item.id);
                    const itemCreatedAt = entry.item.createdAt ? new Date(entry.item.createdAt) : null;
                    const itemUpdatedAt = entry.item.updatedAt ? new Date(entry.item.updatedAt) : null;
                    const itemWasEdited =
                      !!itemCreatedAt &&
                      !!itemUpdatedAt &&
                      itemUpdatedAt.getTime() - itemCreatedAt.getTime() > 1000;
                    const hasOverride = entry.requiredOverride !== null && entry.requiredOverride !== undefined;
                    const isEditingOverride = editOverrideItemId === entry.itemId;
                    return (
                    <tr key={entry.id} className={`hover:bg-muted/20 transition-colors group ${isRefOnly ? 'opacity-70' : ''} ${isNotRequirement ? 'opacity-60' : ''}`}>
                      <td className="px-4 py-2.5 font-bold text-xs">
                        <span className="flex items-center gap-1.5 flex-wrap">
                          {entry.item.name}
                          {entry.item.isCustom && (
                            <span className="inline-block text-[9px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/30">
                              Custom
                            </span>
                          )}
                          {itemWasEdited && itemUpdatedAt && (
                            <span
                              className="inline-block text-[9px] font-mono uppercase tracking-wide text-muted-foreground/80"
                              title={`Item details edited ${format(itemUpdatedAt, "ddHHmm'Z' MMM yy").toUpperCase()}`}
                              data-testid={`text-item-edited-${entry.itemId}`}
                            >
                              Edited {formatDistanceToNow(itemUpdatedAt, { addSuffix: true })}
                            </span>
                          )}
                          {isRefOnly && (
                            <span className="inline-block text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">
                              Ref only — not in DOS
                            </span>
                          )}
                          {isNotRequirement && (
                            <span className="inline-block text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded bg-muted/80 text-muted-foreground border border-border/60" data-testid={`badge-not-req-${entry.itemId}`}>
                              Not a requirement
                            </span>
                          )}
                        </span>
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
                      <td className="px-4 py-2.5 min-w-[120px]">
                        {isRefOnly ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : isEditingOverride ? (
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-1">
                              <Input
                                type="number"
                                min={0}
                                step={1}
                                value={editOverrideValue}
                                onChange={e => setEditOverrideValue(e.target.value)}
                                className="h-6 w-20 text-xs font-mono px-1.5 py-0"
                                placeholder="qty"
                                autoFocus
                                onKeyDown={e => {
                                  if (e.key === "Enter") {
                                    const v = parseFloat(editOverrideValue);
                                    if (!isNaN(v) && v >= 0) handleUpdateRequiredOverride(entry.itemId, entry.onHand, v);
                                  }
                                  if (e.key === "Escape") setEditOverrideItemId(null);
                                }}
                              />
                              <button
                                className="text-[10px] font-mono text-primary hover:text-primary/80 px-1.5 py-0.5 rounded border border-primary/30 bg-primary/5"
                                onClick={() => {
                                  const v = parseFloat(editOverrideValue);
                                  if (!isNaN(v) && v >= 0) handleUpdateRequiredOverride(entry.itemId, entry.onHand, v);
                                }}
                              >Save</button>
                              <button
                                className="text-[10px] font-mono text-muted-foreground hover:text-foreground px-1 py-0.5"
                                onClick={() => setEditOverrideItemId(null)}
                              >✕</button>
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                className="text-[9px] font-mono text-muted-foreground hover:text-destructive underline underline-offset-2"
                                onClick={() => handleUpdateRequiredOverride(entry.itemId, entry.onHand, 0)}
                              >Set 0 — not a req.</button>
                              {hasOverride && (
                                <button
                                  className="text-[9px] font-mono text-muted-foreground hover:text-foreground underline underline-offset-2"
                                  onClick={() => handleUpdateRequiredOverride(entry.itemId, entry.onHand, null)}
                                >Reset to default</button>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 group/req">
                            <span className={`text-xs tabular-nums ${isNotRequirement ? 'text-muted-foreground' : ''}`}>
                              {isNotRequirement ? '0' : entry.required.toFixed(1)}
                            </span>
                            <span className="text-[10px] text-muted-foreground">{entry.item.unit}</span>
                            {hasOverride && !isNotRequirement && (
                              <span className="text-[9px] font-mono px-1 py-0.5 rounded bg-warning/15 text-warning border border-warning/30 ml-0.5">override</span>
                            )}
                            <button
                              className="text-muted-foreground hover:text-primary p-0.5 rounded opacity-60 hover:opacity-100 transition-opacity ml-0.5"
                              title="Set required quantity"
                              onClick={() => {
                                setEditOverrideValue(hasOverride ? String(entry.requiredOverride) : entry.required.toFixed(1));
                                setEditOverrideItemId(entry.itemId);
                              }}
                              data-testid={`button-edit-required-${entry.itemId}`}
                            >
                              <Edit className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs tabular-nums">
                        {isBlankOut ? '—' : (
                          <div>
                            <div className="tabular-nums">{entry.dailyConsumption.toFixed(2)}</div>
                            {entry.item.supplyClass === "V" && entry.burnBreakdown && (
                              <div className="text-[10px] text-muted-foreground leading-tight max-w-[180px] break-words">{entry.burnBreakdown}</div>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {isBlankOut ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <span className={`text-xs tabular-nums ${entry.daysOfSupply < 2 ? 'text-destructive font-bold' : entry.daysOfSupply < 5 ? 'text-warning font-bold' : ''}`}>
                            {entry.daysOfSupply.toFixed(1)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {isBlankOut ? (
                          <span className="text-muted-foreground text-xs">—</span>
                        ) : entry.shortfall > 0 ? (
                          <span className="text-destructive font-bold text-xs tabular-nums">{entry.shortfall.toFixed(1)}</span>
                        ) : <span className="text-muted-foreground text-xs">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {isBlankOut ? (
                          <span className="text-muted-foreground text-xs">—</span>
                        ) : (
                          <StatusCell
                            value={Math.min(100, Math.round((entry.onHand / Math.max(entry.required, 0.01)) * 100))}
                            tier={entry.status}
                          />
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-0.5">
                          {isUnitScopedCustom && (
                            <button
                              className="text-muted-foreground hover:text-primary p-1 rounded transition-colors"
                              title="Edit custom item"
                              onClick={() => setEditItemId(entry.itemId)}
                              data-testid={`button-edit-custom-${entry.itemId}`}
                            >
                              <Edit className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            className="text-muted-foreground hover:text-destructive p-1 rounded transition-colors"
                            title="Remove item"
                            onClick={() => setConfirmRemoveItemId(entry.itemId)}
                            data-testid={`button-remove-${entry.itemId}`}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    );
                  });
                  })()}
                  {(!supply || supply.length === 0) && (
                    <tr>
                      <td colSpan={9} className="px-4 py-10 text-center font-mono">
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

        <TabsContent value="history" className="mt-0 outline-none">
          <SupplyHistoryTab unitId={unitId} />
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
                <div className="h-full min-h-[300px] border border-dashed border-border/50 rounded-sm flex flex-col items-center justify-center text-muted-foreground bg-card/30 gap-4">
                  <Calculator className="w-10 h-10 opacity-10" />
                  <div className="text-center space-y-1">
                    <p className="font-mono text-xs tracking-widest uppercase">Configure parameters then calculate</p>
                    <p className="font-mono text-[10px] text-muted-foreground/60">Results will appear here</p>
                  </div>
                  <Button onClick={handleCalc} disabled={calculate.isPending} variant="outline" className="font-mono uppercase text-xs tracking-widest">
                    <Calculator className="w-3.5 h-3.5 mr-2" />
                    {calculate.isPending ? "Calculating..." : "Run Calculation"}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="weapons" className="mt-0 outline-none">
          <WeaponsTab unitId={unitId} unitDetail={unitDetail} />
        </TabsContent>
      </Tabs>
    </Layout>
  );
}
