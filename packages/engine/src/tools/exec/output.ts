/**
 * Collects command output with bounded memory, however much a command prints.
 *
 * Up to `maxChars` the text is kept whole in memory. Past that only the head and the tail are
 * kept, and the full text goes to a file instead, written with back-pressure so a slow disk
 * pauses the command rather than growing a buffer.
 */
import { createWriteStream, type WriteStream } from "node:fs";
import { collapseCarriageReturns } from "./terminal.ts";

export interface OutputCollectorOptions {
  /** Characters kept whole in memory; beyond this the output is cut to head and tail. */
  maxChars: number;
  /** Most bytes written to the output file. Later output is counted but not saved. */
  fileCapBytes: number;
  /**
   * Creates the output file holding `initial` and returns its absolute path. Called once, when
   * the output first passes `maxChars`. Without it, cut output is not saved anywhere.
   */
  createFile?: (initial: string) => Promise<string>;
  /** An existing file that receives all output from the start (background tasks). */
  filePath?: string;
  /** Total bytes after which `onLimit` is called, once. */
  limitBytes?: number;
  onLimit?: () => void;
  /** Flow control for the producer, so that writing to disk never piles up in memory. */
  pause?: () => void;
  resume?: () => void;
}

export interface CollectedOutput {
  /** For the model: everything, or the head, a marker and the tail. Carriage returns applied. */
  text: string;
  totalChars: number;
  totalBytes: number;
  truncated: boolean;
  /** The file holding the output, when there is one. */
  outputPath: string | null;
  /** True when the file stopped growing at its size cap. */
  fileTruncated: boolean;
  /** Set when the output file could not be written. */
  fileError: string | null;
}

const FILE_CAP_NOTE =
  "\n[Output past this point was not saved: the file reached its size limit.]\n";

type FileState = "none" | "creating" | "open" | "closed";

export class OutputCollector {
  private readonly options: OutputCollectorOptions;
  private readonly headChars: number;
  private readonly tail: TailBuffer;
  /** True while everything so far is still held in `chunks`. */
  private whole = true;
  private chunks: string[] = [];
  private bufferedChars = 0;
  private head = "";
  private totalChars = 0;
  private totalBytes = 0;
  private limitReached = false;

  private fileState: FileState = "none";
  private stream: WriteStream | null = null;
  private filePath: string | null = null;
  private fileReady: Promise<void> | null = null;
  private pending: string[] = [];
  private fileBytes = 0;
  private fileCapped = false;
  private fileError: string | null = null;
  private paused = false;

  constructor(options: OutputCollectorOptions) {
    this.options = options;
    this.headChars = Math.floor(options.maxChars / 2);
    this.tail = new TailBuffer(options.maxChars - this.headChars);
    if (options.filePath !== undefined) this.openStream(options.filePath);
  }

  get bytes(): number {
    return this.totalBytes;
  }

  /** The last characters received, for short status reports. */
  recentText(maxChars: number): string {
    const text = this.whole ? this.chunks.join("") : this.tail.value();
    return collapseCarriageReturns(text.slice(-maxChars));
  }

  push(text: string): void {
    if (!text) return;
    this.totalChars += text.length;
    this.totalBytes += Buffer.byteLength(text);
    if (this.whole) {
      this.chunks.push(text);
      this.bufferedChars += text.length;
      if (this.bufferedChars > this.options.maxChars) {
        const all = this.chunks.join("");
        this.chunks = [];
        this.bufferedChars = 0;
        this.whole = false;
        this.head = cutAtCodePoint(all, this.headChars);
        this.tail.push(all);
        if (this.fileState === "none") this.createFile(all);
        else this.writeToFile(text);
      } else {
        this.writeToFile(text);
      }
    } else {
      this.tail.push(text);
      this.writeToFile(text);
    }
    const limit = this.options.limitBytes;
    if (limit !== undefined && !this.limitReached && this.totalBytes > limit) {
      this.limitReached = true;
      this.options.onLimit?.();
    }
  }

