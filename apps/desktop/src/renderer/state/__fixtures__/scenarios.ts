/**
 * Scripted turns built on `createStream`, shared by the reducer, selector and store tests.
 */
import { makeUsage, PROJECT, type Stream } from "./streams.ts";

/**
 * A complete turn touching most event kinds: reading the prompt, reasoning and text deltas, a
 * read, a command that asks for permission and streams output, a task list, usage, and a final
 * reply. Starts from `usageBefore` totals.
 */
export function fullTurn(
  stream: Stream,
  options: {
    turnId?: string;
    usageBefore?: { requests: number; promptTokens: number; cachedTokens: number };
  } = {},
): void {
  const turnId = options.turnId ?? "t1";
  const before = options.usageBefore ?? { requests: 0, promptTokens: 0, cachedTokens: 0 };
  const m1 = `${turnId}-m1`;
  const m2 = `${turnId}-m2`;
  const read = `${turnId}-c1`;
  const bash = `${turnId}-c2`;
  const todo = `${turnId}-c3`;
  const permission = `${turnId}-p1`;

  stream.emit("session.status", { status: "working", waitingOn: null, message: null });
  stream.emit("turn.started", {
    turnId,
    prompt: {
      content: [
        { type: "text", text: "Fix the failing split test" },
        { type: "text", text: "It loses a cent." },
      ],
      mentions: [{ path: "src/tally/money.py" }],
    },
    command: null,
  });
  stream.emit("prompt.progress", { turnId, total: 20_000, cached: 16_000, processed: 16_000 });
  stream.emit(
    "prompt.progress",
    { turnId, total: 20_000, cached: 16_000, processed: 18_000 },
    1000,
  );
  stream.emit("message.started", { turnId, messageId: m1 }, 1000);
  stream.emit("reasoning.delta", { turnId, messageId: m1, text: "The split rounds " });
  stream.emit("reasoning.delta", { turnId, messageId: m1, text: "each share." }, 400);
  stream.emit("message.delta", { turnId, messageId: m1, text: "Let me look " }, 4500);
  stream.emit("message.delta", { turnId, messageId: m1, text: "at money.py." });
  stream.emit("message.finished", {
    turnId,
    messageId: m1,
    text: "Let me look at money.py.",
    reasoning: "The split rounds each share.",
    toolCalls: [
      { toolCallId: read, toolName: "Read" },
      { toolCallId: bash, toolName: "Bash" },
      { toolCallId: todo, toolName: "TodoWrite" },
    ],
  });
  stream.emit("tool.started", {
    turnId,
    messageId: m1,
    toolCallId: read,
    toolName: "Read",
    input: { file_path: `${PROJECT}/src/tally/money.py` },
  });
  stream.emit("tool.finished", {
    turnId,
    toolCallId: read,
    toolName: "Read",
    outcome: "success",
    content: [{ type: "text", text: "def split_evenly(...)" }],
    display: {
      kind: "file",
      filePath: `${PROJECT}/src/tally/money.py`,
      startLine: 1,
      lineCount: 15,
      totalLines: 15,
      truncated: false,
    },
    durationMs: 12,
  });
  stream.emit("tool.started", {
    turnId,
    messageId: m1,
    toolCallId: bash,
    toolName: "Bash",
    input: { command: "uv run pytest -q" },
  });
  stream.emit("permission.requested", {
    turnId,
    request: {
      requestId: permission,
      toolCallId: bash,
      toolName: "Bash",
      input: { command: "uv run pytest -q" },
      title: "Run a shell command",
      reason: "No rule allows this command",
      suggestions: ["Bash(uv run pytest *)"],
    },
  });
  stream.emit("session.status", { status: "waiting", waitingOn: "permission", message: null });
  stream.emit(
    "request.resolved",
    {
      kind: "permission",
      turnId,
      requestId: permission,
      outcome: "answered",
      response: { behavior: "allow", scope: "once" },
    },
    3000,
  );
  stream.emit("session.status", { status: "working", waitingOn: null, message: null });
  stream.emit("tool.progress", {
    turnId,
    toolCallId: bash,
    progress: { kind: "output", stream: "stdout", text: "..F..\n" },
  });
  stream.emit("tool.progress", {
    turnId,
    toolCallId: bash,
    progress: { kind: "output", stream: "stdout", text: "1 failed, 7 passed\n" },
  });
  stream.emit("tool.progress", {
    turnId,
    toolCallId: bash,
    progress: { kind: "output", stream: "stderr", text: "warning: slow\n" },
  });
  stream.emit("tool.progress", {
    turnId,
    toolCallId: bash,
    progress: { kind: "status", message: "8 of 8 tests · 1 failure" },
  });
  stream.emit("tool.finished", {
    turnId,
    toolCallId: bash,
    toolName: "Bash",
    outcome: "error",
    content: [{ type: "text", text: "1 failed, 7 passed" }],
    display: {
      kind: "command",
      command: "uv run pytest -q",
      cwd: PROJECT,
      exitCode: 1,
      durationMs: 2100,
      timedOut: false,
      interrupted: false,
      backgroundTaskId: null,
      outputPath: null,
    },
    durationMs: 2100,
  });
  stream.emit("tool.started", {
    turnId,
    messageId: m1,
    toolCallId: todo,
    toolName: "TodoWrite",
    input: { todos: [] },
  });
  stream.emit("tasks.updated", {
    tasks: [
      { content: "Add tests for refunds", status: "completed" },
      {
        content: "Make split_evenly handle negative totals",
        status: "in_progress",
        activeForm: "Making split_evenly handle negative totals",
      },
    ],
  });
  stream.emit("tool.finished", {
    turnId,
    toolCallId: todo,
    toolName: "TodoWrite",
    outcome: "success",
    content: [{ type: "text", text: "Updated" }],
    display: null,
    durationMs: 1,
  });
  stream.emit("usage.updated", {
    usage: makeUsage({
      requests: before.requests + 1,
      promptTokens: before.promptTokens + 20_000,
      cachedTokens: before.cachedTokens + 16_000,
    }),
  });
  stream.emit("message.started", { turnId, messageId: m2 });
  stream.emit("message.delta", { turnId, messageId: m2, text: "Found it: " }, 800);
  stream.emit("message.delta", { turnId, messageId: m2, text: "rounding." });
  stream.emit("message.finished", {
    turnId,
    messageId: m2,
    text: "Found it: rounding each share loses a cent.",
    reasoning: null,
    toolCalls: [],
  });
  stream.emit("usage.updated", {
    usage: makeUsage({
      requests: before.requests + 2,
      promptTokens: before.promptTokens + 45_000,
      cachedTokens: before.cachedTokens + 40_000,
    }),
  });
  stream.emit("turn.finished", {
    turnId,
    stopReason: "completed",
    finalText: "Found it: rounding each share loses a cent.",
    error: null,
    durationMs: 48_000,
  });
  stream.emit("session.status", { status: "idle", waitingOn: null, message: null });
}

