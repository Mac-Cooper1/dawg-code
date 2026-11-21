import type { Endpoint } from "@dawg/models";
import {
  type ModelClient,
  ModelError,
  type ModelReply,
  type ModelRequest,
  type ModelStreamEvent,
} from "../contracts/model.ts";
import { ChunkError, completionMessage, ReplyAssembler } from "./assemble.ts";
import { describeNetworkError, httpError, streamErrorEvent } from "./errors.ts";
import {
  buildChatBody,
  buildCountBody,
  type RequestBuildOptions,
  type TemplateFacts,
} from "./request.ts";
import { SseParser } from "./sse.ts";

export interface ModelClientOptions {
  /** For tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /**
   * Fail with a "timeout" error when no bytes arrive for this long, counting from the request
   * until the response headers and then between chunks. Default 300 000 ms: a long prompt on a
   * big local model can take minutes before its first token, and only the bundled runtime sends
   * progress chunks meanwhile.
   */
  idleTimeoutMs?: number;
  /** Timeout for `countTokens`. Default 30 000 ms. */
  countTimeoutMs?: number;
  /** "auto" sends images only when the endpoint reports vision. Default "auto". */
  images?: "auto" | "send" | "omit";
  /**
   * The assistant-message field that carries reasoning back. Default "reasoning" for Ollama and
   * "reasoning_content" (llama-server, LM Studio, vLLM, DeepSeek style) otherwise.
   */
  reasoningField?: "reasoning_content" | "reasoning" | "none";
  /** Ask for usage with `stream_options.include_usage`. Default true. */
  includeUsage?: boolean;
  /** Template facts from the runtime's `/props`. Defaults to `endpoint.template`. */
  template?: TemplateFacts;
}

const DEFAULT_IDLE_MS = 300_000;
const DEFAULT_COUNT_MS = 30_000;
/** After [DONE], how long to wait for the server to end the response before cutting it. */
const DRAIN_MS = 1_000;

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Resolves with the promise's value, or "deadline" after `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | "deadline"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** True when a body sent with the wrong content type is still an event stream. */
function looksLikeSse(text: string): boolean {
  const head = text.trimStart().slice(0, 6);
  return head.startsWith("data:") || head.startsWith(":") || head.startsWith("event:");
}

