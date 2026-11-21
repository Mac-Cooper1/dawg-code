import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidSku, normalizeSku } from "../src/index.js";

test("normalizeSku canonicalises spelling", () => {
  assert.equal(normalizeSku("ABC-1234"), "ABC-1234");
  assert.equal(normalizeSku(" abc_1234 xl "), "ABC-1234-XL");
  assert.equal(normalizeSku("abc--1234"), "ABC-1234");
});

test("normalizeSku rejects garbage", () => {
  for (const bad of ["", "AB-1234", "ABCD-1234", "ABC-123", "ABC-1234-XXXX", 42]) {
    assert.throws(() => normalizeSku(bad), RangeError, String(bad));
  }
});

test("isValidSku", () => {
  assert.equal(isValidSku("xyz 0001"), true);
  assert.equal(isValidSku("nope"), false);
});
