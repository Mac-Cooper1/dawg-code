#!/usr/bin/env node
// Usage:
//   node bin/stock.js sku <raw>                 print the canonical SKU (normalizeSku)
//   node bin/stock.js report <file.csv> <limit> print the low-stock report
import { readFileSync } from "node:fs";
import { Catalog, importCsv, lowStockReport, normalizeSku } from "../src/index.js";

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "sku") {
    console.log(normalizeSku(args[0] ?? ""));
  } else if (command === "report") {
    const catalog = new Catalog();
    for (const product of importCsv(readFileSync(args[0], "utf8"))) catalog.add(product);
    console.log(lowStockReport(catalog, Number(args[1] ?? 5)));
  } else {
    console.error("usage: stock.js sku <raw> | report <file.csv> <limit>");
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
}
