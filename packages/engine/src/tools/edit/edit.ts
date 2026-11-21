import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolDefinition, ToolOutput } from "../../contracts/index.ts";
import {
  atomicWriteFile,
  buildDiffDisplay,
  countLines,
  decodeText,
  describeFsError,
  displayLines,
  encodeText,
  errorCode,
  fileTracker,
  formatBytes,
  formatNumberedLines,
  hashBytes,
  LINE_NUMBER_SEPARATOR,
  listNumbers,
  plural,
  probePath,
  resolveToolPath,
  splitModelLines,
} from "../files/index.ts";
import { directoryMessage, errorResult, missingFileMessage, textParts } from "../files/messages.ts";
import { describeRegionDifferences, findClosestRegion } from "./closest.ts";
import { describeIndentStyle } from "./indent.ts";
import { type Differences, FileText, type MatchPlan, type MatchStep, planEdit } from "./match.ts";
import { describeLookAlike } from "./normalize.ts";

export interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/** Files larger than this are left to shell tools. */
export const MAX_EDIT_BYTES = 64 * 1024 * 1024;

/** Lines of context shown around each change in the result. */
const SNIPPET_CONTEXT = 3;
/** Changes shown with a snippet when `replace_all` changed many places. */
const MAX_SNIPPETS = 3;

export const EDIT_DESCRIPTION = `Replace text in a file: old_string is the text to find, new_string is the text to put in its place.

- Read the file first in this session. The edit is refused if the file changed on disk after you read it. After a successful Edit or Write you can edit the file again without reading it.
- Copy old_string exactly from the file, with the same indentation and line breaks, but without the line-number prefixes Read shows.
- old_string must match exactly one place. If it matches several, add a few neighbouring lines to it, or set replace_all to true to change every match.
- Keep old_string short: the lines you are changing plus a line of context is usually enough.
- new_string replaces all of old_string, so include any lines from old_string that should stay.
- To create a new file or rewrite a whole file, use Write.`;

export const editTool: ToolDefinition<EditInput> = {
  name: "Edit",
  description: EDIT_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The file to change: an absolute path, or relative to the working directory.",
      },
      old_string: {
        type: "string",
        description: "The exact text to replace, copied from the file.",
      },
      new_string: {
        type: "string",
        description: "The text to put in place of old_string.",
      },
      replace_all: {
        type: "boolean",
        description: "Replace every match of old_string instead of exactly one. Defaults to false.",
      },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },
  readOnly: false,
  permission(input, ctx) {
    return { kind: "edit", paths: [resolveToolPath(input.file_path, ctx.cwd)] };
  },
  execute: executeEdit,
};

async function executeEdit(input: EditInput, ctx: ToolContext): Promise<ToolOutput> {
  if (input.file_path.trim() === "") {
    return errorResult("file_path is empty. Give the path of the file to edit.");
  }
  if (input.old_string === input.new_string) {
    return errorResult(
      "old_string and new_string are identical, so the edit would change nothing. Put the replacement text in new_string.",
    );
  }
  const filePath = resolveToolPath(input.file_path, ctx.cwd);
  try {
    return await editPath(filePath, input, ctx);
  } catch (error) {
    ctx.signal.throwIfAborted();
    const message = describeFsError(error, "edit", filePath);
    if (message !== null) return errorResult(message);
    throw error;
  }
}

