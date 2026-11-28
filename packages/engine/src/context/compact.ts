/**
 * Compaction (docs/specs/phase-2-engine-core.md, "Context accounting and compaction").
 *
 * 1. One summarising request: the session's own system message, tools and history, unchanged,
 *    then a note asking for a structured summary. Because everything before that note is the
 *    prompt the slot already holds, the server reuses its cache and processes only the note.
 * 2. A new view: the original session-context message, a note with the summary and the task
 *    list, a note with fresh copies of the recently used files, then the most recent turns word
 *    for word. The view ends where the old one ended, so a turn compacted part-way through can
 *    go on at once.
 *
 * Decisions:
 * - Recent turns: whole turns from the end, at most `maxKeptTurns` (3) and within `keptShare`
 *   (15%) of the window. When even the latest turn does not fit (one long task), its prompt is
 *   kept with as many of its latest steps as fit, cut between steps. Steps are kept whole, so
 *   every kept call has its result.
 * - Reasoning in kept turns is kept: Qwen3.8 and Laguna are trained with their earlier reasoning
 *   in context and their cards ask for it. Reasoning and images of older turns go with those
 *   turns into the summary. Images in kept turns are kept.
 * - Files: the most recent `maxFiles` (5), each whole if under `maxFileTokens` (5,000) and while
 *   they fit in `filesShare` (10%) of the window; the others are named, not shown.
 * - A summarising request too large for the window: the history sent is shrunk until it fits,
 *   in this order: old tool results are replaced by a line saying they were left out (oldest
 *   first, the last few messages untouched), then old reasoning is dropped, then the oldest
 *   turns are dropped whole. This gives up the cached prefix for that one request, which is
 *   unavoidable once it no longer fits. Summarising in stages was rejected: it costs a model
 *   call per stage, and a summary of a summary loses the user's words first.
 * - An empty summary (no text, only reasoning or tool calls) is asked for once more; if it is
 *   still empty, a summary is built from the history itself (the user's messages and the files
 *   touched). A summary cut off by the output limit is kept, marked as cut off; its sections are
 *   ordered so the most important come first.
 */
import type { AssistantMessage, Message, UserMessage } from "../contracts/messages.ts";
import {
  type ModelClient,
  ModelError,
  type ModelReply,
  type ModelRequest,
} from "../contracts/model.ts";
import type {
  CompactionInput,
  CompactionResult,
  Compactor,
  TokenEstimator,
} from "../contracts/prompt.ts";
import { noteMessage } from "../prompt/notes.ts";
import { createTokenEstimator, textTokens } from "./estimate.ts";
import {
  type FilesNotePlan,
  fallbackSummary,
  filesNote,
  partialSummaryRequestBody,
  summaryNote,
  summaryRequestMessage,
} from "./summary.ts";
import { trimLargestResult } from "./trim.ts";
import { normalizePairs, type Span, splitSteps, splitTurns } from "./view.ts";

export interface CompactorOptions {
  estimator?: TokenEstimator;
  /** The most recent turns kept word for word, at most. */
  maxKeptTurns?: number;
  /** Share of the context window the kept turns may use. */
  keptShare?: number;
  /** Share of the context window the re-included files may use. */
  filesShare?: number;
  /** Files re-included, at most. */
  maxFiles?: number;
  /** A file larger than this, in tokens, is named instead of shown. */
  maxFileTokens?: number;
  /**
   * The largest summary reply to ask for, in tokens. Thinking models spend part of it reasoning.
   * It is also capped at a fifth of the window.
   */
  summaryMaxTokens?: number;
}

/**
 * Request settings that change how a prompt is rendered, so the summarising request must repeat
 * the session's own values to hit its cache: Qwen3.8 writes the reasoning effort into the system
 * prompt, and template options travel in `extraBody`. `CompactionInput` has no fields for them
 * yet (proposed as a contract change); a caller that knows them passes them here.
 */
