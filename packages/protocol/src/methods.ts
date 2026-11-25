/**
 * Requests: methods a client calls on the engine, each with a params schema and a result schema.
 *
 * Long-running work never holds a request open. `session.prompt` resolves as soon as the turn is
 * accepted; the turn's progress and end arrive as events carrying its `turnId`.
 */
import { z } from "zod";
import {
  BackgroundTaskSchema,
  CommandInfoSchema,
  EffortSchema,
  ForkPointSchema,
  ModelInfoSchema,
  PermissionModeSchema,
  PermissionResponseSchema,
  PlanResponseSchema,
  PromptSchema,
  QuestionResponseSchema,
  SessionIdSchema,
  SessionSummarySchema,
  TaskItemSchema,
  UsageSchema,
} from "./common.ts";
import { PendingRequestSchema, ReplayedEventsSchema } from "./events.ts";

const IdSchema = z.string().min(1);
const AbsolutePathSchema = z.string().min(1);
/** Methods with nothing to return answer with an empty object, so fields can be added later. */
const EmptyResultSchema = z.object({});

// ---------------------------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------------------------

export const PeerInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string(),
});
export type PeerInfo = z.infer<typeof PeerInfoSchema>;

/**
 * What the client can do. A client that cannot answer prompts (a headless run) turns them off,
 * and the engine then resolves such requests itself (a permission request is denied unless a rule
 * allows it).
 */
export const ClientCapabilitiesSchema = z
  .object({
    permissionPrompts: z.boolean().default(true),
    questions: z.boolean().default(true),
    planApproval: z.boolean().default(true),
  })
  .prefault({});
export type ClientCapabilities = z.infer<typeof ClientCapabilitiesSchema>;

export const InitializeParamsSchema = z.object({
  /** The protocol version the client speaks. */
  protocolVersion: z.number().int().positive(),
  client: PeerInfoSchema,
  capabilities: ClientCapabilitiesSchema,
});

export const EngineCapabilitiesSchema = z.object({
  /** Methods the engine implements. Lets a client feature-detect additive changes. */
  methods: z.array(z.string()),
  /** Events the engine may send. */
  events: z.array(z.string()),
  /** Largest message the engine accepts, in characters of JSON. Null when unbounded. */
  maxMessageLength: z.number().int().positive().nullable(),
});
export type EngineCapabilities = z.infer<typeof EngineCapabilitiesSchema>;

export const InitializeResultSchema = z.object({
  /** Always equal to the version the client asked for; otherwise the engine answers with an error. */
  protocolVersion: z.number().int().positive(),
  engine: PeerInfoSchema,
  capabilities: EngineCapabilitiesSchema,
});

// ---------------------------------------------------------------------------------------------
// Opening sessions
// ---------------------------------------------------------------------------------------------

/** Everything a client needs to show an open session. Returned by create, resume and fork. */
export const SessionSnapshotSchema = z.object({
  session: SessionSummarySchema,
  modelInfo: ModelInfoSchema.nullable(),
  /** Directories added with `/add-dir` or settings (absolute), not counting `cwd`. */
  additionalDirectories: z.array(z.string()),
  tasks: z.array(TaskItemSchema),
  /** Null until the first model request. */
  usage: UsageSchema.nullable(),
  /** Requests waiting on the person, oldest first. */
  pending: z.array(PendingRequestSchema),
  /** The running turn, or null when idle. */
  activeTurnId: IdSchema.nullable(),
  /** Slash commands available in this session. */
  commands: z.array(CommandInfoSchema),
  /** The session's background commands, running and ended, oldest first. */
  background: z.array(BackgroundTaskSchema).default([]),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

export const SessionCreateParamsSchema = z.object({
  /** Working directory (absolute). */
  cwd: AbsolutePathSchema,
  /** The project the session belongs to, when `cwd` is a worktree of it. Defaults to `cwd`. */
  projectDir: AbsolutePathSchema.optional(),
  title: z.string().optional(),
  /** Defaults to the mode from settings. */
  mode: PermissionModeSchema.optional(),
  /** Defaults to the model from settings. */
  model: z.string().optional(),
  effort: EffortSchema.optional(),
  additionalDirectories: z.array(AbsolutePathSchema).optional(),
});

export const SessionResumeParamsSchema = z.object({
  sessionId: SessionIdSchema,
});

export const SessionForkParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** Defaults to the end: every finished turn. */
  point: ForkPointSchema.optional(),
  /** Defaults to the parent's title with a marker the engine chooses. */
  title: z.string().optional(),
  /** Defaults to the parent's working directory. */
  cwd: AbsolutePathSchema.optional(),
});

