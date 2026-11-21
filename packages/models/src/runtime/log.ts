import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface RotatingLogOptions {
  /** Rotate once the current file would grow past this many bytes. */
  maxBytes: number;
  /** Rotated files kept besides the current one: `<path>.1` (newest) … `<path>.<files>`. */
  files: number;
  /** Lines kept in memory for `tail()`. */
  tailLines?: number;
}

export const REDACTED = "[redacted]";

/**
 * Append-only log with size-capped rotation and an in-memory tail. Writes are synchronous so
 * ordering is exact and nothing is lost if the process exits right after a crash report.
 * Registered secrets are replaced before anything reaches the disk or the tail.
 */
export class RotatingLog {
  readonly path: string;
  private readonly options: Required<RotatingLogOptions>;
  private fd: number | undefined;
  private size = 0;
  private readonly recent: string[] = [];
  private secrets: string[] = [];

  constructor(path: string, options: RotatingLogOptions) {
    if (options.maxBytes <= 0) throw new Error("maxBytes must be positive");
    this.path = path;
    this.options = { tailLines: 200, ...options };
    mkdirSync(dirname(path), { recursive: true });
  }

  /** Strings that must never be written (the per-launch API key). Replaces the previous set. */
  setSecrets(secrets: readonly string[]): void {
    this.secrets = secrets.filter((s) => s.length > 0);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join(REDACTED);
    return out;
  }

  writeLine(line: string): void {
    const clean = this.redact(line);
    this.recent.push(clean);
    if (this.recent.length > this.options.tailLines) this.recent.shift();
    let bytes = Buffer.from(`${clean}\n`, "utf8");
    if (bytes.length > this.options.maxBytes)
      bytes = bytes.subarray(bytes.length - this.options.maxBytes);
    const fd = this.open();
    if (this.size > 0 && this.size + bytes.length > this.options.maxBytes) {
      this.rotate();
      this.writeBytes(this.open(), bytes);
    } else {
      this.writeBytes(fd, bytes);
    }
  }

  /** The last `lines` lines written (already redacted). */
  tail(lines = 60): string {
    return this.recent.slice(-lines).join("\n");
  }

  close(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }

  private open(): number {
    if (this.fd === undefined) {
      this.fd = openSync(this.path, "a", 0o600);
      this.size = statSync(this.path).size;
    }
    return this.fd;
  }

  private writeBytes(fd: number, bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    this.size += bytes.length;
  }

  private rotate(): void {
    this.close();
    const { files } = this.options;
    if (files <= 0) {
      rmSync(this.path, { force: true });
      return;
    }
    rmSync(`${this.path}.${files}`, { force: true });
    for (let i = files - 1; i >= 1; i--) {
      try {
        renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
      } catch {
        // A missing older file is normal.
      }
    }
    renameSync(this.path, `${this.path}.1`);
  }
}

/** Splits a byte stream into lines, so a secret is never cut in half across two writes. */
export class LineSplitter {
  private pending = "";
  private readonly onLine: (line: string) => void;
  private readonly maxPending: number;

  constructor(onLine: (line: string) => void, maxPending = 64 * 1024) {
    this.onLine = onLine;
    this.maxPending = maxPending;
  }

  push(chunk: Buffer | string): void {
    this.pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = this.pending.indexOf("\n");
    while (newline !== -1) {
      this.onLine(this.pending.slice(0, newline).replace(/\r$/, ""));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf("\n");
    }
    if (this.pending.length > this.maxPending) this.flush();
  }

  flush(): void {
    if (this.pending.length > 0) {
      this.onLine(this.pending);
      this.pending = "";
    }
  }
}
