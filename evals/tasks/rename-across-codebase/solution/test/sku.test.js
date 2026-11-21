import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidSku, canonicalSku } from "../src/index.js";

test("canonicalSku canonicalises spelling", () => {
  assert.equal(canonicalSku("ABC-1234"), "ABC-1234");
  assert.equal(canonicalSku(" abc_1234 xl "), "ABC-1234-XL");
  assert.equal(canonicalSku("abc--1234"), "ABC-1234");
});

test("canonicalSku rejects garbage", () => {
  for (const bad of ["", "AB-1234", "ABCD-1234", "ABC-123", "ABC-1234-XXXX", 42]) {
    assert.throws(() => canonicalSku(bad), RangeError, String(bad));
  }
});

test("isValidSku", () => {
  assert.equal(isValidSku("xyz 0001"), true);
  assert.equal(isValidSku("nope"), false);
});
