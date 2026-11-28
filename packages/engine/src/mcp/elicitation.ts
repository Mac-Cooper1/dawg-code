/**
 * An MCP server's requests for input (the MCP specification's elicitation: `elicitation/create`,
 * form and URL modes), and the calls in progress they belong to.
 *
 * Which session asks. One connection can serve several sessions of a project at once
 * (manager.ts), and a server's request for input does not say, on the wire, which of the calls in
 * progress caused it: the SDK hands the client's handler the request alone. So each connection
 * keeps the calls in flight on it, each with the session and the tool call it is for, and a
 * request is answered by the session whose calls are the ones in progress:
 *
 * - calls of one session only: that session asks the person, on the call when there is one
 *   (`toolCallId`), or without one when several of its calls are in progress;
 * - calls of more than one session: nobody can tell whose it is, and showing it in the wrong
 *   session would leak one conversation's form into another, so it is declined, and every call
 *   in progress gets a note saying so;
 * - no call in progress (a request out of the blue): declined, since no session's person
 *   expects it, and it could not be shown next to what caused it.
 *
 * Nobody to ask (a headless run, a client without the capability, a subagent): declined at once,
 * and the call's result tells the model why. An interrupt cancels the request with the turn.
 *
 * Time spent waiting for the person does not count against the call's timeout: the clock of each
 * call the request is shown for stops while it waits and goes on with the time that was left
 * when the answer comes.
 */
import {
  type ElicitationContent,
  type ElicitationField,
  type ElicitationResponse,
  elicitationIssues,
} from "@dawg/protocol";
import type { ElicitResult } from "@modelcontextprotocol/client";
import type { ElicitationRequest, ToolContext, ToolOutput } from "../contracts/tools.ts";
import { NoOneToAskError } from "../tools/interactive/errors.ts";

/** Who a request to a server is made for: a session's call. */
export interface McpCaller {
  readonly sessionId: string;
  /** The tool call, or null (a resource read for an `@` mention). */
  readonly toolCallId: string | null;
  /**
   * Asks the person and resolves with the answer. Rejects with `NoOneToAskError` when nobody can
   * answer, and when `signal` aborts or the turn is interrupted. Null when nobody ever can.
   */
  readonly ask:
    | ((request: ElicitationRequest, signal: AbortSignal) => Promise<ElicitationResponse>)
    | null;
  /** A sentence for the model, added to the call's result. */
  note(text: string): void;
}

/** A call's time limit was reached. */
export class McpTimeoutError extends Error {
  override name = "McpTimeoutError";
}

export function nobodyNote(server: string): string {
  return `Note: the MCP server ${server} asked the person for input during this call, and dawg declined, because nobody can answer such a request in this session.`;
}

export function ambiguousNote(server: string): string {
  return `Note: the MCP server ${server} asked for input while calls from more than one session were waiting on it, and dawg declined, because it could not tell which call asked.`;
}

export function unusableNote(server: string, why: string): string {
  return `Note: the MCP server ${server} asked the person for input during this call, and dawg declined: ${why}`;
}

/** A clock for one call that can stop while the person is asked. */
class CallClock {
  #remaining: number;
  #startedAt = Date.now();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #paused = 0;
  readonly #fire: () => void;

  constructor(ms: number, fire: () => void) {
    this.#remaining = ms;
    this.#fire = fire;
    this.#arm();
  }

