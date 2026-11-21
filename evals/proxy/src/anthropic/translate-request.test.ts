import { describe, expect, test } from "vitest";
import { TranslationError, translateRequest } from "./translate-request.ts";

const opts = { upstreamModel: null, includeUsage: true };

describe("translateRequest", () => {
  test("plain text with a system prompt given as text blocks", () => {
    const { body, requestedModel, stream } = translateRequest(
      {
        model: "claude-x",
        max_tokens: 1024,
        temperature: 0.2,
        top_p: 0.9,
        top_k: 40,
        stop_sequences: ["END"],
        metadata: { user_id: "u" },
        system: [
          { type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } },
          { type: "text", text: "Be brief." },
        ],
        messages: [{ role: "user", content: "Hello" }],
      },
      opts,
    );
    expect(requestedModel).toBe("claude-x");
    expect(stream).toBe(false);
    expect(body).toEqual({
      model: "claude-x",
      messages: [
        { role: "system", content: "You are helpful.\n\nBe brief." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 1024,
      temperature: 0.2,
      top_p: 0.9,
      stop: ["END"],
    });
  });

  test("a multi-turn tool loop", () => {
    const { body } = translateRequest(
      {
        model: "m",
        max_tokens: 100,
        stream: true,
        tools: [
          {
            name: "Read",
            description: "Read a file",
            input_schema: { type: "object", properties: { path: { type: "string" } } },
            cache_control: { type: "ephemeral" },
          },
          { type: "web_search_20250305", name: "web_search", max_uses: 3 },
        ],
        messages: [
          { role: "user", content: [{ type: "text", text: "Read a.ts" }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I should read it.", signature: "sig" },
              { type: "redacted_thinking", data: "opaque" },
              { type: "text", text: "Reading." },
              { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.ts" } },
              { type: "tool_use", id: "toolu_2", name: "Read", input: { path: "b.ts" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "export const a = 1;" },
              {
                type: "tool_result",
                tool_use_id: "toolu_2",
                is_error: true,
                content: [{ type: "text", text: "ENOENT" }],
              },
              { type: "text", text: "Continue." },
            ],
          },
        ],
      },
      opts,
    );
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "Read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ]);
    expect(body.messages).toEqual([
      { role: "user", content: "Read a.ts" },
      {
        role: "assistant",
        content: "Reading.",
        reasoning_content: "I should read it.",
        tool_calls: [
          {
            id: "toolu_1",
            type: "function",
            function: { name: "Read", arguments: '{"path":"a.ts"}' },
          },
          {
            id: "toolu_2",
            type: "function",
            function: { name: "Read", arguments: '{"path":"b.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "export const a = 1;" },
      { role: "tool", tool_call_id: "toolu_2", content: "Error: ENOENT" },
      { role: "user", content: "Continue." },
    ]);
  });

  test("assistant turn with only tool calls has null content", () => {
    const { body } = translateRequest(
      {
        model: "m",
        messages: [
          { role: "user", content: "x" },
          { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] },
        ],
      },
      opts,
    );
    expect((body.messages as unknown[])[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t", type: "function", function: { name: "Bash", arguments: "{}" } }],
    });
  });

  test("images: base64 and url, in user turns and tool results", () => {
    const { body } = translateRequest(
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              { type: "image", source: { type: "url", url: "https://example.com/a.jpg" } },
              { type: "text", text: "What is this?" },
            ],
          },
          { role: "assistant", content: [{ type: "tool_use", id: "s", name: "Shot", input: {} }] },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "s",
                content: [
                  { type: "text", text: "screenshot taken" },
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/jpeg", data: "BBBB" },
                  },
                ],
              },
            ],
          },
        ],
      },
      opts,
    );
    const messages = body.messages as Record<string, unknown>[];
    expect(messages[0]).toEqual({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "image_url", image_url: { url: "https://example.com/a.jpg" } },
        { type: "text", text: "What is this?" },
      ],
    });
    expect(messages[2]).toEqual({
      role: "tool",
      tool_call_id: "s",
      content: "screenshot taken\n[image attached below]",
    });
    expect(messages[3]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Image output of tool call s:" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } },
      ],
    });
  });

  test("tool_choice variants", () => {
    const tools = [{ name: "Read", input_schema: { type: "object" } }];
    const choice = (tool_choice: unknown) => {
      const { body } = translateRequest({ model: "m", messages: [], tools, tool_choice }, opts);
      return [body.tool_choice, body.parallel_tool_calls];
    };
    expect(choice({ type: "auto" })).toEqual(["auto", undefined]);
    expect(choice({ type: "any" })).toEqual(["required", undefined]);
    expect(choice({ type: "tool", name: "Read" })).toEqual([
      { type: "function", function: { name: "Read" } },
      undefined,
    ]);
    expect(choice({ type: "none" })).toEqual(["none", undefined]);
    expect(choice({ type: "auto", disable_parallel_tool_use: true })).toEqual(["auto", false]);
    expect(choice(undefined)).toEqual([undefined, undefined]);
    // No tools left after dropping server tools: no tool_choice either.
    const { body } = translateRequest(
      {
        model: "m",
        messages: [],
        tools: [{ type: "bash_20250124", name: "bash" }],
        tool_choice: { type: "any" },
      },
      opts,
    );
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  test("unknown and provider-specific fields are dropped, not rejected", () => {
    const { body } = translateRequest(
      {
        model: "m",
        max_tokens: 10,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        context_management: { edits: [] },
        mcp_servers: [],
        service_tier: "auto",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi", cache_control: { type: "ephemeral" }, citations: null },
              { type: "some_future_block", foo: 1 },
              {
                type: "document",
                source: { type: "text", media_type: "text/plain", data: "doc body" },
                title: "Doc",
              },
            ],
          },
        ],
      },
      opts,
    );
    expect(body).toEqual({
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi\n\nDoc\ndoc body" }],
    });
  });

  test("upstream model override and no stream_options when usage injection is off", () => {
    const { body, requestedModel } = translateRequest(
      { model: "claude-x", stream: true, messages: [] },
      { upstreamModel: "qwen", includeUsage: false },
    );
    expect(requestedModel).toBe("claude-x");
    expect(body.model).toBe("qwen");
    expect(body.stream_options).toBeUndefined();
  });

  test("rejects bodies without messages", () => {
    expect(() => translateRequest({ model: "m" }, opts)).toThrow(TranslationError);
    expect(() => translateRequest("nope", opts)).toThrow(TranslationError);
  });
});
