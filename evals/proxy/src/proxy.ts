import http from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { estimateTokens } from "./anthropic/count-tokens.ts";
import { AnthropicStreamTranslator } from "./anthropic/stream-translator.ts";
import {
  type TranslatedRequest,
  TranslationError,
  translateRequest,
} from "./anthropic/translate-request.ts";
import {
  anthropicError,
  buildMessage,
  translateUpstreamError,
} from "./anthropic/translate-response.ts";
import { ChatAccumulator, errorText, isRecord } from "./chat-accumulator.ts";
import {
  clientAuthorization,
  forwardRequestHeaders,
  forwardResponseHeaders,
  redactHeaders,
  redactRawHeaders,
} from "./headers.ts";
import type { ApiKind, ProxyRecord, TimingsRecord, ToolCallRecord, UsageRecord } from "./record.ts";
import { emptyUsage } from "./record.ts";
import { type BodiesDump, BodiesWriter, RecordWriter, scrubber } from "./recorder.ts";
import { SseParser } from "./sse.ts";
import {
  anthropicToolSchemas,
  checkToolCalls,
  openAiToolSchemas,
  type ToolSchemas,
} from "./tool-validation.ts";
import {
  bodyDecoder,
  describeTransportError,
  isTimeout,
  sendUpstream,
  UpstreamAgents,
} from "./upstream.ts";

export interface ProxyOptions {
  /** Upstream OpenAI-compatible base URL, ending in /v1 (e.g. http://127.0.0.1:8080/v1). */
  upstream: string;
  /** Port on 127.0.0.1; 0 picks a free one. */
  port?: number;
  /** JSONL record file (appended). */
  recordPath: string;
  /** Name of the env var holding the real upstream key. */
  upstreamKeyEnv?: string | null;
  /** Environment to read `upstreamKeyEnv` from (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** Save full request/response bodies per seq here (credentials stripped). */
  bodiesDir?: string | null;
  /** Copied into every record. */
  label?: string | null;
  /**
   * Add `stream_options.include_usage: true` to streamed chat requests that lack it, so usage
   * can be recorded (default true). The extra usage chunk is passed through to the client.
   */
  injectUsage?: boolean;
  /** For translated Anthropic requests: the model name to send upstream instead of the client's. */
  upstreamModel?: string | null;
  /** Abort an upstream request after this long with no data (default 10 minutes; 0 = never). */
  idleTimeoutMs?: number;
  /** Largest accepted request body (default 256 MiB). */
  maxBodyBytes?: number;
  /** Translated streams: send `ping` after this much silence (default 10 s). */
  pingIntervalMs?: number;
  /** On close: how long to let in-flight requests finish before aborting them (default 5 s). */
  shutdownGraceMs?: number;
  /** Log sink for one-line summaries and warnings (default: stderr). */
  log?: (line: string) => void;
}

export interface RunningProxy {
  port: number;
  /** http://127.0.0.1:<port> */
  url: string;
  /** Stop accepting, let in-flight requests finish (or abort them after the grace period),
   * write their records, and close the record file. */
  close(): Promise<void>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024 * 1024;
/** Upper bound on decoded response bytes kept in memory for parsing and body dumps. */
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

/** Why an exchange was aborted. */
type AbortCause = "client" | "shutdown";

interface Exchange {
  seq: number;
  startedAt: Date;
  start: number;
  method: string;
  path: string;
  api: ApiKind;
  model: string | null;
  stream: boolean;
  status: number | null;
  messages: number | null;
  tools: number | null;
  bodyBytes: number;
  usage: UsageRecord;
  timings: TimingsRecord | null;
  toolCalls: ToolCallRecord[];
  finishReason: string | null;
  error: string | null;
  upstreamPath: string | null;
  upstreamModel: string | null;
  ttfbMs: number | null;
  usageInjected: boolean;
  controller: AbortController;
  abortCause: AbortCause | null;
  dump: BodiesDump | null;
}

export async function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const base = parseUpstream(options.upstream);
  const env = options.env ?? process.env;
  let upstreamKey: string | null = null;
  if (options.upstreamKeyEnv) {
    const value = env[options.upstreamKeyEnv];
    if (!value) {
      throw new Error(`environment variable ${options.upstreamKeyEnv} is not set or empty`);
    }
    upstreamKey = value;
  }
  const scrub = scrubber([upstreamKey]);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const safeLog = (line: string) => log(scrub(line));
  const injectUsage = options.injectUsage ?? true;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const pingIntervalMs = options.pingIntervalMs ?? 10_000;
  const shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
  const label = options.label ?? null;
  const upstreamModel = options.upstreamModel ?? null;

