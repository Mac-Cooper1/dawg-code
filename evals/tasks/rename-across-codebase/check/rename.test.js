// Hidden tests: the renamed function is exported and every module still works.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const ws = process.env.WORKSPACE;
const lib = await import(pathToFileURL(join(ws, "src", "index.js")).href);
const skuModule = await import(pathToFileURL(join(ws, "src", "sku.js")).href);

test("canonicalSku is exported and the old name is gone", () => {
  assert.equal(typeof lib.canonicalSku, "function");
  assert.equal(typeof skuModule.canonicalSku, "function");
  assert.equal(lib.normalizeSku, undefined);
  assert.equal(skuModule.normalizeSku, undefined);
});

test("canonicalSku behaves like before", () => {
  assert.equal(lib.canonicalSku("ABC-1234"), "ABC-1234");
  assert.equal(lib.canonicalSku(" abc_1234 xl "), "ABC-1234-XL");
  assert.equal(lib.canonicalSku("abc--1234"), "ABC-1234");
  for (const bad of ["", "AB-1234", "ABCD-1234", "ABC-123", "ABC-1234-XXXX", 42]) {
    assert.throws(() => lib.canonicalSku(bad), RangeError, String(bad));
  }
  assert.equal(lib.isValidSku("xyz 0001"), true);
  assert.equal(lib.isValidSku("nope"), false);
});

const CSV = `sku,name,price_cents,stock
abc_1234,Blue   mug,850,3
XYZ-0001,Red mug,900,12
qrs 0042 xl,Big  blue bowl,1500,1
`;

function load() {
  const catalog = new lib.Catalog();
  for (const p of lib.importCsv(CSV)) catalog.add(p);
  return catalog;
}

test("every module that takes a SKU still canonicalises it", () => {
  assert.deepEqual(
    lib.importCsv(CSV).map((p) => p.sku),
    ["ABC-1234", "XYZ-0001", "QRS-0042-XL"],
  );
  const catalog = load();
  assert.equal(catalog.get("abc 1234").name, "Blue mug");
  assert.equal(catalog.restock("xyz-0001", 3), 15);
  assert.equal(lib.findBySku(catalog, "qrs_0042_xl").name, "Big blue bowl");
  assert.equal(lib.findBySku(catalog, "garbage"), undefined);
  assert.equal(lib.lowStockReport(catalog, 5, { only: ["abc 1234"] }), "ABC-1234     3  Blue mug");
  const cart = new lib.Cart(catalog).add("abc_1234", 2).add("xyz 0001");
  assert.equal(cart.total(), 2 * 850 + 900);
  cart.remove("ABC_1234");
  assert.equal(cart.total(), 900);
  assert.throws(() => cart.add("bad"), RangeError);
});

test("CLI still works", () => {
  const bin = join(ws, "bin", "stock.js");
  assert.equal(execFileSync(process.execPath, [bin, "sku", " abc_1234 xl "], { encoding: "utf8" }), "ABC-1234-XL\n");
  const dir = mkdtempSync(join(tmpdir(), "shelfstock-"));
  try {
    const file = join(dir, "p.csv");
    writeFileSync(file, CSV);
    const out = execFileSync(process.execPath, [bin, "report", file, "5"], { encoding: "utf8" });
    assert.equal(out, "QRS-0042-XL     1  Big blue bowl\nABC-1234     3  Blue mug\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