/** A turn that streams a reply and a running command, then is interrupted mid-stream. */
export function interruptedTurn(stream: Stream, turnId = "t2"): void {
  const messageId = `${turnId}-m1`;
  const call = `${turnId}-c1`;
  stream.emit("session.status", { status: "working", waitingOn: null, message: null });
  stream.emit("turn.started", {
    turnId,
    prompt: { content: [{ type: "text", text: "Now run the whole suite" }], mentions: [] },
    command: null,
  });
  stream.emit("message.started", { turnId, messageId });
  stream.emit("reasoning.delta", { turnId, messageId, text: "Run everything." });
  stream.emit("message.delta", { turnId, messageId, text: "Running the suite" });
  stream.emit("message.finished", {
    turnId,
    messageId,
    text: "Running the suite.",
    reasoning: "Run everything.",
    toolCalls: [{ toolCallId: call, toolName: "Bash" }],
  });
  stream.emit("tool.started", {
    turnId,
    messageId,
    toolCallId: call,
    toolName: "Bash",
    input: { command: "uv run pytest" },
  });
  stream.emit("tool.progress", {
    turnId,
    toolCallId: call,
    progress: { kind: "output", stream: "stdout", text: "....." },
  });
}

/** Ends `interruptedTurn` the way the engine does after `session.interrupt`. */
export function finishInterrupted(stream: Stream, turnId = "t2"): void {
  stream.emit("tool.finished", {
    turnId,
    toolCallId: `${turnId}-c1`,
    toolName: "Bash",
    outcome: "interrupted",
    content: [{ type: "text", text: "Interrupted" }],
    display: null,
    durationMs: 900,
  });
  stream.emit("turn.finished", {
    turnId,
    stopReason: "interrupted",
    finalText: "Running the suite.",
    error: null,
    durationMs: 3000,
  });
  stream.emit("session.status", { status: "idle", waitingOn: null, message: null });
}