  const recorder = new RecordWriter(options.recordPath, scrub);
  await recorder.open();
  const bodies = options.bodiesDir ? new BodiesWriter(options.bodiesDir, scrub) : null;
  const agents = new UpstreamAgents();

  let seq = 0;
  let closing = false;
  /** null = unknown, true/false once probed. */
  let inputTokensEndpoint: boolean | null = null;
  const inFlight = new Map<Exchange, Promise<void>>();

  /** Client path /v1/<rest> → <upstream base>/<rest>. */
  const upstreamUrl = (clientPath: string, search: string): URL =>
    new URL(`${base.href.replace(/\/+$/, "")}${clientPath.slice(3)}${search}`);

  const server = http.createServer((req, res) => {
    const exchange = newExchange(++seq, req);
    const task = handle(exchange, req, res)
      .catch((err: unknown) => {
        exchange.error ??= `internal proxy error: ${err instanceof Error ? err.message : String(err)}`;
        if (!res.headersSent && !res.destroyed) {
          sendJson(res, exchange, 500, {
            error: { message: exchange.error, type: "proxy_error", code: "internal_error" },
          });
        } else if (!res.writableEnded) {
          res.destroy();
        }
      })
      .then(() => finishExchange(exchange))
      .catch((err: unknown) => {
        safeLog(`[eval-proxy] #${exchange.seq} failed to record: ${String(err)}`);
      });
    inFlight.set(exchange, task);
    void task.finally(() => inFlight.delete(exchange));
  });

  function newExchange(n: number, req: http.IncomingMessage): Exchange {
    const url = new URL(req.url ?? "/", "http://proxy.invalid");
    return {
      seq: n,
      startedAt: new Date(),
      start: performance.now(),
      method: req.method ?? "GET",
      path: url.pathname,
      api: "other",
      model: null,
      stream: false,
      status: null,
      messages: null,
      tools: null,
      bodyBytes: 0,
      usage: emptyUsage(),
      timings: null,
      toolCalls: [],
      finishReason: null,
      error: null,
      upstreamPath: null,
      upstreamModel: null,
      ttfbMs: null,
      usageInjected: false,
      controller: new AbortController(),
      abortCause: null,
      dump: bodies
        ? {
            seq: n,
            api: "other",
            request: {
              method: req.method ?? "GET",
              path: req.url ?? "/",
              headers: redactHeaders(req.headers),
              body: "",
            },
            upstream_request: null,
            upstream_response: null,
            client_response: null,
          }
        : null,
    };
  }

  async function handle(ex: Exchange, req: http.IncomingMessage, res: http.ServerResponse) {
    res.on("close", () => {
      if (!res.writableFinished && ex.abortCause === null) {
        ex.abortCause = "client";
        ex.controller.abort(new Error("client disconnected"));
      }
    });
    if (closing) {
      ex.error = "proxy shutting down";
      res.setHeader("connection", "close");
      sendJson(res, ex, 503, {
        error: { message: ex.error, type: "proxy_error", code: "shutting_down" },
      });
      req.resume();
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        ex.error = err.message;
        res.setHeader("connection", "close");
        sendJson(res, ex, 413, {
          error: { message: err.message, type: "invalid_request_error", code: "request_too_large" },
        });
        req.destroy();
        return;
      }
      ex.error = `client disconnected while sending the request (${describeTransportError(err)})`;
      return;
    }
    ex.bodyBytes = body.length;
    if (ex.dump) ex.dump.request.body = body.toString("utf8");

