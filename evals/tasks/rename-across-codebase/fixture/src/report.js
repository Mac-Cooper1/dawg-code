import { normalizeSku } from "./sku.js";

/**
 * Products at or below `threshold` units, lowest stock first, as text lines.
 * SKUs in the output are canonical (see normalizeSku).
 * @param {import("./catalog.js").Catalog} catalog
 * @param {number} threshold
 * @param {{ only?: string[] }} [options] restrict to these SKUs
 */
export function lowStockReport(catalog, threshold, { only } = {}) {
  const allowed = only ? new Set(only.map(normalizeSku)) : null;
  const rows = catalog
    .all()
    .filter((p) => p.stock <= threshold && (!allowed || allowed.has(p.sku)))
    .sort((a, b) => a.stock - b.stock || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  if (rows.length === 0) return "All stock above threshold.";
  return rows.map((p) => `${p.sku}  ${String(p.stock).padStart(4)}  ${p.name}`).join("\n");
}
