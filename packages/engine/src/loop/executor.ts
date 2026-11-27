/**
 * Runs the tool calls of one reply: permission, execution, results.
 *
 * For each call, in the model's order: a call the pipeline could not use gets its error as the
 * result and is not run. Otherwise the tool reports its permission subject, the permission engine
 * decides, and the call runs (allow), is refused (deny), or waits for the person (ask). Read-only
 * calls next to each other run at the same time; everything else runs alone, in order. Results
 * are appended to history in call order whatever order they finish in, and each is appended as
 * soon as every result before it is, so a crash loses as little as possible.
 *
 * Every call gets `tool.started`, any `tool.progress`, then exactly one `tool.finished`, also
 * when the turn is interrupted: a call still without a result then gets an "interrupted" one,
 * because chat templates require every call to have its result.
 */
import type {
  ContentPart,
  PermissionRequest,
  PermissionResponse,
  ToolDisplay,
  ToolOutcome,
} from "@dawg/protocol";
import type { ToolCall, ToolResultMessage } from "../contracts/messages.ts";
import type {
  PermissionDecision,
  PermissionEngine,
  PermissionQuery,
  PermissionState,
} from "../contracts/permissions.ts";
import type { AnyTool, ToolContext, ToolOutput, ToolProbeContext } from "../contracts/tools.ts";
import { denialMessage, describePermissionRequest } from "../permissions/index.ts";
import type { PreparedCall } from "../toolcall/index.ts";
import type { Emit, IdKind, LoopLimits } from "./types.ts";

export interface ExecutorHost {
  readonly tools: ReadonlyMap<string, AnyTool>;
  readonly permissions: PermissionEngine;
  readonly limits: Pick<LoopLimits, "maxResultChars" | "resultPreviewChars">;
  readonly emit: Emit;
  now(): number;
  newId(kind: IdKind): string;
  /** The state decisions are made against, read fresh for every call (the mode can change). */
  permissionState(): PermissionState;
  probeContext(): ToolProbeContext;
  /** False when nobody can answer a permission prompt; an ask then becomes a deny. */
  canAskPermission(): boolean;
  /**
   * Raises a permission request and waits for the person's answer. Rejects when `signal` aborts;
   * the host then reports the request as cancelled.
   */
  askPermission(
    request: PermissionRequest,
    turnId: string,
    signal: AbortSignal,
  ): Promise<PermissionResponse>;
  /**
   * A permission request raised for this call before the session restarted, which the person
   * answers (or has answered) on the card brought back: their answer stands, whatever the rules
   * would decide now. Null when there is none (the usual case).
   */
  restoredPermission?(toolCallId: string): RestoredPermission | null;
  /** Saves "allow always" rules and applies them to the running session. Never throws. */
  allowAlways(rules: readonly string[]): Promise<void>;
  toolContext(call: { turnId: string; toolCallId: string; signal: AbortSignal }): ToolContext;
  /** Appends a result to history (and the transcript). */
  appendResult(
    message: ToolResultMessage,
    extras: { display?: ToolDisplay; durationMs?: number },
  ): Promise<void>;
  /** Saves an oversized result; returns the file's absolute path. */
  saveOutput(name: string, content: string): Promise<string>;
  /**
   * Makes note look-alikes harmless in text from outside the engine (`PromptAssembler.quote`).
   * Applied to every result before it enters history, so no output can pass for a note.
   */
  quote(text: string): string;
}

export interface ExecutedCall {
  call: ToolCall;
  result: ToolResultMessage;
  outcome: ToolOutcome;
  display: ToolDisplay | null;
  /** Files a successful run reported reading or writing (absolute paths). */
  touched: { read: string[]; written: string[] };
  /** Null when the tool never ran. */
  durationMs: number | null;
}

export interface RestoredPermission {
  /** The rules "always allow" saves when the answer names none: the request's suggestions. */
  suggestions: readonly string[];
  /** The person's answer. Rejects when `signal` aborts; the host then cancels the request. */
  wait(signal: AbortSignal): Promise<PermissionResponse>;
}

export interface BatchContext {
  turnId: string;
  /** The assistant message that made the calls. */
  messageId: string;
  signal: AbortSignal;
  /**
   * Calls whose `tool.started` went out before the session restarted (a turn carried on after
   * it waited on the person): they are not announced twice.
   */
  alreadyStarted?: ReadonlySet<string>;
}

interface Settled {
  content: ContentPart[];
  isError: boolean;
  outcome: ToolOutcome;
  display: ToolDisplay | null;
  touched: { read: string[]; written: string[] };
  durationMs: number | null;
}

const NOTHING_TOUCHED = { read: [], written: [] };

