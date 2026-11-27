/**
 * Subagents (Phase 4, "Subagents"): what a client sees of an agent the model starts with the
 * `Agent` tool.
 *
 * A subagent is a child session. It has its own id and its own event log, which
 * `session.replay` returns like any session's (read-only: it is never opened on a connection,
 * and `session.list` leaves it out). Its parent's log carries `subagent.updated` with the whole
 * `SubagentInfo` each time its state changes, linked to the parent's tool call that started it,
 * so replaying the parent rebuilds every agent's card. A subagent's permission prompts are raised
 * in the parent session, labelled with the agent (`PermissionRequest.agent`).
 */
import { z } from "zod";
import {
  ErrorInfoSchema,
  QueuePositionSchema,
  SessionIdSchema,
  SubagentLabelSchema,
  TimestampSchema,
} from "./common.ts";

/**
 * - queued: waiting for a free model slot (the model serves as many agents at once as it has
 *   conversation slots);
 * - running: working, including while one of its requests waits on the person;
 * - completed: its last task ended with a final message; it can be sent another message;
 * - failed: its last task ended with an error;
 * - stopped: stopped by the person or the model, or because its session closed.
 */
export const SubagentStatusSchema = z.enum(["queued", "running", "completed", "failed", "stopped"]);
export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

export const SubagentInfoSchema = SubagentLabelSchema.extend({
  /** The parent's call that started its current task (`Agent`, `SendMessage` or `Skill`), or null. */
  toolCallId: z.string().nullable(),
  /** The parent's turn that call was made in, or null. */
  turnId: z.string().nullable(),
  /** True for a fork: it started from a copy of the parent's conversation. */
  fork: z.boolean(),
  /** True when the parent did not wait for it: the call returned at once. */
  background: z.boolean(),
  status: SubagentStatusSchema,
  /** While queued: its place in line for a model slot (1 = next). Otherwise null. */
  queuePosition: QueuePositionSchema,
  /** The git worktree it works in, when it runs isolated; null otherwise. */
  worktree: z.object({ path: z.string(), branch: z.string() }).nullable(),
  startedAt: TimestampSchema,
  /** When its current task ended; null while queued or running. */
  endedAt: TimestampSchema.nullable(),
  /** Tool calls it has made so far, over all its tasks. */
  toolUses: z.number().int().nonnegative(),
  /** What it is doing now, one line for people ("Read src/app.ts"), or null. */
  activity: z.string().nullable(),
  /** Its final message for its latest task (what the parent was given), once there is one. */
  result: z.string().nullable(),
  /** Set when status is "failed". */
  error: ErrorInfoSchema.nullable(),
});
export type SubagentInfo = z.infer<typeof SubagentInfoSchema>;

/**
 * Added: a subagent of this session was started, queued, moved on or ended. Sent whole, on the
 * parent session. The latest event for an `agentId` is its state. The common fields are written
 * out here rather than taken from events.ts, which imports this file.
 */
export const SubagentUpdatedEventSchema = z.object({
  sessionId: SessionIdSchema,
  seq: z.number().int().positive(),
  time: TimestampSchema,
  agent: SubagentInfoSchema,
});

/** Stops a running or queued subagent of an open session (the Tasks pane's stop button). */
export const SubagentStopParamsSchema = z.object({
  /** The parent session, open on this connection. */
  sessionId: SessionIdSchema,
  agentId: z.string().min(1),
});

export const SubagentStopResultSchema = z.object({
  /** False when it had already ended. */
  stopped: z.boolean(),
});
