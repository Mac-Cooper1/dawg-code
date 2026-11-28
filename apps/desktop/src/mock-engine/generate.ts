/**
 * Events the engine makes up when no recording covers what happened: a reply to a prompt past
 * the recorded turns, the rest of a turn after an unrecorded answer, a compaction, and the
 * events that close a turn on interrupt. They follow the same rules and pacing as recordings.
 */
import type {
  ContentPart,
  ElicitationResponse,
  PendingRequest,
  PermissionMode,
  PermissionResponse,
  PlanResponse,
  Prompt,
  QuestionResponse,
  ToolDisplay,
  ToolOutcome,
  Usage,
} from "@dawg/protocol";
import type { Step } from "./player.ts";
import { scaledDelay } from "./player.ts";
import {
  deniedText,
  INTERRUPTED_RUNNING,
  INTERRUPTED_WAITING,
  planText,
  questionText,
} from "./results.ts";
import type { MockSession } from "./session.ts";
import { toolCallOf } from "./state.ts";
import { compactAtFor, contextBreakdown, INSTRUCTION_TOKENS, PREFIX_TOKENS } from "./usage.ts";

const DEFAULT_WINDOW = 204_800;

/** The status of a session whose turn runs (or that compacts), not waiting for the model. */
export const WORKING = { status: "working", waitingOn: null, queuePosition: null } as const;
/** The status of a session with nothing running. */
export const IDLE = {
  status: "idle",
  waitingOn: null,
  message: null,
  queuePosition: null,
} as const;

export type Decision =
  | { kind: "permission"; response: PermissionResponse }
  | { kind: "question"; response: QuestionResponse }
  | { kind: "plan"; response: PlanResponse }
  | { kind: "elicitation"; response: ElicitationResponse };

/** Timing for generated events, from the engine's playback speed. */
export interface Pace {
  speed: number;
  /** A deterministic jitter in [0, 1), so tests see the same pacing every run. */
  random(): number;
}

function delay(pace: Pace, min: number, max: number): number {
  return scaledDelay(min + Math.floor(pace.random() * (max - min + 1)), pace.speed);
}

/** About 3.6 characters per token, as in the recordings. */
function tokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

/** Splits text into pieces of one or two words, keeping whitespace, as a model streams. */
function chunks(text: string, pace: Pace): string[] {
  const words = text.match(/\S+\s*|\s+/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    const size = pace.random() < 0.5 ? 1 : 2;
    out.push(words.slice(i, i + size).join(""));
    i += size;
  }
  return out;
}

