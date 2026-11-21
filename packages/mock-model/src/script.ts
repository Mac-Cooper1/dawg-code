import type {
  Fault,
  LaneSpec,
  MatchSpec,
  RecordedRequest,
  RequestMatcher,
  Script,
  ScriptReply,
} from "./types.ts";

/**
 * Validation of scripts that come from JSON files, and request matching. Hand-written rather than
 * schema-driven so the mock has no dependencies; errors name the offending path.
 */

export class ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptError";
  }
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const REPLY_KEYS = new Set([
  "text",
  "reasoning",
  "toolCalls",
  "finishReason",
  "usage",
  "pacing",
  "wire",
  "fault",
  "label",
]);
const FAULT_TYPES = new Set([
  "drop",
  "stall",
  "http",
  "context_overflow",
  "non_streaming",
  "stream_error",
  "invalid",
]);
const MATCHER_KEYS = new Set(["system", "lastUser", "bodyIncludes", "hasTools", "maxTokensAtMost"]);

function fail(path: string, problem: string): never {
  throw new ScriptError(`${path}: ${problem}`);
}

function checkTextish(value: unknown, path: string): void {
  if (value === undefined || typeof value === "string") return;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return;
  fail(path, "must be a string or an array of strings");
}

function checkNumber(value: unknown, path: string, min = 0): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    fail(path, `must be a number >= ${min}`);
  }
}

export function validateReply(value: unknown, path = "reply"): ScriptReply {
  if (!isObject(value)) fail(path, "must be an object");
  for (const key of Object.keys(value)) {
    if (!REPLY_KEYS.has(key)) fail(`${path}.${key}`, "is not a reply field");
  }
  checkTextish(value.text, `${path}.text`);
  checkTextish(value.reasoning, `${path}.reasoning`);
  if (value.toolCalls !== undefined) {
    if (!Array.isArray(value.toolCalls)) fail(`${path}.toolCalls`, "must be an array");
    value.toolCalls.forEach((call, i) => {
      const at = `${path}.toolCalls[${i}]`;
      if (!isObject(call)) fail(at, "must be an object");
      if (typeof call.name !== "string") fail(`${at}.name`, "must be a string");
      if (call.id !== undefined && typeof call.id !== "string")
        fail(`${at}.id`, "must be a string");
      const args = call.arguments;
      if (args !== undefined && typeof args !== "string" && !isObject(args)) {
        checkTextish(args, `${at}.arguments`);
      }
    });
  }
  if (value.finishReason !== undefined && typeof value.finishReason !== "string") {
    fail(`${path}.finishReason`, "must be a string");
  }
  if (value.usage !== undefined) {
    if (!isObject(value.usage)) fail(`${path}.usage`, "must be an object");
    for (const k of ["promptTokens", "completionTokens", "cachedTokens"]) {
      checkNumber(value.usage[k], `${path}.usage.${k}`);
    }
  }
  if (value.pacing !== undefined) {
    if (!isObject(value.pacing)) fail(`${path}.pacing`, "must be an object");
    checkNumber(value.pacing.chunkSize, `${path}.pacing.chunkSize`, 1);
    checkNumber(value.pacing.argumentChunkSize, `${path}.pacing.argumentChunkSize`, 1);
    checkNumber(value.pacing.delayMs, `${path}.pacing.delayMs`);
    checkNumber(value.pacing.firstEventDelayMs, `${path}.pacing.firstEventDelayMs`);
    const style = value.pacing.toolCallStyle;
    if (style !== undefined && !["split", "whole", "no-index", "no-id"].includes(String(style))) {
      fail(`${path}.pacing.toolCallStyle`, 'must be "split", "whole", "no-index" or "no-id"');
    }
  }
  if (value.wire !== undefined) {
    if (!isObject(value.wire)) fail(`${path}.wire`, "must be an object");
    checkNumber(value.wire.bytesPerWrite, `${path}.wire.bytesPerWrite`, 1);
    const ending = value.wire.lineEnding;
    if (ending !== undefined && ending !== "lf" && ending !== "crlf") {
      fail(`${path}.wire.lineEnding`, 'must be "lf" or "crlf"');
    }
  }
  if (value.fault !== undefined) validateFault(value.fault, `${path}.fault`);
  return value as ScriptReply;
}

