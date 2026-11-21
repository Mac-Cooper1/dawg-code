import type { Task } from "../task.ts";

/** Where the agent sends model requests. Always points at the recording proxy. */
export interface Endpoint {
  /** OpenAI-style base URL, ending in /v1. */
  openaiBaseUrl: string;
  /** Anthropic-style base URL (no /v1); the proxy translates /v1/messages. */
  anthropicBaseUrl: string;
  /** A dummy key: the proxy swaps in the real one, so the agent never holds it. */
  apiKey: string;
  model: string;
}

export interface RunContext {
  task: Task;
  workspace: string;
  prompt: string;
  /** Throwaway HOME for the agent. Adapters write their config files under it. */
  homeDir: string;
  /** TMPDIR for the agent. */
  tmpDir: string;
  /** Per-run directory for stdout, stderr, transcripts. */
  artifactsDir: string;
  taskDir: string;
  /** Null for adapters that do not talk to a model (`needsEndpoint: false`). */
  endpoint: Endpoint | null;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface AgentRunResult {
  exitCode: number | null;
  timedOut: boolean;
  stdoutPath: string;
  stderrPath: string;
  transcriptPath?: string;
  /** Set when the agent could not be launched at all. */
  error?: string;
}

/**
 * Launches one agent headless. `features` is matched against a task's `requires`; a task with an
 * unmet requirement is recorded as skipped. The feature "*" means "supports everything".
 */
export interface AgentAdapter {
  id: string;
  features: ReadonlySet<string>;
  /** False for adapters that never call a model (reference, noop): no proxy is started. */
  needsEndpoint: boolean;
  run(ctx: RunContext): Promise<AgentRunResult>;
}

/** A built launch: what an adapter would execute. Exposed separately so it can be unit-tested. */
export interface LaunchSpec {
  command: string;
  args: string[];
  /** Extra environment on top of the runner's minimal base env. */
  env: Record<string, string>;
  /** Files to write before launch, keyed by absolute path. */
  files: Record<string, string>;
  /** Where the adapter's transcript ends up, if anywhere. */
  transcriptPath?: string;
}

export function unmetRequirements(adapter: AgentAdapter, task: Task): string[] {
  if (adapter.features.has("*")) return [];
  return task.requires.filter((r) => !adapter.features.has(r));
}

export const DUMMY_API_KEY = "dawg-eval-dummy-key";
