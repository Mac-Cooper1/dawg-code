/**
 * Data shapes shared by the protocol's requests and events and by the engine's internals.
 *
 * This file is a contract: the engine's tools, permission engine and session store are written
 * against these types. Add to it freely; rename or remove only deliberately, and say so.
 */
import { z } from "zod";

/** Additive changes keep this number. Breaking changes bump it. */
export const PROTOCOL_VERSION = 1;

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

export const ToolDisplaySchema = z.discriminatedUnion("kind", [
  DiffDisplaySchema,
  FileDisplaySchema,
  CommandDisplaySchema,
  SearchDisplaySchema,
]);
export type ToolDisplay = z.infer<typeof ToolDisplaySchema>;

// ---------------------------------------------------------------------------------------------
// Permission requests
// ---------------------------------------------------------------------------------------------

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
  /** Without the leading slash, for example "compact". */
  name: z.string().min(1),
  description: z.string(),
  /** Shown after the name, for example "[focus]". Null when it takes no arguments. */
  argumentHint: z.string().nullable(),
});
export type CommandInfo = z.infer<typeof CommandInfoSchema>;
