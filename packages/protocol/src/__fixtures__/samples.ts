/**
 * One valid and one invalid sample for every method and event. Typed against the registries, so
 * adding a method or event without samples fails the type-check.
 */
import type {
  BackgroundTask,
  CompatReport,
  CompatSource,
  HookInfo,
  ModelInfo,
  PermissionRequest,
  SessionSummary,
  SkillInfo,
  TaskItem,
  Usage,
} from "../common.ts";
import type { EventName, EventPayloadInput } from "../events.ts";
import type { McpServerInfo } from "../mcp.ts";
import type { SubagentInfo } from "../subagents.ts";
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
  queuePosition: null,
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
  compactAt: 85196,
  breakdown: { systemPrompt: 900, instructions: 148, tools: 700, messages: 300 },
};

const tasks: TaskItem[] = [{ content: "Run the tests", status: "in_progress", activeForm: "Running the tests" }];

export const backgroundTask: BackgroundTask = {
  taskId: "bg1",
  command: "npm run dev",
  description: "Start the dev server",
  cwd,
  status: "running",
  exitCode: null,
  signal: null,
  stopReason: null,
  startedAt: 1_700_000_000_000,
  endedAt: null,
  outputBytes: 19,
};

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
  commands: [
    {
      name: "compact",
      description: "Summarise the conversation",
      argumentHint: "[focus]",
      source: "builtin",
      kind: "command",
    },
    {
      name: "review",
      description: "Review the staged changes",
      argumentHint: null,
      source: "project",
      kind: "skill",
    },
  ],
  background: [backgroundTask],
};

/** Where the sample hook comes from: a project's Claude Code settings. */
const hookSource: CompatSource = {
  path: "/Users/me/tally/.claude/settings.json",
  origin: "claude",
  scope: "project",
};

export const compatReport: CompatReport = {
  projectDir: "/Users/me/tally",
  items: [
    {
      kind: "skill",
      name: "review",
      source: {
        path: "/Users/me/tally/.claude/skills/review/SKILL.md",
        origin: "claude",
        scope: "project",
      },
      status: "loaded",
      notes: [],
    },
    {
      kind: "hook",
      name: "PreToolUse on Bash: ./scripts/check-command.sh",
      source: hookSource,
      status: "needs-approval",
      notes: ["Runs a command from the project's files."],
    },
  ],
  approval: {
    hash: "sha256:9f2c",
    approved: false,
    items: [
      {
        kind: "hook",
        name: "PreToolUse on Bash: ./scripts/check-command.sh",
        source: hookSource,
        status: "needs-approval",
        notes: ["Runs a command from the project's files."],
      },
    ],
  },
};

/** The sample hook as Settings → Hooks lists it. */
export const hookInfo: HookInfo = {
  id: "hook:7d1e",
  event: "PreToolUse",
  matcher: "Bash",
  type: "command",
  command: "./scripts/check-command.sh",
  timeout: null,
  source: hookSource,
  status: "needs-approval",
  notes: ["Runs a command from the project's files."],
  enabled: true,
};

/** The sample skill as Settings → Skills and commands lists it. */
export const skillInfo: SkillInfo = {
  name: "review",
  kind: "skill",
  description: "Review the current changes for bugs and style",
  argumentHint: "[focus]",
  source: { path: "/Users/me/tally/.claude/skills/review/SKILL.md", origin: "claude", scope: "project" },
  userInvocable: true,
  modelInvocable: true,
  status: "partly-supported",
  notes: ["model “sonnet” is mapped to the session's model: model names are mapped, not obeyed."],
};

type MethodSamples = {
  [M in MethodName]: {
    params: MethodParams<M>;
    result: ResultInput<M>;
    badParams: unknown;
    badResult: unknown;
  };
};

export const mcpServer: McpServerInfo = {
  name: "github",
  scope: "project",
  source: { path: "/Users/me/tally/.mcp.json", origin: "claude", scope: "project" },
  transport: "stdio",
  target: "npx -y @modelcontextprotocol/server-github",
  state: "connected",
  reason: null,
  tools: [
    { name: "mcp__github__get_issue", tool: "get_issue", description: "Get an issue by number" },
  ],
  prompts: 1,
  resources: 0,
  enabled: true,
  notes: [],
};

