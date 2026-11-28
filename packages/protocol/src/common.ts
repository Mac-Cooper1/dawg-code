/**
 * Data shapes shared by the protocol's requests and events and by the engine's internals.
 *
 * This file is a contract: the engine's tools, permission engine and session store are written
 * against these types. Add to it freely; rename or remove only deliberately, and say so.
 */
import { z } from "zod";
import { CommandSandboxSchema } from "./sandbox.ts";

/**
 * Additive changes keep this number. Breaking changes bump it, including a value added to an enum
 * the engine sends (README, "Versioning"). 2: Phase 4 (new tool display kinds, the "elicitation"
 * pending request). 1: Phases 1 to 3.
 */
export const PROTOCOL_VERSION = 2;

// ---------------------------------------------------------------------------------------------
// Modes and status
// ---------------------------------------------------------------------------------------------

export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const SessionStatusSchema = z.enum(["idle", "working", "waiting", "error"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * Set while the session's turn waits for its model because the model is busy with other
 * sessions' requests; `status` is then "working". 1 means it is next in line. Null otherwise.
 */
export const QueuePositionSchema = z.number().int().positive().nullable().default(null);

/**
 * A reasoning effort level. Open-ended on purpose: the levels a model accepts come from its chat
 * template, as reported by the endpoint.
 */
export const EffortSchema = z.string().min(1).max(32);
export type Effort = z.infer<typeof EffortSchema>;

// ---------------------------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------------------------

export const TextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export type TextPart = z.infer<typeof TextPartSchema>;

export const ImagePartSchema = z.object({
  type: z.literal("image"),
  /** For example "image/png". */
  mediaType: z.string(),
  /** Base64, no data-URL prefix. */
  data: z.string(),
});
export type ImagePart = z.infer<typeof ImagePartSchema>;

export const ContentPartSchema = z.discriminatedUnion("type", [TextPartSchema, ImagePartSchema]);
export type ContentPart = z.infer<typeof ContentPartSchema>;

// ---------------------------------------------------------------------------------------------
// Task list (the TodoWrite tool)
// ---------------------------------------------------------------------------------------------

export const TaskStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskItemSchema = z.object({
  content: z.string(),
  status: TaskStatusSchema,
  /** Present-tense form shown while the task is in progress. */
  activeForm: z.string().optional(),
});
export type TaskItem = z.infer<typeof TaskItemSchema>;

// ---------------------------------------------------------------------------------------------
// What a tool call looks like to a client
// ---------------------------------------------------------------------------------------------

export const DiffHunkSchema = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  /** Unified-diff lines: each starts with " ", "+" or "-". No trailing newline. */
  lines: z.array(z.string()),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

export const DiffDisplaySchema = z.object({
  kind: z.literal("diff"),
  /** Absolute path. */
  filePath: z.string(),
  /** True when the file did not exist before. */
  created: z.boolean(),
  hunks: z.array(DiffHunkSchema),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type DiffDisplay = z.infer<typeof DiffDisplaySchema>;

export const FileDisplaySchema = z.object({
  kind: z.literal("file"),
  /** Absolute path. */
  filePath: z.string(),
  /** 1-based line number of the first line returned. */
  startLine: z.number().int().positive(),
  lineCount: z.number().int().nonnegative(),
  /** Lines in the whole file, when known. */
  totalLines: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
});
export type FileDisplay = z.infer<typeof FileDisplaySchema>;

export const CommandDisplaySchema = z.object({
  kind: z.literal("command"),
  command: z.string(),
  /** Directory the command ran in (absolute). */
  cwd: z.string(),
  /** Null while running in the background or when killed by a signal. */
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  timedOut: z.boolean(),
  interrupted: z.boolean(),
  /** Set when the command was started in the background. */
  backgroundTaskId: z.string().nullable(),
  /** File holding the full output, when it was cut or the command runs in the background. */
  outputPath: z.string().nullable(),
  /**
   * What the command printed, as a person should see it: stdout and stderr together in the order
   * they arrived, as plain text (terminal control sequences removed), without the notes the engine
   * adds for the model (the exit code, a timeout, where the full output is saved). When the output
   * was cut, its beginning and end as the model saw them; `outputPath` then holds the whole.
   * Empty when the command printed nothing. Null when there is no output to show yet (a command
   * just started in the background) and in sessions stored before engines reported it.
   */
  output: z.string().nullable().default(null),
  /**
   * The sentences the engine added for the model after the output, one per entry: a timeout,
   * where the full output is saved, processes left running and the like. The exit code is not
   * among them (`exitCode` carries it). Empty in sessions stored before engines reported it.
   */
  notes: z.array(z.string()).default([]),
  /**
   * Added (Phase 4, sandbox): how the command ran with respect to the sandbox (sandbox.ts).
   * Absent when the sandbox is off, and in sessions stored before engines reported it.
   */
  sandbox: CommandSandboxSchema.optional(),
});
export type CommandDisplay = z.infer<typeof CommandDisplaySchema>;

export const SearchDisplaySchema = z.object({
  kind: z.literal("search"),
  pattern: z.string(),
  /** Matching files (Glob, Grep in files mode) or matching lines (Grep in content mode). */
  resultCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type SearchDisplay = z.infer<typeof SearchDisplaySchema>;

/** A page WebFetch fetched, or the redirect it reported instead of following. */
export const WebFetchDisplaySchema = z.object({
  kind: z.literal("web-fetch"),
  /** The URL fetched, after http was upgraded to https. */
  url: z.string(),
  /** The HTTP status of the last response. */
  status: z.number().int(),
  /** The media type, without parameters ("text/html"). Empty when the server sent none. */
  contentType: z.string(),
  /** Bytes downloaded (after decompression). */
  bytes: z.number().int().nonnegative(),
  /** Characters of the page as text (Markdown for HTML). */
  chars: z.number().int().nonnegative(),
  /** The start of the page as text, for a person to glance at. */
  preview: z.string(),
  /** Set when the page redirected to another host: the URL the model was told to fetch next. */
  redirectUrl: z.string().nullable(),
  /** "model": the session's utility model answered the prompt; "page": the text was given. */
  answeredBy: z.enum(["model", "page"]),
  /** True when the page came from the 15-minute cache. */
  cached: z.boolean(),
});
export type WebFetchDisplay = z.infer<typeof WebFetchDisplaySchema>;

/** A WebSearch call's results. */
export const WebSearchDisplaySchema = z.object({
  kind: z.literal("web-search"),
  query: z.string(),
  /** For people: "Brave Search". */
  provider: z.string(),
  results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })),
});
export type WebSearchDisplay = z.infer<typeof WebSearchDisplaySchema>;

/** A call to an MCP server's tool, made by its own name or through `CallMcpTool` (see mcp.ts). */
export const McpDisplaySchema = z.object({
  kind: z.literal("mcp"),
  /** The server's name in its configuration: "github". */
  server: z.string(),
  /** The tool's own name on that server: "get_issue". */
  tool: z.string(),
  /** The result as text for a person: its text, and a line for each image or resource. Capped. */
  text: z.string(),
  /** Images the result held. */
  images: z.number().int().nonnegative(),
  /** True when the server said the call failed. */
  isError: z.boolean(),
  /** Characters of the whole result's text. */
  chars: z.number().int().nonnegative(),
  /** Where the whole result was saved when it was too long to give the model, else null. */
  savedTo: z.string().nullable(),
});
export type McpDisplay = z.infer<typeof McpDisplaySchema>;

export const ToolDisplaySchema = z.discriminatedUnion("kind", [
  DiffDisplaySchema,
  FileDisplaySchema,
  CommandDisplaySchema,
  SearchDisplaySchema,
  WebFetchDisplaySchema,
  WebSearchDisplaySchema,
  McpDisplaySchema,
]);
export type ToolDisplay = z.infer<typeof ToolDisplaySchema>;

// ---------------------------------------------------------------------------------------------
// Permission requests
// ---------------------------------------------------------------------------------------------

/**
 * Added (Phase 4, subagents): which subagent something comes from. A subagent's permission
 * prompts are shown in its parent session, labelled with it. See subagents.ts.
 */
export const SubagentLabelSchema = z.object({
  /** The id the model uses to send the agent another message, unique in the parent: "agent-1". */
  agentId: z.string().min(1),
  /** The agent's own session, whose events `session.replay` returns (read-only). */
  sessionId: z.string().min(1),
  /** "Explore", "Plan", "general-purpose", a custom agent's name, or "fork". */
  agentType: z.string().min(1),
  /** The short description the model gave the task. */
  description: z.string(),
});
export type SubagentLabel = z.infer<typeof SubagentLabelSchema>;

export const PermissionRequestSchema = z.object({
  requestId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  /** One line a person can read, for example "Run a shell command". */
  title: z.string(),
  /** Why this needs an answer, for example "No rule allows this command". */
  reason: z.string(),
  /** Rules that "allow always" would save, in `Tool(specifier)` form. May be empty. */
  suggestions: z.array(z.string()),
  /** A preview of the effect, such as the diff an edit would make. */
  display: ToolDisplaySchema.optional(),
  /** Added: set when a subagent asks; `toolCallId` is then a call in the agent's own session. */
  agent: SubagentLabelSchema.optional(),
  /**
   * Added (Phase 4, sandbox): set for a shell command while the sandbox is on: where it would
   * run, and why outside when it would (sandbox.ts).
   */
  sandbox: CommandSandboxSchema.optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const PermissionResponseSchema = z.discriminatedUnion("behavior", [
  z.object({
    behavior: z.literal("allow"),
    /** "always" also saves a rule to the project's personal settings. */
    scope: z.enum(["once", "always"]),
    /** Rules to save with "always". Defaults to the request's suggestions. */
    rules: z.array(z.string()).optional(),
  }),
  z.object({
    behavior: z.literal("deny"),
    /** Passed to the model as the reason for the denial. */
    message: z.string().optional(),
  }),
]);
export type PermissionResponse = z.infer<typeof PermissionResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Ask-the-user questions (the AskUserQuestion tool)
// ---------------------------------------------------------------------------------------------

export const QuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

export const QuestionSchema = z.object({
  question: z.string(),
  /** A very short label for the question. */
  header: z.string().optional(),
  options: z.array(QuestionOptionSchema),
  multiSelect: z.boolean(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionAnswerSchema = z.object({
  /** The question text this answers. */
  question: z.string(),
  /** Labels of the chosen options. Empty when only free text was given. */
  selected: z.array(z.string()),
  /** Free text typed instead of, or alongside, the options. */
  text: z.string().optional(),
});
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;

// ---------------------------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------------------------

/** Tokens of the model's view, by part. */
export const ContextBreakdownSchema = z.object({
  /** The engine's own system prompt, without instruction files. */
  systemPrompt: z.number().int().nonnegative(),
  /** Instruction files (memory files) loaded into the prompt. */
  instructions: z.number().int().nonnegative(),
  /** Tool definitions. */
  tools: z.number().int().nonnegative(),
  /** The conversation: messages, tool calls and their results, compaction summaries. */
  messages: z.number().int().nonnegative(),
});
export type ContextBreakdown = z.infer<typeof ContextBreakdownSchema>;

export const UsageSchema = z.object({
  /** The endpoint's real context window, in tokens. */
  contextWindow: z.number().int().nonnegative(),
  /** Tokens in the model's view after the latest request (prompt plus reply). */
  contextUsed: z.number().int().nonnegative(),
  /** The latest request. Null where the endpoint did not report a number. */
  last: z.object({
    promptTokens: z.number().int().nonnegative().nullable(),
    completionTokens: z.number().int().nonnegative().nullable(),
    /** Prompt tokens reused from the cache rather than processed again. */
    cachedTokens: z.number().int().nonnegative().nullable(),
    promptTokensPerSecond: z.number().nonnegative().nullable(),
    completionTokensPerSecond: z.number().nonnegative().nullable(),
  }),
  /** Running totals for the session. */
  totals: z.object({
    requests: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative(),
    /** Tool calls that failed to parse or validate, including ones that were repaired. */
    malformedToolCalls: z.number().int().nonnegative(),
  }),
  /**
   * The context size, in tokens, above which the engine compacts the conversation on its own
   * before the next turn starts. Null when it never compacts on its own, and in sessions stored
   * before engines reported it.
   */
  compactAt: z.number().int().nonnegative().nullable().default(null),
  /**
   * What fills `contextUsed`. The endpoint counts only the whole, so the split is estimated and
   * scaled to add up to `contextUsed`. Null in sessions stored before engines reported it.
   */
  breakdown: ContextBreakdownSchema.nullable().default(null),
});
export type Usage = z.infer<typeof UsageSchema>;

// ---------------------------------------------------------------------------------------------
// Additions for the protocol (wave 2). Everything below is additive.
// ---------------------------------------------------------------------------------------------

/** Milliseconds since the Unix epoch. Times travel as plain numbers so payloads stay JSON. */
export const TimestampSchema = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof TimestampSchema>;

export const SessionIdSchema = z.string().min(1);
export type SessionId = z.infer<typeof SessionIdSchema>;

// ---------------------------------------------------------------------------------------------
// Background commands (Bash with run_in_background)
// ---------------------------------------------------------------------------------------------

export const BackgroundTaskSchema = z.object({
  /** The id the model uses with TaskOutput and TaskStop. */
  taskId: z.string().min(1),
  command: z.string(),
  /** The model's short description of the command, when it gave one. */
  description: z.string().nullable(),
  /** Directory the command started in (absolute). */
  cwd: z.string(),
  status: z.enum(["running", "completed", "failed", "stopped"]),
  /** Null while it runs, and when a signal ended it. */
  exitCode: z.number().int().nullable(),
  /** The signal that ended it ("SIGTERM"), when one did. */
  signal: z.string().nullable(),
  /** Why dawg stopped it: asked to (by the person or the model), a limit, or the session ended. */
  stopReason: z.enum(["requested", "time_limit", "output_limit", "session_end"]).nullable(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.nullable(),
  /** Output written so far, in bytes. */
  outputBytes: z.number().int().nonnegative(),
});
export type BackgroundTask = z.infer<typeof BackgroundTaskSchema>;

// Progress a running tool reports. Mirrors `ToolProgress` in the engine's tool contract.
export const ToolProgressSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("output"),
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("status"),
    message: z.string(),
  }),
]);
export type ToolProgress = z.infer<typeof ToolProgressSchema>;

// ---------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------

/** An `@` mention of a file or directory in a prompt. */
export const FileMentionSchema = z.object({
  /** Absolute, or relative to the session's working directory. */
  path: z.string().min(1),
  /** 1-based, inclusive. Both absent means the whole file. */
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});
export type FileMention = z.infer<typeof FileMentionSchema>;

/** What a person sends: text and images, plus the files they mentioned. */
export const PromptSchema = z.object({
  content: z.array(ContentPartSchema).min(1),
  mentions: z.array(FileMentionSchema).default([]),
});
export type Prompt = z.infer<typeof PromptSchema>;
export type PromptInput = z.input<typeof PromptSchema>;

// ---------------------------------------------------------------------------------------------
// Answers to questions and plans
// ---------------------------------------------------------------------------------------------

export const QuestionResponseSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("answered"),
    /** One answer per question asked, in any order (matched by question text). */
    answers: z.array(QuestionAnswerSchema),
  }),
  z.object({
    /** The person closed the question without answering. */
    outcome: z.literal("dismissed"),
    /** Passed to the model. */
    message: z.string().optional(),
  }),
]);
export type QuestionResponse = z.infer<typeof QuestionResponseSchema>;

export const PlanResponseSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    /**
     * The mode to leave plan mode into, for example "acceptEdits" for "approve and accept edits".
     * Omitted means the mode the session was in before it entered plan mode (the plan request's
     * `modeBeforePlan`).
     */
    mode: PermissionModeSchema.optional(),
  }),
  z.object({
    /** Keep planning. */
    decision: z.literal("reject"),
    /** Feedback passed to the model. */
    message: z.string().optional(),
  }),
]);
export type PlanResponse = z.infer<typeof PlanResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Turns and errors
// ---------------------------------------------------------------------------------------------

