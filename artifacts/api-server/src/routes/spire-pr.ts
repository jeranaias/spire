import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  spirePrsTable,
  unitsTable,
  supplyEntriesTable,
  catalogItemsTable,
  prePlannedSchedulesTable,
  resupplyEventsTable,
} from "@workspace/db";
import { eq, isNull, or } from "drizzle-orm";
import {
  createSpirePullRequest,
  getSpireRepoConfig,
  listSpirePrs,
  refreshOpenSpirePrs,
  refreshSpirePrState,
  SpireRepoNotConfiguredError,
  GitHubNotConfiguredError,
  type SpirePrSourceKind,
} from "../lib/spire-pr";
import {
  adjustedDailyRate,
  type Climate,
  type OpTempo,
  type SupplyClass,
} from "../lib/logistics";

const router: IRouter = Router();

const sourceKindEnum = z.enum(["calculator", "schedule", "supply"]);

const createBody = z.object({
  sourceKind: sourceKindEnum,
  sourceId: z.string().min(1).optional(),
  /** Calculator-only scenario inputs. */
  scenario: z
    .object({
      personnel: z.number().int().min(1),
      days: z.number().int().min(1),
      climate: z.enum(["arid", "temperate", "tropical", "arctic"]),
      opTempo: z.enum(["garrison", "sustained", "high", "combat"]),
    })
    .optional(),
  title: z.string().min(1).max(120).optional(),
  summary: z.string().max(4000).optional(),
  createdBy: z.string().max(120).optional(),
});

function mapRow(row: typeof spirePrsTable.$inferSelect) {
  return {
    id: row.id,
    sourceKind: row.sourceKind as SpirePrSourceKind,
    sourceId: row.sourceId,
    sourceLabel: row.sourceLabel,
    repoOwner: row.repoOwner,
    repoName: row.repoName,
    branch: row.branch,
    baseBranch: row.baseBranch,
    filePath: row.filePath,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    title: row.title,
    state: row.state,
    mergedAt: row.mergedAt ? row.mergedAt.toISOString() : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    refreshedAt: row.refreshedAt.toISOString(),
    payloadSummary: row.payloadSummary ?? null,
  };
}

router.get("/spire-pr/config", async (_req, res) => {
  try {
    const cfg = getSpireRepoConfig();
    res.json({
      configured: true,
      owner: cfg.owner,
      name: cfg.name,
      baseBranch: cfg.baseBranch,
    });
  } catch (err) {
    if (err instanceof SpireRepoNotConfiguredError) {
      res.json({
        configured: false,
        owner: null,
        name: null,
        baseBranch: null,
        message: err.message,
      });
      return;
    }
    throw err;
  }
});

router.get("/spire-pr", async (req, res) => {
  const sourceKindRaw = req.query.sourceKind;
  const sourceIdRaw = req.query.sourceId;
  const limitRaw = req.query.limit;
  const refreshRaw = req.query.refresh;

  const parsedKind = sourceKindEnum.safeParse(sourceKindRaw);
  const sourceKind = parsedKind.success ? parsedKind.data : undefined;
  const sourceId = typeof sourceIdRaw === "string" ? sourceIdRaw : undefined;
  const limit =
    typeof limitRaw === "string" ? Number.parseInt(limitRaw, 10) : 50;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;
  const shouldRefresh = refreshRaw === "true" || refreshRaw === "1";

  let rows = await listSpirePrs({ sourceKind, sourceId, limit: safeLimit });
  if (shouldRefresh) {
    try {
      rows = await refreshOpenSpirePrs(rows);
    } catch (err) {
      req.log.warn(
        { err: (err as Error).message },
        "SPIRE PR list: refresh failed, returning cached rows",
      );
    }
  }
  res.json(rows.map(mapRow));
});

router.post("/spire-pr/:id/refresh", async (req, res) => {
  const id = req.params.id;
  const rows = await db
    .select()
    .from(spirePrsTable)
    .where(eq(spirePrsTable.id, id))
    .limit(1);
  if (!rows[0]) {
    res.status(404).json({ error: "NotFound", message: "SPIRE PR not found" });
    return;
  }
  try {
    const refreshed = await refreshSpirePrState(rows[0]);
    res.json(mapRow(refreshed));
  } catch (err) {
    res.status(502).json({
      error: "GitHubError",
      message: (err as Error).message,
    });
  }
});

