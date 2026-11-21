import assert from "node:assert/strict";
import { test } from "node:test";
import { Cart, Catalog } from "../src/index.js";

function catalog() {
  return new Catalog()
    .add({ sku: "ABC-1234", name: "Blue mug", priceCents: 850, stock: 3 })
    .add({ sku: "XYZ-0001", name: "Red mug", priceCents: 900, stock: 12 });
}

test("cart totals across spellings", () => {
  const cart = new Cart(catalog()).add("abc_1234", 2).add("ABC 1234").add("xyz-0001", 4);
  assert.equal(cart.total(), 3 * 850 + 4 * 900);
  cart.remove("Abc-1234");
  assert.equal(cart.total(), 4 * 900);
});

test("cart enforces stock", () => {
  const cart = new Cart(catalog());
  assert.throws(() => cart.add("abc-1234", 4), /only 3/);
  assert.throws(() => cart.add("bad"), RangeError);
});
