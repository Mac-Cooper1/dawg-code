/**
 * Rewind (Phase 4 spec, "Checkpoints and rewind"; `session.rewind`, `/rewind`): going back to a
 * checkpoint, the point just before one of the person's prompts.
 *
 * - `files`: the files the file tools changed from there on are put back as they were
 *   (../checkpoints). The conversation goes on; the model is told which files changed.
 * - `conversation`: the session is forked just before the prompt (`session.fork` with
 *   `beforeTurn`), and the conversation goes on in the fork, which the client shows in place of
 *   the original. Nothing is deleted: the original session is kept as it was, in the list.
 * - `both`: the files, then the fork.
 * - `summarize`: everything from the prompt on is replaced by a summary in the same session (a
 *   compaction of that part only); the transcript keeps the original messages.
 *
 * A subagent's file changes count in the checkpoint of the turn that started it (or sent it its
 * latest task), foreground or background, so they are put back too. A rewind is refused while a
 * subagent still works in the background: the person stops it or lets it finish first.
 *
 * Restoring files refuses, changing nothing, when a file changed outside the file tools since
 * (by the person, another program or a shell command), unless asked to overwrite. Shell
 * commands are not tracked at all, as in Claude Code.
 */
import type { ClientCapabilities, FilesRestored, RewindAction } from "@dawg/protocol";
import type { Engine } from "./engine.ts";
import type { SessionRuntime } from "./session.ts";

export interface RewindInput {
  checkpointId: string;
  action: RewindAction;
  overwrite: boolean;
  instructions: string | null;
}

export interface RewindOutcome {
  outcome: "done" | "conflicts";
  conflicts: string[];
  files: FilesRestored | null;
  /** The fork the conversation goes on in, open in the engine. */
  session: SessionRuntime | null;
  /** The prompt to put back in the composer. */
  prompt: string | null;
}

/** The title a rewound conversation's fork gets: the original's, marked. */
export function rewoundTitle(title: string | null): string | null {
  return title === null ? null : `${title} (rewound)`;
}

export async function rewindSession(
  engine: Engine,
  runtime: SessionRuntime,
  input: RewindInput,
  options: { capabilities?: Partial<ClientCapabilities> } = {},
): Promise<RewindOutcome> {
  // No turn running, and no subagent still working in the background.
  runtime.assertRewindable();
  const checkpoint = runtime.checkpoint(input.checkpointId);
  const none: RewindOutcome = {
    outcome: "done",
    conflicts: [],
    files: null,
    session: null,
    prompt: null,
  };

  if (input.action === "summarize") {
    await runtime.summarizeFrom(checkpoint.turnId, input.instructions);
    return { ...none, prompt: checkpoint.prompt };
  }

  let files: FilesRestored | null = null;
  if (input.action === "files" || input.action === "both") {
    const restored = await runtime.restoreFiles(checkpoint.turnId, input.overwrite);
    if (restored.outcome === "conflicts") {
      return { ...none, outcome: "conflicts", conflicts: restored.conflicts };
    }
    files = { restored: restored.restored, deleted: restored.deleted, skipped: restored.skipped };
    if (input.action === "files") return { ...none, files };
  }

  const title = rewoundTitle(runtime.summary().title);
  const fork = await engine.forkSession(runtime.id, {
    point: { position: "beforeTurn", turnId: checkpoint.turnId },
    ...(title === null ? {} : { title }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
  });
  return { ...none, files, session: fork, prompt: checkpoint.prompt };
}