router.post("/spire-pr", async (req, res) => {
  let body: z.infer<typeof createBody>;
  try {
    body = createBody.parse(req.body);
  } catch (err) {
    res.status(400).json({
      error: "ValidationError",
      issues: (err as z.ZodError).issues,
    });
    return;
  }

  try {
    const built = await buildPayload(body);
    const result = await createSpirePullRequest({
      sourceKind: body.sourceKind,
      sourceId: built.sourceId,
      sourceLabel: built.sourceLabel,
      title: body.title ?? built.defaultTitle,
      summary: body.summary ?? built.defaultSummary,
      payload: built.payload,
      payloadSummary: built.payloadSummary,
      createdBy: body.createdBy ?? null,
    });
    const row = await db
      .select()
      .from(spirePrsTable)
      .where(eq(spirePrsTable.id, result.id))
      .limit(1);
    req.log.info(
      {
        sourceKind: body.sourceKind,
        sourceId: built.sourceId,
        prNumber: result.prNumber,
        prUrl: result.prUrl,
      },
      "SPIRE PR opened",
    );
    res.status(201).json(mapRow(row[0]!));
  } catch (err) {
    if (err instanceof SpireRepoNotConfiguredError) {
      res.status(412).json({
        error: "SpireRepoNotConfigured",
        message: err.message,
      });
      return;
    }
    if (err instanceof GitHubNotConfiguredError) {
      res.status(412).json({
        error: "GitHubNotConfigured",
        message: err.message,
      });
      return;
    }
    if ((err as Error).message?.startsWith("Source not found")) {
      res.status(404).json({
        error: "NotFound",
        message: (err as Error).message,
      });
      return;
    }
    req.log.error({ err: (err as Error).message }, "SPIRE PR create failed");
    res.status(502).json({
      error: "GitHubError",
      message: (err as Error).message ?? "Failed to open SPIRE PR",
    });
  }
});

interface BuiltPayload {
  sourceId: string | null;
  sourceLabel: string;
  defaultTitle: string;
  defaultSummary: string;
  payload: unknown;
  payloadSummary: Record<string, unknown>;
}

async function buildPayload(
  body: z.infer<typeof createBody>,
): Promise<BuiltPayload> {
  if (body.sourceKind === "calculator") {
    return buildCalculatorPayload(body);
  }
  if (body.sourceKind === "supply") {
    return buildSupplyPayload(body);
  }
  return buildSchedulePayload(body);
}

async function buildCalculatorPayload(
  body: z.infer<typeof createBody>,
): Promise<BuiltPayload> {
  if (!body.sourceId) {
    throw new Error("sourceId (unitId) is required for calculator proposals");
  }
  if (!body.scenario) {
    throw new Error("scenario is required for calculator proposals");
  }
  const unitRow = await db
    .select()
    .from(unitsTable)
    .where(eq(unitsTable.id, body.sourceId))
    .limit(1);
  const unit = unitRow[0];
  if (!unit) {
    throw new Error(`Source not found: unit ${body.sourceId}`);
  }
  const items = await db
    .select()
    .from(catalogItemsTable)
    .where(
      or(
        isNull(catalogItemsTable.scopedUnitId),
        eq(catalogItemsTable.scopedUnitId, unit.id),
      ),
    );
  const { personnel, days, climate, opTempo } = body.scenario;
  const lines = items.map((item) => {
    const dailyConsumption = adjustedDailyRate(
      item.baseDailyRate,
      item.supplyClass as SupplyClass,
      climate as Climate,
      opTempo as OpTempo,
      personnel,
    );
    return {
      itemId: item.id,
      itemName: item.name,
      nsn: item.nsn,
      supplyClass: item.supplyClass,
      unit: item.unit,
      dailyConsumption,
      totalRequired: dailyConsumption * days,
    };
  });
  const payload = {
    kind: "calculator-bill",
    generatedAt: new Date().toISOString(),
    unit: { id: unit.id, name: unit.name, echelon: unit.echelon },
    scenario: { personnel, days, climate, opTempo },
    lines,
  };
  return {
    sourceId: unit.id,
    sourceLabel: unit.name,
    defaultTitle: `MARLOG calc: ${unit.name} — ${days}d ${climate}/${opTempo} (${personnel} PAX)`,
    defaultSummary: `Requirements bill for **${unit.name}** under ${days} days, ${climate} climate, ${opTempo} op tempo, ${personnel} PAX. ${lines.length} catalog items priced.`,
    payload,
    payloadSummary: {
      lineCount: lines.length,
      personnel,
      days,
      climate,
      opTempo,
    },
  };
}

