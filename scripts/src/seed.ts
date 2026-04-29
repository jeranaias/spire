import { db } from "@workspace/db";
import {
  catalogItemsTable,
  unitsTable,
  supplyEntriesTable,
  resupplyEventsTable,
  activityTable,
  syncStateTable,
  weaponSystemsTable,
  weaponDodicRatesTable,
  unitWeaponsTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";

const logger = {
  info: (msg: string) => console.log(`[seed] ${msg}`),
  error: (ctx: unknown, msg: string) => console.error(`[seed] ${msg}`, ctx),
};

async function seed(): Promise<void> {
  logger.info("Starting seed...");

  await db.execute(sql`TRUNCATE TABLE unit_weapons CASCADE`);
  await db.execute(sql`TRUNCATE TABLE weapon_dodic_rates CASCADE`);
  await db.execute(sql`TRUNCATE TABLE weapon_systems CASCADE`);
  await db.execute(sql`TRUNCATE TABLE supply_entries CASCADE`);
  await db.execute(sql`TRUNCATE TABLE resupply_events CASCADE`);
  await db.execute(sql`TRUNCATE TABLE activity CASCADE`);
  await db.execute(sql`TRUNCATE TABLE units CASCADE`);
  await db.execute(sql`TRUNCATE TABLE catalog_items CASCADE`);
  await db.execute(sql`TRUNCATE TABLE sync_state CASCADE`);

  // ─── Catalog ────────────────────────────────────────────────────────────────
  // Base rates are PER MARINE PER DAY at temperate / sustained tempo.
  // Class V DODIC items use baseDailyRate = 0 — burn is weapon-driven.
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
        notes: "1.5 gal/Marine/day baseline; +60% in arid climate per planning factors.",
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

      // ─── Class V — Ammunition (DODIC entries, weapon-driven burn) ───────────
      {
        supplyClass: "V",
        name: "A059 — 5.56mm Ball, M855 (30-rd magazine)",
        nsn: "1305-01-269-3211",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "M4/M4A1 Carbine, M27 IAR. Standard 30-round STANAG magazine.",
      },
      {
        supplyClass: "V",
        name: "A064 — 5.56mm Ball, M855A1 (EPR)",
        nsn: "1305-01-571-3838",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "M4A1, M27 IAR. Enhanced Performance Round, steel penetrator.",
      },
      {
        supplyClass: "V",
        name: "A063 — 5.56mm Ball Linked (M249 SAW)",
        nsn: "1305-01-269-3215",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "M249 SAW. Linked 200-round assault pack.",
      },
      {
        supplyClass: "V",
        name: "A131 — 7.62mm Ball M80, Linked (M240)",
        nsn: "1305-00-892-2698",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "M240B/G GPMG. Linked 100/200/250-round cans.",
      },
      {
        supplyClass: "V",
        name: "A556 — .50 Cal M33 Ball, Linked",
        nsn: "1305-00-028-4945",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "M2 .50 Cal HMG. Linked 100-round cans.",
      },
      {
        supplyClass: "V",
        name: "B524 — 40mm HEDP M433",
        nsn: "1310-01-030-9621",
        unit: "round",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "M203 / M320 GLM. High-Explosive Dual-Purpose.",
      },
      {
        supplyClass: "V",
        name: "C787 — 81mm HE, M821",
        nsn: "1320-01-378-7199",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "M252 81mm mortar. High-explosive.",
      },
      {
        supplyClass: "V",
        name: "C889 — 81mm Illum, M853A1",
        nsn: "1320-01-503-5062",
        unit: "round",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "M252 81mm mortar. Illumination.",
      },
      {
        supplyClass: "V",
        name: "D544 — 155mm HE, M107",
        nsn: "1315-00-028-2361",
        unit: "round",
        baseDailyRate: 0,
        criticality: "critical",
        notes: "M777 155mm howitzer. Standard HE projectile.",
      },
      {
        supplyClass: "V",
        name: "D546 — 155mm ICM, M483A1",
        nsn: "1315-00-028-9038",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "M777 155mm howitzer. Improved Conventional Munition.",
      },
      {
        supplyClass: "V",
        name: "D879 — GMLRS M30, HIMARS",
        nsn: "1340-01-517-5599",
        unit: "rocket",
        baseDailyRate: 0,
        criticality: "critical",
        notes: "M142 HIMARS. Guided MLRS rocket. 1 pod = 6 rockets.",
      },
      {
        supplyClass: "V",
        name: "L311 — SMAW Rocket, HEAA",
        nsn: "1340-01-157-7225",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "SMAW. High-Explosive Anti-Armor rocket.",
      },
      {
        supplyClass: "V",
        name: "AA33 — Javelin CTM, FGM-148",
        nsn: "1340-01-399-3564",
        unit: "round",
        baseDailyRate: 0,
        criticality: "critical",
        notes: "Javelin ATGM. Fire-and-forget anti-tank.",
      },

      // More Class V DODICs — pistol, 40mm variants, 60mm mortar, 155mm variants, grenades, AT4
      {
        supplyClass: "V",
        name: "E320 — 9mm Ball M882 (M17/M18 Pistol)",
        nsn: "1305-01-267-3971",
        unit: "round",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "M17/M18 Pistol. 17/21-round magazine.",
      },
      {
        supplyClass: "V",
        name: "B541 — 40mm HE M406 (M203/M320)",
        nsn: "1310-00-752-3997",
        unit: "round",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "M203/M320 GLM. Standard high-explosive grenade.",
      },
      {
        supplyClass: "V",
        name: "B517 — 40mm Smoke M781 (M203/M320)",
        nsn: "1310-00-028-7950",
        unit: "round",
        baseDailyRate: 0,
        criticality: "low",
        notes: "M203/M320 GLM. Smoke/practice round.",
      },
      {
        supplyClass: "V",
        name: "M863 — 40mm GMG HEDP M430 (Mk19)",
        nsn: "1310-01-139-6302",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "Mk19 Grenade Machine Gun. Dual-purpose high-explosive.",
      },
      {
        supplyClass: "V",
        name: "C794 — 60mm HE, M720A1 (M224)",
        nsn: "1320-01-501-7895",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "M224 60mm mortar. High-explosive.",
      },
      {
        supplyClass: "V",
        name: "C795 — 60mm Illum, M721A1 (M224)",
        nsn: "1320-01-013-3588",
        unit: "round",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "M224 60mm mortar. Illumination.",
      },
      {
        supplyClass: "V",
        name: "C797 — 60mm WP, M722 (M224)",
        nsn: "1320-00-174-0765",
        unit: "round",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "M224 60mm mortar. White phosphorus.",
      },
      {
        supplyClass: "V",
        name: "C788 — 81mm WP, M375 (M252)",
        nsn: "1320-00-028-7965",
        unit: "round",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "M252 81mm mortar. White phosphorus.",
      },
      {
        supplyClass: "V",
        name: "D563 — 155mm Illum, M485A1 (M777)",
        nsn: "1315-00-028-5978",
        unit: "round",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "M777 155mm howitzer. Illumination round.",
      },
      {
        supplyClass: "V",
        name: "D569 — 155mm WP, M116A2 (M777)",
        nsn: "1315-00-028-4869",
        unit: "round",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "M777 155mm howitzer. White phosphorus.",
      },
      {
        supplyClass: "V",
        name: "J419 — AT4 HEAT Round (M136)",
        nsn: "1340-01-283-3636",
        unit: "launcher",
        baseDailyRate: 0,
        criticality: "high",
        notes: "M136 AT4. Single-shot 84mm HEAT, disposable.",
      },
      {
        supplyClass: "V",
        name: "E162 — M67 Fragmentation Grenade",
        nsn: "1330-00-028-7921",
        unit: "grenade",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "Standard USMC frag grenade. Issue: 2-4/Marine assault.",
      },
      {
        supplyClass: "V",
        name: "L305 — SMAW Spotting Rocket",
        nsn: "1340-01-157-7115",
        unit: "round",
        baseDailyRate: 0,
        criticality: "low",
        notes: "SMAW. 9mm tracer spotting round (paired with L311).",
      },

      // Aviation ordnance (AH-1Z Viper, UH-1Y support weapons)
      {
        supplyClass: "V",
        name: "L302 — 20mm M940 MPLD Linked (AH-1Z M197)",
        nsn: "1305-01-368-5494",
        unit: "round",
        baseDailyRate: 0,
        criticality: "critical",
        notes: "AH-1Z Viper M197 three-barrel rotary cannon. 750-rd/gun combat load.",
      },
      {
        supplyClass: "V",
        name: "B534 — 2.75in FFAR Mk66 (AH-1Z/UH-1Y)",
        nsn: "1340-00-914-9607",
        unit: "rocket",
        baseDailyRate: 0,
        criticality: "high",
        notes: "70mm folding-fin aerial rocket. 7-rd and 19-rd pods.",
      },
      {
        supplyClass: "V",
        name: "B617 — AGM-114K Hellfire II (AH-1Z)",
        nsn: "1410-01-356-2477",
        unit: "missile",
        baseDailyRate: 0,
        criticality: "critical",
        notes: "AH-1Z. Semi-active laser homing anti-tank missile. 4/LAU-61.",
      },
      {
        supplyClass: "V",
        name: "G981 — AIM-9X Sidewinder (AH-1Z)",
        nsn: "1410-01-460-4086",
        unit: "missile",
        baseDailyRate: 0,
        criticality: "high",
        notes: "AH-1Z. Short-range air-to-air missile. 2/pylon.",
      },

      // 120mm mortar (M120/M327/M252A2 heavy mortar)
      {
        supplyClass: "V",
        name: "C803 — 120mm HE M934A1 (M120)",
        nsn: "1320-01-408-9993",
        unit: "round",
        baseDailyRate: 0,
        criticality: "critical",
        notes: "M120/M327 120mm heavy mortar. High-explosive.",
      },
      {
        supplyClass: "V",
        name: "C804 — 120mm Illum M929A1 (M120)",
        nsn: "1320-01-264-7524",
        unit: "round",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "M120/M327 120mm heavy mortar. Illumination.",
      },
      {
        supplyClass: "V",
        name: "C805 — 120mm WP M929 (M120)",
        nsn: "1320-01-264-7523",
        unit: "round",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "M120/M327 120mm heavy mortar. White phosphorus/smoke.",
      },

      // MANPADS / air defense
      {
        supplyClass: "V",
        name: "AA14 — FIM-92E Stinger RMP Missile (LAAD)",
        nsn: "1410-01-288-1145",
        unit: "missile",
        baseDailyRate: 0,
        criticality: "critical",
        notes: "FIM-92E Stinger. LAAD platoon MANPADS. IR/UV homing.",
      },

      // 155mm Excalibur GPS-guided
      {
        supplyClass: "V",
        name: "D565 — Excalibur M982 GPS-Guided (M777)",
        nsn: "1315-01-564-9999",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "M777. Extended-range GPS/INS precision-guided. ±2m CEP.",
      },

      // Demolition / engineer items (per-marine allocation, baseDailyRate-driven)
      {
        supplyClass: "V",
        name: "J007 — M112 Block Demo Charge (C-4)",
        nsn: "1375-00-277-3684",
        unit: "block",
        baseDailyRate: 0.02,
        criticality: "medium",
        notes: "1.25 lb C-4 block. Engineer/recon use. Per-marine planning factor.",
      },
      {
        supplyClass: "V",
        name: "J111 — M18A1 Claymore Antipersonnel Mine",
        nsn: "1345-00-023-8506",
        unit: "mine",
        baseDailyRate: 0.005,
        criticality: "medium",
        notes: "Directional fragmentation mine. Defensive positions.",
      },
      {
        supplyClass: "V",
        name: "J008 — M700 Detonating Cord (50 ft section)",
        nsn: "1375-00-200-4168",
        unit: "section",
        baseDailyRate: 0.01,
        criticality: "low",
        notes: "PETN detonating cord. Used with block demos and daisy-chain",
      },

      // Hand grenades and signaling (per-marine base rate)
      {
        supplyClass: "V",
        name: "E180 — M18 Smoke Grenade (Colored)",
        nsn: "1330-00-028-7888",
        unit: "grenade",
        baseDailyRate: 0.03,
        criticality: "low",
        notes: "Marking/signaling. Issued per platoon. Red/violet/yellow/green.",
      },
      {
        supplyClass: "V",
        name: "E158 — AN-M8 HC White Smoke Grenade",
        nsn: "1330-00-028-7892",
        unit: "grenade",
        baseDailyRate: 0.02,
        criticality: "low",
        notes: "Screening/obscuration smoke. Per-marine issue.",
      },

      // Small-arms tracers (additional rate rows for existing weapons)
      {
        supplyClass: "V",
        name: "A083 — 5.56mm M856 Tracer (M249/M27)",
        nsn: "1305-01-009-4845",
        unit: "round",
        baseDailyRate: 0,
        criticality: "low",
        notes: "Tracer round for M249 SAW / M27 IAR. 1:4 tracer-to-ball ratio.",
      },
      {
        supplyClass: "V",
        name: "A192 — 7.62mm M62 Tracer Linked (M240)",
        nsn: "1305-00-028-3572",
        unit: "round",
        baseDailyRate: 0,
        criticality: "low",
        notes: "Tracer for M240B/G. Mixed with M80 ball in 4:1 ratio.",
      },
      {
        supplyClass: "V",
        name: "A576 — .50 Cal M17 Tracer Linked (M2)",
        nsn: "1305-00-028-7942",
        unit: "round",
        baseDailyRate: 0,
        criticality: "low",
        notes: "Tracer for M2 .50 cal. Mixed 4:1 with M33 ball.",
      },

      // LAV-25 / 25mm autocannon ammo
      {
        supplyClass: "V",
        name: "A577 — 25mm AP-DS-T M791 (LAV-25)",
        nsn: "1305-01-074-3169",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "LAV-25 / M242 Bushmaster. Armor-piercing discarding sabot-tracer.",
      },
      {
        supplyClass: "V",
        name: "A578 — 25mm HEI-T M792 (LAV-25)",
        nsn: "1305-01-074-3170",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "LAV-25 / M242 Bushmaster. High-explosive incendiary-tracer.",
      },
      {
        supplyClass: "V",
        name: "A579 — 25mm TP-T M793 (LAV-25 Training)",
        nsn: "1305-01-074-3171",
        unit: "round",
        baseDailyRate: 0,
        criticality: "low",
        notes: "LAV-25 / M242 Bushmaster. Target-practice tracer for training.",
      },

      // Fixed-wing aviation ordnance (F-35B / F/A-18 Hornet)
      {
        supplyClass: "V",
        name: "B810 — GBU-12 Paveway II 500lb LGB (F-35B/F-18)",
        nsn: "1325-00-037-2824",
        unit: "bomb",
        baseDailyRate: 0,
        criticality: "critical",
        notes: "Laser-guided 500lb bomb. Primary close-air-support (CAS) ordnance.",
      },
      {
        supplyClass: "V",
        name: "B811 — GBU-32 JDAM 1000lb (F-35B/F-18)",
        nsn: "1325-01-494-2018",
        unit: "bomb",
        baseDailyRate: 0,
        criticality: "critical",
        notes: "1000lb GPS/INS-guided joint direct-attack munition.",
      },
      {
        supplyClass: "V",
        name: "B950 — GBU-31 JDAM 2000lb (F-35B/F-18)",
        nsn: "1325-01-383-1036",
        unit: "bomb",
        baseDailyRate: 0,
        criticality: "high",
        notes: "2000lb GPS/INS JDAM. General-purpose air-to-ground strike.",
      },
      {
        supplyClass: "V",
        name: "B815 — GBU-39 Small Diameter Bomb (SDB) (F-35B)",
        nsn: "1325-01-538-3388",
        unit: "bomb",
        baseDailyRate: 0,
        criticality: "high",
        notes: "250lb glide bomb. 4 per carriage, 90km stand-off range.",
      },
      {
        supplyClass: "V",
        name: "B850 — AIM-120C AMRAAM (F-35B/F-18)",
        nsn: "1410-01-228-5422",
        unit: "missile",
        baseDailyRate: 0,
        criticality: "critical",
        notes: "Advanced medium-range air-to-air missile. BVR capability.",
      },
      {
        supplyClass: "V",
        name: "B820 — AIM-9X Sidewinder (Fixed Wing)",
        nsn: "1410-01-470-9698",
        unit: "missile",
        baseDailyRate: 0,
        criticality: "high",
        notes: "Short-range IR air-to-air missile for F-35B/F-18.",
      },
      {
        supplyClass: "V",
        name: "B912 — AGM-65E Maverick Laser (F/A-18)",
        nsn: "1410-01-271-8977",
        unit: "missile",
        baseDailyRate: 0,
        criticality: "high",
        notes: "Laser-guided air-to-ground missile. CAS against armored targets.",
      },

      // Carl Gustaf M3E1 (84mm recoilless rifle)
      {
        supplyClass: "V",
        name: "K004 — 84mm HEAT M3 (Carl Gustaf M3E1)",
        nsn: "1340-01-668-3113",
        unit: "round",
        baseDailyRate: 0,
        criticality: "critical",
        notes: "Carl Gustaf 84mm recoilless rifle. High-explosive anti-tank.",
      },
      {
        supplyClass: "V",
        name: "K007 — 84mm HE 441C (Carl Gustaf M3E1)",
        nsn: "1340-01-668-3115",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "Carl Gustaf 84mm. High-explosive general-purpose round.",
      },
      {
        supplyClass: "V",
        name: "K008 — 84mm HEDP 502 (Carl Gustaf M3E1)",
        nsn: "1340-01-668-3116",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "Carl Gustaf 84mm. High-explosive dual purpose (anti-armor/anti-personnel).",
      },
      {
        supplyClass: "V",
        name: "K009 — 84mm Smoke M104 (Carl Gustaf M3E1)",
        nsn: "1340-01-668-3117",
        unit: "round",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "Carl Gustaf 84mm. Smoke/screening round.",
      },

      // M110 SASS / Sniper / DMR ammunition
      {
        supplyClass: "V",
        name: "A193 — 7.62mm M118LR Long Range Match (M110/M24)",
        nsn: "1305-01-387-7528",
        unit: "round",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "175gr Sierra BTHP. Sniper and SDM-R long-range match ammo.",
      },
      {
        supplyClass: "V",
        name: "A196 — .300 Win Mag Mk248 Mod 1 (M40A6)",
        nsn: "1305-01-574-5011",
        unit: "round",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "220gr BTHP long-range sniper round for M40A6 rifle.",
      },

      // Additional 155mm (M777) variants
      {
        supplyClass: "V",
        name: "D541 — 155mm RAP M549A1 (M777)",
        nsn: "1315-00-028-5979",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "Rocket-assisted 155mm projectile. Extends range to ~30km.",
      },
      {
        supplyClass: "V",
        name: "D542 — 155mm DPICM M864 (M777)",
        nsn: "1315-00-028-5980",
        unit: "round",
        baseDailyRate: 0,
        criticality: "high",
        notes: "Dual-purpose improved conventional munition. Area fire against soft targets.",
      },

      // Additional HIMARS
      {
        supplyClass: "V",
        name: "D881 — ATACMS M39A1 (HIMARS)",
        nsn: "1340-01-436-3891",
        unit: "missile",
        baseDailyRate: 0,
        criticality: "critical",
        notes: "Army Tactical Missile System. Range >300km. 1 per pod (single-shot).",
      },
      {
        supplyClass: "V",
        name: "D882 — GMLRS-ER M31A2 Extended Range (HIMARS)",
        nsn: "1340-01-622-4211",
        unit: "rocket",
        baseDailyRate: 0,
        criticality: "high",
        notes: "Guided MLRS Extended Range up to 150km. 6/pod.",
      },

      // Additional infantry rockets & anti-armor
      {
        supplyClass: "V",
        name: "K002 — M72A7 LAW 66mm HEAT",
        nsn: "1340-01-564-5559",
        unit: "launcher",
        baseDailyRate: 0,
        criticality: "medium",
        notes: "Lightweight anti-armor weapon. Disposable 66mm HEAT rocket. Infantry issue.",
      },
      {
        supplyClass: "V",
        name: "L390 — SMAW-D M141 Bunker Defeat Munition",
        nsn: "1340-01-457-1230",
        unit: "launcher",
        baseDailyRate: 0,
        criticality: "high",
        notes: "Thermobaric warhead for SMAW. Bunker/cave defeat. Single-shot disposable.",
      },

      // Shotgun (M1014 Benelli)
      {
        supplyClass: "V",
        name: "A100 — 12ga M162 00 Buck (M1014)",
        nsn: "1305-01-445-3010",
        unit: "round",
        baseDailyRate: 0,
        criticality: "low",
        notes: "M1014 Benelli combat shotgun. 00 buckshot for entry operations.",
      },
      {
        supplyClass: "V",
        name: "A102 — 12ga M257 Breaching Round (M1014)",
        nsn: "1305-01-491-2775",
        unit: "round",
        baseDailyRate: 0,
        criticality: "low",
        notes: "M1014. Lock/hinge breaching slug. Breaching teams.",
      },

      // Pyrotechnics / signaling
      {
        supplyClass: "V",
        name: "E165 — M34 WP White Phosphorus Grenade",
        nsn: "1330-00-028-9308",
        unit: "grenade",
        baseDailyRate: 0.005,
        criticality: "medium",
        notes: "Smoke/incendiary WP grenade. Screening and incendiary use.",
      },
      {
        supplyClass: "V",
        name: "E163 — M14 TH3 Thermite Incendiary Grenade",
        nsn: "1330-00-028-9373",
        unit: "grenade",
        baseDailyRate: 0.002,
        criticality: "medium",
        notes: "Thermite incendiary. Destroy equipment/materiel.",
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

  const byDodic = (code: string) => {
    const entry = catalog.find((c) => c.name.startsWith(code + " —"));
    if (!entry) throw new Error(`DODIC ${code} not found in catalog`);
    return entry;
  };

  // ─── Weapon Systems ──────────────────────────────────────────────────────────
  logger.info("Seeding weapon systems...");

  const weaponDefs = await db
    .insert(weaponSystemsTable)
    .values([
      { tamcn: "A0099", name: "M4/M4A1 Carbine",     isGce: true,  notes: "Standard individual weapon" },
      { tamcn: "A0100", name: "M27 IAR",              isGce: true,  notes: "Infantry Automatic Rifle; replaces M249 in rifle squads" },
      { tamcn: "A0087", name: "M249 SAW",             isGce: true,  notes: "Squad Automatic Weapon, 5.56mm" },
      { tamcn: "A0106", name: "M240B/G GPMG",         isGce: true,  notes: "7.62mm General Purpose Machine Gun" },
      { tamcn: "A0111", name: "M2 .50 Cal HMG",       isGce: true,  notes: "Heavy Machine Gun, vehicle/tripod mounted" },
      { tamcn: "A0094", name: "M203 / M320 GLM",      isGce: true,  notes: "40mm Grenade Launcher Underslung / standalone" },
      { tamcn: "A0120", name: "SMAW",                 isGce: true,  notes: "Shoulder-Launched Multipurpose Assault Weapon" },
      { tamcn: "A0125", name: "Javelin (FGM-148)",    isGce: true,  notes: "Man-portable anti-tank guided missile" },
      { tamcn: "A0115", name: "M252 81mm Mortar",     isGce: true,  notes: "Medium mortar, indirect fire" },
      { tamcn: "B0040", name: "M777 155mm Howitzer",  isGce: false, notes: "Lightweight towed howitzer, artillery" },
      { tamcn: "B0050", name: "M142 HIMARS",          isGce: false, notes: "High Mobility Artillery Rocket System" },
      // Additional weapon systems for expanded DODIC coverage
      { tamcn: "A0102", name: "M17/M18 Pistol",        isGce: true,  notes: "SIG Sauer P320. Standard sidearm, NCOs and above." },
      { tamcn: "A0130", name: "Mk19 GMG (40mm)",        isGce: true,  notes: "Mk19 Mod 3 Grenade Machine Gun. Vehicle/tripod." },
      { tamcn: "A0110", name: "M224 60mm Mortar",       isGce: true,  notes: "Lightweight company mortar, direct/indirect fire." },
      { tamcn: "A0126", name: "AT4 Launcher (M136)",    isGce: true,  notes: "84mm single-shot HEAT, disposable. Anti-armor." },
      // Aviation and specialized systems
      { tamcn: "B0010", name: "AH-1Z Viper",            isGce: false, notes: "Attack helicopter. 20mm M197, 2.75in FFARs, Hellfire, AIM-9X." },
      { tamcn: "A0118", name: "M120 120mm Mortar",      isGce: true,  notes: "Battalion heavy mortar. Direct/indirect fire." },
      { tamcn: "C0010", name: "FIM-92 Stinger MANPADS", isGce: false, notes: "LAAD platoon. Man-portable IR-homing SAM." },
      // New: LAV-25, Carl Gustaf, F-35B
      { tamcn: "B0020", name: "LAV-25",                    isGce: false, notes: "Light Armored Vehicle. M242 Bushmaster 25mm autocannon." },
      { tamcn: "A0128", name: "Carl Gustaf M3E1 (84mm)",   isGce: true,  notes: "Recoilless rifle. Multi-role anti-armor/bunker defeat." },
      { tamcn: "B0005", name: "F-35B Lightning II",        isGce: false, notes: "STOVL fighter-attack. GBU-12/31/32/39, AMRAAM, AIM-9X." },
    ])
    .returning();

  const wByName = new Map(weaponDefs.map((w) => [w.name, w]));

  // ─── Weapon-DODIC Rate Rows ──────────────────────────────────────────────────
  // Per-weapon rates: combat_load = initial issue qty (total), assault/sustain = per-day
  // GCE rates assume direct contact; Non-GCE rates are ~60% of GCE for non-contact units
  logger.info("Seeding weapon DODIC rates...");

  await db.insert(weaponDodicRatesTable).values([
    // ── M4/M4A1 Carbine (A059) ────────────────────────────────────────────────
    {
      weaponSystemId: wByName.get("M4/M4A1 Carbine")!.id,
      catalogItemId: byDodic("A059").id, dodic: "A059",
      gceCombatLoad: 840,   gceAssaultRate: 210,  gceSustainRate: 60,
      nonGceCombatLoad: 540, nonGceAssaultRate: 120, nonGceSustainRate: 40,
    },

    // ── M27 IAR (A059 + A064) ─────────────────────────────────────────────────
    {
      weaponSystemId: wByName.get("M27 IAR")!.id,
      catalogItemId: byDodic("A059").id, dodic: "A059",
      gceCombatLoad: 840,   gceAssaultRate: 360,  gceSustainRate: 120,
      nonGceCombatLoad: 540, nonGceAssaultRate: 180, nonGceSustainRate: 60,
    },
    {
      weaponSystemId: wByName.get("M27 IAR")!.id,
      catalogItemId: byDodic("A064").id, dodic: "A064",
      gceCombatLoad: 360,   gceAssaultRate: 120,  gceSustainRate: 60,
      nonGceCombatLoad: 240, nonGceAssaultRate: 60, nonGceSustainRate: 30,
    },

    // ── M249 SAW (A063) ───────────────────────────────────────────────────────
    {
      weaponSystemId: wByName.get("M249 SAW")!.id,
      catalogItemId: byDodic("A063").id, dodic: "A063",
      gceCombatLoad: 1000,  gceAssaultRate: 400,  gceSustainRate: 150,
      nonGceCombatLoad: 600, nonGceAssaultRate: 200, nonGceSustainRate: 80,
    },

    // ── M240B/G GPMG (A131) ───────────────────────────────────────────────────
    {
      weaponSystemId: wByName.get("M240B/G GPMG")!.id,
      catalogItemId: byDodic("A131").id, dodic: "A131",
      gceCombatLoad: 1200,  gceAssaultRate: 600,  gceSustainRate: 200,
      nonGceCombatLoad: 800, nonGceAssaultRate: 300, nonGceSustainRate: 100,
    },

    // ── M2 .50 Cal HMG (A556) ─────────────────────────────────────────────────
    {
      weaponSystemId: wByName.get("M2 .50 Cal HMG")!.id,
      catalogItemId: byDodic("A556").id, dodic: "A556",
      gceCombatLoad: 1000,  gceAssaultRate: 500,  gceSustainRate: 100,
      nonGceCombatLoad: 600, nonGceAssaultRate: 200, nonGceSustainRate: 60,
    },

    // ── M203 / M320 GLM (B524) ────────────────────────────────────────────────
    {
      weaponSystemId: wByName.get("M203 / M320 GLM")!.id,
      catalogItemId: byDodic("B524").id, dodic: "B524",
      gceCombatLoad: 36,    gceAssaultRate: 12,   gceSustainRate: 4,
      nonGceCombatLoad: 24,  nonGceAssaultRate: 6,  nonGceSustainRate: 2,
    },

    // ── SMAW (L311) ───────────────────────────────────────────────────────────
    {
      weaponSystemId: wByName.get("SMAW")!.id,
      catalogItemId: byDodic("L311").id, dodic: "L311",
      gceCombatLoad: 6,     gceAssaultRate: 4,    gceSustainRate: 2,
      nonGceCombatLoad: 4,   nonGceAssaultRate: 2,  nonGceSustainRate: 1,
    },

    // ── Javelin (AA33) ────────────────────────────────────────────────────────
    {
      weaponSystemId: wByName.get("Javelin (FGM-148)")!.id,
      catalogItemId: byDodic("AA33").id, dodic: "AA33",
      gceCombatLoad: 2,     gceAssaultRate: 1,    gceSustainRate: 0.5,
      nonGceCombatLoad: 2,   nonGceAssaultRate: 0.5, nonGceSustainRate: 0.25,
    },

    // ── M252 81mm Mortar (C787 + C889) ────────────────────────────────────────
    {
      weaponSystemId: wByName.get("M252 81mm Mortar")!.id,
      catalogItemId: byDodic("C787").id, dodic: "C787",
      gceCombatLoad: 72,    gceAssaultRate: 36,   gceSustainRate: 12,
      nonGceCombatLoad: 48,  nonGceAssaultRate: 18, nonGceSustainRate: 6,
    },
    {
      weaponSystemId: wByName.get("M252 81mm Mortar")!.id,
      catalogItemId: byDodic("C889").id, dodic: "C889",
      gceCombatLoad: 24,    gceAssaultRate: 8,    gceSustainRate: 4,
      nonGceCombatLoad: 16,  nonGceAssaultRate: 4,  nonGceSustainRate: 2,
    },

    // ── M777 155mm Howitzer (D544 + D546) ─────────────────────────────────────
    {
      weaponSystemId: wByName.get("M777 155mm Howitzer")!.id,
      catalogItemId: byDodic("D544").id, dodic: "D544",
      gceCombatLoad: 120,   gceAssaultRate: 80,   gceSustainRate: 24,
      nonGceCombatLoad: 120, nonGceAssaultRate: 80, nonGceSustainRate: 24,
    },
    {
      weaponSystemId: wByName.get("M777 155mm Howitzer")!.id,
      catalogItemId: byDodic("D546").id, dodic: "D546",
      gceCombatLoad: 24,    gceAssaultRate: 16,   gceSustainRate: 6,
      nonGceCombatLoad: 24,  nonGceAssaultRate: 16, nonGceSustainRate: 6,
    },

    // ── M142 HIMARS (D879) ────────────────────────────────────────────────────
    {
      weaponSystemId: wByName.get("M142 HIMARS")!.id,
      catalogItemId: byDodic("D879").id, dodic: "D879",
      gceCombatLoad: 6,     gceAssaultRate: 6,    gceSustainRate: 2,
      nonGceCombatLoad: 6,   nonGceAssaultRate: 6,  nonGceSustainRate: 2,
    },

    // ── M17/M18 Pistol (E320) ─────────────────────────────────────────────
    {
      weaponSystemId: wByName.get("M17/M18 Pistol")!.id,
      catalogItemId: byDodic("E320").id, dodic: "E320",
      gceCombatLoad: 51,    gceAssaultRate: 17,   gceSustainRate: 5,
      nonGceCombatLoad: 34,  nonGceAssaultRate: 8,  nonGceSustainRate: 3,
    },

    // ── M203 / M320 GLM — additional (B541 HE + B517 Smoke) ──────────────
    {
      weaponSystemId: wByName.get("M203 / M320 GLM")!.id,
      catalogItemId: byDodic("B541").id, dodic: "B541",
      gceCombatLoad: 18,    gceAssaultRate: 6,    gceSustainRate: 2,
      nonGceCombatLoad: 12,  nonGceAssaultRate: 3,  nonGceSustainRate: 1,
    },
    {
      weaponSystemId: wByName.get("M203 / M320 GLM")!.id,
      catalogItemId: byDodic("B517").id, dodic: "B517",
      gceCombatLoad: 6,     gceAssaultRate: 2,    gceSustainRate: 1,
      nonGceCombatLoad: 4,   nonGceAssaultRate: 1,  nonGceSustainRate: 0.5,
    },

    // ── Mk19 GMG (M863) ───────────────────────────────────────────────────
    {
      weaponSystemId: wByName.get("Mk19 GMG (40mm)")!.id,
      catalogItemId: byDodic("M863").id, dodic: "M863",
      gceCombatLoad: 420,   gceAssaultRate: 200,  gceSustainRate: 60,
      nonGceCombatLoad: 280, nonGceAssaultRate: 100, nonGceSustainRate: 40,
    },

    // ── M224 60mm Mortar (C794 HE + C795 Illum + C797 WP) ────────────────
    {
      weaponSystemId: wByName.get("M224 60mm Mortar")!.id,
      catalogItemId: byDodic("C794").id, dodic: "C794",
      gceCombatLoad: 36,    gceAssaultRate: 24,   gceSustainRate: 8,
      nonGceCombatLoad: 24,  nonGceAssaultRate: 12, nonGceSustainRate: 4,
    },
    {
      weaponSystemId: wByName.get("M224 60mm Mortar")!.id,
      catalogItemId: byDodic("C795").id, dodic: "C795",
      gceCombatLoad: 12,    gceAssaultRate: 4,    gceSustainRate: 2,
      nonGceCombatLoad: 8,   nonGceAssaultRate: 2,  nonGceSustainRate: 1,
    },
    {
      weaponSystemId: wByName.get("M224 60mm Mortar")!.id,
      catalogItemId: byDodic("C797").id, dodic: "C797",
      gceCombatLoad: 6,     gceAssaultRate: 2,    gceSustainRate: 1,
      nonGceCombatLoad: 4,   nonGceAssaultRate: 1,  nonGceSustainRate: 0.5,
    },

    // ── M252 81mm Mortar — additional WP (C788) ───────────────────────────
    {
      weaponSystemId: wByName.get("M252 81mm Mortar")!.id,
      catalogItemId: byDodic("C788").id, dodic: "C788",
      gceCombatLoad: 12,    gceAssaultRate: 4,    gceSustainRate: 2,
      nonGceCombatLoad: 8,   nonGceAssaultRate: 2,  nonGceSustainRate: 1,
    },

    // ── M777 155mm Howitzer — additional Illum (D563) + WP (D569) ─────────
    {
      weaponSystemId: wByName.get("M777 155mm Howitzer")!.id,
      catalogItemId: byDodic("D563").id, dodic: "D563",
      gceCombatLoad: 24,    gceAssaultRate: 8,    gceSustainRate: 4,
      nonGceCombatLoad: 24,  nonGceAssaultRate: 8,  nonGceSustainRate: 4,
    },
    {
      weaponSystemId: wByName.get("M777 155mm Howitzer")!.id,
      catalogItemId: byDodic("D569").id, dodic: "D569",
      gceCombatLoad: 12,    gceAssaultRate: 4,    gceSustainRate: 2,
      nonGceCombatLoad: 12,  nonGceAssaultRate: 4,  nonGceSustainRate: 2,
    },

    // ── SMAW — spotting rocket (L305) ─────────────────────────────────────
    {
      weaponSystemId: wByName.get("SMAW")!.id,
      catalogItemId: byDodic("L305").id, dodic: "L305",
      gceCombatLoad: 9,     gceAssaultRate: 6,    gceSustainRate: 2,
      nonGceCombatLoad: 6,   nonGceAssaultRate: 3,  nonGceSustainRate: 1,
    },

    // ── AT4 Launcher (J419) ───────────────────────────────────────────────
    {
      weaponSystemId: wByName.get("AT4 Launcher (M136)")!.id,
      catalogItemId: byDodic("J419").id, dodic: "J419",
      gceCombatLoad: 2,     gceAssaultRate: 1,    gceSustainRate: 0.5,
      nonGceCombatLoad: 2,   nonGceAssaultRate: 0.5, nonGceSustainRate: 0.25,
    },

    // ── AH-1Z Viper (L302 20mm + B534 FFAR + B617 Hellfire + G981 AIM-9X) ──
    {
      weaponSystemId: wByName.get("AH-1Z Viper")!.id,
      catalogItemId: byDodic("L302").id, dodic: "L302",
      gceCombatLoad: 750,   gceAssaultRate: 500,  gceSustainRate: 150,
      nonGceCombatLoad: 750, nonGceAssaultRate: 500, nonGceSustainRate: 150,
    },
    {
      weaponSystemId: wByName.get("AH-1Z Viper")!.id,
      catalogItemId: byDodic("B534").id, dodic: "B534",
      gceCombatLoad: 76,    gceAssaultRate: 38,   gceSustainRate: 10,
      nonGceCombatLoad: 76,  nonGceAssaultRate: 38, nonGceSustainRate: 10,
    },
    {
      weaponSystemId: wByName.get("AH-1Z Viper")!.id,
      catalogItemId: byDodic("B617").id, dodic: "B617",
      gceCombatLoad: 8,     gceAssaultRate: 4,    gceSustainRate: 1,
      nonGceCombatLoad: 8,   nonGceAssaultRate: 4,  nonGceSustainRate: 1,
    },
    {
      weaponSystemId: wByName.get("AH-1Z Viper")!.id,
      catalogItemId: byDodic("G981").id, dodic: "G981",
      gceCombatLoad: 2,     gceAssaultRate: 1,    gceSustainRate: 0.25,
      nonGceCombatLoad: 2,   nonGceAssaultRate: 1,  nonGceSustainRate: 0.25,
    },

    // ── M120 120mm Mortar (C803 HE + C804 Illum + C805 WP) ───────────────
    {
      weaponSystemId: wByName.get("M120 120mm Mortar")!.id,
      catalogItemId: byDodic("C803").id, dodic: "C803",
      gceCombatLoad: 120,   gceAssaultRate: 60,   gceSustainRate: 20,
      nonGceCombatLoad: 80,  nonGceAssaultRate: 30, nonGceSustainRate: 10,
    },
    {
      weaponSystemId: wByName.get("M120 120mm Mortar")!.id,
      catalogItemId: byDodic("C804").id, dodic: "C804",
      gceCombatLoad: 24,    gceAssaultRate: 8,    gceSustainRate: 4,
      nonGceCombatLoad: 16,  nonGceAssaultRate: 4,  nonGceSustainRate: 2,
    },
    {
      weaponSystemId: wByName.get("M120 120mm Mortar")!.id,
      catalogItemId: byDodic("C805").id, dodic: "C805",
      gceCombatLoad: 12,    gceAssaultRate: 4,    gceSustainRate: 2,
      nonGceCombatLoad: 8,   nonGceAssaultRate: 2,  nonGceSustainRate: 1,
    },

    // ── FIM-92 Stinger MANPADS (AA14) ─────────────────────────────────────
    {
      weaponSystemId: wByName.get("FIM-92 Stinger MANPADS")!.id,
      catalogItemId: byDodic("AA14").id, dodic: "AA14",
      gceCombatLoad: 4,     gceAssaultRate: 2,    gceSustainRate: 1,
      nonGceCombatLoad: 4,   nonGceAssaultRate: 2,  nonGceSustainRate: 1,
    },

    // ── M777 155mm — Excalibur GPS-guided (D565) ──────────────────────────
    {
      weaponSystemId: wByName.get("M777 155mm Howitzer")!.id,
      catalogItemId: byDodic("D565").id, dodic: "D565",
      gceCombatLoad: 12,    gceAssaultRate: 4,    gceSustainRate: 2,
      nonGceCombatLoad: 12,  nonGceAssaultRate: 4,  nonGceSustainRate: 2,
    },

    // ── M249 SAW — tracer (A083) ───────────────────────────────────────────
    {
      weaponSystemId: wByName.get("M249 SAW")!.id,
      catalogItemId: byDodic("A083").id, dodic: "A083",
      gceCombatLoad: 200,   gceAssaultRate: 80,   gceSustainRate: 30,
      nonGceCombatLoad: 120, nonGceAssaultRate: 40, nonGceSustainRate: 15,
    },

    // ── M240B/G GPMG — tracer (A192) ──────────────────────────────────────
    {
      weaponSystemId: wByName.get("M240B/G GPMG")!.id,
      catalogItemId: byDodic("A192").id, dodic: "A192",
      gceCombatLoad: 250,   gceAssaultRate: 120,  gceSustainRate: 40,
      nonGceCombatLoad: 160, nonGceAssaultRate: 60, nonGceSustainRate: 20,
    },

    // ── M2 .50 Cal HMG — tracer (A576) ────────────────────────────────────
    {
      weaponSystemId: wByName.get("M2 .50 Cal HMG")!.id,
      catalogItemId: byDodic("A576").id, dodic: "A576",
      gceCombatLoad: 200,   gceAssaultRate: 100,  gceSustainRate: 20,
      nonGceCombatLoad: 120, nonGceAssaultRate: 40, nonGceSustainRate: 12,
    },

    // ── LAV-25 (A577 AP-DS-T + A578 HEI-T) ────────────────────────────────
    {
      weaponSystemId: wByName.get("LAV-25")!.id,
      catalogItemId: byDodic("A577").id, dodic: "A577",
      gceCombatLoad: 420,   gceAssaultRate: 210,  gceSustainRate: 90,
      nonGceCombatLoad: 300, nonGceAssaultRate: 120, nonGceSustainRate: 50,
    },
    {
      weaponSystemId: wByName.get("LAV-25")!.id,
      catalogItemId: byDodic("A578").id, dodic: "A578",
      gceCombatLoad: 420,   gceAssaultRate: 210,  gceSustainRate: 90,
      nonGceCombatLoad: 300, nonGceAssaultRate: 120, nonGceSustainRate: 50,
    },

    // ── Carl Gustaf M3E1 (K004 HEAT + K007 HE + K008 HEDP + K009 Smoke) ──
    {
      weaponSystemId: wByName.get("Carl Gustaf M3E1 (84mm)")!.id,
      catalogItemId: byDodic("K004").id, dodic: "K004",
      gceCombatLoad: 8,     gceAssaultRate: 3,    gceSustainRate: 1,
      nonGceCombatLoad: 6,   nonGceAssaultRate: 2,  nonGceSustainRate: 1,
    },
    {
      weaponSystemId: wByName.get("Carl Gustaf M3E1 (84mm)")!.id,
      catalogItemId: byDodic("K007").id, dodic: "K007",
      gceCombatLoad: 6,     gceAssaultRate: 3,    gceSustainRate: 1,
      nonGceCombatLoad: 4,   nonGceAssaultRate: 2,  nonGceSustainRate: 1,
    },
    {
      weaponSystemId: wByName.get("Carl Gustaf M3E1 (84mm)")!.id,
      catalogItemId: byDodic("K008").id, dodic: "K008",
      gceCombatLoad: 4,     gceAssaultRate: 2,    gceSustainRate: 1,
      nonGceCombatLoad: 4,   nonGceAssaultRate: 2,  nonGceSustainRate: 1,
    },
    {
      weaponSystemId: wByName.get("Carl Gustaf M3E1 (84mm)")!.id,
      catalogItemId: byDodic("K009").id, dodic: "K009",
      gceCombatLoad: 4,     gceAssaultRate: 2,    gceSustainRate: 1,
      nonGceCombatLoad: 4,   nonGceAssaultRate: 2,  nonGceSustainRate: 1,
    },

    // ── F-35B Lightning II (B810 GBU-12 + B811 JDAM + B850 AMRAAM + B820 AIM-9X) ──
    {
      weaponSystemId: wByName.get("F-35B Lightning II")!.id,
      catalogItemId: byDodic("B810").id, dodic: "B810",
      gceCombatLoad: 4,     gceAssaultRate: 2,    gceSustainRate: 1,
      nonGceCombatLoad: 4,   nonGceAssaultRate: 2,  nonGceSustainRate: 1,
    },
    {
      weaponSystemId: wByName.get("F-35B Lightning II")!.id,
      catalogItemId: byDodic("B811").id, dodic: "B811",
      gceCombatLoad: 2,     gceAssaultRate: 1,    gceSustainRate: 0,
      nonGceCombatLoad: 2,   nonGceAssaultRate: 1,  nonGceSustainRate: 0,
    },
    {
      weaponSystemId: wByName.get("F-35B Lightning II")!.id,
      catalogItemId: byDodic("B850").id, dodic: "B850",
      gceCombatLoad: 4,     gceAssaultRate: 2,    gceSustainRate: 1,
      nonGceCombatLoad: 4,   nonGceAssaultRate: 2,  nonGceSustainRate: 1,
    },
    {
      weaponSystemId: wByName.get("F-35B Lightning II")!.id,
      catalogItemId: byDodic("B820").id, dodic: "B820",
      gceCombatLoad: 2,     gceAssaultRate: 1,    gceSustainRate: 0,
      nonGceCombatLoad: 2,   nonGceAssaultRate: 1,  nonGceSustainRate: 0,
    },
  ]);

  // ─── Units ───────────────────────────────────────────────────────────────────
  logger.info("Seeding units...");

  const units = await db
    .insert(unitsTable)
    .values([
      {
        name: "5th Marine Regiment (HQ)",
        callsign: "LANCER 6",
        echelon: "regiment",
        personnel: 48,
        commander: "Col Harrington",
        location: "Camp Pendleton, CA",
        climate: "temperate",
        opTempo: "sustained",
        missionDays: 30,
        role: "organic",
        ammoPosture: "sustain",
        isGce: true,
      },
      {
        name: "1st Battalion, 5th Marines",
        callsign: "LANCER 1-6",
        echelon: "battalion",
        personnel: 870,
        commander: "LtCol Vasquez",
        location: "FOB Kestrel",
        climate: "arid",
        opTempo: "high",
        missionDays: 14,
        role: "organic",
        ammoPosture: "assault",
        isGce: true,
      },
      {
        name: "2nd Battalion, 5th Marines",
        callsign: "LANCER 2-6",
        echelon: "battalion",
        personnel: 855,
        commander: "LtCol Okoro",
        location: "FOB Sentinel",
        climate: "arid",
        opTempo: "combat",
        missionDays: 10,
        role: "organic",
        ammoPosture: "assault",
        isGce: true,
      },
      {
        name: "1st Artillery Battery, 11th Marines",
        callsign: "IRON 6",
        echelon: "battery",
        personnel: 130,
        commander: "Capt Tran",
        location: "Firing Position Bravo",
        climate: "arid",
        opTempo: "high",
        missionDays: 14,
        role: "organic",
        ammoPosture: "assault",
        isGce: false,
      },
      {
        name: "HIMARS Platoon, 11th Marines",
        callsign: "THUNDER 1",
        echelon: "platoon",
        personnel: 28,
        commander: "1stLt Morales",
        location: "BP Echo",
        climate: "arid",
        opTempo: "sustained",
        missionDays: 14,
        role: "organic",
        ammoPosture: "sustain",
        isGce: false,
      },
      {
        name: "Recon Platoon, 5th Marines",
        callsign: "GHOST 6",
        echelon: "platoon",
        personnel: 32,
        commander: "1stLt Park",
        location: "Fwd Screen Line",
        climate: "arid",
        opTempo: "high",
        missionDays: 7,
        role: "organic",
        ammoPosture: "assault",
        isGce: true,
      },
      {
        name: "LAAD Platoon, 5th Marines",
        callsign: "SHIELD 1",
        echelon: "platoon",
        personnel: 24,
        commander: "1stLt Chen",
        location: "Air Defense Zone Alpha",
        climate: "arid",
        opTempo: "sustained",
        missionDays: 14,
        role: "organic",
        ammoPosture: "sustain",
        isGce: false,
      },
      {
        name: "Combat Logistics Battalion 5",
        callsign: "PILGRIM 6",
        echelon: "battalion",
        personnel: 680,
        commander: "LtCol Reyes",
        location: "BSA Titan",
        climate: "arid",
        opTempo: "high",
        missionDays: 14,
        role: "organic",
        ammoPosture: "sustain",
        isGce: false,
      },
      {
        name: "MSOT 8212 (In Direct Support)",
        callsign: "PHANTOM 6",
        echelon: "team",
        personnel: 14,
        commander: "Maj Okafor",
        location: "Undisclosed Fwd Pos",
        climate: "arid",
        opTempo: "combat",
        missionDays: 7,
        role: "in_support",
        ammoPosture: "combat_load",
        isGce: true,
      },
    ])
    .returning();

  const unitByName = new Map(units.map((u) => [u.name, u]));

  // ─── Unit Weapons (sample assignments) ──────────────────────────────────────
  logger.info("Seeding unit weapons...");

  const lancer1 = unitByName.get("1st Battalion, 5th Marines")!;
  const lancer2 = unitByName.get("2nd Battalion, 5th Marines")!;
  const iron    = unitByName.get("1st Artillery Battery, 11th Marines")!;
  const himars  = unitByName.get("HIMARS Platoon, 11th Marines")!;
  const recon   = unitByName.get("Recon Platoon, 5th Marines")!;
  const phantom = unitByName.get("MSOT 8212 (In Direct Support)")!;

  await db.insert(unitWeaponsTable).values([
    // 1/5 Marines — infantry battalion
    { unitId: lancer1.id, weaponSystemId: wByName.get("M4/M4A1 Carbine")!.id,  quantity: 650 },
    { unitId: lancer1.id, weaponSystemId: wByName.get("M27 IAR")!.id,           quantity: 72  },
    { unitId: lancer1.id, weaponSystemId: wByName.get("M240B/G GPMG")!.id,      quantity: 36  },
    { unitId: lancer1.id, weaponSystemId: wByName.get("M249 SAW")!.id,           quantity: 18  },
    { unitId: lancer1.id, weaponSystemId: wByName.get("M2 .50 Cal HMG")!.id,    quantity: 12  },
    { unitId: lancer1.id, weaponSystemId: wByName.get("M203 / M320 GLM")!.id,   quantity: 60  },
    { unitId: lancer1.id, weaponSystemId: wByName.get("M252 81mm Mortar")!.id,  quantity: 6   },
    { unitId: lancer1.id, weaponSystemId: wByName.get("Javelin (FGM-148)")!.id, quantity: 8   },

    // 2/5 Marines — infantry battalion (combat posture)
    { unitId: lancer2.id, weaponSystemId: wByName.get("M4/M4A1 Carbine")!.id,  quantity: 630 },
    { unitId: lancer2.id, weaponSystemId: wByName.get("M27 IAR")!.id,           quantity: 72  },
    { unitId: lancer2.id, weaponSystemId: wByName.get("M240B/G GPMG")!.id,      quantity: 36  },
    { unitId: lancer2.id, weaponSystemId: wByName.get("M249 SAW")!.id,           quantity: 18  },
    { unitId: lancer2.id, weaponSystemId: wByName.get("M2 .50 Cal HMG")!.id,    quantity: 12  },
    { unitId: lancer2.id, weaponSystemId: wByName.get("M203 / M320 GLM")!.id,   quantity: 54  },
    { unitId: lancer2.id, weaponSystemId: wByName.get("M252 81mm Mortar")!.id,  quantity: 6   },
    { unitId: lancer2.id, weaponSystemId: wByName.get("Javelin (FGM-148)")!.id, quantity: 8   },
    { unitId: lancer2.id, weaponSystemId: wByName.get("SMAW")!.id,              quantity: 6   },

    // Artillery battery — howitzers only
    { unitId: iron.id, weaponSystemId: wByName.get("M777 155mm Howitzer")!.id, quantity: 6   },
    { unitId: iron.id, weaponSystemId: wByName.get("M4/M4A1 Carbine")!.id,     quantity: 100 },

    // HIMARS platoon
    { unitId: himars.id, weaponSystemId: wByName.get("M142 HIMARS")!.id,        quantity: 4   },
    { unitId: himars.id, weaponSystemId: wByName.get("M4/M4A1 Carbine")!.id,    quantity: 22  },
    { unitId: himars.id, weaponSystemId: wByName.get("M2 .50 Cal HMG")!.id,     quantity: 4   },

    // Recon platoon — light infantry
    { unitId: recon.id, weaponSystemId: wByName.get("M4/M4A1 Carbine")!.id,    quantity: 28  },
    { unitId: recon.id, weaponSystemId: wByName.get("M27 IAR")!.id,             quantity: 4   },
    { unitId: recon.id, weaponSystemId: wByName.get("M240B/G GPMG")!.id,        quantity: 2   },
    { unitId: recon.id, weaponSystemId: wByName.get("Javelin (FGM-148)")!.id,   quantity: 2   },
    { unitId: recon.id, weaponSystemId: wByName.get("M203 / M320 GLM")!.id,     quantity: 6   },

    // MSOT — special operations
    { unitId: phantom.id, weaponSystemId: wByName.get("M4/M4A1 Carbine")!.id,  quantity: 10  },
    { unitId: phantom.id, weaponSystemId: wByName.get("M27 IAR")!.id,           quantity: 4   },
    { unitId: phantom.id, weaponSystemId: wByName.get("M240B/G GPMG")!.id,      quantity: 2   },
    { unitId: phantom.id, weaponSystemId: wByName.get("Javelin (FGM-148)")!.id, quantity: 2   },
  ]);

  // ─── Supply Entries ──────────────────────────────────────────────────────────
  logger.info("Seeding supply entries...");

  // Climate/tempo multipliers for non-V classes (mirrors logistics.ts)
  const climateMul: Record<string, Record<string, number>> = {
    temperate: { I: 1,    III: 1,    V: 1, VIII: 1,    IX: 1.05 },
    arid:      { I: 1.6,  III: 1.15, V: 1, VIII: 1.1,  IX: 1.05 },
    tropical:  { I: 1.25, III: 1.05, V: 1, VIII: 1.2,  IX: 1.05 },
    arctic:    { I: 1.35, III: 1.6,  V: 1, VIII: 1.15, IX: 1.1  },
  };
  const tempoMul: Record<string, Record<string, number>> = {
    garrison:  { I: 0.9,  III: 0.7,  V: 0.1, VIII: 0.5,  IX: 0.6  },
    sustained: { I: 1,    III: 1,    V: 1,   VIII: 1,    IX: 1    },
    high:      { I: 1.1,  III: 1.4,  V: 2.5, VIII: 1.4,  IX: 1.3  },
    combat:    { I: 1.15, III: 1.6,  V: 5,   VIII: 2,    IX: 1.6  },
  };

  // on-hand ratios (>1 = excess, <1 = deficient, 0 = not stocked)
  const onHandPlan: Record<string, { itemName: string; ratio: number }[]> = {
    "5th Marine Regiment (HQ)": [
      { itemName: "Potable Water", ratio: 1.2 },
      { itemName: "MRE — Meal, Ready-to-Eat", ratio: 1.3 },
      { itemName: "BA-5590/U Lithium Battery (radio)", ratio: 1.0 },
      { itemName: "AA Lithium (general purpose)", ratio: 1.2 },
      { itemName: "IFAK — Individual First Aid Kit", ratio: 1.2 },
      { itemName: "CAT — Combat Application Tourniquet", ratio: 1.0 },
    ],
    "1st Battalion, 5th Marines": [
      { itemName: "Potable Water", ratio: 0.65 },
      { itemName: "MRE — Meal, Ready-to-Eat", ratio: 1.0 },
      { itemName: "BA-5590/U Lithium Battery (radio)", ratio: 0.75 },
      { itemName: "BA-5847/U Battery (NVG / thermal)", ratio: 1.2 },
      { itemName: "AA Lithium (general purpose)", ratio: 1.0 },
      { itemName: "JP-8 Fuel", ratio: 0.8 },
      { itemName: "IFAK — Individual First Aid Kit", ratio: 1.0 },
      { itemName: "CAT — Combat Application Tourniquet", ratio: 0.9 },
      { itemName: "Hemostatic Gauze (Combat Gauze)", ratio: 1.0 },
      { itemName: "1L Saline / Hextend", ratio: 1.2 },
      { itemName: "M4 Bolt Carrier Group (spare)", ratio: 1.0 },
      { itemName: "Radio Antenna, Whip (replacement)", ratio: 1.0 },
      // Class V on-hand in rounds
      { itemName: "A059 — 5.56mm Ball, M855 (30-rd magazine)", ratio: 1.4 },
      { itemName: "A064 — 5.56mm Ball, M855A1 (EPR)", ratio: 1.2 },
      { itemName: "A131 — 7.62mm Ball M80, Linked (M240)", ratio: 1.1 },
      { itemName: "A063 — 5.56mm Ball Linked (M249 SAW)", ratio: 1.0 },
      { itemName: "A556 — .50 Cal M33 Ball, Linked", ratio: 1.2 },
      { itemName: "B524 — 40mm HEDP M433", ratio: 0.9 },
      { itemName: "C787 — 81mm HE, M821", ratio: 1.0 },
      { itemName: "AA33 — Javelin CTM, FGM-148", ratio: 1.0 },
    ],
    "2nd Battalion, 5th Marines": [
      { itemName: "MRE — Meal, Ready-to-Eat", ratio: 0.8 },
      { itemName: "Potable Water", ratio: 0.6 },
      { itemName: "BA-5590/U Lithium Battery (radio)", ratio: 0.4 },
      { itemName: "BA-5847/U Battery (NVG / thermal)", ratio: 0.6 },
      { itemName: "AA Lithium (general purpose)", ratio: 0.85 },
      { itemName: "JP-8 Fuel", ratio: 0.7 },
      { itemName: "IFAK — Individual First Aid Kit", ratio: 0.85 },
      { itemName: "CAT — Combat Application Tourniquet", ratio: 0.65 },
      { itemName: "Hemostatic Gauze (Combat Gauze)", ratio: 0.5 },
      { itemName: "1L Saline / Hextend", ratio: 0.45 },
      { itemName: "M4 Bolt Carrier Group (spare)", ratio: 1.0 },
      { itemName: "Radio Antenna, Whip (replacement)", ratio: 1.2 },
      // Class V — low on ammo (combat posture, aggressive ops)
      { itemName: "A059 — 5.56mm Ball, M855 (30-rd magazine)", ratio: 0.6 },
      { itemName: "A064 — 5.56mm Ball, M855A1 (EPR)", ratio: 0.5 },
      { itemName: "A131 — 7.62mm Ball M80, Linked (M240)", ratio: 0.55 },
      { itemName: "A063 — 5.56mm Ball Linked (M249 SAW)", ratio: 0.7 },
      { itemName: "A556 — .50 Cal M33 Ball, Linked", ratio: 0.6 },
      { itemName: "B524 — 40mm HEDP M433", ratio: 0.4 },
      { itemName: "C787 — 81mm HE, M821", ratio: 0.6 },
      { itemName: "L311 — SMAW Rocket, HEAA", ratio: 1.0 },
      { itemName: "AA33 — Javelin CTM, FGM-148", ratio: 0.5 },
    ],
    "1st Artillery Battery, 11th Marines": [
      { itemName: "Potable Water", ratio: 0.75 },
      { itemName: "MRE — Meal, Ready-to-Eat", ratio: 1.0 },
      { itemName: "BA-5590/U Lithium Battery (radio)", ratio: 0.8 },
      { itemName: "JP-8 Fuel", ratio: 0.6 },
      { itemName: "IFAK — Individual First Aid Kit", ratio: 1.0 },
      { itemName: "CAT — Combat Application Tourniquet", ratio: 1.0 },
      // Class V — howitzer ammo
      { itemName: "D544 — 155mm HE, M107", ratio: 1.2 },
      { itemName: "D546 — 155mm ICM, M483A1", ratio: 0.8 },
      { itemName: "A059 — 5.56mm Ball, M855 (30-rd magazine)", ratio: 1.0 },
    ],
    "HIMARS Platoon, 11th Marines": [
      { itemName: "Potable Water", ratio: 1.0 },
      { itemName: "MRE — Meal, Ready-to-Eat", ratio: 1.2 },
      { itemName: "BA-5590/U Lithium Battery (radio)", ratio: 1.1 },
      { itemName: "JP-8 Fuel", ratio: 1.3 },
      { itemName: "IFAK — Individual First Aid Kit", ratio: 1.1 },
      { itemName: "D879 — GMLRS M30, HIMARS", ratio: 1.5 },
      { itemName: "A059 — 5.56mm Ball, M855 (30-rd magazine)", ratio: 1.0 },
      { itemName: "A556 — .50 Cal M33 Ball, Linked", ratio: 1.2 },
    ],
    "Recon Platoon, 5th Marines": [
      { itemName: "Potable Water", ratio: 0.7 },
      { itemName: "MRE — Meal, Ready-to-Eat", ratio: 1.1 },
      { itemName: "BA-5590/U Lithium Battery (radio)", ratio: 0.6 },
      { itemName: "BA-5847/U Battery (NVG / thermal)", ratio: 0.5 },
      { itemName: "AA Lithium (general purpose)", ratio: 0.9 },
      { itemName: "IFAK — Individual First Aid Kit", ratio: 1.0 },
      { itemName: "CAT — Combat Application Tourniquet", ratio: 1.0 },
      { itemName: "A059 — 5.56mm Ball, M855 (30-rd magazine)", ratio: 1.5 },
      { itemName: "A064 — 5.56mm Ball, M855A1 (EPR)", ratio: 1.2 },
      { itemName: "A131 — 7.62mm Ball M80, Linked (M240)", ratio: 1.3 },
      { itemName: "B524 — 40mm HEDP M433", ratio: 1.0 },
      { itemName: "AA33 — Javelin CTM, FGM-148", ratio: 2.0 },
    ],
    "LAAD Platoon, 5th Marines": [
      { itemName: "Potable Water", ratio: 1.0 },
      { itemName: "MRE — Meal, Ready-to-Eat", ratio: 1.0 },
      { itemName: "BA-5590/U Lithium Battery (radio)", ratio: 1.2 },
      { itemName: "JP-8 Fuel", ratio: 1.0 },
      { itemName: "IFAK — Individual First Aid Kit", ratio: 1.0 },
    ],
    "Combat Logistics Battalion 5": [
      { itemName: "Potable Water", ratio: 1.5 },
      { itemName: "MRE — Meal, Ready-to-Eat", ratio: 1.4 },
      { itemName: "BA-5590/U Lithium Battery (radio)", ratio: 1.0 },
      { itemName: "JP-8 Fuel", ratio: 0.75 },
      { itemName: "IFAK — Individual First Aid Kit", ratio: 1.2 },
      { itemName: "CAT — Combat Application Tourniquet", ratio: 1.1 },
      { itemName: "M4 Bolt Carrier Group (spare)", ratio: 1.5 },
      { itemName: "Radio Antenna, Whip (replacement)", ratio: 1.3 },
    ],
    "MSOT 8212 (In Direct Support)": [
      { itemName: "MRE — Meal, Ready-to-Eat", ratio: 1.4 },
      { itemName: "Potable Water", ratio: 0.8 },
      { itemName: "BA-5590/U Lithium Battery (radio)", ratio: 0.7 },
      { itemName: "BA-5847/U Battery (NVG / thermal)", ratio: 0.6 },
      { itemName: "AA Lithium (general purpose)", ratio: 0.9 },
      { itemName: "IFAK — Individual First Aid Kit", ratio: 1.3 },
      { itemName: "CAT — Combat Application Tourniquet", ratio: 1.2 },
      { itemName: "A059 — 5.56mm Ball, M855 (30-rd magazine)", ratio: 1.5 },
      { itemName: "A131 — 7.62mm Ball M80, Linked (M240)", ratio: 1.0 },
      { itemName: "AA33 — Javelin CTM, FGM-148", ratio: 1.0 },
    ],
  };

  // For Class V items with weapon-driven burn, we compute on-hand from combat load targets
  // For non-V items, we compute from per-Marine rates as before
  // We need to know the weapon assignments per unit for Class V seeding
  const unitWeaponRows = await db
    .select({
      unitId: unitWeaponsTable.unitId,
      weaponSystemId: unitWeaponsTable.weaponSystemId,
      quantity: unitWeaponsTable.quantity,
    })
    .from(unitWeaponsTable);

  const dodicRates = await db.select().from(weaponDodicRatesTable);

  for (const u of units) {
    const plan = onHandPlan[u.name] ?? [];
    const allRows: { unitId: string; itemId: string; onHand: number }[] = [];

    // Build a map: catalogItemId -> totalWeaponDrivenCombatLoad for this unit
    const unitWeapons = unitWeaponRows.filter((w) => w.unitId === u.id);
    const combatLoadByItem = new Map<string, number>();
    const assaultByItem = new Map<string, number>();

    for (const uw of unitWeapons) {
      const rates = dodicRates.filter(
        (r) => r.weaponSystemId === uw.weaponSystemId,
      );
      for (const r of rates) {
        const gceMul = u.isGce ? 1 : 0;
        const nonGceMul = u.isGce ? 0 : 1;
        const cl = r.gceCombatLoad * gceMul + r.nonGceCombatLoad * nonGceMul;
        const ar = r.gceAssaultRate * gceMul + r.nonGceAssaultRate * nonGceMul;
        combatLoadByItem.set(
          r.catalogItemId,
          (combatLoadByItem.get(r.catalogItemId) ?? 0) + uw.quantity * cl,
        );
        assaultByItem.set(
          r.catalogItemId,
          (assaultByItem.get(r.catalogItemId) ?? 0) + uw.quantity * ar,
        );
      }
    }

    for (const item of catalog) {
      const found = plan.find((p) => p.itemName === item.name);
      if (!found && item.supplyClass === "V") continue; // skip unplanned V items

      let onHand: number;
      if (item.supplyClass === "V") {
        // Use combat load target as baseline then scale by ratio
        const ratio = found?.ratio ?? 1.0;
        const baseline =
          combatLoadByItem.get(item.id) ??
          (assaultByItem.get(item.id) ?? 0) * u.missionDays;
        onHand = Math.round(baseline * ratio);
      } else {
        const ratio = found?.ratio ?? 1.0;
        const c = climateMul[u.climate]?.[item.supplyClass] ?? 1;
        const t = tempoMul[u.opTempo]?.[item.supplyClass] ?? 1;
        const required =
          item.baseDailyRate * c * t * u.personnel * u.missionDays;
        onHand = Math.round(required * ratio * 100) / 100;
      }

      if (onHand > 0 || found) {
        allRows.push({ unitId: u.id, itemId: item.id, onHand });
      }
    }

    if (allRows.length > 0) {
      await db.insert(supplyEntriesTable).values(allRows);
    }
  }

  // ─── Resupply Events ─────────────────────────────────────────────────────────
  logger.info("Seeding resupply events...");

  const water       = itemByName.get("Potable Water")!;
  const battery5590 = itemByName.get("BA-5590/U Lithium Battery (radio)")!;
  const ammoA059    = itemByName.get("A059 — 5.56mm Ball, M855 (30-rd magazine)")!;
  const fuel        = itemByName.get("JP-8 Fuel")!;

  const now = new Date();

  await db.insert(resupplyEventsTable).values([
    {
      unitId: lancer2.id,
      supplyClass: "III",
      itemId: battery5590.id,
      quantity: 1200,
      unit: "battery",
      scheduledFor: new Date(now.getTime() + 8 * 60 * 60 * 1000),
      status: "in_transit",
      assignedTo: "CLB-5 (GySgt Walsh)",
      notes: "Priority push — 2/5 at <2 DOS on radios. LZ Sierra cleared.",
    },
    {
      unitId: lancer2.id,
      supplyClass: "I",
      itemId: water.id,
      quantity: 18000,
      unit: "gal",
      scheduledFor: new Date(now.getTime() + 18 * 60 * 60 * 1000),
      status: "planned",
      assignedTo: "CLB-5",
      notes: "7-ton convoy, Route IRON. Water buffalo x3.",
    },
    {
      unitId: lancer1.id,
      supplyClass: "V",
      itemId: ammoA059.id,
      quantity: 150000,
      unit: "round",
      scheduledFor: new Date(now.getTime() + 36 * 60 * 60 * 1000),
      status: "planned",
      assignedTo: "Capt Diaz",
      notes: "Pre-position A059 for OPORD 501 execution.",
    },
    {
      unitId: iron.id,
      supplyClass: "III",
      itemId: fuel.id,
      quantity: 4000,
      unit: "gal",
      scheduledFor: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      status: "planned",
      assignedTo: "CLB-5",
      notes: "HEMTT fuel tanker. Route AMBER.",
    },
    {
      unitId: phantom.id,
      supplyClass: "III",
      itemId: battery5590.id,
      quantity: 60,
      unit: "battery",
      scheduledFor: new Date(now.getTime() + 72 * 60 * 60 * 1000),
      status: "planned",
      assignedTo: "Helo infiltration",
      notes: "CSAR package. Freq: PHANTOM VICTOR.",
    },
  ]);

  // ─── Activity Feed ───────────────────────────────────────────────────────────
  await db.insert(activityTable).values([
    {
      kind: "deficiency_flagged",
      message: "LANCER 2-6 flagged: Class III batteries < 2 DOS at combat tempo",
      unitId: lancer2.id,
      unitName: lancer2.name,
      timestamp: new Date(now.getTime() - 20 * 60 * 1000),
    },
    {
      kind: "deficiency_flagged",
      message: "LANCER 2-6 flagged: Potable Water < 1.5 DOS (arid/combat)",
      unitId: lancer2.id,
      unitName: lancer2.name,
      timestamp: new Date(now.getTime() - 35 * 60 * 1000),
    },
    {
      kind: "deficiency_flagged",
      message: "LANCER 2-6 flagged: Class V A059 < 2 DOS (assault posture)",
      unitId: lancer2.id,
      unitName: lancer2.name,
      timestamp: new Date(now.getTime() - 50 * 60 * 1000),
    },
    {
      kind: "resupply_planned",
      message: "Resupply planned for LANCER 2-6: 1,200 batteries Class III (in transit)",
      unitId: lancer2.id,
      unitName: lancer2.name,
      timestamp: new Date(now.getTime() - 75 * 60 * 1000),
    },
    {
      kind: "resupply_planned",
      message: "Resupply planned for LANCER 1-6: 150,000 rds A059 Class V",
      unitId: lancer1.id,
      unitName: lancer1.name,
      timestamp: new Date(now.getTime() - 90 * 60 * 1000),
    },
    {
      kind: "sync_completed",
      message: "Synced with SPIRE — pushed 9, failed 0, catalog delta: +0 new, 0 changed (112ms)",
      timestamp: new Date(now.getTime() - 5 * 60 * 1000),
    },
    {
      kind: "unit_created",
      message: "MSOT 8212 (team, in support) attached to regimental task force",
      unitId: phantom.id,
      unitName: phantom.name,
      timestamp: new Date(now.getTime() - 8 * 60 * 60 * 1000),
    },
  ]);

  // ─── Sync State ──────────────────────────────────────────────────────────────
  await db.insert(syncStateTable).values({
    id: "default",
    upstreamSystem: "SPIRE",
    connected: true,
    lastSyncAt: new Date(now.getTime() - 5 * 60 * 1000),
    pendingChanges: 0,
    latencyMs: 112,
  });

  logger.info("Seed complete.");
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "Seed failed");
    process.exit(1);
  });