export async function executeToolCalls(
  calls: readonly PreparedCall[],
  batch: BatchContext,
  host: ExecutorHost,
): Promise<ExecutedCall[]> {
  const results: (ExecutedCall | undefined)[] = calls.map(() => undefined);
  const started = calls.map(() => false);
  let appended = 0;
  let appending: Promise<void> = Promise.resolve();

  // Appends every result that is ready and whose predecessors are all in; one writer at a time.
  const flush = (): Promise<void> => {
    appending = appending.then(async () => {
      while (appended < calls.length) {
        const done = results[appended];
        if (done === undefined) return;
        await host.appendResult(done.result, {
          ...(done.display === null ? {} : { display: done.display }),
          ...(done.durationMs === null ? {} : { durationMs: done.durationMs }),
        });
        appended += 1;
      }
    });
    return appending;
  };

  const finish = (index: number, settled: Settled): void => {
    const prepared = calls[index] as PreparedCall;
    const call = prepared.call;
    const marked = settled.isError ? markAsError(settled.content) : settled.content;
    const content = marked.map((p) =>
      p.type === "text" ? { type: "text" as const, text: host.quote(p.text) } : p,
    );
    const result: ToolResultMessage = {
      role: "tool",
      toolCallId: call.id,
      toolName: call.name,
      content,
      isError: settled.isError,
    };
    results[index] = {
      call,
      result,
      outcome: settled.outcome,
      display: settled.display,
      touched: settled.touched,
      durationMs: settled.durationMs,
    };
    host.emit("tool.finished", {
      turnId: batch.turnId,
      toolCallId: call.id,
      toolName: call.name,
      outcome: settled.outcome,
      content,
      display: settled.display,
      durationMs: settled.durationMs,
    });
  };

  const start = (index: number): void => {
    const prepared = calls[index] as PreparedCall;
    started[index] = true;
    if (batch.alreadyStarted?.has(prepared.call.id) === true) return;
    host.emit("tool.started", {
      turnId: batch.turnId,
      messageId: batch.messageId,
      toolCallId: prepared.call.id,
      toolName: prepared.call.name,
      input: inputOf(prepared),
    });
  };

  const runOne = async (index: number): Promise<void> => {
    start(index);
    const settled = await settle(calls[index] as PreparedCall, batch, host);
    finish(index, settled);
    await flush();
  };

  let i = 0;
  while (i < calls.length && !batch.signal.aborted) {
    if (runsConcurrently(calls[i] as PreparedCall, host)) {
      let j = i;
      while (j < calls.length && runsConcurrently(calls[j] as PreparedCall, host)) j += 1;
      const group: Promise<void>[] = [];
      for (let k = i; k < j; k++) group.push(runOne(k));
      await Promise.all(group);
      i = j;
    } else {
      await runOne(i);
      i += 1;
    }
  }

  // Interrupted: every call still without a result gets one, so history stays valid.
  for (let k = 0; k < calls.length; k++) {
    if (results[k] !== undefined) continue;
    const ran = started[k] === true;
    if (!ran) start(k);
    finish(k, {
      content: [
        {
          type: "text",
          text: ran
            ? "Interrupted: the person stopped the turn before this call finished."
            : "Interrupted: the person stopped the turn before this call ran.",
        },
      ],
      isError: true,
      outcome: "interrupted",
      display: null,
      touched: NOTHING_TOUCHED,
      durationMs: null,
    });
  }
  await flush();
  return results as ExecutedCall[];
}

/** Read-only calls that will actually run may share the stage with each other. */
function runsConcurrently(call: PreparedCall, host: ExecutorHost): boolean {
  if (call.status !== "ready") return false;
  return host.tools.get(call.tool.name)?.readOnly === true;
}

function inputOf(call: PreparedCall): Record<string, unknown> {
  if (call.status === "ready") return call.input;
  try {
    const parsed: unknown = JSON.parse(call.call.arguments);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The pipeline always records an object; fall through to an empty one regardless.
  }
  return {};
}

function textResult(
  text: string,
  outcome: ToolOutcome,
  isError: boolean,
  durationMs: number | null = null,
): Settled {
  return {
    content: [{ type: "text", text }],
    isError,
    outcome,
    display: null,
    touched: NOTHING_TOUCHED,
    durationMs,
  };
}

const INTERRUPTED_WAITING =
  "Interrupted: the person stopped the turn while this call waited for permission.";

