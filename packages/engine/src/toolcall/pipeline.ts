/**
 * The whole tool-call pipeline for one model reply: recover calls written as text, resolve tool
 * names, parse and repair arguments, coerce and validate them, and assign ids. Every call comes
 * out either ready to run or with the exact tool-result text to give the model instead.
 * See docs/specs/phase-2-engine-core.md, "Tool-call pipeline".
 */
import type { ToolCall } from "../contracts/messages.ts";
import type { ModelReply, ToolSchema } from "../contracts/model.ts";
import type { Coercion } from "./coerce.ts";
import {
  invalidArgumentsMessage,
  TRUNCATED_UNNAMED_CALL_NOTICE,
  truncatedCallMessage,
  unknownToolMessage,
  unparseableArgumentsMessage,
  unreadableProseCallMessage,
} from "./errors.ts";
import { type ArgumentsParse, parseToolArguments, type RepairKind } from "./json-parse.ts";
import { MCP_DISPATCHER, resolveToolName } from "./names.ts";
import { type ProseFormat, type RecoveredCall, recoverProseCalls } from "./prose.ts";
import { validateToolInput } from "./validate.ts";
import { serializeArguments } from "./values.ts";

export interface PrepareOptions {
  /**
   * Returns a new call id. Called, in call order, only for calls the model gave no id or a
   * repeated one, so the result is deterministic for a deterministic generator.
   */
  newId: () => string;
  /** Ids already used earlier in the session. A model id that collides is replaced. */
  isIdTaken?: (id: string) => boolean;
}

/** What was changed to make a call usable. All empty for a clean call. */
export interface CallFixes {
  /** Repairs to the argument text. */
  repairs: RepairKind[];
  /** Coercions applied to the parsed arguments (ready calls only). */
  coercions: Coercion[];
  /** The name the model wrote, when it was corrected to a tool's real name. */
  nameCorrectedFrom: string | null;
  /** How the call was written, when it was recovered from the reply's text. */
  proseFormat: ProseFormat | null;
}

interface CallBase {
  /** The call to record in history. `arguments` always parses as a JSON object. */
  call: ToolCall;
  fixes: CallFixes;
  /** True when anything about the call was wrong, even if it was fixed. */
  malformed: boolean;
}

export interface ReadyCall extends CallBase {
  status: "ready";
  tool: ToolSchema;
  /** The validated input, identical to `JSON.parse(call.arguments)`. */
  input: Record<string, unknown>;
}

export type InvalidReason =
  /** The reply hit the output limit while this call was being written. */
  | "truncated"
  /** The arguments could not be read as a JSON object. */
  | "unparseable"
  /** The arguments parsed but do not satisfy the schema. */
  | "schema";

export interface InvalidCall extends CallBase {
  status: "invalid";
  tool: ToolSchema;
  reason: InvalidReason;
  /** The tool-result text for the model. The tool must not be run. */
  error: string;
}

export interface UnknownToolCall extends CallBase {
  status: "unknown_tool";
  /** The tool-result text for the model, listing the available tools. */
  error: string;
}

export type PreparedCall = ReadyCall | InvalidCall | UnknownToolCall;

export interface PreparedReply {
  /** The reply text, with call markup removed when calls were recovered from it. */
  content: string;
  /** One entry per call, in the order the model made them. */
  calls: PreparedCall[];
  /** True when the calls were found in the reply's text rather than the structured channel. */
  recoveredFromProse: boolean;
  /** Calls that were not perfect as sent, including repaired ones. For usage reporting. */
  malformedCount: number;
  /**
   * Text for the turn loop to give the model when the reply was cut off while starting a call
   * that could not be recorded (no tool was named yet). Null otherwise.
   */
  notice: string | null;
}

interface Pending {
  id: string;
  name: string;
  arguments: string;
  truncated: boolean;
  prose: RecoveredCall | null;
}

/**
 * Turns one model reply's tool calls into calls that are ready to run or errors for the model.
 * Pure: no I/O, no clock; never throws for any reply.
 */
export function prepareToolCalls(
  reply: Pick<ModelReply, "content" | "toolCalls" | "finishReason">,
  tools: readonly ToolSchema[],
  options: PrepareOptions,
): PreparedReply {
  const cutOff = reply.finishReason === "length";
  let content = reply.content;
  let recovered = false;
  let notice: string | null = null;
  let pending: Pending[];

  if (reply.toolCalls.length > 0) {
    pending = reply.toolCalls.map((c, i) => ({
      id: c.id,
      name: c.name,
      arguments: c.arguments,
      // The output limit stopped the reply, so the last call was still being written.
      truncated: cutOff && i === reply.toolCalls.length - 1,
      prose: null,
    }));
  } else {
    const found = recoverProseCalls(reply.content, tools, reply.finishReason);
    content = found.content;
    recovered = found.calls.length > 0;
    if (found.unnamedTruncated) notice = TRUNCATED_UNNAMED_CALL_NOTICE;
    pending = found.calls.map((c, i) => ({
      id: "",
      name: c.name,
      arguments: c.arguments,
      truncated: cutOff && c.unterminated && i === found.calls.length - 1,
      prose: c,
    }));
  }

  const ids = idAssigner(options);
  const calls = pending.map((p) => prepareOne(p, ids(p.id), tools));
  return {
    content,
    calls,
    recoveredFromProse: recovered,
    malformedCount: calls.filter((c) => c.malformed).length,
    notice,
  };
}

