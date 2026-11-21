import { describe, expect, test } from "vitest";
import { type SlotCacheKeyInput, slotCacheKey, slotFileName } from "./cache.ts";

const base: SlotCacheKeyInput = {
  model: { sha256: "a".repeat(64) },
  chatTemplate: "{% for m in messages %}{{ m.content }}{% endfor %}",
  prefix: "You are a coding agent.",
  runtimeBuild: "b12359-b1b770d90",
};

describe("slotCacheKey", () => {
  test("is deterministic and a valid file name stem", () => {
    const key = slotCacheKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(slotCacheKey({ ...base })).toBe(key);
    expect(slotFileName(key)).toBe(`${key}.bin`);
    // String and byte prefixes with the same bytes are the same key.
    expect(slotCacheKey({ ...base, prefix: Buffer.from(base.prefix as string, "utf8") })).toBe(key);
  });

  test.each([
    ["model content", { model: { sha256: "b".repeat(64) } }],
    ["model file identity", { model: { path: "/m.gguf", sizeBytes: 1, mtimeMs: 2 } }],
    ["chat template", { chatTemplate: `${base.chatTemplate} ` }],
    ["prefix", { prefix: "You are a coding agent!" }],
    ["one more prefix byte", { prefix: `${base.prefix}\n` }],
    ["runtime build", { runtimeBuild: "b12360-0000000" }],
    ["extra", { extra: "q8_0" }],
  ] as const)("changes when the %s changes", (_what, change) => {
    expect(slotCacheKey({ ...base, ...change })).not.toBe(slotCacheKey(base));
  });

  test("field boundaries cannot be shifted to collide", () => {
    const a = slotCacheKey({ ...base, chatTemplate: "ab", prefix: "c" });
    const b = slotCacheKey({ ...base, chatTemplate: "a", prefix: "bc" });
    expect(a).not.toBe(b);
  });

  test("file-based identity tracks size and modification time", () => {
    const one = slotCacheKey({ ...base, model: { path: "/m.gguf", sizeBytes: 10, mtimeMs: 1 } });
    const touched = slotCacheKey({
      ...base,
      model: { path: "/m.gguf", sizeBytes: 10, mtimeMs: 2 },
    });
    expect(one).not.toBe(touched);
  });

  test("slot file names only accept real keys", () => {
    expect(() => slotFileName("../../etc/passwd")).toThrow();
    expect(() => slotFileName("A".repeat(64))).toThrow();
  });
});