async function editPath(filePath: string, input: EditInput, ctx: ToolContext): Promise<ToolOutput> {
  const probe = await probePath(filePath);
  if (probe.kind === "missing") {
    if (input.old_string === "") return createFile(filePath, input.new_string, ctx);
    const missing = await missingFileMessage(filePath, input.file_path, ctx.workingDirectories);
    return errorResult(`${missing}\nTo create a new file, use Write.`);
  }
  if (probe.kind === "directory") return errorResult(await directoryMessage(filePath, "Edit"));
  if (probe.kind === "special") {
    return errorResult(
      `${filePath} is not a regular file (it is a pipe, socket or device), so Edit cannot change it.`,
    );
  }
  if (probe.stats.size > MAX_EDIT_BYTES) {
    return errorResult(
      `${filePath} is too large for Edit (${formatBytes(probe.stats.size)}; the limit is ${formatBytes(MAX_EDIT_BYTES)}). Use a shell command such as sed to change it.`,
    );
  }

  const bytes = await readFile(filePath, { signal: ctx.signal });
  const decoded = decodeText(bytes);
  if (decoded.kind === "binary") {
    return errorResult(`${filePath} is a binary file, so Edit cannot change it.`);
  }
  if (decoded.invalid) {
    return errorResult(
      `${filePath} is not valid UTF-8 text (it may use a legacy encoding such as Latin-1, Windows-1252 or Shift-JIS). Edit would damage the bytes it cannot decode, so nothing was changed. Make the change with a shell command that keeps the encoding, such as sed, or ask the user whether to convert the file to UTF-8.`,
    );
  }

  const oldText = decoded.text;
  const tracker = fileTracker(ctx.state);
  const freshness = tracker.freshness(filePath, hashBytes(bytes));
  const fillingEmptyFile = input.old_string === "" && oldText === "";
  if (!fillingEmptyFile) {
    if (freshness.status === "unread") {
      return errorResult(
        `You have not read ${filePath} in this session. Read it first (at least the part you want to change), then retry the edit.`,
      );
    }
    if (freshness.status === "stale") {
      return errorResult(
        `${filePath} has changed on disk since you last read it. Read it again, then retry the edit against its current text.`,
      );
    }
  }
  // After filling an empty file the model has written every line itself.
  const knewWholeFile =
    fillingEmptyFile || (freshness.status === "current" && freshness.record.whole);

  if (input.old_string === "" && oldText !== "") {
    return errorResult(
      `old_string is empty, but ${filePath} is not. To insert text, put the line next to where it goes in old_string, and that line plus your new text in new_string. To replace the whole file, use Write.`,
    );
  }

  let plan: MatchPlan;
  const file = new FileText(oldText);
  if (fillingEmptyFile) {
    plan = {
      kind: "matched",
      step: "exact",
      preprocess: "none",
      edits: [{ start: 0, end: 0, replacement: input.new_string, line: 0 }],
      newText: input.new_string,
      differences: {
        trailingWhitespace: false,
        indentation: false,
        indentationConsistent: true,
        fileIndent: null,
        modelIndent: null,
        lookAlikes: [],
        innerWhitespace: false,
        missingFinalNewline: false,
      },
    };
  } else {
    plan = planEdit(file, input.old_string, input.new_string, input.replace_all === true);
  }

  if (plan.kind === "none") return errorResult(noMatchMessage(filePath, file, input));
  if (plan.kind === "ambiguous") return errorResult(ambiguousMessage(filePath, plan));
  if (plan.newText === oldText) {
    return errorResult(
      "Nothing was changed: once new_string was fitted to the file's whitespace and characters, it was the same as the text it would replace. Check that new_string contains the change you meant.",
    );
  }

  ctx.signal.throwIfAborted();
  const newBytes = encodeText(plan.newText, decoded.encoding, decoded.bom);
  await atomicWriteFile(filePath, newBytes, { mode: probe.stats.mode & 0o7777 });
  const after = await stat(filePath);
  tracker.recordWrite(
    filePath,
    {
      hash: hashBytes(newBytes),
      size: newBytes.length,
      mtimeMs: after.mtimeMs,
      totalLines: countLines(plan.newText),
    },
    "edit",
    knewWholeFile,
  );

  return {
    content: textParts(successMessage(filePath, plan, ctx.limits.readMaxLineChars)),
    display: buildDiffDisplay(filePath, oldText, plan.newText),
    touched: { written: [filePath] },
  };
}

async function createFile(
  filePath: string,
  content: string,
  ctx: ToolContext,
): Promise<ToolOutput> {
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST" || code === "ENOTDIR") {
      return errorResult(
        `Cannot create ${filePath}: part of its directory path is a file, not a directory.`,
      );
    }
    throw error;
  }
  ctx.signal.throwIfAborted();
  const bytes = encodeText(content, "utf8", false);
  await atomicWriteFile(filePath, bytes);
  const after = await stat(filePath);
  const totalLines = countLines(content);
  fileTracker(ctx.state).recordWrite(
    filePath,
    { hash: hashBytes(bytes), size: bytes.length, mtimeMs: after.mtimeMs, totalLines },
    "write",
    true,
  );
  return {
    content: textParts(`Created ${filePath} (${plural(totalLines, "line")}).`),
    display: buildDiffDisplay(filePath, null, content),
    touched: { written: [filePath] },
  };
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

