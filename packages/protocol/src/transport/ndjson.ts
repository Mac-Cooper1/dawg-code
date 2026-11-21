import { type JsonRpcMessage, parseJson } from "../jsonrpc.ts";
import {
  createTransportCore,
  type Transport,
  TransportClosedError,
  TransportError,
} from "./types.ts";

/**
 * The parts of a Node readable stream this transport uses. Structural, so the package does not
 * import Node's types and stays usable from a browser bundle.
 */
export interface ReadableLike {
  on(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
  off(event: "end" | "close", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

/** The parts of a Node writable stream this transport uses. */
export interface WritableLike {
  write(chunk: string, callback?: (error?: Error | null) => void): boolean;
  end(): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
}

export interface NdjsonTransportOptions {
  input: ReadableLike;
  output: WritableLike;
  /**
   * Longest line accepted, in characters. Longer lines are dropped and reported as "oversized".
   * Prompts can carry base64 images, so the default is generous: 64 Mi characters.
   */
  maxLineLength?: number;
  /** End `output` when the transport closes. Defaults to true. */
  endOutputOnClose?: boolean;
}

export const DEFAULT_MAX_LINE_LENGTH = 64 * 1024 * 1024;

/**
 * Newline-delimited JSON over a pair of streams: one message per line, UTF-8. Used for stdio.
 *
 * Lines may arrive split across chunks or several to a chunk. Blank lines and a trailing "\r" are
 * ignored. Invalid JSON and oversized lines are reported and skipped; the stream carries on.
 */
export function createNdjsonTransport(options: NdjsonTransportOptions): Transport {
  const { input, output } = options;
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  const endOutputOnClose = options.endOutputOnClose ?? true;
  const core = createTransportCore();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  // True while skipping the rest of an oversized line.
  let discarding = false;

  function handleLine(line: string): void {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text.trim() === "") return;
    const parsed = parseJson(text);
    if (parsed.ok) core.emitMessage(parsed.value);
    else core.emitError(new TransportError("parse", `Invalid JSON: ${parsed.error}`));
  }

  function reportOversized(): void {
    core.emitError(
      new TransportError(
        "oversized",
        `A line exceeded ${maxLineLength} characters and was dropped`,
      ),
    );
  }

  function onData(chunk: string | Uint8Array): void {
    if (core.closed) return;
    let text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    while (text.length > 0) {
      const newline = text.indexOf("\n");
      if (newline === -1) {
        if (discarding) return;
        if (buffer.length + text.length > maxLineLength) {
          buffer = "";
          discarding = true;
          reportOversized();
          return;
        }
        buffer += text;
        return;
      }
      const piece = text.slice(0, newline);
      text = text.slice(newline + 1);
      if (discarding) {
        discarding = false;
        continue;
      }
      if (buffer.length + piece.length > maxLineLength) {
        buffer = "";
        reportOversized();
        continue;
      }
      const line = buffer + piece;
      buffer = "";
      handleLine(line);
      // A listener may have closed the transport while handling the line.
      if (core.closed) return;
    }
  }

  function onEnd(): void {
    if (!discarding) {
      const rest = buffer + decoder.decode();
      buffer = "";
      if (rest.trim() !== "") handleLine(rest);
    }
    shutdown(null);
  }

  function onInputError(error: Error): void {
    const wrapped = new TransportError("io", `Read failed: ${error.message}`, { cause: error });
    core.emitError(wrapped);
    shutdown(wrapped);
  }

  function onOutputError(error: Error): void {
    const wrapped = new TransportError("io", `Write failed: ${error.message}`, { cause: error });
    core.emitError(wrapped);
    shutdown(wrapped);
  }

  function detach(): void {
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("close", onEnd);
    input.off("error", onInputError);
    output.off("error", onOutputError);
  }

  function shutdown(error: Error | null): void {
    if (core.closed) return;
    detach();
    if (endOutputOnClose) {
      try {
        output.end();
      } catch {
        // Already ended or destroyed: nothing more to flush.
      }
    }
    core.markClosed(error);
  }

  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", onEnd);
  input.on("error", onInputError);
  output.on("error", onOutputError);

  return {
    send(message: JsonRpcMessage) {
      if (core.closed) throw new TransportClosedError();
      output.write(`${JSON.stringify(message)}\n`);
    },
    onMessage: core.onMessage,
    onError: core.onError,
    onClose: core.onClose,
    close() {
      shutdown(null);
    },
    get closed() {
      return core.closed;
    },
  };
}
