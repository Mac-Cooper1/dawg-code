import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Endpoint, EndpointKind } from "@dawg/models";
import {
  completionBody,
  errorBody,
  overflowBody,
  type RenderContext,
  sseEvent,
  streamEvents,
} from "./render.ts";
import { MAIN_LANE, matches, parseScript, validateReply } from "./script.ts";
import type {
  LaneSpec,
  MatchSpec,
  MockModelOptions,
  RecordedRequest,
  ScriptReply,
  TemplateCaps,
} from "./types.ts";

export interface UnansweredRequest {
  /** Index of the request in `requests`. */
  index: number;
  lane: string;
  reason: string;
}

export interface MockModel {
  /** Origin, e.g. http://127.0.0.1:53211 */
  readonly url: string;
  /** OpenAI-compatible root, `${url}/v1`. */
  readonly baseUrl: string;
  readonly port: number;
  /** An Endpoint pointing at this mock. */
  readonly endpoint: Endpoint;
  /** Every request received, in order. */
  readonly requests: readonly RecordedRequest[];
  /** Chat completion requests only, in order. */
  readonly chatRequests: readonly RecordedRequest[];
  /** Requests that found no reply to answer them. */
  readonly unanswered: readonly UnansweredRequest[];
  /** Sockets currently open (including idle keep-alive ones). */
  readonly openConnections: number;
  /** The `messages` of chat request `n` (negative counts from the end). */
  messages(n: number): unknown[];
  /** Appends replies to the main lane. */
  addReplies(...replies: ScriptReply[]): void;
  /** Appends replies to a named lane, which must exist. */
  addLaneReplies(lane: string, ...replies: ScriptReply[]): void;
  /** Adds a lane. Lanes are tried in the order they were added. */
  addLane(name: string, spec: LaneSpec): void;
  /** Replies not yet used, per lane. */
  pending(): Record<string, number>;
  /** Makes GET /health answer 503 "Loading model" (true) or 200 (false). */
  setLoading(loading: boolean): void;
  /** Throws when scripted replies are left unused or a request went unanswered. */
  assertDone(): void;
  /** Closes every connection (including stalled streams) and stops listening. */
  close(): Promise<void>;
}

