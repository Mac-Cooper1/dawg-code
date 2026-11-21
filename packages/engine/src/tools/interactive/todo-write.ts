/**
 * `TodoWrite`: replaces the session's task list. Name and input follow the documented tool
 * (`todos[]` of `content`, `status`, `activeForm`); `activeForm` is optional here because local
 * models often leave it out, and refusing the whole list for a missing label helps nobody.
 */
import type { TaskItem } from "@dawg/protocol";
import type { PermissionSubject } from "../../contracts/permissions.ts";
import type { ToolContext, ToolDefinition, ToolOutput } from "../../contracts/tools.ts";

export interface TodoWriteInput {
  todos: { content: string; status: TaskItem["status"]; activeForm?: string }[];
}

const DESCRIPTION = `Replace the session's task list with the list you give. Use it for work that takes several steps, so the person can follow your progress.

- Write the steps as tasks when you start. Send the whole list every time: it replaces the previous one.
- Keep exactly one task in_progress while you work on it, and mark it completed as soon as it is done, before starting the next.
- Add tasks you discover along the way; remove ones that turn out to be unnecessary.
- Skip the list for a single quick step or a plain question.`;

export const todoWriteTool: ToolDefinition<TodoWriteInput> = {
  name: "TodoWrite",
  description: DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The whole task list, in order.",
        items: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: 'The task, in the imperative, for example "Run the tests".',
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              description: "Where the task stands.",
            },
            activeForm: {
              type: "string",
              description:
                'The task as an ongoing action, shown while it is in progress, for example "Running the tests".',
            },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
  readOnly: false,

  permission(): PermissionSubject {
    return { kind: "none" };
  },

  async execute(input: TodoWriteInput, ctx: ToolContext): Promise<ToolOutput> {
    const tasks: TaskItem[] = [];
    for (const todo of input.todos) {
      const content = todo.content.trim();
      if (content === "") continue;
      const activeForm = todo.activeForm?.trim() ?? "";
      // No undefined-valued keys: the list is stored and must replay identically.
      tasks.push(
        activeForm === ""
          ? { content, status: todo.status }
          : { content, status: todo.status, activeForm },
      );
    }
    ctx.session.setTasks(tasks);
    return { content: [{ type: "text", text: summarize(tasks) }] };
  },
};

function summarize(tasks: readonly TaskItem[]): string {
  if (tasks.length === 0) return "The task list is now empty.";
  const count = (status: TaskItem["status"]) => tasks.filter((t) => t.status === status).length;
  const done = count("completed");
  const active = count("in_progress");
  const pending = count("pending");
  const lines = [
    `The task list now has ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}: ${done} completed, ${active} in progress, ${pending} pending.`,
  ];
  if (active > 1) lines.push("Keep only one task in progress at a time.");
  if (done === tasks.length) lines.push("Every task is completed.");
  return lines.join("\n");
}