  /** Waits for the file to be written and returns what was collected. */
  async finish(): Promise<CollectedOutput> {
    if (this.fileReady) await this.fileReady;
    if (this.stream) {
      const stream = this.stream;
      this.stream = null;
      this.fileState = "closed";
      await new Promise<void>((resolve) => {
        stream.once("error", () => resolve());
        stream.end(() => resolve());
      });
    }
    this.setPaused(false);
    let text: string;
    if (this.whole) {
      text = collapseCarriageReturns(this.chunks.join(""));
    } else {
      const tail = this.tail.value();
      const omitted = Math.max(0, this.totalChars - this.head.length - tail.length);
      text =
        `${collapseCarriageReturns(this.head)}\n\n` +
        `[... ${omitted.toLocaleString("en-US")} characters omitted ...]\n\n` +
        collapseCarriageReturns(tail);
    }
    return {
      text,
      totalChars: this.totalChars,
      totalBytes: this.totalBytes,
      truncated: !this.whole,
      outputPath: this.filePath,
      fileTruncated: this.fileCapped,
      fileError: this.fileError,
    };
  }

  private createFile(initial: string): void {
    const create = this.options.createFile;
    if (!create) return;
    this.fileState = "creating";
    // Hold the producer until the file exists, so nothing queues up meanwhile.
    this.setPaused(true);
    this.fileReady = create(this.capForFile(initial))
      .then((path) => {
        this.openStream(path);
        const queued = this.pending;
        this.pending = [];
        for (const text of queued) this.writeToFile(text);
      })
      .catch((error: unknown) => {
        this.fileError = error instanceof Error ? error.message : String(error);
        this.fileState = "closed";
        this.pending = [];
      })
      .finally(() => {
        if (this.stream?.writableNeedDrain !== true) this.setPaused(false);
      });
  }

  private openStream(path: string): void {
    this.filePath = path;
    this.fileState = "open";
    const stream = createWriteStream(path, { flags: "a" });
    stream.on("error", (error) => {
      this.fileError ??= error.message;
      this.fileCapped = true;
      this.setPaused(false);
    });
    stream.on("drain", () => this.setPaused(false));
    this.stream = stream;
  }

  /** Trims `text` to what still fits under the file cap, and counts it. */
  private capForFile(text: string): string {
    if (this.fileCapped) return "";
    const room = this.options.fileCapBytes - this.fileBytes;
    const bytes = Buffer.byteLength(text);
    if (bytes <= room) {
      this.fileBytes += bytes;
      return text;
    }
    this.fileCapped = true;
    const fitted = Buffer.from(text).subarray(0, Math.max(0, room)).toString("utf8");
    this.fileBytes += Buffer.byteLength(fitted);
    return fitted + FILE_CAP_NOTE;
  }

  private writeToFile(text: string): void {
    if (this.fileCapped || this.fileError) return;
    if (this.fileState === "creating") {
      this.pending.push(text);
      return;
    }
    if (this.fileState !== "open" || !this.stream) return;
    const piece = this.capForFile(text);
    if (piece && !this.stream.write(piece)) this.setPaused(true);
  }

  private setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.options.pause?.();
    else this.options.resume?.();
  }
}

/** Keeps the last `capacity` characters of a stream of text. */
class TailBuffer {
  private readonly capacity: number;
  private parts: string[] = [];
  private length = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(0, capacity);
  }

  push(text: string): void {
    if (this.capacity === 0) return;
    if (text.length >= this.capacity) {
      this.parts = [text.slice(text.length - this.capacity)];
      this.length = this.capacity;
      return;
    }
    this.parts.push(text);
    this.length += text.length;
    while (this.parts.length > 1) {
      const first = this.parts[0] ?? "";
      if (this.length - first.length < this.capacity) break;
      this.parts.shift();
      this.length -= first.length;
    }
    if (this.parts.length > 256) this.parts = [this.parts.join("")];
  }

  value(): string {
    const joined = this.parts.join("");
    return joined.length > this.capacity ? joined.slice(joined.length - this.capacity) : joined;
  }
}

/** The first `max` characters of `text`, without splitting a surrogate pair. */
export function cutAtCodePoint(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}
