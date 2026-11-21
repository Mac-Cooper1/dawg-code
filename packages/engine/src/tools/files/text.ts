/**
 * Text decoding, encoding and line handling shared by the file tools.
 *
 * Files are decoded once, edited as strings and encoded back the way they came: same encoding,
 * same byte order mark. Lines end with "\n" or "\r\n"; a lone "\r" is ordinary content, which
 * keeps our line numbers in step with grep, sed and ripgrep.
 */
import { isUtf8 } from "node:buffer";

export type TextEncodingName = "utf8" | "utf16le" | "utf16be";

export interface EncodingInfo {
  encoding: TextEncodingName;
  /** The file starts with a byte order mark. */
  bom: boolean;
  /** Length of the byte order mark in bytes (0 when there is none). */
  bomLength: number;
}

export type DecodeResult =
  | {
      kind: "text";
      /** The decoded text, without the byte order mark. */
      text: string;
      encoding: TextEncodingName;
      bom: boolean;
      /** Some bytes could not be decoded and were replaced with U+FFFD. */
      invalid: boolean;
    }
  | { kind: "binary" };

/** How many leading bytes are inspected for NUL bytes, as git does. */
export const BINARY_SNIFF_BYTES = 8000;

// Built from code points: the formatter would turn escapes into literal, invisible characters.
export const BOM = String.fromCharCode(0xfeff);
/** What a decoder puts in place of bytes it cannot decode. */
export const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

export function sniffEncoding(head: Uint8Array): EncodingInfo {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    return { encoding: "utf8", bom: true, bomLength: 3 };
  }
  if (head[0] === 0xff && head[1] === 0xfe) return { encoding: "utf16le", bom: true, bomLength: 2 };
  if (head[0] === 0xfe && head[1] === 0xff) return { encoding: "utf16be", bom: true, bomLength: 2 };
  return { encoding: "utf8", bom: false, bomLength: 0 };
}

/** A UTF-8 file containing NUL bytes near its start is treated as binary. */
export function looksBinary(head: Uint8Array, info: EncodingInfo): boolean {
  if (info.encoding !== "utf8") return false;
  const end = Math.min(head.length, BINARY_SNIFF_BYTES);
  for (let i = info.bomLength; i < end; i++) {
    if (head[i] === 0) return true;
  }
  return false;
}

export function decoderLabel(encoding: TextEncodingName): string {
  return encoding === "utf8" ? "utf-8" : encoding === "utf16le" ? "utf-16le" : "utf-16be";
}

export function decodeText(bytes: Uint8Array): DecodeResult {
  const info = sniffEncoding(bytes);
  if (looksBinary(bytes, info)) return { kind: "binary" };
  const body = bytes.subarray(info.bomLength);
  const decoder = new TextDecoder(decoderLabel(info.encoding), { ignoreBOM: true });
  const text = decoder.decode(body);
  let invalid: boolean;
  if (info.encoding === "utf8") {
    invalid = !isUtf8(body);
  } else {
    // UTF-16 has no cheap validity check; an odd byte count or a lone surrogate shows up as U+FFFD.
    invalid =
      body.length % 2 === 1 ||
      countChar(text, REPLACEMENT_CHAR) > countUtf16Replacement(body, info);
  }
  return { kind: "text", text, encoding: info.encoding, bom: info.bom, invalid };
}

function countUtf16Replacement(body: Uint8Array, info: EncodingInfo): number {
  const [a, b] = info.encoding === "utf16le" ? [0xfd, 0xff] : [0xff, 0xfd];
  let n = 0;
  for (let i = 0; i + 1 < body.length; i += 2) {
    if (body[i] === a && body[i + 1] === b) n++;
  }
  return n;
}

export function countChar(text: string, ch: string): number {
  let n = 0;
  let i = text.indexOf(ch);
  while (i !== -1) {
    n++;
    i = text.indexOf(ch, i + 1);
  }
  return n;
}

export function encodeText(text: string, encoding: TextEncodingName, bom: boolean): Uint8Array {
  if (encoding === "utf8") {
    const body = Buffer.from(text, "utf8");
    return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
  }
  const body = Buffer.from(text, "utf16le");
  if (encoding === "utf16be") body.swap16();
  if (!bom) return body;
  const mark = encoding === "utf16le" ? [0xff, 0xfe] : [0xfe, 0xff];
  return Buffer.concat([Buffer.from(mark), body]);
}

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

export type LineEnding = "\n" | "\r\n";

export interface LineEndingStats {
  lf: number;
  crlf: number;
  /** The more common ending; "\n" when there are none or it is a tie. */
  dominant: LineEnding;
}

export function lineEndingStats(text: string): LineEndingStats {
  let lf = 0;
  let crlf = 0;
  let i = text.indexOf("\n");
  while (i !== -1) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
    i = text.indexOf("\n", i + 1);
  }
  return { lf, crlf, dominant: crlf > lf ? "\r\n" : "\n" };
}

/** Turns every bare "\n" into `eol`. Existing "\r\n" pairs are left alone. */
export function applyLineEnding(text: string, eol: LineEnding): string {
  if (eol === "\n") return text;
  return text.replace(/(?<!\r)\n/g, "\r\n");
}

export interface SplitLines {
  /** Line contents without their terminators. A text ending in a newline has a final "". */
  lines: string[];
  /** The terminator after each line: "\n", "\r\n", or "" for the last. */
  terminators: string[];
  /** Offset in the text where each line starts. */
  offsets: number[];
}

export function splitLines(text: string): SplitLines {
  const lines: string[] = [];
  const terminators: string[] = [];
  const offsets: number[] = [];
  let start = 0;
  let i = text.indexOf("\n");
  while (i !== -1) {
    const crlf = i > start && text.charCodeAt(i - 1) === 13;
    offsets.push(start);
    lines.push(text.slice(start, crlf ? i - 1 : i));
    terminators.push(crlf ? "\r\n" : "\n");
    start = i + 1;
    i = text.indexOf("\n", start);
  }
  offsets.push(start);
  lines.push(text.slice(start));
  terminators.push("");
  return { lines, terminators, offsets };
}

/** Splits text the model sent (which may use either ending) into line contents. */
export function splitModelLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/**
 * The number of lines as an editor counts them: "" has 0, "a" and "a\n" have 1, "a\n\n" has 2.
 */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = countChar(text, "\n");
  if (!text.endsWith("\n")) n++;
  return n;
}

/** The lines an editor would show: like `splitLines` without the empty entry after a final newline. */
export function displayLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n")) lines.pop();
  return lines;
}
