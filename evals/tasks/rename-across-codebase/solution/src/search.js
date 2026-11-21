import { isValidSku, canonicalSku } from "./sku.js";

/**
 * Look a product up by SKU, accepting any spelling. Returns undefined for
 * queries that are not SKUs at all.
 * @param {import("./catalog.js").Catalog} catalog
 * @param {string} query
 */
export function findBySku(catalog, query) {
  if (!isValidSku(query)) return undefined;
  return catalog.get(canonicalSku(query));
}

/**
 * Products whose name contains every word (case-insensitive).
 * @param {import("./catalog.js").Catalog} catalog
 * @param {string} words
 */
export function searchByName(catalog, words) {
  const wanted = words.toLowerCase().split(/\s+/).filter(Boolean);
  return catalog.all().filter((p) => wanted.every((w) => p.name.toLowerCase().includes(w)));
}
