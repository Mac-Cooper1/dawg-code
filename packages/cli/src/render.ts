/** Plain-text renderings of tool calls, diffs and requests, for the terminal and for logs. */
import path from "node:path";
import type {
  ContentPart,
  DiffDisplay,
  EventPayload,
  PermissionRequest,
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
  const lines = [`Permission needed: ${request.title}`];
  const what = describeInput(request.toolName, request.input, cwd);
  lines.push(`  ${request.toolName}${what === "" ? "" : ` ${what}`}`);
  if (request.reason !== "") lines.push(`  ${request.reason}`);
  if (request.display?.kind === "diff") lines.push(...diffLines(request.display, cwd, 16));
  return lines;
}
