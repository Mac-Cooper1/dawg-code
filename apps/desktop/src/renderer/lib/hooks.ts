/**
 * Words for hooks and the code a project supplies, shared by the transcript's hook lines, the
 * project trust dialog and Settings → Hooks, so the three say the same thing the same way.
 */
import type { CompatItemStatus, CompatSource, HookInfo } from "@dawg/protocol";
import type { HookItem } from "../state/types.ts";
import { formatDuration } from "./format.ts";

/** Whose file, as Settings → Permissions names the scopes. */
const SCOPE_WORDS: Record<CompatSource["scope"], string> = {
  user: "yours everywhere",
  project: "shared with the project",
  local: "personal for this project",
  nested: "in a folder inside the project",
  flags: "from the command line",
};

/** "Claude Code’s file, shared with the project". */
export function sourceLabel(source: Pick<CompatSource, "origin" | "scope">): string {
  if (source.scope === "flags") return "From the command line";
  const whose = source.origin === "claude" ? "Claude Code’s file" : "dawg’s file";
  return `${whose}, ${SCOPE_WORDS[source.scope]}`;
}

/** What a status means for a hook or a server, in a few words. */
export const STATUS_LABEL: Record<CompatItemStatus, string> = {
  loaded: "Runs",
  "needs-approval": "Waits for your approval",
  "partly-supported": "Runs, partly supported",
  "not-supported": "Not supported yet",
  invalid: "Could not be read",
};

/** A handler type in words: "Command", "HTTP", "Prompt", "Agent", "MCP tool". */
export function handlerTypeLabel(type: string): string {
  switch (type) {
    case "command":
      return "Command";
    case "http":
      return "HTTP";
    case "prompt":
      return "Prompt";
    case "agent":
      return "Agent";
    case "mcp_tool":
      return "MCP tool";
    default:
      return type;
  }
}

/**
 * What a hook that is not a command reaches, in a few words: "Posts to localhost:8080", "Asks
 * the helper model", "Asks haiku (mapped to a local model)", "Calls security_scan on my_server".
 * Null for a command, and for an older engine that does not say.
 */
export function hookReach(hook: Pick<HookInfo, "type" | "reaches">): string | null {
  const reaches = hook.reaches ?? null;
  if (reaches === null) return null;
  switch (hook.type) {
    case "http":
      return reaches.host === null ? null : `Posts to ${reaches.host}`;
    case "prompt":
    case "agent": {
      const who = hook.type === "agent" ? "A read-only subagent on" : "Asks";
      return reaches.model === null
        ? `${who} the helper model, or the session’s model`
        : `${who} “${reaches.model}”, mapped to the helper model or the session’s`;
    }
    case "mcp_tool":
      return reaches.server === null || reaches.tool === null
        ? null
        : `Calls ${reaches.tool} on the MCP server ${reaches.server}`;
    default:
      return null;
  }
}

/** Hooks take milliseconds more often than seconds: "41 ms", "1.2 s". */
export function hookDuration(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : formatDuration(ms);
}

/** " for Bash", or nothing when the hook did not run for a tool call. */
function forTool(item: Pick<HookItem, "toolName" | "toolCallId">): string {
  if (item.toolCallId === null) return "";
  return item.toolName === null ? " for a tool call" : ` for ${item.toolName}`;
}

function withMessage(text: string, message: string | null): string {
  const said = message?.trim() ?? "";
  return said === "" ? text : `${text}: ${said}`;
}

/**
 * The hook's one line in the transcript: "PreToolUse hook blocked Bash: rm -rf is not allowed",
 * "Stop hook kept the turn going: run the tests first", "SessionStart hook failed (exit 1): …".
 */
export function hookLine(item: HookItem): string {
  const event = item.hook.event;
  const tool = item.toolName ?? "the call";
  switch (item.outcome) {
    case "timeout":
      return `${event} hook timed out${forTool(item)}`;
    case "error": {
      const code = item.exitCode === null ? "" : ` (exit ${item.exitCode})`;
      return withMessage(`${event} hook${forTool(item)} failed${code}`, item.message);
    }
    case "blocked":
      switch (event) {
        case "PreToolUse":
          return withMessage(`PreToolUse hook blocked ${tool}`, item.message);
        case "UserPromptSubmit":
          return withMessage("UserPromptSubmit hook blocked the prompt", item.message);
        case "Stop":
          return withMessage("Stop hook kept the turn going", item.message);
        case "PostToolUse":
        case "PostToolUseFailure":
          return withMessage(`${event} hook gave feedback on ${tool}`, item.message);
        case "PermissionRequest":
          return withMessage(`PermissionRequest hook denied ${tool}`, item.message);
        case "SubagentStop":
          return withMessage("SubagentStop hook kept the agent going", item.message);
        case "PreCompact":
          return withMessage("PreCompact hook blocked the compaction", item.message);
        case "PostToolBatch":
          return withMessage("PostToolBatch hook ended the turn", item.message);
        case "UserPromptExpansion":
          return withMessage("UserPromptExpansion hook blocked the command", item.message);
        default:
          return withMessage(`${event} hook blocked it`, item.message);
      }
    case "success":
      if (event === "PreToolUse" && item.decision === "deny") {
        return withMessage(`PreToolUse hook blocked ${tool}`, item.message);
      }
      if (event === "PreToolUse" && item.decision === "allow") {
        return withMessage(`PreToolUse hook allowed ${tool}`, item.message);
      }
      if (event === "PreToolUse" && item.decision === "ask") {
        return withMessage(`PreToolUse hook asked you about ${tool}`, item.message);
      }
      // It answered the permission prompt in the person's place.
      if (event === "PermissionRequest" && item.decision === "allow") {
        return withMessage(`PermissionRequest hook allowed ${tool}`, item.message);
      }
      return withMessage(`${event} hook ran${forTool(item)}`, item.message);
  }
}

/** How loud the line is: a plain run is quiet; a block stands out; a failure is red. */
export function hookTone(item: HookItem): "quiet" | "blocked" | "error" {
  if (item.outcome === "error" || item.outcome === "timeout") return "error";
  if (item.outcome === "blocked" || item.decision === "deny" || item.decision === "block") {
    return "blocked";
  }
  return "quiet";
}

/** The quiet line for hooks held back until the person approves them. */
export function skippedLine(sources: readonly CompatSource[]): string {
  const onlyUser = sources.length > 0 && sources.every((source) => source.scope === "user");
  return onlyUser
    ? "Hooks from your Claude Code settings are waiting for your approval, so they did not run."
    : "Hooks from this project are waiting for your approval, so they did not run.";
}
