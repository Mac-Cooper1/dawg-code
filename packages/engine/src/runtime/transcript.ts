/**
 * Facts the runtime reads back out of a session's transcript records: turn boundaries, calls left
 * without results, usage totals, and events for sessions whose event log is missing (forks, and
 * sessions written by other tools).
 *
 * Turn ids are derived from the transcript: a turn is named after the sequence number of the
 * record holding its prompt (`turn-<seq>`). That makes them stable across resume and fork (a
 * fork copies records with their numbers) and lets a fork point name a turn without any index.
 */
import type { ContentPart, EventName, PermissionMode, ToolOutcome, Usage } from "@dawg/protocol";
import type { Message, ToolCall } from "../contracts/messages.ts";
import type { EventFields } from "../loop/types.ts";
import type { SessionRecord } from "../session/index.ts";

export function turnIdFor(promptSeq: number): string {
  return `turn-${promptSeq}`;
}

/** The prompt record's sequence number, or null when the id is not one of ours. */
export function promptSeqOf(turnId: string): number | null {
  const match = /^turn-(\d+)$/.exec(turnId);
  return match ? Number(match[1]) : null;
}

/** Sequence numbers of the records that start turns (the person's prompts), ascending. */
export function promptSeqs(records: readonly SessionRecord[]): number[] {
  return records.filter((r) => r.type === "user").map((r) => r.seq);
}

/**
 * Where a record's message sits in the model's current view: its index, or null when it is not
 * in the view (before the latest compaction, or not a message). Rebuilds the view's shape from
 * the records as the store's replay does.
 */
export function viewIndexOfRecord(records: readonly SessionRecord[], seq: number): number | null {
  let length = 0;
  let index: number | null = null;
  for (const record of records) {
    if (record.type === "compact") {
      length = record.messages.length;
      index = null;
      continue;
    }
    if (
      record.type === "user" ||
      record.type === "assistant" ||
      record.type === "note" ||
      record.type === "tool_result"
    ) {
      if (record.seq === seq) index = length;
      length += 1;
    }
  }
  return index;
}

/** Calls of the view's last assistant message that have no result after it, in call order. */
export function danglingCalls(view: readonly Message[]): ToolCall[] {
  for (let i = view.length - 1; i >= 0; i--) {
    const message = view[i] as Message;
    if (message.role !== "assistant") continue;
    if (message.toolCalls.length === 0) return [];
    const answered = new Set<string>();
    for (const later of view.slice(i + 1)) {
      if (later.role === "tool") answered.add(later.toolCallId);
    }
    return message.toolCalls.filter((c) => !answered.has(c.id));
  }
  return [];
}

/** Every call id the session has used, so a model id that repeats one is replaced. */
export function callIds(records: readonly SessionRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const r of records) {
    if (r.type === "assistant") for (const c of r.message.toolCalls) ids.add(c.id);
    if (r.type === "compact") {
      for (const m of r.messages)
        if (m.role === "assistant") for (const c of m.toolCalls) ids.add(c.id);
    }
  }
  return ids;
}

/** The mode the session was in before it last entered plan mode. */
export function modeBeforePlan(records: readonly SessionRecord[]): PermissionMode {
  let mode: PermissionMode = "default";
  let before: PermissionMode = "default";
  for (const r of records) {
    if (r.type !== "state" || r.changes.mode === undefined) continue;
    if (r.changes.mode === "plan" && mode !== "plan") before = mode;
    mode = r.changes.mode;
  }
  return before;
}

/** The text of the first prompt in the transcript, for the title. */
export function firstPromptText(records: readonly SessionRecord[]): string | null {
  for (const r of records) {
    if (r.type !== "user") continue;
    const text = r.message.content
      .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
    if (text !== "") return text;
  }
  return null;
}

/**
 * Files the model read or changed since the last full compaction, in the order the calls were
 * made, taken from the structured views stored with the results. Replaying them through the
 * instruction set marks the instruction files they made relevant as already delivered.
 */
