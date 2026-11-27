/** Plain-text renderings of tool calls, diffs and requests, for the terminal and for logs. */
import path from "node:path";
import type {
  ContentPart,
  DiffDisplay,
  EventPayload,
  PermissionRequest,
  SubagentInfo,
  ToolDisplay,
} from "@dawg/protocol";

function shortPath(file: string, cwd: string): string {
  const rel = path.relative(cwd, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
}

function oneLine(text: string, max = 80): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/** What a call is about, in a few words: the file, the command, the pattern. */
export function describeInput(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);
  const file = str("file_path") ?? str("path");
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      return file === null ? "" : shortPath(file, cwd);
    case "Bash":
      return oneLine(str("command") ?? "");
    case "Glob":
    case "Grep": {
      const pattern = str("pattern") ?? "";
      return file === null ? pattern : `${pattern} in ${shortPath(file, cwd)}`;
    }
    case "TodoWrite":
      return Array.isArray(input.todos) ? `${input.todos.length} tasks` : "";
    case "ExitPlanMode":
      return "plan ready";
    case "Agent": {
      const type = str("subagent_type") ?? "general-purpose";
      const background = input.run_in_background === true ? ", in the background" : "";
      return `${type}: ${oneLine(str("description") ?? "")}${background}`;
    }
    case "SendMessage":
      return `to ${str("to") ?? "?"}: ${oneLine(str("message") ?? "", 60)}`;
    default: {
      const json = JSON.stringify(input);
      return json === "{}" ? "" : oneLine(json);
    }
  }
}

function textOf(content: readonly ContentPart[]): string {
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function displaySummary(display: ToolDisplay | null): string {
  if (display === null) return "";
  switch (display.kind) {
    case "diff":
      return ` (+${display.additions} -${display.deletions})`;
    case "file":
      return ` (${display.lineCount} lines)`;
    case "command":
      return display.exitCode === null ? "" : ` (exit ${display.exitCode})`;
    case "search":
      return ` (${display.resultCount} results)`;
    case "web-fetch":
      return display.redirectUrl === null
        ? ` (${display.status}, ${display.chars} characters)`
        : ` (moved to ${display.redirectUrl})`;
    case "web-search":
      return ` (${display.results.length} results)`;
    case "mcp":
      return ` (the ${display.server} server's ${display.tool}${display.savedTo === null ? "" : `, saved whole to ${display.savedTo}`})`;
  }
}

/** One line for a finished call: what it did and how it ended. */
export function toolLine(
  started: { toolName: string; input: Record<string, unknown> } | undefined,
  finished: EventPayload<"tool.finished">,
  cwd: string,
): string {
  const name = finished.toolName;
  const what = started === undefined ? "" : describeInput(name, started.input, cwd);
  const head = what === "" ? name : `${name} ${what}`;
  const first = oneLine(textOf(finished.content), 100);
  switch (finished.outcome) {
    case "success":
      return `* ${head}: done${displaySummary(finished.display)}`;
    case "error":
      return `* ${head}: failed${first === "" ? "" : `: ${first}`}`;
    case "denied":
      return `* ${head}: denied${first === "" ? "" : `: ${first}`}`;
    case "invalid":
      return `* ${head}: invalid call${first === "" ? "" : `: ${first}`}`;
    case "interrupted":
      return `* ${head}: interrupted`;
  }
}

/**
 * Added (Phase 4, sandbox): the line under a shell command the sandbox stopped from doing
 * something, or null. Indented, so it reads as part of the call above it.
 */
export function sandboxLine(display: ToolDisplay | null): string | null {
  if (display?.kind !== "command" || display.sandbox === undefined) return null;
  const blocked = display.sandbox.blocked;
  if (blocked.length === 0) return null;
  return `  Blocked by the sandbox: ${blocked.join("; ")}`;
}

/** Why a command would run outside the sandbox, for a permission request; null inside or off. */
function outsideReason(request: PermissionRequest): string | null {
  const sandbox = request.sandbox;
  if (sandbox === undefined || sandbox.placement !== "outside") return null;
  switch (sandbox.reason) {
    case "retry":
      return "Runs outside the sandbox: the sandbox blocked it, and it is being tried again without it.";
    case "excluded":
      return "Runs outside the sandbox: it is one of the commands excluded from it in the settings.";
    case "unavailable":
      return "Runs outside the sandbox: the sandbox cannot run on this system.";
    default:
      return "Runs outside the sandbox.";
  }
}

/** A compact unified diff, at most `maxLines` lines of changes and context. */
export function diffLines(display: DiffDisplay, cwd: string, maxLines = 24): string[] {
  const out = [
    `  ${display.created ? "new file " : ""}${shortPath(display.filePath, cwd)} (+${display.additions} -${display.deletions})`,
  ];
  let shown = 0;
  let total = 0;
  for (const hunk of display.hunks) {
    total += hunk.lines.length + 1;
    if (shown >= maxLines) continue;
    out.push(`  @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    shown += 1;
    for (const line of hunk.lines) {
      if (shown >= maxLines) break;
      out.push(`  ${line}`);
      shown += 1;
    }
  }
  if (total > shown) out.push(`  ... ${total - shown} more lines`);
  return out;
}

export function permissionLines(request: PermissionRequest, cwd: string): string[] {
  // A subagent's request is raised in its parent's session: say which agent asks.
  const who =
    request.agent === undefined
      ? ""
      : ` (${request.agent.agentId}, ${request.agent.agentType} agent: ${oneLine(request.agent.description, 60)})`;
  const lines = [`Permission needed${who}: ${request.title}`];
  const what = describeInput(request.toolName, request.input, cwd);
  lines.push(`  ${request.toolName}${what === "" ? "" : ` ${what}`}`);
  if (request.reason !== "") lines.push(`  ${request.reason}`);
  const outside = outsideReason(request);
  if (outside !== null) lines.push(`  ${outside}`);
  if (request.display?.kind === "diff") lines.push(...diffLines(request.display, cwd, 16));
  return lines;
}

/**
 * One compact line about a subagent, for each change of its state: "[agent-1 Explore] Find the
 * port: running".
 */
export function agentLine(agent: SubagentInfo): string {
  const head = `[${agent.agentId} ${agent.agentType}] ${oneLine(agent.description, 60)}`;
  const uses = agent.toolUses === 1 ? "1 tool use" : `${agent.toolUses} tool uses`;
  switch (agent.status) {
    case "queued":
      return `${head}: queued${agent.queuePosition === null ? "" : ` (${agent.queuePosition} in line for the model)`}`;
    case "running":
      return `${head}: running${agent.background ? " in the background" : ""}${agent.worktree === null ? "" : ` in ${agent.worktree.path}`}`;
    case "completed":
      return `${head}: done, ${uses}`;
    case "failed":
      return `${head}: failed${agent.error === null ? "" : `: ${oneLine(agent.error.message)}`}`;
    case "stopped":
      return `${head}: stopped`;
  }
}
