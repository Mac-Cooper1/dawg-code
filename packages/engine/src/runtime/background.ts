/**
 * Background commands as the protocol shows them (`BackgroundTask`, `background.updated`).
 *
 * The Bash tool's registry (`../tools/bash/background.ts`) lives in memory and starts empty in
 * each run of a session. The event log keeps the rest: every task's latest `background.updated`,
 * and the output file each one wrote, named by the Bash call's result. From these a resumed
 * session lists the tasks of earlier runs and serves their output.
 */
import type { BackgroundTask, CommandDisplay } from "@dawg/protocol";
import type { BackgroundTaskInfo } from "../tools/bash/index.ts";
import type { LoggedEvent } from "./event-log.ts";

export function toBackgroundTask(info: BackgroundTaskInfo): BackgroundTask {
  return {
    taskId: info.id,
    command: info.command,
    description: info.description,
    cwd: info.cwd,
    status: info.status,
    exitCode: info.exitCode,
    signal: info.signal,
    stopReason: info.stopReason,
    startedAt: info.startedAt,
    endedAt: info.endedAt,
    outputBytes: info.outputBytes,
  };
}

export interface StoredBackground {
  /** Each task's latest state, in the order the tasks first appeared (oldest first). */
  tasks: Map<string, BackgroundTask>;
  /** Each task's output file, from the result of the Bash call that started it. */
  outputPaths: Map<string, string>;
  /** The highest `n` of a `bash-<n>` id seen anywhere, 0 when none. */
  highestNumber: number;
}

/** What the stored events say about background commands. */
export function backgroundFromEvents(events: readonly LoggedEvent[]): StoredBackground {
  const tasks = new Map<string, BackgroundTask>();
  const outputPaths = new Map<string, string>();
  let highestNumber = 0;
  const see = (id: string) => {
    const n = /^bash-(\d+)$/.exec(id)?.[1];
    if (n !== undefined) highestNumber = Math.max(highestNumber, Number(n));
  };
  for (const { event, payload } of events) {
    if (event === "background.updated") {
      const task = payload.task as BackgroundTask | undefined;
      if (task === undefined || typeof task.taskId !== "string") continue;
      tasks.set(task.taskId, task);
      see(task.taskId);
    } else if (event === "tool.finished") {
      const display = payload.display as CommandDisplay | null | undefined;
      if (display?.kind !== "command" || !display.backgroundTaskId) continue;
      see(display.backgroundTaskId);
      if (display.outputPath) outputPaths.set(display.backgroundTaskId, display.outputPath);
    }
  }
  return { tasks, outputPaths, highestNumber };
}
