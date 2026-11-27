/** `hook.ran` and `hook.skipped` in the transcript: where the items go and what they keep. */
import type { CompatSource, EventPayloadInput } from "@dawg/protocol";
import { describe, expect, it } from "vitest";
import {
  applyLive,
  applyReplay,
  createStream,
  makeSummary,
  openSession,
  PROJECT,
  type Stream,
} from "./__fixtures__/streams.ts";
import type { EngineSlice, HookItem, TranscriptItem } from "./types.ts";

type HookRan = Omit<EventPayloadInput<"hook.ran">, "sessionId" | "seq" | "time">;

const SOURCE: CompatSource = {
  path: `${PROJECT}/.claude/settings.json`,
  origin: "claude",
  scope: "project",
};

function items(state: EngineSlice): TranscriptItem[] {
  return state.transcripts.s1 ?? [];
}

function order(state: EngineSlice): string[] {
  return items(state).map((item) => item.id);
}

function ran(
  fields: Partial<Omit<HookRan, "hook">> & { event: string; matcher?: string; command?: string },
): HookRan {
  const { event, matcher = "Bash", command = "./check.sh", ...rest } = fields;
  return {
    turnId: "t1",
    toolCallId: "c1",
    hook: { event, matcher, type: "command", command, source: SOURCE },
    outcome: "success",
    exitCode: 0,
    durationMs: 30,
    decision: null,
    message: null,
    ...rest,
  };
}

function turnWithBash(s: Stream): void {
  s.emit("session.status", { status: "working", waitingOn: null, message: null });
  s.emit("turn.started", {
    turnId: "t1",
    prompt: { content: [{ type: "text", text: "Clean up" }], mentions: [] },
    command: null,
  });
  s.emit("message.started", { turnId: "t1", messageId: "m1" });
  s.emit("message.finished", {
    turnId: "t1",
    messageId: "m1",
    text: "",
    reasoning: null,
    toolCalls: [{ toolCallId: "c1", toolName: "Bash" }],
  });
  s.emit("tool.started", {
    turnId: "t1",
    messageId: "m1",
    toolCallId: "c1",
    toolName: "Bash",
    input: { command: "rm -rf build" },
  });
}

function live(build: (s: Stream) => void): EngineSlice {
  const stream = createStream("s1");
  build(stream);
  return applyLive(openSession(makeSummary("s1")), stream.events);
}

describe("hook.ran", () => {
  it("puts a PreToolUse hook just before its call, with the call's tool", () => {
    const state = live((s) => {
      turnWithBash(s);
      s.emit(
        "hook.ran",
        ran({
          event: "PreToolUse",
          outcome: "blocked",
          exitCode: 2,
          decision: "deny",
          message: "no",
        }),
      );
      s.emit("tool.finished", {
        turnId: "t1",
        toolCallId: "c1",
        toolName: "Bash",
        outcome: "denied",
        content: [{ type: "text", text: "Denied by a PreToolUse hook: no" }],
        display: null,
        durationMs: null,
      });
    });
    expect(order(state)).toEqual(["user:t1", "hook:6", "tool:c1"]);
    const hook = items(state)[1] as HookItem;
    expect(hook).toMatchObject({
      kind: "hook",
      toolName: "Bash",
      outcome: "blocked",
      exitCode: 2,
      decision: "deny",
      message: "no",
      hook: { event: "PreToolUse", command: "./check.sh", source: SOURCE },
    });
  });

  it("keeps a PreToolUse hook before the call's permission card, which comes later", () => {
    const state = live((s) => {
      turnWithBash(s);
      s.emit("hook.ran", ran({ event: "PreToolUse", decision: "ask" }));
      s.emit("permission.requested", {
        turnId: "t1",
        request: {
          requestId: "p1",
          toolCallId: "c1",
          toolName: "Bash",
          input: { command: "rm -rf build" },
          title: "Run a shell command",
          reason: "A PreToolUse hook asked",
          suggestions: [],
        },
      });
    });
    expect(order(state)).toEqual(["user:t1", "hook:6", "permission:p1", "tool:c1"]);
  });

  it("puts PostToolUse hooks after their call, in the order they ran", () => {
    const state = live((s) => {
      turnWithBash(s);
      s.emit("tool.finished", {
        turnId: "t1",
        toolCallId: "c1",
        toolName: "Bash",
        outcome: "success",
        content: [{ type: "text", text: "" }],
        display: null,
        durationMs: 20,
      });
      s.emit("message.started", { turnId: "t1", messageId: "m2" });
      s.emit("message.delta", { turnId: "t1", messageId: "m2", text: "Done." });
      s.emit("hook.ran", ran({ event: "PostToolUse" }));
      s.emit("hook.ran", ran({ event: "PostToolUse", command: "npm run lint" }));
    });
    // Both after the call's card, before the reply that followed it.
    const ids = order(state);
    expect(ids.slice(0, 4)).toEqual(["user:t1", "tool:c1", "hook:9", "hook:10"]);
    expect(ids[4]).toBe("assistant:m2");
  });

  it("appends a hook outside any call, and a replay builds the same items", () => {
    const stream = createStream("s1");
    stream.emit(
      "hook.ran",
      ran({ event: "SessionStart", turnId: null, toolCallId: null, matcher: "startup" }),
    );
    turnWithBash(stream);
    stream.emit("hook.ran", ran({ event: "PreToolUse" }));
    const viaLive = applyLive(openSession(makeSummary("s1")), stream.events);
    const viaReplay = applyReplay(openSession(makeSummary("s1")), "s1", stream.events);
    expect(order(viaLive)).toEqual(["hook:1", "user:t1", "hook:7", "tool:c1"]);
    expect(items(viaReplay)).toEqual(items(viaLive));
    // The same event again changes nothing.
    const again = applyLive(viaLive, stream.events.slice(-1));
    expect(items(again)).toBe(items(viaLive));
  });
});

describe("hook.skipped", () => {
  it("adds one quiet line naming the project", () => {
    const state = live((s) => {
      s.emit("hook.skipped", { turnId: null, projectDir: PROJECT, sources: [SOURCE] });
    });
    expect(items(state)).toEqual([
      {
        kind: "hook-skipped",
        id: "hook-skipped:1",
        turnId: null,
        seq: 1,
        projectDir: PROJECT,
        sources: [SOURCE],
      },
    ]);
  });
});