export interface CompactionRequestOptions {
  reasoningEffort?: string;
  parallelToolCalls?: boolean;
  extraBody?: Readonly<Record<string, unknown>>;
}

export type CompactionInputWithOptions = CompactionInput & CompactionRequestOptions;

const DEFAULTS = {
  maxKeptTurns: 3,
  keptShare: 0.15,
  filesShare: 0.1,
  maxFiles: 5,
  maxFileTokens: 5_000,
  summaryMaxTokens: 16_384,
};

/** Messages at the end of history that shrinking leaves alone while it has other choices. */
const PROTECTED_TAIL = 6;
const CUT_OFF_MARK = "[The summary was cut off here by the output limit.]";

type Estimate = (messages: readonly Message[]) => number;

export function createCompactor(options: CompactorOptions = {}): Compactor {
  const estimator = options.estimator ?? createTokenEstimator();
  const settings = { ...DEFAULTS, ...options };
  return {
    compact: (input) => compact(input as CompactionInputWithOptions, estimator, settings),
    trimLargestResult: (history, targetTokens) =>
      trimLargestResult(history, targetTokens, estimator),
  };
}

async function compact(
  input: CompactionInputWithOptions,
  estimator: TokenEstimator,
  settings: typeof DEFAULTS,
): Promise<CompactionResult> {
  const window = input.client.endpoint.contextWindow;
  const reserve = Math.max(256, Math.min(settings.summaryMaxTokens, Math.floor(window / 5)));
  const tools = input.prefix.tools;
  const system = input.prefix.system;

  // From a point (rewind's "summarise from here"): the request names where that part starts.
  const from = input.from;
  const askFor = (retry: boolean): Message =>
    from === undefined
      ? summaryRequestMessage(input.focus, retry)
      : noteMessage(
          partialSummaryRequestBody(promptStart(input.history[from]), input.focus, retry),
        );
  const request = (history: readonly Message[], retry: boolean): ModelRequest => {
    const req: ModelRequest = {
      messages: [system, ...history, askFor(retry)],
      tools,
      maxOutputTokens: reserve,
      signal: input.signal,
    };
    if (input.sampling !== undefined) req.sampling = input.sampling;
    if (input.slot !== undefined) req.slot = input.slot;
    if (input.reasoningEffort !== undefined) req.reasoningEffort = input.reasoningEffort;
    if (input.parallelToolCalls !== undefined) req.parallelToolCalls = input.parallelToolCalls;
    if (input.extraBody !== undefined) req.extraBody = input.extraBody;
    return req;
  };

  // How big the summarising request is: exactly where the endpoint counts, else estimated. An
  // exact count also corrects the estimates used while shrinking.
  const first = request(input.history, false);
  const estimated = estimator.estimate({ messages: first.messages, tools });
  const exact = await countOrNull(input.client, first);
  let scale = exact !== null && estimated > 0 ? exact / estimated : 1;
  const estimate: Estimate = (history) =>
    Math.ceil(
      estimator.estimate({
        messages: [system, ...history, askFor(false)],
        tools,
      }) * scale,
    );

  let limit = window - reserve;
  let sent = (exact ?? estimated) <= limit ? input.history : shrink(input.history, limit, estimate);

  let reply: ModelReply;
  try {
    reply = await complete(input.client, request(sent, false));
  } catch (error) {
    if (!(error instanceof ModelError) || error.kind !== "context_overflow") throw error;
    // The estimate was too low. Learn from the server's own count, then try once more.
    const reported = error.promptTokens;
    const ours = estimate(sent);
    if (reported !== null && ours > 0) scale *= reported / ours;
    limit = Math.floor((error.contextWindow ?? window) - reserve) - 256;
    sent = shrink(input.history, limit, estimate);
    reply = await complete(input.client, request(sent, false));
  }

  let usage = reply.usage;
  let summary = summaryText(reply);
  if (summary === "") {
    reply = await complete(input.client, request(sent, true));
    usage = reply.usage;
    summary = summaryText(reply);
  }
  if (summary === "") summary = fallbackSummary(input.history.slice(from ?? 0));
  else if (reply.finishReason === "length") summary = `${summary}\n\n${CUT_OFF_MARK}`;

  return {
    summary,
    messages: buildView(input, summary, estimator, settings, window),
    usage,
  };
}

