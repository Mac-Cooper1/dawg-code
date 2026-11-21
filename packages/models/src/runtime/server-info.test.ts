import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { CatalogEntry } from "../types.ts";
import {
  bundledEndpoint,
  deriveCapabilities,
  parseServerInfo,
  type ServerInfo,
} from "./server-info.ts";

// Captured from the real llama-server b12359 with SmolLM2-135M-Instruct, -c 4096 -np 2.
const props = JSON.parse(
  await readFile(new URL("./__fixtures__/llama-props-b12359.json", import.meta.url), "utf8"),
);
const models = JSON.parse(
  await readFile(new URL("./__fixtures__/llama-models-b12359.json", import.meta.url), "utf8"),
);

const catalog = (caps: CatalogEntry["capabilities"]): CatalogEntry => ({
  id: "x",
  displayName: "X",
  licence: { spdx: "Apache-2.0", url: "https://example.invalid" },
  source: {
    repo: "o/r",
    revision: "0".repeat(40),
    file: "x.gguf",
    sha256: "0".repeat(64),
    sizeBytes: 1,
  },
  minMemoryBytes: 1,
  context: { default: 1, max: 1 },
  capabilities: caps,
  profile: "p",
  rank: 1,
});

describe("parseServerInfo", () => {
  test("reads the real b12359 responses", () => {
    const info = parseServerInfo(props, models);
    expect(info).toMatchObject({
      modelId: "/models/SmolLM2-135M-Instruct-Q4_0.gguf",
      contextWindow: 2048,
      trainedContext: 8192,
      totalSlots: 2,
      vision: false,
      buildInfo: "b12359-b1b770d90",
      isSleeping: false,
    });
    expect(info.chatTemplate).toContain("<|im_start|>");
    expect(info.templateCaps.supports_tools).toBe(false);
  });

  test("rejects a response without the fields the app relies on", () => {
    expect(() => parseServerInfo({ total_slots: 1 }, models)).toThrow();
    expect(() => parseServerInfo(props, { data: [] })).toThrow();
  });
});

describe("deriveCapabilities", () => {
  const info = (overrides: Partial<ServerInfo>): ServerInfo => ({
    ...parseServerInfo(props, models),
    ...overrides,
  });

  test("tools need template support; the catalog can only remove them", () => {
    const toolTemplate = info({
      templateCaps: { supports_tools: true, supports_tool_calls: true },
    });
    expect(deriveCapabilities(toolTemplate).tools).toBe(true);
    expect(
      deriveCapabilities(toolTemplate, catalog({ tools: false, vision: false, reasoning: false }))
        .tools,
    ).toBe(false);
    expect(
      deriveCapabilities(info({}), catalog({ tools: true, vision: false, reasoning: false })).tools,
    ).toBe(false);
  });

  test("vision needs a loaded projector", () => {
    expect(deriveCapabilities(info({ vision: true })).vision).toBe(true);
    expect(
      deriveCapabilities(
        info({ vision: false }),
        catalog({ tools: false, vision: true, reasoning: false }),
      ).vision,
    ).toBe(false);
  });

  test("reasoning comes from the catalog, else from template hints", () => {
    expect(deriveCapabilities(info({})).reasoning).toBe(false);
    expect(
      deriveCapabilities(info({ chatTemplate: "{% if enable_thinking %}<think>{% endif %}" }))
        .reasoning,
    ).toBe(true);
    expect(
      deriveCapabilities(info({ templateCaps: { supports_reasoning_effort: true } })).reasoning,
    ).toBe(true);
    expect(
      deriveCapabilities(info({}), catalog({ tools: false, vision: false, reasoning: true }))
        .reasoning,
    ).toBe(true);
  });

  test("the bundled endpoint is loopback, keyed and cache-capable", () => {
    const endpoint = bundledEndpoint(40001, "k", info({}));
    expect(endpoint).toEqual({
      kind: "bundled",
      baseUrl: "http://127.0.0.1:40001/v1",
      apiKey: "k",
      model: "/models/SmolLM2-135M-Instruct-Q4_0.gguf",
      contextWindow: 2048,
      capabilities: { tools: false, vision: false, reasoning: false, cacheControl: true },
    });
  });
});
