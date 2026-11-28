/**
 * What a session's events add up to: its status, task list, background commands, usage, pending
 * requests, and the turn, messages, tool calls and compaction still open. The engine folds every event it emits into
 * this, so snapshots, interrupts and decisions read the same facts a client would rebuild.
 */
import type {
  BackgroundTask,
  EngineEvent,
  PendingRequest,
  SessionStatus,
  TaskItem,
  Usage,
} from "@dawg/protocol";

export interface OpenTurn {
  turnId: string;
  startedAt: number;
  /** The turn began in the stored part, before the engine started. */
  stored: boolean;
  /** Text of the turn's last finished message that had any. */
  lastText: string | null;
}

export interface OpenMessage {
  turnId: string;
  text: string;
  reasoning: string;
}

export interface OpenTool {
  turnId: string;
  toolName: string;
  input: Record<string, unknown>;
  startedAt: number;
  /** Live output so far. */
  output: string;
  /** Waiting on a permission request. */
  waiting: boolean;
}

export class SessionState {
  status: SessionStatus = "idle";
  waitingOn: "permission" | "question" | "plan" | "elicitation" | null = null;
  statusMessage: string | null = null;
  /** Set while the turn waits for a model busy with other sessions (1 = next). */
  queuePosition: number | null = null;
  tasks: TaskItem[] = [];
  /** Background commands by task id, latest state, oldest first. */
  readonly background = new Map<string, BackgroundTask>();
  usage: Usage | null = null;
  /** Oldest first. */
  readonly pending = new Map<string, PendingRequest>();
  turn: OpenTurn | null = null;
  readonly messages = new Map<string, OpenMessage>();
  readonly tools = new Map<string, OpenTool>();
  compaction: { compactionId: string; contextUsed: number } | null = null;
  lastTurnFailed = false;
  /** Turns started so far. */
  turns = 0;

  apply(event: EngineEvent, stored = false): void {
    switch (event.event) {
      case "session.status": {
        const p = event.payload;
        this.status = p.status;
        this.waitingOn = p.waitingOn;
        this.statusMessage = p.message;
        this.queuePosition = p.queuePosition;
        return;
      }
      case "tasks.updated":
        this.tasks = event.payload.tasks.map((t) => ({ ...t }));
        return;
      case "background.updated":
        this.background.set(event.payload.task.taskId, { ...event.payload.task });
        return;
      case "usage.updated":
        this.usage = event.payload.usage;
        return;
      case "turn.started":
        this.turns += 1;
        this.turn = {
          turnId: event.payload.turnId,
          startedAt: event.payload.time,
          stored,
          lastText: null,
        };
        return;
      case "turn.finished":
        this.turn = null;
        this.lastTurnFailed = event.payload.stopReason === "error";
        this.messages.clear();
        this.tools.clear();
        return;
      case "message.started":
        this.messages.set(event.payload.messageId, {
          turnId: event.payload.turnId,
          text: "",
          reasoning: "",
        });
        return;
      case "message.delta": {
        const message = this.messages.get(event.payload.messageId);
        if (message) message.text += event.payload.text;
        return;
      }
      case "reasoning.delta": {
        const message = this.messages.get(event.payload.messageId);
        if (message) message.reasoning += event.payload.text;
        return;
      }
      case "message.finished":
        this.messages.delete(event.payload.messageId);
        if (this.turn && event.payload.text.trim() !== "") this.turn.lastText = event.payload.text;
        return;
      case "tool.started":
        this.tools.set(event.payload.toolCallId, {
          turnId: event.payload.turnId,
          toolName: event.payload.toolName,
          input: event.payload.input,
          startedAt: event.payload.time,
          output: "",
          waiting: false,
        });
        return;
      case "tool.progress": {
        const tool = this.tools.get(event.payload.toolCallId);
        const progress = event.payload.progress;
        if (tool && progress.kind === "output") tool.output += progress.text;
        return;
      }
      case "tool.finished":
        this.tools.delete(event.payload.toolCallId);
        return;
      case "permission.requested": {
        const { turnId, request } = event.payload;
        this.pending.set(request.requestId, { kind: "permission", turnId, request });
        const tool = this.tools.get(request.toolCallId);
        if (tool) tool.waiting = true;
        return;
      }
      case "question.asked": {
        const { turnId, requestId, toolCallId, questions } = event.payload;
        this.pending.set(requestId, { kind: "question", turnId, requestId, toolCallId, questions });
        return;
      }
      case "plan.proposed": {
        const { turnId, requestId, toolCallId, plan, planPath, modeBeforePlan } = event.payload;
        this.pending.set(requestId, {
          kind: "plan",
          turnId,
          requestId,
          toolCallId,
          plan,
          planPath,
          modeBeforePlan,
        });
        return;
      }
      case "elicitation.requested": {
        const { sessionId: _s, seq: _q, time: _t, ...ask } = event.payload;
        this.pending.set(ask.requestId, { kind: "elicitation", ...ask });
        return;
      }
      case "request.resolved": {
        const request = this.pending.get(event.payload.requestId);
        this.pending.delete(event.payload.requestId);
        if (request?.kind === "permission") {
          const tool = this.tools.get(request.request.toolCallId);
          if (tool) tool.waiting = false;
        }
        return;
      }
      case "compaction.started":
        this.compaction = {
          compactionId: event.payload.compactionId,
          contextUsed: event.payload.contextUsed,
        };
        return;
      case "compaction.finished":
        this.compaction = null;
        return;
      case "session.updated":
      case "session.deleted":
      case "prompt.progress":
      case "error":
        return;
    }
  }
}

/** The tool call a pending request is about ("" for an MCP server's request that names none). */
export function toolCallOf(request: PendingRequest): string {
  return request.kind === "permission" ? request.request.toolCallId : (request.toolCallId ?? "");
}

/** The request's id, wherever its kind keeps it. */
export function requestIdOf(request: PendingRequest): string {
  return request.kind === "permission" ? request.request.requestId : request.requestId;
}