async function countOrNull(client: ModelClient, request: ModelRequest): Promise<number | null> {
  try {
    return await client.countTokens({ messages: request.messages, tools: request.tools });
  } catch {
    return null;
  }
}

async function complete(client: ModelClient, request: ModelRequest): Promise<ModelReply> {
  for await (const event of client.stream(request)) {
    if (event.type === "finished") return event.reply;
  }
  throw new ModelError("invalid_response", "The summarising request ended without a reply.");
}

/** The reply's text, without a reasoning block a server failed to separate. */
function summaryText(reply: ModelReply): string {
  return reply.content.replace(/^\s*<think>[\s\S]*?<\/think>/, "").trim();
}

// ---------------------------------------------------------------------------------------------
// Shrinking a history that does not fit in one summarising request
// ---------------------------------------------------------------------------------------------

function leftOut(tokens: number): string {
  return `[This output was left out of the summary request to fit the context window; it was about ${tokens} tokens.]`;
}

/**
 * The history with the least removed that fits `limit`. Throws a context-overflow `ModelError`
 * when even the session context and the latest turn alone do not fit.
 */
export function shrink(history: readonly Message[], limit: number, estimate: Estimate): Message[] {
  let view = [...history];
  if (estimate(view) <= limit) return view;
  const protectedFrom = Math.max(1, view.length - PROTECTED_TAIL);

  // 1. Old tool results, oldest first.
  for (let i = 0; i < protectedFrom; i++) {
    const m = view[i] as Message;
    if (m.role !== "tool" || isLeftOut(m)) continue;
    const tokens = Math.round(
      m.content.reduce((n, p) => n + (p.type === "text" ? textTokens(p.text) : 1_500), 0),
    );
    view[i] = { ...m, content: [{ type: "text", text: leftOut(tokens) }] };
    if (estimate(view) <= limit) return view;
  }
  // 2. Old reasoning, oldest first.
  for (let i = 0; i < protectedFrom; i++) {
    const m = view[i] as Message;
    if (m.role !== "assistant" || !m.reasoning) continue;
    const { reasoning: _dropped, ...rest } = m;
    view[i] = rest satisfies AssistantMessage;
    if (estimate(view) <= limit) return view;
  }
  // 3. The oldest turns, whole, keeping the session context and the latest turn.
  const turns = splitTurns(view, 1);
  let dropped = 0;
  for (let k = 0; k < turns.length - 1; k++) {
    dropped++;
    const keepFrom = (turns[k + 1] as Span).start;
    const candidate = [view[0] as Message, droppedTurnsNote(dropped), ...view.slice(keepFrom)];
    if (estimate(candidate) <= limit) return candidate;
  }
  if (turns.length > 1) {
    view = [
      view[0] as Message,
      droppedTurnsNote(dropped),
      ...view.slice((turns.at(-1) as Span).start),
    ];
  }
  // 4. Every remaining tool result.
  for (let i = 1; i < view.length; i++) {
    const m = view[i] as Message;
    if (m.role !== "tool" || isLeftOut(m)) continue;
    view[i] = { ...m, content: [{ type: "text", text: leftOut(0) }] };
    if (estimate(view) <= limit) return view;
  }
  throw new ModelError(
    "context_overflow",
    "The conversation is too large to summarise: even its latest turn does not fit in the context window.",
  );
}

function isLeftOut(m: Message): boolean {
  if (m.role !== "tool") return false;
  const part = m.content[0];
  return (
    m.content.length === 1 &&
    part?.type === "text" &&
    part.text.startsWith("[This output was left out")
  );
}

/** The text of the message a partial summary starts at, to point the model at it. */
function promptStart(message: Message | undefined): string {
  if (message === undefined || message.role !== "user") return "";
  return message.content
    .map((p) => (p.type === "text" ? p.text : "[image]"))
    .join(" ")
    .trim();
}

