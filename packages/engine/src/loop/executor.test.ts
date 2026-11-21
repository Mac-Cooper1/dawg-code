import type { PermissionResponse } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type {
  AnyTool,
  PermissionDecision,
  PermissionEngine,
  ToolOutput,
  ToolResultMessage,
} from "../contracts/index.ts";
import { createTestToolContext, type TestToolContext } from "../testing/context.ts";
import type { PreparedCall } from "../toolcall/index.ts";
import { type ExecutorHost, executeToolCalls } from "./executor.ts";

function tool(
  name: string,
  readOnly: boolean,
  run: (input: Record<string, unknown>, signal: AbortSignal) => Promise<ToolOutput>,
): AnyTool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    readOnly,
    permission: () => ({ kind: "none" }),
    execute: (input: Record<string, unknown>, ctx) => run(input, ctx.signal),
  };
}

function ready(name: string, id: string, input: Record<string, unknown> = {}): PreparedCall {
  return {
    status: "ready",
    tool: { name, description: name, parameters: {} },
    input,
    call: { id, name, arguments: JSON.stringify(input) },
    fixes: { repairs: [], coercions: [], nameCorrectedFrom: null, proseFormat: null },
    malformed: false,
  };
}

const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    });
  });

interface Recorded {
  host: ExecutorHost;
  appended: ToolResultMessage[];
  events: { event: string; payload: Record<string, unknown> }[];
  timeline: string[];
}

let contexts: TestToolContext[] = [];
afterEach(async () => {
  for (const c of contexts) await c.cleanup();
  contexts = [];
});

async function makeHost(
  tools: AnyTool[],
  options: {
    decide?: PermissionEngine["decide"];
    answer?: () => Promise<PermissionResponse>;
    maxResultChars?: number;
  } = {},
): Promise<Recorded> {
  const test = await createTestToolContext();
  contexts.push(test);
  const appended: ToolResultMessage[] = [];
  const events: Recorded["events"] = [];
  const timeline: string[] = [];
  let n = 0;
  const allow: PermissionDecision = { behavior: "allow", reason: { type: "not_needed" } };
  const host: ExecutorHost = {
    tools: new Map(tools.map((t) => [t.name, t])),
    permissions: { decide: options.decide ?? (() => allow) },
    limits: { maxResultChars: options.maxResultChars ?? 100_000, resultPreviewChars: 10 },
    emit: (event, payload) => {
      events.push({ event, payload: payload as Record<string, unknown> });
    },
    now: () => Date.now(),
    newId: (kind) => `${kind}-${++n}`,
    permissionState: () => ({
      mode: "default",
      rules: { allow: [], ask: [], deny: [] },
      cwd: test.ctx.cwd,
      workingDirectories: [test.ctx.cwd],
      homeDir: test.ctx.cwd,
    }),
    probeContext: () => test.ctx,
    canAskPermission: () => true,
    askPermission: () =>
      options.answer ? options.answer() : Promise.resolve({ behavior: "allow", scope: "once" }),
    allowAlways: async () => {},
    toolContext: ({ signal }) => ({ ...test.ctx, signal }),
    appendResult: async (message) => {
      timeline.push(`append ${message.toolCallId}`);
      appended.push(message);
    },
    saveOutput: (name, content) => test.ctx.saveOutput(name, content),
    quote: (text) => text.replace(/<(\/?)(dawg-note)/gi, "<$1quoted-$2"),
  };
  return { host, appended, events, timeline };
}

const batch = (signal = new AbortController().signal) => ({ turnId: "t", messageId: "m", signal });

