import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolDefinition, ToolOutput } from "../../contracts/index.ts";
import {
  applyLineEnding,
  atomicWriteFile,
  BOM,
  buildDiffDisplay,
  countLines,
  decodeText,
  describeFsError,
  describeRanges,
  encodeText,
  errorCode,
  fileTracker,
  hashBytes,
  LINE_NUMBER_SEPARATOR,
  lineEndingStats,
  plural,
  probePath,
  REPLACEMENT_CHAR,
  resolveToolPath,
  stripLineNumberPrefixes,
  type TextEncodingName,
} from "../files/index.ts";
import { errorResult, textParts } from "../files/messages.ts";

export interface WriteInput {
  file_path: string;
  content: string;
}

export const WRITE_DESCRIPTION = `Create a file, or replace everything in an existing file.

- file_path: an absolute path, or a path relative to the working directory. Missing parent directories are created.
- content: the complete text of the file.
- To overwrite a file that already exists, you must first Read all of it in this session, and it must not have changed since.
- To change part of an existing file, use Edit instead.
- An existing file keeps its line endings (LF or CRLF), byte order mark, encoding and permissions.`;

export const writeTool: ToolDefinition<WriteInput> = {
  name: "Write",
  description: WRITE_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "The file to write: an absolute path, or relative to the working directory.",
      },
      content: {
        type: "string",
        description: "The complete new contents of the file.",
      },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
  readOnly: false,
  permission(input, ctx) {
    return { kind: "edit", paths: [resolveToolPath(input.file_path, ctx.cwd)] };
  },
  execute: executeWrite,
};

async function executeWrite(input: WriteInput, ctx: ToolContext): Promise<ToolOutput> {
  if (input.file_path.trim() === "") {
    return errorResult("file_path is empty. Give the path of the file to write.");
  }
  const filePath = resolveToolPath(input.file_path, ctx.cwd);
  try {
    return await writePath(filePath, input, ctx);
  } catch (error) {
    ctx.signal.throwIfAborted();
    const message = describeFsError(error, "write", filePath);
    if (message !== null) return errorResult(message);
    throw error;
  }
}

async function writePath(
  filePath: string,
  input: WriteInput,
  ctx: ToolContext,
): Promise<ToolOutput> {
  const probe = await probePath(filePath);
  if (probe.kind === "directory") {
    return errorResult(`${filePath} is a directory. Give the path of a file to write.`);
  }
  if (probe.kind === "special") {
    return errorResult(
      `${filePath} is not a regular file (it is a pipe, socket or device), so Write will not replace it.`,
    );
  }
  if (stripLineNumberPrefixes(input.content, [LINE_NUMBER_SEPARATOR]) !== null) {
    return errorResult(
      `Nothing was written: every line of content starts with a line number and "${LINE_NUMBER_SEPARATOR}", copied from Read output. Those prefixes are not part of the file. Remove them and write again.`,
    );
  }

  const tracker = fileTracker(ctx.state);
  let before: string | null = null;
  let oldBytes: Uint8Array | null = null;
  let encoding: TextEncodingName = "utf8";
  let bom = false;
  let mode: number | undefined;
  let text = input.content;
  const kept: string[] = [];

  if (probe.kind === "file") {
    oldBytes = await readFile(filePath, { signal: ctx.signal });
    const freshness = tracker.freshness(filePath, hashBytes(oldBytes));
    if (freshness.status === "unread") {
      return errorResult(
        `${filePath} already exists, and you have not read it in this session. Read it first, so you do not throw away content you have not seen, then write it again. To change only part of it, use Edit.`,
      );
    }
    if (freshness.status === "stale") {
      return errorResult(
        `${filePath} has changed on disk since you last read it. Read it again, then write your new version based on its current contents.`,
      );
    }
    if (!freshness.record.whole) {
      const { ranges, totalLines } = freshness.record;
      const seen =
        ranges.length > 0
          ? `You have read only ${describeRanges(ranges)} of ${filePath}, which has ${plural(totalLines, "line")}.`
          : `You have not seen all ${plural(totalLines, "line")} of ${filePath} as it is now; you only edited part of it.`;
      const fix =
        ranges.length > 0 ? "Read the rest of the file first" : "Read the whole file first";
      return errorResult(
        `${seen} Writing would replace lines you have not seen. ${fix}, or use Edit to change part of it.`,
      );
    }
    mode = probe.stats.mode & 0o7777;
    const decoded = decodeText(oldBytes);
    if (decoded.kind === "binary") {
      before = "";
    } else {
      if (decoded.invalid && input.content.includes(REPLACEMENT_CHAR)) {
        return errorResult(
          `Nothing was written: content contains the character ${REPLACEMENT_CHAR} (U+FFFD), which Read shows in place of bytes it could not decode. ${filePath} is not valid UTF-8, so writing this would destroy those bytes for good. Change the file with a shell command that keeps its encoding instead.`,
        );
      }
      before = decoded.text;
      encoding = decoded.encoding;
      bom = decoded.bom;
      if (lineEndingStats(before).dominant === "\r\n") {
        const converted = applyLineEnding(text, "\r\n");
        if (converted !== text) kept.push("CRLF line endings");
        text = converted;
      }
      if (bom) {
        if (text.startsWith(BOM)) text = text.slice(1);
        kept.push("byte order mark");
      }
      if (encoding !== "utf8")
        kept.push(encoding === "utf16le" ? "UTF-16LE encoding" : "UTF-16BE encoding");
    }
  }

  const bytes = encodeText(text, encoding, bom);
  const totalLines = countLines(text);
  if (oldBytes !== null && Buffer.compare(Buffer.from(bytes), Buffer.from(oldBytes)) === 0) {
    tracker.recordWrite(
      filePath,
      {
        hash: hashBytes(bytes),
        size: bytes.length,
        mtimeMs: probe.kind === "file" ? probe.stats.mtimeMs : 0,
        totalLines,
      },
      "write",
      true,
    );
    return {
      content: textParts(`No change: ${filePath} already has exactly this content.`),
      display: buildDiffDisplay(filePath, before, text),
    };
  }

  if (probe.kind === "missing") {
    const parent = path.dirname(filePath);
    try {
      await mkdir(parent, { recursive: true });
    } catch (error) {
      const code = errorCode(error);
      if (code === "EEXIST" || code === "ENOTDIR") {
        return errorResult(
          `Cannot create ${filePath}: part of its directory path is a file, not a directory.`,
        );
      }
      throw error;
    }
  }
  ctx.signal.throwIfAborted();
  await atomicWriteFile(filePath, bytes, { mode });
  const after = await stat(filePath);
  tracker.recordWrite(
    filePath,
    { hash: hashBytes(bytes), size: bytes.length, mtimeMs: after.mtimeMs, totalLines },
    "write",
    true,
  );

  const created = probe.kind === "missing";
  let message = created
    ? `Created ${filePath} (${plural(totalLines, "line")}).`
    : `Wrote ${filePath} (${plural(totalLines, "line")}), replacing its previous contents.`;
  if (kept.length > 0) message += ` Kept the file's ${joinWords(kept)}.`;
  return {
    content: textParts(message),
    display: buildDiffDisplay(filePath, before, text),
    touched: { written: [filePath] },
  };
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
