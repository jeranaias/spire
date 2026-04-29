import nodemailer, { type Transporter } from "nodemailer";
import {
  db,
  commsHygieneRunsTable,
  commsHygieneSettingsTable,
  activityTable,
  type CommsHygieneOutcome,
} from "@workspace/db";
import { asc, count, desc, eq, lt, lte } from "drizzle-orm";
import { logger } from "./logger";
import { runDistroAudit, type DistroAuditResult, type FlaggedUnit } from "./distro-audit";

const SETTINGS_ROW_ID = "default";

const DEFAULT_INTERVAL_HOURS = 168;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 180;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_NEAR_EXPIRY_WINDOW_DAYS = 7;

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

interface CommsHygieneConfig {
  enabled: boolean;
  intervalMs: number;
  recipients: string[];
  cc: string[];
  appBaseUrl: string;
  smtp: SmtpConfig | null;
}

function parseRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function readSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const from = process.env.COMMS_HYGIENE_FROM ?? process.env.SMTP_FROM;
  if (!host || !from) return null;
  const portRaw = process.env.SMTP_PORT;
  const port = portRaw ? Number(portRaw) : 587;
  if (!Number.isFinite(port) || port <= 0) return null;
  return {
    host,
    port,
    secure: (process.env.SMTP_SECURE ?? "").toLowerCase() === "true" || port === 465,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from,
  };
}

/**
 * Env-var (or compile-time) fallback for the retention horizon. Used when
 * the in-DB override is unset. Kept sync because it never touches the DB.
 *
 * Set `COMMS_HYGIENE_RETENTION_DAYS=0` to disable pruning entirely when no
 * override is configured.
 */
export function readCommsHygieneRetentionDefault(): number {
  const raw = process.env.COMMS_HYGIENE_RETENTION_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_DAYS;
  return Math.max(0, Math.floor(parsed));
}

export interface CommsHygieneSettings {
  /**
   * Effective retention in days that the prune sweep and stats endpoint use.
   * `retentionDaysOverride` when set, otherwise `retentionDaysDefault`.
   */
  retentionDays: number;
  /** In-DB override; null when no override is active. */
  retentionDaysOverride: number | null;
  /** Env / compile-time default — the value used when no override is set. */
  retentionDaysDefault: number;
  /** Last time the override was changed via the dashboard. */
  updatedAt: string | null;
}

/**
 * Read the current effective comms-hygiene settings, lazily creating the
 * single settings row on first access so callers don't have to special-case
 * a missing row.
 */