export function promptText(prompt: Prompt): string {
  return prompt.content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** A short title from a prompt's first line, as a title model might write it. */
export function titleFrom(prompt: Prompt): string {
  const line = promptText(prompt)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined) return "Image prompt";
  const sentence = line.split(/(?<=[.!?])\s/)[0] ?? line;
  let title = sentence.replace(/[.!?:;,\s]+$/, "").replace(/\s+/g, " ");
  if (title.length > 50) {
    const cut = title.slice(0, 50);
    title = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 30)).replace(/[,;:\s]+$/, "")}…`;
  }
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** The usage after one more model request: `added` new prompt tokens, `completion` written. */
export function nextUsage(session: MockSession, added: number, completion: number): Usage {
  const before = session.state.usage;
  const window = session.modelInfo?.contextWindow ?? before?.contextWindow ?? DEFAULT_WINDOW;
  const cached = before === null ? PREFIX_TOKENS : before.contextUsed;
  const prompt = before === null ? PREFIX_TOKENS + INSTRUCTION_TOKENS + added : cached + added;
  const totals = before?.totals;
  const contextUsed = prompt + completion;
  return {
    contextWindow: window,
    contextUsed,
    last: {
      promptTokens: prompt,
      completionTokens: completion,
      cachedTokens: cached,
      promptTokensPerSecond: 1_236.4,
      completionTokensPerSecond: 40.8,
    },
    totals: {
      requests: (totals?.requests ?? 0) + 1,
      promptTokens: (totals?.promptTokens ?? 0) + prompt,
      completionTokens: (totals?.completionTokens ?? 0) + completion,
      cachedTokens: (totals?.cachedTokens ?? 0) + cached,
      malformedToolCalls: totals?.malformedToolCalls ?? 0,
    },
    compactAt: compactAtFor(window),
    breakdown: breakdownAfter(session, contextUsed),
  };
}

/** The split of `contextUsed`, keeping the fixed parts the session's last usage reported. */
export function breakdownAfter(session: MockSession, contextUsed: number) {
  const previous = session.state.usage?.breakdown;
  return previous ? contextBreakdown(contextUsed, previous) : contextBreakdown(contextUsed);
}

/** One streamed assistant message with its usage, as steps. */
function messageSteps(
  session: MockSession,
  pace: Pace,
  turnId: string,
  text: string,
  added: number,
): Step[] {
  const messageId = session.ids.fresh("message");
  const steps: Step[] = [];
  const parts = chunks(text, pace);
  parts.forEach((part, i) => {
    steps.push({
      delay: i === 0 ? delay(pace, 500, 900) : delay(pace, 40, 90),
      run: () => {
        if (i === 0) session.emit("message.started", { turnId, messageId });
        session.emit("message.delta", { turnId, messageId, text: part });
      },
    });
  });
  steps.push({
    delay: delay(pace, 10, 40),
    run: () => {
      session.emit("message.finished", { turnId, messageId, text, reasoning: null, toolCalls: [] });
      session.emit("usage.updated", { usage: nextUsage(session, added, tokens(text)) });
    },
  });
  return steps;
}

/** The end of a turn: `turn.finished`, then the status, with the length measured now. */
function finishSteps(session: MockSession, pace: Pace, turnId: string, finalText: string): Step[] {
  return [
    {
      delay: delay(pace, 20, 60),
      run: () => {
        const now = session.now();
        session.emit("turn.finished", {
          turnId,
          stopReason: "completed",
          finalText,
          error: null,
          durationMs: Math.max(0, now - (session.state.turn?.startedAt ?? now)),
        });
        session.emit("session.status", IDLE);
      },
    },
  ];
}

/** The reply to a prompt that no recording covers. */
export function genericReply(session: MockSession, prompt: Prompt): string {
  const text = promptText(prompt).trim();
  const first = text.split("\n")[0]?.trim() ?? "";
  const shown = first.length > 80 ? `${first.slice(0, 79)}…` : first;
  const images = prompt.content.filter((part) => part.type === "image").length;
  const lines = [
    "This is dawg’s **mock engine**, so nothing ran: no model read your message, and no files or commands were touched.",
    "",
    "What arrived:",
    "",
    shown === "" ? "- No text" : `- Your message: “${shown}”`,
  ];
  if (images > 0) lines.push(`- ${images === 1 ? "One image" : `${images} images`}`);
  const mentions = prompt.mentions.map((m) => `\`${m.path}\``);
  lines.push(
    mentions.length === 0 ? "- No files mentioned" : `- Files mentioned: ${mentions.join(", ")}`,
  );
  lines.push(`- Working directory: \`${session.settings.cwd}\``);
  lines.push("", "The recorded sessions in the sidebar show what real runs look like.");
  return lines.join("\n");
}

/**
 * A generated turn: working, `turn.started` (both sent at once, so the turn id is known when the
 * prompt is answered), then a streamed reply. Returns the turn id and the steps still to play.
 */
export function genericTurn(
  session: MockSession,
  pace: Pace,
  prompt: Prompt,
): { turnId: string; steps: Step[] } {
  session.emit("session.status", { ...WORKING, message: "Working" });
  const turnId = session.ids.fresh("turn");
  session.emit("turn.started", { turnId, prompt, command: null });
  const reply = genericReply(session, prompt);
  const steps = [
    ...messageSteps(session, pace, turnId, reply, tokens(promptText(prompt)) + 12),
    ...finishSteps(session, pace, turnId, reply),
  ];
  return { turnId, steps };
}

/**
 * The mode an approved plan continues in, as the real engine picks it: the one the answer names,
 * else the request's `modeBeforePlan`.
 */