export const subagentInfo: SubagentInfo = {
  agentId: "agent-1",
  sessionId: "s1-agent-1",
  agentType: "Explore",
  description: "Find the config loader",
  toolCallId: "c1",
  turnId: "t1",
  fork: false,
  background: false,
  status: "running",
  queuePosition: null,
  worktree: null,
  startedAt: 1_700_000_000_000,
  endedAt: null,
  toolUses: 2,
  activity: "Read src/config.ts",
  result: null,
  error: null,
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
  "session.delete": {
    params: { sessionId: "s1" },
    result: {},
    badParams: { sessionId: "" },
    badResult: null,
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
  "session.checkpoints": {
    params: { sessionId: "s1" },
    result: {
      checkpoints: [
        {
          id: "turn-4",
          turnId: "turn-4",
          time: 1_700_000_000_000,
          prompt: "Add a greeting",
          tracked: true,
          files: [{ path: `${cwd}/hello.txt`, change: "created" }],
          restore: [{ path: `${cwd}/hello.txt`, action: "delete", changedOutside: false }],
        },
      ],
      retention: 100,
    },
    badParams: { sessionId: "" },
    badResult: {
      checkpoints: [{ id: "turn-4", turnId: "turn-4", time: 1, prompt: "", tracked: true, files: [], restore: [{ path: "/a", action: "shred", changedOutside: false }] }],
      retention: 100,
    },
  },
  "session.rewind": {
    params: { sessionId: "s1", checkpointId: "turn-4", action: "both" },
    result: {
      outcome: "done",
      conflicts: [],
      files: { restored: [`${cwd}/readme.md`], deleted: [`${cwd}/hello.txt`], skipped: [] },
      session: snapshot,
      prompt: "Add a greeting",
    },
    badParams: { sessionId: "s1", checkpointId: "turn-4", action: "undo-everything" },
    badResult: { outcome: "maybe", conflicts: [], files: null, session: null, prompt: null },
  },
  "background.output": {
    params: { sessionId: "s1", taskId: "bg1" },
    result: { text: "listening on :3000\n", nextOffset: 19, totalBytes: 19, done: false },
    badParams: { sessionId: "s1", taskId: "bg1", limit: 0 },
    badResult: { text: 1, nextOffset: 0, totalBytes: 0, done: false },
  },
  "background.stop": {
    params: { sessionId: "s1", taskId: "bg1" },
    result: { stopped: true },
    badParams: { sessionId: "s1" },
    badResult: {},
  },
  "subagent.stop": {
    params: { sessionId: "s1", agentId: "agent-1" },
    result: { stopped: true },
    badParams: { sessionId: "s1", agentId: "" },
    badResult: { stopped: "yes" },
  },
  "project.inspect": {
    params: { projectDir: "/Users/me/tally" },
    result: compatReport,
    badParams: { projectDir: "" },
    badResult: { ...compatReport, items: [{ ...compatReport.items[0], status: "maybe" }] },
  },
  "project.trust": {
    params: { projectDir: "/Users/me/tally", hash: "sha256:9f2c", approved: true },
    result: { approved: true },
    badParams: { projectDir: "/Users/me/tally", hash: "", approved: true },
    badResult: { approved: "yes" },
  },
  "hooks.list": {
    params: { projectDir: "/Users/me/tally" },
    result: { projectDir: "/Users/me/tally", hooks: [hookInfo], disabledBy: null },
    badParams: { projectDir: 3 },
    badResult: {
      projectDir: "/Users/me/tally",
      hooks: [{ ...hookInfo, enabled: "yes" }],
      disabledBy: null,
    },
  },
  "hooks.setEnabled": {
    params: { projectDir: "/Users/me/tally", id: hookInfo.id, enabled: false },
    result: { enabled: false },
    badParams: { projectDir: "/Users/me/tally", id: "", enabled: false },
    badResult: { enabled: null },
  },
  "project.skills": {
    params: { projectDir: "/Users/me/tally" },
    result: {
      projectDir: "/Users/me/tally",
      skills: [skillInfo],
      commands: [
        {
          ...skillInfo,
          name: "frontend:test",
          kind: "command",
          description: "Run the frontend tests",
          argumentHint: null,
          source: {
            path: "/Users/me/.claude/commands/frontend/test.md",
            origin: "claude",
            scope: "user",
          },
          modelInvocable: false,
          status: "loaded",
          notes: [],
        },
      ],
    },
    badParams: { projectDir: "" },
    badResult: { projectDir: null, skills: [{ ...skillInfo, kind: "agent" }], commands: [] },
  },
  "mcp.list": {
    params: { projectDir: "/Users/me/tally" },
    result: { projectDir: "/Users/me/tally", servers: [mcpServer], importable: 2 },
    badParams: { projectDir: 3 },
    badResult: {
      projectDir: "/Users/me/tally",
      servers: [{ ...mcpServer, state: "sleeping" }],
      importable: 0,
    },
  },
  "mcp.restart": {
    params: { projectDir: "/Users/me/tally", name: "github" },
    result: { server: mcpServer },
    badParams: { projectDir: "/Users/me/tally", name: "" },
    badResult: { server: { ...mcpServer, tools: null } },
  },
  "mcp.setEnabled": {
    params: { projectDir: null, name: "github", enabled: false },
    result: { enabled: false },
    badParams: { projectDir: null, name: "github" },
    badResult: { enabled: "no" },
  },
  "mcp.importPreview": {
    params: {},
    result: {
      from: "/Users/me/.claude.json",
      to: "/Users/me/.dawg/mcp.json",
      hash: "sha256:abc",
      items: [
        {
          name: "github",
          project: null,
          transport: "stdio",
          target: "npx -y @modelcontextprotocol/server-github",
          secrets: ["env GITHUB_TOKEN"],
          action: "copy",
          reason: null,
        },
      ],
    },
    badParams: null,
    badResult: { from: "/Users/me/.claude.json", to: "x", hash: null, items: [{ name: "" }] },
  },
  "mcp.import": {
    params: { hash: "sha256:abc" },
    result: { imported: 1, path: "/Users/me/.dawg/mcp.json" },
    badParams: { hash: "" },
    badResult: { imported: -1, path: "/Users/me/.dawg/mcp.json" },
  },
  "mcp.session": {
    params: { sessionId: "s1" },
    result: {
      resources: [
        {
          server: "docs",
          uri: "file://api/auth.md",
          name: "Authentication",
          description: "How the API signs requests",
          mimeType: "text/markdown",
          mention: "@docs:file://api/auth.md",
        },
      ],
      prompts: [
        {
          name: "mcp__github__pr_review",
          description: "Review a pull request (MCP)",
          argumentHint: "<number>",
          source: "user",
          kind: "command",
        },
      ],
    },
    badParams: { sessionId: "" },
    badResult: { resources: [{ server: "docs" }], prompts: [] },
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
  "session.deleted": {
    payload: { ...base },
    bad: { ...base, time: -1 },
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
  "background.updated": {
    payload: { ...base, task: backgroundTask },
    bad: { ...base, task: { ...backgroundTask, status: "paused" } },
  },
  "subagent.updated": {
    payload: { ...base, agent: subagentInfo },
    bad: { ...base, agent: { ...subagentInfo, status: "sleeping" } },
  },
  "hook.ran": {
    payload: {
      ...base,
      turnId: "t1",
      toolCallId: "c1",
      hook: {
        event: "PreToolUse",
        matcher: "Bash",
        type: "command",
        command: "./scripts/check-command.sh",
        source: hookSource,
      },
      outcome: "blocked",
      exitCode: 2,
      durationMs: 41,
      decision: "deny",
      message: "rm -rf is not allowed in this project",
    },
    bad: {
      ...base,
      turnId: "t1",
      toolCallId: "c1",
      hook: { event: "PreToolUse", matcher: null, type: "command", command: "x", source: hookSource },
      outcome: "exploded",
      exitCode: 1,
      durationMs: 1,
      decision: null,
      message: null,
    },
  },
  "hook.skipped": {
    payload: { ...base, turnId: "t1", projectDir: "/Users/me/tally", sources: [hookSource] },
    bad: { ...base, turnId: "t1", projectDir: "/Users/me/tally", sources: [{ path: "" }] },
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
