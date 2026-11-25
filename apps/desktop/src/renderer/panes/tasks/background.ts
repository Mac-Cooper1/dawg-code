/** How the Tasks pane words a background command's state. */
import type { BackgroundTask } from "@dawg/protocol";
import { formatDuration } from "../../lib/format.ts";

const STOP_REASONS: Record<NonNullable<BackgroundTask["stopReason"]>, string> = {
  requested: "Stopped on request",
  time_limit: "Stopped: it ran past its time limit",
  output_limit: "Stopped: it wrote too much output",
  session_end: "Stopped when the session ended",
};

/** "Running for 12 s", "Done · exit code 0", "Failed · exit code 1", "Stopped on request". */
export function statusText(task: BackgroundTask, now: number): string {
  switch (task.status) {
    case "running":
      return `Running for ${formatDuration(now - task.startedAt)}`;
    case "completed":
      return `Done · exit code ${task.exitCode ?? 0}`;
    case "failed":
      if (task.exitCode !== null) return `Failed · exit code ${task.exitCode}`;
      return task.signal !== null ? `Failed · ended by ${task.signal}` : "Failed";
    case "stopped":
      return task.stopReason !== null ? STOP_REASONS[task.stopReason] : "Stopped";
  }
}

/** How long an ended command ran: "ran 3.2 s". Null while it runs (the status says it). */
export function ranText(task: BackgroundTask): string | null {
  if (task.status === "running" || task.endedAt === null) return null;
  return `ran ${formatDuration(task.endedAt - task.startedAt)}`;
}

/** The command on one line, for headings and names: "npm run dev". */
export function oneLine(command: string, max = 80): string {
  const line = command.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