export function touchedSinceCompaction(
  records: readonly SessionRecord[],
  isTrimRecord: (summary: string) => boolean,
): string[] {
  let start = 0;
  records.forEach((r, i) => {
    if (r.type === "compact" && !isTrimRecord(r.summary)) start = i + 1;
  });
  const paths: string[] = [];
  for (const r of records.slice(start)) {
    if (r.type !== "tool_result" || r.message.isError || r.display === undefined) continue;
    if (r.display.kind === "file" || r.display.kind === "diff") paths.push(r.display.filePath);
  }
  return paths;
}

/**
 * Usage totals rebuilt from the replies stored in the transcript. The context size is the last
 * reply's, or the size a later compaction left. `compactAt` and `breakdown` need the session's
 * profile and prefix, so they are null here; the runtime fills them in.
 */
export function usageFromRecords(
  records: readonly SessionRecord[],
  contextWindow: number,
): Usage | null {
  const totals = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    malformedToolCalls: 0,
  };
  let last: Usage["last"] | null = null;
  let contextUsed = 0;
  for (const r of records) {
    if (r.type === "compact") {
      if (r.tokensAfter != null) contextUsed = r.tokensAfter;
      continue;
    }
    if (r.type !== "assistant") continue;
    totals.malformedToolCalls += r.message.toolCalls.filter(
      (c) => c.rawArguments !== undefined,
    ).length;
    const u = r.info?.usage;
    if (u === undefined) continue;
    totals.requests += 1;
    totals.promptTokens += u.promptTokens ?? 0;
    totals.completionTokens += u.completionTokens ?? 0;
    totals.cachedTokens += u.cachedTokens ?? 0;
    last = {
      promptTokens: u.promptTokens,
      completionTokens: u.completionTokens,
      cachedTokens: u.cachedTokens,
      promptTokensPerSecond: u.promptTokensPerSecond,
      completionTokensPerSecond: u.completionTokensPerSecond,
    };
    contextUsed = (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
  }
  if (last === null) return null;
  return {
    contextWindow,
    contextUsed: Math.min(Math.max(0, Math.round(contextUsed)), Number.MAX_SAFE_INTEGER),
    last: intLast(last),
    totals,
    compactAt: null,
    breakdown: null,
  };
}

function intLast(last: Usage["last"]): Usage["last"] {
  const int = (n: number | null) => (n === null ? null : Math.max(0, Math.round(n)));
  const num = (n: number | null) => (n === null ? null : Math.max(0, n));
  return {
    promptTokens: int(last.promptTokens),
    completionTokens: int(last.completionTokens),
    cachedTokens: int(last.cachedTokens),
    promptTokensPerSecond: num(last.promptTokensPerSecond),
    completionTokensPerSecond: num(last.completionTokensPerSecond),
  };
}

export interface SynthesizedEvent<E extends EventName = EventName> {
  event: E;
  fields: EventFields<E>;
  time: number;
}

/** A best reading of how a stored result came about, for events rebuilt from records. */
function outcomeOf(content: readonly ContentPart[], isError: boolean): ToolOutcome {
  if (!isError) return "success";
  const first = content.find((p) => p.type === "text");
  const text = first?.type === "text" ? first.text : "";
  if (/^\s*(error:\s*)?interrupted\b/i.test(text)) return "interrupted";
  if (/^\s*(error:\s*)?denied\b/i.test(text)) return "denied";
  if (/was not run\b|^\s*(error:\s*)?there is no tool named\b/i.test(text)) return "invalid";
  return "error";
}

/**
 * Events that describe a transcript, for a session that has none stored: each turn, its messages,
 * its calls and their results, task lists and compactions. Streaming events are not invented.
 */
