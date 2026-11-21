/**
 * `EnterPlanMode` and `ExitPlanMode`. Names follow the documented tools; `EnterPlanMode` takes no
 * input and `ExitPlanMode` takes the plan as `plan` (Markdown).
 *
 * Approving a plan may name the mode to continue in, which the `SessionServices` contract cannot
 * pass back to the tool, so the session applies the mode change itself before `proposePlan`
 * resolves. The tool only reports the mode it then finds.
 */
import type { PermissionSubject } from "../../contracts/permissions.ts";
import type { ToolContext, ToolDefinition, ToolOutput } from "../../contracts/tools.ts";
import { NoOneToAskError, RequestDismissedError } from "./errors.ts";

export type EnterPlanModeInput = Record<string, never>;

export interface ExitPlanModeInput {
  plan: string;
}

const ENTER_DESCRIPTION = `Switch the session to plan mode, where you can read and search but not change anything, to explore and design an approach before writing code.

- Use it for a large, risky or unclear task when the person would want to agree on the approach first.
- When the plan is ready, present it with ExitPlanMode.`;

const EXIT_DESCRIPTION = `Present your plan to the person for approval. If they approve, plan mode ends and you carry out the plan; if not, you get their feedback and keep planning.

- Call it only in plan mode, after you have explored enough to know what to change.
- plan: the plan in Markdown: the steps, the files you will change, and how you will check the result.
- Do not use it to ask questions; use AskUserQuestion for that.`;

function text(value: string, isError = false): ToolOutput {
  return isError
    ? { content: [{ type: "text", text: value }], isError: true }
    : { content: [{ type: "text", text: value }] };
}

export const enterPlanModeTool: ToolDefinition<EnterPlanModeInput> = {
  name: "EnterPlanMode",
  description: ENTER_DESCRIPTION,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  readOnly: false,

  permission(): PermissionSubject {
    return { kind: "none" };
  },

  async execute(_input: EnterPlanModeInput, ctx: ToolContext): Promise<ToolOutput> {
    if (ctx.session.getMode() === "plan") {
      return text("Plan mode is already on. Present the plan with ExitPlanMode when it is ready.");
    }
    ctx.session.setMode("plan");
    return text(
      "Plan mode is on. Explore with read-only tools and design the approach; do not change any files yet. When the plan is complete, present it with ExitPlanMode.",
    );
  },
};

export const exitPlanModeTool: ToolDefinition<ExitPlanModeInput> = {
  name: "ExitPlanMode",
  description: EXIT_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      plan: { type: "string", description: "The plan, in Markdown." },
    },
    required: ["plan"],
    additionalProperties: false,
  },
  readOnly: false,

  permission(): PermissionSubject {
    return { kind: "none" };
  },

  async execute(input: ExitPlanModeInput, ctx: ToolContext): Promise<ToolOutput> {
    if (ctx.session.getMode() !== "plan") {
      return text(
        "Error: plan mode is not on, so there is no plan to approve. Carry on with the task.",
        true,
      );
    }
    if (input.plan.trim() === "") {
      return text("Error: the plan is empty. Write the plan in the plan field.", true);
    }
    let answer: { approved: boolean; message?: string };
    try {
      answer = await ctx.session.proposePlan(input.plan);
    } catch (error) {
      if (error instanceof NoOneToAskError) {
        return text(
          "No one can approve plans in this session, so plan mode stays on and nothing may be changed. Give the plan as your final answer and stop.",
        );
      }
      if (error instanceof RequestDismissedError) {
        return text(rejection(error.note));
      }
      throw error;
    }
    if (!answer.approved) return text(rejection(answer.message ?? null));
    const mode = ctx.session.getMode();
    return text(
      `The person approved the plan. Plan mode is off; the session is now in ${mode} mode. Carry out the plan.`,
    );
  },
};

function rejection(message: string | null): string {
  const feedback =
    message === null || message.trim() === "" ? "" : `\nTheir feedback: ${message.trim()}`;
  return `The person did not approve the plan and wants to keep planning.${feedback}\nStay in plan mode, revise the plan, and present it again with ExitPlanMode.`;
}