    const url = new URL(req.url ?? "/", "http://proxy.invalid");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (ex.method === "POST" && path === "/v1/messages") {
      ex.api = "anthropic.messages";
      await anthropicMessages(ex, req, res, body);
    } else if (ex.method === "POST" && path === "/v1/messages/count_tokens") {
      await countTokens(ex, req, res, body);
    } else if (path === "/v1" || path.startsWith("/v1/")) {
      if (ex.method === "POST" && path === "/v1/chat/completions") ex.api = "openai.chat";
      await passThrough(ex, req, res, body, url);
    } else {
      ex.error = `no route for ${ex.method} ${url.pathname}`;
      sendJson(res, ex, 404, {
        error: { message: ex.error, type: "not_found_error", code: "not_found" },
      });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // OpenAI-compatible pass-through
  // ---------------------------------------------------------------------------------------------

  async function passThrough(
    ex: Exchange,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
    url: URL,
  ) {
    let sendBody = body;
    let schemas: ToolSchemas = new Map();
    const parsed = body.length > 0 && looksJson(req.headers["content-type"]) ? tryJson(body) : null;
    if (isRecord(parsed)) {
      ex.model = typeof parsed.model === "string" ? parsed.model : null;
      ex.stream = parsed.stream === true;
      if (Array.isArray(parsed.messages)) ex.messages = parsed.messages.length;
      if (ex.api === "openai.chat") {
        ex.tools = Array.isArray(parsed.tools) ? parsed.tools.length : 0;
        ex.messages ??= 0;
        schemas = openAiToolSchemas(parsed.tools);
        const opts = parsed.stream_options;
        if (ex.stream && injectUsage && !(isRecord(opts) && opts.include_usage === true)) {
          sendBody = withIncludeUsage(body, parsed);
          ex.usageInjected = true;
        }
      }
    }

    const target = upstreamUrl(url.pathname, url.search);
    ex.upstreamPath = target.pathname;
    const headers = forwardRequestHeaders(req.headers, { upstreamKey });
    const hasBody = !(body.length === 0 && (ex.method === "GET" || ex.method === "HEAD"));
    if (ex.dump) {
      ex.dump.upstream_request = {
        url: target.href,
        headers: redactHeaders(headers),
        body: sendBody === body ? null : sendBody.toString("utf8"),
      };
    }

    let upstreamRes: http.IncomingMessage;
    try {
      upstreamRes = await sendUpstream({
        url: target,
        method: ex.method,
        headers,
        body: hasBody ? sendBody : null,
        signal: ex.controller.signal,
        idleTimeoutMs,
        agents,
      });
    } catch (err) {
      failBeforeResponse(ex, res, err, "openai");
      return;
    }
    ex.ttfbMs = performance.now() - ex.start;
    const status = upstreamRes.statusCode ?? 502;
    ex.status = status;
    res.writeHead(
      status,
      upstreamRes.statusMessage || undefined,
      forwardResponseHeaders(upstreamRes.rawHeaders),
    );

    const contentType = String(upstreamRes.headers["content-type"] ?? "");
    const isSse = contentType.includes("text/event-stream");
    const acc = new ChatAccumulator();
    const capture = new Capture(MAX_CAPTURE_BYTES);
    let sawDone = false;
    const sse = isSse
      ? new SseParser((event) => {
          if (event.data === "[DONE]") sawDone = true;
          if (event.data === "[DONE]") return;
          const chunk = tryJsonText(event.data);
          if (chunk !== undefined) acc.applyChunk(chunk);
        })
      : null;
    const decoder = bodyDecoder(upstreamRes.headers["content-encoding"], (decoded) => {
      sse?.push(decoded);
      capture.push(decoded);
    });

    let streamError: unknown = null;
    try {
      for await (const chunk of upstreamRes) {
        decoder?.write(chunk as Buffer);
        if (!(await writeChunk(res, chunk as Buffer))) {
          ex.abortCause ??= "client";
          ex.controller.abort(new Error("client disconnected"));
          break;
        }
      }
    } catch (err) {
      streamError = err;
    }
    await decoder?.end();
    sse?.end();

    if (streamError !== null || ex.abortCause !== null) {
      ex.error =
        abortMessage(ex) ?? `upstream stream failed: ${describeTransportError(streamError)}`;
      if (!res.writableEnded) res.destroy();
    } else {
      res.end();
    }

    const text = capture.text();
    if (!isSse && text !== null && looksJson(contentType)) {
      const parsedRes = tryJsonText(text);
      if (parsedRes !== undefined) acc.applyCompletion(parsedRes);
    }
    if (status >= 400) ex.error ??= `upstream HTTP ${status}: ${upstreamErrorMessage(text)}`;
    if (isSse && ex.api === "openai.chat" && decoder !== null && !sawDone && !acc.finishReason) {
      ex.error ??= "upstream stream ended before the response was complete";
    }
    applyAccumulator(ex, acc, schemas);
    if (ex.dump) {
      ex.dump.upstream_response = {
        status,
        headers: redactRawHeaders(upstreamRes.rawHeaders),
        body: text ?? "[body too large to capture]",
      };
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Anthropic Messages → OpenAI Chat Completions
  // ---------------------------------------------------------------------------------------------

  function anthropicUpstreamHeaders(req: http.IncomingMessage, stream: boolean) {
    const headers: http.OutgoingHttpHeaders = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      "accept-encoding": "identity",
    };
    const auth = upstreamKey !== null ? `Bearer ${upstreamKey}` : clientAuthorization(req.headers);
    if (auth) headers.authorization = auth;
    return headers;
  }

  async function anthropicMessages(
    ex: Exchange,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
  ) {
    const input = tryJson(body);
    if (isRecord(input)) {
      ex.model = typeof input.model === "string" ? input.model : null;
      ex.stream = input.stream === true;
      ex.messages = Array.isArray(input.messages) ? input.messages.length : 0;
      ex.tools = Array.isArray(input.tools) ? input.tools.length : 0;
    }
    let translated: TranslatedRequest;
    try {
      translated = translateRequest(input, { upstreamModel, includeUsage: injectUsage });
    } catch (err) {
      const message =
        err instanceof TranslationError ? err.message : `invalid request: ${String(err)}`;
      ex.error = message;
      sendJson(res, ex, 400, anthropicError("invalid_request_error", message));
      return;
    }
    const upstreamModelName = String(translated.body.model ?? "");
    if (upstreamModelName !== translated.requestedModel) ex.upstreamModel = upstreamModelName;
    const schemas = anthropicToolSchemas(isRecord(input) ? input.tools : undefined);
    const upstreamBody = Buffer.from(JSON.stringify(translated.body));
    const target = upstreamUrl("/v1/chat/completions", "");
    ex.upstreamPath = target.pathname;
    const headers = anthropicUpstreamHeaders(req, translated.stream);
    if (ex.dump) {
      ex.dump.upstream_request = {
        url: target.href,
        headers: redactHeaders(headers),
        body: upstreamBody.toString("utf8"),
      };
    }

    let upstreamRes: http.IncomingMessage;
    try {
      upstreamRes = await sendUpstream({
        url: target,
        method: "POST",
        headers,
        body: upstreamBody,
        signal: ex.controller.signal,
        idleTimeoutMs,
        agents,
      });
    } catch (err) {
      failBeforeResponse(ex, res, err, "anthropic");
      return;
    }
    ex.ttfbMs = performance.now() - ex.start;
    const status = upstreamRes.statusCode ?? 502;
    const contentType = String(upstreamRes.headers["content-type"] ?? "");
    const isSse = contentType.includes("text/event-stream");
    const dumpUpstream = (text: string | null) => {
      if (ex.dump) {
        ex.dump.upstream_response = {
          status,
          headers: redactRawHeaders(upstreamRes.rawHeaders),
          body: text ?? "[body too large to capture]",
        };
      }
    };

    if (status < 200 || status >= 300) {
      const { text, error } = await readAll(upstreamRes);
      dumpUpstream(text);
      const bodyText = text ?? "";
      const mapped = translateUpstreamError(status, bodyText);
      ex.error = `upstream HTTP ${status}: ${mapped.message}`;
      if (error !== null) ex.error += ` (${error})`;
      if (ex.abortCause === null) sendJson(res, ex, mapped.status, mapped.body);
      return;
    }

    if (!translated.stream) {
      const acc = new ChatAccumulator();
      let text: string | null;
      if (isSse) {
        const sse = new SseParser((event) => {
          if (event.data === "[DONE]") return;
          const chunk = tryJsonText(event.data);
          if (chunk !== undefined) acc.applyChunk(chunk);
        });
        const read = await readAll(upstreamRes, (chunk) => sse.push(chunk));
        sse.end();
        text = read.text;
        if (read.error !== null) ex.error = read.error;
      } else {
        const read = await readAll(upstreamRes);
        text = read.text;
        if (read.error !== null) ex.error = read.error;
        const parsed = text === null ? undefined : tryJsonText(text);
        if (parsed === undefined) {
          ex.error ??= "upstream returned a body that is not JSON";
        } else {
          acc.applyCompletion(parsed);
        }
      }
      dumpUpstream(text);
      applyAccumulator(ex, acc, schemas);
      if (ex.abortCause !== null) {
        ex.error = abortMessage(ex);
        return;
      }
      if (ex.error !== null || acc.error !== null) {
        const message = ex.error ?? acc.error ?? "upstream error";
        ex.error = message;
        sendJson(res, ex, 502, anthropicError("api_error", message));
        return;
      }
      const message = buildMessage(acc, translated.requestedModel);
      sendJson(res, ex, 200, message);
      return;
    }

    // Streamed response.
    ex.status = 200;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    const sent: string[] = [];
    const translator = new AnthropicStreamTranslator({
      model: translated.requestedModel,
      estimatedInputTokens: estimateTokens(translated.body),
      write: (text) => {
        if (ex.dump) sent.push(text);
        if (!res.destroyed && !res.writableEnded) res.write(text);
      },
    });
    translator.start();
    const pinger = setInterval(
      () => {
        if (translator.idleMs() >= pingIntervalMs) translator.ping();
      },
      Math.max(50, Math.floor(pingIntervalMs / 2)),
    );
    // Held in an object: it is set from the parser callback.
    const state: { upstreamError: string | null; readError: unknown; sawDone: boolean } = {
      upstreamError: null,
      readError: null,
      sawDone: false,
    };
    const jsonChunks: Buffer[] = [];
    const sse = new SseParser((event) => {
      if (event.data === "[DONE]") state.sawDone = true;
      if (state.upstreamError !== null || event.data === "[DONE]") return;
      const chunk = tryJsonText(event.data);
      if (chunk === undefined) return;
      const err = translator.onChunk(chunk);
      if (err !== null) state.upstreamError = err;
    });
    const capture = new Capture(MAX_CAPTURE_BYTES);
    const decoder = bodyDecoder(upstreamRes.headers["content-encoding"], (decoded) => {
      capture.push(decoded);
      if (isSse) sse.push(decoded);
      else jsonChunks.push(decoded);
    });
    if (decoder === null) {
      state.upstreamError = `unsupported content-encoding from upstream: ${String(upstreamRes.headers["content-encoding"])}`;
    }
    try {
      if (decoder !== null) {
        for await (const chunk of upstreamRes) {
          decoder.write(chunk as Buffer);
          if (state.upstreamError !== null || res.destroyed) break;
        }
      }
    } catch (err) {
      state.readError = err;
    } finally {
      clearInterval(pinger);
    }
    await decoder?.end();
    if (isSse) {
      sse.end();
      const ended = state.sawDone || translator.accumulator.finishReason !== null;
      if (!ended && state.readError === null && ex.abortCause === null) {
        state.upstreamError ??= "upstream stream ended before the response was complete";
      }
    } else if (state.readError === null && ex.abortCause === null && decoder !== null) {
      const jsonBody = Buffer.concat(jsonChunks).toString("utf8");
      // The upstream ignored `stream`; replay its whole completion as one chunk.
      const parsed = tryJsonText(jsonBody);
      if (parsed === undefined) state.upstreamError ??= "upstream returned a body that is not JSON";
      else {
        const err = translator.onChunk(completionAsChunk(parsed));
        if (err !== null) state.upstreamError ??= err;
      }
    }
    dumpUpstream(capture.text());

    if (ex.abortCause !== null) {
      ex.error = abortMessage(ex);
      ex.controller.abort();
      if (!res.writableEnded) res.destroy();
    } else if (state.upstreamError !== null || state.readError !== null) {
      const message =
        state.upstreamError ?? `upstream stream failed: ${describeTransportError(state.readError)}`;
      ex.error = message;
      ex.controller.abort();
      const type =
        state.readError !== null && isTimeout(state.readError) ? "timeout_error" : "api_error";
      translator.fail(type, message);
      res.end();
    } else {
      translator.finish();
      res.end();
    }
    applyAccumulator(ex, translator.accumulator, schemas);
    if (ex.dump) ex.dump.client_response = { status: 200, body: sent.join("") };
  }

  async function countTokens(
    ex: Exchange,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer,
  ) {
    const input = tryJson(body);
    if (isRecord(input)) {
      ex.model = typeof input.model === "string" ? input.model : null;
      ex.messages = Array.isArray(input.messages) ? input.messages.length : 0;
      ex.tools = Array.isArray(input.tools) ? input.tools.length : 0;
    }
    let translated: TranslatedRequest;
    try {
      translated = translateRequest(isRecord(input) ? { ...input, stream: false } : input, {
        upstreamModel,
        includeUsage: false,
      });
    } catch (err) {
      const message =
        err instanceof TranslationError ? err.message : `invalid request: ${String(err)}`;
      ex.error = message;
      sendJson(res, ex, 400, anthropicError("invalid_request_error", message));
      return;
    }
    const countBody: Record<string, unknown> = {
      model: translated.body.model,
      messages: translated.body.messages,
    };
    if (translated.body.tools !== undefined) countBody.tools = translated.body.tools;
    if (translated.body.tool_choice !== undefined)
      countBody.tool_choice = translated.body.tool_choice;

    if (inputTokensEndpoint !== false) {
      const target = upstreamUrl("/v1/chat/completions/input_tokens", "");
      try {
        const upstreamRes = await sendUpstream({
          url: target,
          method: "POST",
          headers: anthropicUpstreamHeaders(req, false),
          body: Buffer.from(JSON.stringify(countBody)),
          signal: ex.controller.signal,
          idleTimeoutMs,
          agents,
        });
        const { text } = await readAll(upstreamRes);
        const status = upstreamRes.statusCode ?? 0;
        const parsed = text === null ? undefined : tryJsonText(text);
        if (status === 200 && isRecord(parsed) && typeof parsed.input_tokens === "number") {
          inputTokensEndpoint = true;
          ex.upstreamPath = target.pathname;
          res.setHeader("x-dawg-token-count", "upstream");
          sendJson(res, ex, 200, { input_tokens: parsed.input_tokens });
          return;
        }
        if (status === 404 || status === 405 || status === 501) inputTokensEndpoint = false;
      } catch (err) {
        if (ex.abortCause !== null) {
          ex.error = abortMessage(ex);
          return;
        }
        safeLog(
          `[eval-proxy] #${ex.seq} token count upstream failed: ${describeTransportError(err)}`,
        );
      }
    }
    res.setHeader("x-dawg-token-count", "estimate; characters/3.5");
    sendJson(res, ex, 200, { input_tokens: estimateTokens(countBody) });
  }

  // ---------------------------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------------------------

  function abortMessage(ex: Exchange): string | null {
    if (ex.abortCause === "client") return "client disconnected";
    if (ex.abortCause === "shutdown") return "aborted: proxy shutting down";
    return null;
  }

  function failBeforeResponse(
    ex: Exchange,
    res: http.ServerResponse,
    err: unknown,
    shape: "openai" | "anthropic",
  ) {
    if (ex.abortCause !== null) {
      ex.error = abortMessage(ex);
      return;
    }
    const timeout = isTimeout(err);
    const status = timeout ? 504 : 502;
    const message = describeTransportError(err);
    ex.error = message;
    if (shape === "anthropic") {
      sendJson(res, ex, status, anthropicError(timeout ? "timeout_error" : "api_error", message));
    } else {
      sendJson(res, ex, status, {
        error: {
          message,
          type: "proxy_error",
          code: timeout ? "upstream_timeout" : "upstream_unreachable",
        },
      });
    }
  }

  function sendJson(res: http.ServerResponse, ex: Exchange, status: number, payload: unknown) {
    if (res.headersSent || res.destroyed) return;
    const text = JSON.stringify(payload);
    ex.status = status;
    if (ex.dump) ex.dump.client_response = { status, body: text };
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  function applyAccumulator(ex: Exchange, acc: ChatAccumulator, schemas: ToolSchemas) {
    ex.usage = acc.usage;
    ex.timings = acc.timings;
    ex.finishReason = acc.finishReason;
    if (ex.api !== "other") ex.toolCalls = checkToolCalls(acc.toolCalls(), schemas);
    if (acc.error !== null) ex.error ??= `upstream error: ${acc.error}`;
  }

  async function finishExchange(ex: Exchange) {
    const record: ProxyRecord = {
      seq: ex.seq,
      started_at: ex.startedAt.toISOString(),
      duration_ms: Math.round((performance.now() - ex.start) * 10) / 10,
      api: ex.api,
      path: ex.path,
      model: ex.model,
      stream: ex.stream,
      status: ex.status,
      request: { messages: ex.messages, tools: ex.tools, body_bytes: ex.bodyBytes },
      usage: ex.usage,
      timings: ex.timings,
      tool_calls: ex.toolCalls,
      finish_reason: ex.finishReason,
      error: ex.error,
      method: ex.method,
      label,
      upstream_path: ex.upstreamPath,
      upstream_model: ex.upstreamModel,
      ttfb_ms: ex.ttfbMs === null ? null : Math.round(ex.ttfbMs * 10) / 10,
      usage_injected: ex.usageInjected,
    };
    if (ex.dump && bodies) {
      ex.dump.api = ex.api;
      bodies.write(ex.dump);
    }
    const invalid = record.tool_calls.filter(
      (t) => !t.arguments_valid_json || t.schema_valid === false,
    );
    safeLog(
      `[eval-proxy] #${record.seq} ${record.api} ${record.method} ${record.path} ` +
        `${record.status ?? "-"} ${Math.round(record.duration_ms)}ms` +
        (record.tool_calls.length > 0
          ? ` tools=${record.tool_calls.length}${invalid.length > 0 ? ` invalid=${invalid.length}` : ""}`
          : "") +
        (record.error ? ` error=${JSON.stringify(record.error.slice(0, 300))}` : ""),
    );
    await recorder.write(record);
  }

  // Outlive typical client keep-alive pools so an idle connection is not closed under a request.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const pending = () => [...inFlight.values()];
      if (inFlight.size > 0) {
        await Promise.race([
          Promise.allSettled(pending()),
          new Promise((resolve) => setTimeout(resolve, shutdownGraceMs).unref()),
        ]);
      }
      for (const ex of inFlight.keys()) {
        if (ex.abortCause === null) {
          ex.abortCause = "shutdown";
          ex.controller.abort(new Error("proxy shutting down"));
        }
      }
      await Promise.allSettled(pending());
      server.closeAllConnections();
      await serverClosed;
      await recorder.close();
      await bodies?.flush();
      agents.destroy();
    })();
    return closePromise;
  };

