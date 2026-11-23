/**
 * Calls and results for the real tools, with their input fields and output shapes
 * (packages/engine/src/tools): what `tool.started` carries as input, what `tool.finished` gives
 * the model as content, and the `display` a client renders.
 */
import type { CommandDisplay, DiffHunk, TaskItem } from "@dawg/protocol";
import type { MessageRecorder, Recorder, ToolCall, ToolProgressStep } from "./recorder.ts";
import { diffDisplay, hunk, hunkSides, numberLines, plural } from "./text.ts";

// ---------------------------------------------------------------------------------------------
// Bash
// ---------------------------------------------------------------------------------------------

export function callBash(m: MessageRecorder, command: string, description: string): ToolCall {
  return m.call("Bash", { command, description });
}

export interface BashRun {
  output: string;
  exitCode: number;
  durationMs: number;
  /** Live output and status lines. Default: the output in a few pieces across the run. */
  progress?: ToolProgressStep[];
  /** False when the call waited for permission and `tool.started` was already sent. */
  start?: boolean;
}

/** The command display for a finished foreground command. */
export function commandDisplay(
  rec: Recorder,
  command: string,
  exitCode: number | null,
  durationMs: number,
  interrupted = false,
): CommandDisplay {
  return {
    kind: "command",
    command,
    cwd: rec.cwd,
    exitCode,
    durationMs,
    timedOut: false,
    interrupted,
    backgroundTaskId: null,
    outputPath: null,
  };
}

/**
 * Runs a Bash call. As in the real tool, a non-zero exit is an error result: the output, then
 * "Exit code N", marked "Error:" for the model.
 */
export function runBash(rec: Recorder, call: ToolCall, run: BashRun): void {
  const command = String(call.input.command);
  const body = run.output.replace(/\n+$/, "");
  const content =
    run.exitCode === 0
      ? body || "(no output)"
      : `Error: ${body ? `${body}\n\n` : ""}Exit code ${run.exitCode}`;
  rec.runTool(call, {
    start: run.start,
    durationMs: run.durationMs,
    outcome: run.exitCode === 0 ? "success" : "error",
    content,
    display: commandDisplay(rec, command, run.exitCode, run.durationMs),
    progress: run.progress ?? spreadOutput(run.output, run.durationMs),
  });
}

