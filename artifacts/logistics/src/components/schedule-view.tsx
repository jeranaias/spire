import { useState } from "react";
import { Link } from "wouter";
import {
  useUpdateResupplyEvent,
  getGetDashboardOpsecPushesQueryKey,
  getListUnitSchedulesQueryKey,
  type ScheduleDetail,
} from "@workspace/api-client-react";
import { ArrowLeft, CheckCircle2, Download, Link2, Loader2, Mail, Printer, Radio } from "lucide-react";
import { PushToSpireButton } from "@/components/push-to-spire-button";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { ShareLinkPanel } from "@/components/share-link-panel";
import { buildScheduleMailto, downloadSchedulePdf } from "@/lib/schedule-pdf";
import { buildShareUrl } from "@/lib/share-url";

const BURN_MODEL_LABELS: Record<string, string> = {
  doctrinal: "Doctrinal Only",
  observed: "Observed Only",
  "worst-of-both": "Worst-of-Both",
};

function statusStyle(status: string): string {
  if (status === "delivered") return "bg-success/15 text-success border-success/30";
  if (status === "planned") return "bg-warning/15 text-warning border-warning/30";
  return "bg-destructive/15 text-destructive border-destructive/30";
}

interface ScheduleViewProps {
  schedule: ScheduleDetail;
  scheduleQueryKey: readonly unknown[];
  /** When true, hides write actions and the "Back to Unit" link (for public share view). */
  shareMode?: boolean;
}

