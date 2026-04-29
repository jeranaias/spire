import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { format } from "date-fns";
import QRCode from "qrcode";
import type { ScheduleDetail } from "@workspace/api-client-react";
import { partitionDistroEmails } from "@workspace/distro-email";
import { buildShareUrl } from "./share-url";

const BURN_MODEL_LABELS: Record<string, string> = {
  doctrinal: "Doctrinal Only",
  observed: "Observed Only",
  "worst-of-both": "Worst-of-Both",
};

function dtg(date: Date): string {
  return format(date, "ddHHmm'Z' MMM yy").toUpperCase();
}

function sanitizeForFilename(value: string): string {
  return value
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function buildSchedulePdfFilename(schedule: ScheduleDetail): string {
  const dtgPart = schedule.publishedAt
    ? format(new Date(schedule.publishedAt), "ddHHmm'Z'-MMMyy").toUpperCase()
    : "DRAFT";
  const labelPart = sanitizeForFilename(schedule.label) || "Schedule";
  return `MARLOG-Schedule-${labelPart}-${dtgPart}.pdf`;
}

export interface ScheduleEmailDraft {
  subject: string;
  body: string;
}

export function buildScheduleEmailDraft(
  schedule: ScheduleDetail,
  shareUrl?: string,
): ScheduleEmailDraft {
  const dtgPart = schedule.publishedAt
    ? dtg(new Date(schedule.publishedAt))
    : "DRAFT";
  const subject = `MARLOG Schedule — ${schedule.label} — ${dtgPart}`;

  const burnLabel =
    BURN_MODEL_LABELS[schedule.burnModel] ?? schedule.burnModel;
  const pushWord = schedule.events.length === 1 ? "push" : "pushes";
  const unitLine = schedule.unitEchelon
    ? `${schedule.unitName} (${schedule.unitEchelon})`
    : schedule.unitName;

  const lines: string[] = [
    `Pre-Coordinated Resupply Schedule: ${schedule.label}`,
    `Receiving Unit: ${unitLine}`,
    `Published DTG: ${dtgPart}`,
    `Plan: ${schedule.horizonDays}d horizon, ${burnLabel}, ` +
      `${schedule.safetyMarginDays}d safety, ${schedule.resupplyLeadDays}d lead, ` +
      `${schedule.events.length} ${pushWord}`,
    "",
  ];

  if (shareUrl) {
    lines.push(`Schedule link: ${shareUrl}`);
    if (schedule.shareToken) {
      lines.push(`Share token: ${schedule.shareToken}`);
    }
    lines.push("");
  }

  lines.push("// MARLOG — Marine Logistics");

  return { subject, body: lines.join("\n") };
}

// Validation runs server-side when planners save a unit, but units created
// before that check existed (or imported / hand-edited) can still carry
// malformed entries — so we re-validate here before pre-filling mailto:.
// The `partitionDistroEmails` helper from `@workspace/distro-email` is the
// shared source of truth for the email-shape rule.

export interface ScheduleMailto {
  /** The fully-formed mailto: URL, with only valid addresses in to=/cc=. */
  url: string;
  /** TO entries that passed the email-shape check (de-duplicated). */
  validRecipients: string[];
  /** TO entries that were skipped because they don't look like emails. */
  invalidRecipients: string[];
  /** CC entries that passed the email-shape check (de-duplicated). */
  validCcRecipients: string[];
  /** CC entries that were skipped because they don't look like emails. */
  invalidCcRecipients: string[];
  /** BCC entries that passed the email-shape check (de-duplicated). */
  validBccRecipients: string[];
  /** BCC entries that were skipped because they don't look like emails. */
  invalidBccRecipients: string[];
}

/**
 * Build a mailto: URL for a schedule, filtering the unit's distribution list
 * (TO and CC) down to addresses that actually look like emails. Returns the
 * URL alongside both the kept and skipped entries so the caller can warn
 * planners about pre-existing bad addresses.
 *
 * Entries are de-duplicated across TO and CC, so an address that appears in
 * both lists only shows up in TO (the more permissive bucket).
 */
export function buildScheduleMailto(
  schedule: ScheduleDetail,
  shareUrl?: string,
): ScheduleMailto {
  const draft = buildScheduleEmailDraft(schedule, shareUrl);
  const params = new URLSearchParams();
  params.set("subject", draft.subject);
  params.set("body", draft.body);
  // URLSearchParams encodes spaces as "+", but mailto clients expect "%20".
  const qs = params.toString().replace(/\+/g, "%20");

  const seen = new Set<string>();
  const { valid: validRecipients, invalid: invalidRecipients } =
    partitionDistroEmails(schedule.unitDistroEmails, seen);
  const { valid: validCcRecipients, invalid: invalidCcRecipients } =
    partitionDistroEmails(schedule.unitDistroCcEmails, seen);
  const { valid: validBccRecipients, invalid: invalidBccRecipients } =
    partitionDistroEmails(schedule.unitDistroBccEmails, seen);

  // Recipients are encoded directly into the path of the mailto: URL
  // (RFC 6068) rather than as a query parameter, since most desktop mail
  // clients only honor the `to` field when it appears there. CC and BCC
  // header params are assembled ahead of the body so desktop mail clients
  // consistently honor them — same RFC 6068 quirks as the to= path above.
  const recipients = validRecipients
    .map((addr) => encodeURIComponent(addr))
    .join(",");
  const headerParams: string[] = [];
  if (validCcRecipients.length > 0) {
    headerParams.push(
      `cc=${validCcRecipients.map((addr) => encodeURIComponent(addr)).join(",")}`,
    );
  }
  if (validBccRecipients.length > 0) {
    headerParams.push(
      `bcc=${validBccRecipients.map((addr) => encodeURIComponent(addr)).join(",")}`,
    );
  }
  const url =
    headerParams.length > 0
      ? `mailto:${recipients}?${headerParams.join("&")}&${qs}`
      : `mailto:${recipients}?${qs}`;

  return {
    url,
    validRecipients,
    invalidRecipients,
    validCcRecipients,
    invalidCcRecipients,
    validBccRecipients,
    invalidBccRecipients,
  };
}

/**
 * Backwards-compatible wrapper that returns just the mailto: URL string.
 * Prefer {@link buildScheduleMailto} when the caller wants to surface
 * skipped-address warnings to the user.
 */
export function buildScheduleMailtoUrl(
  schedule: ScheduleDetail,
  shareUrl?: string,
): string {
  return buildScheduleMailto(schedule, shareUrl).url;
}

export async function downloadSchedulePdf(
  schedule: ScheduleDetail,
): Promise<void> {
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 36;
  const contentWidth = pageWidth - marginX * 2;
  const printedDtg = dtg(new Date());
  const publishedDtg = schedule.publishedAt
    ? dtg(new Date(schedule.publishedAt))
    : "DRAFT";

  // Render the share QR code (if a share token exists) so we can embed it
  // in the header next to the published DTG block. If QR rendering fails
  // we still want to produce the rest of the PDF, but the failure is
  // surfaced in the console so it isn't silently lost.
  let qrDataUrl: string | null = null;
  if (schedule.shareToken && typeof window !== "undefined") {
    try {
      const shareUrl = buildShareUrl(schedule.shareToken);
      qrDataUrl = await QRCode.toDataURL(shareUrl, {
        margin: 0,
        width: 256,
        errorCorrectionLevel: "M",
      });
    } catch (err) {
      console.warn(
        "[schedule-pdf] failed to render share QR code; continuing without it",
        err,
      );
      qrDataUrl = null;
    }
  }

  // Classification banner (top)
  doc.setLineWidth(1.5);
  doc.line(marginX, 36, pageWidth - marginX, 36);
  doc.line(marginX, 60, pageWidth - marginX, 60);
  doc.setFont("courier", "bold");
  doc.setFontSize(14);
  doc.text("UNCLASSIFIED", pageWidth / 2, 53, { align: "center" });

  // Title
  doc.setFont("courier", "bold");
  doc.setFontSize(13);
  doc.text(
    "PRE-COORDINATED RESUPPLY SCHEDULE",
    pageWidth / 2,
    82,
    { align: "center" },
  );

  // Share QR code (top-right corner). Drawn before the right-aligned
  // DTG block so we can shift that block left to make room for it.
  const qrSize = 60;
  const qrGap = 10;
  let dtgRightX = pageWidth - marginX;
  if (qrDataUrl) {
    const qrX = pageWidth - marginX - qrSize;
    const qrY = 66;
    doc.addImage(qrDataUrl, "PNG", qrX, qrY, qrSize, qrSize);
    doc.setFont("courier", "bold");
    doc.setFontSize(7);
    doc.text("SCAN TO OPEN ON MOBILE", qrX + qrSize / 2, qrY + qrSize + 8, {
      align: "center",
    });
    dtgRightX = qrX - qrGap;
  }

  // Header columns: Schedule + Published DTG
  doc.setFont("courier", "bold");
  doc.setFontSize(8);
  doc.text("SCHEDULE", marginX, 102);
  doc.text("PUBLISHED DTG", dtgRightX, 102, { align: "right" });

  doc.setFont("courier", "normal");
  doc.setFontSize(9);
  doc.text(schedule.label, marginX, 115);
  doc.text(`Receiving Unit: ${schedule.unitName}`, marginX, 127);
  doc.text(publishedDtg, dtgRightX, 115, { align: "right" });
  doc.text(`Printed: ${printedDtg}`, dtgRightX, 127, {
    align: "right",
  });

  // Plan summary box
  const planBoxY = 140;
  const planBoxHeight = 26;
  doc.setLineWidth(0.75);
  doc.rect(marginX, planBoxY, contentWidth, planBoxHeight);
  const burnLabel =
    BURN_MODEL_LABELS[schedule.burnModel] ?? schedule.burnModel;
  const pushWord = schedule.events.length === 1 ? "push" : "pushes";
  const planLine =
    `PLAN: ${schedule.horizonDays}d horizon  ` +
    `${burnLabel}  ` +
    `${schedule.safetyMarginDays}d safety  ` +
    `${schedule.resupplyLeadDays}d lead  ` +
    `${schedule.events.length} ${pushWord}`;
  doc.setFont("courier", "bold");
  doc.setFontSize(9);
  doc.text(planLine, marginX + 8, planBoxY + 17);

  // Push table
  const tableStartY = planBoxY + planBoxHeight + 12;

  if (schedule.events.length === 0) {
    doc.setFont("courier", "normal");
    doc.setFontSize(10);
    doc.text(
      "NO RESUPPLY EVENTS IN THIS SCHEDULE.",
      pageWidth / 2,
      tableStartY + 20,
      { align: "center" },
    );
  } else {
    autoTable(doc, {
      startY: tableStartY,
      margin: { left: marginX, right: marginX },
      head: [
        ["Item", "Class", "Quantity", "Delivery DTG", "Status", "Notes"],
      ],
      body: schedule.events.map((ev) => [
        ev.itemName ?? "—",
        `Class ${ev.supplyClass}`,
        `${ev.quantity.toFixed(1)} ${ev.unit}`,
        dtg(new Date(ev.scheduledFor)),
        ev.status.toUpperCase(),
        ev.notes ?? "—",
      ]),
      styles: {
        font: "courier",
        fontSize: 8,
        cellPadding: 4,
        lineColor: [80, 80, 80],
        lineWidth: 0.5,
        textColor: [0, 0, 0],
      },
      headStyles: {
        fillColor: [230, 230, 230],
        textColor: [0, 0, 0],
        fontStyle: "bold",
        halign: "left",
      },
      columnStyles: {
        0: { cellWidth: 130 },
        1: { cellWidth: 50 },
        2: { cellWidth: 70, halign: "right" },
        3: { cellWidth: 90, halign: "right" },
        4: { cellWidth: 60, halign: "center" },
        5: { cellWidth: "auto" },
      },
      didDrawPage: () => {
        // Re-draw classification banners on every page
        doc.setLineWidth(1.5);
        doc.line(marginX, 36, pageWidth - marginX, 36);
        doc.line(marginX, 60, pageWidth - marginX, 60);
        doc.setFont("courier", "bold");
        doc.setFontSize(14);
        doc.text("UNCLASSIFIED", pageWidth / 2, 53, { align: "center" });
      },
    });
  }

  // Signature/handoff block + footer + closing classification banner
  // Place at bottom of last page, with fallback to a new page if needed.
  const lastTable = (
    doc as unknown as { lastAutoTable?: { finalY: number } }
  ).lastAutoTable;
  const afterTableY = lastTable?.finalY ?? tableStartY + 40;
  const signatureBlockHeight = 110;
  let signatureY = afterTableY + 30;
  if (signatureY + signatureBlockHeight > pageHeight - 40) {
    doc.addPage();
    signatureY = 90;
  }

  // Signature lines
  const half = contentWidth / 2 - 12;
  const sigLineY = signatureY + 40;
  doc.setLineWidth(0.75);
  doc.line(marginX, sigLineY, marginX + half, sigLineY);
  doc.line(
    marginX + half + 24,
    sigLineY,
    marginX + half + 24 + half,
    sigLineY,
  );

  doc.setFont("courier", "bold");
  doc.setFontSize(8);
  doc.text("RELEASED BY — SIGNATURE / DATE", marginX, sigLineY + 12);
  doc.text(
    "RECEIVED BY — SIGNATURE / DATE",
    marginX + half + 24,
    sigLineY + 12,
  );

  // Footer caption
  doc.setFont("courier", "normal");
  doc.setFontSize(8);
  doc.text(
    `MARLOG Pre-Coordinated Schedule — ${schedule.label} — Printed ${printedDtg}`,
    pageWidth / 2,
    sigLineY + 36,
    { align: "center" },
  );

  // Closing classification banner
  const closeBannerY = sigLineY + 50;
  doc.setLineWidth(1.5);
  doc.line(marginX, closeBannerY, pageWidth - marginX, closeBannerY);
  doc.line(
    marginX,
    closeBannerY + 24,
    pageWidth - marginX,
    closeBannerY + 24,
  );
  doc.setFont("courier", "bold");
  doc.setFontSize(14);
  doc.text("UNCLASSIFIED", pageWidth / 2, closeBannerY + 17, {
    align: "center",
  });

  doc.save(buildSchedulePdfFilename(schedule));
}
