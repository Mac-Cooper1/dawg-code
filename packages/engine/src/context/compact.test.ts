import {
  type MockModel,
  type MockModelOptions,
  type ScriptReply,
  startMockModel,
  text,
  toolCall,
} from "@dawg/mock-model";
import type { TaskItem } from "@dawg/protocol";
import { afterEach, describe, expect, test } from "vitest";
import type { Message, UserMessage } from "../contracts/messages.ts";
import { type ModelClient, ModelError } from "../contracts/model.ts";
import type { PromptPrefix, SessionEnvironment } from "../contracts/prompt.ts";
import { createModelClient, toChatMessages, toChatTools } from "../model/index.ts";
import { buildPromptPrefix, createPromptAssembler, isNoteText } from "../prompt/index.ts";
import { CORE_TOOLS } from "../tools/index.ts";
import { type CompactionInputWithOptions, createCompactor } from "./compact.ts";
import { checkView } from "./view.ts";

const assembler = createPromptAssembler();
const env: SessionEnvironment = {
  cwd: "/work/app",
  additionalDirectories: [],
  platform: "darwin",
  osVersion: "macOS 15.6",
  shell: "bash",
  date: "2026-11-21",
  git: { branch: "main", status: "", recentCommits: "" },
};

const prompt = (value: string): UserMessage => ({
  role: "user",
  kind: "prompt",
  content: [{ type: "text", text: value }],
});
const call = (id: string, name: string, args: object, reasoning?: string): Message => ({
  role: "assistant",
  content: "",
  ...(reasoning === undefined ? {} : { reasoning }),
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
});
const result = (id: string, name: string, value: string): Message => ({
  role: "tool",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text: value }],
  isError: false,
});
const reply = (value: string): Message => ({ role: "assistant", content: value, toolCalls: [] });