// ---------------------------------------------------------------------------------------------
// Managing stored sessions
// ---------------------------------------------------------------------------------------------

export const SessionListParamsSchema = z.object({
  /** Only sessions of this project. */
  projectDir: AbsolutePathSchema.optional(),
  /** Case-insensitive match on the title. */
  query: z.string().optional(),
  includeArchived: z.boolean().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  /** `nextCursor` from the previous page. */
  cursor: z.string().optional(),
});

export const SessionListResultSchema = z.object({
  /** Newest activity first. */
  sessions: z.array(SessionSummarySchema),
  /** Null on the last page. */
  nextCursor: z.string().nullable(),
});

export const SessionRenameParamsSchema = z.object({
  sessionId: SessionIdSchema,
  title: z.string().min(1).max(200),
});

export const SessionArchiveParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** False unarchives. Defaults to true. */
  archived: z.boolean().optional(),
});

export const SessionSummaryResultSchema = z.object({
  session: SessionSummarySchema,
});

/**
 * Deletes a stored session for good: its transcript, events and side files. Works whether or not
 * the session is open. A running turn or compaction is interrupted first, and every connection
 * that had the session open gets `session.deleted` as its last event. Forks of it keep working.
 */
export const SessionDeleteParamsSchema = z.object({
  sessionId: SessionIdSchema,
});

// ---------------------------------------------------------------------------------------------
// Running a session
// ---------------------------------------------------------------------------------------------

export const SessionPromptParamsSchema = z.object({
  sessionId: SessionIdSchema,
  prompt: PromptSchema,
});

export const SessionPromptResultSchema = z.object({
  /** Identifies the turn's events. */
  turnId: IdSchema,
});

export const SessionInterruptParamsSchema = z.object({
  sessionId: SessionIdSchema,
});

export const SessionInterruptResultSchema = z.object({
  /** False when no turn or compaction was running. */
  interrupted: z.boolean(),
});

export const SessionSetModeParamsSchema = z.object({
  sessionId: SessionIdSchema,
  mode: PermissionModeSchema,
});

export const SessionSetModeResultSchema = z.object({
  mode: PermissionModeSchema,
});

export const SessionSetModelParamsSchema = z.object({
  sessionId: SessionIdSchema,
  model: z.string().min(1),
});

export const SessionSetModelResultSchema = z.object({
  model: z.string(),
  modelInfo: ModelInfoSchema.nullable(),
  /** The effort after the change: reset to null when the new model does not accept the old one. */
  effort: EffortSchema.nullable(),
});

export const SessionSetEffortParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** Null returns to the model's default. */
  effort: EffortSchema.nullable(),
});

export const SessionSetEffortResultSchema = z.object({
  effort: EffortSchema.nullable(),
});

export const SessionCommandParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** Without the leading slash, for example "compact". */
  name: z.string().min(1),
  /** Everything after the name, as typed. */
  args: z.string().default(""),
});

export const SessionCommandResultSchema = z.object({
  /** Text to show, in Markdown, for commands that answer at once (`/help`, `/context`). */
  output: z.string().nullable(),
  /** Set when the command started a turn (for example `/init`); follow it through events. */
  turnId: IdSchema.nullable(),
  /** Set when the command opened another session (for example `/clear` or `/resume <id>`). */
  openedSession: SessionSnapshotSchema.nullable(),
});

// ---------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------

export const PermissionRespondParamsSchema = z.object({
  sessionId: SessionIdSchema,
  requestId: IdSchema,
  response: PermissionResponseSchema,
});

export const QuestionRespondParamsSchema = z.object({
  sessionId: SessionIdSchema,
  requestId: IdSchema,
  response: QuestionResponseSchema,
});

export const PlanRespondParamsSchema = z.object({
  sessionId: SessionIdSchema,
  requestId: IdSchema,
  response: PlanResponseSchema,
});

// ---------------------------------------------------------------------------------------------
// Background commands
// ---------------------------------------------------------------------------------------------

export const BackgroundOutputParamsSchema = z.object({
  sessionId: SessionIdSchema,
  taskId: IdSchema,
  /** Byte offset in the output to start at. 0 is the beginning. */
  offset: z.number().int().nonnegative().default(0),
  /** Most bytes to return; at most 1 MiB. */
  limit: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024)
    .default(256 * 1024),
});

