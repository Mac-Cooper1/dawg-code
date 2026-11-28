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
  CompatSourceSchema,
  ErrorInfoSchema,
  PermissionModeSchema,
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

// ---------------------------------------------------------------------------------------------
// Added (Phase 4, round 3): the subagents a project's sessions can start, for Settings →
// Subagents and `/agents`, and writing a new agent file
// ---------------------------------------------------------------------------------------------

/** Where an agent's own lasting memory folder is: the person's, the project's, or the person's for this project. */
export const SubagentMemoryScopeSchema = z.enum(["user", "project", "local"]);
export type SubagentMemoryScope = z.infer<typeof SubagentMemoryScopeSchema>;

/**
 * - loaded: sessions get it as written;
 * - partly-supported: sessions get it, but some fields are ignored (`notes` names each);
 * - needs-approval: sessions get it, but the power its project file supplies (tool grants, a
 *   looser mode, MCP servers of its own) waits for the person to approve the project's code;
 * - invalid: the file cannot be used (`notes` says why);
 * - overridden: another definition of the same name is used instead (`overriddenBy`).
 */
export const SubagentDefinitionStatusSchema = z.enum([
  "loaded",
  "partly-supported",
  "needs-approval",
  "invalid",
  "overridden",
]);
export type SubagentDefinitionStatus = z.infer<typeof SubagentDefinitionStatusSchema>;

/** One subagent definition: a built-in, or an agent file, as a session in the project reads it. */
export const SubagentDefinitionSchema = z.object({
  /** What the model passes as `subagent_type`. */
  name: z.string().min(1),
  description: z.string(),
  /** dawg's own Explore, Plan or general-purpose. */
  builtIn: z.boolean(),
  /** The file; null for a built-in. */
  source: CompatSourceSchema.nullable(),
  /** `tools` as written; null when absent (every tool a subagent can have). */
  tools: z.array(z.string()).nullable(),
  disallowedTools: z.array(z.string()),
  /** `model` as written; null when absent or `inherit`. */
  model: z.string().nullable(),
  /**
   * The model it runs on when that is not the session's: null while every name maps to the
   * session's model (principle 4).
   */
  mappedModel: z.string().nullable(),
  /** `permissionMode` when it names a mode dawg has; null for the parent's. */
  permissionMode: PermissionModeSchema.nullable(),
  /** A built-in that only reads: no write tools, plan mode whatever the parent's mode. */
  readOnly: z.boolean(),
  maxTurns: z.number().int().positive().nullable(),
  /** Skills loaded into its context when it starts. */
  skills: z.array(z.string()),
  memory: SubagentMemoryScopeSchema.nullable(),
  /** Its memory folder (absolute) when `memory` is set; null without a project for the project's scopes. */
  memoryDirectory: z.string().nullable(),
  /** `mcpServers`: each a configured server's name, or one of its own (`inline`). */
  mcpServers: z.array(z.object({ name: z.string().min(1), inline: z.boolean() })),
  background: z.boolean(),
  isolation: z.enum(["worktree"]).nullable(),
  status: SubagentDefinitionStatusSchema,
  /** For `overridden`: the file used instead (absolute). Otherwise null. */
  overriddenBy: z.string().nullable(),
  /** Sentences: fields ignored or mapped, what waits for approval, why it is not used. */
  notes: z.array(z.string()).default([]),
});
export type SubagentDefinition = z.infer<typeof SubagentDefinitionSchema>;

/** Settings → Subagents and `/agents`: every subagent a project's new sessions get. Read-only. */
export const ProjectSubagentsParamsSchema = z.object({
  /** An absolute folder, or null for only the built-ins and the person's own files. */
  projectDir: z.string().min(1).nullable(),
});

export const ProjectSubagentsResultSchema = z.object({
  projectDir: z.string().nullable(),
  /**
   * The built-ins first, then the files: the person's (`~/.claude`, `~/.dawg`), then the
   * project's from the repository root down (`.claude` before `.dawg` in each folder), each
   * folder's sorted by name. Invalid and overridden ones included.
   */
  agents: z.array(SubagentDefinitionSchema),
  /** Where `subagent.create` writes: `~/.dawg/agents` and the project's `.dawg/agents` (null without a project). */
  folders: z.object({ user: z.string(), project: z.string().nullable() }),
});

/**
 * Writes a new agent file, `<name>.md` in the person's `~/.dawg/agents` or the project's
 * `.dawg/agents`, never under `.claude`. A bad name is InvalidParams; a file of that name already
 * there is InvalidState (it is never overwritten). New sessions pick the file up.
 */
export const SubagentCreateParamsSchema = z.object({
  /** The project; needed for `scope: "project"`, and used to report the new agent's status. */
  projectDir: z.string().min(1).nullable(),
  /** user: `~/.dawg/agents`; project: `<projectDir>/.dawg/agents`. */
  scope: z.enum(["user", "project"]),
  name: z.string(),
  description: z.string(),
  /** The system prompt: the file's body. */
  prompt: z.string().default(""),
  /** Tool names; null or absent for every tool a subagent can have. */
  tools: z.array(z.string().min(1)).nullable().optional(),
  disallowedTools: z.array(z.string().min(1)).optional(),
  model: z.string().min(1).nullable().optional(),
  permissionMode: PermissionModeSchema.nullable().optional(),
  memory: SubagentMemoryScopeSchema.nullable().optional(),
  background: z.boolean().optional(),
  isolation: z.enum(["worktree"]).nullable().optional(),
});

export const SubagentCreateResultSchema = z.object({
  /** The file written (absolute). */
  path: z.string(),
  /** The new agent as the listing now shows it. */
  agent: SubagentDefinitionSchema,
});
