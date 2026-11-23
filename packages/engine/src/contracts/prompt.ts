/**
 * The seam between the turn loop and the code that writes what the model reads: the static
 * prefix, the notes appended later, and the summary that replaces history at compaction.
 * See docs/specs/phase-2-engine-core.md, "Prompt assembly and cache stability" and
 * "Context accounting and compaction".
 */
import type { ContentPart, PermissionMode, TaskItem } from "@dawg/protocol";
import type { Message, SystemMessage, UserMessage } from "./messages.ts";
import type { ModelClient, ModelUsage, SamplingParams, ToolSchema } from "./model.ts";
import type { AnyTool } from "./tools.ts";

/** Facts about where a session runs, gathered once when it starts. */
export interface SessionEnvironment {
  /** The session's primary working directory (absolute). */
  cwd: string;
  additionalDirectories: readonly string[];
  /** For example "darwin". */
  platform: string;
  /** For example "macOS 15.6". */
  osVersion: string;
  /** The shell commands run in, for example "bash". */
  shell: string;
  /** Local date at session start, as YYYY-MM-DD. */
  date: string;
  /** Null when the working directory is not in a git repository. */
  git: {
    branch: string | null;
    /** Short status at session start, already capped in length. Empty when clean. */
    status: string;
    /** A few recent commits, one line each. May be empty. */
    recentCommits: string;
  } | null;
}

/** The parts of a request that stay the same from one request to the next. */
export interface PromptPrefix {
  /** Core instructions, tool guidance and instruction files, as one system message. */
  system: SystemMessage;
  /** What the model is told about each tool, in the order the tools were given. */
  tools: ToolSchema[];
}

/** Something the engine tells the model after the session has started. */
export type SystemNote =
  | { type: "date_changed"; date: string }
  | { type: "mode_changed"; mode: PermissionMode }
  /** A file the model has read was changed on disk by someone else. */
  | { type: "file_changed"; path: string }
  | {
      type: "background_task_finished";
      taskId: string;
      command: string;
      exitCode: number | null;
      outputPath: string;
    }
  /** An instruction file that applies to a directory the model has just started working in. */
  | { type: "instructions_added"; path: string; content: string }
  /** The model has made the same call with the same result several times running. */
  | { type: "repeating"; toolName: string; times: number }
  /** The reply stopped because it reached the output limit. */
  | { type: "output_truncated" }
  /** The person interrupted the previous turn. */
  | { type: "interrupted" }
  | { type: "plan_approved"; mode: PermissionMode }
  | { type: "plan_rejected"; message: string | null }
  | { type: "directory_added"; path: string }
  | { type: "text"; text: string };

export interface PromptAssembler {
  /**
   * Builds the static prefix. Must be byte-stable: the same tools (in the same order) and the
   * same instruction text always give the same bytes, with nothing volatile inside (no times,
   * counters, random ids or machine facts).
   *
   * `instructions` is the already-rendered text of the instruction files (CLAUDE.md and
   * friends), or an empty string when there are none.
   */
  prefix(input: { tools: readonly AnyTool[]; instructions: string }): PromptPrefix;
  /** The session-context message: written once at session start and never rewritten. */
  sessionContext(environment: SessionEnvironment): UserMessage;
  /** Renders a note as a message to append to history. */
  note(note: SystemNote): UserMessage;
  /**
   * Turns what the person typed or pasted into the message to append. Text that imitates a note
   * is made harmless, so nothing the person pastes can pass for something the engine said.
   */
  prompt(content: readonly ContentPart[]): UserMessage;
  /**
   * Makes note look-alikes harmless in text that came from outside the engine: a tool result, a
   * file, command output. The turn loop applies it to every tool result before it enters history.
   */
  quote(text: string): string;
}

export interface CompactionInput {
  /** The prefix the session uses, so the summarising request reuses the prompt cache. */
  prefix: PromptPrefix;
  /** The model's current view after the system message: session context, then history. */
  history: readonly Message[];
  client: ModelClient;
  /** What the person asked the summary to concentrate on (`/compact <focus>`), if anything. */
  focus: string | null;
  tasks: readonly TaskItem[];
  /** Files read most recently, newest first, with their current text. Already capped in size. */
  recentFiles: readonly { path: string; content: string }[];
  sampling?: SamplingParams;
  /**
   * The same request settings the session sends. Anything that changes how the prompt is
   * rendered must be repeated here, or the summarising request misses the prompt cache.
   */
  reasoningEffort?: string;
  parallelToolCalls?: boolean;
  extraBody?: Readonly<Record<string, unknown>>;
  slot?: number;
  signal: AbortSignal;
}

export interface CompactionResult {
  /** The structured summary the model wrote. */
  summary: string;
  /**
   * The model's new view after the system message. It begins with the original session-context
   * message unchanged, holds the summary, the task list, the kept recent turns verbatim and the
   * recent files, and is valid for a chat template: every tool call still has its result and no
   * result is left without its call.
   */
  messages: Message[];
  /** Usage of the summarising request, when reported. */
  usage: ModelUsage | null;
}

export interface Compactor {
  /** Throws a `ModelError` when the summarising request fails; history is then left as it was. */
  compact(input: CompactionInput): Promise<CompactionResult>;
  /**
   * Shortens one oversized tool result inside history instead of compacting, when that alone
   * brings the context back under the threshold. Returns null when it does not apply.
   */
  trimLargestResult(history: readonly Message[], targetTokens: number): Message[] | null;
}

export interface TokenEstimator {
  /** A rough token count for when the endpoint cannot count exactly. Never throws. */
  estimate(input: { messages: readonly Message[]; tools: readonly ToolSchema[] }): number;
}

/** Per-model settings, chosen by the catalog entry's `profile` id. */
export interface ModelProfile {
  id: string;
  sampling: SamplingParams;
  /** The effort level to ask for when the person has not chosen one. Null means the model's own. */
  defaultEffort: string | null;
  /** Largest reply to ask for, in tokens. Each request asks for less when the window has less left. */
  maxOutputTokens: number;
  /**
   * Fraction of the context window above which history is compacted before a new turn starts.
   * Within a turn, compaction waits until the next reply might no longer fit.
   */
  compactionThreshold: number;
  /** Whether to ask for parallel tool calls when the template supports them. */
  parallelToolCalls: boolean;
  /**
   * Chat-template options sent with every request as `chat_template_kwargs`, for models whose
   * template default is wrong for an agent. Null when none are needed.
   */
  chatTemplateKwargs: Readonly<Record<string, unknown>> | null;
}