  return { port, url: `http://127.0.0.1:${port}`, close };
}

// -----------------------------------------------------------------------------------------------
// Module helpers
// -----------------------------------------------------------------------------------------------

function parseUpstream(upstream: string): URL {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    throw new Error(`invalid upstream URL: ${upstream}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`upstream must be http(s): ${upstream}`);
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new BodyTooLargeError(limit);
    chunks.push(buf);
  }
  return Buffer.concat(chunks, size);
}

/** Read a whole upstream body (decoded), optionally feeding each decoded chunk to `onChunk`. */
async function readAll(
  res: http.IncomingMessage,
  onChunk?: (chunk: Buffer) => void,
): Promise<{ text: string | null; error: string | null }> {
  const capture = new Capture(MAX_CAPTURE_BYTES);
  const decoder = bodyDecoder(res.headers["content-encoding"], (decoded) => {
    capture.push(decoded);
    onChunk?.(decoded);
  });
  let error: string | null = null;
  try {
    for await (const chunk of res) decoder?.write(chunk as Buffer);
  } catch (err) {
    error = `upstream stream failed: ${describeTransportError(err)}`;
  }
  await decoder?.end();
  return { text: capture.text(), error };
}

/** Collects decoded bytes up to a cap. */
class Capture {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #size = 0;
  #overflow = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    if (this.#overflow) return;
    this.#size += chunk.length;
    if (this.#size > this.#limit) {
      this.#overflow = true;
      this.#chunks.length = 0;
      return;
    }
    this.#chunks.push(chunk);
  }

  /** The captured text, or null when it exceeded the cap. */
  text(): string | null {
    return this.#overflow ? null : Buffer.concat(this.#chunks).toString("utf8");
  }
}

function writeChunk(res: http.ServerResponse, chunk: Buffer): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      resolve(ok);
    };
    const onDrain = () => done(true);
    const onClose = () => done(false);
    res.on("drain", onDrain);
    res.on("close", onClose);
  });
}

function looksJson(contentType: string | string[] | undefined): boolean {
  const value = Array.isArray(contentType) ? contentType.join(",") : (contentType ?? "");
  // Many clients omit content-type on JSON posts; treat a missing type as JSON too.
  return value === "" || value.toLowerCase().includes("json");
}

function tryJson(body: Buffer): unknown {
  return tryJsonText(body.toString("utf8"));
}

function tryJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function upstreamErrorMessage(text: string | null): string {
  if (text === null) return "(body too large)";
  const parsed = tryJsonText(text);
  if (isRecord(parsed) && parsed.error !== undefined) return errorText(parsed.error).slice(0, 2000);
  if (isRecord(parsed) && typeof parsed.message === "string") return parsed.message.slice(0, 2000);
  return text.trim().slice(0, 2000) || "(empty body)";
}

/**
 * Add `"stream_options":{"include_usage":true}` to a chat request. When the request has no
 * `stream_options`, the field is spliced in after the opening brace so every other byte of the
 * client's body is unchanged; otherwise the body is re-serialised.
 */
export function withIncludeUsage(body: Buffer, parsed: Record<string, unknown>): Buffer {
  if (parsed.stream_options === undefined) {
    const text = body.toString("utf8");
    const brace = text.search(/\S/);
    if (brace !== -1 && text[brace] === "{") {
      const rest = text.slice(brace + 1);
      const empty = /^\s*\}/.test(rest);
      return Buffer.from(
        `${text.slice(0, brace + 1)}"stream_options":{"include_usage":true}${empty ? "" : ","}${rest}`,
        "utf8",
      );
    }
  }
  const existing = isRecord(parsed.stream_options) ? parsed.stream_options : {};
  return Buffer.from(
    JSON.stringify({ ...parsed, stream_options: { ...existing, include_usage: true } }),
    "utf8",
  );
}

/** A non-streamed completion expressed as one stream chunk (for upstreams that ignore `stream`). */
function completionAsChunk(completion: unknown): unknown {
  if (!isRecord(completion)) return completion;
  const choices = Array.isArray(completion.choices) ? completion.choices : [];
  return {
    ...completion,
    choices: choices.map((choice) => {
      if (!isRecord(choice)) return choice;
      const message = isRecord(choice.message) ? choice.message : {};
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls.map((call, index) => (isRecord(call) ? { index, ...call } : call))
        : undefined;
      return {
        index: choice.index ?? 0,
        delta: { ...message, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
        finish_reason: choice.finish_reason ?? null,
      };
    }),
  };
}