export function modeAfterPlan(
  session: MockSession,
  request: PendingRequest,
  response: PlanResponse,
): PermissionMode | null {
  if (response.decision !== "approve") return null;
  const before = request.kind === "plan" ? request.modeBeforePlan : null;
  const next = response.mode ?? before ?? session.planReturnMode;
  return next === "plan" ? "default" : next;
}

/** The result the model gets for the call a decision ended, worded as the real tools word it. */
export function decisionResult(
  request: PendingRequest,
  decision: Decision,
  mode: PermissionMode,
): { outcome: ToolOutcome; content: string; durationMs: number | null } {
  switch (decision.kind) {
    case "permission":
      if (decision.response.behavior === "deny") {
        const toolName = request.kind === "permission" ? request.request.toolName : "tool";
        return {
          outcome: "denied",
          content: deniedText(toolName, decision.response.message),
          durationMs: null,
        };
      }
      return {
        outcome: "success",
        content:
          "(mock engine) Allowed. There is no recording of what this call does, so nothing ran.",
        durationMs: 0,
      };
    case "question": {
      const questions = request.kind === "question" ? request.questions : [];
      return {
        outcome: "success",
        content: questionText(questions, decision.response),
        durationMs: null,
      };
    }
    case "plan":
      return { outcome: "success", content: planText(decision.response, mode), durationMs: null };
    case "elicitation":
      return {
        outcome: "success",
        content: elicitationText(request, decision.response),
        durationMs: null,
      };
  }
}

/** What a mock MCP server answers once the person dealt with its request for input. */
function elicitationText(request: PendingRequest, response: ElicitationResponse): string {
  const server = request.kind === "elicitation" ? request.server : "The server";
  if (response.action === "decline") return `${server}: you declined, so nothing was created.`;
  if (response.action === "cancel") return `${server}: the request was cancelled.`;
  if (request.kind === "elicitation" && request.mode === "url") {
    return `${server}: thanks, carry on in the page that opened.`;
  }
  return `${server}: created it with ${JSON.stringify(response.content ?? {})}.`;
}

/**
 * The rest of a turn after an answer no recording covers: the call ends with the answer's
 * result, then a short reply ends the turn. If other requests still wait, only the call ends.
 */
export function genericContinuation(
  session: MockSession,
  pace: Pace,
  request: PendingRequest,
  decision: Decision,
): Step[] {
  const turnId = request.turnId;
  const toolCallId = toolCallOf(request);
  const othersPending = session.state.pending.size > 0;
  const steps: Step[] = [];
  steps.push({
    delay: delay(pace, 120, 300),
    run: () => {
      if (!othersPending) {
        session.emit("session.status", { ...WORKING, message: "Working" });
      }
      let mode = session.settings.mode;
      if (decision.kind === "plan") {
        const next = modeAfterPlan(session, request, decision.response);
        if (next !== null && next !== session.settings.mode) {
          session.updateSettings({ mode: next }, ["mode"]);
          mode = next;
        }
      }
      const tool = session.state.tools.get(toolCallId);
      if (tool) {
        const result = decisionResult(request, decision, mode);
        session.emit("tool.finished", {
          turnId,
          toolCallId,
          toolName: tool.toolName,
          outcome: result.outcome,
          content: [{ type: "text", text: result.content }],
          display: null,
          durationMs:
            decision.kind === "permission"
              ? result.durationMs
              : Math.max(0, session.now() - tool.startedAt),
        });
      }
    },
  });
  if (othersPending) return steps;
  steps.push({
    delay: 0,
    run: () => {
      for (const [id, tool] of session.state.tools) {
        if (tool.turnId !== turnId) continue;
        session.emit("tool.finished", {
          turnId,
          toolCallId: id,
          toolName: tool.toolName,
          outcome: "error",
          content: [
            {
              type: "text",
              text: "Error: the mock engine has no recording of this call's result.",
            },
          ],
          display: null,
          durationMs: null,
        });
      }
    },
  });
  const text =
    "That is as far as the recording goes: the mock engine has nothing recorded for this answer, so the turn ends here.";
  steps.push(...messageSteps(session, pace, turnId, text, 60));
  steps.push(...finishSteps(session, pace, turnId, text));
  return steps;
}