export function ScheduleView({ schedule, scheduleQueryKey, shareMode = false }: ScheduleViewProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [shareToken, setShareToken] = useState<string | null>(schedule.shareToken ?? null);

  const updateResupply = useUpdateResupplyEvent({
    mutation: {
      onSuccess: (_data, variables) => {
        queryClient.invalidateQueries({ queryKey: scheduleQueryKey });
        queryClient.invalidateQueries({
          queryKey: getGetDashboardOpsecPushesQueryKey(),
        });
        queryClient.invalidateQueries({ queryKey: ["opsec-pushes"] });
        if (variables.data.status === "delivered") {
          toast({
            title: "Push marked delivered",
            description: "Schedule and dashboard updated.",
          });
        }
      },
      onError: (err: unknown) => {
        toast({
          title: "Could not mark delivered",
          description: err instanceof Error ? err.message : "Unknown error",
          variant: "destructive",
        });
      },
    },
  });

  return (
    <>
      {/* Print-only header — classification banner, schedule label, DTG */}
      <div className="hidden print:block mb-4">
        <div className="text-center font-mono font-bold text-base tracking-[0.3em] border-y-2 border-black py-1">
          UNCLASSIFIED
        </div>
        <h1 className="text-center text-lg font-mono font-bold uppercase tracking-[0.15em] mt-3">
          Pre-Coordinated Resupply Schedule
        </h1>
        <div className="flex gap-4 text-xs font-mono mt-3 items-start">
          <div className="flex-1 grid grid-cols-2 gap-4">
            <div>
              <div className="font-bold uppercase tracking-widest">Schedule</div>
              <div>{schedule.label}</div>
              <div className="mt-1">
                Receiving Unit: {schedule.unitName}
                {schedule.unitEchelon ? ` (${schedule.unitEchelon})` : ""}
              </div>
            </div>
            <div className="text-right">
              <div className="font-bold uppercase tracking-widest">Published DTG</div>
              <div>
                {schedule.publishedAt
                  ? format(new Date(schedule.publishedAt), "ddHHmm'Z' MMM yy").toUpperCase()
                  : "DRAFT"}
              </div>
              <div>Printed: {format(new Date(), "ddHHmm'Z' MMM yy").toUpperCase()}</div>
            </div>
          </div>
          {schedule.shareToken && (
            <div className="shrink-0 text-center" data-testid="qr-share-url-print">
              <div className="bg-white p-1 border border-black">
                <QRCodeSVG
                  value={buildShareUrl(schedule.shareToken)}
                  size={88}
                  level="M"
                  marginSize={0}
                />
              </div>
              <div className="font-bold uppercase tracking-widest text-[8px] mt-1">
                Scan to open on mobile
              </div>
            </div>
          )}
        </div>
        <div className="grid grid-cols-4 gap-2 text-[10px] font-mono mt-2">
          <div className="border border-black px-2 py-1">
            <div className="font-bold uppercase tracking-widest">Location</div>
            <div className="uppercase">{schedule.unitLocation || "—"}</div>
          </div>
          <div className="border border-black px-2 py-1">
            <div className="font-bold uppercase tracking-widest">Climate</div>
            <div className="uppercase">{schedule.unitClimate || "—"}</div>
          </div>
          <div className="border border-black px-2 py-1">
            <div className="font-bold uppercase tracking-widest">Op Tempo</div>
            <div className="uppercase">{schedule.unitOpTempo || "—"}</div>
          </div>
          <div className="border border-black px-2 py-1">
            <div className="font-bold uppercase tracking-widest">Ammo Posture</div>
            <div className="uppercase">{schedule.unitAmmoPosture ? schedule.unitAmmoPosture.replace("_", " ") : "—"}</div>
          </div>
        </div>
        <div className="text-xs font-mono mt-3 p-2 border border-black">
          <span className="font-bold uppercase tracking-widest">Plan: </span>
          {schedule.horizonDays}d horizon ·{" "}
          {BURN_MODEL_LABELS[schedule.burnModel] ?? schedule.burnModel} ·{" "}
          {schedule.safetyMarginDays}d safety · {schedule.resupplyLeadDays}d lead ·{" "}
          {schedule.events.length} push{schedule.events.length !== 1 ? "es" : ""}
        </div>
      </div>

      <div className="print:hidden">
        <PageHeader
          title={schedule.label}
          tag={shareMode ? "Shared Schedule · Read-Only" : "Pre-Coordinated Schedule"}
          subtitle={`${schedule.unitName} · ${schedule.horizonDays}d horizon · ${BURN_MODEL_LABELS[schedule.burnModel] ?? schedule.burnModel}`}
          right={
            <div className="flex gap-2">
              {!shareMode && (
                <Link href={`/units/${schedule.unitId}`}>
                  <Button variant="outline" size="sm" className="font-mono uppercase text-[10px] tracking-widest">
                    <ArrowLeft className="w-3.5 h-3.5 mr-1.5" /> Back to Unit
                  </Button>
                </Link>
              )}
              <Button
                variant="outline"
                size="sm"
                className="font-mono uppercase text-[10px] tracking-widest"
                onClick={() => window.print()}
                data-testid="button-print-schedule"
              >
                <Printer className="w-3.5 h-3.5 mr-1.5" /> Print
              </Button>
              {!shareMode && (
                <PushToSpireButton
                  sourceKind="schedule"
                  sourceId={schedule.id}
                  contextLabel={schedule.label || `Schedule ${schedule.id.slice(0, 8)}`}
                  size="default"
                />
              )}
              <Button
                variant="outline"
                size="sm"
                className="font-mono uppercase text-[10px] tracking-widest"
                onClick={() => {
                  void downloadSchedulePdf(schedule).catch((err: unknown) => {
                    toast({
                      title: "Could not generate PDF",
                      description:
                        err instanceof Error ? err.message : "Unknown error",
                      variant: "destructive",
                    });
                  });
                }}
                data-testid="button-download-pdf"
              >
                <Download className="w-3.5 h-3.5 mr-1.5" /> Download PDF
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="font-mono uppercase text-[10px] tracking-widest"
                onClick={() => {
                  // Prefer the public share URL so recipients without an
                  // account can open the schedule. Fall back to the current
                  // page URL only if no share token is available.
                  const publicUrl =
                    schedule.shareToken && typeof window !== "undefined"
                      ? buildShareUrl(schedule.shareToken)
                      : undefined;
                  const fallbackUrl =
                    typeof window !== "undefined"
                      ? window.location.href
                      : undefined;
                  const {
                    url,
                    validRecipients,
                    invalidRecipients,
                    validCcRecipients,
                    invalidCcRecipients,
                    validBccRecipients,
                    invalidBccRecipients,
                  } = buildScheduleMailto(schedule, publicUrl ?? fallbackUrl);
                  // Distro entries (TO, CC, and BCC) that don't match the
                  // email shape would otherwise be silently passed through
                  // to the mailto: draft and (depending on the mail client)
                  // either be refused or sent to a garbage address. Strip
                  // them and warn the planner so they can clean up the
                  // unit's distribution list.
                  const invalidAll = [
                    ...invalidRecipients,
                    ...invalidCcRecipients,
                    ...invalidBccRecipients,
                  ];
                  if (invalidAll.length > 0) {
                    const noValidRecipients =
                      validRecipients.length === 0 &&
                      validCcRecipients.length === 0 &&
                      validBccRecipients.length === 0;
                    toast({
                      title:
                        invalidAll.length === 1
                          ? "Skipped 1 invalid distro address"
                          : `Skipped ${invalidAll.length} invalid distro addresses`,
                      description: `${invalidAll
                        .map((addr) => `"${addr}"`)
                        .join(", ")} ${
                        invalidAll.length === 1 ? "doesn't" : "don't"
                      } look like an email address. ${
                        noValidRecipients
                          ? "Add recipients manually in your mail client, or update the unit's distribution list."
                          : "Update the unit's distribution list to clean them up."
                      }`,
                      variant: noValidRecipients ? "destructive" : "default",
                    });
                  }
                  if (typeof window !== "undefined") {
                    window.location.href = url;
                  }
                }}
                data-testid="button-email-schedule"
              >
                <Mail className="w-3.5 h-3.5 mr-1.5" /> Email
              </Button>
            </div>
          }
        />
      </div>

      <div className="space-y-6">
        {!shareMode && (
          <Card className="border-border print:hidden">
            <CardHeader className="border-b border-border pb-3 pt-4 px-4">
              <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
                <Link2 className="w-3.5 h-3.5 text-primary" /> Share Link
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <ShareLinkPanel
                scheduleId={schedule.id}
                shareToken={shareToken}
                onTokenChange={setShareToken}
                invalidateKeys={[
                  scheduleQueryKey,
                  getListUnitSchedulesQueryKey(schedule.unitId),
                  getGetDashboardOpsecPushesQueryKey(),
                ]}
              />
            </CardContent>
          </Card>
        )}

        <Card className="border-border print:hidden">
          <CardHeader className="border-b border-border pb-3 pt-4 px-4">
            <CardTitle className="font-mono uppercase text-[10px] tracking-widest flex items-center gap-2 text-muted-foreground">
              <Radio className="w-3.5 h-3.5 text-primary" /> Schedule Details
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 font-mono">
              <div>
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-0.5">Unit</span>
                <span className="text-sm font-bold">{schedule.unitName}</span>
              </div>
              <div>
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-0.5">Published</span>
                <span className="text-sm font-bold">
                  {schedule.publishedAt ? format(new Date(schedule.publishedAt), "ddMMMyy HHmm'Z'").toUpperCase() : "Draft"}
                </span>
              </div>
              <div>
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-0.5">Horizon</span>
                <span className="text-sm font-bold">{schedule.horizonDays} Days</span>
              </div>
              <div>
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-0.5">Burn Model</span>
                <span className="text-sm font-bold">{BURN_MODEL_LABELS[schedule.burnModel] ?? schedule.burnModel}</span>
              </div>
              <div>
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-0.5">Safety Margin</span>
                <span className="text-sm font-bold">{schedule.safetyMarginDays}d</span>
              </div>
              <div>
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-0.5">Resupply Lead</span>
                <span className="text-sm font-bold">{schedule.resupplyLeadDays}d</span>
              </div>
              <div>
                <span className="text-[10px] text-muted-foreground uppercase tracking-widest block mb-0.5">Total Pushes</span>
                <span className="text-sm font-bold">{schedule.events.length}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border">
          <CardHeader className="border-b border-border pb-3 pt-4 px-4">
            <CardTitle className="font-mono uppercase text-[10px] tracking-widest text-muted-foreground">
              Resupply Push Schedule
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {schedule.events.length === 0 ? (
              <div className="px-4 py-8 text-center font-mono text-xs text-muted-foreground uppercase tracking-widest">
                No resupply events in this schedule.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/20">
                    <th className="px-4 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Item</th>
                    <th className="px-4 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Class</th>
                    <th className="px-4 py-2 text-right font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Quantity</th>
                    <th className="px-4 py-2 text-right font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Delivery Date</th>
                    <th className="px-4 py-2 text-center font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Status</th>
                    <th className="px-4 py-2 text-left font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Notes</th>
                    {!shareMode && (
                      <th className="px-4 py-2 text-right font-mono text-[10px] uppercase tracking-widest text-muted-foreground print:hidden">Action</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {schedule.events.map((ev) => {
                    const pendingForThisEvent =
                      updateResupply.isPending &&
                      updateResupply.variables?.eventId === ev.id;
                    return (
                      <tr key={ev.id} className="hover:bg-muted/10">
                        <td className="px-4 py-2.5 font-mono font-bold text-xs">{ev.itemName ?? "—"}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">Class {ev.supplyClass}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums font-bold text-primary">
                          {ev.quantity.toFixed(1)} {ev.unit}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs tabular-nums">
                          {format(new Date(ev.scheduledFor), "ddHHmm'Z' MMM yy").toUpperCase()}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <span className={`inline-flex items-center font-mono text-[10px] border px-1.5 py-0.5 rounded-sm ${statusStyle(ev.status)}`}>
                            {ev.status.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[10px] text-muted-foreground">
                          {ev.notes ?? "—"}
                        </td>
                        {!shareMode && (
                          <td className="px-4 py-2.5 text-right print:hidden">
                            {ev.status === "planned" ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={pendingForThisEvent}
                                onClick={() =>
                                  updateResupply.mutate({
                                    eventId: ev.id,
                                    data: { status: "delivered" },
                                  })
                                }
                                className="font-mono uppercase text-[10px] tracking-widest h-7 px-2"
                                data-testid={`button-mark-delivered-${ev.id}`}
                              >
                                {pendingForThisEvent ? (
                                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                ) : (
                                  <CheckCircle2 className="w-3 h-3 mr-1" />
                                )}
                                Mark Delivered
                              </Button>
                            ) : (
                              <span className="font-mono text-[10px] text-muted-foreground/60">—</span>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Print-only signature/handoff block + classification footer */}
      <div className="hidden print:block mt-8">
        <div className="grid grid-cols-2 gap-8 text-xs font-mono">
          <div>
            <div className="border-b border-black h-12"></div>
            <div className="font-bold uppercase tracking-widest mt-1">Released By — Signature / Date</div>
          </div>
          <div>
            <div className="border-b border-black h-12"></div>
            <div className="font-bold uppercase tracking-widest mt-1">Received By — Signature / Date</div>
          </div>
        </div>
        <div className="font-mono text-[10px] text-center mt-4">
          MARLOG Pre-Coordinated Schedule — {schedule.label} — Printed {format(new Date(), "ddMMMyy HHmm'Z'").toUpperCase()}
        </div>
        <div className="text-center font-mono font-bold text-base tracking-[0.3em] border-y-2 border-black py-1 mt-4">
          UNCLASSIFIED
        </div>
      </div>
    </>
  );
}
