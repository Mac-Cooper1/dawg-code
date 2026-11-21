/**
 * What a tool is and what it is given when it runs.
 * See docs/specs/phase-2-engine-core.md, "Tools".
 */
import type {
  ContentPart,
  PermissionMode,
  Question,
  QuestionAnswer,
  TaskItem,
  ToolDisplay,
  ToolProgress,
} from "@dawg/protocol";
import type { JsonSchema } from "./model.ts";
import type { PermissionSubject } from "./permissions.ts";

/** Limits are settings, not constants. Tools read them from the context on every call. */
export interface ToolLimits {
  /** Lines `Read` returns when no `limit` is given. */
  readDefaultLines: number;
  /** Characters kept per line by `Read`; longer lines are cut. */
  readMaxLineChars: number;
  /** Largest file `Read` returns whole; larger files must be read in ranges. */
  readMaxBytes: number;
  bashDefaultTimeoutMs: number;
  bashMaxTimeoutMs: number;
  /** `Bash` output longer than this is cut to head and tail, with the full text saved. */
  bashMaxOutputChars: number;
  /** Paths `Glob` returns at most. */
  globMaxResults: number;
  /** Lines or files `Grep` returns when no `head_limit` is given. */
  grepDefaultHeadLimit: number;
  /** Characters kept per matching line by `Grep`; longer lines are cut. */
  grepMaxLineChars: number;
  /** Characters of `Grep` output returned inline; more is cut with a note. */
  grepMaxOutputChars: number;
  /** How long one `Glob` or `Grep` search may run. */
  searchTimeoutMs: number;
}

export const DEFAULT_TOOL_LIMITS: ToolLimits = {
  readDefaultLines: 2000,
  readMaxLineChars: 2000,
  readMaxBytes: 256 * 1024,
  bashDefaultTimeoutMs: 120_000,
  bashMaxTimeoutMs: 600_000,
  bashMaxOutputChars: 30_000,
  globMaxResults: 100,
  grepDefaultHeadLimit: 250,
  grepMaxLineChars: 500,
  grepMaxOutputChars: 30_000,
  searchTimeoutMs: 20_000,
};

/**
 * Session-scoped state that lasts between tool calls: which files have been read, the shell's
 * current directory, background commands. It is in memory only and starts empty on resume.
 */
export interface SessionStateBag {
  /** Returns the value stored under `key`, creating it on first use. */
  get<T>(key: string, create: () => T): T;
}

/**
 * Progress a running tool reports: live output from a command, or a short status line such as
 * "Searching 1,204 files". Defined once, in the protocol, because clients receive it as is.
 */
export type { ToolProgress };

/** Things a tool can ask the session to do. Implemented by the turn loop. */
export interface SessionServices {
  getMode(): PermissionMode;
  setMode(mode: PermissionMode): void;
  /** Replaces the task list. */
  setTasks(tasks: TaskItem[]): void;
  /** Pauses the turn until the user answers. Rejects if the turn is interrupted. */
  askUser(questions: Question[]): Promise<QuestionAnswer[]>;
  /** Presents a plan for approval. Rejects if the turn is interrupted. */
  proposePlan(plan: string): Promise<{ approved: boolean; message?: string }>;
}

/** The subset of the context available while a call is only being judged, not run. */
export interface ToolProbeContext {
  /** The session's primary working directory (absolute). Relative paths resolve against it. */
  readonly cwd: string;
  /** `cwd` plus any added directories (absolute). */
  readonly workingDirectories: readonly string[];
  readonly state: SessionStateBag;
}

export interface ToolContext extends ToolProbeContext {
  readonly sessionId: string;
  readonly toolCallId: string;
  /** Aborted when the turn is interrupted. Tools must stop promptly and may then throw. */
  readonly signal: AbortSignal;
  readonly limits: ToolLimits;
  /** Extra environment variables for child processes, from settings. */
  readonly env: Readonly<Record<string, string>>;
  /** Whether the model can be given images. */
  readonly vision: boolean;
  /** Absolute path of the ripgrep binary to use, or null to find one. */
  readonly ripgrepPath: string | null;
  readonly session: SessionServices;
  /**
   * True when a deny rule forbids reading this file (absolute path). Search tools use it to leave
   * such files out of their results. Absent when no rules are in force.
   */
  readonly readDenied?: (absolutePath: string) => boolean;
  /** Reports live progress. Cheap; may be called often. */
  progress(update: ToolProgress): void;
  /**
   * Saves text or bytes under the session's `tool-results/` folder and returns the absolute path.
   * `name` is a suggested file name; the session makes it unique. The file belongs to the caller
   * afterwards: a tool may keep appending to the returned path (a background command's output).
   */
  saveOutput(name: string, content: string | Uint8Array): Promise<string>;
}

export interface ToolOutput {
  /** What the model is given as the result. */
  content: ContentPart[];
  /** True for a failure the model can act on: a missing file, no match, a failed command. */
  isError?: boolean;
  /** A structured view for clients, such as the diff an edit made. */
  display?: ToolDisplay;
  /** Files this call read or changed (absolute paths), for the turn loop's bookkeeping. */
  touched?: { read?: string[]; written?: string[] };
}

/**
 * One tool.
 *
 * - `description` and `inputSchema` are sent to the model on every request, so they must be
 *   byte-stable: no dates, counters, machine-specific text or unordered output.
 * - `inputSchema` is a hand-written JSON Schema object with `additionalProperties: false`. Input
 *   has been validated against it before `permission` or `execute` is called.
 * - `execute` returns `isError: true` for failures the model can act on. It throws only for bugs
 *   and when aborted; the caller turns a throw into an error result.
 */
export interface ToolDefinition<Input> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** True when a call can change nothing. Such calls may run at the same time as each other. */
  readonly readOnly: boolean;
  /**
   * What this call would do, for the permission engine. Must be fast, must not change anything,
   * and must not throw for input that passed the schema.
   */
  permission(input: Input, ctx: ToolProbeContext): PermissionSubject;
  execute(input: Input, ctx: ToolContext): Promise<ToolOutput>;
}

/** A tool whose input type has been erased, as held in a registry. */
// biome-ignore lint/suspicious/noExplicitAny: the registry holds tools with different input types
export type AnyTool = ToolDefinition<any>;
