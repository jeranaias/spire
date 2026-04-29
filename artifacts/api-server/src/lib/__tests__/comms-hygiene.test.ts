import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db, commsHygieneRunsTable } from "@workspace/db";
import { gt } from "drizzle-orm";

// The persistence layer in `recordRun` is the only thing keeping the
// dashboard's "Last digest" line accurate across restarts. It is wrapped
// in a try/catch on purpose (so a DB blip never masks an SMTP send), which
// also means a regression that broke the insert would slip past CI silently.
// These tests pin every outcome path through `runCommsHygieneOnce` to a
// real row in `comms_hygiene_runs`, and assert the read helpers consume
// those rows the way the dashboard expects.

const sendMailMock = vi.fn();

vi.mock("nodemailer", () => {
  const createTransport = vi.fn(() => ({ sendMail: sendMailMock }));
  return {
    default: { createTransport },
    createTransport,
  };
});

const runDistroAuditMock = vi.fn();

vi.mock("../distro-audit", () => ({
  runDistroAudit: () => runDistroAuditMock(),
}));

// Imports *after* the mock declarations so the module under test resolves
// the mocked nodemailer + distro-audit instead of the real ones.
const {
  runCommsHygieneOnce,
  getLatestCommsHygieneRun,
  getLatestSuccessfulCommsHygieneSend,
  listCommsHygieneRuns,
} = await import("../comms-hygiene");
const { closeTestPool } = await import("../../test/db-helpers");

const ENV_KEYS = [
  "COMMS_HYGIENE_TO",
  "COMMS_HYGIENE_CC",
  "COMMS_HYGIENE_FROM",
  "COMMS_HYGIENE_ENABLED",
  "COMMS_HYGIENE_INTERVAL_HOURS",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "SMTP_SECURE",
  "MARLOG_PUBLIC_BASE_URL",
] as const;

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function flaggedAuditResult() {
  return {
    scannedUnitCount: 5,
    flaggedUnitCount: 2,
    invalidEntryCount: 3,
    units: [
      {
        unitId: "unit-a",
        unitName: "TEST_UNIT_A",
        echelon: "company",
        callsign: null,
        invalidEntries: [
          { bucket: "to" as const, value: "not-an-email" },
          { bucket: "cc" as const, value: "still@nope" },
        ],
        invalidCount: 2,
      },
      {
        unitId: "unit-b",
        unitName: "TEST_UNIT_B",
        echelon: "battalion",
        callsign: "BRAVO",
        invalidEntries: [{ bucket: "bcc" as const, value: "garbage" }],
        invalidCount: 1,
      },
    ],
  };
}

function emptyAuditResult() {
  return {
    scannedUnitCount: 5,
    flaggedUnitCount: 0,
    invalidEntryCount: 0,
    units: [],
  };
}