/**
 * Closes everything open when a turn is interrupted, in protocol order: pending requests are
 * cancelled, a streaming message finishes with what it has, running calls finish "interrupted",
 * then `turn.finished` and the idle status.
 */
export function interruptTurn(session: MockSession, now: number): void {
  const turn = session.state.turn;
  if (turn === null) return;
  const { turnId } = turn;
  // Worked out first: cancelling a permission request ends the call's wait.
  const tools = [...session.state.tools].map(
    ([toolCallId, tool]) => [toolCallId, tool, interruptedResult(session, tool, now)] as const,
  );
  for (const request of [...session.state.pending.values()]) {
    session.emit("request.resolved", {
      kind: request.kind,
      turnId: request.turnId,
      requestId: request.kind === "permission" ? request.request.requestId : request.requestId,
      outcome: "cancelled",
      response: null,
    });
  }
  let partial: string | null = null;
  for (const [messageId, message] of [...session.state.messages]) {
    session.emit("message.finished", {
      turnId: message.turnId,
      messageId,
      text: message.text,
      reasoning: message.reasoning === "" ? null : message.reasoning,
      toolCalls: [],
    });
    if (message.text.trim() !== "") partial = message.text;
  }
  for (const [toolCallId, tool, result] of tools) {
    session.emit("tool.finished", {
      turnId: tool.turnId,
      toolCallId,
      toolName: tool.toolName,
      outcome: "interrupted",
      content: [{ type: "text", text: result.content }],
      display: result.display,
      durationMs: result.durationMs,
    });
  }
  session.emit("turn.finished", {
    turnId,
    stopReason: "interrupted",
    finalText: session.state.turn?.lastText ?? partial,
    error: null,
    durationMs: Math.max(0, now - turn.startedAt),
  });
  session.emit("session.status", IDLE);
}

/** The Bash tool's note after the output of a command it stopped. */
export const INTERRUPTED_COMMAND = "The command was interrupted.";

function interruptedResult(
  session: MockSession,
  tool: {
    toolName: string;
    input: Record<string, unknown>;
    startedAt: number;
    output: string;
    waiting: boolean;
  },
  now: number,
): { content: string; display: ToolDisplay | null; durationMs: number | null } {
  if (tool.waiting) return { content: INTERRUPTED_WAITING, display: null, durationMs: null };
  const durationMs = Math.max(0, now - tool.startedAt);
  if (tool.toolName !== "Bash" || typeof tool.input.command !== "string") {
    return { content: INTERRUPTED_RUNNING, display: null, durationMs };
  }
  // As the Bash tool reports it: the output so far, a note, marked as an error for the model.
  const body = tool.output.replace(/\n+$/, "");
  return {
    content: `Error: ${body ? `${body}\n\n` : ""}${INTERRUPTED_COMMAND}`,
    display: {
      kind: "command",
      command: tool.input.command,
      cwd: session.settings.cwd,
      exitCode: null,
      durationMs,
      timedOut: false,
      interrupted: true,
      backgroundTaskId: null,
      outputPath: null,
      output: body,
      notes: [INTERRUPTED_COMMAND],
    },
    durationMs,
  };
}

/** `/compact`: the summary that replaces the history, as the mock engine writes it. */
export function compactionSummary(session: MockSession): string {
  const turns = session.state.turns;
  const title = session.settings.title ?? "an untitled session";
  return [
    `Summary of "${title}" so far (${turns} ${turns === 1 ? "turn" : "turns"}), written by the mock engine without a model.`,
    "Recent work and open tasks are kept; earlier tool output is dropped.",
  ].join(" ");
}

/** Context left after compacting: about 29% of what there was, never below the prefix. */
export function contextAfterCompaction(before: number): number {
  return Math.min(before, Math.max(PREFIX_TOKENS + INSTRUCTION_TOKENS, Math.round(before * 0.29)));
}
