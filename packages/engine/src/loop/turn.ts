/**
 * The turn loop. See docs/specs/phase-2-engine-core.md, "The turn loop".
 *
 *   loop:
 *     make room           (trim or compact when the context passes the threshold)
 *     request             = prefix + tool schemas + history
 *     stream the reply    → message and reasoning deltas
 *     no tool calls       → the turn is over
 *     run the calls       → results appended in call order
 *     safe point          → notes (instructions, repeats, background commands, mode, date)
 *
 * The loop owns retry policy, because the model client never retries: an empty reply and a
 * request that fails in a way that may pass (a dropped stream, a lost connection) are each sent
 * again once; a context overflow compacts and sends again once. Notes are only ever appended
 * where they cannot separate a tool call from its result.
 */
import type { AssistantMessage, Message } from "../contracts/messages.ts";
import {
  type ModelClient,
  ModelError,
  type ModelReply,
  type ModelRequest,
} from "../contracts/model.ts";
import type { PromptPrefix, SystemNote } from "../contracts/prompt.ts";
import type { MessageExtras } from "../session/writer.ts";
import { type PreparedReply, prepareToolCalls } from "../toolcall/index.ts";
import { errorInfo, errorInfoFrom } from "./errors.ts";
import { type ExecutedCall, type ExecutorHost, executeToolCalls } from "./executor.ts";
import { RepeatDetector } from "./repeat.ts";
import type { LoopLimits, LoopResult } from "./types.ts";

/** What room-making did. "failed" leaves history as it was. */
export type RoomResult = "ok" | "compacted" | "failed" | "interrupted";

