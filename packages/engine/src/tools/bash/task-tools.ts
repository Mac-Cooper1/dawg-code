/**
 * Tools for background tasks started by Bash with `run_in_background`.
 *
 * `TaskStop` follows the documented name and inputs (`task_id`, and the older `shell_id`).
 * `TaskOutput` is the documented name of the tool that read a task's output; the public
 * reference now lists it as removed (the model reads the output file instead) and no longer
 * documents its inputs, so its inputs here are our own choice.
 */
import type { CommandDisplay } from "@dawg/protocol";
import type { PermissionSubject } from "../../contracts/permissions.ts";
import {
  DEFAULT_TOOL_LIMITS,
  type ToolContext,
  type ToolDefinition,
  type ToolOutput,
} from "../../contracts/tools.ts";
import { type BackgroundTaskInfo, getBackgroundTasks } from "./background.ts";
import { formatDuration } from "./bash.ts";

export interface TaskStopInput {
  task_id?: string;
  /** The older name for `task_id`. */
  shell_id?: string;
}

export interface TaskOutputInput {
  task_id: string;
  block?: boolean;
  timeout?: number;
}

const TASK_OUTPUT_DEFAULT_WAIT_MS = 30_000;

export const taskStopTool: ToolDefinition<TaskStopInput> = {
  name: "TaskStop",
  description: `Stop a background task that Bash started with run_in_background, given the task id that call returned. The task's command and every process it started are ended.`,
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The id of the task to stop." },
      shell_id: { type: "string", description: "Older name for task_id; use task_id." },
    },
    additionalProperties: false,
  },
  readOnly: false,

  permission(): PermissionSubject {
    return { kind: "none" };
  },

  async execute(input: TaskStopInput, ctx: ToolContext): Promise<ToolOutput> {
    const id = (input.task_id ?? input.shell_id ?? "").trim();
    const tasks = getBackgroundTasks(ctx.state);
    if (!id)
      return errorOutput(`Give the task_id of the task to stop.${runningList(tasks.running())}`);
    const before = tasks.get(id);
    if (!before)
      return errorOutput(`There is no background task ${id}.${runningList(tasks.running())}`);
    if (before.status !== "running") {
      return {
        content: [{ type: "text", text: `Task ${id} had already ended: ${describeEnd(before)}.` }],
        display: displayOf(before),
      };
    }
    const after = (await tasks.stop(id, "requested")) ?? before;
    return {
      content: [{ type: "text", text: `Stopped task ${id} (${after.command}).` }],
      display: displayOf(after),
    };
  },
};

export const taskOutputTool: ToolDefinition<TaskOutputInput> = {
  name: "TaskOutput",
  description: `Check on a background task that Bash started with run_in_background: whether it is still running, its exit code once it has ended, and the output it printed since the last check. Set block to true to wait for the task to end first, for up to timeout milliseconds.`,
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "The id of the task." },
      block: {
        type: "boolean",
        description: "Wait for the task to end before answering. Defaults to false.",
      },
      timeout: {
        type: "integer",
        minimum: 0,
        maximum: DEFAULT_TOOL_LIMITS.bashMaxTimeoutMs,
        description: `How long to wait when block is true, in milliseconds. Defaults to ${TASK_OUTPUT_DEFAULT_WAIT_MS}.`,
      },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
  readOnly: true,

  permission(): PermissionSubject {
    return { kind: "none" };
  },

  async execute(input: TaskOutputInput, ctx: ToolContext): Promise<ToolOutput> {
    const tasks = getBackgroundTasks(ctx.state);
    const id = input.task_id.trim();
    if (!tasks.get(id)) {
      return errorOutput(`There is no background task ${id}.${runningList(tasks.running())}`);
    }
    if (input.block) {
      const wait = Math.min(
        Math.max(0, input.timeout ?? TASK_OUTPUT_DEFAULT_WAIT_MS),
        ctx.limits.bashMaxTimeoutMs,
      );
      await tasks.waitFor(id, wait, ctx.signal);
      if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("aborted");
    }
    const read = await tasks.readOutput(id, ctx.limits.bashMaxOutputChars);
    if (!read) return errorOutput(`There is no background task ${id}.`);
    const { info } = read;
    const status =
      info.status === "running"
        ? `Task ${id} is still running (${formatDuration(Date.now() - info.startedAt)} so far).`
        : `Task ${id} has ended: ${describeEnd(info)}.`;
    const output = read.text.replace(/\n+$/, "");
    const text = output
      ? `${status}\nNew output:\n${output}`
      : `${status}\nNo new output since the last check.`;
    return { content: [{ type: "text", text }], display: displayOf(info) };
  },
};

function describeEnd(info: BackgroundTaskInfo): string {
  const ran = info.endedAt ? ` after ${formatDuration(info.endedAt - info.startedAt)}` : "";
  switch (info.stopReason) {
    case "requested":
      return `it was stopped on request${ran}`;
    case "time_limit":
      return `it was stopped at its time limit${ran}`;
    case "output_limit":
      return `it was stopped for printing too much output${ran}`;
    case "session_end":
      return `it was stopped when the session ended${ran}`;
    default:
      if (info.signal) return `it was ended by ${info.signal}${ran}`;
      return `it exited with code ${info.exitCode}${ran}`;
  }
}

function runningList(running: BackgroundTaskInfo[]): string {
  if (running.length === 0) return " No background tasks are running.";
  const lines = running.map((t) => `\n- ${t.id}: ${t.description ?? t.command}`);
  return ` Running background tasks:${lines.join("")}`;
}

function displayOf(info: BackgroundTaskInfo): CommandDisplay {
  return {
    kind: "command",
    command: info.command,
    cwd: info.cwd,
    exitCode: info.exitCode,
    durationMs: info.endedAt ? info.endedAt - info.startedAt : null,
    timedOut: info.stopReason === "time_limit",
    interrupted: info.stopReason === "requested" || info.stopReason === "session_end",
    backgroundTaskId: info.id,
    outputPath: info.outputPath,
  };
}

function errorOutput(message: string): ToolOutput {
  return { content: [{ type: "text", text: message }], isError: true };
}