function droppedTurnsNote(count: number): UserMessage {
  return noteMessage(
    `${count === 1 ? "One earlier turn was" : `${count} earlier turns were`} left out of this summary request because the conversation did not fit in the context window.`,
  );
}

// ---------------------------------------------------------------------------------------------
// The new view
// ---------------------------------------------------------------------------------------------

function buildView(
  input: CompactionInput,
  summary: string,
  estimator: TokenEstimator,
  settings: typeof DEFAULTS,
  window: number,
): Message[] {
  const history = input.history;
  const head = history[0];
  const sessionContext = head?.role === "user" && head.kind === "note" ? head : null;
  const from = sessionContext === null ? 0 : 1;
  const tokens = (messages: readonly Message[]) =>
    messages.length === 0 ? 0 : estimator.estimate({ messages, tools: [] });

  const kept = selectRecent(history, from, {
    budget: Math.floor(window * settings.keptShare),
    maxTurns: settings.maxKeptTurns,
    tokens,
  });
  const files = planFiles(input.recentFiles, {
    budget: Math.floor(window * settings.filesShare),
    maxFiles: settings.maxFiles,
    maxFileTokens: settings.maxFileTokens,
  });

  const view: Message[] = [];
  if (sessionContext !== null) view.push(sessionContext);
  view.push(summaryNote(summary, input.tasks, kept.length > 0));
  const filesMessage = filesNote(files);
  if (filesMessage !== null) view.push(filesMessage);
  view.push(...normalizePairs(kept));
  return view;
}

/**
 * The most recent turns that fit, cut at a turn boundary; or, when the latest turn alone does
 * not fit, that turn's prompt and as many of its latest steps as fit, cut between steps.
 */
export function selectRecent(
  history: readonly Message[],
  from: number,
  limits: { budget: number; maxTurns: number; tokens: (m: readonly Message[]) => number },
): Message[] {
  const turns = splitTurns(history, from);
  if (turns.length === 0 || limits.maxTurns <= 0) return [];
  let start = history.length;
  let used = 0;
  let count = 0;
  for (let k = turns.length - 1; k >= 0 && count < limits.maxTurns; k--) {
    const turn = turns[k] as Span;
    const cost = limits.tokens(history.slice(turn.start, turn.end));
    if (used + cost > limits.budget) break;
    used += cost;
    start = turn.start;
    count++;
  }
  if (count > 0) return history.slice(start);

  // The latest turn is too big: its prompt (and any notes before its first step), then the
  // latest steps that fit.
  const last = turns[turns.length - 1] as Span;
  const steps = splitSteps(history, last);
  const leadEnd = steps[0]?.start ?? last.end;
  const lead = history.slice(last.start, leadEnd);
  used = limits.tokens(lead);
  // A prompt too large to keep (a huge paste) is left to the summary.
  if (used > limits.budget) return [];
  let keepFrom = last.end;
  for (let k = steps.length - 1; k >= 0; k--) {
    const step = steps[k] as Span;
    const cost = limits.tokens(history.slice(step.start, step.end));
    if (used + cost > limits.budget) break;
    used += cost;
    keepFrom = step.start;
  }
  return [...lead, ...history.slice(keepFrom, last.end)];
}

export function planFiles(
  files: readonly { path: string; content: string }[],
  limits: { budget: number; maxFiles: number; maxFileTokens: number },
): FilesNotePlan {
  const plan: FilesNotePlan = { shown: [], omitted: [] };
  let used = 0;
  for (const file of files.slice(0, limits.maxFiles)) {
    // Numbered lines cost about one token more per line than the text alone.
    const cost = textTokens(file.content) + file.content.split("\n").length + 10;
    if (cost <= limits.maxFileTokens && used + cost <= limits.budget) {
      plan.shown.push(file);
      used += cost;
    } else {
      plan.omitted.push(file.path);
    }
  }
  return plan;
}