async function buildSupplyPayload(
  body: z.infer<typeof createBody>,
): Promise<BuiltPayload> {
  if (!body.sourceId) {
    throw new Error("sourceId (unitId) is required for supply proposals");
  }
  const unitRow = await db
    .select()
    .from(unitsTable)
    .where(eq(unitsTable.id, body.sourceId))
    .limit(1);
  const unit = unitRow[0];
  if (!unit) {
    throw new Error(`Source not found: unit ${body.sourceId}`);
  }
  const rows = await db
    .select({
      entry: supplyEntriesTable,
      item: catalogItemsTable,
    })
    .from(supplyEntriesTable)
    .innerJoin(
      catalogItemsTable,
      eq(supplyEntriesTable.itemId, catalogItemsTable.id),
    )
    .where(eq(supplyEntriesTable.unitId, unit.id));
  const items = rows.map(({ entry, item }) => ({
    itemId: item.id,
    itemName: item.name,
    nsn: item.nsn,
    supplyClass: item.supplyClass,
    unit: item.unit,
    onHand: entry.onHand,
    requiredOverride: entry.requiredOverride,
    baseDailyRate: item.baseDailyRate,
  }));
  const payload = {
    kind: "supply-snapshot",
    generatedAt: new Date().toISOString(),
    unit: {
      id: unit.id,
      name: unit.name,
      echelon: unit.echelon,
      personnel: unit.personnel,
      climate: unit.climate,
      opTempo: unit.opTempo,
    },
    items,
  };
  return {
    sourceId: unit.id,
    sourceLabel: unit.name,
    defaultTitle: `MARLOG supply snapshot: ${unit.name}`,
    defaultSummary: `Current on-hand supply state for **${unit.name}** (${items.length} items, including required-quantity overrides).`,
    payload,
    payloadSummary: { itemCount: items.length },
  };
}

async function buildSchedulePayload(
  body: z.infer<typeof createBody>,
): Promise<BuiltPayload> {
  if (!body.sourceId) {
    throw new Error("sourceId (scheduleId) is required for schedule proposals");
  }
  const scheduleRow = await db
    .select()
    .from(prePlannedSchedulesTable)
    .where(eq(prePlannedSchedulesTable.id, body.sourceId))
    .limit(1);
  const schedule = scheduleRow[0];
  if (!schedule) {
    throw new Error(`Source not found: schedule ${body.sourceId}`);
  }
  const events = await db
    .select({
      ev: resupplyEventsTable,
      itemName: catalogItemsTable.name,
    })
    .from(resupplyEventsTable)
    .leftJoin(
      catalogItemsTable,
      eq(resupplyEventsTable.itemId, catalogItemsTable.id),
    )
    .where(eq(resupplyEventsTable.scheduleId, schedule.id));
  const u = await db
    .select({ name: unitsTable.name })
    .from(unitsTable)
    .where(eq(unitsTable.id, schedule.unitId))
    .limit(1);
  const unitName = u[0]?.name ?? null;
  const payload = {
    kind: "comms-denied-schedule",
    generatedAt: new Date().toISOString(),
    schedule: {
      id: schedule.id,
      label: schedule.label,
      unitId: schedule.unitId,
      unitName,
      horizonDays: schedule.horizonDays,
      publishedAt: schedule.publishedAt
        ? schedule.publishedAt.toISOString()
        : null,
    },
    events: events.map(({ ev, itemName }) => ({
      id: ev.id,
      itemId: ev.itemId,
      itemName,
      supplyClass: ev.supplyClass,
      quantity: ev.quantity,
      unit: ev.unit,
      scheduledFor: ev.scheduledFor
        ? ev.scheduledFor.toISOString()
        : null,
      status: ev.status,
      assignedTo: ev.assignedTo,
      notes: ev.notes,
    })),
  };
  return {
    sourceId: schedule.id,
    sourceLabel: schedule.label,
    defaultTitle: `MARLOG schedule: ${schedule.label}${unitName ? ` (${unitName})` : ""}`,
    defaultSummary: `Pre-coordinated comms-denied schedule **${schedule.label}** with ${events.length} resupply events${unitName ? ` for ${unitName}` : ""}.`,
    payload,
    payloadSummary: { eventCount: events.length, unitName },
  };
}

export default router;
