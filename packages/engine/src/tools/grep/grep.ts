/**
 * The Grep tool: a regex search over file contents, run by the pinned ripgrep.
 *
 * ripgrep runs directly (no shell), with the pattern passed as `--regexp=<pattern>` so that a
 * pattern starting with "-" is never read as a flag. As documented for Claude Code, files that
 * .gitignore excludes are skipped; hidden files are searched, version-control folders are not.
 * Results are made deterministic: content and count output is sorted by path, file lists by
 * modification time (newest first).
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import type { SearchDisplay } from "@dawg/protocol";
import type { PermissionSubject } from "../../contracts/permissions.ts";
import type {
  ToolContext,
  ToolDefinition,
  ToolOutput,
  ToolProbeContext,
} from "../../contracts/tools.ts";
import { type ProcessHandle, spawnInGroup } from "../exec/process.ts";
import { clearRipgrepCache, RipgrepNotFoundError, resolveRipgrep } from "../ripgrep/resolve.ts";

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  "-i"?: boolean;
  "-o"?: boolean;
  "-n"?: boolean;
  "-B"?: number;
  "-A"?: number;
  "-C"?: number;
  context?: number;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
}

export interface GrepToolOptions {
  /** Finds the ripgrep binary. Defaults to the standard resolver. */
  findRipgrep?: (ctx: ToolContext) => Promise<string>;
}

/** Entries shown when `head_limit` is 0 ("no limit"), so a result can never be unbounded. */
const UNLIMITED_HEAD_LIMIT = 5_000;
/** Content lines counted past the shown page before the search stops counting. */
const EXTRA_COUNT_LIMIT = 20_000;
/** Matching files collected in files mode before the search stops. */
const MAX_FILES = 50_000;
const VCS_DIRS = [".git", ".hg", ".svn", ".jj", ".bzr", "_darcs"];
const STDERR_LIMIT = 4_000;

const DESCRIPTION = `Search file contents for a regular expression, using ripgrep.

- The pattern uses ripgrep's regex syntax, not grep's. Escape special characters to match them literally: "interface\\{\\}" finds "interface{}", "foo\\.bar" finds "foo.bar".
- output_mode "files_with_matches" (the default) lists the files that match, newest first. "content" shows the matching lines with their line numbers. "count" shows how many matches each file has, and the total.
- Narrow the search with glob (for example "*.js" or "src/**/*.{ts,tsx}") or type (a ripgrep file type such as "py", "rust" or "js").
- In content mode: -A, -B and -C (or context) add lines after, before or around each match; -o shows only the matched text; -n false hides line numbers.
- -i ignores case. multiline lets a pattern span lines, with "." also matching newlines.
- Results stop at head_limit entries (lines, files or count rows); pass offset to see the next ones.
- Files ignored by .gitignore are skipped unless you name one as the path. Hidden files are searched.
- Use this tool rather than running grep or rg with Bash.`;

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "The regular expression to search for." },
    path: {
      type: "string",
      description: "File or directory to search. Defaults to the working directory.",
    },
    glob: {
      type: "string",
      description: 'Only search files whose paths match this glob, for example "*.ts".',
    },
    type: {
      type: "string",
      description: 'Only search files of this ripgrep type, for example "py" or "go".',
    },
    output_mode: {
      type: "string",
      enum: ["content", "files_with_matches", "count"],
      description: 'What to return. Defaults to "files_with_matches".',
    },
    "-i": { type: "boolean", description: "Ignore case." },
    "-o": {
      type: "boolean",
      description: "Show only the matched part of each line. Content mode only.",
    },
    "-n": {
      type: "boolean",
      description: "Show line numbers. Content mode only; defaults to true.",
    },
    "-B": {
      type: "integer",
      minimum: 0,
      description: "Lines of context before each match. Content mode only.",
    },
    "-A": {
      type: "integer",
      minimum: 0,
      description: "Lines of context after each match. Content mode only.",
    },
    "-C": {
      type: "integer",
      minimum: 0,
      description: "Lines of context before and after each match. Content mode only.",
    },
    context: { type: "integer", minimum: 0, description: "The same as -C." },
    head_limit: {
      type: "integer",
      minimum: 0,
      description: "Return at most this many entries. 0 means no limit.",
    },
    offset: {
      type: "integer",
      minimum: 0,
      description: "Skip this many entries first, to page through long results.",
    },
    multiline: {
      type: "boolean",
      description: 'Let the pattern match across lines, with "." matching newlines.',
    },
  },
  required: ["pattern"],
  additionalProperties: false,
} as const;