async function settle(
  prepared: PreparedCall,
  batch: BatchContext,
  host: ExecutorHost,
): Promise<Settled> {
  if (prepared.status !== "ready") return textResult(prepared.error, "invalid", true);
  const call = prepared.call;
  const tool = host.tools.get(prepared.tool.name);
  if (tool === undefined) {
    return textResult(`The tool ${call.name} is not available in this session.`, "invalid", true);
  }
  if (batch.signal.aborted) {
    return textResult(
      "Interrupted: the person stopped the turn before this call ran.",
      "interrupted",
      true,
    );
  }

  // Permission. An answer given on a card brought back after a restart stands as it is.
  let answer: PermissionResponse | null = null;
  let suggestions: readonly string[] = [];
  const restored = host.restoredPermission?.(call.id) ?? null;
  if (restored !== null) {
    suggestions = restored.suggestions;
    try {
      answer = await restored.wait(batch.signal);
    } catch (error) {
      if (batch.signal.aborted) return textResult(INTERRUPTED_WAITING, "interrupted", true);
      return textResult(
        `Denied: the permission request failed (${errorMessage(error)}), so this call was not run.`,
        "denied",
        true,
      );
    }
  } else {
    const state = host.permissionState();
    let query: PermissionQuery;
    try {
      query = {
        toolName: tool.name,
        subject: tool.permission(prepared.input, host.probeContext()),
      };
    } catch (error) {
      return textResult(
        `Denied: the permission check for this call failed (${errorMessage(error)}), so it was not run.`,
        "denied",
        true,
      );
    }
    const decision: PermissionDecision = host.permissions.decide(query, state);
    if (decision.behavior === "deny") return textResult(decision.message, "denied", true);
    if (decision.behavior === "ask") {
      const wording = { cwd: state.cwd, homeDir: state.homeDir };
      if (!host.canAskPermission()) {
        return textResult(
          denialMessage(query, decision.reason, { ...wording, dontAsk: true }),
          "denied",
          true,
        );
      }
      const { title, reason } = describePermissionRequest(query, decision, wording);
      const request: PermissionRequest = {
        requestId: host.newId("request"),
        toolCallId: call.id,
        toolName: tool.name,
        input: prepared.input,
        title,
        reason,
        suggestions: decision.suggestions,
      };
      suggestions = decision.suggestions;
      try {
        answer = await host.askPermission(request, batch.turnId, batch.signal);
      } catch (error) {
        if (batch.signal.aborted) return textResult(INTERRUPTED_WAITING, "interrupted", true);
        return textResult(
          `Denied: the permission request failed (${errorMessage(error)}), so this call was not run.`,
          "denied",
          true,
        );
      }
    }
  }
  if (answer !== null) {
    if (answer.behavior === "deny") {
      const said = answer.message?.trim() ?? "";
      return textResult(
        `Denied: the person did not allow this ${tool.name} call.${said === "" ? "" : ` They said: ${said}`} Do not try it again unchanged; adjust your approach or ask what they would prefer.`,
        "denied",
        true,
      );
    }
    if (answer.scope === "always") {
      const rules = answer.rules ?? suggestions;
      if (rules.length > 0) await host.allowAlways(rules);
    }
  }

  // Execution.
  if (batch.signal.aborted) {
    return textResult(
      "Interrupted: the person stopped the turn before this call ran.",
      "interrupted",
      true,
    );
  }
  const startedAt = host.now();
  let output: ToolOutput;
  try {
    output = await tool.execute(
      prepared.input,
      host.toolContext({ turnId: batch.turnId, toolCallId: call.id, signal: batch.signal }),
    );
  } catch (error) {
    const durationMs = Math.max(0, host.now() - startedAt);
    if (batch.signal.aborted) {
      return textResult(
        "Interrupted: the person stopped the turn before this call finished.",
        "interrupted",
        true,
        durationMs,
      );
    }
    return textResult(
      `Error: ${tool.name} failed: ${errorMessage(error)}`,
      "error",
      true,
      durationMs,
    );
  }
  const durationMs = Math.max(0, host.now() - startedAt);
  const isError = output.isError === true;
  const content = await spillIfLarge(output.content, call, host);
  return {
    content,
    isError,
    // A tool that stops on the interrupt reports it in its own result (the output so far).
    outcome: isError ? (batch.signal.aborted ? "interrupted" : "error") : "success",
    display: output.display ?? null,
    touched: isError
      ? NOTHING_TOUCHED
      : { read: output.touched?.read ?? [], written: output.touched?.written ?? [] },
    durationMs,
  };
}

/**
 * The chat format has no error flag on tool results, so an error result must say so in its own
 * words. Results that already open with a clear marker are left alone.
 */
function markAsError(content: ContentPart[]): ContentPart[] {
  const index = content.findIndex((p) => p.type === "text");
  const first = content[index];
  if (first === undefined || first.type !== "text") {
    return [{ type: "text", text: "Error: the call failed." }, ...content];
  }
  if (/^\s*(error|denied|interrupted)\b/i.test(first.text)) return content;
  const out = content.slice();
  out[index] = { type: "text", text: `Error: ${first.text}` };
  return out;
}

/** Replaces text too long to give the model whole by a preview and the path of the full text. */
async function spillIfLarge(
  content: ContentPart[],
  call: ToolCall,
  host: ExecutorHost,
): Promise<ContentPart[]> {
  const texts = content.filter(
    (p): p is Extract<ContentPart, { type: "text" }> => p.type === "text",
  );
  const full = texts.map((p) => p.text).join("\n");
  if (full.length <= host.limits.maxResultChars) return content;
  const preview = full.slice(0, host.limits.resultPreviewChars);
  const size = full.length.toLocaleString("en-US");
  let tail: string;
  try {
    const file = await host.saveOutput(`${call.name}-${call.id}.txt`, full);
    tail = `[The full result is ${size} characters long, too long to show here. It was saved to ${file}. Read it in parts with Read (offset and limit), or search it with Grep.]`;
  } catch (error) {
    tail = `[The full result is ${size} characters long, too long to show here, and could not be saved (${errorMessage(error)}). Narrow the request to get a shorter result.]`;
  }
  const images = content.filter((p) => p.type !== "text");
  return [{ type: "text", text: `${preview}\n\n${tail}` }, ...images];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
