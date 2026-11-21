/**
 * A scripted session for tests: what a turn loop would append, in order, and a driver that keeps
 * the in-memory history the way the engine does (push each message; replace on compaction).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "../../contracts/index.ts";
import type { StateChanges } from "../records.ts";
import { SessionStore, type SessionStoreOptions } from "../store.ts";
import type { CompactInput, MessageExtras, SessionWriter } from "../writer.ts";

export type Step =
  | { kind: "message"; message: Message; extras?: MessageExtras }
  | { kind: "state"; changes: StateChanges }
  | { kind: "compact"; build: (history: readonly Message[]) => CompactInput };

/** A 1x1 PNG. */
export const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const UNICODE_SAMPLE =
  "naïve café — 日本語のテキスト, emoji 👩‍💻🚀, RTL שלום, combining é, " +
  "zero width ​ joiner, line sep   para sep  , nul \u0000, tab\tand\nnewline, " +
  'quotes "double" and \\backslash\\, lone surrogate \ud800 end';

function prompt(text: string, extra: Message[] = []): Step[] {
  return [
    { kind: "message", message: { role: "user", kind: "prompt", content: [{ type: "text", text }] } },
    ...extra.map((message): Step => ({ kind: "message", message })),
  ];
}

function call(id: string, name: string, args: object, rawArguments?: string) {
  return {
    id,
    name,
    arguments: JSON.stringify(args),
    ...(rawArguments !== undefined ? { rawArguments } : {}),
  };
}

function result(toolCallId: string, toolName: string, text: string, isError = false): Step {
  return {
    kind: "message",
    message: { role: "tool", toolCallId, toolName, content: [{ type: "text", text }], isError },
    extras: { durationMs: 12 },
  };
}