const STEP_IGNORED: Record<Exclude<MatchStep, "exact">, string> = {
  "line-endings": "line endings",
  "trailing-whitespace": "trailing whitespace",
  indentation: "indentation",
  "look-alikes": "indentation and look-alike characters such as curly quotes",
  "inner-whitespace": "all differences in whitespace and look-alike characters",
};

function noMatchMessage(filePath: string, file: FileText, input: EditInput): string {
  const lines = [`No match: old_string was not found in ${filePath}. Nothing was changed.`];
  // Models sometimes repeat an edit that already landed. Only a substantial new_string that is
  // not part of old_string says anything about that.
  const telling =
    input.new_string.trim().length >= 8 && !input.old_string.includes(input.new_string);
  const already = telling ? file.text.indexOf(input.new_string) : -1;
  if (already !== -1) {
    lines.push(
      `new_string already appears in the file at line ${file.lineAt(already) + 1}, so this change may have been made already.`,
    );
  }
  const fileLines = displayLines(file.text);
  const oldLines = splitModelLines(input.old_string);
  if (oldLines.length > 1 && oldLines[oldLines.length - 1] === "") oldLines.pop();
  const region = findClosestRegion(fileLines, oldLines);
  if (region === null) {
    lines.push(
      "Nothing in the file looks like old_string. Read the file again to see its current text, or use Grep to find where the text you want is.",
    );
    return lines.join("\n");
  }
  const first = region.startLine + 1;
  const last = region.endLine + 1;
  const where = first === last ? `line ${first}` : `lines ${first}-${last}`;
  lines.push(
    `The most similar text is at ${where}. The lines that differ, as JSON strings so whitespace shows (- old_string, + file):`,
    describeRegionDifferences(fileLines, region, oldLines),
  );
  const from = Math.max(1, first - 2);
  lines.push(
    `Copy the text exactly as it is in the file (Read with offset ${from} and limit ${last - from + 3} to see it again), then retry.`,
  );
  return lines.join("\n");
}

function ambiguousMessage(
  filePath: string,
  plan: Extract<MatchPlan, { kind: "ambiguous" }>,
): string {
  const count = plan.lines.length;
  const unique = [...new Set(plan.lines)];
  const where =
    unique.length === 1 ? `all on line ${unique[0]}` : `at lines ${listNumbers(unique)}`;
  let text = `old_string matches ${count} places in ${filePath}, ${where}. Nothing was changed. Add neighbouring lines to old_string so it matches only one place, or set replace_all to true to change all of them.`;
  if (plan.step !== "exact") {
    text += ` (These matches ignore ${STEP_IGNORED[plan.step]}.)`;
  }
  return text;
}

function successMessage(
  filePath: string,
  plan: Extract<MatchPlan, { kind: "matched" }>,
  maxLineChars: number,
): string {
  const after = new FileText(plan.newText);
  const shownLines = displayLines(plan.newText);
  let delta = 0;
  const ranges: Array<[number, number]> = [];
  for (const edit of plan.edits) {
    const start = edit.start + delta;
    const end = start + edit.replacement.length;
    delta += edit.replacement.length - (edit.end - edit.start);
    const first = after.lineAt(start);
    const last = end > start ? after.lineAt(end - 1) : first;
    ranges.push([first, last]);
  }

  const out: string[] = [];
  const starts = [...new Set(ranges.map(([s]) => s + 1))];
  if (plan.edits.length === 1) out.push(`Edited ${filePath}.`);
  else {
    const where = starts.length === 1 ? `line ${starts[0]}` : `lines ${listNumbers(starts)}`;
    out.push(`Edited ${filePath}: replaced ${plan.edits.length} matches, now on ${where}.`);
  }
  const note = toleranceNote(plan);
  if (note !== null) out.push(note);

  if (shownLines.length === 0) {
    out.push("The file is now empty.");
    return out.join("\n\n");
  }
  // Context windows around each change, merged where they touch.
  const windows: Array<{ from: number; to: number; changes: number }> = [];
  for (const [first, last] of ranges) {
    const from = Math.max(0, Math.min(first, shownLines.length - 1) - SNIPPET_CONTEXT);
    const to = Math.min(shownLines.length - 1, last + SNIPPET_CONTEXT);
    const previous = windows[windows.length - 1];
    if (previous !== undefined && from <= previous.to + 1) {
      previous.to = Math.max(previous.to, to);
      previous.changes++;
    } else {
      windows.push({ from, to, changes: 1 });
    }
  }
  for (const w of windows.slice(0, MAX_SNIPPETS)) {
    out.push(snippet(shownLines, w.from, w.to, maxLineChars));
  }
  const hidden = windows.slice(MAX_SNIPPETS).reduce((n, w) => n + w.changes, 0);
  if (hidden > 0) out.push(`(${plural(hidden, "more change")} not shown.)`);
  return out.join("\n\n");
}

