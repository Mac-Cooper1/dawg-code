/**
 * One valid and one invalid sample for every method and event. Typed against the registries, so
 * adding a method or event without samples fails the type-check.
 */
import type {
  ModelInfo,
  PermissionRequest,
  SessionSummary,
  TaskItem,
  Usage,
} from "../common.ts";
import type { EventName, EventPayloadInput } from "../events.ts";
import type { MethodName, MethodParams, ResultInput } from "../methods.ts";
import type { SessionSnapshot } from "../methods.ts";

const base = { sessionId: "s1", seq: 1, time: 1_700_000_000_000 };
const cwd = "/tmp/project";

export const summary: SessionSummary = {
  id: "s1",
  title: "Fix the failing test",
  cwd,
  projectDir: cwd,
  createdAt: 1_700_000_000_000,
  lastActivityAt: 1_700_000_100_000,
  status: "idle",
  mode: "default",
  model: "qwen-coder",
  effort: null,
  archived: false,
  forkedFrom: null,
  lastSeq: 0,
};

export const modelInfo: ModelInfo = {
  id: "qwen-coder",
  contextWindow: 131072,
  vision: false,
  reasoning: true,
  effortLevels: ["low", "medium", "high"],
};

export const usage: Usage = {
  contextWindow: 131072,
  contextUsed: 2048,
  last: {
    promptTokens: 2000,
    completionTokens: 48,
    cachedTokens: 1800,
    promptTokensPerSecond: 900,
    completionTokensPerSecond: 40,
  },
  totals: {
    requests: 1,
    promptTokens: 2000,
    completionTokens: 48,
    cachedTokens: 1800,
    malformedToolCalls: 0,
  },
};

const tasks: TaskItem[] = [{ content: "Run the tests", status: "in_progress", activeForm: "Running the tests" }];

export const permissionRequest: PermissionRequest = {
  requestId: "p1",
  toolCallId: "c1",
  toolName: "Bash",
  input: { command: "npm test" },
  title: "Run a shell command",
  reason: "No rule allows this command",
  suggestions: ["Bash(npm test *)"],
};

export const snapshot: SessionSnapshot = {
  session: summary,
  modelInfo,
  additionalDirectories: [],
  tasks: [],
  usage: null,
  pending: [{ kind: "permission", turnId: "t1", request: permissionRequest }],
  activeTurnId: "t1",
  commands: [{ name: "compact", description: "Summarise the conversation", argumentHint: "[focus]" }],
};

type MethodSamples = {
  [M in MethodName]: {
    params: MethodParams<M>;
    result: ResultInput<M>;
    badParams: unknown;
    badResult: unknown;
  };
};