/** About sixty records: prompts, replies with reasoning and calls, results, notes, state, a compaction. */
export function scriptedSteps(): Step[] {
  return [
    {
      kind: "message",
      message: {
        role: "system",
        content: "Working directory: /work/project\nPlatform: darwin\nDate: 2026-11-21",
      },
    },
    { kind: "state", changes: { mode: "default", model: "local-model", effort: "medium" } },
    ...prompt("Fix the failing test in parser.ts"),
    {
      kind: "message",
      message: {
        role: "assistant",
        content: "Let me look at the test first.",
        reasoning: "The user wants a fix. Read the test, then the parser.",
        toolCalls: [
          call("call_1", "Read", { file_path: "/work/project/parser.test.ts" }),
          call("call_2", "Grep", { pattern: "parse\\(", path: "src" }, '{"pattern":"parse\\(", path:"src",}'),
        ],
      },
      extras: {
        info: {
          model: "local-model",
          finishReason: "tool_calls",
          usage: {
            promptTokens: 1200,
            completionTokens: 80,
            cachedTokens: 1100,
            promptTokensPerSecond: 900.5,
            completionTokensPerSecond: 40.25,
            promptMs: 110,
            completionMs: 2000,
          },
        },
      },
    },
    result("call_1", "Read", "1\timport { parse } from './parser';\n2\ttest('x', () => {});"),
    result("call_2", "Grep", "No matches found", true),
    { kind: "state", changes: { tasks: [{ content: "Read the test", status: "completed" }, { content: "Fix the parser", status: "in_progress", activeForm: "Fixing the parser" }] } },
    {
      kind: "message",
      message: {
        role: "assistant",
        content: "",
        toolCalls: [call("call_3", "Edit", { file_path: "/work/project/parser.ts", old_string: "a", new_string: "b" })],
      },
    },
    {
      kind: "message",
      message: {
        role: "tool",
        toolCallId: "call_3",
        toolName: "Edit",
        content: [{ type: "text", text: "Edited parser.ts" }],
        isError: false,
      },
      extras: {
        display: {
          kind: "diff",
          filePath: "/work/project/parser.ts",
          created: false,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
          additions: 1,
          deletions: 1,
        },
      },
    },
    { kind: "message", message: { role: "assistant", content: "Fixed. The test passes now.", toolCalls: [] } },
    { kind: "state", changes: { title: "Fix parser test" } },
    ...prompt("Here is a screenshot of the error, what is wrong?"),
    {
      kind: "message",
      message: {
        role: "user",
        kind: "prompt",
        content: [
          { type: "text", text: "And this one:" },
          { type: "image", mediaType: "image/png", data: TINY_PNG },
        ],
      },
    },
    {
      kind: "message",
      message: {
        role: "assistant",
        content: "I will take a screenshot of the page too.",
        reasoning: "Need a second image.",
        toolCalls: [call("call_4", "Read", { file_path: "/work/project/shot.png" })],
      },
    },
    {
      kind: "message",
      message: {
        role: "tool",
        toolCallId: "call_4",
        toolName: "Read",
        content: [
          { type: "text", text: "Image file:" },
          { type: "image", mediaType: "image/png", data: TINY_PNG },
        ],
        isError: false,
      },
    },
    {
      kind: "message",
      message: {
        role: "user",
        kind: "note",
        content: [{ type: "text", text: "The file parser.ts changed on disk since it was read." }],
      },
    },
    { kind: "message", message: { role: "assistant", content: UNICODE_SAMPLE, toolCalls: [] } },
    { kind: "state", changes: { mode: "plan" } },
    ...prompt("Plan the next refactor."),
    { kind: "message", message: { role: "assistant", content: "Here is the plan.", toolCalls: [call("call_5", "ExitPlanMode", { plan: "1. a\n2. b" })] } },
    result("call_5", "ExitPlanMode", "Plan approved."),
    { kind: "state", changes: { mode: "acceptEdits", model: null, effort: null, additionalDirectories: ["/work/shared"] } },
    {
      kind: "compact",
      build: (history) => ({
        trigger: "manual",
        focus: "the parser work",
        summary: "Goal: fix the parser test. Done: edited parser.ts. Next: refactor.",
        messages: [
          history[0] as Message,
          {
            role: "user",
            kind: "note",
            content: [{ type: "text", text: "Summary of the conversation so far: fixed the parser." }],
          },
          ...history.slice(-3),
        ],
        tokensBefore: 50_000,
        tokensAfter: 4_000,
      }),
    },
    ...prompt("Now run the tests."),
    { kind: "message", message: { role: "assistant", content: "", toolCalls: [call("call_6", "Bash", { command: "npm test", description: "Run tests" })] } },
    result("call_6", "Bash", `${"PASS src/parser.test.ts\n".repeat(50)}Tests: 50 passed`),
    { kind: "message", message: { role: "assistant", content: "All 50 tests pass.", toolCalls: [] } },
    { kind: "state", changes: { tasks: [], archived: true } },
    { kind: "state", changes: { archived: false } },
    {
      kind: "compact",
      build: (history) => ({
        trigger: "auto",
        summary: "Second summary.",
        messages: [...history.slice(0, 1), ...history.slice(-2)],
        tokensBefore: null,
        tokensAfter: null,
      }),
    },
    ...prompt("One more thing after the second compaction."),
    { kind: "message", message: { role: "assistant", content: "Done.", toolCalls: [] } },
  ];
}

/** Applies one step to a writer and to the in-memory history, as the engine would. */
export async function runStep(writer: SessionWriter, history: Message[], step: Step): Promise<void> {
  switch (step.kind) {
    case "message":
      await writer.appendMessage(step.message, step.extras);
      history.push(step.message);
      break;
    case "state":
      await writer.setState(step.changes);
      break;
    case "compact": {
      const input = step.build(history);
      await writer.compact(input);
      history.splice(0, history.length, ...input.messages);
      break;
    }
  }
}

export interface TempStore {
  root: string;
  project: string;
  store: SessionStore;
  cleanup(): Promise<void>;
}

export async function tempStore(options: Omit<SessionStoreOptions, "root"> = {}): Promise<TempStore> {
  const root = await mkdtemp(path.join(tmpdir(), "dawg-sessions-"));
  const project = path.join(root, "work", "project");
  const store = new SessionStore({ root: path.join(root, "home"), durability: "none", ...options });
  return {
    root,
    project,
    store,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** A clock that advances one second per reading, from a fixed start. */
export function steppingClock(start = "2026-11-21T09:00:00.000Z"): () => Date {
  let t = Date.parse(start);
  return () => {
    const now = new Date(t);
    t += 1000;
    return now;
  };
}

/** Ids that sort in creation order and never change between runs. */
export function fixedIds(prefix = "session"): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${String(n).padStart(4, "0")}`;
  };
}