/** The output as it would stream: the first line early, the rest in pieces near the end. */
function spreadOutput(output: string, durationMs: number): ToolProgressStep[] {
  const lines = output.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (lines.length === 0) return [];
  const steps: ToolProgressStep[] = [];
  const [first, ...rest] = lines;
  steps.push({ at: Math.round(durationMs * 0.35), output: first ?? "" });
  for (let i = 0; i < rest.length; i += 4) {
    const at = Math.round(durationMs * (0.8 + (0.18 * i) / Math.max(rest.length, 1)));
    steps.push({ at, output: rest.slice(i, i + 4).join("") });
  }
  return steps;
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export function callRead(m: MessageRecorder, rec: Recorder, relative: string): ToolCall {
  return m.call("Read", { file_path: rec.path(relative) });
}

/** Reads a whole file. `lines` is every line of it. */
export function runRead(rec: Recorder, call: ToolCall, lines: readonly string[]): void {
  rec.runTool(call, {
    durationMs: rec.random.int(3, 14),
    content: numberLines(lines, 1),
    display: {
      kind: "file",
      filePath: String(call.input.file_path),
      startLine: 1,
      lineCount: lines.length,
      totalLines: lines.length,
      truncated: false,
    },
  });
}

/** A Read of part of a file. */
export function callReadRange(
  m: MessageRecorder,
  rec: Recorder,
  relative: string,
  offset: number,
  limit: number,
): ToolCall {
  return m.call("Read", { file_path: rec.path(relative), offset, limit });
}

/** Runs a ranged Read: `lines` are the lines shown, starting at line `offset`. */
export function runReadRange(
  rec: Recorder,
  call: ToolCall,
  lines: readonly string[],
  totalLines: number,
): void {
  const start = Number(call.input.offset);
  const last = start + lines.length - 1;
  const note =
    last < totalLines
      ? `[Lines ${start}-${last} of ${totalLines} shown. To continue, Read with offset ${last + 1}.]`
      : `[Lines ${start}-${last} of ${totalLines} shown, to the end of the file.]`;
  rec.runTool(call, {
    durationMs: rec.random.int(3, 14),
    content: `${numberLines(lines, start)}\n\n${note}`,
    display: {
      kind: "file",
      filePath: String(call.input.file_path),
      startLine: start,
      lineCount: lines.length,
      totalLines,
      truncated: false,
    },
  });
}

/** An Edit call whose old and new text are the changed part of `h`. */
export function callEdit(
  m: MessageRecorder,
  rec: Recorder,
  relative: string,
  h: DiffHunk,
  sides?: { before: string; after: string },
): ToolCall {
  const { before, after } = sides ?? hunkSides(h);
  return m.call("Edit", { file_path: rec.path(relative), old_string: before, new_string: after });
}

/**
 * Runs an Edit: "Edited <path>." and the lines around the change as they are now, with the diff
 * as display.
 */
export function runEdit(
  rec: Recorder,
  call: ToolCall,
  h: DiffHunk,
  options: { start?: boolean } = {},
): void {
  const filePath = String(call.input.file_path);
  const after = h.lines.filter((line) => !line.startsWith("-")).map((line) => line.slice(1));
  const last = h.newStart + after.length - 1;
  const header =
    after.length === 1
      ? `Line ${h.newStart} after the edit:`
      : `Lines ${h.newStart}-${last} after the edit:`;
  rec.runTool(call, {
    start: options.start,
    durationMs: rec.random.int(6, 22),
    content: `Edited ${filePath}.\n\n${header}\n${numberLines(after, h.newStart)}`,
    display: diffDisplay(filePath, [h]),
  });
}

export function callWrite(
  m: MessageRecorder,
  rec: Recorder,
  relative: string,
  content: string,
): ToolCall {
  return m.call("Write", { file_path: rec.path(relative), content });
}

/** Runs a Write that creates a file. */
export function runWrite(rec: Recorder, call: ToolCall): void {
  const filePath = String(call.input.file_path);
  const text = String(call.input.content);
  const lines = text.replace(/\n$/, "").split("\n");
  rec.runTool(call, {
    durationMs: rec.random.int(5, 18),
    content: `Created ${filePath} (${plural(lines.length, "line")}).`,
    display: diffDisplay(
      filePath,
      [
        hunk(
          0,
          1,
          lines.map((line) => `+${line}`),
        ),
      ],
      true,
    ),
  });
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

export function callGrep(
  m: MessageRecorder,
  pattern: string,
  options: { path?: string; glob?: string; output_mode?: "content" | "files_with_matches" } = {},
): ToolCall {
  return m.call("Grep", { pattern, ...options });
}

/** Content mode: `<absolute path>:<line>:<text>` per matching line. */
export function runGrep(
  rec: Recorder,
  call: ToolCall,
  matches: readonly { file: string; line: number; text: string }[],
): void {
  const body =
    matches.length === 0
      ? "No matches found."
      : matches.map((m) => `${rec.path(m.file)}:${m.line}:${m.text}`).join("\n");
  rec.runTool(call, {
    durationMs: rec.random.int(30, 90),
    content: body,
    display: {
      kind: "search",
      pattern: String(call.input.pattern),
      resultCount: matches.length,
      truncated: false,
    },
  });
}

export function callGlob(m: MessageRecorder, pattern: string): ToolCall {
  return m.call("Glob", { pattern });
}

/** Absolute paths, most recently modified first. */
export function runGlob(rec: Recorder, call: ToolCall, files: readonly string[]): void {
  rec.runTool(call, {
    durationMs: rec.random.int(12, 40),
    content:
      files.length === 0
        ? `No files found matching ${String(call.input.pattern)}.`
        : files.map((f) => rec.path(f)).join("\n"),
    display: {
      kind: "search",
      pattern: String(call.input.pattern),
      resultCount: files.length,
      truncated: false,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Interactive tools
// ---------------------------------------------------------------------------------------------

export function callTodo(m: MessageRecorder, todos: TaskItem[]): ToolCall {
  return m.call("TodoWrite", { todos });
}

export interface QuestionInput {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export function callAsk(m: MessageRecorder, questions: QuestionInput[]): ToolCall {
  return m.call("AskUserQuestion", { questions });
}

export function callPlan(m: MessageRecorder, plan: string): ToolCall {
  return m.call("ExitPlanMode", { plan });
}
