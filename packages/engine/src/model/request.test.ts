import type { Endpoint } from "@dawg/models";
import { describe, expect, test } from "vitest";
import type { Message } from "../contracts/messages.ts";
import type { ModelRequest, ToolSchema } from "../contracts/model.ts";
import {
  buildChatBody,
  buildCountBody,
  type RequestBuildOptions,
  SAMPLING_FIELDS,
  toChatMessages,
} from "./request.ts";

const endpoint = (kind: Endpoint["kind"] = "bundled"): Endpoint => ({
  kind,
  baseUrl: "http://127.0.0.1:1/v1",
  model: "test-model",
  contextWindow: 8192,
  capabilities: { tools: true, vision: true, reasoning: true, cacheControl: kind === "bundled" },
});

const send: RequestBuildOptions = {
  images: "send",
  reasoningField: "reasoning_content",
  includeUsage: true,
};

const png = { type: "image" as const, mediaType: "image/png", data: "iVBORw0KGgo=" };

const tools: ToolSchema[] = [
  {
    name: "Read",
    description: "Reads a file.",
    parameters: {
      type: "object",
      properties: { file_path: { type: "string" }, offset: { type: "number" } },
      required: ["file_path"],
    },
  },
];

const history: Message[] = [
  { role: "system", content: "You are a coding agent." },
  { role: "user", kind: "prompt", content: [{ type: "text", text: "Read a.txt" }] },
  {
    role: "assistant",
    content: "",
    reasoning: "I should read it.",
    toolCalls: [
      {
        id: "call_1",
        name: "Read",
        arguments: '{"file_path":"a.txt"}',
        rawArguments: '{"file_path":"a.txt",}',
      },
    ],
  },
  {
    role: "tool",
    toolCallId: "call_1",
    toolName: "Read",
    content: [{ type: "text", text: "1\thello" }],
    isError: false,
  },
  { role: "assistant", content: "It says hello.", toolCalls: [] },
  { role: "user", kind: "note", content: [{ type: "text", text: "The date is now 2026-11-22." }] },
];

const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
  messages: history,
  tools,
  ...extra,
});

describe("toChatMessages", () => {
  test("system, user, assistant with reasoning and calls, tool results", () => {
    expect(toChatMessages(history, send)).toEqual([
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: "Read a.txt" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "I should read it.",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "Read", arguments: '{"file_path":"a.txt"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "1\thello" },
      { role: "assistant", content: "It says hello." },
      { role: "user", content: "The date is now 2026-11-22." },
    ]);
  });

  test("the reasoning field can be renamed or left out", () => {
    const reasoningOnly = history.slice(2, 3);
    expect(
      toChatMessages(reasoningOnly, { ...send, reasoningField: "reasoning" })[0],
    ).toMatchObject({
      reasoning: "I should read it.",
    });
    expect(toChatMessages(reasoningOnly, { ...send, reasoningField: null })[0]).not.toHaveProperty(
      "reasoning_content",
    );
  });

  test("text-only user content becomes one string; mixed content becomes parts with data URLs", () => {
    const messages: Message[] = [
      {
        role: "user",
        kind: "prompt",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
      { role: "user", kind: "prompt", content: [{ type: "text", text: "Look:" }, png] },
    ];
    expect(toChatMessages(messages, send)).toEqual([
      { role: "user", content: "first\n\nsecond" },
      {
        role: "user",
        content: [
          { type: "text", text: "Look:" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ],
      },
    ]);
  });

  test("images in tool results follow the run of tool messages in one user message", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "Screenshot", arguments: "{}" },
          { id: "b", name: "Read", arguments: "{}" },
        ],
      },
      {
        role: "tool",
        toolCallId: "a",
        toolName: "Screenshot",
        content: [{ type: "text", text: "Captured." }, png],
        isError: false,
      },
      {
        role: "tool",
        toolCallId: "b",
        toolName: "Read",
        content: [{ type: "text", text: "text file" }],
        isError: false,
      },
      { role: "assistant", content: "Done.", toolCalls: [] },
    ];
    const out = toChatMessages(messages, send);
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user", "assistant"]);
    expect(out[1]).toEqual({
      role: "tool",
      tool_call_id: "a",
      content: "Captured.\n\n[1 image from this result follows the tool results]",
    });
    expect(out[3]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Image output of tool call a (Screenshot):" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    });
  });

  test("without vision, images become text notes and no extra message is added", () => {
    const messages: Message[] = [
      { role: "user", kind: "prompt", content: [{ type: "text", text: "Look:" }, png] },
      { role: "tool", toolCallId: "a", toolName: "Shot", content: [png], isError: true },
    ];
    expect(toChatMessages(messages, { ...send, images: "omit" })).toEqual([
      { role: "user", content: "Look:\n\n[image omitted: this model cannot view images]" },
      {
        role: "tool",
        tool_call_id: "a",
        content: "[image omitted: this model cannot view images]",
      },
    ]);
  });
});