describe("the tool executor", () => {
  it("runs neighbouring read-only calls together and appends results in call order", async () => {
    const timeline: string[] = [];
    const slow = (name: string, ms: number) =>
      tool(name, true, async (_input, signal) => {
        timeline.push(`start ${name}`);
        await delay(ms, signal);
        timeline.push(`end ${name}`);
        return { content: [{ type: "text", text: name }] };
      });
    const write = tool("Change", false, async () => {
      timeline.push("start Change");
      return { content: [{ type: "text", text: "changed" }] };
    });
    const r = await makeHost([slow("A", 60), slow("B", 10), write]);
    const results = await executeToolCalls(
      [ready("A", "1"), ready("B", "2"), ready("Change", "3"), ready("A", "4")],
      batch(),
      r.host,
    );
    expect(results.map((x) => x.outcome)).toEqual(["success", "success", "success", "success"]);
    // A and B overlap; B ends first; Change waits for both; the last A waits for Change.
    expect(timeline.slice(0, 4)).toEqual(["start A", "start B", "end B", "end A"]);
    expect(timeline.slice(4)).toEqual(["start Change", "start A", "end A"]);
    expect(r.appended.map((m) => m.toolCallId)).toEqual(["1", "2", "3", "4"]);
    const started = r.events
      .filter((e) => e.event === "tool.started")
      .map((e) => e.payload.toolCallId);
    expect(started).toEqual(["1", "2", "3", "4"]);
  });

  it("turns a throw into an error result that says it is an error", async () => {
    const r = await makeHost([
      tool("Boom", false, async () => {
        throw new Error("kaput");
      }),
      tool("Fails", false, async () => ({
        content: [{ type: "text", text: "no such file" }],
        isError: true,
      })),
    ]);
    const results = await executeToolCalls(
      [ready("Boom", "1"), ready("Fails", "2")],
      batch(),
      r.host,
    );
    expect(results.map((x) => x.outcome)).toEqual(["error", "error"]);
    expect(results[0]?.result.content).toEqual([
      { type: "text", text: "Error: Boom failed: kaput" },
    ]);
    expect(results[1]?.result.content).toEqual([{ type: "text", text: "Error: no such file" }]);
  });

  it("saves a result that is too long and gives the model a preview and the path", async () => {
    const r = await makeHost(
      [tool("Big", true, async () => ({ content: [{ type: "text", text: "z".repeat(500) }] }))],
      {
        maxResultChars: 100,
      },
    );
    const [result] = await executeToolCalls([ready("Big", "c1")], batch(), r.host);
    const text = (result?.result.content[0] as { text: string } | undefined)?.text ?? "";
    expect(text.startsWith("zzzzzzzzzz\n\n[The full result is 500 characters")).toBe(true);
    const file = /saved to (\S+)\. /.exec(text)?.[1] as string;
    expect(file).toContain("Big-c1");
  });

  it("returns invalid calls' errors without running anything", async () => {
    let ran = false;
    const r = await makeHost([
      tool("T", false, async () => {
        ran = true;
        return { content: [] };
      }),
    ]);
    const invalid: PreparedCall = {
      status: "invalid",
      reason: "schema",
      tool: { name: "T", description: "", parameters: {} },
      call: { id: "x", name: "T", arguments: "{}" },
      error: "T was not run: bad input.",
      fixes: { repairs: [], coercions: [], nameCorrectedFrom: null, proseFormat: null },
      malformed: true,
    };
    const [result] = await executeToolCalls([invalid], batch(), r.host);
    expect(ran).toBe(false);
    expect(result?.outcome).toBe("invalid");
    expect(result?.durationMs).toBeNull();
  });

  it("gives every call a result when interrupted, including calls that never started", async () => {
    const controller = new AbortController();
    const r = await makeHost([
      tool("Wait", false, async (_input, signal) => {
        setTimeout(() => controller.abort(), 5);
        await delay(10_000, signal);
        return { content: [] };
      }),
    ]);
    const results = await executeToolCalls(
      [ready("Wait", "1"), ready("Wait", "2")],
      batch(controller.signal),
      r.host,
    );
    expect(results.map((x) => x.outcome)).toEqual(["interrupted", "interrupted"]);
    expect(r.appended.map((m) => m.toolCallId)).toEqual(["1", "2"]);
    const names = r.events.map((e) => `${e.event} ${e.payload.toolCallId}`);
    expect(names).toEqual([
      "tool.started 1",
      "tool.finished 1",
      "tool.started 2",
      "tool.finished 2",
    ]);
  });

  it("denies, and asks then honours the answer", async () => {
    const asks: PermissionDecision = {
      behavior: "ask",
      reason: { type: "mode", mode: "default" },
      suggestions: [],
    };
    const r = await makeHost(
      [tool("T", false, async () => ({ content: [{ type: "text", text: "ran" }] }))],
      {
        decide: () => asks,
        answer: async () => ({ behavior: "deny", message: "no thanks" }),
      },
    );
    const [result] = await executeToolCalls([ready("T", "1")], batch(), r.host);
    expect(result?.outcome).toBe("denied");
    expect((result?.result.content[0] as { text: string } | undefined)?.text).toContain(
      "no thanks",
    );
  });
});
