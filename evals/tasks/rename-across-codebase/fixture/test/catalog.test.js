import assert from "node:assert/strict";
import { test } from "node:test";
import { Catalog, findBySku, importCsv, lowStockReport, searchByName } from "../src/index.js";

const CSV = `sku,name,price_cents,stock
abc_1234,Blue   mug,850,3
# discontinued
XYZ-0001,Red mug,900,12
qrs 0042 xl,Big  blue bowl,1500,1
`;

function load() {
  const catalog = new Catalog();
  for (const p of importCsv(CSV)) catalog.add(p);
  return catalog;
}

test("import normalises SKUs and names", () => {
  const products = importCsv(CSV);
  assert.deepEqual(
    products.map((p) => [p.sku, p.name]),
    [
      ["ABC-1234", "Blue mug"],
      ["XYZ-0001", "Red mug"],
      ["QRS-0042-XL", "Big blue bowl"],
    ],
  );
});

test("catalog lookups accept any spelling", () => {
  const catalog = load();
  assert.equal(catalog.get("abc 1234").name, "Blue mug");
  assert.throws(() => catalog.add({ sku: "ABC_1234", name: "dup", priceCents: 1, stock: 1 }));
  assert.equal(catalog.restock("xyz-0001", 3), 15);
});

test("search", () => {
  const catalog = load();
  assert.equal(findBySku(catalog, "qrs_0042_xl").name, "Big blue bowl");
  assert.equal(findBySku(catalog, "not a sku"), undefined);
  assert.deepEqual(
    searchByName(catalog, "BLUE").map((p) => p.sku),
    ["ABC-1234", "QRS-0042-XL"],
  );
});

test("low stock report", () => {
  const catalog = load();
  assert.equal(lowStockReport(catalog, 5), "QRS-0042-XL     1  Big blue bowl\nABC-1234     3  Blue mug");
  assert.equal(lowStockReport(catalog, 5, { only: ["abc 1234"] }), "ABC-1234     3  Blue mug");
  assert.equal(lowStockReport(catalog, 0), "All stock above threshold.");
});