  #arm(): void {
    this.#startedAt = Date.now();
    this.#timer = setTimeout(this.#fire, Math.max(0, Math.min(this.#remaining, 2_147_483_647)));
    this.#timer.unref?.();
  }

  pause(): void {
    this.#paused += 1;
    if (this.#paused !== 1 || this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#remaining -= Date.now() - this.#startedAt;
  }

  resume(): void {
    if (this.#paused === 0) return;
    this.#paused -= 1;
    if (this.#paused === 0) this.#arm();
  }

  stop(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#paused = -1;
  }
}

interface InFlight {
  caller: McpCaller | null;
  clock: CallClock | null;
}

// ---------------------------------------------------------------------------------------------
// The requested schema: MCP's restricted flat object, as the protocol's fields
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The options of an enum, titled (`oneOf`/`anyOf` of consts, or the older `enumNames`) or not. */
function options(
  schema: Json,
  key: "oneOf" | "anyOf",
): { value: string; title: string | null }[] | null {
  const titled = schema[key];
  if (Array.isArray(titled)) {
    const out = titled
      .filter((o): o is Json => o !== null && typeof o === "object")
      .filter((o) => typeof o.const === "string")
      .map((o) => ({ value: o.const as string, title: text(o.title) }));
    return out.length > 0 ? out : null;
  }
  const plain = schema.enum;
  if (Array.isArray(plain) && plain.length > 0 && plain.every((v) => typeof v === "string")) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return (plain as string[]).map((value, i) => ({ value, title: text(names[i]) }));
  }
  return null;
}

/**
 * The form a requested schema describes, or why it cannot be shown. The SDK has checked the
 * request's shape already; this keeps to what the specification allows and drops nothing
 * silently.
 */
export function fieldsFromSchema(
  schema: unknown,
): { fields: ElicitationField[] } | { error: string } {
  if (schema === null || typeof schema !== "object") return { error: "it sent no form." };
  const properties = (schema as Json).properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    return { error: "its form has no fields." };
  }
  const required = new Set(
    Array.isArray((schema as Json).required) ? ((schema as Json).required as unknown[]) : [],
  );
  const fields: ElicitationField[] = [];
  for (const [name, raw] of Object.entries(properties as Json)) {
    if (raw === null || typeof raw !== "object")
      return { error: `its field ${name} is not valid.` };
    const p = raw as Json;
    const base = {
      name,
      title: text(p.title),
      description: text(p.description),
      required: required.has(name),
    };
    if (p.type === "array") {
      const items = (p.items ?? {}) as Json;
      const choices = options(items, "anyOf");
      if (choices === null) return { error: `its field ${name} is a list dawg cannot show.` };
      const fallback = Array.isArray(p.default)
        ? (p.default as unknown[]).filter((v): v is string => typeof v === "string")
        : null;
      fields.push({
        ...base,
        type: "multiselect",
        options: choices,
        minItems: count(p.minItems),
        maxItems: count(p.maxItems),
        default: fallback,
      });
      continue;
    }
    if (p.type === "string") {
      const choices = options(p, "oneOf");
      if (choices !== null) {
        fields.push({
          ...base,
          type: "select",
          options: choices,
          default: typeof p.default === "string" ? p.default : null,
        });
        continue;
      }
      const format =
        p.format === "email" ||
        p.format === "uri" ||
        p.format === "date" ||
        p.format === "date-time"
          ? p.format
          : null;
      fields.push({
        ...base,
        type: "string",
        format,
        minLength: count(p.minLength),
        maxLength: count(p.maxLength),
        default: typeof p.default === "string" ? p.default : null,
      });
      continue;
    }
    if (p.type === "number" || p.type === "integer") {
      fields.push({
        ...base,
        type: p.type,
        minimum: finite(p.minimum),
        maximum: finite(p.maximum),
        default: finite(p.default),
      });
      continue;
    }
    if (p.type === "boolean") {
      fields.push({
        ...base,
        type: "boolean",
        default: typeof p.default === "boolean" ? p.default : null,
      });
      continue;
    }
    return { error: `its field ${name} is of a kind dawg cannot show.` };
  }
  return { fields };
}

/** The longest address a URL mode request may give (the app opens up to this many). */
export const URL_MAX_CHARS = 8_192;