describe("serialisation is deterministic", () => {
  test("the same input always gives byte-identical JSON", () => {
    const first = JSON.stringify(buildChatBody(endpoint(), request({ slot: 1 }), send));
    for (let i = 0; i < 5; i++) {
      const copy = structuredClone(request({ slot: 1 }));
      expect(JSON.stringify(buildChatBody(endpoint(), copy, send))).toBe(first);
    }
  });

  test("appending a message leaves the earlier messages' JSON unchanged", () => {
    for (let n = 1; n < history.length; n++) {
      const before = JSON.stringify(toChatMessages(history.slice(0, n), send));
      const after = JSON.stringify(toChatMessages(history.slice(0, n + 1), send));
      expect(after.startsWith(before.slice(0, -1))).toBe(true);
    }
  });

  test("the message order inside an object never depends on how the input was built", () => {
    const shuffled: Message = {
      toolCalls: [],
      content: "It says hello.",
      role: "assistant",
    } as Message;
    expect(JSON.stringify(toChatMessages([shuffled], send))).toBe(
      JSON.stringify(toChatMessages([history[4] as Message], send)),
    );
  });
});

describe("buildChatBody", () => {
  test("bundled requests carry the runtime extras", () => {
    const body = buildChatBody(endpoint("bundled"), request({ slot: 2 }), send);
    expect(body).toMatchObject({
      model: "test-model",
      stream: true,
      stream_options: { include_usage: true },
      cache_prompt: true,
      id_slot: 2,
      timings_per_token: true,
      return_progress: true,
    });
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "Read", description: "Reads a file.", parameters: tools[0]?.parameters },
      },
    ]);
    expect(buildChatBody(endpoint("bundled"), request(), send)).not.toHaveProperty("id_slot");
  });

  test.each(["ollama", "lmstudio", "remote"] as const)("%s requests are plain OpenAI", (kind) => {
    const body = buildChatBody(endpoint(kind), request({ slot: 2 }), send);
    for (const extra of ["cache_prompt", "id_slot", "timings_per_token", "return_progress"]) {
      expect(body).not.toHaveProperty(extra);
    }
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test("optional fields are sent only when set", () => {
    const bare = buildChatBody(endpoint(), request(), { ...send, includeUsage: false });
    for (const field of [
      "tool_choice",
      "max_tokens",
      "reasoning_effort",
      "parallel_tool_calls",
      "stream_options",
      "temperature",
    ]) {
      expect(bare).not.toHaveProperty(field);
    }
    const full = buildChatBody(
      endpoint(),
      request({
        toolChoice: "required",
        maxOutputTokens: 100,
        reasoningEffort: "high",
        parallelToolCalls: true,
      }),
      send,
    );
    expect(full).toMatchObject({
      tool_choice: "required",
      max_tokens: 100,
      reasoning_effort: "high",
      parallel_tool_calls: true,
    });
  });

  test("no tools: no tools, tool_choice or parallel_tool_calls fields", () => {
    const body = buildChatBody(
      endpoint(),
      request({ tools: [], toolChoice: "auto", parallelToolCalls: true }),
      send,
    );
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  test("template facts filter effort levels and parallel calls", () => {
    const template = { reasoningEffortLevels: ["low", "high"], parallelToolCalls: false };
    const opts = { ...send, template };
    const ok = buildChatBody(
      endpoint(),
      request({ reasoningEffort: "low", parallelToolCalls: true }),
      opts,
    );
    expect(ok.reasoning_effort).toBe("low");
    expect(ok).not.toHaveProperty("parallel_tool_calls");
    const unknown = buildChatBody(endpoint(), request({ reasoningEffort: "max" }), opts);
    expect(unknown).not.toHaveProperty("reasoning_effort");
  });

  test("sampling maps to fields by endpoint kind", () => {
    const sampling = {
      temperature: 0.2,
      topP: 0.9,
      topK: 20,
      minP: 0.05,
      repeatPenalty: 1.1,
      presencePenalty: 0.5,
      frequencyPenalty: 0.1,
      seed: 7,
    };
    expect(buildChatBody(endpoint("bundled"), request({ sampling }), send)).toMatchObject({
      temperature: 0.2,
      top_p: 0.9,
      top_k: 20,
      min_p: 0.05,
      repeat_penalty: 1.1,
      presence_penalty: 0.5,
      frequency_penalty: 0.1,
      seed: 7,
    });
    const remote = buildChatBody(endpoint("remote"), request({ sampling }), send);
    expect(remote).toMatchObject({ temperature: 0.2, top_p: 0.9, seed: 7 });
    for (const field of ["top_k", "min_p", "repeat_penalty"])
      expect(remote).not.toHaveProperty(field);
    expect(SAMPLING_FIELDS.map((f) => f.param).sort()).toEqual(Object.keys(sampling).sort());
  });

  test("extraBody merges last and can override", () => {
    const body = buildChatBody(
      endpoint(),
      request({
        extraBody: { chat_template_kwargs: { enable_thinking: false }, cache_prompt: false },
      }),
      send,
    );
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.cache_prompt).toBe(false);
    expect(Object.keys(body).at(-1)).toBe("chat_template_kwargs");
  });

  test("the count body holds only the prompt", () => {
    expect(Object.keys(buildCountBody(endpoint(), request(), send))).toEqual([
      "model",
      "messages",
      "tools",
    ]);
    expect(Object.keys(buildCountBody(endpoint(), { messages: history, tools: [] }, send))).toEqual(
      ["model", "messages"],
    );
  });
});