export interface TurnHost extends ExecutorHost {
  readonly loopLimits: LoopLimits;
  /** The client and the per-request fields (sampling, effort, slot...) for the next request. */
  model(): {
    client: ModelClient;
    options: Omit<ModelRequest, "messages" | "tools" | "signal">;
  };
  prefix(): PromptPrefix;
  /** The model's view after the system message: session context, then history. */
  view(): readonly Message[];
  isCallIdTaken(id: string): boolean;
  appendMessage(message: Message, extras?: MessageExtras): Promise<void>;
  appendNote(note: SystemNote): Promise<void>;
  /** Appends the notes that wait for a safe point (mode, date, background commands...). */
  flushNotes(): Promise<void>;
  /** Called after a batch's results are all in history: instruction files for touched paths. */
  afterToolBatch(executed: readonly ExecutedCall[]): Promise<void>;
  /**
   * Accounts one finished request and emits `usage.updated`. `requestViewLength` is how many
   * messages of the view the request held, so later growth can be estimated on top of it.
   */
  recordUsage(reply: ModelReply, malformedCalls: number, requestViewLength: number): void;
  /** Trims or compacts when needed; with `overflow`, because the model said it does not fit. */
  makeRoom(turnId: string, signal: AbortSignal, overflow: boolean): Promise<RoomResult>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

interface Partial_ {
  text: string;
  reasoning: string;
}

type Attempt =
  | { kind: "reply"; reply: ModelReply }
  | { kind: "interrupted"; partial: Partial_ }
  | { kind: "error"; error: unknown; partial: Partial_ };

export async function runTurn(
  host: TurnHost,
  turn: { turnId: string; signal: AbortSignal },
): Promise<LoopResult> {
  const { turnId, signal } = turn;
  const limits = host.loopLimits;
  const repeats = new RepeatDetector();
  let requests = 0;
  let lastText: string | null = null;
  let cutOffInARow = 0;
  /** Notes the loop itself raised, appended at the next safe point. */
  const pending: SystemNote[] = [];

  const appendPending = async (): Promise<void> => {
    while (pending.length > 0) await host.appendNote(pending.shift() as SystemNote);
  };

  const interrupted = async (): Promise<LoopResult> => {
    await host.appendNote({ type: "interrupted" });
    return { stopReason: "interrupted", finalText: lastText, error: null };
  };

  while (true) {
    if (signal.aborted) return interrupted();
    if (requests >= limits.maxRequestsPerTurn) {
      return { stopReason: "turn_limit", finalText: lastText, error: null };
    }

    const room = await host.makeRoom(turnId, signal, false);
    if (room === "interrupted" || signal.aborted) return interrupted();

    const messageId = host.newId("message");
    let started = false;
    const ensureStarted = () => {
      if (started) return;
      started = true;
      host.emit("message.started", { turnId, messageId });
    };
    const finishMessage = (text: string, reasoning: string, calls: PreparedReply["calls"]) => {
      ensureStarted();
      host.emit("message.finished", {
        turnId,
        messageId,
        text,
        reasoning: reasoning === "" ? null : reasoning,
        toolCalls: calls.map((c) => ({ toolCallId: c.call.id, toolName: c.call.name })),
      });
    };

    const attempt = await requestWithRetries(host, turnId, signal, ensureStarted, messageId);
    if (attempt.kind === "interrupted") {
      const { text, reasoning } = attempt.partial;
      if (text !== "" || reasoning !== "") {
        // Keep what the person already saw; calls are dropped, since none of them is complete.
        const partial: AssistantMessage = { role: "assistant", content: text, toolCalls: [] };
        if (reasoning !== "") partial.reasoning = reasoning;
        await host.appendMessage(partial, { info: { finishReason: "unknown" } });
        if (text.trim() !== "") lastText = text;
      }
      if (started) finishMessage(text, reasoning, []);
      return interrupted();
    }
    if (attempt.kind === "error") {
      if (started) finishMessage(attempt.partial.text, attempt.partial.reasoning, []);
      return { stopReason: "error", finalText: lastText, error: errorInfoFrom(attempt.error) };
    }

    const reply = attempt.reply;
    requests += 1;
    // Nothing is appended while a request runs, so this is the view the request was built from.
    const requestViewLength = host.view().length;
    const tools = host.prefix().tools;
    const prepared = prepareToolCalls(reply, tools, {
      newId: () => host.newId("call"),
      isIdTaken: (id) => host.isCallIdTaken(id),
    });

    const cutOff = reply.finishReason === "length";
    if (isEmpty(reply) && !cutOff) {
      // Sent twice and empty twice.
      if (started) finishMessage("", reply.reasoning, []);
      host.recordUsage(reply, prepared.malformedCount, requestViewLength);
      return {
        stopReason: "error",
        finalText: lastText,
        error: errorInfo(
          "invalid_model_output",
          "The model sent an empty reply twice in a row.",
          null,
          true,
        ),
      };
    }

    const usable = prepared.content.trim() !== "" || prepared.calls.length > 0;
    if (usable) {
      const message: AssistantMessage = {
        role: "assistant",
        content: prepared.content,
        toolCalls: prepared.calls.map((c) => c.call),
      };
      if (reply.reasoning !== "") message.reasoning = reply.reasoning;
      await host.appendMessage(message, {
        info: { model: reply.model, finishReason: reply.finishReason, usage: reply.usage },
      });
      lastText = prepared.content.trim() === "" ? null : prepared.content;
    }
    finishMessage(prepared.content, reply.reasoning, prepared.calls);
    host.recordUsage(reply, prepared.malformedCount, requestViewLength);

    if (prepared.notice !== null) pending.push({ type: "text", text: prepared.notice });
    if (cutOff) {
      pending.push({ type: "output_truncated" });
      cutOffInARow = usable ? 0 : cutOffInARow + 1;
      if (cutOffInARow >= limits.maxCutOffInARow) {
        await appendPending();
        return {
          stopReason: "error",
          finalText: lastText,
          error: errorInfo(
            "invalid_model_output",
            "The model's replies kept stopping at the output limit before anything usable was written.",
            null,
            true,
          ),
        };
      }
    } else {
      cutOffInARow = 0;
    }

    if (prepared.calls.length === 0) {
      if (!cutOff) return { stopReason: "completed", finalText: lastText, error: null };
      // Cut off mid-text: let the model carry on, told to send less at once.
      await appendPending();
      continue;
    }

    const executed = await executeToolCalls(prepared.calls, { turnId, messageId, signal }, host);
    if (signal.aborted) return interrupted();

    let repeatedTimes = 0;
    let repeatedTool = "";
    for (const e of executed) {
      const times = repeats.observe(e.call, e.result);
      if (times >= repeatedTimes) {
        repeatedTimes = times;
        repeatedTool = e.call.name;
      }
    }
    await host.afterToolBatch(executed);
    if (repeatedTimes >= limits.repeatStopAt) {
      await appendPending();
      return {
        stopReason: "error",
        finalText: lastText,
        error: errorInfo(
          "repetition",
          `The model made the same ${repeatedTool} call with the same result ${repeatedTimes} times in a row, so the turn was stopped.`,
          null,
          true,
        ),
      };
    }
    if (repeatedTimes >= limits.repeatNoteAt) {
      pending.push({ type: "repeating", toolName: repeatedTool, times: repeatedTimes });
    }
    await appendPending();
    await host.flushNotes();
  }
}

/** No text and no calls. Reasoning alone gives the person nothing. */
function isEmpty(reply: ModelReply): boolean {
  return reply.content.trim() === "" && reply.toolCalls.length === 0;
}

async function requestWithRetries(
  host: TurnHost,
  turnId: string,
  signal: AbortSignal,
  ensureStarted: () => void,
  messageId: string,
): Promise<Attempt> {
  let retriedEmpty = false;
  let retriedFailure = false;
  let retriedOverflow = false;
  while (true) {
    const partial: Partial_ = { text: "", reasoning: "" };
    const { client, options } = host.model();
    const prefix = host.prefix();
    const request: ModelRequest = {
      ...options,
      messages: [prefix.system, ...host.view()],
      tools: prefix.tools,
      signal,
    };
    let reply: ModelReply | null = null;
    try {
      for await (const event of client.stream(request)) {
        switch (event.type) {
          case "prompt_progress":
            host.emit("prompt.progress", {
              turnId,
              total: event.total,
              cached: event.cached,
              processed: event.processed,
            });
            break;
          case "text_delta":
            ensureStarted();
            partial.text += event.text;
            host.emit("message.delta", { turnId, messageId, text: event.text });
            break;
          case "reasoning_delta":
            ensureStarted();
            partial.reasoning += event.text;
            host.emit("reasoning.delta", { turnId, messageId, text: event.text });
            break;
          case "tool_call_started":
          case "tool_call_delta":
            ensureStarted();
            break;
          case "finished":
            reply = event.reply;
            break;
        }
      }
    } catch (error) {
      if (signal.aborted || (error instanceof ModelError && error.kind === "aborted")) {
        return { kind: "interrupted", partial };
      }
      if (error instanceof ModelError && error.kind === "context_overflow") {
        if (retriedOverflow) return { kind: "error", error, partial };
        retriedOverflow = true;
        const room = await host.makeRoom(turnId, signal, true);
        if (room === "interrupted" || signal.aborted) return { kind: "interrupted", partial };
        if (room === "failed" || room === "ok") return { kind: "error", error, partial };
        continue;
      }
      if (error instanceof ModelError && error.retryable && !retriedFailure) {
        retriedFailure = true;
        await host.sleep(host.loopLimits.retryDelayMs, signal);
        if (signal.aborted) return { kind: "interrupted", partial };
        continue;
      }
      return { kind: "error", error, partial };
    }
    if (reply === null) {
      return {
        kind: "error",
        error: new ModelError("invalid_response", "the stream ended without a reply"),
        partial,
      };
    }
    if (isEmpty(reply) && reply.finishReason !== "length" && !retriedEmpty) {
      retriedEmpty = true;
      continue;
    }
    return { kind: "reply", reply };
  }
}
