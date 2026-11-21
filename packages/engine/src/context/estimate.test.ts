import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { Message } from "../contracts/messages.ts";
import type { ToolSchema } from "../contracts/model.ts";
import { buildPromptPrefix } from "../prompt/index.ts";
import { CORE_TOOLS } from "../tools/index.ts";
import { createTokenEstimator, DEFAULT_IMAGE_TOKENS, textTokens } from "./estimate.ts";

interface ChatRequest {
  messages: { role: string; content: string }[];
  tools?: { function: { name: string; description: string; parameters: object } }[];
}

async function request(name: string): Promise<ChatRequest> {
  const file = new URL(`../model/__fixtures__/llama-server/${name}.json`, import.meta.url);
  return (JSON.parse(await readFile(file, "utf8")) as { request: ChatRequest }).request;
}

function toEngine(req: ChatRequest): { messages: Message[]; tools: ToolSchema[] } {
  const messages = req.messages.map((m): Message => {
    if (m.role === "system") return { role: "system", content: m.content };
    return { role: "user", kind: "prompt", content: [{ type: "text", text: m.content }] };
  });
  const tools = (req.tools ?? []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters as ToolSchema["parameters"],
  }));
  return { messages, tools };
}

const estimator = createTokenEstimator();

describe("against real llama-server counts", () => {
  /**
   * Prompts captured from llama-server b12359 with the token count it reported (SmolLM2-135M's
   * tokenizer). The overflow capture's 900-phrase prompt is stored trimmed; it is rebuilt here
   * from the generator recorded in the capture's comment.
   */
  const cases: { name: string; load: () => Promise<ChatRequest>; real: number }[] = [
    { name: "a short chat (nonstream-text)", load: () => request("nonstream-text"), real: 27 },
    {
      name: "a thinking template (stream-reasoning)",
      load: () => request("stream-reasoning"),
      real: 30,
    },
    {
      name: "two tools and a custom template (nonstream-tool-call)",
      load: () => request("nonstream-tool-call"),
      real: 229,
    },
    {
      name: "a 1,233-token prompt (stream-progress)",
      load: () => request("stream-progress"),
      real: 1233,
    },
    {
      name: "a 5,320-token prompt (error-context-overflow)",
      load: async () => ({
        messages: [
          {
            role: "user",
            content: Array.from({ length: 900 }, (_, i) => `word${i} and more`).join(" "),
          },
        ],
      }),
      real: 5320,
    },
  ];

  /*
   * Measured: +7%, -10%, +39%, 0%, -0%. The tools case is high because this test template's
   * tool preamble is short (about 60 tokens) while Qwen3.8's is about 250 and the estimate
   * allows 150; the thinking template adds a few tokens the estimate does not know about.
   */
  for (const c of cases) {
    test(`${c.name} is within -15% to +45%`, async () => {
      const estimate = estimator.estimate(toEngine(await c.load()));
      const error = (estimate - c.real) / c.real;
      expect(error).toBeGreaterThan(-0.15);
      expect(error).toBeLessThan(0.45);
    });
  }

  test("the long prompts are within 5%", async () => {
    const progress = estimator.estimate(toEngine(await request("stream-progress")));
    expect(Math.abs(progress - 1233) / 1233).toBeLessThan(0.05);
  });
});

describe("the estimate", () => {
  const user = (text: string): Message => ({
    role: "user",
    kind: "prompt",
    content: [{ type: "text", text }],
  });

  test("counts every part of a conversation", () => {
    const base: Message[] = [user("Fix the failing test in src/app.ts.")];
    const before = estimator.estimate({ messages: base, tools: [] });
    const withCall: Message[] = [
      ...base,
      {
        role: "assistant",
        content: "",
        reasoning: "The test is about parsing dates; read it first.",
        toolCalls: [{ id: "c1", name: "Read", arguments: '{"file_path":"src/app.ts"}' }],
      },
      {
        role: "tool",
        toolCallId: "c1",
        toolName: "Read",
        content: [{ type: "text", text: "1→export const x = 1;\n2→export const y = 2;" }],
        isError: false,
      },
    ];
    const after = estimator.estimate({ messages: withCall, tools: [] });
    expect(after).toBeGreaterThan(before + 30);
  });

  test("gives an image a fixed cost", () => {
    const text: Message[] = [user("look")];
    const image: Message[] = [
      {
        role: "user",
        kind: "prompt",
        content: [
          { type: "text", text: "look" },
          { type: "image", mediaType: "image/png", data: "A".repeat(500_000) },
        ],
      },
    ];
    const diff =
      estimator.estimate({ messages: image, tools: [] }) -
      estimator.estimate({ messages: text, tools: [] });
    expect(diff).toBe(DEFAULT_IMAGE_TOKENS);
  });

  test("counts tool schemas", () => {
    const prefix = buildPromptPrefix({ tools: CORE_TOOLS, instructions: "" });
    const without = estimator.estimate({ messages: [prefix.system], tools: [] });
    const withTools = estimator.estimate({ messages: [prefix.system], tools: prefix.tools });
    // Measured with the Qwen3.8, Laguna and gpt-oss tokenizers, the seven core tools' schemas are
    // about 2,610 tokens as JSON, plus each template's own tool preamble.
    expect(withTools - without).toBeGreaterThan(2_600);
    expect(withTools - without).toBeLessThan(3_600);
  });

  test("never throws, even for a schema JSON cannot hold", () => {
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic.self = cyclic;
    const tools: ToolSchema[] = [{ name: "Odd", description: "odd", parameters: cyclic }];
    expect(estimator.estimate({ messages: [], tools })).toBeGreaterThan(0);
    expect(estimator.estimate({ messages: [], tools: [] })).toBe(0);
  });

  test("counts digits, symbols and other scripts at about a token each", () => {
    expect(textTokens("1234567890")).toBe(10);
    expect(textTokens("你好世界")).toBe(4);
    expect(textTokens("hello")).toBe(1);
    expect(textTokens(" internationalization")).toBeGreaterThan(3);
  });

  test("scales when told to", () => {
    const messages = [user("a fairly ordinary sentence about code")];
    const plain = createTokenEstimator().estimate({ messages, tools: [] });
    const doubled = createTokenEstimator({ scale: 2 }).estimate({ messages, tools: [] });
    expect(doubled).toBeGreaterThanOrEqual(plain * 2 - 1);
    expect(doubled).toBeLessThanOrEqual(plain * 2 + 1);
  });

  test("is fast on a large history", () => {
    const big: Message[] = Array.from({ length: 200 }, (_, i) =>
      user(`line ${i}: ${"const value = compute(input, options);\n".repeat(100)}`),
    );
    const started = performance.now();
    estimator.estimate({ messages: big, tools: [] });
    const first = performance.now() - started;
    const again = performance.now();
    estimator.estimate({ messages: big, tools: [] });
    expect(performance.now() - again).toBeLessThan(first);
    expect(first).toBeLessThan(1_000);
  });
});
