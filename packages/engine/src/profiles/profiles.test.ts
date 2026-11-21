import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { ModelProfile } from "../contracts/prompt.ts";
import {
  DEFAULT_PROFILE,
  getModelProfile,
  hasModelProfile,
  listModelProfileIds,
  type ModelProfileDetails,
} from "./index.ts";

async function catalogProfileIds(): Promise<string[]> {
  const file = new URL("../../../../catalog/catalog.json", import.meta.url);
  const catalog = JSON.parse(await readFile(file, "utf8")) as { entries: { profile: string }[] };
  return [...new Set(catalog.entries.map((e) => e.profile))];
}

function expectSane(profile: ModelProfileDetails) {
  const s = profile.sampling;
  if (s.temperature !== undefined) expect(s.temperature).toBeGreaterThanOrEqual(0);
  if (s.temperature !== undefined) expect(s.temperature).toBeLessThanOrEqual(2);
  if (s.topP !== undefined) expect(s.topP).toBeGreaterThan(0);
  if (s.topP !== undefined) expect(s.topP).toBeLessThanOrEqual(1);
  if (s.topK !== undefined) expect(Number.isInteger(s.topK) && s.topK >= 0).toBe(true);
  if (s.minP !== undefined) expect(s.minP >= 0 && s.minP < 1).toBe(true);
  if (s.presencePenalty !== undefined) expect(Math.abs(s.presencePenalty)).toBeLessThanOrEqual(2);
  if (s.repeatPenalty !== undefined)
    expect(s.repeatPenalty >= 1 && s.repeatPenalty <= 1.5).toBe(true);
  expect(Number.isInteger(profile.maxOutputTokens)).toBe(true);
  expect(profile.maxOutputTokens).toBeGreaterThanOrEqual(4_096);
  expect(profile.maxOutputTokens).toBeLessThanOrEqual(65_536);
  expect(profile.compactionThreshold).toBeGreaterThanOrEqual(0.5);
  expect(profile.compactionThreshold).toBeLessThanOrEqual(0.8);
  expect(profile.defaultEffort === null || profile.defaultEffort.length > 0).toBe(true);
  expect(typeof profile.parallelToolCalls).toBe("boolean");
}

describe("model profiles", () => {
  test("every profile id in the catalog resolves to its own profile", async () => {
    const ids = await catalogProfileIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(hasModelProfile(id), id).toBe(true);
      expect(getModelProfile(id).id).toBe(id);
    }
  });

  test("every shipped profile is used by the catalog", async () => {
    expect(listModelProfileIds().sort()).toEqual((await catalogProfileIds()).sort());
  });

  test("an unknown or missing id gets the default", () => {
    expect(getModelProfile("some-hand-loaded-gguf").id).toBe("default");
    expect(getModelProfile(null)).toEqual(DEFAULT_PROFILE);
    expect(getModelProfile(undefined)).toEqual(DEFAULT_PROFILE);
    expect(hasModelProfile("default")).toBe(false);
  });

  test("values are in sane ranges", () => {
    for (const id of listModelProfileIds()) expectSane(getModelProfile(id));
    expectSane(DEFAULT_PROFILE);
  });

  test("a profile satisfies the contract", () => {
    const profile: ModelProfile = getModelProfile("qwen3.8");
    expect(Object.keys(profile)).toEqual(
      expect.arrayContaining([
        "id",
        "sampling",
        "defaultEffort",
        "maxOutputTokens",
        "compactionThreshold",
        "parallelToolCalls",
      ]),
    );
  });

  test("follows each model card", () => {
    expect(getModelProfile("qwen3.8").sampling).toEqual({
      temperature: 1.0,
      topP: 0.95,
      topK: 20,
      minP: 0,
      presencePenalty: 0,
      repeatPenalty: 1.0,
    });
    expect(getModelProfile("qwen3.6").sampling.temperature).toBe(0.6);
    expect(getModelProfile("qwen3.6").chatTemplateKwargs).toEqual({ preserve_thinking: true });
    expect(getModelProfile("laguna-xs-2.1").chatTemplateKwargs).toEqual({ enable_thinking: true });
    // The harmony template renders one tool call per reply.
    expect(getModelProfile("gpt-oss").parallelToolCalls).toBe(false);
  });

  test("hands out copies", () => {
    const mine = getModelProfile("qwen3.8");
    mine.sampling.temperature = 0;
    expect(getModelProfile("qwen3.8").sampling.temperature).toBe(1.0);
  });
});