export async function getCommsHygieneSettings(): Promise<CommsHygieneSettings> {
  const fallback = readCommsHygieneRetentionDefault();
  let row: typeof commsHygieneSettingsTable.$inferSelect | undefined;
  try {
    const rows = await db
      .select()
      .from(commsHygieneSettingsTable)
      .where(eq(commsHygieneSettingsTable.id, SETTINGS_ROW_ID))
      .limit(1);
    row = rows[0];
    if (!row) {
      const inserted = await db
        .insert(commsHygieneSettingsTable)
        .values({ id: SETTINGS_ROW_ID, retentionDaysOverride: null })
        .onConflictDoNothing({ target: commsHygieneSettingsTable.id })
        .returning();
      row = inserted[0];
      if (!row) {
        // Lost the race with another writer — re-read.
        const refetch = await db
          .select()
          .from(commsHygieneSettingsTable)
          .where(eq(commsHygieneSettingsTable.id, SETTINGS_ROW_ID))
          .limit(1);
        row = refetch[0];
      }
    }
  } catch (err) {
    // Settings should never block prune/stats reads — fall back to env-only.
    logger.error({ err }, "Comms-hygiene: failed to load settings, using env fallback");
    return {
      retentionDays: fallback,
      retentionDaysOverride: null,
      retentionDaysDefault: fallback,
      updatedAt: null,
    };
  }

  const override = row?.retentionDaysOverride ?? null;
  return {
    retentionDays: override ?? fallback,
    retentionDaysOverride: override,
    retentionDaysDefault: fallback,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

/**
 * Days of `comms_hygiene_runs` history to keep. Reads the in-DB override
 * first (so dashboard changes take effect without a server restart), then
 * falls back to `COMMS_HYGIENE_RETENTION_DAYS`, then the compile-time
 * default. Anything older is swept by the daily prune timer.
 *
 * A non-positive return value disables pruning entirely.
 */
export async function readCommsHygieneRetentionDays(): Promise<number> {
  const settings = await getCommsHygieneSettings();
  return settings.retentionDays;
}

/**
 * Persist a new retention override (or clear it by passing `null`). Records
 * an activity entry so the change shows up in the audit log immediately.
 * `retentionDaysOverride` must be a non-negative integer when set; 0 means
 * "retention disabled". Returns the freshly-loaded settings.
 */
export async function setCommsHygieneRetentionOverride(
  retentionDaysOverride: number | null,
): Promise<CommsHygieneSettings> {
  if (
    retentionDaysOverride !== null &&
    (!Number.isInteger(retentionDaysOverride) ||
      retentionDaysOverride < 0 ||
      retentionDaysOverride > 3650)
  ) {
    throw new Error(
      `Invalid retentionDaysOverride: ${retentionDaysOverride}. Must be null or an integer between 0 and 3650.`,
    );
  }

  const before = await getCommsHygieneSettings();
  const now = new Date();
  await db
    .insert(commsHygieneSettingsTable)
    .values({
      id: SETTINGS_ROW_ID,
      retentionDaysOverride,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: commsHygieneSettingsTable.id,
      set: { retentionDaysOverride, updatedAt: now },
    });

  const after = await getCommsHygieneSettings();

  if (before.retentionDaysOverride !== after.retentionDaysOverride) {
    const message =
      after.retentionDaysOverride === null
        ? `Comms-hygiene retention override cleared — falling back to ${after.retentionDaysDefault}-day default`
        : `Comms-hygiene retention override set to ${after.retentionDaysOverride} day${
            after.retentionDaysOverride === 1 ? "" : "s"
          }${
            before.retentionDaysOverride === null
              ? ` (was using ${before.retentionDaysDefault}-day default)`
              : ` (was ${before.retentionDaysOverride})`
          }`;
    try {
      await db.insert(activityTable).values({
        kind: "comms_hygiene_retention_changed",
        message,
      });
    } catch (err) {
      // Audit logging failures should never mask the settings update.
      logger.error({ err }, "Comms-hygiene: failed to persist retention-change activity");
    }
    logger.info(
      {
        before: before.retentionDaysOverride,
        after: after.retentionDaysOverride,
        effective: after.retentionDays,
      },
      "Comms-hygiene: retention override updated",
    );
  }

  return after;
}

/**
 * Days before pruning at which a stored run should be flagged as
 * "expires soon" on the dashboard, so planners can save the entry off
 * (e.g. by exporting) before it silently disappears. Read separately so
 * operators can tune the warning window without touching retention itself.
 *
 * Set to 0 (or any non-positive value) to disable the warning entirely
 * even when retention is on.
 *
 * Exported so dashboard endpoints can echo the configured window back to
 * the UI, keeping server- and client-side flagging in lockstep.
 */
export function readCommsHygieneNearExpiryWindowDays(): number {
  const raw = process.env.COMMS_HYGIENE_NEAR_EXPIRY_WINDOW_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_NEAR_EXPIRY_WINDOW_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_NEAR_EXPIRY_WINDOW_DAYS;
  return Math.max(0, Math.floor(parsed));
}

function readConfig(): CommsHygieneConfig {
  const intervalHoursRaw = process.env.COMMS_HYGIENE_INTERVAL_HOURS;
  const intervalHours = intervalHoursRaw
    ? Number(intervalHoursRaw)
    : DEFAULT_INTERVAL_HOURS;
  const intervalMs =
    Number.isFinite(intervalHours) && intervalHours > 0
      ? intervalHours * 60 * 60 * 1000
      : DEFAULT_INTERVAL_HOURS * 60 * 60 * 1000;

  const recipients = parseRecipients(process.env.COMMS_HYGIENE_TO);
  const cc = parseRecipients(process.env.COMMS_HYGIENE_CC);

  const appBaseUrl = (
    process.env.MARLOG_PUBLIC_BASE_URL ?? "http://localhost"
  ).replace(/\/+$/, "");

  const enabled =
    (process.env.COMMS_HYGIENE_ENABLED ?? "").toLowerCase() === "true" &&
    recipients.length > 0;

  return {
    enabled,
    intervalMs,
    recipients,
    cc,
    appBaseUrl,
    smtp: readSmtpConfig(),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildDigestSubject(result: DistroAuditResult): string {
  const u = result.flaggedUnitCount;
  const e = result.invalidEntryCount;
  return `[MARLOG] Comms hygiene: ${e} malformed distro entr${e === 1 ? "y" : "ies"} across ${u} unit${u === 1 ? "" : "s"}`;
}

export function buildDigestText(
  result: DistroAuditResult,
  appBaseUrl: string,
): string {
  const lines: string[] = [];
  lines.push("MARLOG Comms-Hygiene Digest");
  lines.push("");
  lines.push(
    `Scanned ${result.scannedUnitCount} unit${result.scannedUnitCount === 1 ? "" : "s"}. ` +
      `Found ${result.invalidEntryCount} malformed entr${result.invalidEntryCount === 1 ? "y" : "ies"} ` +
      `across ${result.flaggedUnitCount} unit${result.flaggedUnitCount === 1 ? "" : "s"}.`,
  );
  lines.push("");
  lines.push(
    "These addresses are silently dropped at email send time, so distros may be missing recipients.",
  );
  lines.push("");
  for (const u of result.units) {
    const callsign = u.callsign ? ` "${u.callsign}"` : "";
    lines.push(`• ${u.unitName}${callsign} (${u.echelon})`);
    lines.push(`  Edit: ${appBaseUrl}/units/${u.unitId}/edit`);
    for (const entry of u.invalidEntries) {
      lines.push(`    ${entry.bucket.toUpperCase().padEnd(3)}  ${entry.value}`);
    }
    lines.push("");
  }
  lines.push(
    "Fix from the unit detail page → Edit, or by direct DB cleanup. " +
      "Replies to this address are not monitored.",
  );
  return lines.join("\n");
}

export function buildDigestHtml(
  result: DistroAuditResult,
  appBaseUrl: string,
): string {
  const unitsHtml = result.units
    .map((u: FlaggedUnit) => {
      const callsign = u.callsign
        ? ` <em style="color:#9aa0a6">"${escapeHtml(u.callsign)}"</em>`
        : "";
      const editUrl = `${appBaseUrl}/units/${encodeURIComponent(u.unitId)}/edit`;
      const rows = u.invalidEntries
        .map(
          (entry) =>
            `<li><code style="background:#0e1726;color:#e6edf3;padding:1px 6px;border-radius:4px">${escapeHtml(entry.bucket.toUpperCase())}</code> &nbsp;${escapeHtml(entry.value)}</li>`,
        )
        .join("");
      return `
        <li style="margin-bottom:18px">
          <div style="font-weight:600">${escapeHtml(u.unitName)}${callsign} <span style="color:#9aa0a6;font-weight:400">(${escapeHtml(u.echelon)})</span></div>
          <div style="margin:4px 0 6px"><a href="${editUrl}" style="color:#22d3ee">Open unit edit page →</a></div>
          <ul style="margin:0 0 0 18px;padding:0">${rows}</ul>
        </li>`;
    })
    .join("");

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0e1726;background:#f6f7f9;padding:24px">
  <div style="max-width:680px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:24px">
    <h1 style="margin:0 0 4px;font-size:18px">MARLOG Comms-Hygiene Digest</h1>
    <p style="margin:0 0 16px;color:#4b5563">
      Scanned <strong>${result.scannedUnitCount}</strong> unit${result.scannedUnitCount === 1 ? "" : "s"}.
      Found <strong>${result.invalidEntryCount}</strong> malformed entr${result.invalidEntryCount === 1 ? "y" : "ies"}
      across <strong>${result.flaggedUnitCount}</strong> unit${result.flaggedUnitCount === 1 ? "" : "s"}.
    </p>
    <p style="margin:0 0 16px;color:#4b5563">
      These addresses are silently dropped at email send time, so distros may be missing recipients.
    </p>
    <ul style="list-style:none;padding:0;margin:0">${unitsHtml}</ul>
    <p style="margin:24px 0 0;color:#9aa0a6;font-size:12px">
      Fix from the unit detail page → Edit, or by direct DB cleanup. Replies to this address are not monitored.
    </p>
  </div>
</body></html>`;
}

let cachedTransporter: Transporter | null = null;
function getTransporter(smtp: SmtpConfig): Transporter {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user && smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  return cachedTransporter;
}

export interface CommsHygieneRunResult {
  audited: number;
  flagged: number;
  invalid: number;
  emailSent: boolean;
  outcome: CommsHygieneOutcome;
  /** @deprecated Use `outcome` instead. Kept for log/back-compat. */
  reason?: string;
}

export interface BuiltDigest {
  audited: number;
  flagged: number;
  invalid: number;
  /** True when no entries were flagged and the digest should be suppressed at send time. */
  suppressed: boolean;
  /** Email subject line (always populated, even when suppressed). */
  subject: string;
  /** Plain-text body (always populated, even when suppressed). */
  text: string;
  /** HTML body (always populated, even when suppressed). */
  html: string;
}

/**
 * Build the digest payload that `runCommsHygieneOnce` would dispatch, without
 * sending it. Shared between the scheduled job and the on-demand preview
 * endpoint so both render exactly the same subject/text/html.
 */
export async function buildDigest(): Promise<BuiltDigest> {
  const config = readConfig();
  const result = await runDistroAudit();
  return {
    audited: result.scannedUnitCount,
    flagged: result.flaggedUnitCount,
    invalid: result.invalidEntryCount,
    suppressed: result.flaggedUnitCount === 0,
    subject: buildDigestSubject(result),
    text: buildDigestText(result, config.appBaseUrl),
    html: buildDigestHtml(result, config.appBaseUrl),
  };
}

async function recordRun(args: {
  audited: number;
  flagged: number;
  invalid: number;
  recipients: string[];
  cc: string[];
  outcome: CommsHygieneOutcome;
  errorMessage?: string;
}): Promise<void> {
  try {
    await db.insert(commsHygieneRunsTable).values({
      auditedCount: args.audited,
      flaggedCount: args.flagged,
      invalidCount: args.invalid,
      recipients: args.recipients,
      cc: args.cc,
      outcome: args.outcome,
      errorMessage: args.errorMessage ?? null,
    });
  } catch (err) {
    // Persistence failures should never mask the original send result; the
    // SMTP outcome / log line is still authoritative.
    logger.error({ err }, "Comms-hygiene: failed to persist run record");
  }
}

/**
 * Run the audit once and email the digest if anything is flagged.
 * Suppresses the email when there are no malformed entries. Every invocation
 * is persisted to `comms_hygiene_runs` so planners can confirm a digest
 * actually went out (or see why it didn't) without grepping server logs.
 */
export async function runCommsHygieneOnce(): Promise<CommsHygieneRunResult> {
  const config = readConfig();
  const digest = await buildDigest();

  const summary = {
    audited: digest.audited,
    flagged: digest.flagged,
    invalid: digest.invalid,
  };

  if (digest.suppressed) {
    logger.info(summary, "Comms-hygiene: no malformed distro entries — email suppressed");
    await recordRun({
      ...summary,
      recipients: [],
      cc: [],
      outcome: "skipped_no_flags",
    });
    return { ...summary, emailSent: false, outcome: "skipped_no_flags", reason: "no_flagged_entries" };
  }

  if (config.recipients.length === 0) {
    logger.warn(
      { ...summary },
      "Comms-hygiene: malformed entries found but COMMS_HYGIENE_TO is empty — email skipped",
    );
    await recordRun({
      ...summary,
      recipients: [],
      cc: config.cc,
      outcome: "skipped_no_recipients",
    });
    return { ...summary, emailSent: false, outcome: "skipped_no_recipients", reason: "no_recipients" };
  }

  if (!config.smtp) {
    logger.warn(
      { ...summary, recipients: config.recipients },
      "Comms-hygiene: SMTP not configured — logging digest instead of sending",
    );
    logger.info({ subject: digest.subject, text: digest.text }, "Comms-hygiene: digest preview");
    await recordRun({
      ...summary,
      recipients: config.recipients,
      cc: config.cc,
      outcome: "skipped_no_smtp",
    });
    return { ...summary, emailSent: false, outcome: "skipped_no_smtp", reason: "smtp_not_configured" };
  }

  const transporter = getTransporter(config.smtp);
  try {
    await transporter.sendMail({
      from: config.smtp.from,
      to: config.recipients,
      cc: config.cc.length > 0 ? config.cc : undefined,
      subject: digest.subject,
      text: digest.text,
      html: digest.html,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, ...summary, recipients: config.recipients },
      "Comms-hygiene: digest email send failed",
    );
    await recordRun({
      ...summary,
      recipients: config.recipients,
      cc: config.cc,
      outcome: "failed",
      errorMessage,
    });
    throw err;
  }

  logger.info(
    { ...summary, recipients: config.recipients, cc: config.cc },
    "Comms-hygiene: digest email sent",
  );
  await recordRun({
    ...summary,
    recipients: config.recipients,
    cc: config.cc,
    outcome: "sent",
  });
  return { ...summary, emailSent: true, outcome: "sent" };
}

export interface CommsHygieneRunRecord {
  id: string;
  ranAt: string;
  auditedCount: number;
  flaggedCount: number;
  invalidCount: number;
  recipients: string[];
  cc: string[];
  outcome: CommsHygieneOutcome;
  errorMessage: string | null;
}

function toRecord(row: typeof commsHygieneRunsTable.$inferSelect): CommsHygieneRunRecord {
  return {
    id: row.id,
    ranAt: row.ranAt.toISOString(),
    auditedCount: row.auditedCount,
    flaggedCount: row.flaggedCount,
    invalidCount: row.invalidCount,
    recipients: row.recipients ?? [],
    cc: row.cc ?? [],
    outcome: row.outcome as CommsHygieneOutcome,
    errorMessage: row.errorMessage,
  };
}

/** Most recent run, regardless of outcome. */
export async function getLatestCommsHygieneRun(): Promise<CommsHygieneRunRecord | null> {
  const rows = await db
    .select()
    .from(commsHygieneRunsTable)
    .orderBy(desc(commsHygieneRunsTable.ranAt))
    .limit(1);
  const row = rows[0];
  return row ? toRecord(row) : null;
}

/**
 * Most recent run whose outcome was a successful send. Lets the dashboard
 * surface "last digest actually delivered" separately from "last attempt".
 */
export async function getLatestSuccessfulCommsHygieneSend(): Promise<CommsHygieneRunRecord | null> {
  const rows = await db
    .select()
    .from(commsHygieneRunsTable)
    .orderBy(desc(commsHygieneRunsTable.ranAt))
    .limit(50);
  const sent = rows.find((r) => r.outcome === "sent");
  return sent ? toRecord(sent) : null;
}

export interface CommsHygieneStats {
  /** Total number of `comms_hygiene_runs` rows currently stored. */
  totalRuns: number;
  /** ISO timestamp of the oldest stored run, or `null` when the table is empty. */
  oldestRanAt: string | null;
  /** Effective retention horizon in days (0 means retention is disabled). */
  retentionDays: number;
  /**
   * In-DB override (set via the dashboard); `null` when no override is
   * active and the env-var default is in effect. Surfaced so the footnote
   * can show "180-day default" vs "365-day override active".
   */
  retentionDaysOverride: number | null;
  /** Env-var (or compile-time) default — used when no override is set. */
  retentionDaysDefault: number;
  /**
   * ISO timestamp at which the oldest stored run is expected to age out of
   * the table. `null` when there are no stored runs or retention is disabled.
   * Computed as `oldestRanAt + retentionDays`, matching the prune sweep's
   * cutoff math, so planners can tell at a glance when older entries will
   * silently disappear under the current retention setting.
   */
  oldestExpiresAt: string | null;
  /**
   * Configured "expires soon" warning window in days
   * (`COMMS_HYGIENE_NEAR_EXPIRY_WINDOW_DAYS`, default 7). Echoed back to the
   * dashboard so the per-row pill calculation matches what the server used
   * to compute `nearExpiryCount`. Always 0 when retention is disabled, so
   * the UI doesn't need to special-case the off state.
   */
  nearExpiryWindowDays: number;
  /**
   * Number of stored runs whose projected expiry (`ranAt + retentionDays`)
   * is within `nearExpiryWindowDays` of "now", *including* any rows that
   * have already passed their expiry but have not yet been swept by the
   * daily prune. The footnote uses this to nudge planners to export before
   * the sweep removes them. Always 0 when retention is disabled.
   */
  nearExpiryCount: number;
}

/**
 * Lightweight stats for the dashboard footnote: how many digest runs are on
 * file, when the oldest one was recorded, and when it will fall off under
 * the active retention policy. Surfaces the prune behavior so planners
 * understand nothing important silently disappeared.
 */
export async function getCommsHygieneStats(): Promise<CommsHygieneStats> {
  const settings = await getCommsHygieneSettings();
  const retentionDays = settings.retentionDays;
  // Window is only meaningful when retention is on — when retention is
  // disabled, nothing will ever be pruned, so there is nothing to warn
  // about. Reporting 0 here keeps the FE's special-case logic minimal.
  const nearExpiryWindowDays =
    retentionDays > 0 ? readCommsHygieneNearExpiryWindowDays() : 0;

  const [countRow] = await db
    .select({ value: count() })
    .from(commsHygieneRunsTable);
  const totalRuns = countRow?.value ?? 0;

  if (totalRuns === 0) {
    return {
      totalRuns: 0,
      oldestRanAt: null,
      retentionDays,
      retentionDaysOverride: settings.retentionDaysOverride,
      retentionDaysDefault: settings.retentionDaysDefault,
      oldestExpiresAt: null,
      nearExpiryWindowDays,
      nearExpiryCount: 0,
    };
  }

  const [oldestRow] = await db
    .select({ ranAt: commsHygieneRunsTable.ranAt })
    .from(commsHygieneRunsTable)
    .orderBy(asc(commsHygieneRunsTable.ranAt))
    .limit(1);
  const oldestRanAt = oldestRow ? oldestRow.ranAt : null;

  const oldestExpiresAt =
    oldestRanAt && retentionDays > 0
      ? new Date(
          oldestRanAt.getTime() + retentionDays * 24 * 60 * 60 * 1000,
        ).toISOString()
      : null;

  // Near-expiry: rows whose projected expiry (ranAt + retentionDays) is at
  // or before now+window. Equivalent to ranAt <= now - (retentionDays -
  // window) days. We deliberately include rows that are already past
  // expiry — they survive in the table until the next daily prune sweep
  // and are the most urgent to save off.
  //
  // A non-positive window is treated as "warning disabled" (matching the
  // contract documented on `readCommsHygieneNearExpiryWindowDays`). We
  // skip the count query entirely so the FE / footnote stay silent.
  let nearExpiryCount = 0;
  if (retentionDays > 0 && nearExpiryWindowDays > 0) {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const cutoff = new Date(
      now - (retentionDays - nearExpiryWindowDays) * dayMs,
    );
    // Mirror the prune sweep's lower bound (`ranAt < cutoff` removes the
    // row) so we don't double-count rows that the next sweep will not
    // actually delete. Using lte here means rows scheduled to expire
    // exactly at the boundary are still flagged as "soon".
    const [nearRow] = await db
      .select({ value: count() })
      .from(commsHygieneRunsTable)
      .where(lte(commsHygieneRunsTable.ranAt, cutoff));
    nearExpiryCount = nearRow?.value ?? 0;
  }

  return {
    totalRuns,
    oldestRanAt: oldestRanAt ? oldestRanAt.toISOString() : null,
    retentionDays,
    retentionDaysOverride: settings.retentionDaysOverride,
    retentionDaysDefault: settings.retentionDaysDefault,
    oldestExpiresAt,
    nearExpiryWindowDays,
    nearExpiryCount,
  };
}

export async function listCommsHygieneRuns(limit: number): Promise<CommsHygieneRunRecord[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 200);
  const rows = await db
    .select()
    .from(commsHygieneRunsTable)
    .orderBy(desc(commsHygieneRunsTable.ranAt))
    .limit(safeLimit);
  return rows.map(toRecord);
}

let lastRunAt = 0;

/**
 * Delete `comms_hygiene_runs` rows older than the given retention window.
 * Returns the number of rows removed. A non-positive `retentionDays` is
 * treated as "retention disabled" and is a no-op.
 *
 * When `retentionDays` is omitted, the current effective value is read
 * from the DB-backed settings on every call so dashboard overrides take
 * effect on the next sweep without a server restart.
 */
export async function pruneCommsHygieneRuns(
  retentionDays?: number,
): Promise<number> {
  const effective =
    retentionDays !== undefined
      ? retentionDays
      : await readCommsHygieneRetentionDays();
  if (effective <= 0) return 0;
  const cutoff = new Date(Date.now() - effective * 24 * 60 * 60 * 1000);
  try {
    // Use the driver's rowCount instead of `.returning(...)` so we don't pull
    // every deleted id over the wire when historical sweeps are large.
    const result = await db
      .delete(commsHygieneRunsTable)
      .where(lt(commsHygieneRunsTable.ranAt, cutoff));
    const removed = result.rowCount ?? 0;
    if (removed > 0) {
      logger.info(
        { removed, retentionDays: effective, cutoff: cutoff.toISOString() },
        "Comms-hygiene: pruned old run history",
      );
    }
    return removed;
  } catch (err) {
    logger.error(
      { err, retentionDays: effective },
      "Comms-hygiene: failed to prune old run history",
    );
    return 0;
  }
}

export function startCommsHygieneScheduler(): void {
  const config = readConfig();

  // Retention sweep always runs on a daily cadence regardless of whether
  // the digest scheduler itself is enabled — manual "Send Digest Now" can
  // grow the table even when scheduled sends are turned off. Each tick
  // re-reads the current effective retention so dashboard overrides take
  // effect on the next sweep without a server restart. (When retention is
  // 0 the prune call is a cheap no-op.)
  logger.info(
    "Comms-hygiene retention sweep scheduled (daily, reads override on each tick)",
  );
  setTimeout(() => {
    void pruneCommsHygieneRuns();
  }, 60 * 1000);
  setInterval(() => {
    void pruneCommsHygieneRuns();
  }, PRUNE_INTERVAL_MS);

  if (!config.enabled) {
    logger.info(
      {
        configured: config.recipients.length > 0,
        intervalHours: config.intervalMs / (60 * 60 * 1000),
      },
      "Comms-hygiene scheduler disabled (set COMMS_HYGIENE_ENABLED=true and COMMS_HYGIENE_TO=... to enable)",
    );
    return;
  }

  logger.info(
    {
      intervalHours: config.intervalMs / (60 * 60 * 1000),
      recipients: config.recipients.length,
      smtpConfigured: config.smtp !== null,
    },
    "Comms-hygiene scheduler started",
  );

  const tick = async (): Promise<void> => {
    try {
      const now = Date.now();
      if (now - lastRunAt < config.intervalMs) return;
      lastRunAt = now;
      await runCommsHygieneOnce();
    } catch (err) {
      logger.error({ err }, "Comms-hygiene scheduler tick failed");
    }
  };

  // Fire once shortly after startup so the first digest doesn't have to wait
  // a full cadence interval, then poll on a fixed cadence.
  setTimeout(() => {
    void tick();
  }, 30 * 1000);
  setInterval(() => {
    void tick();
  }, CHECK_INTERVAL_MS);
}
