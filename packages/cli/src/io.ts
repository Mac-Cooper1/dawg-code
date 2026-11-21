/** The process's streams and signals, passed in so each mode can be driven the same way. */
import type { Readable, Writable } from "node:stream";

export interface Io {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable;
  env: NodeJS.ProcessEnv;
  /** The directory the command was started in. */
  cwd: string;
  /**
   * Calls `handler` for every SIGINT and SIGTERM until the returned function is called. The
   * handler decides what an interrupt means at that moment.
   */
  onSignal(handler: (signal: "SIGINT" | "SIGTERM") => void): () => void;
  /** Ends the process at once, as a second Ctrl+C asks. */
  exitNow(code: number): never;
}

/** Most bytes of a prompt read from standard input. */
export const MAX_STDIN_BYTES = 10 * 1024 * 1024;

export async function readAll(stream: Readable, maxBytes = MAX_STDIN_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error(`Standard input is over ${maxBytes / 1024 / 1024} MB.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Resolves once everything written to `stream` so far has been handed to the system. */
export function flush(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || stream.writableEnded) {
      resolve();
      return;
    }
    stream.write("", () => resolve());
  });
}
