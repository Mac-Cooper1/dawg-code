import { canonicalSku } from "./sku.js";

export class Cart {
  /** @param {import("./catalog.js").Catalog} catalog */
  constructor(catalog) {
    this.catalog = catalog;
    /** @type {Map<string, number>} */
    this.items = new Map();
  }

  /**
   * @param {string} sku any spelling canonicalSku accepts
   * @param {number} [qty]
   */
  add(sku, qty = 1) {
    const key = canonicalSku(sku);
    const product = this.catalog.get(key);
    if (!product) throw new Error(`unknown SKU ${key}`);
    const next = (this.items.get(key) ?? 0) + qty;
    if (next > product.stock) throw new Error(`only ${product.stock} of ${key} in stock`);
    this.items.set(key, next);
    return this;
  }

  /** @param {string} sku */
  remove(sku) {
    this.items.delete(canonicalSku(sku));
    return this;
  }

  total() {
    let cents = 0;
    for (const [sku, qty] of this.items) {
      cents += this.catalog.get(sku).priceCents * qty;
    }
    return cents;
  }
}
