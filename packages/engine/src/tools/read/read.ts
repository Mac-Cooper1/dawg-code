import type { Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FileDisplay } from "@dawg/protocol";
import type { ToolContext, ToolDefinition, ToolOutput } from "../../contracts/index.ts";
import {
  binaryHint,
  binaryKindFor,
  describeFsError,
  detectImage,
  fileTracker,
  formatBytes,
  formatNumberedLines,
  hashBytes,
  IMAGE_EXTENSIONS,
  plural,
  probePath,
  REPLACEMENT_CHAR,
  resolveToolPath,
  scanTextFile,
  shellQuote,
  unsupportedKindFor,
} from "../files/index.ts";
import { directoryMessage, errorResult, missingFileMessage, textParts } from "../files/messages.ts";

export interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

/** Images larger than this are refused rather than sent to the model whole. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const READ_DESCRIPTION = `Read a file and return its text with line numbers.

- file_path: an absolute path, or a path relative to the working directory.
- Each line of the result starts with its line number and "→". That prefix is not part of the file: leave it out of Edit's old_string and Write's content.
- Long files are returned one part at a time, and the result says which lines you got and the offset to continue from. To read a chosen part, give offset (the first line, counting from 1) and limit (how many lines).
- Read a file before you change it with Edit or Write.
- PNG, JPEG, GIF and WebP images are shown as images when the model can see images.
- Read works on files only. To list a directory, use Glob or run ls.`;

export const readTool: ToolDefinition<ReadInput> = {
  name: "Read",
  description: READ_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The file to read: an absolute path, or relative to the working directory.",
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "The line to start from, counting from 1. Leave it out to start at the top.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        description: "How many lines to read. Leave it out to read up to the default amount.",
      },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
  readOnly: true,
  permission(input, ctx) {
    return { kind: "read", paths: [resolveToolPath(input.file_path, ctx.cwd)] };
  },
  execute: executeRead,
};

async function executeRead(input: ReadInput, ctx: ToolContext): Promise<ToolOutput> {
  if (input.file_path.trim() === "") {
    return errorResult("file_path is empty. Give the path of the file to read.");
  }
  const filePath = resolveToolPath(input.file_path, ctx.cwd);
  try {
    return await readPath(filePath, input, ctx);
  } catch (error) {
    ctx.signal.throwIfAborted();
    const message = describeFsError(error, "read", filePath);
    if (message !== null) return errorResult(message);
    throw error;
  }
}

async function readPath(filePath: string, input: ReadInput, ctx: ToolContext): Promise<ToolOutput> {
  const probe = await probePath(filePath);
  if (probe.kind === "missing") {
    return errorResult(await missingFileMessage(filePath, input.file_path, ctx.workingDirectories));
  }
  if (probe.kind === "directory") return errorResult(await directoryMessage(filePath, "Read"));
  if (probe.kind === "special") {
    return errorResult(
      `${filePath} is not a regular file (it is a pipe, socket or device), so Read cannot show it.`,
    );
  }

  const unsupported = unsupportedKindFor(filePath);
  if (unsupported === "pdf") {
    return errorResult(
      `Reading PDF files is not supported yet. If poppler is installed, \`pdftotext ${shellQuote(filePath)} -\` prints the text.`,
    );
  }
  if (unsupported === "notebook") {
    return errorResult(
      `Reading Jupyter notebooks (.ipynb) is not supported yet. A notebook is JSON, so a shell command such as \`jq '.cells' ${shellQuote(filePath)}\` can show its cells.`,
    );
  }
  const binary = binaryKindFor(filePath);
  if (binary !== null) {
    return errorResult(
      `${filePath} is ${binary.label}, which Read cannot show as text. To inspect it, ${binaryHint(binary, filePath)}.`,
    );
  }
  if (IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    const image = await readImage(filePath, probe.stats, ctx);
    if (image !== null) return image;
  }
  return readText(filePath, probe.stats, input, ctx);
}

async function readText(
  filePath: string,
  stats: Stats,
  input: ReadInput,
  ctx: ToolContext,
): Promise<ToolOutput> {
  const { limits } = ctx;
  const ranged = input.offset !== undefined || input.limit !== undefined;
  const startLine = Math.max(1, Math.floor(input.offset ?? 1));
  const tooLarge = !ranged && stats.size > limits.readMaxBytes;
  const scan = await scanTextFile(filePath, {
    startLine,
    maxLines: tooLarge ? 0 : Math.max(1, Math.floor(input.limit ?? limits.readDefaultLines)),
    // Lines are cut here once; formatting below must not cut them again.
    maxLineChars: limits.readMaxLineChars,
    maxOutputChars: limits.readMaxBytes,
    signal: ctx.signal,
  });

  if (scan.kind === "binary") {
    if (detectImage(scan.head) !== null) {
      const image = await readImage(filePath, stats, ctx);
      if (image !== null) return image;
    }
    return errorResult(
      `${filePath} looks like a binary file (it contains NUL bytes), so Read will not show it. To inspect it, run \`file ${shellQuote(filePath)}\` or \`xxd ${shellQuote(filePath)} | head\`.`,
    );
  }

  if (tooLarge) {
    return errorResult(
      `${filePath} is too large to read at once: ${formatBytes(scan.size)}, ${plural(scan.totalLines, "line")} (the limit for reading a whole file is ${formatBytes(limits.readMaxBytes)}). Read it in parts with offset and limit, for example offset 1 and limit ${limits.readDefaultLines}, or use Grep to find the lines you need.`,
    );
  }

  const version = {
    hash: scan.hash,
    size: scan.size,
    mtimeMs: scan.mtimeMs,
    totalLines: scan.totalLines,
  };
  const tracker = fileTracker(ctx.state);

  if (scan.totalLines === 0) {
    tracker.recordRead(filePath, version, null);
    return {
      content: textParts(`The file ${filePath} exists but is empty.`),
      display: fileDisplay(filePath, 1, 0, 0, false),
      touched: { read: [filePath] },
    };
  }
  if (startLine > scan.totalLines) {
    return errorResult(
      `offset ${startLine} is past the end of ${filePath}, which has ${plural(scan.totalLines, "line")}. Use an offset from 1 to ${scan.totalLines}.`,
    );
  }

  const lastLine = startLine + scan.lines.length - 1;
  tracker.recordRead(filePath, version, { start: startLine, end: lastLine });

  const body = formatNumberedLines(scan.lines, startLine, Number.POSITIVE_INFINITY).text;
  const notes: string[] = [];
  if (lastLine < scan.totalLines) {
    const why = scan.stoppedForSize ? "; the rest did not fit in one result" : "";
    notes.push(
      `[Lines ${startLine}-${lastLine} of ${scan.totalLines} shown${why}. To continue, Read with offset ${lastLine + 1}.]`,
    );
  } else if (startLine > 1) {
    notes.push(
      `[Lines ${startLine}-${lastLine} of ${scan.totalLines} shown, to the end of the file.]`,
    );
  }
  if (scan.cut > 0) {
    notes.push(
      `[${plural(scan.cut, "line")} longer than ${limits.readMaxLineChars} characters ${scan.cut === 1 ? "was" : "were"} cut.]`,
    );
  }
  if (scan.invalid) {
    notes.push(
      `[This file is not valid UTF-8: bytes that could not be decoded are shown as ${REPLACEMENT_CHAR}. Edit cannot change it; use a shell command that keeps its encoding.]`,
    );
  }
  const text = notes.length > 0 ? `${body}\n\n${notes.join("\n")}` : body;
  const truncated = (!ranged && lastLine < scan.totalLines) || scan.stoppedForSize || scan.cut > 0;
  return {
    content: textParts(text),
    display: fileDisplay(filePath, startLine, scan.lines.length, scan.totalLines, truncated),
    touched: { read: [filePath] },
  };
}

/** Returns null when the file is not an image after all, so it is read as text instead. */
async function readImage(
  filePath: string,
  stats: Stats,
  ctx: ToolContext,
): Promise<ToolOutput | null> {
  if (stats.size > MAX_IMAGE_BYTES) {
    return errorResult(
      `${filePath} is too large to read as an image: ${formatBytes(stats.size)} (the limit is ${formatBytes(MAX_IMAGE_BYTES)}). Make a smaller copy first, for example \`sips -Z 2000 ${shellQuote(filePath)} --out /tmp/small.png\`, and read that.`,
    );
  }
  const bytes = await readFile(filePath, { signal: ctx.signal });
  const info = detectImage(bytes);
  if (info === null) return null;
  fileTracker(ctx.state).recordRead(
    filePath,
    { hash: hashBytes(bytes), size: bytes.length, mtimeMs: stats.mtimeMs, totalLines: 0 },
    null,
  );
  const size = info.width !== null && info.height !== null ? `${info.width}x${info.height}, ` : "";
  const facts = `${info.format}, ${size}${formatBytes(bytes.length)}`;
  const display = fileDisplay(filePath, 1, 0, null, false);
  if (!ctx.vision) {
    return {
      content: textParts(
        `${filePath} is an image (${facts}). The current model cannot see images, so its contents are not shown.`,
      ),
      display,
      touched: { read: [filePath] },
    };
  }
  return {
    content: [
      { type: "text", text: `Image ${filePath} (${facts}):` },
      { type: "image", mediaType: info.mediaType, data: bytes.toString("base64") },
    ],
    display,
    touched: { read: [filePath] },
  };
}

function fileDisplay(
  filePath: string,
  startLine: number,
  lineCount: number,
  totalLines: number | null,
  truncated: boolean,
): FileDisplay {
  return { kind: "file", filePath, startLine, lineCount, totalLines, truncated };
}