/** Why a URL mode request's address cannot be offered, or null when it can. */
export function urlProblem(url: string): string | null {
  // As long as a browser is handed; Claude Code caps it about here too.
  if (url.length > URL_MAX_CHARS) return "the address it gave is too long to open.";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "the address it gave is not valid.";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `dawg opens only web addresses, and this one starts with ${parsed.protocol}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// One connection's calls in flight
// ---------------------------------------------------------------------------------------------

export class McpElicitations {
  readonly #server: string;
  readonly #calls = new Set<InFlight>();

  constructor(server: string) {
    this.#server = server;
  }

  /** How many calls are in flight, for tests. */
  get inFlight(): number {
    return this.#calls.size;
  }

  /**
   * Runs a request to the server for `caller`, so a request for input it causes reaches the
   * right session. `timeoutMs` (null for none) is the call's limit, which stops while the person
   * is asked; reaching it aborts the request with `McpTimeoutError`.
   */
  async run<T>(
    caller: McpCaller | null,
    options: { signal: AbortSignal; timeoutMs: number | null; what: string },
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal.reason);
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = options.timeoutMs;
    const timedOut = new McpTimeoutError(
      `The call to ${this.#server} (${options.what}) took longer than ${Math.round((timeout ?? 0) / 1000)} s, its time limit.`,
    );
    const clock =
      timeout === null ? null : new CallClock(timeout, () => controller.abort(timedOut));
    const entry: InFlight = { caller, clock };
    this.#calls.add(entry);
    try {
      return await request(controller.signal);
    } catch (error) {
      if (controller.signal.reason === timedOut && !options.signal.aborted) throw timedOut;
      throw error;
    } finally {
      this.#calls.delete(entry);
      clock?.stop();
      options.signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * The answer to the server's `elicitation/create`: the person's, from the session whose calls
   * are in progress, or a decline when that cannot be (see the top of this file). `signal` aborts
   * when the server cancels its request.
   */
  async handle(params: Json, signal: AbortSignal): Promise<ElicitResult> {
    const server = this.#server;
    const decline: ElicitResult = { action: "decline" };
    const calls = [...this.#calls].filter(
      (c): c is InFlight & { caller: McpCaller } => c.caller !== null,
    );
    if (calls.length === 0) return decline;
    const sessions = new Set(calls.map((c) => c.caller.sessionId));
    if (sessions.size > 1) {
      for (const c of calls) c.caller.note(ambiguousNote(server));
      return decline;
    }
    const first = calls[0] as (typeof calls)[number];
    const ask = first.caller.ask;
    if (ask === null) {
      for (const c of calls) c.caller.note(nobodyNote(server));
      return decline;
    }
    const mode = params.mode === "url" ? "url" : "form";
    const message = typeof params.message === "string" ? params.message : "";
    let fields: ElicitationField[] = [];
    let url: string | null = null;
    if (mode === "form") {
      const form = fieldsFromSchema(params.requestedSchema);
      if ("error" in form) {
        for (const c of calls) c.caller.note(unusableNote(server, form.error));
        return decline;
      }
      fields = form.fields;
    } else {
      url = typeof params.url === "string" ? params.url : "";
      const problem = urlProblem(url);
      if (problem !== null) {
        for (const c of calls) c.caller.note(unusableNote(server, problem));
        return decline;
      }
    }
    const withCall = calls.filter((c) => c.caller.toolCallId !== null);
    const toolCallId = withCall.length === 1 && calls.length === 1 ? first.caller.toolCallId : null;
    for (const c of calls) c.clock?.pause();
    try {
      // The schema and id as sent, for Elicitation hooks (../hooks).
      const sent = params as { requestedSchema?: unknown; elicitationId?: unknown };
      const answer = await ask(
        {
          server,
          message,
          mode,
          fields,
          url,
          toolCallId,
          requestedSchema: mode === "form" ? (sent.requestedSchema ?? null) : null,
          elicitationId: typeof sent.elicitationId === "string" ? sent.elicitationId : null,
        },
        signal,
      );
      if (answer.action !== "accept") return { action: answer.action };
      if (mode === "url") return { action: "accept" };
      const content: ElicitationContent = answer.content ?? {};
      // The session checked it already; a second look keeps a bad answer from the server.
      if (elicitationIssues(fields, content).length > 0) return { action: "cancel" };
      return { action: "accept", content };
    } catch (error) {
      if (error instanceof NoOneToAskError) {
        for (const c of calls) c.caller.note(nobodyNote(server));
        return decline;
      }
      // Interrupted, or the server took its request back.
      return { action: "cancel" };
    } finally {
      for (const c of calls) c.clock?.resume();
    }
  }
}

/** The caller for a tool's call, and the notes a request for input left for its result. */
export function callerFor(ctx: Pick<ToolContext, "sessionId" | "toolCallId" | "session">): {
  caller: McpCaller;
  notes: string[];
} {
  const notes: string[] = [];
  const services = ctx.session;
  const elicit = services.elicit;
  return {
    notes,
    caller: {
      sessionId: ctx.sessionId,
      toolCallId: ctx.toolCallId,
      ask:
        elicit === undefined ? null : (request, signal) => elicit.call(services, request, signal),
      note: (text) => {
        if (!notes.includes(text)) notes.push(text);
      },
    },
  };
}

/** A tool's output with the notes for the model added after it. */
export function withNotes(output: ToolOutput, notes: readonly string[]): ToolOutput {
  if (notes.length === 0) return output;
  return {
    ...output,
    content: [...output.content, ...notes.map((text) => ({ type: "text" as const, text }))],
  };
}