interface Lane {
  name: string;
  match: MatchSpec | null;
  replies: ScriptReply[];
  next: number;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const HOST = "127.0.0.1";
const SECRET_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key"]);
const CHAT_PATHS = new Set(["/v1/chat/completions", "/chat/completions"]);
const COUNT_PATHS = new Set([
  "/v1/chat/completions/input_tokens",
  "/chat/completions/input_tokens",
]);

const DEFAULT_TEMPLATE_CAPS: TemplateCaps = {
  supports_object_arguments: true,
  supports_parallel_tool_calls: true,
  supports_preserve_reasoning: false,
  supports_reasoning_effort: false,
  supports_string_content: true,
  supports_system_role: true,
  supports_tool_calls: true,
  supports_tools: true,
  supports_typed_content: true,
  reasoning_effort_levels: [],
};

const defaultCount = (text: string) => Math.ceil(text.length / 4);

export async function startMockModel(options: MockModelOptions = {}): Promise<MockModel> {
  const kind: EndpointKind = options.kind ?? "bundled";
  const flavor = options.flavor ?? (kind === "bundled" ? "llama.cpp" : "openai");
  const llama = flavor === "llama.cpp";
  const model = options.model ?? "mock-model";
  const contextWindow = options.contextWindow ?? 8192;
  const countTokens = options.countTokens ?? defaultCount;
  let loading = options.loading ?? false;

  const script = Array.isArray(options.script)
    ? parseScript(options.script)
    : options.script
      ? parseScript(stripFunctions(options.script))
      : {};
  const lanes: Lane[] = [];
  // Function matchers cannot pass through parseScript's JSON checks, so they are re-attached.
  for (const [name, spec] of Object.entries(
    (Array.isArray(options.script) ? undefined : options.script?.lanes) ?? {},
  )) {
    const checked = script.lanes?.[name];
    lanes.push({ name, match: spec.match, replies: [...(checked?.replies ?? [])], next: 0 });
  }
  const main: Lane = {
    name: MAIN_LANE,
    match: null,
    replies: [...(script.replies ?? [])],
    next: 0,
  };

  const requests: RecordedRequest[] = [];
  const unanswered: UnansweredRequest[] = [];
  const sockets = new Set<Socket>();
  const slotPrompts = new Map<number, string>();
  let chatCount = 0;

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, errorBody(500, `mock-model: ${String(error)}`));
      } else {
        res.destroy();
      }
    });
  });
  server.on("connection", (socket) => {
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readBody(req);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || SECRET_HEADERS.has(name)) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    let body: unknown;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const record: RecordedRequest = {
      index: requests.length,
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers,
      body,
      rawBody,
    };
    requests.push(record);
    const path = new URL(record.path, "http://mock").pathname;

    if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
      if (loading) {
        sendJson(res, 503, errorBody(503, "Loading model", "unavailable_error"));
      } else {
        sendJson(res, 200, { status: "ok" });
      }
      return;
    }
    if (options.apiKey !== undefined && req.headers.authorization !== `Bearer ${options.apiKey}`) {
      sendJson(res, 401, {
        error: { message: "Invalid API Key", type: "authentication_error", code: 401 },
      });
      return;
    }
    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      sendJson(res, 200, modelsBody());
      return;
    }
    if (req.method === "GET" && path === "/props" && llama) {
      sendJson(res, 200, propsBody());
      return;
    }
    if (req.method === "POST" && COUNT_PATHS.has(path) && llama) {
      const prompt = chatPrompt(body);
      if (prompt === null) {
        sendJson(res, 400, errorBody(400, "'messages' is required"));
        return;
      }
      sendJson(res, 200, { input_tokens: countTokens(prompt), object: "response.input_tokens" });
      return;
    }
    if (req.method === "POST" && CHAT_PATHS.has(path)) {
      await chat(record, res);
      return;
    }
    sendJson(res, 404, {
      error: { message: "File Not Found", type: "not_found_error", code: 404 },
    });
  }

  function chatPrompt(body: unknown): string | null {
    if (!isObject(body) || !Array.isArray(body.messages)) return null;
    // Tools first, like a chat template renders them into the system prompt.
    return JSON.stringify({ tools: body.tools ?? [], messages: body.messages });
  }

  async function chat(record: RecordedRequest, res: ServerResponse): Promise<void> {
    const body = record.body;
    const prompt = chatPrompt(body);
    if (!isObject(body) || prompt === null) {
      sendJson(res, 400, errorBody(400, "'messages' is required"));
      return;
    }
    const estimate = countTokens(prompt);
    if (options.enforceContextWindow && estimate >= contextWindow) {
      sendJson(res, 400, overflowBody(estimate, contextWindow));
      return;
    }
    const lane = lanes.find((l) => l.match !== null && matches(l.match, record)) ?? main;
    record.lane = lane.name;
    const reply = lane.replies[lane.next];
    const number = chatCount++;
    if (reply === undefined) {
      const reason = `no scripted reply left for chat request #${number} (lane ${lane.name})`;
      unanswered.push({ index: record.index, lane: lane.name, reason });
      sendJson(res, 500, errorBody(500, `mock-model: ${reason}`, "mock_script_error"));
      return;
    }
    record.replyIndex = lane.next;
    lane.next += 1;

    const fault = reply.fault;
    if (fault?.type === "http") {
      const payload =
        fault.body ?? errorBody(fault.status, fault.message ?? `HTTP ${fault.status}`);
      if (typeof payload === "string") {
        res.writeHead(fault.status, { "content-type": "text/plain; charset=utf-8" });
        res.end(payload);
      } else {
        sendJson(res, fault.status, payload);
      }
      return;
    }
    if (fault?.type === "context_overflow") {
      const tokens = fault.promptTokens ?? Math.max(estimate, contextWindow + 1);
      sendJson(res, 400, overflowBody(tokens, fault.contextWindow ?? contextWindow));
      return;
    }
    if (fault?.type === "invalid") {
      res.writeHead(200, { "content-type": fault.contentType ?? "text/html; charset=utf-8" });
      res.end(fault.body ?? "<!doctype html><title>Not a model server</title><p>Hello.</p>");
      return;
    }

    const slot = typeof body.id_slot === "number" && body.id_slot >= 0 ? body.id_slot : 0;
    const previous = body.cache_prompt === false ? undefined : slotPrompts.get(slot);
    const reused = previous === undefined ? 0 : countPrefix(previous, prompt);
    slotPrompts.set(slot, prompt);
    const promptTokens = reply.usage?.promptTokens ?? estimate;
    // The last prompt token is always evaluated again, as on the real server.
    const cachedTokens =
      reply.usage?.cachedTokens ?? Math.min(reused, Math.max(0, promptTokens - 1));
    const streamOptions = isObject(body.stream_options) ? body.stream_options : {};
    const ctx: RenderContext = {
      flavor,
      model,
      requestNumber: number,
      promptTokens,
      cachedTokens,
      includeUsage: streamOptions.include_usage === true,
      timingsPerToken: body.timings_per_token === true,
      returnProgress: body.return_progress === true,
      promptTokensPerSecond: options.promptTokensPerSecond ?? 1000,
      completionTokensPerSecond: options.completionTokensPerSecond ?? 50,
      progressBatch: options.progressBatch ?? 512,
      countTokens,
    };

    if (fault?.type === "drop" && body.stream !== true) {
      res.socket?.destroy();
      return;
    }
    if (body.stream !== true || fault?.type === "non_streaming") {
      if (fault?.type === "stall") return; // never answers; close() or the client ends it
      await pause(reply.pacing?.firstEventDelayMs ?? 0, res);
      sendJson(res, 200, completionBody(reply, ctx));
      return;
    }
    await writeStream(res, streamEvents(reply, ctx), reply);
  }

  /** Tokens of the longest common prefix: what a real slot could reuse from its last prompt. */
  function countPrefix(a: string, b: string): number {
    const limit = Math.min(a.length, b.length);
    let i = 0;
    while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i === 0 ? 0 : countTokens(a.slice(0, i));
  }

  async function writeStream(
    res: ServerResponse,
    events: ReturnType<typeof streamEvents>,
    reply: ScriptReply,
  ): Promise<void> {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    const fault = reply.fault;
    const lineEnding = reply.wire?.lineEnding ?? "lf";
    const comments = reply.wire?.comments === true;
    const cut =
      fault?.type === "drop" || fault?.type === "stall" || fault?.type === "stream_error"
        ? (fault.afterEvents ?? 2)
        : Number.POSITIVE_INFINITY;
    let sent = 0;
    for (const event of events) {
      if (sent >= cut) break;
      const delay = sent === 0 ? reply.pacing?.firstEventDelayMs : reply.pacing?.delayMs;
      if (!(await pause(delay ?? 0, res))) return;
      if (!(await write(res, sseEvent(event, lineEnding, comments), reply.wire?.bytesPerWrite))) {
        return;
      }
      sent += 1;
    }
    if (sent < cut) {
      res.end();
      return;
    }
    if (fault?.type === "drop") {
      res.socket?.destroy();
    } else if (fault?.type === "stream_error") {
      const status = fault.status ?? 500;
      const error = errorBody(status, fault.message ?? "mock server error").error as Json;
      await write(res, sseEvent({ error }, lineEnding, false), undefined);
      res.end();
    }
    // A stall leaves the response open.
  }

  function modelsBody(): Json {
    const entry: Json = { id: model, object: "model", created: 1_700_000_000, owned_by: "mock" };
    if (!llama) return { object: "list", data: [entry] };
    return {
      object: "list",
      data: [
        {
          ...entry,
          aliases: [model],
          tags: [],
          owned_by: "llamacpp",
          meta: { n_ctx: contextWindow, n_ctx_train: contextWindow * 4, n_params: 1, size: 1 },
        },
      ],
    };
  }

  function propsBody(): Json {
    return {
      default_generation_settings: { params: {}, n_ctx: contextWindow },
      total_slots: options.totalSlots ?? 1,
      model_alias: model,
      model_path: `/models/${model}.gguf`,
      modalities: { vision: options.capabilities?.vision === true, audio: false },
      chat_template: options.chatTemplate ?? "{# mock template #}",
      chat_template_caps: { ...DEFAULT_TEMPLATE_CAPS, ...options.templateCaps },
      build_info: "b12359-mock",
      is_sleeping: false,
    };
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: HOST, port: options.port ?? 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://${HOST}:${port}`;
  const endpoint: Endpoint = {
    kind,
    baseUrl: `${url}/v1`,
    model,
    contextWindow,
    capabilities: {
      tools: options.capabilities?.tools ?? true,
      vision: options.capabilities?.vision ?? false,
      reasoning: options.capabilities?.reasoning ?? false,
      cacheControl: kind === "bundled",
    },
  };
  if (options.apiKey !== undefined) endpoint.apiKey = options.apiKey;

  let closing: Promise<void> | null = null;
  const chatRequests = () => requests.filter((r) => CHAT_PATHS.has(r.path.split("?")[0] ?? ""));

  return {
    url,
    baseUrl: endpoint.baseUrl,
    port,
    endpoint,
    get requests() {
      return requests;
    },
    get chatRequests() {
      return chatRequests();
    },
    get unanswered() {
      return unanswered;
    },
    get openConnections() {
      return sockets.size;
    },
    messages(n: number): unknown[] {
      const all = chatRequests();
      const request = all[n < 0 ? all.length + n : n];
      if (!request)
        throw new Error(`mock-model: there is no chat request ${n} (${all.length} seen)`);
      const body = request.body;
      return isObject(body) && Array.isArray(body.messages) ? body.messages : [];
    },
    addReplies(...replies: ScriptReply[]) {
      main.replies.push(...replies.map((r, i) => validateReply(r, `addReplies[${i}]`)));
    },
    addLaneReplies(name: string, ...replies: ScriptReply[]) {
      const lane = name === MAIN_LANE ? main : lanes.find((l) => l.name === name);
      if (!lane) throw new Error(`mock-model: no lane named "${name}"`);
      lane.replies.push(...replies.map((r, i) => validateReply(r, `${name}[${i}]`)));
    },
    addLane(name: string, spec: LaneSpec) {
      if (name === MAIN_LANE || lanes.some((l) => l.name === name)) {
        throw new Error(`mock-model: lane "${name}" already exists`);
      }
      const replies = (spec.replies ?? []).map((r, i) => validateReply(r, `${name}[${i}]`));
      lanes.push({ name, match: spec.match, replies, next: 0 });
    },
    pending() {
      const out: Record<string, number> = { [MAIN_LANE]: main.replies.length - main.next };
      for (const lane of lanes) out[lane.name] = lane.replies.length - lane.next;
      return out;
    },
    setLoading(value: boolean) {
      loading = value;
    },
    assertDone() {
      const problems: string[] = [];
      for (const lane of [main, ...lanes]) {
        const left = lane.replies.slice(lane.next);
        if (left.length === 0) continue;
        const labels = left.map((r, i) => r.label ?? `#${lane.next + i}`).join(", ");
        problems.push(
          `lane ${lane.name}: ${left.length} unused repl${left.length === 1 ? "y" : "ies"} (${labels})`,
        );
      }
      for (const miss of unanswered) problems.push(`request ${miss.index}: ${miss.reason}`);
      if (problems.length > 0)
        throw new Error(`mock-model script not done:\n  ${problems.join("\n  ")}`);
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}

/** Removes function matchers so the rest of the script can be checked as JSON. */
function stripFunctions(script: NonNullable<MockModelOptions["script"]>) {
  if (Array.isArray(script) || !script.lanes) return script;
  const lanes: Record<string, LaneSpec> = {};
  for (const [name, lane] of Object.entries(script.lanes)) {
    lanes[name] = { ...lane, match: typeof lane.match === "function" ? {} : lane.match };
  }
  return { ...script, lanes };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Waits `ms`, returning false early if the client has gone. */
function pause(ms: number, res: ServerResponse): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      res.off("close", onClose);
      resolve(!res.destroyed);
    }, ms);
    const onClose = () => {
      clearTimeout(timer);
      resolve(false);
    };
    res.once("close", onClose);
  });
}

/** Writes and waits until the bytes are handed to the socket. False when the client has gone. */
async function write(res: ServerResponse, text: string, bytesPerWrite?: number): Promise<boolean> {
  const data = Buffer.from(text, "utf8");
  const size = bytesPerWrite ?? data.length;
  for (let offset = 0; offset < data.length; offset += size) {
    if (res.destroyed) return false;
    const piece = data.subarray(offset, offset + size);
    const ok = await new Promise<boolean>((resolve) => {
      res.write(piece, (error) => resolve(!error));
    });
    if (!ok) return false;
    // Yield so separate writes tend to leave as separate network packets.
    if (bytesPerWrite !== undefined) await new Promise((r) => setImmediate(r));
  }
  return true;
}
