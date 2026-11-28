/**
 * Checkpoints and rewind (Phase 4, "Checkpoints and rewind").
 *
 * The engine opens a checkpoint before it processes each prompt: the point just before the
 * person's message. The first time a file tool (Write, Edit) changes a file within a checkpoint,
 * the file's content from before is saved, "did not exist" included. Changes made by shell
 * commands are not tracked.
 *
 * `session.checkpoints` lists them; `session.rewind` goes back to one: the files, the
 * conversation (as a fork, so nothing is deleted), both, or a summary of everything from there.
 */
import { z } from "zod";
import { SessionIdSchema, SubagentLabelSchema, TimestampSchema } from "./common.ts";
import type { MethodResult } from "./methods.ts";

/** One file a checkpoint's turn changed with a file tool. */
export const CheckpointFileSchema = z.object({
  /** Absolute. */
  path: z.string().min(1),
  /** `created`: it did not exist before the turn. `modified`: it did. */
  change: z.enum(["created", "modified"]),
  /**
   * The subagents the turn started that changed it (their changes count in the checkpoint of
   * the turn that started them, foreground or background). Empty when only the conversation did.
   */
  agents: z.array(SubagentLabelSchema).default([]),
});
export type CheckpointFile = z.infer<typeof CheckpointFileSchema>;

/** What restoring files to a checkpoint would do to one file. Files already as they were are left out. */
export const RestoreStepSchema = z.object({
  /** Absolute. */
  path: z.string().min(1),
  /** `write` puts back the saved content; `delete` removes a file made since. */
  action: z.enum(["write", "delete"]),
  /**
   * The file changed since dawg's file tools last wrote it: by the person, another program or a
   * shell command. Restoring it needs `overwrite`.
   */
  changedOutside: z.boolean(),
});
export type RestoreStep = z.infer<typeof RestoreStepSchema>;

export const CheckpointSchema = z.object({
  /** What `session.rewind` names. The turn's id. */
  id: z.string().min(1),
  turnId: z.string().min(1),
  /** When the prompt was sent. */
  time: TimestampSchema,
  /** The person's message as typed (a command as typed), text only. */
  prompt: z.string(),
  /**
   * False when this checkpoint's saved files are gone: older than the retention limit, or from
   * before checkpoints were kept. The conversation can still be rewound to it.
   */
  tracked: z.boolean(),
  /** Files this turn changed with file tools, in the order it first changed them. */
  files: z.array(CheckpointFileSchema),
  /**
   * What restoring files to this checkpoint would do: every file changed from here on, by this
   * turn or a later one. Empty when there is nothing to put back.
   */
  restore: z.array(RestoreStepSchema),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const SessionCheckpointsParamsSchema = z.object({
  sessionId: SessionIdSchema,
});

export const SessionCheckpointsResultSchema = z.object({
  /** Oldest first: one per prompt in the conversation. */
  checkpoints: z.array(CheckpointSchema),
  /** How many of the latest checkpoints keep their files. */
  retention: z.number().int().positive(),
});

/**
 * - `both`: put the files back and fork the conversation from just before the prompt.
 * - `conversation`: only the fork; the files stay as they are.
 * - `files`: only the files; the conversation goes on, and the model is told at the next turn.
 * - `summarize`: replace everything from the prompt on with a summary (a compaction of that
 *   part only; the transcript keeps the original messages). Reported by `compaction.*` events.
 */
export const RewindActionSchema = z.enum(["both", "conversation", "files", "summarize"]);
export type RewindAction = z.infer<typeof RewindActionSchema>;

export const SessionRewindParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** A `Checkpoint.id` from `session.checkpoints`. */
  checkpointId: z.string().min(1),
  action: RewindActionSchema,
  /**
   * Put back files that changed outside dawg's file tools since (see `changedOutside`). Without
   * it such files make the rewind stop with outcome `conflicts`, having changed nothing.
   */
  overwrite: z.boolean().default(false),
  /** For `summarize`: what the summary should concentrate on. */
  instructions: z.string().max(10_000).optional(),
});

export const FilesRestoredSchema = z.object({
  /** Written back with their saved content. */
  restored: z.array(z.string()),
  /** Made after the checkpoint, so removed. */
  deleted: z.array(z.string()),
  /** Left as they are, with why (a symbolic link now, a saved copy that is gone). */
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export type FilesRestored = z.infer<typeof FilesRestoredSchema>;

/** `session.rewind`'s result without the fork's snapshot (see `sessionRewindResultSchema`). */
export const SessionRewindResultBaseSchema = z.object({
  /**
   * `done`, or `conflicts` when files changed outside dawg's file tools and `overwrite` was not
   * set: then nothing was changed, and `conflicts` names them.
   */
  outcome: z.enum(["done", "conflicts"]),
  conflicts: z.array(z.string()),
  /** What happened to the files; null when they were not asked for, or on conflicts. */
  files: FilesRestoredSchema.nullable(),
  /**
   * The checkpoint's prompt, to put back in the composer after the conversation was rewound or
   * summarised. Null for `files` and on conflicts.
   */
  prompt: z.string().nullable(),
});

/**
 * `session.rewind`'s result: the base, plus `session`, the fork the conversation goes on in
 * (`both`, `conversation`), open on this connection, or null. The session rewound from is kept
 * as it was. methods.ts passes its `SessionSnapshotSchema`, which lives there, so the two files
 * do not import each other.
 */
export function sessionRewindResultSchema<S extends z.ZodType>(snapshot: S) {
  return SessionRewindResultBaseSchema.extend({ session: snapshot.nullable() });
}
export type SessionRewindResult = MethodResult<"session.rewind">;