/** Why a turn ended. */
export const StopReasonSchema = z.enum([
  /** The model replied without tool calls. */
  "completed",
  /** The session's turn limit was reached. */
  "turn_limit",
  /** The person interrupted it. */
  "interrupted",
  /** An unrecoverable error; the turn's `error` says which. */
  "error",
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

/**
 * Kinds of user-presentable error. Kinds a newer engine adds arrive as "other", so this list can
 * grow without breaking older clients.
 */
export const ErrorKindSchema = z
  .enum([
    /** The model endpoint could not be reached. */
    "model_unavailable",
    /** The endpoint answered with an error. */
    "model_error",
    /** The conversation no longer fits the context window, even after compaction. */
    "context_overflow",
    /** The model kept producing calls that could not be parsed or repaired. */
    "invalid_model_output",
    /** The model repeated the same call with the same result until the guard stopped it. */
    "repetition",
    /** A tool failed in a way the model could not act on. */
    "tool_failure",
    /** The session transcript could not be read or written. */
    "storage",
    /** A bug in the engine. */
    "internal",
    "other",
  ])
  .catch("other");
export type ErrorKind = z.infer<typeof ErrorKindSchema>;

export const ErrorInfoSchema = z.object({
  kind: ErrorKindSchema,
  /** One or two sentences a person can read. */
  message: z.string(),
  /** Extra technical detail, such as the endpoint's response body. */
  detail: z.string().nullable(),
  /** True when trying the same thing again may work. */
  retryable: z.boolean(),
});
export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

/** Where a fork starts copying from its parent. */
export const ForkPointSchema = z.discriminatedUnion("position", [
  /** Everything up to the last finished turn. */
  z.object({ position: z.literal("end") }),
  /** History up to, but not including, the given turn. */
  z.object({ position: z.literal("beforeTurn"), turnId: z.string().min(1) }),
  /** History up to and including the given turn. */
  z.object({ position: z.literal("afterTurn"), turnId: z.string().min(1) }),
]);
export type ForkPoint = z.infer<typeof ForkPointSchema>;

/** One row of the session list. */
export const SessionSummarySchema = z.object({
  id: SessionIdSchema,
  /** Null until a title has been generated or set. */
  title: z.string().nullable(),
  /** Working directory (absolute). For a worktree session, the worktree. */
  cwd: z.string(),
  /** The project the session belongs to (absolute). Equals `cwd` unless it runs in a worktree. */
  projectDir: z.string(),
  createdAt: TimestampSchema,
  lastActivityAt: TimestampSchema,
  /** A session not open on any connection is "idle", or "error" if its last turn failed. */
  status: SessionStatusSchema,
  /** As in the `session.status` event: set while the turn waits for its model. */
  queuePosition: QueuePositionSchema,
  mode: PermissionModeSchema,
  /** Null when no model has been chosen yet. */
  model: z.string().nullable(),
  /** Null means the model's default. */
  effort: EffortSchema.nullable(),
  archived: z.boolean(),
  forkedFrom: z
    .object({
      sessionId: SessionIdSchema,
      point: ForkPointSchema,
    })
    .nullable(),
  /** Sequence number of the session's latest event; 0 when it has none. */
  lastSeq: z.number().int().nonnegative(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** What a session's model can do, as reported by its endpoint. */
export const ModelInfoSchema = z.object({
  id: z.string(),
  /** The real context window, in tokens. */
  contextWindow: z.number().int().nonnegative(),
  vision: z.boolean(),
  reasoning: z.boolean(),
  /** Effort levels the model's template accepts. Empty when it has none. */
  effortLevels: z.array(EffortSchema),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

/** A slash command, for the composer's `/` menu. */
export const CommandInfoSchema = z.object({
  /** Without the leading slash, for example "compact", or "frontend:test" with a namespace. */
  name: z.string().min(1),
  description: z.string(),
  /** Shown after the name, for example "[focus]". Null when it takes no arguments. */
  argumentHint: z.string().nullable(),
  /**
   * Where it comes from: built into dawg, or a custom command or skill in the person's own files
   * (`~/.claude`, `~/.dawg`) or the project's. Missing means built in.
   */
  source: z.enum(["builtin", "user", "project"]).optional(),
  /** A slash command, or a skill the person can also run by name. Missing means a command. */
  kind: z.enum(["command", "skill"]).optional(),
});
export type CommandInfo = z.infer<typeof CommandInfoSchema>;

// ---------------------------------------------------------------------------------------------
// Compatibility with Claude Code setups (Phase 4): what a project and the person's home hold,
// what dawg does with each item, and the consent project-supplied code needs.
// ---------------------------------------------------------------------------------------------

export const CompatItemKindSchema = z.enum([
  /** CLAUDE.md, AGENTS.md and the files they import. */
  "instructions",
  /** A settings file as a whole (its permissions, env and so on). */
  "settings",
  /** A custom slash command: a Markdown file under a `commands` folder, at any depth. */
  "command",
  /** `skills/<name>/SKILL.md`. */
  "skill",
  /** A subagent: `agents/*.md`. */
  "agent",
  /** One hook handler from a settings file's `hooks`. */
  "hook",
  /** An MCP server from `.mcp.json`, `~/.claude.json` or a settings file. */
  "mcp-server",
  /** Output styles, plugins, a status line, keybindings and anything else found. */
  "other",
]);
export type CompatItemKind = z.infer<typeof CompatItemKindSchema>;

/** Where an item was found. */
export const CompatSourceSchema = z.object({
  /** The file that defines it (absolute). */
  path: z.string().min(1),
  /** Whose convention: Claude Code's `.claude` folders and files, or dawg's own `.dawg`. */
  origin: z.enum(["claude", "dawg"]),
  /**
   * user: the person's home; project: the project's shared files; local: the project's personal
   * files; nested: a folder inside the project; flags: the command line.
   */
  scope: z.enum(["user", "project", "local", "nested", "flags"]),
});
export type CompatSource = z.infer<typeof CompatSourceSchema>;

export const CompatItemStatusSchema = z.enum([
  /** Works as documented. */
  "loaded",
  /** Project-supplied code waiting for the person's consent before it runs. */
  "needs-approval",
  /** Loaded, but some fields or events are ignored; `notes` names each. */
  "partly-supported",
  /** Depends on something dawg does not have (Anthropic's cloud) or does not have yet. */
  "not-supported",
  /** The file could not be read or parsed; `notes` says why. */
  "invalid",
]);
export type CompatItemStatus = z.infer<typeof CompatItemStatusSchema>;

export const CompatItemSchema = z.object({
  kind: CompatItemKindSchema,
  /** For people: "/review", "PostToolUse on Edit|Write: npm run lint", "github". */
  name: z.string().min(1),
  source: CompatSourceSchema,
  status: CompatItemStatusSchema,
  /** Sentences: each unsupported field or event, why it needs approval, or what is wrong. */
  notes: z.array(z.string()).default([]),
});
export type CompatItem = z.infer<typeof CompatItemSchema>;

/**
 * Code a setup supplies that runs only with the person's consent: hooks and MCP servers from a
 * project's files (and from Claude Code's own user files, which were written for another app).
 */
export const CodeApprovalSchema = z.object({
  /**
   * A hash of every such definition. Consent is kept under it, so any change to the
   * definitions asks again.
   */
  hash: z.string().min(1),
  approved: z.boolean(),
  /** The definitions, as the person should see them before deciding. */
  items: z.array(CompatItemSchema),
});
export type CodeApproval = z.infer<typeof CodeApprovalSchema>;

/** Everything a setup holds and what dawg does with it (`dawg compat`, Settings → Project setup). */
export const CompatReportSchema = z.object({
  /** The project the report covers (absolute), or null for only the person's own files. */
  projectDir: z.string().nullable(),
  items: z.array(CompatItemSchema),
  /** Null when nothing in the setup needs consent. */
  approval: CodeApprovalSchema.nullable(),
});
export type CompatReport = z.infer<typeof CompatReportSchema>;

/** Added (Phase 4, hooks): what an http, prompt, agent or mcp_tool hook reaches. */
export const HookReachesSchema = z.object({
  /** http: the URL's host, with its port when it has one. */
  host: z.string().nullable(),
  /** prompt and agent: `model` as written (mapped to a local model), or null for the default. */
  model: z.string().nullable(),
  /** mcp_tool: the MCP server and its tool. */
  server: z.string().nullable(),
  tool: z.string().nullable(),
});
export type HookReaches = z.infer<typeof HookReachesSchema>;

/**
 * One hook handler as Settings → Hooks lists it (Phase 4): where it comes from, what it runs,
 * whether dawg runs it, and the person's switch for it.
 */
export const HookInfoSchema = z.object({
  /**
   * Names this definition (its file, event, matcher and handler) while it stays unchanged; what
   * `hooks.setEnabled` takes. A changed definition gets a new id.
   */
  id: z.string().min(1),
  /** The documented event name: "PreToolUse", "Stop"... */
  event: z.string().min(1),
  /** As written in the settings file; null when the group has none. */
  matcher: z.string().nullable(),
  /** The handler type as written: "command", "http", "prompt", "agent", "mcp_tool". */
  type: z.string().min(1),
  /** What it runs, as written: the command (with its arguments), the URL or the prompt. */
  command: z.string(),
  /** Its own timeout in seconds, or null for the documented default. */
  timeout: z.number().nonnegative().nullable(),
  source: CompatSourceSchema,
  /**
   * What dawg does with it: loaded (it runs), needs-approval (it waits for the person's consent,
   * `project.trust`), partly-supported (it runs, `notes` say what is ignored), not-supported.
   */
  status: CompatItemStatusSchema,
  notes: z.array(z.string()).default([]),
  /** The person's own switch (Settings → Hooks). An off hook never runs. */
  enabled: z.boolean(),
  /**
   * Added (Phase 4, hooks): what a hook that is not a command reaches, for people. Null (or
   * absent, from an older engine) for a command hook.
   */
  reaches: HookReachesSchema.nullable().optional(),
});
export type HookInfo = z.infer<typeof HookInfoSchema>;

/**
 * One skill or custom command as Settings → Skills and commands lists it (Phase 4): what it is,
 * where it comes from, who may run it, and what dawg does with it.
 */
export const SkillInfoSchema = z.object({
  /** Without the slash: "review", "frontend:test", "apps/web:deploy" for a nested skill. */
  name: z.string().min(1),
  kind: z.enum(["skill", "command"]),
  /** The front matter's description, else the body's first line; "" when there is neither. */
  description: z.string(),
  /** Shown after the name in the `/` menu, for example "[issue-number]"; null when none. */
  argumentHint: z.string().nullable(),
  source: CompatSourceSchema,
  /**
   * A person can run it by typing `/name`: it does not opt out, its name can be typed, and it is
   * not one of dawg's own commands' names.
   */
  userInvocable: z.boolean(),
  /** The agent may load it on its own (it does not set `disable-model-invocation`). */
  modelInvocable: z.boolean(),
  /** Loaded, partly-supported (`notes` name each ignored field), or invalid (`notes` say why). */
  status: CompatItemStatusSchema,
  /** Sentences: fields ignored or mapped, conflicts, why it is not used. */
  notes: z.array(z.string()).default([]),
});
export type SkillInfo = z.infer<typeof SkillInfoSchema>;