type Mode = "content" | "files_with_matches" | "count";

function searchPathOf(input: GrepInput, cwd: string): string {
  return path.resolve(cwd, input.path?.trim() ? input.path : ".");
}

/** The ripgrep arguments for a search. Exported for tests. */
export function buildRipgrepArgs(
  input: GrepInput,
  searchPath: string,
  maxLineChars: number,
): string[] {
  const mode: Mode = input.output_mode ?? "files_with_matches";
  const args = ["--no-config", "--color=never", "--no-messages", "--hidden"];
  for (const dir of VCS_DIRS) args.push(`--glob=!${dir}`);
  if (input.glob) args.push(`--glob=${input.glob}`);
  if (input.type) args.push(`--type=${input.type}`);
  if (input["-i"]) args.push("--ignore-case");
  if (input.multiline) args.push("--multiline", "--multiline-dotall");
  if (mode === "files_with_matches") {
    args.push("--files-with-matches", "--null");
  } else if (mode === "count") {
    args.push("--count-matches", "--with-filename", "--null");
  } else {
    args.push(
      "--line-number",
      "--with-filename",
      "--null",
      "--no-heading",
      "--sort=path",
      `--max-columns=${Math.max(1, Math.floor(maxLineChars))}`,
      "--max-columns-preview",
    );
    if (input["-o"]) args.push("--only-matching");
    const around = input["-C"] ?? input.context;
    const before = input["-B"] ?? around;
    const after = input["-A"] ?? around;
    if (before !== undefined && before > 0) args.push(`--before-context=${Math.floor(before)}`);
    if (after !== undefined && after > 0) args.push(`--after-context=${Math.floor(after)}`);
  }
  args.push(`--regexp=${input.pattern}`, "--", searchPath);
  return args;
}