export function eventsFromRecords(records: readonly SessionRecord[]): SynthesizedEvent[] {
  const out: SynthesizedEvent[] = [];
  const push = <E extends EventName>(event: E, fields: EventFields<E>, time: number) => {
    out.push({ event, fields, time } as SynthesizedEvent);
  };
  let turn: { id: string; start: number; lastText: string | null } | null = null;
  let open = new Map<string, string>();
  const closeTurn = (time: number) => {
    if (turn === null) return;
    for (const [toolCallId, toolName] of open) {
      push(
        "tool.finished",
        {
          turnId: turn.id,
          toolCallId,
          toolName,
          outcome: "interrupted",
          content: [
            { type: "text", text: "Interrupted: the session stopped before this call finished." },
          ],
          display: null,
          durationMs: null,
        },
        time,
      );
    }
    open = new Map();
    push(
      "turn.finished",
      {
        turnId: turn.id,
        stopReason: "completed",
        finalText: turn.lastText,
        error: null,
        durationMs: Math.max(0, time - turn.start),
      },
      time,
    );
    turn = null;
  };

  for (const r of records) {
    const time = Date.parse(r.time);
    switch (r.type) {
      case "user":
        closeTurn(time);
        turn = { id: turnIdFor(r.seq), start: time, lastText: null };
        push(
          "turn.started",
          { turnId: turn.id, prompt: { content: r.message.content, mentions: [] }, command: null },
          time,
        );
        break;
      case "assistant": {
        if (turn === null) break;
        const messageId = `message-${r.seq}`;
        push("message.started", { turnId: turn.id, messageId }, time);
        push(
          "message.finished",
          {
            turnId: turn.id,
            messageId,
            text: r.message.content,
            reasoning: r.message.reasoning ?? null,
            toolCalls: r.message.toolCalls.map((c) => ({ toolCallId: c.id, toolName: c.name })),
          },
          time,
        );
        turn.lastText = r.message.content.trim() === "" ? null : r.message.content;
        for (const call of r.message.toolCalls) {
          let input: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(call.arguments);
            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
              input = parsed as Record<string, unknown>;
            }
          } catch {
            // Stored arguments always parse; an empty object is the safe fallback regardless.
          }
          open.set(call.id, call.name);
          push(
            "tool.started",
            { turnId: turn.id, messageId, toolCallId: call.id, toolName: call.name, input },
            time,
          );
        }
        break;
      }
      case "tool_result": {
        if (turn === null || !open.has(r.message.toolCallId)) break;
        open.delete(r.message.toolCallId);
        push(
          "tool.finished",
          {
            turnId: turn.id,
            toolCallId: r.message.toolCallId,
            toolName: r.message.toolName,
            outcome: outcomeOf(r.message.content, r.message.isError),
            content: r.message.content,
            display: r.display ?? null,
            durationMs: r.durationMs ?? null,
          },
          time,
        );
        break;
      }
      case "state":
        if (r.changes.tasks !== undefined) push("tasks.updated", { tasks: r.changes.tasks }, time);
        break;
      case "compact": {
        const compactionId = `compaction-${r.seq}`;
        const before = Math.max(0, Math.round(r.tokensBefore ?? 0));
        push(
          "compaction.started",
          {
            compactionId,
            trigger: r.trigger,
            turnId: (turn as { id: string } | null)?.id ?? null,
            contextUsed: before,
            contextWindow: 0,
            focus: r.focus ?? null,
          },
          time,
        );
        push(
          "compaction.finished",
          {
            compactionId,
            outcome: "completed",
            summary: r.summary,
            contextBefore: before,
            contextAfter: r.tokensAfter == null ? null : Math.max(0, Math.round(r.tokensAfter)),
            error: null,
          },
          time,
        );
        break;
      }
      default:
        break;
    }
  }
  const lastTime =
    records.length > 0 ? Date.parse((records[records.length - 1] as SessionRecord).time) : 0;
  closeTurn(lastTime);
  return out;
}
