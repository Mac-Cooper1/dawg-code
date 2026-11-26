/** The runtime's public types. See README.md in this folder. */
import type { SettingsFlags } from "@dawg/compat";
import type { Endpoint } from "@dawg/models";
import type {
  ClientCapabilities,
  Effort,
  ErrorInfo,
  ForkPoint,
  PermissionMode,
  StopReason,
  Usage,
} from "@dawg/protocol";
import type { ModelClient } from "../contracts/model.ts";
import type { PermissionEngine } from "../contracts/permissions.ts";
import type {
  Compactor,
  ModelProfile,
  PromptAssembler,
  SessionEnvironment,
  TokenEstimator,
} from "../contracts/prompt.ts";
import type { AnyTool, ToolLimits } from "../contracts/tools.ts";
import type { IdKind, LoopLimits } from "../loop/types.ts";
import type { SlotPool } from "../model/slots.ts";
import type { Durability } from "../session/index.ts";
import type { EnvironmentInput } from "./environment.ts";

/** A connection to one model, as the model provider hands it out. */
export interface ModelConnection {
  client: ModelClient;
  /**
   * The slots conversation requests (turns and compaction) share with every other connection to
   * the same server. Hand out the same object for all of them: the engine keeps one scheduler
   * per pool, and a request waits for a free slot there before it is sent (the session shows as
   * queued meanwhile). Leave it out for servers that report no slots (Ollama, LM Studio, a remote
   * API); their requests are sent at once.
   */
  pool?: SlotPool;
  /** A fixed cache slot for every conversation request. Ignored when `pool` is set. */
  slot?: number;
  /**
   * Where side requests (session titles) go, so they never touch the conversation's history or
   * its cache slots. Defaults to `client` without a slot; on the bundled runtime give it a pool
   * (or a slot) of its own, or the server may pick a conversation slot. Its pool works like
   * `pool`, but a session never shows as queued for a side request.
   */
  utility?: { client: ModelClient; pool?: SlotPool; slot?: number };
}

export interface ModelProvider {
  /** Connects to a model. `modelId` null means the configured default model. */
  connect(modelId: string | null): Promise<ModelConnection>;
}

export interface RuntimeLimits extends LoopLimits {
  /** Recently read files handed to compaction as fresh copies, newest first. */
  compactionRecentFiles: number;
  /** Characters kept of each of those files. */
  compactionRecentFileChars: number;
  /** Characters of an `@`-mentioned file included with a prompt. */
  mentionMaxChars: number;
}

export const DEFAULT_RUNTIME_LIMITS: Omit<RuntimeLimits, keyof LoopLimits> = {
  compactionRecentFiles: 5,
  compactionRecentFileChars: 20_000,
  mentionMaxChars: 100_000,
};

export interface EngineOptions {
  /** The data root, normally `~/.dawg`. Tests use a temporary directory. */
  storeRoot: string;
  /** The person's home directory: user settings, instruction files and `~` in rules. */
  homeDir: string;
  models: ModelProvider;
  assembler: PromptAssembler;
  compactor: Compactor;
  estimator: TokenEstimator;
  /** The model profile, fixed or chosen per endpoint. */
  profile: ModelProfile | ((endpoint: Endpoint) => ModelProfile);
  /** Defaults to `createPermissionEngine()`. */
  permissions?: PermissionEngine;
  /** In a fixed order. Defaults to the core tools followed by the interactive tools. */
  tools?: readonly AnyTool[];
  toolLimits?: Partial<ToolLimits>;
  limits?: Partial<RuntimeLimits>;
  /**
   * What the person's client can answer, unless a session is opened with its own. Each defaults
   * to true. With `permissionPrompts` false an ask becomes a deny; with `questions` or
   * `planApproval` false the tool is told nobody can answer.
   */
  capabilities?: Partial<ClientCapabilities>;
  /** Command-line settings (`--allowedTools`, `--permission-mode`...), highest precedence. */
  settingsFlags?: SettingsFlags;
  /** Whether project instruction files may import files from outside the project. */
  externalImports?: "allow" | "block";
  /** The ripgrep binary for Grep and Glob, or null to look one up. */
  ripgrepPath?: string | null;
  /** Generate a title after a session's first turn. Default true. */
  generateTitles?: boolean;
  /** How the transcript is flushed to the drive. Default "batched". */
  durability?: Durability;
  /** Milliseconds since the epoch. Default `Date.now`. */
  clock?: () => number;
  /** Ids for messages, requests, compactions and calls the model left without one. */
  newId?: (kind: IdKind) => string;
  /** Gathers the session-context facts. Defaults to reading the machine and git. */
  environment?: (input: EnvironmentInput) => Promise<SessionEnvironment>;
}

export interface OpenSessionOptions {
  /** What the client that opens the session can answer. Defaults to the engine's. */
  capabilities?: Partial<ClientCapabilities>;
}

export interface NewSessionOptions extends OpenSessionOptions {
  /** Working directory (absolute). */
  cwd: string;
  /**
   * The project the session belongs to (absolute), when `cwd` is a worktree of it; default
   * `cwd`. It is the summary's `projectDir`, and where personal settings
   * (`settings.local.json`) are read and "always allow" saves, so they outlive the worktree.
   * Sessions are still filed under `cwd`.
   */
  projectDir?: string;
  title?: string;
  /** Defaults to the mode from settings, else "default". */
  mode?: PermissionMode;
  /** Defaults to the provider's default model. */
  model?: string;
  effort?: Effort;
  additionalDirectories?: string[];
}

export interface ForkSessionOptions extends OpenSessionOptions {
  /** Defaults to the end: every finished turn. */
  point?: ForkPoint;
  /** Defaults to the parent's title with " (fork)". */
  title?: string;
  /** Must be the parent's working directory when given. */
  cwd?: string;
}

export interface ListSessionsOptions {
  /** Only sessions of this project. */
  projectDir?: string;
  /** Case-insensitive match on the title. */
  query?: string;
  includeArchived?: boolean;
  limit?: number;
  cursor?: string;
}

/** How a turn ended. */
export interface TurnOutcome {
  turnId: string;
  stopReason: StopReason;
  /** Text of the turn's last assistant message, when it had any. */
  finalText: string | null;
  /** Set when `stopReason` is "error". */
  error: ErrorInfo | null;
  /** The session's usage when the turn ended. */
  usage: Usage | null;
  durationMs: number;
}

export interface CompactionOutcome {
  outcome: "completed" | "failed" | "interrupted";
  summary: string | null;
  error: ErrorInfo | null;
}