export const BackgroundOutputResultSchema = z.object({
  /** The output from `offset`, as plain text (terminal control sequences removed). */
  text: z.string(),
  /** Where the next read starts. */
  nextOffset: z.number().int().nonnegative(),
  /** Output written so far, in bytes. */
  totalBytes: z.number().int().nonnegative(),
  /** True when the command has ended and everything up to `totalBytes` was read. */
  done: z.boolean(),
});

export const BackgroundStopParamsSchema = z.object({
  sessionId: SessionIdSchema,
  taskId: IdSchema,
});

export const BackgroundStopResultSchema = z.object({
  /** False when it had already ended. */
  stopped: z.boolean(),
});

// ---------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------

export const SessionReplayParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** Return events with a greater `seq`. 0 replays the whole session. */
  afterSeq: z.number().int().nonnegative(),
  /** Most events to return. The engine may return fewer. */
  limit: z.number().int().positive().optional(),
});

export const SessionReplayResultSchema = z.object({
  /** Ascending by `seq`. Deltas of finished messages and progress of finished tools may be left out. */
  events: ReplayedEventsSchema,
  /** The session's latest `seq` when the response was written. */
  lastSeq: z.number().int().nonnegative(),
  /** True when `limit` cut the list short; ask again after the last returned `seq`. */
  hasMore: z.boolean(),
});

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

/** Every request method, by name. The runtime source of truth for params and results. */
export const methods = {
  initialize: { params: InitializeParamsSchema, result: InitializeResultSchema },
  "session.create": { params: SessionCreateParamsSchema, result: SessionSnapshotSchema },
  "session.resume": { params: SessionResumeParamsSchema, result: SessionSnapshotSchema },
  "session.fork": { params: SessionForkParamsSchema, result: SessionSnapshotSchema },
  "session.list": { params: SessionListParamsSchema, result: SessionListResultSchema },
  "session.rename": { params: SessionRenameParamsSchema, result: SessionSummaryResultSchema },
  "session.archive": { params: SessionArchiveParamsSchema, result: SessionSummaryResultSchema },
  "session.delete": { params: SessionDeleteParamsSchema, result: EmptyResultSchema },
  "session.prompt": { params: SessionPromptParamsSchema, result: SessionPromptResultSchema },
  "session.interrupt": {
    params: SessionInterruptParamsSchema,
    result: SessionInterruptResultSchema,
  },
  "session.setMode": { params: SessionSetModeParamsSchema, result: SessionSetModeResultSchema },
  "session.setModel": { params: SessionSetModelParamsSchema, result: SessionSetModelResultSchema },
  "session.setEffort": {
    params: SessionSetEffortParamsSchema,
    result: SessionSetEffortResultSchema,
  },
  "session.command": { params: SessionCommandParamsSchema, result: SessionCommandResultSchema },
  "session.replay": { params: SessionReplayParamsSchema, result: SessionReplayResultSchema },
  "background.output": {
    params: BackgroundOutputParamsSchema,
    result: BackgroundOutputResultSchema,
  },
  "background.stop": { params: BackgroundStopParamsSchema, result: BackgroundStopResultSchema },
  "permission.respond": { params: PermissionRespondParamsSchema, result: EmptyResultSchema },
  "question.respond": { params: QuestionRespondParamsSchema, result: EmptyResultSchema },
  "plan.respond": { params: PlanRespondParamsSchema, result: EmptyResultSchema },
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>;

export type MethodName = keyof typeof methods;
export const METHOD_NAMES = Object.keys(methods) as MethodName[];

type Def<M extends MethodName> = (typeof methods)[M];

/** Method name to params and result, as a client sees them: params it sends, results it gets. */
export type MethodMap = {
  [M in MethodName]: { params: z.input<Def<M>["params"]>; result: z.output<Def<M>["result"]> };
};

export type MethodParams<M extends MethodName> = MethodMap[M]["params"];
export type MethodResult<M extends MethodName> = MethodMap[M]["result"];
/** Params as a handler receives them: validated, unknown fields stripped, defaults filled. */
export type ParsedParams<M extends MethodName> = z.output<Def<M>["params"]>;
/** A result as a handler builds it, before it is validated and sent. */
export type ResultInput<M extends MethodName> = z.input<Def<M>["result"]>;

export function isMethodName(name: string): name is MethodName {
  return Object.hasOwn(methods, name);
}
