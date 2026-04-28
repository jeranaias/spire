import { db } from "@workspace/db";
import {
  catalogItemsTable,
  unitsTable,
  supplyEntriesTable,
  resupplyEventsTable,
  activityTable,
  syncStateTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";

const logger = {
  info: (msg: string) => console.log(`[seed] ${msg}`),
  error: (ctx: unknown, msg: string) => console.error(`[seed] ${msg}`, ctx),
};

async function seed(): Promise<void> {
  logger.info("Starting seed...");

  await db.execute(sql`TRUNCATE TABLE supply_entries CASCADE`);
  await db.execute(sql`TRUNCATE TABLE resupply_events CASCADE`);
  await db.execute(sql`TRUNCATE TABLE activity CASCADE`);
  await db.execute(sql`TRUNCATE TABLE units CASCADE`);
  await db.execute(sql`TRUNCATE TABLE catalog_items CASCADE`);
  await db.execute(sql`TRUNCATE TABLE sync_state CASCADE`);

  // Catalog. Base rates are PER MARINE PER DAY at temperate / sustained tempo.
  // Climate / tempo multipliers are applied at calculation time.
  const catalog = await db
    .insert(catalogItemsTable)
    .values([
      // Class I — Subsistence
      {
        supplyClass: "I",
        name: "MRE — Meal, Ready-to-Eat",
        nsn: "8970-01-181-3658",
        unit: "MRE",
        baseDailyRate: 3,
        criticality: "critical",
        notes: "3 MREs/Marine/day baseline. ~3,750 kcal/day.",
      },
      {
        supplyClass: "I",
        name: "Potable Water",
        nsn: "6810-00-577-0094",
        unit: "gal",
        baseDailyRate: 1.5,
        criticality: "critical",
        notes:
          "1.5 gal/Marine/day baseline; +60% in arid climate per planning factors.",
      },
      {
        supplyClass: "I",
        name: "UGR-A Field Ration (T-Ration)",
        nsn: "8970-01-411-9830",
        unit: "meal",
        baseDailyRate: 0.5,
        criticality: "medium",
        notes: "Hot meal supplement, when supportable.",
      },

      // Class III(P) — POL & Power
      {
        supplyClass: "III",
        name: "BA-5590/U Lithium Battery (radio)",
        nsn: "6135-01-036-3495",
        unit: "battery",
        baseDailyRate: 0.5,
        criticality: "critical",
        notes: "PRC-152 / PRC-117. ~10-12hr per battery in continuous use.",
      },
      {
        supplyClass: "III",
        name: "BA-5847/U Battery (NVG / thermal)",
        nsn: "6135-01-447-0949",
        unit: "battery",
        baseDailyRate: 0.25,
        criticality: "high",
        notes: "AN/PVS-14, AN/PEQ-15.",
      },
      {
        supplyClass: "III",
        name: "AA Lithium (general purpose)",
        nsn: "6135-01-351-1131",
        unit: "battery",
        baseDailyRate: 2,
        criticality: "medium",
        notes: "Optics, GPS, IR strobes, etc.",
      },
      {
        supplyClass: "III",
        name: "JP-8 Fuel",
        nsn: "9130-01-031-5816",
        unit: "gal",
        baseDailyRate: 0.4,
        criticality: "high",
        notes: "Per-Marine planning factor for organic vehicles & generators.",
      },

      // Class V — Ammunition
      {
        supplyClass: "V",
        name: "5.56mm Ball, M855 (linked & loose)",
        nsn: "1305-01-269-3211",
        unit: "round",
        baseDailyRate: 30,
        criticality: "high",
        notes: "Per-Marine sustained training rate. Combat scales 5x.",
      },
      {
        supplyClass: "V",
        name: "7.62mm Linked, M80 / M62 (M240)",
        nsn: "1305-00-892-2698",
        unit: "round",
        baseDailyRate: 15,
        criticality: "high",
        notes: "Crew-served distribution.",
      },
      {
        supplyClass: "V",
        name: "40mm HEDP, M433",
        nsn: "1310-01-030-9621",
        unit: "round",
        baseDailyRate: 0.5,
        criticality: "medium",
      },

      // Class VIII — Medical
      {
        supplyClass: "VIII",
        name: "IFAK — Individual First Aid Kit",
        nsn: "6545-01-539-2732",
        unit: "kit",
        baseDailyRate: 0.02,
        criticality: "critical",
        notes: "Replenishment / damaged-kit factor.",
      },
      {
        supplyClass: "VIII",
        name: "CAT — Combat Application Tourniquet",
        nsn: "6515-01-521-7976",
        unit: "ea",
        baseDailyRate: 0.05,
        criticality: "critical",
      },
      {
        supplyClass: "VIII",
        name: "Hemostatic Gauze (Combat Gauze)",
        nsn: "6510-01-562-3325",
        unit: "ea",
        baseDailyRate: 0.05,
        criticality: "high",
      },
      {
        supplyClass: "VIII",
        name: "1L Saline / Hextend",
        nsn: "6505-01-410-5879",
        unit: "bag",
        baseDailyRate: 0.03,
        criticality: "high",
      },

      // Class IX — Repair Parts
      {
        supplyClass: "IX",
        name: "Boot, Combat (Replacement)",
        nsn: "8430-01-516-7484",
        unit: "pr",
        baseDailyRate: 0.005,
        criticality: "low",
      },
      {
        supplyClass: "IX",
        name: "M4 Bolt Carrier Group (spare)",
        nsn: "1005-01-595-1259",
        unit: "ea",
        baseDailyRate: 0.005,
        criticality: "medium",
      },
      {
        supplyClass: "IX",
        name: "Radio Antenna, Whip (replacement)",
        nsn: "5985-01-560-2250",
        unit: "ea",
        baseDailyRate: 0.01,
        criticality: "medium",
      },
    ])
    .returning();

  const itemByName = new Map(catalog.map((c) => [c.name, c]));

  // Units
  const units = await db
    .insert(unitsTable)
    .values([
      {
        name: "1st Plt, Bravo Co, 1/5",
        callsign: "RAIDER 1",
        echelon: "platoon",
        personnel: 42,
        commander: "1stLt Hayes",
        location: "MCAGCC Twentynine Palms",
        climate: "arid",
        opTempo: "high",
        missionDays: 7,
      },
      {
        name: "2nd Sqd, Alpha Co, 2/7",
        callsign: "WARLORD 2-2",
        echelon: "squad",
        personnel: 13,
        commander: "Sgt Aguilar",
        location: "Camp Pendleton, CA",
        climate: "temperate",
        opTempo: "sustained",
        missionDays: 5,
      },
      {
        name: "Weapons Co, 3/8",
        callsign: "BLACKSHEEP 6",
        echelon: "company",
        personnel: 168,
        commander: "Capt Reyes",
        location: "FOB Shughart",
        climate: "tropical",
        opTempo: "combat",
        missionDays: 10,
      },
      {
        name: "Recon Det, 1st RECON Bn",
        callsign: "GHOST 4",
        echelon: "section",
        personnel: 8,
        commander: "GySgt Park",
        location: "Bardufoss, Norway",
        climate: "arctic",
        opTempo: "sustained",
        missionDays: 14,
      },
    ])
    .returning();

  // Supply entries — vary on-hand to produce green / amber / red
  const onHandPlan: Record<
    string,
    { itemName: string; ratio: number }[]
  > = {
    "1st Plt, Bravo Co, 1/5": [
      // Class I water deficient (arid + high tempo)
      { itemName: "Potable Water", ratio: 0.55 },
      { itemName: "MRE — Meal, Ready-to-Eat", ratio: 1.1 },
      { itemName: "BA-5590/U Lithium Battery (radio)", ratio: 0.7 },
      { itemName: "BA-5847/U Battery (NVG / thermal)", ratio: 1.2 },
      { itemName: "AA Lithium (general purpose)", ratio: 1.0 },
      { itemName: "JP-8 Fuel", ratio: 0.9 },
      { itemName: "5.56mm Ball, M855 (linked & loose)", ratio: 1.4 },
      { itemName: "7.62mm Linked, M80 / M62 (M240)", ratio: 1.0 },
      { itemName: "40mm HEDP, M433", ratio: 1.0 },
      { itemName: "IFAK — Individual First Aid Kit", ratio: 1.0 },
      { itemName: "CAT — Combat Application Tourniquet", ratio: 0.8 },
      { itemName: "Hemostatic Gauze (Combat Gauze)", ratio: 1.0 },
      { itemName: "1L Saline / Hextend", ratio: 1.2 },
      { itemName: "M4 Bolt Carrier Group (spare)", ratio: 1.0 },
      { itemName: "Radio Antenna, Whip (replacement)", ratio: 1.0 },
    ],
    "2nd Sqd, Alpha Co, 2/7": [
      { itemName: "Potable Water", ratio: 1.4 },
      { itemName: "MRE — Meal, Ready-to-Eat", ratio: 1.5 },
      { itemName: "BA-5590/U Lithium Battery (radio)", ratio: 1.6 },
      { itemName: "AA Lithium (general purpose)", ratio: 1.5 },
      { itemName: "5.56mm Ball, M855 (linked & loose)", ratio: 2.0 },
      { itemName: "IFAK — Individual First Aid Kit", ratio: 1.2 },
      { itemName: "CAT — Combat Application Tourniquet", ratio: 1.0 },
      { itemName: "Hemostatic Gauze (Combat Gauze)", ratio: 1.0 },
    ],
    "Weapons Co, 3/8": [
      // Combat tempo + tropical: lots of demand
      { itemName: "MRE — Meal, Ready-to-Eat", ratio: 0.8 },
      { itemName: "Potable Water", ratio: 0.7 },
      { itemName: "BA-5590/U Lithium Battery (radio)", ratio: 0.4 }, // RED
      { itemName: "BA-5847/U Battery (NVG / thermal)", ratio: 0.6 },
      { itemName: "AA Lithium (general purpose)", ratio: 0.9 },
      { itemName: "JP-8 Fuel", ratio: 0.85 },
      { itemName: "5.56mm Ball, M855 (linked & loose)", ratio: 0.45 }, // RED
      { itemName: "7.62mm Linked, M80 / M62 (M240)", ratio: 0.6 },
      { itemName: "40mm HEDP, M433", ratio: 0.7 },
      { itemName: "IFAK — Individual First Aid Kit", ratio: 0.9 },
      { itemName: "CAT — Combat Application Tourniquet", ratio: 0.7 },
      { itemName: "Hemostatic Gauze (Combat Gauze)", ratio: 0.6 }, // amber
      { itemName: "1L Saline / Hextend", ratio: 0.5 },
      { itemName: "M4 Bolt Carrier Group (spare)", ratio: 1.0 },
      { itemName: "Radio Antenna, Whip (replacement)", ratio: 1.2 },
    ],
    "Recon Det, 1st RECON Bn": [
      // Arctic + 14 days — batteries are critical
      { itemName: "MRE — Meal, Ready-to-Eat", ratio: 1.1 },
      { itemName: "Potable Water", ratio: 0.9 },
      { itemName: "BA-5590/U Lithium Battery (radio)", ratio: 0.6 }, // arctic = 1.6x
      { itemName: "BA-5847/U Battery (NVG / thermal)", ratio: 0.5 },
      { itemName: "AA Lithium (general purpose)", ratio: 0.8 },
      { itemName: "JP-8 Fuel", ratio: 0.7 },
      { itemName: "5.56mm Ball, M855 (linked & loose)", ratio: 1.0 },
      { itemName: "IFAK — Individual First Aid Kit", ratio: 1.0 },
      { itemName: "CAT — Combat Application Tourniquet", ratio: 1.0 },
    ],
  };

  // climate/tempo multipliers (mirrors logistics.ts) for seeding only
  const climateMul: Record<string, Record<string, number>> = {
    temperate: { I: 1, III: 1, V: 1, VIII: 1, IX: 1 },
    arid: { I: 1.6, III: 1.15, V: 1, VIII: 1.1, IX: 1.05 },
    tropical: { I: 1.25, III: 1.05, V: 1, VIII: 1.2, IX: 1.05 },
    arctic: { I: 1.35, III: 1.6, V: 1, VIII: 1.15, IX: 1.1 },
  };
  const tempoMul: Record<string, Record<string, number>> = {
    garrison: { I: 0.9, III: 0.7, V: 0.1, VIII: 0.5, IX: 0.6 },
    sustained: { I: 1, III: 1, V: 1, VIII: 1, IX: 1 },
    high: { I: 1.1, III: 1.4, V: 2.5, VIII: 1.4, IX: 1.3 },
    combat: { I: 1.15, III: 1.6, V: 5, VIII: 2, IX: 1.6 },
  };

  for (const u of units) {
    const plan = onHandPlan[u.name] ?? [];
    const allRows: { unitId: string; itemId: string; onHand: number }[] = [];
    for (const item of catalog) {
      const found = plan.find((p) => p.itemName === item.name);
      const ratio = found?.ratio ?? 1.0;
      const c = climateMul[u.climate]?.[item.supplyClass] ?? 1;
      const t = tempoMul[u.opTempo]?.[item.supplyClass] ?? 1;
      const required = item.baseDailyRate * c * t * u.personnel * u.missionDays;
      const onHand = Math.round(required * ratio * 100) / 100;
      allRows.push({ unitId: u.id, itemId: item.id, onHand });
    }
    if (allRows.length > 0) {
      await db.insert(supplyEntriesTable).values(allRows);
    }
  }

  // Seed a few resupply events
  const water = itemByName.get("Potable Water")!;
  const battery5590 = itemByName.get("BA-5590/U Lithium Battery (radio)")!;
  const ammo556 = itemByName.get("5.56mm Ball, M855 (linked & loose)")!;

  const raider = units.find((u) => u.callsign === "RAIDER 1")!;
  const blacksheep = units.find((u) => u.callsign === "BLACKSHEEP 6")!;
  const ghost = units.find((u) => u.callsign === "GHOST 4")!;

  const now = new Date();
  await db.insert(resupplyEventsTable).values([
    {
      unitId: raider.id,
      supplyClass: "I",
      itemId: water.id,
      quantity: 200,
      unit: "gal",
      scheduledFor: new Date(now.getTime() + 36 * 60 * 60 * 1000),
      status: "planned",
      assignedTo: "CLB-15 (LCpl Diaz)",
      notes: "Sling-load via CH-53E, LZ Diamond.",
    },
    {
      unitId: blacksheep.id,
      supplyClass: "III",
      itemId: battery5590.id,
      quantity: 120,
      unit: "battery",
      scheduledFor: new Date(now.getTime() + 12 * 60 * 60 * 1000),
      status: "in_transit",
      assignedTo: "CLB-3",
      notes: "Push from FSSG ASP. Comms blackout window 0400-0600L.",
    },
    {
      unitId: blacksheep.id,
      supplyClass: "V",
      itemId: ammo556.id,
      quantity: 12000,
      unit: "round",
      scheduledFor: new Date(now.getTime() + 48 * 60 * 60 * 1000),
      status: "planned",
      assignedTo: "Capt Reyes",
    },
    {
      unitId: ghost.id,
      supplyClass: "III",
      itemId: battery5590.id,
      quantity: 40,
      unit: "battery",
      scheduledFor: new Date(now.getTime() + 72 * 60 * 60 * 1000),
      status: "planned",
      assignedTo: "Norwegian HSV-2",
    },
  ]);

  // Activity feed
  await db.insert(activityTable).values([
    {
      kind: "deficiency_flagged",
      message:
        "BLACKSHEEP 6 flagged: Class III batteries < 2 DOS at combat tempo",
      unitId: blacksheep.id,
      unitName: blacksheep.name,
      timestamp: new Date(now.getTime() - 25 * 60 * 1000),
    },
    {
      kind: "resupply_planned",
      message: "Resupply planned for RAIDER 1: 200 gal of Class I (Water)",
      unitId: raider.id,
      unitName: raider.name,
      timestamp: new Date(now.getTime() - 90 * 60 * 1000),
    },
    {
      kind: "sync_completed",
      message: "Synced with SPIRE — pushed 3, failed 0, catalog delta: +20 new, 0 changed (138ms)",
      timestamp: new Date(now.getTime() - 5 * 60 * 1000),
    },
    {
      kind: "unit_created",
      message: "GHOST 4 (section) created with 8 Marines",
      unitId: ghost.id,
      unitName: ghost.name,
      timestamp: new Date(now.getTime() - 6 * 60 * 60 * 1000),
    },
  ]);

  // Sync state
  await db.insert(syncStateTable).values({
    id: "default",
    upstreamSystem: "SPIRE",
    connected: true,
    lastSyncAt: new Date(now.getTime() - 5 * 60 * 1000),
    pendingChanges: 0,
    latencyMs: 138,
  });

  logger.info("Seed complete.");
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Seed failed");
    process.exit(1);
  });
