/**
 * Checkpoints and rewind in the mock engine (`session.checkpoints`, `session.rewind`, `/rewind`,
 * `/memory`), answered as the real engine answers them. A checkpoint is each prompt in a session's
 * log; the files it changed are its edits' diffs (`tool.finished` with a diff display). Files are
 * never really written here, so a restore reports what it would have put back.
 */
import {
  type Checkpoint,
  type EngineEvent,
  ErrorCodes,
  type FilesRestored,
  RpcError,
} from "@dawg/protocol";

/** Changes made by shell commands are not tracked, as in Claude Code. */
const SHELL_CAVEAT =
  "Only changes made by dawg's file tools (Write, Edit) are tracked. Changes made by shell commands are not; git shows every change.";

interface Turn {
  turnId: string;
  time: number;
  prompt: string;
  /** Files its edits changed, in order: path → created. */
  files: Map<string, boolean>;
}

function turnsOf(log: readonly EngineEvent[]): Turn[] {
  const turns: Turn[] = [];
  const byId = new Map<string, Turn>();
  for (const event of log) {
    if (event.event === "turn.started") {
      const turn: Turn = {
        turnId: event.payload.turnId,
        time: event.payload.time,
        prompt: event.payload.prompt.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n"),
        files: new Map(),
      };
      turns.push(turn);
      byId.set(turn.turnId, turn);
    } else if (
      event.event === "tool.finished" &&
      event.payload.outcome === "success" &&
      event.payload.display?.kind === "diff"
    ) {
      const turn = byId.get(event.payload.turnId);
      const { filePath, created } = event.payload.display;
      if (turn !== undefined && !turn.files.has(filePath)) turn.files.set(filePath, created);
    }
  }
  return turns;
}

/** `session.checkpoints`: one per prompt, oldest first. */
export function mockCheckpoints(log: readonly EngineEvent[]): {
  checkpoints: Checkpoint[];
  retention: number;
} {
  const turns = turnsOf(log);
  const checkpoints = turns.map((turn, index): Checkpoint => {
    // Restoring to it puts back every file changed from here on, as it was first found.
    const restore = new Map<string, boolean>();
    for (const later of turns.slice(index)) {
      for (const [path, created] of later.files) if (!restore.has(path)) restore.set(path, created);
    }
    return {
      id: turn.turnId,
      turnId: turn.turnId,
      time: turn.time,
      prompt: turn.prompt,
      tracked: true,
      files: [...turn.files].map(([path, created]) => ({
        path,
        change: created ? "created" : "modified",
        agents: [],
      })),
      restore: [...restore].map(([path, created]) => ({
        path,
        action: created ? "delete" : "write",
        changedOutside: false,
      })),
    };
  });
  return { checkpoints, retention: 100 };
}

/** A checkpoint of the session, or the engine's error for an unknown one. */
export function mockCheckpoint(log: readonly EngineEvent[], checkpointId: string): Checkpoint {
  const found = mockCheckpoints(log).checkpoints.find((c) => c.id === checkpointId);
  if (found === undefined) {
    throw new RpcError(
      ErrorCodes.InvalidParams,
      `This conversation has no checkpoint ${checkpointId}; list them again.`,
    );
  }
  return found;
}

/** What restoring files to a checkpoint reports. */
export function mockRestore(checkpoint: Checkpoint): FilesRestored {
  return {
    restored: checkpoint.restore.filter((s) => s.action === "write").map((s) => s.path),
    deleted: checkpoint.restore.filter((s) => s.action === "delete").map((s) => s.path),
    skipped: [],
  };
}

/** `/rewind` for a client without a dialog: the list. */
export function rewindText(log: readonly EngineEvent[]): string {
  const { checkpoints } = mockCheckpoints(log);
  if (checkpoints.length === 0) return "Nothing to rewind to yet: no prompts in this conversation.";
  return [
    "Checkpoints, newest first:",
    ...checkpoints
      .slice()
      .reverse()
      .map((c, i) => `  ${i + 1}. ${c.prompt.replace(/\s+/g, " ").trim().slice(0, 70)}`),
    "",
    "Choose one with the rewind dialog in the app (Esc twice), or /rewind in dawg's interactive mode.",
    SHELL_CAVEAT,
  ].join("\n");
}

/** `/memory`: where the project's memory would be. */
export function memoryText(projectDir: string): string {
  const key = projectDir.replace(/[^A-Za-z0-9]/g, "-");
  return [
    `Memory for this project: ~/.dawg/projects/${key}/memory`,
    "  MEMORY.md: the index. Its first 200 lines load when a session starts.",
    "",
    "Instruction files:",
    "  CLAUDE.md (the project's)",
    "  ~/.claude/CLAUDE.md (yours, for every project; not made yet)",
    "",
    "Changes apply from the next session. Files under .claude/ are read, never written, by dawg: edit those in your own editor.",
  ].join("\n");
}