export const methodSamples: MethodSamples = {
  initialize: {
    params: { protocolVersion: 1, client: { name: "test", version: "0.0.0" }, capabilities: {} },
    result: {
      protocolVersion: 1,
      engine: { name: "engine", version: "0.0.0" },
      capabilities: { methods: ["initialize"], events: ["session.status"], maxMessageLength: null },
    },
    badParams: { protocolVersion: "1", client: { name: "test", version: "0" } },
    badResult: { protocolVersion: 1, engine: { name: "engine" } },
  },
  "session.create": {
    params: { cwd, mode: "plan" },
    result: snapshot,
    badParams: { cwd: "" },
    badResult: { ...snapshot, pending: [{ kind: "telepathy" }] },
  },
  "session.resume": {
    params: { sessionId: "s1" },
    result: snapshot,
    badParams: { sessionId: 7 },
    badResult: { session: summary },
  },
  "session.fork": {
    params: { sessionId: "s1", point: { position: "beforeTurn", turnId: "t2" } },
    result: {
      ...snapshot,
      session: {
        ...summary,
        id: "s2",
        forkedFrom: { sessionId: "s1", point: { position: "beforeTurn", turnId: "t2" } },
      },
    },
    badParams: { sessionId: "s1", point: { position: "beforeTurn" } },
    badResult: { ...snapshot, activeTurnId: 3 },
  },
  "session.list": {
    params: { includeArchived: true, limit: 50 },
    result: { sessions: [summary], nextCursor: null },
    badParams: { limit: 0 },
    badResult: { sessions: [{ ...summary, status: "sleeping" }], nextCursor: null },
  },
  "session.rename": {
    params: { sessionId: "s1", title: "New title" },
    result: { session: { ...summary, title: "New title" } },
    badParams: { sessionId: "s1", title: "" },
    badResult: { session: { ...summary, archived: "no" } },
  },
  "session.archive": {
    params: { sessionId: "s1" },
    result: { session: { ...summary, archived: true } },
    badParams: { sessionId: "s1", archived: "yes" },
    badResult: {},
  },
  "session.prompt": {
    params: {
      sessionId: "s1",
      prompt: {
        content: [
          { type: "text", text: "Why does this fail?" },
          { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
        ],
        mentions: [{ path: "src/a.ts", startLine: 1, endLine: 20 }],
      },
    },
    result: { turnId: "t1" },
    badParams: { sessionId: "s1", prompt: { content: [] } },
    badResult: { turnId: "" },
  },
  "session.interrupt": {
    params: { sessionId: "s1" },
    result: { interrupted: true },
    badParams: {},
    badResult: { interrupted: "yes" },
  },
  "session.setMode": {
    params: { sessionId: "s1", mode: "acceptEdits" },
    result: { mode: "acceptEdits" },
    badParams: { sessionId: "s1", mode: "yolo" },
    badResult: { mode: "yolo" },
  },
  "session.setModel": {
    params: { sessionId: "s1", model: "qwen-coder" },
    result: { model: "qwen-coder", modelInfo, effort: null },
    badParams: { sessionId: "s1", model: "" },
    badResult: { model: "qwen-coder" },
  },
  "session.setEffort": {
    params: { sessionId: "s1", effort: "high" },
    result: { effort: "high" },
    badParams: { sessionId: "s1", effort: "" },
    badResult: { effort: 3 },
  },
  "session.command": {
    params: { sessionId: "s1", name: "compact", args: "keep the test names" },
    result: { output: null, turnId: null, openedSession: null },
    badParams: { sessionId: "s1", name: "" },
    badResult: { output: null, turnId: null },
  },
  "session.replay": {
    params: { sessionId: "s1", afterSeq: 0, limit: 100 },
    result: {
      events: [
        {
          event: "session.status",
          payload: { ...base, status: "working", waitingOn: null, message: null },
        },
      ],
      lastSeq: 1,
      hasMore: false,
    },
    badParams: { sessionId: "s1", afterSeq: -1 },
    badResult: {
      events: [{ event: "session.status", payload: { ...base, status: "dancing" } }],
      lastSeq: 1,
      hasMore: false,
    },
  },
  "permission.respond": {
    params: {
      sessionId: "s1",
      requestId: "p1",
      response: { behavior: "allow", scope: "always", rules: ["Bash(npm test *)"] },
    },
    result: {},
    badParams: { sessionId: "s1", requestId: "p1", response: { behavior: "maybe" } },
    badResult: null,
  },
  "question.respond": {
    params: {
      sessionId: "s1",
      requestId: "q1",
      response: {
        outcome: "answered",
        answers: [{ question: "Which database?", selected: ["SQLite"] }],
      },
    },
    result: {},
    badParams: { sessionId: "s1", requestId: "q1", response: { outcome: "answered" } },
    badResult: "ok",
  },
  "plan.respond": {
    params: {
      sessionId: "s1",
      requestId: "plan1",
      response: { decision: "approve", mode: "acceptEdits" },
    },
    result: {},
    badParams: { sessionId: "s1", requestId: "plan1", response: { decision: "approve", mode: "x" } },
    badResult: [],
  },
};

type EventSamples = { [E in EventName]: { payload: EventPayloadInput<E>; bad: unknown } };

const errorInfo = {
  kind: "model_unavailable" as const,
  message: "The model server is not responding.",
  detail: null,
  retryable: true,
};

export const eventSamples: EventSamples = {
  "session.status": {
    payload: { ...base, status: "waiting", waitingOn: "permission", message: null },
    bad: { ...base, status: "waiting" },
  },
  "session.updated": {
    payload: {
      ...base,
      title: "Fix the failing test",
      mode: "plan",
      model: "qwen-coder",
      modelInfo,
      effort: null,
      archived: false,
      additionalDirectories: [],
      changed: ["mode"],
    },
    bad: { ...base, title: null, mode: "plan" },
  },
  "turn.started": {
    payload: {
      ...base,
      turnId: "t1",
      prompt: { content: [{ type: "text", text: "Fix it" }] },
      command: null,
    },
    bad: { ...base, turnId: "t1", prompt: { content: [{ type: "audio" }] }, command: null },
  },
  "turn.finished": {
    payload: {
      ...base,
      turnId: "t1",
      stopReason: "completed",
      finalText: "Done.",
      error: null,
      durationMs: 1234,
    },
    bad: { ...base, turnId: "t1", stopReason: "bored", finalText: null, error: null, durationMs: 1 },
  },
  "message.started": {
    payload: { ...base, turnId: "t1", messageId: "m1" },
    bad: { ...base, turnId: "t1" },
  },
  "message.delta": {
    payload: { ...base, turnId: "t1", messageId: "m1", text: "Hel" },
    bad: { ...base, turnId: "t1", messageId: "m1", text: 5 },
  },
  "message.finished": {
    payload: {
      ...base,
      turnId: "t1",
      messageId: "m1",
      text: "Hello",
      reasoning: "The user greets me.",
      toolCalls: [{ toolCallId: "c1", toolName: "Read" }],
    },
    bad: { ...base, turnId: "t1", messageId: "m1", text: "Hello", reasoning: null },
  },
  "reasoning.delta": {
    payload: { ...base, turnId: "t1", messageId: "m1", text: "Thinking" },
    bad: { ...base, messageId: "m1", text: "Thinking" },
  },
  "tool.started": {
    payload: {
      ...base,
      turnId: "t1",
      messageId: "m1",
      toolCallId: "c1",
      toolName: "Read",
      input: { file_path: "/tmp/project/a.ts" },
    },
    bad: { ...base, turnId: "t1", messageId: "m1", toolCallId: "c1", toolName: "Read", input: "x" },
  },
  "tool.progress": {
    payload: {
      ...base,
      turnId: "t1",
      toolCallId: "c1",
      progress: { kind: "output", stream: "stdout", text: "PASS\n" },
    },
    bad: { ...base, turnId: "t1", toolCallId: "c1", progress: { kind: "output", text: "x" } },
  },
  "tool.finished": {
    payload: {
      ...base,
      turnId: "t1",
      toolCallId: "c1",
      toolName: "Edit",
      outcome: "success",
      content: [{ type: "text", text: "Edited a.ts" }],
      display: {
        kind: "diff",
        filePath: "/tmp/project/a.ts",
        created: false,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
        additions: 1,
        deletions: 1,
      },
      durationMs: 12,
    },
    bad: {
      ...base,
      turnId: "t1",
      toolCallId: "c1",
      toolName: "Edit",
      outcome: "exploded",
      content: [],
      display: null,
      durationMs: null,
    },
  },
  "permission.requested": {
    payload: { ...base, turnId: "t1", request: permissionRequest },
    bad: { ...base, turnId: "t1", request: { ...permissionRequest, suggestions: "none" } },
  },
  "question.asked": {
    payload: {
      ...base,
      turnId: "t1",
      requestId: "q1",
      toolCallId: "c2",
      questions: [
        {
          question: "Which database?",
          header: "Database",
          options: [{ label: "SQLite" }, { label: "Postgres", description: "Needs a server" }],
          multiSelect: false,
        },
      ],
    },
    bad: { ...base, turnId: "t1", requestId: "q1", toolCallId: "c2", questions: [] },
  },
  "plan.proposed": {
    payload: {
      ...base,
      turnId: "t1",
      requestId: "plan1",
      toolCallId: "c3",
      plan: "# Plan\n\n1. Do the thing",
      planPath: null,
    },
    bad: { ...base, turnId: "t1", requestId: "plan1", toolCallId: "c3", planPath: null },
  },
  "request.resolved": {
    payload: {
      ...base,
      kind: "permission",
      turnId: "t1",
      requestId: "p1",
      outcome: "answered",
      response: { behavior: "deny", message: "Not now" },
    },
    bad: {
      ...base,
      kind: "plan",
      turnId: "t1",
      requestId: "plan1",
      outcome: "answered",
      response: { behavior: "deny" },
    },
  },
  "tasks.updated": {
    payload: { ...base, tasks },
    bad: { ...base, tasks: [{ content: "x", status: "blocked" }] },
  },
  "usage.updated": {
    payload: { ...base, usage },
    bad: { ...base, usage: { ...usage, contextUsed: -1 } },
  },
  "prompt.progress": {
    payload: { ...base, turnId: "t1", total: 2000, cached: 1800, processed: 1900 },
    bad: { ...base, turnId: "t1", total: 2000, cached: 1800 },
  },
  "compaction.started": {
    payload: {
      ...base,
      compactionId: "k1",
      trigger: "manual",
      turnId: null,
      contextUsed: 90000,
      contextWindow: 131072,
      focus: "keep test names",
    },
    bad: { ...base, compactionId: "k1", trigger: "sometimes", turnId: null },
  },
  "compaction.finished": {
    payload: {
      ...base,
      compactionId: "k1",
      outcome: "completed",
      summary: "Goal: fix the test.",
      contextBefore: 90000,
      contextAfter: 12000,
      error: null,
    },
    bad: { ...base, compactionId: "k1", outcome: "completed" },
  },
  error: {
    payload: { ...base, turnId: null, error: errorInfo },
    bad: { ...base, turnId: null, error: { message: "x" } },
  },
};