/** A session of three turns, the last one still running (it ends with a tool result). */
function session(): Message[] {
  return [
    assembler.sessionContext(env),
    prompt("The date parser rejects ISO weeks. Fix it; keep the public API unchanged."),
    call("c1", "Grep", { pattern: "parseDate" }, "Find where dates are parsed."),
    result("c1", "Grep", "src/date.ts\nsrc/date.test.ts"),
    call("c2", "Read", { file_path: "src/date.ts" }),
    result("c2", "Read", "1→export function parseDate(s: string) {\n2→  return new Date(s);\n3→}"),
    call("c3", "Edit", { file_path: "src/date.ts", old_string: "a", new_string: "b" }),
    result("c3", "Edit", "Edited /work/app/src/date.ts."),
    reply("Fixed: parseDate now accepts ISO weeks. Tests pass."),
    prompt("Thanks. Now add a test for 2026-W01."),
    call("c4", "Read", { file_path: "src/date.test.ts" }, "Look at the existing tests."),
    result("c4", "Read", "1→import { parseDate } from './date';\n2→test('basic', () => {});"),
    reply("Added the test."),
    {
      role: "user",
      kind: "prompt",
      content: [
        { type: "text", text: "This screenshot shows the failing CI run. Fix it." },
        { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
      ],
    },
    call("c5", "Bash", { command: "npm test" }, "Run the tests to see the failure."),
    result("c5", "Bash", "FAIL src/date.test.ts > 2026-W01\nExit code 1"),
  ];
}

const TASKS: TaskItem[] = [
  { content: "Fix ISO week parsing", status: "completed" },
  { content: "Fix the CI failure", status: "in_progress" },
];

const SUMMARY = `## Goal
Fix ISO week parsing in parseDate without changing the public API.

## User instructions
- Keep the public API unchanged.

## Current state
The parser fix is in; a new test for 2026-W01 fails in CI.

## Next steps
1. Read the failing test output.`;

let mock: MockModel | null = null;
afterEach(async () => {
  await mock?.close();
  mock = null;
});

async function setup(
  replies: ScriptReply[],
  options: Omit<MockModelOptions, "script"> = {},
): Promise<{ client: ModelClient; mock: MockModel }> {
  mock = await startMockModel({ contextWindow: 65_536, ...options, script: replies });
  return { client: createModelClient(mock.endpoint), mock };
}

function input(
  client: ModelClient,
  prefix: PromptPrefix,
  history: Message[],
  extra: Partial<CompactionInputWithOptions> = {},
): CompactionInputWithOptions {
  return {
    prefix,
    history,
    client,
    focus: null,
    tasks: TASKS,
    recentFiles: [
      {
        path: "/work/app/src/date.ts",
        content: "export function parseDate(s: string) {\n  return s;\n}\n",
      },
    ],
    signal: new AbortController().signal,
    ...extra,
  };
}

function chatBody(m: MockModel, index: number) {
  return m.chatRequests[index]?.body as {
    messages: { role: string; content: unknown }[];
    tools: unknown[];
    max_tokens?: number;
    id_slot?: number;
  };
}

function textOf(message: Message | undefined): string {
  if (message === undefined) return "";
  if (message.role === "system" || message.role === "assistant") return message.content;
  return message.content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

const prefix = buildPromptPrefix({ tools: CORE_TOOLS, instructions: "Always use pnpm." });

describe("the summarising request", () => {
  test("repeats the session's system message, tools and history byte for byte", async () => {
    const { client, mock: m } = await setup([text(SUMMARY)]);
    const history = session();
    await createCompactor().compact(input(client, prefix, history, { slot: 2 }));

    // What a normal request of this session would send.
    const sessionMessages = toChatMessages([prefix.system, ...history], {
      images: "omit",
      reasoningField: "reasoning_content",
    });
    const body = chatBody(m, 0);
    expect(body.messages[0]).toEqual({ role: "system", content: prefix.system.content });
    expect(body.tools).toEqual(toChatTools(prefix.tools));
    expect(body.messages.slice(0, sessionMessages.length)).toEqual(sessionMessages);
    // Byte for byte, which is what the prompt cache compares.
    const sent = JSON.stringify(body.messages);
    expect(sent.startsWith(JSON.stringify(sessionMessages).slice(0, -1))).toBe(true);
    expect(JSON.stringify(body.tools)).toBe(JSON.stringify(toChatTools(prefix.tools)));
    expect(body.id_slot).toBe(2);
    // Then exactly one message: the request for a summary, as a note.
    expect(body.messages).toHaveLength(sessionMessages.length + 1);
    const last = body.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(isNoteText(String(last?.content))).toBe(true);
    expect(String(last?.content)).toContain("## Next steps");
    expect(body.max_tokens).toBeGreaterThan(1_000);
  });

  test("carries the focus", async () => {
    const { client, mock: m } = await setup([text(SUMMARY)]);
    await createCompactor().compact(
      input(client, prefix, session(), { focus: "the CI failure and its log" }),
    );
    const last = chatBody(m, 0).messages.at(-1);
    expect(String(last?.content)).toContain("concentrate on: the CI failure and its log");
  });

  test("repeats the session's reasoning effort and template options when given", async () => {
    const { client, mock: m } = await setup([text(SUMMARY)], {
      templateCaps: { reasoning_effort_levels: ["low", "medium", "xhigh"] },
    });
    await createCompactor().compact(
      input(client, prefix, session(), {
        reasoningEffort: "medium",
        extraBody: { chat_template_kwargs: { preserve_thinking: true } },
      }),
    );
    const body = chatBody(m, 0) as unknown as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("medium");
    expect(body.chat_template_kwargs).toEqual({ preserve_thinking: true });
  });
});

describe("the new view", () => {
  test("is valid and holds the context, summary, tasks, files and recent turns", async () => {
    const { client } = await setup([text(SUMMARY)]);
    const history = session();
    const out = await createCompactor().compact(input(client, prefix, history));

    expect(out.summary).toBe(SUMMARY);
    expect(out.usage).not.toBeNull();
    expect(checkView(out.messages)).toEqual([]);
    // The original session-context message, unchanged.
    expect(out.messages[0]).toBe(history[0]);
    // The summary and the task list, in one note.
    const summary = textOf(out.messages[1]);
    expect(isNoteText(summary)).toBe(true);
    expect(summary).toContain(SUMMARY);
    expect(summary).toContain("- completed: Fix ISO week parsing");
    expect(summary).toContain("- in_progress: Fix the CI failure");
    // The files, numbered as Read numbers them.
    const files = textOf(out.messages[2]);
    expect(isNoteText(files)).toBe(true);
    expect(files).toContain('<file path="/work/app/src/date.ts">\n1→export function parseDate');
    // The recent turns, word for word, cut at a turn boundary, ending where history ended.
    const kept = out.messages.slice(3);
    const start = history.length - kept.length;
    expect(kept).toEqual(history.slice(start));
    expect(history[start]?.role === "user" && history[start].kind).toBe("prompt");
    expect(out.messages.at(-1)).toBe(history.at(-1));
  });

  test("keeps reasoning and images in the kept turns", async () => {
    const { client } = await setup([text(SUMMARY)]);
    const out = await createCompactor().compact(input(client, prefix, session()));
    const kept = out.messages.slice(3);
    expect(kept.some((m) => m.role === "assistant" && m.reasoning !== undefined)).toBe(true);
    expect(kept.some((m) => m.role === "user" && m.content.some((p) => p.type === "image"))).toBe(
      true,
    );
  });

  test("keeps at most three turns", async () => {
    const { client } = await setup([text(SUMMARY)]);
    const history: Message[] = [assembler.sessionContext(env)];
    for (let i = 0; i < 8; i++) history.push(prompt(`question ${i}`), reply(`answer ${i}`));
    const out = await createCompactor().compact(
      input(client, prefix, history, { recentFiles: [] }),
    );
    expect(checkView(out.messages)).toEqual([]);
    // Context, summary, then three whole turns.
    expect(out.messages.slice(2)).toEqual(history.slice(-6));
  });

  test("keeps the prompt and latest steps when the current turn alone is too big", async () => {
    const { client } = await setup([text(SUMMARY)], { contextWindow: 16_384 });
    const history: Message[] = [assembler.sessionContext(env), prompt("Refactor every module.")];
    for (let i = 0; i < 40; i++) {
      history.push(
        call(`s${i}`, "Read", { file_path: `src/m${i}.ts` }),
        result(`s${i}`, "Read", `1→// module ${i}\n${"2→export const x = 1;\n".repeat(30)}`),
      );
    }
    const out = await createCompactor().compact(
      input(client, prefix, history, { recentFiles: [] }),
    );
    expect(checkView(out.messages)).toEqual([]);
    const kept = out.messages.slice(2);
    expect(kept[0]).toBe(history[1]);
    expect(kept.length).toBeGreaterThan(2);
    expect(kept.length).toBeLessThan(history.length - 2);
    // After the prompt come whole steps from the end of the turn.
    expect(kept.slice(1)).toEqual(history.slice(history.length - (kept.length - 1)));
    expect(kept[1]?.role).toBe("assistant");
  });

  test("names large files instead of showing them", async () => {
    const { client } = await setup([text(SUMMARY)]);
    const big = "export const line = 'a fairly long line of source code';\n".repeat(2_000);
    const out = await createCompactor().compact(
      input(client, prefix, session(), {
        recentFiles: [
          { path: "/work/app/big.ts", content: big },
          { path: "/work/app/small.ts", content: "export {};\n" },
        ],
      }),
    );
    const files = textOf(out.messages[2]);
    expect(files).toContain('<file path="/work/app/small.ts">');
    expect(files).not.toContain('<file path="/work/app/big.ts">');
    expect(files).toMatch(/Read them again if you need them: \/work\/app\/big\.ts/);
  });
});

describe("summaries that go wrong", () => {
  test("an empty reply is asked for again", async () => {
    const { client, mock: m } = await setup([toolCall("Read", { file_path: "x" }), text(SUMMARY)]);
    const out = await createCompactor().compact(input(client, prefix, session()));
    expect(out.summary).toBe(SUMMARY);
    expect(m.chatRequests).toHaveLength(2);
    expect(String(chatBody(m, 1).messages.at(-1)?.content)).toContain(
      "did not contain the summary",
    );
    // The retry still starts with the session's own prompt.
    expect(chatBody(m, 1).messages.slice(0, -1)).toEqual(chatBody(m, 0).messages.slice(0, -1));
  });

  test("two empty replies give a summary built from the history", async () => {
    const { client } = await setup([text(""), text("   ")]);
    const out = await createCompactor().compact(input(client, prefix, session()));
    expect(out.summary).toContain("No written summary could be made");
    expect(out.summary).toContain("keep the public API unchanged");
    expect(out.summary).toContain("src/date.ts (Read, Edit)");
    expect(checkView(out.messages)).toEqual([]);
  });

  test("a summary cut off by the output limit is kept and marked", async () => {
    const { client } = await setup([
      text("## Goal\nFix ISO weeks.\n\n## User instr", { finishReason: "length" }),
    ]);
    const out = await createCompactor().compact(input(client, prefix, session()));
    expect(out.summary).toMatch(/^## Goal\nFix ISO weeks\./);
    expect(out.summary).toContain("cut off here by the output limit");
  });

  test("a failed request throws a ModelError and returns no view", async () => {
    const { client } = await setup([{ fault: { type: "http", status: 500 } }]);
    await expect(
      createCompactor().compact(input(client, prefix, session())),
    ).rejects.toBeInstanceOf(ModelError);
  });
});

describe("a history too large for one summarising request", () => {
  const smallPrefix = buildPromptPrefix({ tools: [], instructions: "" });
  const bulky = (n: number) => `${"x".repeat(60)}\n`.repeat(n);

  function bigHistory(): Message[] {
    const history: Message[] = [assembler.sessionContext(env)];
    for (let t = 0; t < 6; t++) {
      history.push(prompt(`step ${t}: keep going`));
      history.push(
        call(`b${t}`, "Bash", { command: `make part${t}` }),
        result(`b${t}`, "Bash", bulky(80)),
      );
      history.push(reply(`part ${t} done`));
    }
    return history;
  }

  test("is shrunk to fit, oldest tool results first, before it is sent", async () => {
    // The mock counts a character as a quarter token and rejects prompts over the window.
    const { client, mock: m } = await setup([text(SUMMARY)], {
      contextWindow: 6_000,
      enforceContextWindow: true,
    });
    const history = bigHistory();
    const out = await createCompactor().compact(
      input(client, smallPrefix, history, { recentFiles: [] }),
    );
    expect(out.summary).toBe(SUMMARY);
    expect(m.chatRequests).toHaveLength(1);
    const sent = JSON.stringify(chatBody(m, 0).messages);
    expect(sent).toContain("left out of the summary request");
    // The newest output survives; the oldest went first.
    expect(sent).toContain("part5");
    expect(checkView(out.messages)).toEqual([]);
  });

  test("is shrunk after the server says it overflowed, when the endpoint cannot count", async () => {
    // An endpoint without a token-count call, whose tokenizer is far denser than the estimate.
    const { client, mock: m } = await setup([text(SUMMARY)], {
      kind: "remote",
      contextWindow: 8_000,
      enforceContextWindow: true,
      countTokens: (value) => Math.ceil(value.length / 1.5),
    });
    const out = await createCompactor().compact(
      input(client, smallPrefix, bigHistory(), { recentFiles: [] }),
    );
    expect(out.summary).toBe(SUMMARY);
    // The first attempt was refused; the second, smaller one was answered.
    expect(m.requests.filter((r) => r.path.includes("chat/completions")).length).toBe(2);
    expect(JSON.stringify(chatBody(m, 1).messages)).toContain("left out of the summary request");
  });

  test("throws when not even the latest turn fits", async () => {
    const { client } = await setup([text(SUMMARY)], { contextWindow: 1_500 });
    const history: Message[] = [
      assembler.sessionContext(env),
      prompt(`please look at this: ${bulky(400)}`),
    ];
    await expect(
      createCompactor().compact(input(client, smallPrefix, history, { recentFiles: [] })),
    ).rejects.toMatchObject({ kind: "context_overflow" });
  });
});