function validateFault(value: unknown, path: string): Fault {
  if (!isObject(value)) fail(path, "must be an object");
  if (typeof value.type !== "string" || !FAULT_TYPES.has(value.type)) {
    fail(`${path}.type`, `must be one of ${[...FAULT_TYPES].join(", ")}`);
  }
  if (value.type === "http") {
    if (typeof value.status !== "number" || value.status < 100 || value.status > 599) {
      fail(`${path}.status`, "must be an HTTP status");
    }
  }
  checkNumber(value.afterEvents, `${path}.afterEvents`);
  return value as Fault;
}

function validateMatcher(value: unknown, path: string): MatchSpec {
  if (typeof value === "function") return value as MatchSpec;
  if (!isObject(value)) fail(path, "must be an object");
  for (const key of Object.keys(value)) {
    if (!MATCHER_KEYS.has(key)) fail(`${path}.${key}`, "is not a matcher field");
  }
  return value as RequestMatcher;
}

/** Accepts a script as plain data (an array of replies, or `{ replies, lanes }`) and checks it. */
export function parseScript(value: unknown): Script {
  if (Array.isArray(value)) {
    return { replies: value.map((r, i) => validateReply(r, `replies[${i}]`)) };
  }
  if (!isObject(value)) fail("script", "must be an array of replies or an object");
  for (const key of Object.keys(value)) {
    if (key !== "replies" && key !== "lanes") fail(`script.${key}`, "is not a script field");
  }
  const script: Script = {};
  if (value.replies !== undefined) {
    if (!Array.isArray(value.replies)) fail("replies", "must be an array");
    script.replies = value.replies.map((r, i) => validateReply(r, `replies[${i}]`));
  }
  if (value.lanes !== undefined) {
    if (!isObject(value.lanes)) fail("lanes", "must be an object");
    const lanes: Record<string, LaneSpec> = {};
    for (const [name, lane] of Object.entries(value.lanes)) {
      if (name === MAIN_LANE)
        fail(`lanes.${name}`, `"${MAIN_LANE}" is reserved for the replies list`);
      if (!isObject(lane)) fail(`lanes.${name}`, "must be an object");
      const replies = lane.replies ?? [];
      if (!Array.isArray(replies)) fail(`lanes.${name}.replies`, "must be an array");
      lanes[name] = {
        match: validateMatcher(lane.match, `lanes.${name}.match`),
        replies: replies.map((r, i) => validateReply(r, `lanes.${name}.replies[${i}]`)),
      };
    }
    script.lanes = lanes;
  }
  return script;
}

export const MAIN_LANE = "main";

interface ChatBody {
  messages?: unknown;
  tools?: unknown;
  max_tokens?: unknown;
}

/** The text of a message's content, whether a string or an array of parts. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

export function matches(spec: MatchSpec, request: RecordedRequest): boolean {
  if (typeof spec === "function") return spec(request);
  const body = (isObject(request.body) ? request.body : {}) as ChatBody;
  const messages = Array.isArray(body.messages) ? body.messages.filter(isObject) : [];
  if (spec.system !== undefined) {
    const system = messages.find((m) => m.role === "system");
    if (!system || !contentText(system.content).includes(spec.system)) return false;
  }
  if (spec.lastUser !== undefined) {
    const users = messages.filter((m) => m.role === "user");
    const last = users[users.length - 1];
    if (!last || !contentText(last.content).includes(spec.lastUser)) return false;
  }
  if (spec.bodyIncludes !== undefined && !request.rawBody.includes(spec.bodyIncludes)) return false;
  if (spec.hasTools !== undefined) {
    const has = Array.isArray(body.tools) && body.tools.length > 0;
    if (has !== spec.hasTools) return false;
  }
  if (spec.maxTokensAtMost !== undefined) {
    if (typeof body.max_tokens !== "number" || body.max_tokens > spec.maxTokensAtMost) return false;
  }
  return true;
}