/** Lines `from`..`to` (0-based) of the new file, numbered as Read numbers them. */
function snippet(lines: string[], from: number, to: number, maxLineChars: number): string {
  const header =
    from === to
      ? `Line ${from + 1} after the edit:`
      : `Lines ${from + 1}-${to + 1} after the edit:`;
  if (to - from + 1 <= 60) {
    return `${header}\n${formatNumberedLines(lines.slice(from, to + 1), from + 1, maxLineChars).text}`;
  }
  // A long change: its start and end are enough to check it landed where intended.
  const head = formatNumberedLines(lines.slice(from, from + 30), from + 1, maxLineChars).text;
  const tail = formatNumberedLines(lines.slice(to - 9, to + 1), to - 8, maxLineChars).text;
  const skipped = to - 9 - (from + 30);
  return `${header}\n${head}\n[… ${plural(skipped, "line")} not shown …]\n${tail}`;
}

function toleranceNote(plan: Extract<MatchPlan, { kind: "matched" }>): string | null {
  const notes: string[] = [];
  if (plan.preprocess === "line-numbers") {
    notes.push(
      `Note: old_string included line-number prefixes copied from Read output (like "12${LINE_NUMBER_SEPARATOR}"). They were removed before matching; they are never part of the file.`,
    );
  } else if (plan.preprocess === "escapes") {
    notes.push(
      "Note: old_string contained the two characters \\n (or \\t) where the file has a real line break (or tab). They were read as escapes. Send real line breaks and tabs next time.",
    );
  }
  const ignored = describeDifferences(plan.step, plan.differences);
  if (ignored.length > 0) {
    notes.push(
      `Note: old_string did not match the file exactly; it matched after ignoring ${joinWords(ignored)}. The change was applied to the file's actual text, and new_string was adjusted to the file's style. Check the result below, and copy text exactly next time.`,
    );
  }
  if (!plan.differences.indentationConsistent) {
    notes.push(
      "Warning: the lines of old_string were not indented consistently with the file, so the indentation of new lines is a best guess. Check it below.",
    );
  }
  return notes.length > 0 ? notes.join("\n") : null;
}

function describeDifferences(step: MatchStep, d: Differences): string[] {
  if (step === "exact") return [];
  const out: string[] = [];
  if (d.indentation) {
    const file = describeIndentStyle(d.fileIndent);
    const model = describeIndentStyle(d.modelIndent);
    const sameStyle =
      d.fileIndent !== null &&
      d.modelIndent !== null &&
      d.fileIndent.kind === d.modelIndent.kind &&
      d.fileIndent.unit === d.modelIndent.unit;
    out.push(
      sameStyle || d.modelIndent === null
        ? "differences in indentation depth"
        : `differences in indentation (the file uses ${file}; old_string used ${model})`,
    );
  }
  if (d.trailingWhitespace) out.push("whitespace at the ends of lines");
  if (d.lookAlikes.length > 0) {
    const chars = d.lookAlikes.slice(0, 4).map(describeLookAlike).join(", ");
    out.push(`look-alike characters (the file has ${chars} where old_string has plain ASCII)`);
  }
  if (d.innerWhitespace) out.push("differences in spacing inside lines");
  if (d.missingFinalNewline) {
    out.push("the line break at the end of old_string (the file does not end with one)");
  }
  return out;
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
