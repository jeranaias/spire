import { db, unitsTable } from "@workspace/db";
import { isValidDistroEmail } from "@workspace/distro-email";
import { asc } from "drizzle-orm";

// The same email-shape rule is enforced at save time on the API, in the
// unit edit screen, and when building the schedule mailto: URL — all of
// them go through `@workspace/distro-email`. Reusing `isValidDistroEmail`
// here guarantees this audit surfaces every entry the runtime code would
// silently skip, with no risk of regex drift.

interface BadEntry {
  bucket: "to" | "cc" | "bcc";
  value: string;
}

function findInvalid(
  bucket: BadEntry["bucket"],
  list: string[] | null | undefined,
): BadEntry[] {
  const out: BadEntry[] = [];
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

async function audit(): Promise<void> {
  const units = await db
    .select()
    .from(unitsTable)
    .orderBy(asc(unitsTable.name));

  const flagged: Array<{
    id: string;
    name: string;
    echelon: string;
    invalid: BadEntry[];
  }> = [];

  for (const u of units) {
    const invalid = [
      ...findInvalid("to", u.distroEmails),
      ...findInvalid("cc", u.distroCcEmails),
      ...findInvalid("bcc", u.distroBccEmails),
    ];
    if (invalid.length > 0) {
      flagged.push({ id: u.id, name: u.name, echelon: u.echelon, invalid });
    }
  }

  if (flagged.length === 0) {
    console.log(
      `[audit-distro-emails] Scanned ${units.length} unit${units.length === 1 ? "" : "s"}. ` +
        `No malformed distribution-list addresses found.`,
    );
    return;
  }

  const totalBad = flagged.reduce((acc, f) => acc + f.invalid.length, 0);
  console.log(
    `[audit-distro-emails] Scanned ${units.length} unit${units.length === 1 ? "" : "s"}. ` +
      `Found ${totalBad} malformed entr${totalBad === 1 ? "y" : "ies"} ` +
      `across ${flagged.length} unit${flagged.length === 1 ? "" : "s"}:`,
  );
  console.log("");
  for (const f of flagged) {
    console.log(`  • ${f.name} (${f.echelon})  id=${f.id}`);
    for (const entry of f.invalid) {
      console.log(`      ${entry.bucket.toUpperCase().padEnd(3)}  ${entry.value}`);
    }
  }
  console.log("");
  console.log(
    "Fix from the unit detail page → Edit, or by direct DB cleanup. " +
      "These entries are already silently dropped at email send time.",
  );

  // Non-zero exit so CI / cron wrappers can detect dirty data.
  process.exitCode = 1;
}

audit().catch((err) => {
  console.error("[audit-distro-emails] failed:", err);
  process.exitCode = 2;
});