describe("comms-hygiene scheduler persistence", () => {
  let savedEnv: Record<string, string | undefined>;
  let snapshotTime: Date;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    clearEnv();
    sendMailMock.mockReset();
    runDistroAuditMock.mockReset();
    // Snapshot just before the test so cleanup only removes rows we wrote.
    // Subtract a millisecond to absorb clock skew between Node and Postgres.
    snapshotTime = new Date(Date.now() - 1);
  });

  afterEach(async () => {
    await db
      .delete(commsHygieneRunsTable)
      .where(gt(commsHygieneRunsTable.ranAt, snapshotTime));
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("persists a 'skipped_no_flags' row when the audit finds nothing", async () => {
    runDistroAuditMock.mockResolvedValue(emptyAuditResult());
    // Recipients are configured, but no flagged entries should still suppress
    // the email and write a skipped_no_flags row.
    process.env.COMMS_HYGIENE_TO = "ops@example.com";
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_FROM = "noreply@example.test";

    const result = await runCommsHygieneOnce();
    expect(result.outcome).toBe("skipped_no_flags");
    expect(result.emailSent).toBe(false);

    const latest = await getLatestCommsHygieneRun();
    expect(latest).not.toBeNull();
    expect(latest!.outcome).toBe("skipped_no_flags");
    expect(latest!.auditedCount).toBe(5);
    expect(latest!.flaggedCount).toBe(0);
    expect(latest!.invalidCount).toBe(0);
    // We deliberately store empty recipients on this branch — there's no point
    // logging "who would have received it" when the digest itself is empty.
    expect(latest!.recipients).toEqual([]);
    expect(latest!.cc).toEqual([]);
    expect(latest!.errorMessage).toBeNull();
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("persists a 'skipped_no_recipients' row when COMMS_HYGIENE_TO is empty", async () => {
    runDistroAuditMock.mockResolvedValue(flaggedAuditResult());
    // No COMMS_HYGIENE_TO. SMTP host is fine — recipients are checked first.
    process.env.COMMS_HYGIENE_CC = "watch@example.com";
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_FROM = "noreply@example.test";

    const result = await runCommsHygieneOnce();
    expect(result.outcome).toBe("skipped_no_recipients");
    expect(result.emailSent).toBe(false);

    const latest = await getLatestCommsHygieneRun();
    expect(latest!.outcome).toBe("skipped_no_recipients");
    expect(latest!.flaggedCount).toBe(2);
    expect(latest!.invalidCount).toBe(3);
    expect(latest!.recipients).toEqual([]);
    // The CC list is still meaningful — it shows planners who *would* have
    // been informed if a primary recipient were configured.
    expect(latest!.cc).toEqual(["watch@example.com"]);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("persists a 'skipped_no_smtp' row when SMTP env vars are missing", async () => {
    runDistroAuditMock.mockResolvedValue(flaggedAuditResult());
    process.env.COMMS_HYGIENE_TO = "ops@example.com, ops2@example.com";
    process.env.COMMS_HYGIENE_CC = "watch@example.com";
    // No SMTP_HOST / SMTP_FROM => readSmtpConfig() returns null.

    const result = await runCommsHygieneOnce();
    expect(result.outcome).toBe("skipped_no_smtp");
    expect(result.emailSent).toBe(false);

    const latest = await getLatestCommsHygieneRun();
    expect(latest!.outcome).toBe("skipped_no_smtp");
    expect(latest!.recipients).toEqual([
      "ops@example.com",
      "ops2@example.com",
    ]);
    expect(latest!.cc).toEqual(["watch@example.com"]);
    expect(latest!.flaggedCount).toBe(2);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("persists a 'sent' row and dispatches the email when fully configured", async () => {
    runDistroAuditMock.mockResolvedValue(flaggedAuditResult());
    process.env.COMMS_HYGIENE_TO = "ops@example.com";
    process.env.COMMS_HYGIENE_CC = "watch@example.com";
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_FROM = "noreply@example.test";
    process.env.SMTP_PORT = "587";
    sendMailMock.mockResolvedValue({ messageId: "test-msg-1" });

    const result = await runCommsHygieneOnce();
    expect(result.outcome).toBe("sent");
    expect(result.emailSent).toBe(true);

    expect(sendMailMock).toHaveBeenCalledOnce();
    const callArgs = sendMailMock.mock.calls[0]![0];
    expect(callArgs.from).toBe("noreply@example.test");
    expect(callArgs.to).toEqual(["ops@example.com"]);
    expect(callArgs.cc).toEqual(["watch@example.com"]);
    expect(typeof callArgs.subject).toBe("string");
    expect(typeof callArgs.text).toBe("string");
    expect(typeof callArgs.html).toBe("string");

    const latest = await getLatestCommsHygieneRun();
    expect(latest!.outcome).toBe("sent");
    expect(latest!.recipients).toEqual(["ops@example.com"]);
    expect(latest!.cc).toEqual(["watch@example.com"]);
    expect(latest!.auditedCount).toBe(5);
    expect(latest!.flaggedCount).toBe(2);
    expect(latest!.invalidCount).toBe(3);
    expect(latest!.errorMessage).toBeNull();
  });

  it("persists a 'failed' row before re-throwing when the SMTP send fails", async () => {
    // Regression guard: the dashboard must always be able to surface a failed
    // attempt, even though the call propagates the error to the scheduler so
    // operators see it in the logs. If `recordRun` ever moved *after* the
    // throw, this test would catch it.
    runDistroAuditMock.mockResolvedValue(flaggedAuditResult());
    process.env.COMMS_HYGIENE_TO = "ops@example.com";
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_FROM = "noreply@example.test";
    sendMailMock.mockRejectedValue(new Error("ECONNREFUSED upstream"));

    await expect(runCommsHygieneOnce()).rejects.toThrow(
      /ECONNREFUSED upstream/,
    );

    const latest = await getLatestCommsHygieneRun();
    expect(latest).not.toBeNull();
    expect(latest!.outcome).toBe("failed");
    expect(latest!.errorMessage).toContain("ECONNREFUSED upstream");
    expect(latest!.recipients).toEqual(["ops@example.com"]);
    expect(latest!.flaggedCount).toBe(2);
    expect(latest!.invalidCount).toBe(3);
  });

  it("getLatestCommsHygieneRun returns the most recent row regardless of outcome", async () => {
    // First run: skipped_no_flags
    runDistroAuditMock.mockResolvedValue(emptyAuditResult());
    await runCommsHygieneOnce();

    // Tiny pause so the second row's ran_at is strictly greater. PG's now()
    // is microsecond-precise so this is paranoia, but cheap insurance.
    await new Promise((r) => setTimeout(r, 5));

    // Second run: skipped_no_recipients
    runDistroAuditMock.mockResolvedValue(flaggedAuditResult());
    await runCommsHygieneOnce();

    const latest = await getLatestCommsHygieneRun();
    expect(latest!.outcome).toBe("skipped_no_recipients");

    const recent = await listCommsHygieneRuns(10);
    // Ordered desc, so the most recent insert is first.
    expect(recent[0]!.outcome).toBe("skipped_no_recipients");
    expect(
      recent.find((r) => r.outcome === "skipped_no_flags"),
    ).toBeDefined();
  });

  it("getLatestSuccessfulCommsHygieneSend skips non-sent rows", async () => {
    // 1) A failed run.
    runDistroAuditMock.mockResolvedValue(flaggedAuditResult());
    process.env.COMMS_HYGIENE_TO = "ops@example.com";
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_FROM = "noreply@example.test";
    sendMailMock.mockRejectedValueOnce(new Error("first-failure"));
    await expect(runCommsHygieneOnce()).rejects.toThrow();

    await new Promise((r) => setTimeout(r, 5));

    // 2) A successful send — this is the row the helper must surface.
    sendMailMock.mockResolvedValueOnce({ messageId: "ok" });
    const sent = await runCommsHygieneOnce();
    expect(sent.outcome).toBe("sent");
    const sentLatest = await getLatestCommsHygieneRun();
    expect(sentLatest!.outcome).toBe("sent");
    const sentId = sentLatest!.id;

    await new Promise((r) => setTimeout(r, 5));

    // 3) A more-recent non-sent row (skipped). The "latest run" should now
    // be the skipped one, but "latest *successful* send" should still point
    // at the sent row from step 2.
    delete process.env.COMMS_HYGIENE_TO;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_FROM;
    runDistroAuditMock.mockResolvedValue(emptyAuditResult());
    const skipped = await runCommsHygieneOnce();
    expect(skipped.outcome).toBe("skipped_no_flags");

    const latestAny = await getLatestCommsHygieneRun();
    expect(latestAny!.outcome).toBe("skipped_no_flags");

    const latestSent = await getLatestSuccessfulCommsHygieneSend();
    expect(latestSent).not.toBeNull();
    expect(latestSent!.outcome).toBe("sent");
    expect(latestSent!.id).toBe(sentId);
  });
});
