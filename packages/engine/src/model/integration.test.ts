import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Endpoint,
  ensureTestModel,
  RuntimeSupervisor,
  readRuntimeLock,
  resolveRuntimeBinary,
} from "@dawg/models";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Message } from "../contracts/messages.ts";
import type {
  ModelClient,
  ModelReply,
  ModelRequest,
  ModelStreamEvent,
  ToolSchema,
} from "../contracts/model.ts";
import { createModelClient } from "./client.ts";

/**
 * Opt-in: DAWG_RUNTIME_TESTS=1 (the switch packages/models uses). Runs the pinned llama-server
 * with the tiny test model from runtime.lock.json. The model's own template knows no tools, so
 * the server is given a small tool-capable ChatML template (__fixtures__/tools-template.jinja).
 * On b12359 `tool_choice: "required"` is not enforced by a grammar with this template; the
 * prompt below makes the model call the tool anyway at temperature 0.
 */

const enabled = process.env.DAWG_RUNTIME_TESTS === "1";
const template = fileURLToPath(new URL("./__fixtures__/tools-template.jinja", import.meta.url));

const tools: ToolSchema[] = [
  {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
  {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

const system: Message = { role: "system", content: "You are a helpful assistant." };
const user = (text: string): Message => ({
  role: "user",
  kind: "prompt",
  content: [{ type: "text", text }],
});

describe.skipIf(!enabled)("model client against the real llama-server", () => {
  let work: string;
  let sup: RuntimeSupervisor;
  let endpoint: Endpoint;
  let client: ModelClient;

  async function ask(request: ModelRequest) {
    const events: ModelStreamEvent[] = [];
    for await (const event of client.stream(request)) events.push(event);
    const last = events.at(-1);
    if (last?.type !== "finished") throw new Error("no finished event");
    return { events, reply: last.reply as ModelReply };
  }

  beforeAll(async () => {
    const lock = await readRuntimeLock();
    const binary = (await resolveRuntimeBinary()).binary;
    const model = await ensureTestModel({ pin: lock.testModel });
    work = await mkdtemp(join(tmpdir(), "dawg-model-client-it-"));
    sup = new RuntimeSupervisor({
      binary,
      model: { path: model, sha256: lock.testModel.sha256 },
      contextSize: 4096,
      slots: 1,
      settings: {
        cacheRamMiB: 64,
        ctxCheckpoints: 2,
        checkpointMinStep: 256,
        extraArgs: ["--chat-template-file", template],
      },
      paths: {
        slotSaveDir: join(work, "slots"),
        logDir: join(work, "logs"),
        keyDir: join(work, "keys"),
      },
      timing: { loadTimeoutMs: 180_000, healthIntervalMs: 100 },
    });
    endpoint = await sup.start();
    const caps = sup.serverInfo?.templateCaps ?? {};
    client = createModelClient(endpoint, {
      template: {
        parallelToolCalls: caps.supports_parallel_tool_calls,
        reasoningEffortLevels: caps.reasoning_effort_levels,
      },
    });
  }, 600_000);

  afterAll(async () => {
    await sup?.stop();
    const running = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((line) => work && line.includes(work));
    if (work) await rm(work, { recursive: true, force: true });
    expect(running).toEqual([]);
  }, 60_000);

  test("streams text with usage, timings and progress", async () => {
    const { events, reply } = await ask({
      messages: [system, user("Say hello in one short sentence.")],
      tools: [],
      maxOutputTokens: 16,
      sampling: { temperature: 0, seed: 1 },
      slot: 0,
    });
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.some((e) => e.type === "prompt_progress")).toBe(true);
    expect(reply.content.trim().length).toBeGreaterThan(0);
    expect(["stop", "length"]).toContain(reply.finishReason);
    expect(reply.model).toEqual(expect.any(String));
    expect(reply.usage).toEqual({
      promptTokens: expect.any(Number),
      completionTokens: expect.any(Number),
      cachedTokens: expect.any(Number),
      promptTokensPerSecond: expect.any(Number),
      completionTokensPerSecond: expect.any(Number),
      promptMs: expect.any(Number),
      completionMs: expect.any(Number),
    });
  }, 120_000);

  test("a tool call", async () => {
    const { events, reply } = await ask({
      messages: [system, user("Weather in Paris and in Rome? Call the tool twice.")],
      tools,
      toolChoice: "required",
      parallelToolCalls: true,
      maxOutputTokens: 64,
      sampling: { temperature: 0, seed: 1 },
      slot: 0,
    });
    console.log(`[model client integration] tool calls: ${JSON.stringify(reply.toolCalls)}`);
    expect(reply.finishReason).toBe("tool_calls");
    expect(reply.toolCalls.length).toBeGreaterThanOrEqual(1);
    const call = reply.toolCalls[0];
    expect(call?.name).toBe("get_weather");
    expect(call?.id.length).toBeGreaterThan(0);
    expect(JSON.parse(call?.arguments ?? "")).toEqual({ city: expect.any(String) });
    expect(events.find((e) => e.type === "tool_call_started")).toMatchObject({
      index: 0,
      name: "get_weather",
    });
  }, 120_000);

  test("a repeated prefix is reused from the cache", async () => {
    const first: Message[] = [
      system,
      user(`Here are some notes. ${"The sky is blue. ".repeat(40)} Summarise them.`),
    ];
    const a = await ask({ messages: first, tools: [], maxOutputTokens: 4, slot: 0 });
    const b = await ask({
      messages: [
        ...first,
        { role: "assistant", content: a.reply.content, toolCalls: [] },
        user("Shorter, please."),
      ],
      tools: [],
      maxOutputTokens: 4,
      slot: 0,
    });
    const reused = b.reply.usage.cachedTokens ?? 0;
    console.log(
      `[model client integration] first prompt ${a.reply.usage.promptTokens} tokens; second reused ${reused} of ${b.reply.usage.promptTokens}`,
    );
    expect(reused).toBeGreaterThan(0.8 * (a.reply.usage.promptTokens ?? 0));
  }, 120_000);

  test("a history with reasoning, a tool call and an image result is accepted", async () => {
    // The test model has no projector, so endpoint.capabilities.vision is false and the image
    // goes as a text note; sent as an image, the server would answer HTTP 500.
    expect(endpoint.capabilities.vision).toBe(false);
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const { reply } = await ask({
      messages: [
        system,
        user("Take a screenshot."),
        {
          role: "assistant",
          content: "",
          reasoning: "A screenshot is needed.",
          toolCalls: [{ id: "call_1", name: "read_file", arguments: '{"path":"shot.png"}' }],
        },
        {
          role: "tool",
          toolCallId: "call_1",
          toolName: "read_file",
          content: [
            { type: "text", text: "The file is an image." },
            { type: "image", mediaType: "image/png", data: png },
          ],
          isError: false,
        },
      ],
      tools,
      maxOutputTokens: 4,
      slot: 0,
    });
    expect(["stop", "length", "tool_calls"]).toContain(reply.finishReason);
  }, 120_000);

  test("countTokens matches the prompt tokens the server reports", async () => {
    const messages = [system, user("Count me, please.")];
    const counted = await client.countTokens({ messages, tools });
    const { reply } = await ask({ messages, tools, maxOutputTokens: 1, slot: 0 });
    expect(counted).toBe(reply.usage.promptTokens);
  }, 120_000);
});
