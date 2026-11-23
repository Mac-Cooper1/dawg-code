/**
 * Checks one session's event stream against the protocol's ordering guarantees (packages/protocol
 * README, "Ordering guarantees", rules 1 to 7). Written for the mock engine's recordings and
 * output, and reusable for the real engine's: it only reads `{ event, payload }` objects.
 *
 * It returns violations instead of throwing, so a test can print all of them at once.
 */
import type { EngineEvent, SessionStatus } from "@dawg/protocol";

export interface ConformanceOptions {
  /**
   * The stream starts in the middle of a session: a replay after some seq, or a slice of a
   * recording. The first seq may be any number, the session's status is unknown until a
   * `session.status` arrives, and the turn running at the start (with its message, calls,
   * requests and compaction) may have begun before the first event.
   */
  midSession?: boolean;
  /**
   * Allow gaps in seq, as in a replay that leaves out deltas and progress of finished work.
   * Seq must still grow.
   */
  allowSeqGaps?: boolean;
  /**
   * The stream must end with nothing open: no turn, message, call, request or compaction.
   * Off by default, since a session may stop at a decision or mid-turn.
   */
  requireClosed?: boolean;
}

interface OpenMessage {
  messageId: string;
  turnId: string;
}

interface FinishedMessage {
  turnId: string;
  toolCalls: { toolCallId: string; toolName: string }[];
  /** Index of the next call expected to start. */
  next: number;
}

interface OpenTool {
  turnId: string;
  toolName: string;
}

interface Pending {
  kind: "permission" | "question" | "plan";
  turnId: string;
  toolCallId: string;
}

/** Returns the violations found, in stream order. An empty list means the stream conforms. */
export function checkConformance(
  events: readonly EngineEvent[],
  options: ConformanceOptions = {},
): string[] {
  const checker = new Checker(options);
  events.forEach((event, index) => {
    checker.check(event, index);
  });
  checker.end(events.length);
  return checker.violations;
}

class Checker {
  readonly violations: string[] = [];
  readonly #options: ConformanceOptions;

  #label = "";
  #sessionId: string | null = null;
  #lastSeq: number | null = null;
  /** Null while unknown (a mid-session stream before its first status). */
  #status: SessionStatus | null;
  #turn: { turnId: string; adopted: boolean } | null = null;
  #turnStartedInStream = false;
  #adoptedTurnId: string | null = null;
  readonly #seenTurns = new Set<string>();
  readonly #finishedTurns = new Set<string>();
  #message: OpenMessage | null = null;
  readonly #seenMessages = new Set<string>();
  readonly #finishedMessages = new Map<string, FinishedMessage>();
  readonly #tools = new Map<string, OpenTool>();
  readonly #seenTools = new Set<string>();
  readonly #pending = new Map<string, Pending>();
  readonly #seenRequests = new Set<string>();
  #compaction: string | null = null;
  #compactionSeen = false;
  /** The previous event was `turn.finished`: the next must be `session.status` idle or error. */
  #expectEndStatus = false;
  /** The previous event raised a request: the status must be "waiting" by the next event. */
  #expectWaiting = false;

  constructor(options: ConformanceOptions) {
    this.#options = options;
    this.#status = options.midSession ? null : "idle";
  }

