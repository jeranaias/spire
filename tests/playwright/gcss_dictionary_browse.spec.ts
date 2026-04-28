import { test, expect } from "@playwright/test";
import { signIn, gotoHash } from "./_helpers";

test("WP-9: integrations field dictionary search filters by column and SPIRE field", async ({
  page,
}) => {
  await signIn(page);
  await gotoHash(page, "#/integrations/gcss-mc");
  await expect(page.locator("body")).toContainText(/Field dictionary/i, {
    timeout: 10_000,
  });

  const search = page.getByTestId("dictionary-search");
  await search.waitFor({ state: "visible", timeout: 5_000 });

  // Scope assertions to the dictionary table — the integrations page
  // renders several other reference tables (entity map, EQUIPMENT_MASTER
  // sample, etc.) that would otherwise match a bare `table` locator.
  const dictTable = page.getByTestId("dictionary-table");
  await dictTable.waitFor({ state: "visible", timeout: 5_000 });

  // Filter by a real column name — should narrow to rows that mention it.
  await search.fill("TAMCN");
  await expect(dictTable).toContainText(/TAMCN/, { timeout: 5_000 });
  const tableText = await dictTable.innerText();
  expect(tableText.toLowerCase()).toContain("tamcn");

  // Clear, then filter by mapped SPIRE field. `unit_uic` is the SPIRE
  // field for OWNER_UNIT_ADDRESS_CODE per the published mapping.
  await search.fill("");
  await search.fill("unit_uic");
  await expect(dictTable).toContainText(/OWNER_UNIT_ADDRESS_CODE/i, {
    timeout: 5_000,
  });

  // Sanity: typing a nonsense token leaves the table with no real-export
  // rows (header + empty body still renders).
  await search.fill("");
  await search.fill("xyzzy_no_such_field_xyzzy");
  // Wait a tick for React to reconcile the filtered list.
  await page.waitForTimeout(200);
  const filteredText = await dictTable.innerText();
  expect(filteredText.toLowerCase()).not.toContain("tamcn");
});
