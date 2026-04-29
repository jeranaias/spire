import { db, unitsTable } from "@workspace/db";
import { isValidDistroEmail } from "@workspace/distro-email";
import { asc } from "drizzle-orm";

export type DistroBucket = "to" | "cc" | "bcc";

export interface InvalidDistroEntry {
  bucket: DistroBucket;
  value: string;
}

export interface FlaggedUnit {
  unitId: string;
  unitName: string;
  echelon: string;
  callsign: string | null;
  invalidEntries: InvalidDistroEntry[];
  invalidCount: number;
}

export interface DistroAuditResult {
  scannedUnitCount: number;
  flaggedUnitCount: number;
  invalidEntryCount: number;
  units: FlaggedUnit[];
}

function collectInvalid(
  bucket: DistroBucket,
  list: string[] | null | undefined,
): InvalidDistroEntry[] {
  const out: InvalidDistroEntry[] = [];
  for (const raw of list ?? []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!isValidDistroEmail(trimmed)) {
      out.push({ bucket, value: trimmed });
    }
  }
  return out;
}

/**
 * Scan every unit's distribution-list buckets (to/cc/bcc) for malformed
 * email addresses using the same shape rule enforced by the API save step,
 * the unit-edit form, and the schedule mailto: pipeline. Returns a digest
 * suitable for both the `/dashboard/distro-audit` endpoint and the
 * weekly comms-hygiene email job.
 */
export async function runDistroAudit(): Promise<DistroAuditResult> {
  const units = await db
    .select()
    .from(unitsTable)
    .orderBy(asc(unitsTable.name));

  const flagged: FlaggedUnit[] = [];
  for (const u of units) {
    const invalidEntries = [
      ...collectInvalid("to", u.distroEmails),
      ...collectInvalid("cc", u.distroCcEmails),
      ...collectInvalid("bcc", u.distroBccEmails),
    ];
    if (invalidEntries.length === 0) continue;
    flagged.push({
      unitId: u.id,
      unitName: u.name,
      echelon: u.echelon,
      callsign: u.callsign ?? null,
      invalidEntries,
      invalidCount: invalidEntries.length,
    });
  }

  const invalidEntryCount = flagged.reduce((acc, f) => acc + f.invalidCount, 0);

  return {
    scannedUnitCount: units.length,
    flaggedUnitCount: flagged.length,
    invalidEntryCount,
    units: flagged,
  };
}
