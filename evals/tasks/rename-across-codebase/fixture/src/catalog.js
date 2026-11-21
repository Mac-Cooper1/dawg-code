import { normalizeSku } from "./sku.js";

/**
 * @typedef {{ sku: string, name: string, priceCents: number, stock: number }} Product
 */

export class Catalog {
  /** @type {Map<string, Product>} */
  #products = new Map();

  /** @param {Product} product */
  add(product) {
    const sku = normalizeSku(product.sku);
    if (this.#products.has(sku)) {
      throw new Error(`duplicate SKU ${sku}`);
    }
    this.#products.set(sku, { ...product, sku });
    return this;
  }

  /** @param {string} sku */
  get(sku) {
    return this.#products.get(normalizeSku(sku));
  }

  /**
   * @param {string} sku
   * @param {number} count
   */
  restock(sku, count) {
    const product = this.get(sku);
    if (!product) throw new Error(`unknown SKU ${sku}`);
    product.stock += count;
    return product.stock;
  }

  all() {
    // Plain code-unit order, so sorting does not depend on the locale.
    return [...this.#products.values()].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  }
}
