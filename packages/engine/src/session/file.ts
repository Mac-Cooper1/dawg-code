/**
 * Reading a session file.
 *
 * A record counts as written once its line ends in "\n". The writer emits each record and its
 * newline in one append, so bytes after the last newline are a write that was cut short (a crash
 * or a full disk). They are ignored here and cut off by the next writer before it appends.
 *
 * A complete line that is not a valid record is different: our writer cannot produce one, so the
 * file was damaged by something else. By default reading then fails loudly, naming the line,
 * because skipping a record would hand the model a history it never saw (a tool call without its
 * result, a missing compaction) and the session would carry on from a quietly wrong state. Callers
 * that only want to show or salvage what is there (listing, export of a damaged file) can ask for
 * `onCorrupt: "skip"` and get the problems back instead.
 */
import { open } from "node:fs/promises";
import { SessionStoreError } from "./errors.ts";
import { isErrno } from "./paths.ts";
import { SESSION_FORMAT_VERSION, type SessionRecord, SessionRecordSchema } from "./records.ts";

export interface ReadOptions {
  /** What to do with a complete line that is not a valid record. Default "throw". */
  onCorrupt?: "throw" | "skip";
}

export interface ReadProblem {
  /** 1-based line number. */
  line: number;
  reason: string;
}

export interface FileContents {
  records: SessionRecord[];
  /** Length of the file up to and including its last newline: where the next append belongs. */
  committedBytes: number;
  /** Bytes after the last newline, ignored. Non-zero after a write was cut short. */
  tornBytes: number;
  /** Lines skipped with `onCorrupt: "skip"`. Always empty in "throw" mode. */
  problems: ReadProblem[];
}

const NEWLINE = 0x0a;

export async function readSessionFile(
  file: string,
  options: ReadOptions = {},
): Promise<FileContents> {
  let buffer: Buffer;
  try {
    const handle = await open(file, "r");
    try {
      buffer = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new SessionStoreError("not-found", `No session file at ${file}.`, {
        file,
        cause: error,
      });
    }
    throw error;
  }
  return parseSessionBuffer(buffer, file, options);
}

export function parseSessionBuffer(
  buffer: Buffer,
  file: string,
  options: ReadOptions = {},
): FileContents {
  const skip = options.onCorrupt === "skip";
  const records: SessionRecord[] = [];
  const problems: ReadProblem[] = [];

  const lastNewline = buffer.lastIndexOf(NEWLINE);
  const committedBytes = lastNewline + 1;
  const tornBytes = buffer.length - committedBytes;

  let start = 0;
  let lineNumber = 0;
  let previousSeq = -1;
  while (start < committedBytes) {
    const end = buffer.indexOf(NEWLINE, start);
    lineNumber += 1;
    const lineStart = start;
    start = end + 1;
    if (end === lineStart) continue; // A blank line carries nothing; tolerate it.

    const fail = (reason: string): void => {
      if (!skip || records.length === 0) {
        throw new SessionStoreError(
          "corrupt",
          `Session file ${file} is damaged at line ${lineNumber}: ${reason}`,
          { file, line: lineNumber },
        );
      }
      problems.push({ line: lineNumber, reason });
    };

    let raw: unknown;
    try {
      raw = JSON.parse(buffer.toString("utf8", lineStart, end));
    } catch (error) {
      fail(`not JSON (${(error as Error).message})`);
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail("not a JSON object");
      continue;
    }
    const version = (raw as { v?: unknown }).v;
    if (typeof version === "number" && version > SESSION_FORMAT_VERSION) {
      // Never skipped: a newer record may change what the older ones mean.
      throw new SessionStoreError(
        "unsupported-version",
        `Session file ${file} was written by a newer version (format ${version}; this build reads up to ${SESSION_FORMAT_VERSION}).`,
        { file, line: lineNumber },
      );
    }
    const parsed = SessionRecordSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
      fail(`not a valid record${where}: ${issue?.message ?? "invalid"}`);
      continue;
    }
    const seq = parsed.data.seq;
    if (records.length === 0 && parsed.data.type !== "meta") {
      fail("the first record is not a meta record");
      continue;
    }
    if (records.length > 0 && parsed.data.type === "meta") {
      fail("a second meta record");
      continue;
    }
    if (records.length > 0 && (skip ? seq <= previousSeq : seq !== previousSeq + 1)) {
      fail(`sequence number ${seq} after ${previousSeq}`);
      continue;
    }
    previousSeq = seq;
    // Keep the parsed JSON itself rather than zod's output: zod rebuilds objects in schema key
    // order, and the history must come back exactly as it was written.
    records.push(raw as SessionRecord);
  }

  if (records.length === 0) {
    throw new SessionStoreError("empty", `Session file ${file} holds no complete record.`, {
      file,
    });
  }
  return { records, committedBytes, tornBytes, problems };
}
