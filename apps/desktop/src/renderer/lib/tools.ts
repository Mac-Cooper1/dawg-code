/**
 * How tool calls are named in the UI: the transcript card ("Ran uv run pytest -q"), the sidebar
 * ("Working: editing money.py") and decision cards ("Needs you: run a command").
 * Tool and field names follow Claude Code's documented tools (Bash, Edit, `file_path`, ...).
 */
import type { PermissionRequest, ToolDisplay } from "@dawg/protocol";
import { basename, displayPath, truncate } from "./format.ts";

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function firstLine(text: string): string {
  const index = text.indexOf("\n");
  return index === -1 ? text : `${text.slice(0, index)} …`;
}

function hostAndPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

/** What a call works on, for the card's second column: a command, a path, a pattern. */
export function toolTarget(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  homeDir: string,
): string {
  const path = stringField(input, "file_path") ?? stringField(input, "notebook_path");
  switch (toolName) {
    case "Bash":
      return firstLine(stringField(input, "command") ?? "");
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return path ? displayPath(path, cwd, homeDir) : "";
    case "Glob":
    case "Grep":
      return stringField(input, "pattern") ?? "";
    case "WebFetch":
      return hostAndPath(stringField(input, "url") ?? "");
    case "WebSearch":
      return stringField(input, "query") ?? "";
    default: {
      if (path) return displayPath(path, cwd, homeDir);
      for (const value of Object.values(input)) {
        if (typeof value === "string" && value !== "") return truncate(firstLine(value), 120);
      }
      return "";
    }
  }
}

const RUNNING_VERB: Record<string, string> = {
  Bash: "Running",
  Read: "Reading",
  Edit: "Editing",
  MultiEdit: "Editing",
  Write: "Writing",
  NotebookEdit: "Editing",
  Glob: "Finding files",
  Grep: "Searching",
  WebFetch: "Fetching",
  WebSearch: "Searching the web",
  TodoWrite: "Updating tasks",
  EnterPlanMode: "Entering plan mode",
  ExitPlanMode: "Proposing a plan",
  AskUserQuestion: "Asking",
};

const DONE_VERB: Record<string, string> = {
  Bash: "Ran",
  Read: "Read",
  Edit: "Edited",
  MultiEdit: "Edited",
  Write: "Wrote",
  NotebookEdit: "Edited",
  Glob: "Found files",
  Grep: "Searched",
  WebFetch: "Fetched",
  WebSearch: "Searched the web",
  TodoWrite: "Updated tasks",
  EnterPlanMode: "Entered plan mode",
  ExitPlanMode: "Proposed a plan",
  AskUserQuestion: "Asked",
};

/** The card's first column. `display` lets a Write that created a file read "Created". */
export function toolVerb(
  toolName: string,
  state: "running" | "success" | "error" | "denied" | "invalid" | "interrupted",
  display?: ToolDisplay | null,
): string {
  if (state === "running") return RUNNING_VERB[toolName] ?? toolName;
  if (state === "interrupted") return "Stopped";
  if (state === "denied") return "Denied";
  if (state === "invalid") return "Could not run";
  if (toolName === "Write" && display?.kind === "diff" && display.created) return "Created";
  return DONE_VERB[toolName] ?? toolName;
}

/** Lower-case activity for "Working: …" in the sidebar. */
export function toolActivity(toolName: string, input: Record<string, unknown>): string {
  const path = stringField(input, "file_path") ?? stringField(input, "notebook_path");
  const file = path ? basename(path) : null;
  switch (toolName) {
    case "Bash":
      return `running ${truncate(firstLine(stringField(input, "command") ?? "a command"), 40)}`;
    case "Read":
      return file ? `reading ${file}` : "reading a file";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return file ? `editing ${file}` : "editing a file";
    case "Write":
      return file ? `writing ${file}` : "writing a file";
    case "Glob":
      return "finding files";
    case "Grep": {
      const pattern = stringField(input, "pattern");
      return pattern ? `searching for ${truncate(pattern, 30)}` : "searching";
    }
    case "WebFetch":
      return `fetching ${truncate(hostAndPath(stringField(input, "url") ?? "a page"), 40)}`;
    case "WebSearch":
      return "searching the web";
    case "TodoWrite":
      return "updating the task list";
    default:
      return `using ${toolName}`;
  }
}

/** What a permission request asks for, after "Needs you: ". */
export function permissionNeed(request: Pick<PermissionRequest, "toolName" | "display">): string {
  switch (request.toolName) {
    case "Bash":
      return "run a command";
    case "Edit":
    case "MultiEdit":
      return "edit a file";
    case "Write":
      return request.display?.kind === "diff" && request.display.created
        ? "create a file"
        : "write a file";
    case "NotebookEdit":
      return "edit a notebook";
    case "WebFetch":
      return "fetch a page";
    case "WebSearch":
      return "search the web";
    default:
      return request.toolName.startsWith("mcp__") ? "use a tool" : `use ${request.toolName}`;
  }
}