export function createModelClient(
  endpoint: Endpoint,
  options: ModelClientOptions = {},
): ModelClient {
  const fetchImpl = options.fetch ?? fetch;
  const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const base = trimSlash(endpoint.baseUrl);
  const images =
    options.images === undefined || options.images === "auto"
      ? endpoint.capabilities.vision
        ? "send"
        : "omit"
      : options.images;
  const field =
    options.reasoningField ?? (endpoint.kind === "ollama" ? "reasoning" : "reasoning_content");
  const build: RequestBuildOptions = {
    images,
    reasoningField: field === "none" ? null : field,
    includeUsage: options.includeUsage ?? true,
  };
  const template = options.template ?? endpoint.template;
  if (template) build.template = template;

  function headers(accept: string): Record<string, string> {
    const out: Record<string, string> = { "content-type": "application/json", accept };
    if (endpoint.apiKey) out.authorization = `Bearer ${endpoint.apiKey}`;
    return out;
  }

  async function* stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const external = request.signal;
    if (external?.aborted) {
      throw new ModelError("aborted", "the request was aborted before it was sent");
    }
    const body = JSON.stringify(buildChatBody(endpoint, request, build));
    const controller = new AbortController();
    const assembler = new ReplyAssembler();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, idleMs);
    };
    // The idle clock only runs while waiting on the server, not while the caller handles an event.
    const pause = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const onAbort = () => controller.abort();
    external?.addEventListener("abort", onAbort, { once: true });
    let settled = false;
    let connected = false;

    /** Any failure as a ModelError. An abort or a timeout wins over what it caused. */
    const fail = (error: unknown): ModelError => {
      const partial = assembler.partial() ?? undefined;
      if (external?.aborted) {
        return new ModelError("aborted", "the request was aborted", { partial, cause: error });
      }
      if (timedOut) {
        return new ModelError("timeout", `no data from the model for ${idleMs} ms`, {
          retryable: true,
          partial,
          cause: error,
        });
      }
      if (error instanceof ModelError) return error;
      if (!connected) {
        return new ModelError(
          "connection",
          `cannot reach ${base}: ${describeNetworkError(error)}`,
          {
            retryable: true,
            cause: error,
          },
        );
      }
      return new ModelError(
        "stream_interrupted",
        `the reply broke off: ${describeNetworkError(error)}`,
        { retryable: true, partial, cause: error },
      );
    };

    /** Parses one SSE event; sets `done` on [DONE]. */
    let done = false;
    const handle = (data: string, event: string): ModelStreamEvent[] => {
      if (data === "[DONE]") {
        done = true;
        return [];
      }
      if (data.trim() === "") return [];
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch (error) {
        throw new ModelError(
          "invalid_response",
          `the stream sent something that is not JSON: ${data.slice(0, 200)}`,
          { partial: assembler.partial() ?? undefined, cause: error },
        );
      }
      if (event === "error") throw streamErrorEvent(chunk, assembler.partial());
      try {
        return assembler.accept(chunk);
      } catch (error) {
        if (error instanceof ChunkError && error.message === "error") {
          throw streamErrorEvent((chunk as { error: unknown }).error, assembler.partial());
        }
        throw new ModelError(
          "invalid_response",
          error instanceof Error ? error.message : String(error),
          { partial: assembler.partial() ?? undefined, cause: chunk },
        );
      }
    };

    try {
      touch();
      const response = await fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        headers: headers("text/event-stream, application/json"),
        body,
        signal: controller.signal,
      });
      connected = true;
      touch();

      if (!response.ok) {
        const text = await response.text();
        throw httpError(response.status, response.statusText, text);
      }

      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      let chunks: AsyncIterable<Uint8Array>;
      if (type.includes("text/event-stream")) {
        if (!response.body) throw new ModelError("invalid_response", "the stream has no body");
        chunks = readChunks(response.body.getReader(), touch);
      } else {
        const text = await response.text();
        if (!looksLikeSse(text)) {
          pause();
          const whole = wholeReply(text, type);
          for (const event of whole.events) yield event;
          settled = true;
          yield { type: "finished", reply: whole.reply };
          return;
        }
        chunks = (async function* () {
          yield new TextEncoder().encode(text);
        })();
      }

      const parser = new SseParser();
      const iterator = chunks[Symbol.asyncIterator]();
      while (!done) {
        const next = await iterator.next();
        const events = next.done ? parser.end() : parser.push(next.value);
        for (const ev of events) {
          for (const out of handle(ev.data, ev.event)) {
            if (external?.aborted) throw new Error("aborted");
            pause();
            yield out;
            touch();
          }
          if (done) break;
        }
        if (next.done) break;
      }

      if (!done && !assembler.finished) {
        throw new ModelError(
          "stream_interrupted",
          "the stream ended before the reply was complete",
          {
            retryable: true,
            partial: assembler.partial() ?? undefined,
          },
        );
      }
      if (done) {
        // Let the server finish the response so the connection can be reused; cut it if it lingers.
        pause();
        const drained = await withDeadline(
          (async () => {
            while (!(await iterator.next()).done) {
              // Anything after [DONE] is ignored.
            }
          })().catch(() => undefined),
          DRAIN_MS,
        );
        if (drained === "deadline") controller.abort();
      }
      pause();
      const { events, reply } = assembler.complete();
      for (const event of events) yield event;
      if (external?.aborted) throw new Error("aborted");
      settled = true;
      yield { type: "finished", reply };
    } catch (error) {
      throw fail(error);
    } finally {
      pause();
      external?.removeEventListener("abort", onAbort);
      // An unfinished or abandoned stream must not leave its socket open.
      if (!settled) controller.abort();
    }
  }

  async function countTokens(
    request: Pick<ModelRequest, "messages" | "tools">,
  ): Promise<number | null> {
    if (endpoint.kind !== "bundled") return null;
    try {
      const response = await fetchImpl(`${base}/chat/completions/input_tokens`, {
        method: "POST",
        headers: headers("application/json"),
        body: JSON.stringify(buildCountBody(endpoint, request, build)),
        signal: AbortSignal.timeout(options.countTimeoutMs ?? DEFAULT_COUNT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const data: unknown = await response.json();
      const tokens = (data as { input_tokens?: unknown } | null)?.input_tokens;
      return typeof tokens === "number" && Number.isInteger(tokens) && tokens >= 0 ? tokens : null;
    } catch {
      // The caller falls back to an estimate.
      return null;
    }
  }

  return { endpoint, stream, countTokens };
}

/** The body's chunks, touching the idle timer on each one. */
async function* readChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  touch: () => void,
): AsyncGenerator<Uint8Array> {
  try {
    while (true) {
      const read = await reader.read();
      touch();
      if (read.done) return;
      yield read.value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** A non-streamed answer to a streaming request: accepted when it is a chat completion. */
function wholeReply(
  text: string,
  contentType: string,
): { events: ModelStreamEvent[]; reply: ModelReply } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    const what = contentType ? `a ${contentType.split(";")[0]} body` : "a body";
    throw new ModelError(
      "invalid_response",
      `expected a chat completion, got ${what}: ${text.slice(0, 200)}`,
    );
  }
  if (completionMessage(body) === null) {
    if (typeof body === "object" && body !== null && "error" in body) {
      throw streamErrorEvent((body as { error: unknown }).error, null);
    }
    throw new ModelError(
      "invalid_response",
      `expected a chat completion, got: ${text.slice(0, 200)}`,
    );
  }
  const assembler = new ReplyAssembler();
  const events = assembler.accept(body);
  const done = assembler.complete();
  return { events: [...events, ...done.events], reply: done.reply };
}
