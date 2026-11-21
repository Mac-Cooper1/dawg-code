import type { FileHandle } from "node:fs/promises";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProxyRecord } from "./record.ts";

/** Replaces every occurrence of the given secrets in a string. */
export function scrubber(secrets: (string | null | undefined)[]): (text: string) => string {
  const list = secrets.filter((s): s is string => typeof s === "string" && s.length >= 4);
  if (list.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const secret of list) out = out.split(secret).join("[REDACTED]");
    return out;
  };
}

/**
 * Appends one JSON line per record. Writes are serialised so lines never interleave, and each line
 * is written with a single call. `close()` waits for pending writes and syncs the file.
 */
export class RecordWriter {
  readonly #path: string;
  readonly #scrub: (text: string) => string;
  #handle: Promise<FileHandle> | null = null;
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  #lastError: unknown = null;

  constructor(filePath: string, scrub: (text: string) => string) {
    this.#path = filePath;
    this.#scrub = scrub;
  }

  async open(): Promise<void> {
    await mkdir(path.dirname(path.resolve(this.#path)), { recursive: true });
    this.#handle = open(this.#path, "a");
    await this.#handle;
  }

  write(record: ProxyRecord): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const line = `${this.#scrub(JSON.stringify(record))}\n`;
    this.#queue = this.#queue.then(async () => {
      try {
        this.#handle ??= open(this.#path, "a");
        const handle = await this.#handle;
        await handle.write(line);
      } catch (err) {
        this.#lastError = err;
        process.stderr.write(`[eval-proxy] failed to write record: ${String(err)}\n`);
      }
    });
    return this.#queue;
  }

  get lastError(): unknown {
    return this.#lastError;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#queue;
    this.#closed = true;
    if (this.#handle) {
      const handle = await this.#handle;
      try {
        await handle.sync();
      } catch {
        // Not all file systems support fsync; the data is still written.
      }
      await handle.close();
      this.#handle = null;
    }
  }
}

/** Debug dump of one exchange (`--bodies-dir`). Headers must already be redacted. */
export interface BodiesDump {
  seq: number;
  api: string;
  request: { method: string; path: string; headers: Record<string, unknown>; body: string };
  upstream_request: {
    url: string;
    headers: Record<string, unknown>;
    body: string | null;
  } | null;
  upstream_response: { status: number; headers: Record<string, unknown>; body: string } | null;
  /** What the proxy sent the client, when it differs from the upstream response (translation). */
  client_response: { status: number; body: string } | null;
}

/** Writes `<dir>/<seq>.json` per exchange, with secrets scrubbed. */
export class BodiesWriter {
  readonly #dir: string;
  readonly #scrub: (text: string) => string;
  #ready: Promise<unknown> | null = null;
  #pending = new Set<Promise<void>>();

  constructor(dir: string, scrub: (text: string) => string) {
    this.#dir = dir;
    this.#scrub = scrub;
  }

  write(dump: BodiesDump): void {
    this.#ready ??= mkdir(this.#dir, { recursive: true });
    const file = path.join(this.#dir, `${String(dump.seq).padStart(6, "0")}.json`);
    const task = this.#ready
      .then(() => writeFile(file, this.#scrub(JSON.stringify(dump, null, 2))))
      .catch((err: unknown) => {
        process.stderr.write(`[eval-proxy] failed to write bodies for ${dump.seq}: ${err}\n`);
      })
      .finally(() => {
        this.#pending.delete(task);
      });
    this.#pending.add(task);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.#pending]);
  }
}
