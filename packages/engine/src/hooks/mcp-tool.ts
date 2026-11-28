/**
 * Runs one `mcp_tool` hook handler (code.claude.com/docs/en/hooks, "MCP tool hook fields"): a
 * tool of an MCP server the session has connected is called with the handler's `input`, whose
 * string values take `${path}` substitutions from the hook input ("${tool_input.file_path}").
 * The tool's text is read like a command's standard output on exit 0; a tool that reports an
 * error, or a server that is not connected, is a failure (`onFailure` decides what it blocks).
 *
 * The call goes through the session's MCP servers (../mcp/session-mcp.ts) without a permission
 * check or tool hooks of its own: a settings file asked for it, as it asks for a command.
 */
import { untilAborted } from "./abort.ts";
import type { HandlerRun } from "./output.ts";

/** What an `mcp_tool` hook calls through: the session's MCP servers. */
export interface HookMcp {
  /**
   * Calls `tool` on `server`. `waitMs` is how long to wait for a server still connecting (0 on
   * events that only observe, as documented). Resolves with the tool's text, or with why it
   * could not be called.
   */
  call(request: {
    server: string;
    tool: string;
    args: Record<string, unknown>;
    waitMs: number;
    signal: AbortSignal;
  }): Promise<{ isError: boolean; text: string } | { error: string }>;
}

/** `${a.b.c}` in a string value. */
const PATH = /\$\{([^}]+)\}/g;

function valueAt(source: unknown, path: string): unknown {
  let at: unknown = source;
  for (const key of path.trim().split(".")) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The arguments with substitutions made. A string that is one `${path}` and nothing else takes
 * the value as it is (a number stays a number); inside other text a value is written as text,
 * and a path the input does not have becomes an empty string.
 */
export function substituteInput(value: unknown, hookInput: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = /^\$\{([^}]+)\}$/.exec(value);
    if (whole !== null) {
      const found = valueAt(hookInput, whole[1] as string);
      return found === undefined ? "" : found;
    }
    return value.replace(PATH, (_all, path: string) => asText(valueAt(hookInput, path)));
  }
  if (Array.isArray(value)) return value.map((item) => substituteInput(item, hookInput));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = substituteInput(item, hookInput);
    return out;
  }
  return value;
}

export interface McpToolHookSpec {
  server: string;
  tool: string;
  input: Record<string, unknown> | null;
  hookInput: Record<string, unknown>;
  mcp: HookMcp | null;
  /** How long a server still connecting may take; 0 to not wait. */
  waitMs: number;
  timeoutMs: number;
  signal?: AbortSignal;
  now?: () => number;
}

export async function runMcpToolHook(spec: McpToolHookSpec): Promise<HandlerRun> {
  const now = spec.now ?? Date.now;
  const startedAt = now();
  const elapsed = () => Math.max(0, Math.round(now() - startedAt));
  const name = `MCP tool "${spec.tool}" on server "${spec.server}"`;
  if (spec.mcp === null) {
    return {
      kind: "failed",
      outcome: "error",
      detail: `${name} cannot be called: this session has no MCP servers.`,
      durationMs: 0,
    };
  }
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), Math.max(1, spec.timeoutMs));
  timeout.unref?.();
  const signal =
    spec.signal === undefined ? timer.signal : AbortSignal.any([timer.signal, spec.signal]);
  try {
    const args = substituteInput(spec.input ?? {}, spec.hookInput) as Record<string, unknown>;
    const answer = await untilAborted(
      spec.mcp.call({
        server: spec.server,
        tool: spec.tool,
        args,
        waitMs: Math.min(spec.waitMs, spec.timeoutMs),
        signal,
      }),
      signal,
    );
    if (spec.signal?.aborted === true) return { kind: "aborted", durationMs: elapsed() };
    if (timer.signal.aborted) throw new Error("timed out");
    if ("error" in answer) {
      return { kind: "failed", outcome: "error", detail: answer.error, durationMs: elapsed() };
    }
    if (answer.isError) {
      const said = answer.text.replace(/\s+/g, " ").trim().slice(0, 300);
      return {
        kind: "failed",
        outcome: "error",
        detail: `${name} reported an error${said === "" ? "." : `: ${said}`}`,
        durationMs: elapsed(),
      };
    }
    return { kind: "output", from: "mcp_tool", text: answer.text, durationMs: elapsed() };
  } catch (error) {
    if (spec.signal?.aborted === true) return { kind: "aborted", durationMs: elapsed() };
    if (timer.signal.aborted) {
      return {
        kind: "failed",
        outcome: "timeout",
        detail: `${name} did not answer within ${Math.round(spec.timeoutMs / 100) / 10} s.`,
        durationMs: elapsed(),
      };
    }
    return {
      kind: "failed",
      outcome: "error",
      detail: `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: elapsed(),
    };
  } finally {
    clearTimeout(timeout);
  }
}
