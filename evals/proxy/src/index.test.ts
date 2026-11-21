import { expect, test } from "vitest";
import { ProxyRecordSchema, packageName, startProxy } from "./index.ts";

test("package is wired up", () => {
  expect(packageName).toBe("@dawg/eval-proxy");
  expect(typeof startProxy).toBe("function");
});

test("the record schema accepts the contract example", () => {
  const record = {
    seq: 1,
    started_at: "2026-11-20T10:00:00.000Z",
    duration_ms: 1234,
    api: "openai.chat",
    path: "/v1/chat/completions",
    model: "qwen",
    stream: true,
    status: 200,
    request: { messages: 12, tools: 9, body_bytes: 45678 },
    usage: { prompt_tokens: 1234, completion_tokens: 56, cached_tokens: null },
    timings: {
      cache_n: 1200,
      prompt_n: 34,
      prompt_per_second: 250.1,
      predicted_n: 56,
      predicted_per_second: 31.2,
      prompt_ms: null,
      predicted_ms: null,
    },
    tool_calls: [
      {
        name: "Edit",
        arguments_valid_json: true,
        schema_valid: true,
        error: null,
        id: "c",
        arguments_bytes: 10,
      },
    ],
    finish_reason: "tool_calls",
    error: null,
    method: "POST",
    label: null,
    upstream_path: "/v1/chat/completions",
    upstream_model: null,
    ttfb_ms: 12,
    usage_injected: true,
  };
  expect(ProxyRecordSchema.parse(record)).toEqual(record);
});