export function createGrepTool(options: GrepToolOptions = {}): ToolDefinition<GrepInput> {
  const findRipgrep =
    options.findRipgrep ??
    (async (ctx: ToolContext) => (await resolveRipgrep({ explicitPath: ctx.ripgrepPath })).path);

  return {
    name: "Grep",
    description: DESCRIPTION,
    inputSchema: INPUT_SCHEMA,
    readOnly: true,

    permission(input: GrepInput, ctx: ToolProbeContext): PermissionSubject {
      return { kind: "read", paths: [searchPathOf(input, ctx.cwd)] };
    },

    async execute(input: GrepInput, ctx: ToolContext): Promise<ToolOutput> {
      if (input.pattern.includes("\0") || input.path?.includes("\0")) {
        return errorOutput(
          "The pattern and path must not contain a null byte. Remove it and try again.",
        );
      }
      if (input.pattern === "") return errorOutput("The pattern is empty.");
      const searchPath = searchPathOf(input, ctx.cwd);
      const info = await stat(searchPath).catch(() => null);
      if (!info) return errorOutput(`The path ${searchPath} does not exist.`);

      let rgPath: string;
      try {
        rgPath = await findRipgrep(ctx);
      } catch (error) {
        if (error instanceof RipgrepNotFoundError) return errorOutput(error.message);
        throw error;
      }

      const mode: Mode = input.output_mode ?? "files_with_matches";
      const requested = input.head_limit ?? ctx.limits.grepDefaultHeadLimit;
      const limit = requested <= 0 ? UNLIMITED_HEAD_LIMIT : Math.floor(requested);
      const offset = Math.max(0, Math.floor(input.offset ?? 0));
      const timeLimitMs = ctx.limits.searchTimeoutMs;
      const run = {
        rgPath,
        args: buildRipgrepArgs(input, searchPath, ctx.limits.grepMaxLineChars),
        cwd: info.isDirectory() ? searchPath : path.dirname(searchPath),
        mode,
        limit,
        offset,
        timeLimitMs,
        signal: ctx.signal,
        denied: memoize(ctx.readDenied),
      };

      let result: SearchRun;
      try {
        result = await runSearch(run);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // The binary vanished since it was checked (re-fetched, deleted): look again once.
        clearRipgrepCache();
        result = await runSearch({ ...run, rgPath: await findRipgrep(ctx) });
      }
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("aborted");

      if (result.failed) {
        const detail = result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`;
        return errorOutput(`The search could not run:\n${detail}`);
      }
      return formatResult(input, result, { mode, limit, offset, timeLimitMs }, ctx);
    },
  };
}

export const grepTool: ToolDefinition<GrepInput> = createGrepTool();

interface ContentEntry {
  separator: boolean;
  text: string;
}

interface SearchRun {
  /** Content mode: the shown lines. Files mode: every matching file. Count mode: every row. */
  entries: ContentEntry[];
  files: string[];
  counts: { file: string; count: number }[];
  /** Content mode: lines found (matches and context), within the counting cap. */
  totalLines: number;
  /** True when counting stopped early, so totals are lower bounds. */
  stoppedEarly: boolean;
  timedOut: boolean;
  failed: boolean;
  exitCode: number | null;
  stderr: string;
}

async function runSearch(run: {
  rgPath: string;
  args: string[];
  cwd: string;
  mode: Mode;
  limit: number;
  offset: number;
  timeLimitMs: number;
  signal: AbortSignal;
  /** Files whose results must be left out (read-denied), silently. */
  denied: ((absolutePath: string) => boolean) | undefined;
}): Promise<SearchRun> {
  const denied = run.denied;
  const result: SearchRun = {
    entries: [],
    files: [],
    counts: [],
    totalLines: 0,
    stoppedEarly: false,
    timedOut: false,
    failed: false,
    exitCode: null,
    stderr: "",
  };
  let partial = "";
  let handle: ProcessHandle | null = null;
  let stopping = false;
  const stop = () => {
    if (stopping || !handle) return;
    stopping = true;
    void handle.terminate(500);
  };

  const wanted = run.offset + run.limit;
  const takeContentLine = (line: string) => {
    const nul = line.indexOf("\0");
    if (nul < 0) {
      // A group separator ("--") between context blocks.
      const last = result.entries[result.entries.length - 1];
      if (result.entries.length > 0 && !last?.separator && result.totalLines > run.offset) {
        result.entries.push({ separator: true, text: "--" });
      }
      return;
    }
    if (denied?.(line.slice(0, nul))) return;
    result.totalLines += 1;
    if (result.totalLines > run.offset && result.totalLines <= wanted) {
      result.entries.push({ separator: false, text: line });
    }
    if (result.totalLines >= wanted + EXTRA_COUNT_LIMIT) {
      result.stoppedEarly = true;
      stop();
    }
  };
  const takeRecord = (record: string) => {
    if (run.mode === "files_with_matches") {
      if (!record || denied?.(record)) return;
      result.files.push(record);
      if (result.files.length >= MAX_FILES) {
        result.stoppedEarly = true;
        stop();
      }
      return;
    }
    const nul = record.indexOf("\0");
    if (nul < 0) return;
    const file = record.slice(0, nul);
    const count = Number(record.slice(nul + 1));
    if (Number.isFinite(count) && !denied?.(file)) result.counts.push({ file, count });
  };

  const separator = run.mode === "files_with_matches" ? "\0" : "\n";
  const onText = (text: string) => {
    if (stopping) return;
    const pieces = (partial + text).split(separator);
    partial = pieces.pop() ?? "";
    for (const piece of pieces) {
      if (stopping) return;
      if (run.mode === "content") takeContentLine(piece);
      else takeRecord(piece);
    }
  };

  const env = { ...process.env };
  delete env.RIPGREP_CONFIG_PATH;
  handle = spawnInGroup(run.rgPath, run.args, {
    cwd: run.cwd,
    env,
    onOutput: (stream, text) => {
      if (stream === "stdout") onText(text);
      else if (result.stderr.length < STDERR_LIMIT) result.stderr += text;
    },
  });

  const onAbort = () => stop();
  run.signal.addEventListener("abort", onAbort, { once: true });
  if (run.signal.aborted) stop();
  const timer = setTimeout(() => {
    result.timedOut = true;
    stop();
  }, run.timeLimitMs);
  try {
    const exit = await handle.exited;
    if (exit.error) throw exit.error;
    await handle.drained;
    if (stopping) await handle.terminate(500);
    if (!stopping && partial) {
      if (run.mode === "content") takeContentLine(partial);
      else takeRecord(partial);
    }
    result.exitCode = exit.code;
    const produced = result.totalLines > 0 || result.files.length > 0 || result.counts.length > 0;
    // Exit code 2 with output means some files could not be read; without, the search failed.
    result.failed = !stopping && exit.code !== 0 && exit.code !== 1 && !produced;
  } finally {
    clearTimeout(timer);
    run.signal.removeEventListener("abort", onAbort);
  }
  const last = result.entries[result.entries.length - 1];
  if (last?.separator) result.entries.pop();
  result.stderr = result.stderr.slice(0, STDERR_LIMIT);
  return result;
}

async function formatResult(
  input: GrepInput,
  result: SearchRun,
  page: { mode: Mode; limit: number; offset: number; timeLimitMs: number },
  ctx: ToolContext,
): Promise<ToolOutput> {
  const notes: string[] = [];
  if (result.timedOut) {
    notes.push(
      `The search stopped after ${Math.round(page.timeLimitMs / 1000)} seconds, so results may be incomplete. Narrow the path, glob or type.`,
    );
  }
  if (result.stderr.trim() && result.exitCode === 2 && !result.timedOut && !result.stoppedEarly) {
    notes.push(`Some files could not be searched:\n${firstLines(result.stderr, 5)}`);
  }
  const atLeast = result.stoppedEarly || result.timedOut ? "at least " : "";

  let body: string;
  let resultCount: number;
  let truncated = false;
  if (page.mode === "content") {
    resultCount = result.totalLines;
    if (result.totalLines === 0) body = "No matches found.";
    else if (result.entries.length === 0) {
      body = `No entries at this offset: the search found ${atLeast}${result.totalLines} lines.`;
    } else {
      const showNumbers = input["-n"] !== false;
      body = result.entries
        .map((e) => (e.separator ? e.text : formatContentLine(e.text, showNumbers)))
        .join("\n");
      const shown = result.entries.filter((e) => !e.separator).length;
      const last = page.offset + shown;
      if (last < result.totalLines || result.stoppedEarly) {
        truncated = true;
        notes.unshift(
          `Showing lines ${page.offset + 1}-${last} of ${atLeast}${result.totalLines}. Pass offset=${last} to see more.`,
        );
      }
    }
  } else if (page.mode === "files_with_matches") {
    resultCount = result.files.length;
    if (result.files.length === 0) body = "No matches found.";
    else {
      const sorted = await sortByModified(result.files);
      const pageFiles = sorted.slice(page.offset, page.offset + page.limit);
      if (pageFiles.length === 0) {
        body = `No entries at this offset: ${atLeast}${sorted.length} files match.`;
      } else {
        body = pageFiles.join("\n");
        const last = page.offset + pageFiles.length;
        if (last < sorted.length || result.stoppedEarly) {
          truncated = true;
          notes.unshift(
            `Showing files ${page.offset + 1}-${last} of ${atLeast}${sorted.length}. Pass offset=${last} to see more.`,
          );
        }
      }
    }
  } else {
    const rows = [...result.counts].sort((a, b) => compare(a.file, b.file));
    const totalMatches = rows.reduce((sum, row) => sum + row.count, 0);
    resultCount = rows.length;
    if (rows.length === 0) body = "No matches found.";
    else {
      const pageRows = rows.slice(page.offset, page.offset + page.limit);
      const summary = `${atLeast}${totalMatches} ${totalMatches === 1 ? "match" : "matches"} in ${rows.length} ${rows.length === 1 ? "file" : "files"}.`;
      if (pageRows.length === 0) body = `No entries at this offset. Total: ${summary}`;
      else {
        body = `${pageRows.map((r) => `${r.file}:${r.count}`).join("\n")}\n\nTotal: ${summary}`;
        const last = page.offset + pageRows.length;
        if (last < rows.length) {
          truncated = true;
          notes.unshift(
            `Showing files ${page.offset + 1}-${last} of ${rows.length}. Pass offset=${last} to see more.`,
          );
        }
      }
    }
  }

  let text = notes.length > 0 ? `${body}\n\n${notes.join("\n")}` : body;
  const maxChars = Math.max(1, ctx.limits.grepMaxOutputChars);
  if (text.length > maxChars) {
    const saved = await ctx.saveOutput("grep-results.txt", text);
    const cut = text.slice(0, maxChars);
    const end = cut.lastIndexOf("\n");
    text = `${end > 0 ? cut.slice(0, end) : cut}\n\n[The result was ${text.length} characters, so it was cut here. The full result is in ${saved}. Read it there, or narrow the search.]`;
    truncated = true;
  }
  const display: SearchDisplay = {
    kind: "search",
    pattern: input.pattern,
    resultCount,
    truncated: truncated || result.timedOut || result.stoppedEarly,
  };
  return { content: [{ type: "text", text }], display };
}

/** Turns ripgrep's `path\0line:text` (or `-` for context) into `path:line:text`. */
function formatContentLine(line: string, showNumbers: boolean): string {
  const nul = line.indexOf("\0");
  const file = line.slice(0, nul);
  const rest = line.slice(nul + 1);
  const match = /^(\d+)([:-])/.exec(rest);
  if (!match) return `${file}:${rest}`;
  const [prefix, lineNo, kind] = match;
  const text = rest.slice(prefix.length);
  return showNumbers ? `${file}${kind}${lineNo}${kind}${text}` : `${file}${kind}${text}`;
}

async function sortByModified(files: string[]): Promise<string[]> {
  const times = new Map<string, number>();
  const queue = [...files];
  const worker = async () => {
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      const info = await stat(file).catch(() => null);
      times.set(file, info?.mtimeMs ?? 0);
    }
  };
  await Promise.all(Array.from({ length: 32 }, worker));
  return [...files].sort((a, b) => (times.get(b) ?? 0) - (times.get(a) ?? 0) || compare(a, b));
}

/** Remembers the answer for each path, since every matching line of a file asks again. */
function memoize(
  check: ((absolutePath: string) => boolean) | undefined,
): ((absolutePath: string) => boolean) | undefined {
  if (!check) return undefined;
  const answers = new Map<string, boolean>();
  return (file) => {
    let answer = answers.get(file);
    if (answer === undefined) {
      answer = check(file);
      answers.set(file, answer);
    }
    return answer;
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function firstLines(text: string, count: number): string {
  return text.trim().split("\n").slice(0, count).join("\n");
}

function errorOutput(message: string): ToolOutput {
  return { content: [{ type: "text", text: message }], isError: true };
}
