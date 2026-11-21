/**
 * Streams a file once to find what `Read` needs: its encoding, whether it is binary, its line
 * count, its hash, and the text of a range of lines. Memory stays bounded by the range asked for,
 * so a range of a very large file costs no more than a small file.
 */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { cutLineFromPrefix } from "./format.ts";
import {
  BINARY_SNIFF_BYTES,
  decoderLabel,
  type EncodingInfo,
  looksBinary,
  REPLACEMENT_CHAR,
  sniffEncoding,
  type TextEncodingName,
} from "./text.ts";

export interface ScanOptions {
  /** First line to collect (1-based). */
  startLine: number;
  /** Lines to collect at most. 0 collects none, which still counts lines and hashes the file. */
  maxLines: number;
  /** Longer lines are cut, with a marker giving their full length. */
  maxLineChars: number;
  /** Collection stops before the shown text (with line-number prefixes) would pass this size. */
  maxOutputChars: number;
  signal?: AbortSignal;
  chunkBytes?: number;
}

export type ScanResult =
  | {
      kind: "binary";
      size: number;
      mtimeMs: number;
      /** The first bytes of the file, for recognising images. */
      head: Uint8Array;
    }
  | {
      kind: "text";
      size: number;
      mtimeMs: number;
      hash: string;
      encoding: TextEncodingName;
      bom: boolean;
      /** Some bytes could not be decoded and appear as U+FFFD. */
      invalid: boolean;
      totalLines: number;
      startLine: number;
      /** The collected lines, already cut to `maxLineChars`. */
      lines: string[];
      /** How many of the collected lines were cut. */
      cut: number;
      /** Collection stopped early because of `maxOutputChars`. */
      stoppedForSize: boolean;
    };

export async function scanTextFile(filePath: string, options: ScanOptions): Promise<ScanResult> {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    const chunkBytes = Math.max(BINARY_SNIFF_BYTES, options.chunkBytes ?? 256 * 1024);
    // Even, so UTF-16 code units never straddle two reads.
    const buffer = Buffer.allocUnsafe(chunkBytes + (chunkBytes % 2));
    const hash = createHash("sha256");
    const collector = new LineCollector(options);
    let info: EncodingInfo | null = null;
    let decoder: TextDecoder | null = null;
    let decodedReplacements = 0;
    let rawReplacements = 0;
    let oddLength = false;
    let tail = Buffer.alloc(0);
    let offset = 0;

    for (;;) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (info === null) {
        info = sniffEncoding(chunk);
        if (looksBinary(chunk, info)) {
          return {
            kind: "binary",
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            head: Buffer.from(chunk.subarray(0, 64 * 1024)),
          };
        }
        decoder = new TextDecoder(decoderLabel(info.encoding), { ignoreBOM: true });
      }
      hash.update(chunk);
      const body = offset === 0 ? chunk.subarray(info.bomLength) : chunk;
      if (info.encoding === "utf8") {
        // Search across the boundary with the previous read's last two bytes.
        const joined = tail.length > 0 ? Buffer.concat([tail, body]) : body;
        rawReplacements += countSequence(joined, [0xef, 0xbf, 0xbd], 1);
        tail = Buffer.from(body.subarray(Math.max(0, body.length - 2)));
      } else {
        const pair = info.encoding === "utf16le" ? [0xfd, 0xff] : [0xff, 0xfd];
        rawReplacements += countSequence(body, pair, 2);
        if (body.length % 2 === 1) oddLength = true;
      }
      const text = (decoder as TextDecoder).decode(body, { stream: true });
      decodedReplacements += countReplacement(text);
      collector.push(text);
      offset += bytesRead;
    }

    const encoding = info ?? sniffEncoding(new Uint8Array(0));
    if (decoder !== null) {
      const rest = decoder.decode();
      decodedReplacements += countReplacement(rest);
      collector.push(rest);
    }
    collector.end();
    return {
      kind: "text",
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      hash: hash.digest("hex"),
      encoding: encoding.encoding,
      bom: encoding.bom,
      invalid: oddLength || decodedReplacements > rawReplacements,
      totalLines: collector.lineCount,
      startLine: options.startLine,
      lines: collector.lines,
      cut: collector.cut,
      stoppedForSize: collector.stoppedForSize,
    };
  } finally {
    await handle.close();
  }
}

class LineCollector {
  readonly lines: string[] = [];
  lineCount = 0;
  cut = 0;
  stoppedForSize = false;

  readonly #options: ScanOptions;
  readonly #endLine: number;
  #kept: string[] = [];
  #keptLength = 0;
  #lineLength = 0;
  #lastCode = -1;
  #outputChars = 0;

  constructor(options: ScanOptions) {
    this.#options = options;
    this.#endLine = options.startLine + options.maxLines - 1;
  }

  push(text: string): void {
    let from = 0;
    for (;;) {
      const nl = text.indexOf("\n", from);
      const end = nl === -1 ? text.length : nl;
      if (end > from) this.#append(text, from, end);
      if (nl === -1) return;
      this.#finish(true);
      from = nl + 1;
    }
  }

  end(): void {
    // A last line without a terminator still counts; an empty one after a final newline does not.
    if (this.#lineLength > 0) this.#finish(false);
  }

  #wanted(lineNumber: number): boolean {
    return (
      !this.stoppedForSize && lineNumber >= this.#options.startLine && lineNumber <= this.#endLine
    );
  }

  #append(text: string, from: number, end: number): void {
    this.#lineLength += end - from;
    this.#lastCode = text.charCodeAt(end - 1);
    const room = this.#options.maxLineChars - this.#keptLength;
    if (room > 0 && this.#wanted(this.lineCount + 1)) {
      const piece = text.slice(from, Math.min(end, from + room));
      this.#kept.push(piece);
      this.#keptLength += piece.length;
    }
  }

  #finish(terminated: boolean): void {
    this.lineCount++;
    if (this.#wanted(this.lineCount)) {
      let length = this.#lineLength;
      let text = this.#kept.join("");
      if (terminated && this.#lastCode === 13) {
        length--;
        if (text.length > length) text = text.slice(0, length);
      }
      const shown = length > this.#options.maxLineChars ? cutLineFromPrefix(text, length) : text;
      if (shown !== text) this.cut++;
      // Allow for the line-number prefix and the newline.
      const cost = shown.length + String(this.lineCount).length + 2;
      if (this.lines.length > 0 && this.#outputChars + cost > this.#options.maxOutputChars) {
        this.stoppedForSize = true;
        if (shown !== text) this.cut--;
      } else {
        this.#outputChars += cost;
        this.lines.push(shown);
      }
    }
    this.#kept = [];
    this.#keptLength = 0;
    this.#lineLength = 0;
    this.#lastCode = -1;
  }
}

/** Counts occurrences of `sequence` that start at a multiple of `alignment`. */
function countSequence(bytes: Uint8Array, sequence: number[], alignment: number): number {
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const needle = Buffer.from(sequence);
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    if (i % alignment === 0) n++;
    i = haystack.indexOf(needle, i + 1);
  }
  return n;
}

function countReplacement(text: string): number {
  let n = 0;
  let i = text.indexOf(REPLACEMENT_CHAR);
  while (i !== -1) {
    n++;
    i = text.indexOf(REPLACEMENT_CHAR, i + 1);
  }
  return n;
}
