import { canonicalSku as norm } from "./sku.js";

/** Collapse runs of whitespace in a product name. */
function normalizeName(name) {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * Parse CSV text with a header line `sku,name,price_cents,stock`.
 * Blank lines and lines starting with # are skipped.
 * @param {string} text
 * @returns {import("./catalog.js").Product[]}
 */
export function importCsv(text) {
  const lines = text.split(/\r?\n/);
  const header = lines.shift()?.trim();
  if (header !== "sku,name,price_cents,stock") {
    throw new Error(`unexpected header: ${header}`);
  }
  const products = [];
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const cols = line.split(",");
    if (cols.length !== 4) throw new Error(`line ${i + 2}: expected 4 columns`);
    const [sku, name, price, stock] = cols;
    products.push({
      sku: norm(sku),
      name: normalizeName(name),
      priceCents: Number.parseInt(price, 10),
      stock: Number.parseInt(stock, 10),
    });
  }
  return products;
}
