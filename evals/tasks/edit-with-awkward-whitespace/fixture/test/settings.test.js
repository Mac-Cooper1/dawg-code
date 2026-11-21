import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, formats, network, supports, theme } from "../src/settings.js";

test("settings load", () => {
  assert.equal(typeof network.timeoutMs, "number");
  assert.ok(network.timeoutMs > 0);
  assert.equal(network.retries, 3);
  assert.ok(formats.includes("json"));
  assert.equal(theme.accent, "#ff9900");
});

test("supports is case-insensitive", () => {
  assert.equal(supports("JSON"), true);
  assert.equal(supports("ini"), false);
});

test("describe mentions the timeout", () => {
  assert.match(describe(), new RegExp(`^${network.timeoutMs}ms, ${formats.length} formats, bg #1e1e1e$`));
});
