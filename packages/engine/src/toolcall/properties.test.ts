/**
 * Properties of the argument parser, checked over seeded random inputs so failures reproduce.
 */
import { describe, expect, test } from "vitest";
import { parseToolArguments } from "./json-parse.ts";
import { isPlainObject, sameJson, serializeArguments } from "./values.ts";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARS = [
  ..."abcXYZ019 _-./:",
  '"',
  "'",
  "\\",
  "\n",
  "\t",
  "{",
  "}",
  "[",
  "]",
  ",",
  ":",
  "é",
  "😀",
  "\u0000",
  " ",
  "`",
];
const KEYS = ["file_path", "content", "a", "b", "todos", "__proto__", "x y", "", "-i", "1"];

function randomString(r: () => number): string {
  const n = Math.floor(r() * 12);
  let s = "";
  for (let i = 0; i < n; i++) s += CHARS[Math.floor(r() * CHARS.length)];
  return s;
}

function randomValue(r: () => number, depth: number): unknown {
  const pick = Math.floor(r() * (depth > 3 ? 5 : 7));
  switch (pick) {
    case 0:
      return randomString(r);
    case 1:
      return Math.floor((r() - 0.5) * 1e6);
    case 2:
      return (r() - 0.5) * 10 ** Math.floor(r() * 20 - 10);
    case 3:
      return r() < 0.5;
    case 4:
      return null;
    case 5:
      return Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, depth + 1));
    default:
      return randomObject(r, depth + 1);
  }
}

function randomObject(r: () => number, depth = 0): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const n = Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const key = r() < 0.7 ? (KEYS[Math.floor(r() * KEYS.length)] ?? "k") : randomString(r);
    Object.defineProperty(obj, key, {
      value: randomValue(r, depth),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return obj;
}

const SAMPLES = 400;

function samples(seed: number): Record<string, unknown>[] {
  const r = rng(seed);
  return Array.from({ length: SAMPLES }, () => randomObject(r));
}

/** Every value in `part` is also in `whole` at the same place; arrays may be shorter. */
function containedIn(part: unknown, whole: unknown): boolean {
  if (Array.isArray(part)) {
    return (
      Array.isArray(whole) &&
      part.length <= whole.length &&
      part.every((v, i) => containedIn(v, whole[i]))
    );
  }
  if (isPlainObject(part)) {
    return (
      isPlainObject(whole) &&
      Object.keys(part).every((k) => Object.hasOwn(whole, k) && containedIn(part[k], whole[k]))
    );
  }
  return Object.is(part, whole) || (part === 0 && whole === 0);
}

describe("parser properties", () => {
  test("any valid JSON object passes through unchanged and unrepaired", () => {
    for (const obj of samples(1)) {
      for (const text of [JSON.stringify(obj), JSON.stringify(obj, null, 2)]) {
        const r = parseToolArguments(text);
        expect(r.ok, text).toBe(true);
        if (!r.ok) continue;
        expect(r.repaired, text).toBe(false);
        expect(r.repairs).toEqual([]);
        expect(sameJson(r.value, JSON.parse(text)), text).toBe(true);
      }
    }
  });

  test("never throws, and any success is a plain object that round-trips", () => {
    const r = rng(2);
    const inputs: string[] = [];
    for (let i = 0; i < 3000; i++) inputs.push(randomString(r) + randomString(r));
    // Mutations of valid arguments: the realistic kind of garbage.
    for (const obj of samples(3)) {
      const text = JSON.stringify(obj);
      for (let k = 0; k < 4; k++) {
        const at = Math.floor(r() * (text.length + 1));
        const roll = r();
        const ch = CHARS[Math.floor(r() * CHARS.length)] ?? "";
        if (roll < 0.33) inputs.push(text.slice(0, at) + text.slice(at + 1));
        else if (roll < 0.66) inputs.push(text.slice(0, at) + ch + text.slice(at));
        else inputs.push(text.slice(0, at) + ch + text.slice(at + 1));
      }
    }
    for (const input of inputs) {
      let result: ReturnType<typeof parseToolArguments> | undefined;
      expect(() => {
        result = parseToolArguments(input);
      }, input).not.toThrow();
      if (result?.ok) {
        expect(isPlainObject(result.value)).toBe(true);
        expect(sameJson(JSON.parse(serializeArguments(result.value)), result.value)).toBe(true);
      }
    }
  });

  test("every prefix fails or yields only values present in the original", () => {
    for (const obj of samples(4).slice(0, 150)) {
      for (const text of [JSON.stringify(obj), JSON.stringify(obj, null, 1)]) {
        for (let end = 0; end < text.length; end++) {
          const prefix = text.slice(0, end);
          const r = parseToolArguments(prefix);
          if (!r.ok) continue;
          expect(containedIn(r.value, obj), `prefix ${JSON.stringify(prefix)}`).toBe(true);
        }
      }
    }
  });

  test("no prefix ever yields a shortened string", () => {
    const content = 'line one\nline two with "quotes" and \\backslashes\\ and {braces}';
    const text = JSON.stringify({ file_path: "/a.txt", content, mode: "w" });
    for (let end = 0; end < text.length; end++) {
      const r = parseToolArguments(text.slice(0, end));
      if (!r.ok || r.value.content === undefined) continue;
      expect(r.value.content).toBe(content);
    }
  });

  test("canonical serialisation is stable", () => {
    const r = rng(5);
    for (const obj of samples(6)) {
      const variants = [
        JSON.stringify(obj),
        JSON.stringify(obj, null, 2),
        `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``,
        JSON.stringify(JSON.stringify(obj)),
      ];
      const text = variants[Math.floor(r() * variants.length)] ?? "";
      const first = parseToolArguments(text);
      expect(first.ok, text).toBe(true);
      if (!first.ok) continue;
      const once = serializeArguments(first.value);
      const second = parseToolArguments(once);
      expect(second.ok && !second.repaired).toBe(true);
      if (!second.ok) continue;
      expect(serializeArguments(second.value)).toBe(once);
      expect(serializeArguments(first.value)).toBe(once);
    }
  });
});
