import { readFile } from "node:fs/promises";
import type { Endpoint } from "@dawg/models";
import { describe, expect, test } from "vitest";
import { ModelError, type ModelReply, type ModelStreamEvent } from "../contracts/model.ts";
import { createModelClient } from "./client.ts";

/**
 * The client against byte-exact captures of llama-server b12359 (see
 * __fixtures__/llama-server/*.json). Each capture is replayed with its original network chunks.
 */

interface Capture {
  status: number;
  contentType: string;
  chunks: string[];
}

async function capture(name: string): Promise<Capture> {
  const path = new URL(`./__fixtures__/llama-server/${name}.json`, import.meta.url);
  return JSON.parse(await readFile(path, "utf8")) as Capture;
}

const endpoint: Endpoint = {
  kind: "bundled",
  baseUrl: "http://127.0.0.1:9/v1",
  model: "SmolLM2-135M-Instruct-Q4_0.gguf",
  contextWindow: 2048,
  capabilities: { tools: true, vision: false, reasoning: false, cacheControl: true },
};

function replay(c: Capture, split?: number): typeof fetch {
  const encoder = new TextEncoder();
  const pieces = c.chunks.flatMap((chunk) => {
    const bytes = encoder.encode(chunk);
    if (!split) return [bytes];
    const out: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += split) out.push(bytes.slice(i, i + split));
    return out;
  });
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const piece of pieces) controller.enqueue(piece);
          controller.close();
        },
      }),
      { status: c.status, headers: { "content-type": c.contentType } },
    );
}

async function run(name: string, split?: number) {
  const client = createModelClient(endpoint, { fetch: replay(await capture(name), split) });
  const events: ModelStreamEvent[] = [];
  for await (const event of client.stream({ messages: [], tools: [] })) events.push(event);
  const last = events.at(-1);
  if (last?.type !== "finished") throw new Error("no finished event");
  return { events, reply: last.reply };
}

async function failure(name: string): Promise<ModelError> {
  try {
    await run(name);
  } catch (error) {
    if (error instanceof ModelError) return error;
    throw error;
  }
  throw new Error("expected a ModelError");
}

const texts = (events: ModelStreamEvent[]) =>
  events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");

describe("replaying real llama-server streams", () => {
  test("a plain text reply with timings in the finish chunk", async () => {
    const { events, reply } = await run("stream-text");
    expect(texts(events)).toBe("Hello.");
    expect(reply).toMatchObject<Partial<ModelReply>>({
      content: "Hello.",
      reasoning: "",
      toolCalls: [],
      finishReason: "stop",
      model: "SmolLM2-135M-Instruct-Q4_0.gguf",
    });
    // No usage chunk: everything comes from timings.
    expect(reply.usage).toEqual({
      promptTokens: 27,
      completionTokens: 3,
      cachedTokens: 0,
      promptTokensPerSecond: 832.7935597298048,
      completionTokensPerSecond: 264.48029621793177,
      promptMs: 32.421,
      completionMs: 7.562,
    });
  });

  test("usage chunk with cached tokens", async () => {
    const { reply } = await run("stream-text-usage");
    expect(reply.usage).toMatchObject({ promptTokens: 27, completionTokens: 3, cachedTokens: 26 });
  });

  test("progress chunks, per-token timings and usage, split into 3-byte pieces", async () => {
    const { events, reply } = await run("stream-text-extras", 3);
    expect(events.filter((e) => e.type === "prompt_progress")).toEqual([
      { type: "prompt_progress", processed: 26, total: 27, cached: 26 },
      { type: "prompt_progress", processed: 27, total: 27, cached: 26 },
    ]);
    expect(events.findIndex((e) => e.type === "prompt_progress")).toBe(0);
    expect(reply.content).toBe("Hello.");
    expect(reply.usage).toMatchObject({ promptTokens: 27, cachedTokens: 26, completionTokens: 3 });
  });

  test("a long prompt's progress", async () => {
    const { events, reply } = await run("stream-progress");
    const progress = events.filter((e) => e.type === "prompt_progress");
    expect(progress.at(-1)).toEqual({
      type: "prompt_progress",
      processed: 1233,
      total: 1233,
      cached: 14,
    });
    expect(reply.finishReason).toBe("length");
    expect(reply.usage.promptTokens).toBe(1233);
  });

  test("a streamed tool call", async () => {
    const { events, reply } = await run("stream-tool-call", 5);
    const started = events.filter((e) => e.type === "tool_call_started");
    expect(started).toEqual([
      {
        type: "tool_call_started",
        index: 0,
        id: "TxlnPtclhK13AeUqk0bp4BDIqGKagiTm",
        name: "get_weather",
      },
    ]);
    expect(reply.finishReason).toBe("tool_calls");
    expect(reply.toolCalls).toHaveLength(1);
    expect(JSON.parse(reply.toolCalls[0]?.arguments ?? "")).toEqual({ city: "Paris" });
    const args = events.flatMap((e) => (e.type === "tool_call_delta" ? [e.arguments] : []));
    expect(args.join("")).toBe(reply.toolCalls[0]?.arguments);
  });

  test("a tool call cut short by max_tokens streams nothing and finishes with length", async () => {
    const { reply } = await run("stream-tool-call-truncated");
    expect(reply).toMatchObject({ content: "", toolCalls: [], finishReason: "length" });
  });

  test("reasoning deltas", async () => {
    const { events, reply } = await run("stream-reasoning");
    expect(events.some((e) => e.type === "reasoning_delta")).toBe(true);
    expect(reply.reasoning.startsWith("<idea>")).toBe(true);
    expect(reply.content).toBe("");
  });

  test("non-streamed bodies are accepted in place of a stream", async () => {
    const text = await run("nonstream-text");
    expect(text.reply).toMatchObject({ content: "Hello.", finishReason: "stop" });
    const tool = await run("nonstream-tool-call");
    expect(tool.reply.toolCalls).toEqual([
      {
        id: "3HnEKhyzylc3E8qS3UlloNKf2LwIx1dc",
        name: "get_weather",
        arguments: '{"city": "Paris"}',
      },
    ]);
    expect(tool.events.map((e) => e.type)).toEqual([
      "tool_call_started",
      "tool_call_delta",
      "finished",
    ]);
  });

  test("errors keep the server's message and map to the right kind", async () => {
    const overflow = await failure("error-context-overflow");
    expect(overflow).toMatchObject({ kind: "context_overflow", status: 400, retryable: false });
    expect(overflow.message).toContain("request (5320 tokens) exceeds the available context size");
    const auth = await failure("error-auth");
    expect(auth).toMatchObject({ kind: "http", status: 401, retryable: false });
    expect(auth.message).toBe("HTTP 401: Invalid API Key");
    const image = await failure("error-image-unsupported");
    expect(image).toMatchObject({ kind: "http", status: 500, retryable: false });
    const args = await failure("error-tool-arguments");
    expect(args).toMatchObject({ kind: "http", status: 500, retryable: false });
  });
});
