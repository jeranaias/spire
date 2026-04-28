import { test, expect, request } from "@playwright/test";

const BASE = process.env.SPIRE_E2E_BASE_URL ?? "http://127.0.0.1:8000";

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split("\n").filter((l) => l.length > 0);
  const headers = lines[0].split(",").map((c) => c.replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (const ch of line) {
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
  });
}

test("sensitive fields ship in canonical hashed form across exports", async () => {
  const ctx = await request.newContext({ baseURL: BASE });
  await ctx.post("/api/auth/login", {
    data: { dodid: "1234567890", pin: "123456" },
  });

  const headerCsv = await (
    await ctx.get("/api/gcss/export/sr_header.csv?limit=50")
  ).text();
  const partsCsv = await (
    await ctx.get("/api/gcss/export/sr_parts.csv?limit=200")
  ).text();

  const headerRows = parseCsv(headerCsv);
  const partsRows = parseCsv(partsCsv);

  expect(headerRows.length).toBeGreaterThan(0);
  expect(partsRows.length).toBeGreaterThan(0);

  for (const r of headerRows) {
    for (const [col, prefix] of [
      ["SR_NUMBER", "sr_number_"],
      ["SERIAL_NUMBER", "serial_number_"],
      ["TAMCN", "tamcn_"],
      ["OWNER_UNIT_ADDRESS_CODE", "owner_unit_address_code_"],
    ] as const) {
      const v = (r[col] ?? "").trim();
      if (!v) continue;
      expect(v.startsWith(prefix), `${col}=${v}`).toBe(true);
      expect(v.slice(prefix.length).length, `${col} suffix len`).toBe(20);
    }
  }

  const headerSrs = new Set(headerRows.map((r) => r.SR_NUMBER));
  const partsSrs = new Set(partsRows.map((r) => r.SR_NUMBER));
  const overlap = [...headerSrs].filter((s) => partsSrs.has(s));
  expect(overlap.length, "cross-export SR_NUMBER overlap").toBeGreaterThan(0);
});