function idAssigner(options: PrepareOptions): (given: string) => string {
  const used = new Set<string>();
  const taken = (id: string) => used.has(id) || (options.isIdTaken?.(id) ?? false);
  return (given) => {
    let id = given;
    if (id === "" || taken(id)) {
      let attempt = 0;
      do {
        id = options.newId();
        attempt++;
      } while ((id === "" || taken(id)) && attempt < 100);
      // A generator that keeps repeating itself still must not produce duplicates.
      const base = id === "" ? "call" : id;
      for (let n = 2; id === "" || taken(id); n++) id = `${base}-${n}`;
    }
    used.add(id);
    return id;
  };
}

function prepareOne(p: Pending, id: string, tools: readonly ToolSchema[]): PreparedCall {
  const proseFormat = p.prose?.format ?? null;
  const fixes = (extra: Partial<CallFixes> = {}): CallFixes => ({
    repairs: [],
    coercions: [],
    nameCorrectedFrom: null,
    proseFormat,
    ...extra,
  });

  const resolved = resolveToolName(p.name, tools);
  if (!resolved.found) {
    const parsed = parseToolArguments(p.arguments);
    // An MCP tool called by its listed name where only the dispatcher is offered goes through it.
    if (p.name.startsWith("mcp__") && parsed.ok && tools.some((t) => t.name === MCP_DISPATCHER)) {
      const through = prepareOne(
        {
          ...p,
          name: MCP_DISPATCHER,
          arguments: JSON.stringify({ name: p.name, arguments: parsed.value }),
        },
        id,
        tools,
      );
      return { ...through, fixes: { ...through.fixes, nameCorrectedFrom: p.name } };
    }
    return {
      status: "unknown_tool",
      call: recordCall(id, p.name, p.arguments, parsed),
      error: unknownToolMessage(p.name, tools, resolved.suggestion),
      fixes: fixes({ repairs: parsed.ok ? parsed.repairs : [] }),
      malformed: true,
    };
  }

  const tool = resolved.tool;
  const nameCorrectedFrom = resolved.correctedFrom;
  if (p.truncated) {
    return {
      status: "invalid",
      reason: "truncated",
      tool,
      call: withRaw({ id, name: tool.name, arguments: "{}" }, p.arguments),
      error: truncatedCallMessage(tool.name),
      fixes: fixes({ nameCorrectedFrom }),
      malformed: true,
    };
  }
  if (p.prose?.failure) {
    return {
      status: "invalid",
      reason: "unparseable",
      tool,
      call: { id, name: tool.name, arguments: "{}" },
      error: unreadableProseCallMessage(tool, p.prose.failure),
      fixes: fixes({ nameCorrectedFrom }),
      malformed: true,
    };
  }

  const parsed = parseToolArguments(p.arguments);
  if (!parsed.ok) {
    return {
      status: "invalid",
      reason: "unparseable",
      tool,
      call: recordCall(id, tool.name, p.arguments, parsed),
      error: unparseableArgumentsMessage(tool, parsed.failure, p.arguments),
      fixes: fixes({ nameCorrectedFrom }),
      malformed: true,
    };
  }

  const checked = validateToolInput(tool, parsed.value);
  if (!checked.ok) {
    return {
      status: "invalid",
      reason: "schema",
      tool,
      call: recordCall(id, tool.name, p.arguments, parsed),
      error: invalidArgumentsMessage(tool, checked.issues, parsed.value),
      fixes: fixes({ repairs: parsed.repairs, nameCorrectedFrom }),
      malformed: true,
    };
  }

  const changed = parsed.repaired || checked.coercions.length > 0;
  const text = serializeArguments(checked.value);
  return {
    status: "ready",
    tool,
    input: checked.value,
    call: changed
      ? withRaw({ id, name: tool.name, arguments: text }, p.arguments)
      : { id, name: tool.name, arguments: text },
    fixes: fixes({ repairs: parsed.repairs, coercions: checked.coercions, nameCorrectedFrom }),
    malformed: changed || nameCorrectedFrom !== null || p.prose !== null,
  };
}

/**
 * The call as history records it: the repaired arguments when they parsed, `{}` when they did not
 * (llama.cpp refuses a request whose history holds arguments that are not a JSON object).
 */
function recordCall(id: string, name: string, raw: string, parsed: ArgumentsParse): ToolCall {
  if (!parsed.ok) return withRaw({ id, name, arguments: "{}" }, raw);
  const text = serializeArguments(parsed.value);
  return parsed.repaired
    ? withRaw({ id, name, arguments: text }, raw)
    : { id, name, arguments: text };
}

/**
 * Keeps the model's own text when it differs from what is recorded. Differences of formatting
 * alone (spacing, key quoting that parses the same) are not kept: callers only pass `raw` here
 * when the content changed.
 */
function withRaw(call: ToolCall, raw: string): ToolCall {
  return raw === call.arguments ? call : { ...call, rawArguments: raw };
}
