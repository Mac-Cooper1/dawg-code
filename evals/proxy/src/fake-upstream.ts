/**
 * A scripted OpenAI-compatible upstream on 127.0.0.1, for tests. Each test supplies a handler that
 * decides how to answer; every request is captured.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface CapturedRequest {
  method: string;
  /** Path and query, as received. */
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** The body parsed as JSON, when it is JSON. */
  json: unknown;
  /** Resolves when the connection closed before the response finished (the proxy aborted). */
  aborted: Promise<void>;
  /** True once the response finished normally. */
  completed: boolean;
}

export type FakeHandler = (req: CapturedRequest, res: http.ServerResponse) => void | Promise<void>;

export interface FakeUpstream {
  /** Base URL ending in /v1. */
  url: string;
  port: number;
  requests: CapturedRequest[];
  setHandler(handler: FakeHandler): void;
  close(): Promise<void>;
}

export async function startFakeUpstream(initial?: FakeHandler): Promise<FakeUpstream> {
  let handler: FakeHandler = initial ?? ((_req, res) => sendJson(res, 200, {}));
  const requests: CapturedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    let json: unknown;
    try {
      json = JSON.parse(body.toString("utf8"));
    } catch {
      json = undefined;
    }
    let resolveAborted: () => void = () => {};
    const captured: CapturedRequest = {
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: req.headers,
      body,
      json,
      aborted: new Promise<void>((resolve) => {
        resolveAborted = resolve;
      }),
      completed: false,
    };
    res.on("close", () => {
      if (res.writableFinished) captured.completed = true;
      else resolveAborted();
    });
    requests.push(captured);
    try {
      await handler(captured, res);
    } catch {
      if (!res.headersSent) sendJson(res, 500, { error: { message: "fake handler failed" } });
      else res.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    setHandler(next) {
      handler = next;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Raw SSE text for a list of chunks (objects are JSON-encoded), optionally ending in [DONE]. */
export function sseText(chunks: unknown[], done = true): string {
  let out = "";
  for (const chunk of chunks) {
    out += `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`;
  }
  if (done) out += "data: [DONE]\n\n";
  return out;
}

export interface SseOptions {
  /** Delay between writes. */
  delayMs?: number;
  /** End with `data: [DONE]` (default true). */
  done?: boolean;
  /** Write these raw pieces instead of one piece per chunk (to split events across writes). */
  raw?: string[];
}

/** Stream chunks as an OpenAI-style SSE response. */
export async function sendSse(
  res: http.ServerResponse,
  chunks: unknown[],
  options: SseOptions = {},
): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const pieces =
    options.raw ?? chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`);
  if (options.raw === undefined && options.done !== false) pieces.push("data: [DONE]\n\n");
  for (const piece of pieces) {
    if (res.destroyed) return;
    res.write(piece);
    if (options.delayMs) await sleep(options.delayMs);
  }
  res.end();
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface RawRequestOptions {
  method?: string;
  headers?: http.OutgoingHttpHeaders;
  body?: string | Buffer;
}

/** Open a request with node:http (full control over headers); resolves at response headers. */
export function openRequest(
  url: string,
  options: RawRequestOptions = {},
): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: options.headers,
      agent: false,
    });
    req.once("response", (res) => resolve({ req, res }));
    req.once("error", reject);
    req.end(options.body);
  });
}

/** Send a request and read the whole response. */
export async function rawRequest(
  url: string,
  options: RawRequestOptions = {},
): Promise<RawResponse> {
  const { res } = await openRequest(url, options);
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  return { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One `chat.completion.chunk`. */
export function chunk(
  delta: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  };
}

/** A non-streamed `chat.completion`. */
export function completion(
  message: Record<string, unknown>,
  finishReason: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [
      { index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    ...extra,
  };
}