  #fail(message: string): void {
    this.violations.push(`${this.#label}: ${message}`);
  }

  check(event: EngineEvent, index: number): void {
    const p = event.payload;
    this.#label = `#${index} seq ${p.seq} ${event.event}`;
    this.#checkSeq(p.seq, index);
    if (this.#sessionId === null) this.#sessionId = p.sessionId;
    else if (p.sessionId !== this.#sessionId) {
      this.#fail(`sessionId ${p.sessionId} differs from ${this.#sessionId}`);
    }

    if (this.#expectEndStatus) {
      this.#expectEndStatus = false;
      const ok =
        event.event === "session.status" &&
        (event.payload.status === "idle" || event.payload.status === "error");
      if (!ok) this.#fail("turn.finished must be followed by session.status idle or error");
    }
    if (this.#expectWaiting) {
      this.#expectWaiting = false;
      const ok =
        this.#status === "waiting" ||
        (event.event === "session.status" && event.payload.status === "waiting");
      if (!ok) this.#fail(`a request was raised but the status is ${this.#status}, not waiting`);
    }

    const turnId = turnIdOf(event);
    if (turnId !== null && this.#finishedTurns.has(turnId)) {
      this.#fail(`turn ${turnId} already finished; turn.finished must be its last event`);
      return;
    }
    if (this.#compaction !== null && touchesMessagesOrTools(event)) {
      this.#fail(`${event.event} while compaction ${this.#compaction} runs`);
    }

    switch (event.event) {
      case "session.status":
        this.#onStatus(event.payload);
        return;
      case "turn.started":
        this.#onTurnStarted(event.payload.turnId);
        return;
      case "turn.finished":
        this.#onTurnFinished(event.payload.turnId);
        return;
      case "message.started":
        this.#onMessageStarted(event.payload.turnId, event.payload.messageId);
        return;
      case "message.delta":
      case "reasoning.delta":
        this.#onMessageDelta(event.payload.turnId, event.payload.messageId);
        return;
      case "message.finished":
        this.#onMessageFinished(event.payload);
        return;
      case "tool.started":
        this.#onToolStarted(event.payload);
        return;
      case "tool.progress":
        this.#onToolProgress(event.payload.turnId, event.payload.toolCallId);
        return;
      case "tool.finished":
        this.#onToolFinished(event.payload);
        return;
      case "permission.requested":
        this.#onRequest(
          "permission",
          event.payload.turnId,
          event.payload.request.requestId,
          event.payload.request.toolCallId,
        );
        return;
      case "question.asked":
      case "plan.proposed":
        this.#onRequest(
          event.event === "question.asked" ? "question" : "plan",
          event.payload.turnId,
          event.payload.requestId,
          event.payload.toolCallId,
        );
        return;
      case "request.resolved":
        this.#onResolved(event.payload);
        return;
      case "prompt.progress":
        this.#onPromptProgress(event.payload);
        return;
      case "compaction.started":
        this.#onCompactionStarted(event.payload.compactionId, event.payload.turnId);
        return;
      case "compaction.finished":
        this.#onCompactionFinished(event.payload.compactionId);
        return;
      case "error":
        if (event.payload.turnId !== null) this.#requireTurn(event.payload.turnId);
        return;
      case "session.updated":
      case "tasks.updated":
      case "usage.updated":
        return;
    }
  }

  end(count: number): void {
    this.#label = `end of stream (${count} events)`;
    if (!this.#options.requireClosed) return;
    if (this.#turn !== null) this.#fail(`turn ${this.#turn.turnId} never finished`);
    if (this.#message !== null) this.#fail(`message ${this.#message.messageId} never finished`);
    for (const id of this.#tools.keys()) this.#fail(`tool call ${id} never finished`);
    for (const id of this.#pending.keys()) this.#fail(`request ${id} never resolved`);
    if (this.#compaction !== null) this.#fail(`compaction ${this.#compaction} never finished`);
  }

  // -------------------------------------------------------------------------------------------
  // Rule 1: sequence numbers
  // -------------------------------------------------------------------------------------------

  #checkSeq(seq: number, index: number): void {
    const last = this.#lastSeq;
    this.#lastSeq = seq;
    if (last === null) {
      if (index === 0 && !this.#options.midSession && seq !== 1) {
        this.#fail(`the first seq is ${seq}, not 1`);
      }
      return;
    }
    if (this.#options.allowSeqGaps) {
      if (seq <= last) this.#fail(`seq ${seq} does not grow from ${last}`);
    } else if (seq !== last + 1) {
      this.#fail(`seq ${seq} does not follow ${last} by one`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Rule 2: turns and status
  // -------------------------------------------------------------------------------------------

  #onStatus(p: { status: SessionStatus; waitingOn: string | null }): void {
    if ((p.status === "waiting") !== (p.waitingOn !== null)) {
      this.#fail(`status ${p.status} with waitingOn ${p.waitingOn}`);
    }
    if (this.#pending.size > 0 && p.status !== "waiting") {
      this.#fail(`status ${p.status} while ${this.#pending.size} request(s) are pending`);
    }
    if (p.status === "waiting" && this.#pending.size === 0 && this.#knowsAllRequests()) {
      this.#fail("status waiting with no pending request");
    }
    this.#status = p.status;
  }

  #onTurnStarted(turnId: string): void {
    if (this.#turn !== null) {
      this.#fail(`turn ${turnId} starts while turn ${this.#turn.turnId} runs`);
    }
    if (this.#seenTurns.has(turnId)) this.#fail(`turn id ${turnId} is reused`);
    if (this.#status !== null && this.#status !== "working") {
      this.#fail(`turn.started while the status is ${this.#status}, not working`);
    }
    this.#seenTurns.add(turnId);
    this.#turnStartedInStream = true;
    this.#turn = { turnId, adopted: false };
  }

  #onTurnFinished(turnId: string): void {
    if (!this.#requireTurn(turnId)) return;
    if (this.#message !== null) {
      this.#fail(`turn ends while message ${this.#message.messageId} streams`);
      this.#message = null;
    }
    for (const [id, tool] of this.#tools) {
      if (tool.turnId === turnId) {
        this.#fail(`turn ends before tool call ${id} finished`);
        this.#tools.delete(id);
      }
    }
    for (const [id, request] of this.#pending) {
      if (request.turnId === turnId) {
        this.#fail(`turn ends before request ${id} was resolved`);
        this.#pending.delete(id);
      }
    }
    this.#finishedTurns.add(turnId);
    this.#turn = null;
    this.#expectEndStatus = true;
  }

  /**
   * True when `turnId` is the running turn. In a mid-session stream, the first turn referred to
   * before any `turn.started` is adopted as the one that was running when the stream began.
   */
  #requireTurn(turnId: string): boolean {
    if (this.#turn?.turnId === turnId) return true;
    if (this.#canAdoptTurn(turnId)) {
      this.#adoptedTurnId = turnId;
      this.#seenTurns.add(turnId);
      this.#turn = { turnId, adopted: true };
      return true;
    }
    if (this.#turn === null) this.#fail(`refers to turn ${turnId}, but no turn runs`);
    else this.#fail(`refers to turn ${turnId}, but turn ${this.#turn.turnId} runs`);
    return false;
  }

  #canAdoptTurn(turnId: string): boolean {
    return (
      this.#options.midSession === true &&
      this.#turn === null &&
      !this.#turnStartedInStream &&
      this.#adoptedTurnId === null &&
      !this.#finishedTurns.has(turnId)
    );
  }

  /** Things begun before a mid-session stream may be referred to without their start. */
  #inAdoptedTurn(turnId: string): boolean {
    return this.#turn?.adopted === true && this.#turn.turnId === turnId;
  }

  #knowsAllRequests(): boolean {
    return !this.#options.midSession || this.#turnStartedInStream;
  }

  // -------------------------------------------------------------------------------------------
  // Rule 3: messages
  // -------------------------------------------------------------------------------------------

  #onMessageStarted(turnId: string, messageId: string): void {
    if (!this.#requireTurn(turnId)) return;
    if (this.#message !== null) {
      this.#fail(`message ${messageId} starts while message ${this.#message.messageId} streams`);
    }
    if (this.#seenMessages.has(messageId)) this.#fail(`message id ${messageId} is reused`);
    this.#seenMessages.add(messageId);
    this.#message = { messageId, turnId };
  }

  #onMessageDelta(turnId: string, messageId: string): void {
    if (!this.#requireTurn(turnId)) return;
    if (this.#message?.messageId === messageId) return;
    if (this.#adoptMessage(turnId, messageId)) return;
    this.#fail(`delta for message ${messageId}, which is not streaming`);
  }

  #adoptMessage(turnId: string, messageId: string): boolean {
    if (!this.#inAdoptedTurn(turnId) || this.#message !== null) return false;
    if (this.#seenMessages.has(messageId)) return false;
    this.#seenMessages.add(messageId);
    this.#message = { messageId, turnId };
    return true;
  }

  #onMessageFinished(p: {
    turnId: string;
    messageId: string;
    toolCalls: { toolCallId: string; toolName: string }[];
  }): void {
    if (!this.#requireTurn(p.turnId)) return;
    if (this.#message?.messageId !== p.messageId && !this.#adoptMessage(p.turnId, p.messageId)) {
      this.#fail(`message ${p.messageId} finishes but was not streaming`);
      return;
    }
    this.#message = null;
    this.#finishedMessages.set(p.messageId, { turnId: p.turnId, toolCalls: p.toolCalls, next: 0 });
  }

  // -------------------------------------------------------------------------------------------
  // Rule 4: tool calls
  // -------------------------------------------------------------------------------------------

  #onToolStarted(p: {
    turnId: string;
    messageId: string;
    toolCallId: string;
    toolName: string;
  }): void {
    if (!this.#requireTurn(p.turnId)) return;
    if (this.#message !== null) {
      this.#fail(
        `tool call ${p.toolCallId} starts while message ${this.#message.messageId} streams`,
      );
    }
    if (this.#seenTools.has(p.toolCallId)) this.#fail(`tool call id ${p.toolCallId} is reused`);
    this.#seenTools.add(p.toolCallId);
    this.#tools.set(p.toolCallId, { turnId: p.turnId, toolName: p.toolName });
    const message = this.#finishedMessages.get(p.messageId);
    if (message === undefined) {
      if (!this.#inAdoptedTurn(p.turnId)) {
        this.#fail(`tool call ${p.toolCallId} starts before message ${p.messageId} finished`);
      }
      return;
    }
    if (message.turnId !== p.turnId) {
      this.#fail(`tool call ${p.toolCallId} names message ${p.messageId} of another turn`);
    }
    const expected = message.toolCalls[message.next];
    if (expected === undefined) {
      this.#fail(`tool call ${p.toolCallId} is not among message ${p.messageId}'s remaining calls`);
      return;
    }
    if (expected.toolCallId !== p.toolCallId) {
      this.#fail(`tool call ${p.toolCallId} starts out of order; ${expected.toolCallId} is next`);
    } else if (expected.toolName !== p.toolName) {
      this.#fail(
        `tool call ${p.toolCallId} is ${p.toolName}, but the message named ${expected.toolName}`,
      );
    }
    message.next += 1;
  }

  #onToolProgress(turnId: string, toolCallId: string): void {
    if (!this.#requireTurn(turnId)) return;
    if (this.#tools.get(toolCallId)?.turnId === turnId) return;
    if (this.#adoptTool(turnId, toolCallId, null)) return;
    this.#fail(`progress for tool call ${toolCallId}, which is not running`);
  }

  #adoptTool(turnId: string, toolCallId: string, toolName: string | null): boolean {
    if (!this.#inAdoptedTurn(turnId) || this.#seenTools.has(toolCallId)) return false;
    this.#seenTools.add(toolCallId);
    // An adopted call's name is unknown ("") until its tool.finished names it.
    this.#tools.set(toolCallId, { turnId, toolName: toolName ?? "" });
    return true;
  }

  #onToolFinished(p: { turnId: string; toolCallId: string; toolName: string }): void {
    if (!this.#requireTurn(p.turnId)) return;
    const tool = this.#tools.get(p.toolCallId);
    if (tool === undefined) {
      if (!this.#adoptTool(p.turnId, p.toolCallId, p.toolName)) {
        this.#fail(`tool call ${p.toolCallId} finishes but is not running`);
        return;
      }
    } else if (tool.toolName !== "" && tool.toolName !== p.toolName) {
      this.#fail(
        `tool call ${p.toolCallId} started as ${tool.toolName}, finishes as ${p.toolName}`,
      );
    }
    for (const [id, request] of this.#pending) {
      if (request.toolCallId === p.toolCallId) {
        this.#fail(`tool call ${p.toolCallId} finishes while request ${id} is pending`);
      }
    }
    this.#tools.delete(p.toolCallId);
  }

  // -------------------------------------------------------------------------------------------
  // Rule 5: requests
  // -------------------------------------------------------------------------------------------

  #onRequest(kind: Pending["kind"], turnId: string, requestId: string, toolCallId: string): void {
    if (!this.#requireTurn(turnId)) return;
    if (this.#seenRequests.has(requestId)) this.#fail(`request id ${requestId} is reused`);
    this.#seenRequests.add(requestId);
    if (!this.#tools.has(toolCallId) && !this.#adoptTool(turnId, toolCallId, null)) {
      this.#fail(`request ${requestId} is for tool call ${toolCallId}, which is not running`);
    }
    this.#pending.set(requestId, { kind, turnId, toolCallId });
    this.#expectWaiting = true;
  }

  #onResolved(p: {
    kind: Pending["kind"];
    turnId: string;
    requestId: string;
    outcome: "answered" | "cancelled";
    response: unknown;
  }): void {
    if (!this.#requireTurn(p.turnId)) return;
    if ((p.outcome === "answered") !== (p.response !== null)) {
      this.#fail(`outcome ${p.outcome} with ${p.response === null ? "no" : "a"} response`);
    }
    const request = this.#pending.get(p.requestId);
    if (request === undefined) {
      const adoptable = this.#inAdoptedTurn(p.turnId) && !this.#seenRequests.has(p.requestId);
      if (adoptable) this.#seenRequests.add(p.requestId);
      else this.#fail(`request ${p.requestId} is resolved but is not pending`);
      return;
    }
    if (request.kind !== p.kind) {
      this.#fail(`request ${p.requestId} is a ${request.kind} request, resolved as ${p.kind}`);
    }
    if (request.turnId !== p.turnId) {
      this.#fail(`request ${p.requestId} belongs to turn ${request.turnId}, not ${p.turnId}`);
    }
    this.#pending.delete(p.requestId);
  }

  #onPromptProgress(p: { turnId: string; total: number; cached: number; processed: number }): void {
    if (!this.#requireTurn(p.turnId)) return;
    if (this.#message !== null) {
      this.#fail(`prompt progress while message ${this.#message.messageId} streams`);
    }
    if (p.cached > p.total || p.processed > p.total) {
      this.#fail(`cached ${p.cached} or processed ${p.processed} exceeds total ${p.total}`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Rule 6: compaction
  // -------------------------------------------------------------------------------------------

  #onCompactionStarted(compactionId: string, turnId: string | null): void {
    if (this.#compaction !== null) {
      this.#fail(`compaction ${compactionId} starts while ${this.#compaction} runs`);
    }
    if (turnId !== null) this.#requireTurn(turnId);
    else if (this.#turn !== null) {
      this.#fail(`compaction ${compactionId} has no turn, but turn ${this.#turn.turnId} runs`);
    }
    if (this.#message !== null) {
      this.#fail(
        `compaction ${compactionId} starts while message ${this.#message.messageId} streams`,
      );
    }
    this.#compactionSeen = true;
    this.#compaction = compactionId;
  }

  #onCompactionFinished(compactionId: string): void {
    if (this.#compaction === compactionId) {
      this.#compaction = null;
      return;
    }
    const adoptable = this.#options.midSession === true && !this.#compactionSeen;
    this.#compactionSeen = true;
    if (!adoptable) this.#fail(`compaction ${compactionId} finishes but is not running`);
  }
}

/** The turn an event belongs to, or null for session-level events. */
function turnIdOf(event: EngineEvent): string | null {
  switch (event.event) {
    case "session.status":
    case "session.updated":
    case "tasks.updated":
    case "usage.updated":
    case "compaction.finished":
      return null;
    case "compaction.started":
    case "error":
      return event.payload.turnId;
    default:
      return event.payload.turnId;
  }
}

function touchesMessagesOrTools(event: EngineEvent): boolean {
  return (
    event.event.startsWith("message.") ||
    event.event.startsWith("tool.") ||
    event.event === "reasoning.delta"
  );
}
