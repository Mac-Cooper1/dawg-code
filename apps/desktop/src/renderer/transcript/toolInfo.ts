/**
 * What a tool card shows, worked out from the tool item alone: its icon, the short meta on the
 * right of its header, whether it counts as failed, and whether it starts open. Pure functions,
 * so the rules are tested without rendering.
 */
import type { ContentPart, DiffHunk, FileDisplay, SearchDisplay } from "@dawg/protocol";
import { MCP_DISPATCHER } from "../lib/tools.ts";
import type { ToolCallDisplay, ToolCallItem } from "../state/types.ts";
import type { IconName } from "../ui/index.ts";
import { agentHasOutcome, isAgentCall } from "./agentInfo.ts";
import { webMetaText } from "./webInfo.ts";

/** Tools whose result is a diff. Their cards open by default in "smart" mode. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
]);

export function toolIcon(toolName: string): IconName {
  switch (toolName) {
    case "Bash":
      return "terminal";
    case "Read":
      return "read";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "edit";
    case "Grep":
    case "Glob":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "globe";
    case "ToolSearch":
      return "search";
    default:
      return toolName === MCP_DISPATCHER || toolName.startsWith("mcp__") ? "server" : "model";
  }
}

/** The text parts of a result, joined. */
export function contentText(content: readonly ContentPart[] | null): string {
  if (!content) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** A failed call: an error or invalid input, or a command that exited non-zero or timed out. */
export function toolFailed(item: ToolCallItem): boolean {
  if (item.state === "error" || item.state === "invalid") return true;
  const display = item.display;
  if (display?.kind === "command") {
    return display.timedOut || (display.exitCode !== null && display.exitCode !== 0);
  }
  return false;
}

/**
 * Whether a card starts open, for the "Tool calls in the transcript" setting. In "smart" mode
 * what needs a look opens: failed calls, edits (to show the diff) and running commands (to show
 * their live output); reads, searches and passing commands stay one line. A subagent's card
 * opens once it has a final message (or an error) to read.
 */
export function defaultToolOpen(item: ToolCallItem, setting: ToolCallDisplay): boolean {
  if (setting === "open") return true;
  if (setting === "closed") return false;
  if (isAgentCall(item)) return agentHasOutcome(item);
  if (item.state === "running") return item.toolName === "Bash" || EDIT_TOOLS.has(item.toolName);
  if (toolFailed(item)) return true;
  if (EDIT_TOOLS.has(item.toolName)) return item.state === "success";
  return false;
}

export type MetaTone = "neutral" | "ok" | "bad";

export type MetaPart =
  | { kind: "text"; text: string; tone: MetaTone }
  | { kind: "diff"; additions: number; deletions: number };

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : pluralForm}`;
}

/** Files named in Grep's content output ("path:12:text"). */
function countMatchedFiles(text: string): number {
  const files = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^(.+?):\d+[:-]/.exec(line);
    if (match?.[1]) files.add(match[1]);
  }
  return files.size;
}

/** "14 matches in 6 files", "6 files", "no matches". */
export function searchSummary(
  toolName: string,
  input: Record<string, unknown>,
  display: SearchDisplay,
  text: string,
): string {
  const n = display.resultCount;
  if (n === 0) return toolName === "Glob" ? "no files" : "no matches";
  if (toolName === "Glob") return plural(n, "file");
  const mode = input.output_mode;
  if (mode === "content") {
    const files = countMatchedFiles(text);
    const matches = plural(n, "match", "matches");
    return files > 0 ? `${matches} in ${plural(files, "file")}` : matches;
  }
  if (mode === "count") {
    const total = /Total: (?:at least )?([\d,]+) match/.exec(text)?.[1];
    if (total)
      return `${plural(Number(total.replace(/,/g, "")), "match", "matches")} in ${plural(n, "file")}`;
  }
  return plural(n, "file");
}

function readSummary(display: FileDisplay, content: readonly ContentPart[] | null): string {
  if (content?.some((part) => part.type === "image")) return "image";
  if (display.lineCount === 0) return "empty";
  return plural(display.lineCount, "line");
}

/**
 * The header's meta for a finished call: exit status, line counts, +/− counts, match counts or a
 * short failure reason. Durations are added by the caller where they matter (commands).
 */
export function toolMeta(item: ToolCallItem): MetaPart[] {
  const { state, display } = item;
  if (state === "running") return [];
  if (state === "denied") return [{ kind: "text", text: "not allowed", tone: "bad" }];
  if (state === "invalid") return [{ kind: "text", text: "invalid input", tone: "bad" }];

  if (display?.kind === "command") {
    let status: MetaPart;
    if (display.backgroundTaskId !== null) {
      status = { kind: "text", text: "in the background", tone: "neutral" };
    } else if (display.timedOut) status = { kind: "text", text: "timed out", tone: "bad" };
    else if (display.interrupted || state === "interrupted") {
      status = { kind: "text", text: "interrupted", tone: "neutral" };
    } else if (display.exitCode === null) status = { kind: "text", text: "stopped", tone: "bad" };
    else {
      status = {
        kind: "text",
        text: `exit ${display.exitCode}`,
        tone: display.exitCode === 0 ? "ok" : "bad",
      };
    }
    return [status];
  }
  if (state === "interrupted") return [{ kind: "text", text: "interrupted", tone: "neutral" }];
  if (state === "error") return [{ kind: "text", text: "failed", tone: "bad" }];
  if (display?.kind === "diff") {
    return [{ kind: "diff", additions: display.additions, deletions: display.deletions }];
  }
  if (display?.kind === "file") {
    return [{ kind: "text", text: readSummary(display, item.content), tone: "neutral" }];
  }
  if (display?.kind === "search") {
    return [
      {
        kind: "text",
        text: searchSummary(item.toolName, item.input, display, contentText(item.content)),
        tone: "neutral",
      },
    ];
  }
  if (display?.kind === "web-fetch" || display?.kind === "web-search") {
    return [{ kind: "text", text: webMetaText(display), tone: "neutral" }];
  }
  if (display?.kind === "mcp" && display.savedTo !== null) {
    return [{ kind: "text", text: "saved to a file", tone: "neutral" }];
  }
  return [];
}

/** The duration shown after a finished command's status. */
export function toolDurationMs(item: ToolCallItem): number | null {
  if (item.display?.kind === "command" && item.display.durationMs !== null) {
    return item.display.durationMs;
  }
  return item.durationMs;
}

// --- Command output -------------------------------------------------------------------------

/**
 * Sentences the engine's Bash tool writes after a command's output (tools/bash/bash.ts). The
 * footer starts with one of these; further notes may follow it.
 */
const COMMAND_FOOTER_START = [
  /^Exit code -?\d+$/,
  /^The command (did not finish within|was interrupted|printed more than|was ended by|left processes running)/,
  /^The output was [\d,]+ characters, so only its beginning and end are shown\./,
  /^The working directory .+ no longer exists/,
  /^The command ended in .+, outside the working directories/,
];

export interface CommandOutput {
  /** What the command printed. */
  output: string;
  /** The engine's notes after it (timed out, cut short, …), shown muted under the output. */
  notes: string[];
}

/**
 * The output of a finished command: the display's `output` and `notes`, which the engine reports
 * apart from what the model was given. Sessions stored before engines reported them (`output`
 * null) fall back to taking the model's text apart (`finishedCommandOutput`).
 */
export function commandOutput(item: ToolCallItem): CommandOutput {
  const display = item.display?.kind === "command" ? item.display : null;
  if (display !== null && display.output !== null) {
    return { output: display.output, notes: display.notes };
  }
  return finishedCommandOutput(item);
}

/**
 * The fallback for sessions stored before engines reported `output` and `notes` on a command's
 * display: the output of a finished command, as the person would have seen it in a terminal.
 *
 * The result `content` is what the model was given, not what the command printed: the engine
 * prefixes a failed call's text with "Error: " (loop/executor.ts `markAsError`) and the Bash tool
 * appends a footer ("Exit code 1", timeout and truncation notes) after a blank line. When the live
 * chunks are known they are the output itself. Otherwise this undoes those two additions:
 * - "Error: " is removed only from a call that did not succeed and whose command did not exit 0
 *   (the engine's own test for an error, timeouts and interrupts included), so a command whose
 *   own first line starts with "Error:" loses that word;
 * - the last block after a blank line counts as the footer only when it starts with one of the
 *   engine's footer sentences; its "Exit code N" line (N being the exit code shown in the header)
 *   is dropped and the other notes are kept.
 * Engines now send the display output separately, so only stored sessions take this path.
 */
export function finishedCommandOutput(item: ToolCallItem): CommandOutput {
  const display = item.display?.kind === "command" ? item.display : null;
  let text = contentText(item.content);
  if (item.state !== "success" && display !== null && display.exitCode !== 0) {
    text = text.replace(/^Error: /, "");
  }
  const trimmed = text.replace(/\n+$/, "");
  const cut = trimmed.lastIndexOf("\n\n");
  const tail = cut === -1 ? trimmed : trimmed.slice(cut + 2);
  const footerLines = tail.split("\n");
  const isFooter = COMMAND_FOOTER_START.some((pattern) => pattern.test(footerLines[0] ?? ""));
  let body = isFooter ? (cut === -1 ? "" : trimmed.slice(0, cut)) : text;
  const exitLine = display?.exitCode != null ? `Exit code ${display.exitCode}` : null;
  const notes = isFooter ? footerLines.filter((line) => line !== exitLine && line !== "") : [];
  // The tool's stand-in for an empty result.
  if (body === "(no output)") body = "";
  const live = item.output.map((chunk) => chunk.text).join("");
  return { output: item.output.length > 0 ? live : body, notes };
}

// --- Read results ---------------------------------------------------------------------------

export interface FileLines {
  /** Number of the first line. */
  start: number;
  lines: string[];
  /** Text after the numbered lines (the tool's notes), or the whole text when it has none. */
  notes: string;
}

/** "  12→text": Read's numbered line format (engine: tools/files/format.ts). */
const NUMBERED_LINE = /^ *(\d+)→(.*)$/s;

/**
 * Splits a Read result into the file's lines and the notes after them, removing the line-number
 * prefixes the tool adds for the model. Falls back to the display's start line when the text has
 * no prefixes.
 */
export function parseReadResult(text: string, display: FileDisplay | null): FileLines {
  if (display !== null && display.lineCount === 0) return { start: 1, lines: [], notes: text };
  const all = text.split("\n");
  const lines: string[] = [];
  let start = -1;
  let index = 0;
  for (; index < all.length; index++) {
    const match = NUMBERED_LINE.exec(all[index] ?? "");
    if (!match) break;
    const number = Number(match[1]);
    if (start === -1) start = number;
    else if (number !== start + lines.length) break;
    lines.push(match[2] ?? "");
  }
  if (lines.length > 0) {
    return { start, lines, notes: all.slice(index).join("\n").trim() };
  }
  const count = display?.lineCount ?? all.length;
  return { start: display?.startLine ?? 1, lines: all.slice(0, count), notes: "" };
}

// --- Diffs ----------------------------------------------------------------------------------

export interface DiffRow {
  kind: "hunk" | "context" | "add" | "del" | "note";
  /** The line number shown: the new file's for context and additions, the old file's for deletions. */
  number: number | null;
  sign: "" | "+" | "-";
  text: string;
}

/** Rows for an inline diff, with line numbers counted from each hunk's start. */
export function diffRows(hunks: readonly DiffHunk[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const hunk of hunks) {
    rows.push({
      kind: "hunk",
      number: null,
      sign: "",
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === "+") {
        rows.push({ kind: "add", number: newLine++, sign: "+", text });
      } else if (marker === "-") {
        rows.push({ kind: "del", number: oldLine++, sign: "-", text });
      } else if (marker === "\\") {
        rows.push({ kind: "note", number: null, sign: "", text: line });
      } else {
        rows.push({
          kind: "context",
          number: newLine,
          sign: "",
          text: marker === " " ? text : line,
        });
        oldLine++;
        newLine++;
      }
    }
  }
  return rows;
}
