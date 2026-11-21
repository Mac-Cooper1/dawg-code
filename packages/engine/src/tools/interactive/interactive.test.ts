import type { PermissionMode } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createTestToolContext, type TestToolContext } from "../../testing/context.ts";
import { lintToolSchema } from "../../toolcall/index.ts";
import {
  askUserQuestionTool,
  enterPlanModeTool,
  exitPlanModeTool,
  INTERACTIVE_TOOLS,
  NoOneToAskError,
  RequestDismissedError,
  todoWriteTool,
} from "./index.ts";

let contexts: TestToolContext[] = [];
afterEach(async () => {
  for (const c of contexts) await c.cleanup();
  contexts = [];
});

async function context(session: Parameters<typeof createTestToolContext>[0] = {}) {
  const c = await createTestToolContext(session);
  contexts.push(c);
  return c;
}

const textOf = (out: { content: { type: string; text?: string }[] }) =>
  out.content.map((p) => p.text ?? "").join("");

describe("the interactive tools", () => {
  it("have schemas that lint clean for grammar-constrained decoding", () => {
    for (const tool of INTERACTIVE_TOOLS) {
      const errors = lintToolSchema({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }).filter((f) => f.severity === "error");
      expect(errors, tool.name).toEqual([]);
      expect(
        tool.permission(
          {},
          { cwd: "/", workingDirectories: ["/"], state: { get: (_k, c) => c() } },
        ),
      ).toEqual({
        kind: "none",
      });
    }
  });

  it("TodoWrite replaces the list without undefined keys", async () => {
    const c = await context();
    const out = await todoWriteTool.execute(
      {
        todos: [
          { content: "  Write tests ", status: "in_progress", activeForm: "Writing tests" },
          { content: "Ship", status: "pending" },
          { content: "   ", status: "pending" },
        ],
      },
      c.ctx,
    );
    expect(c.tasks).toEqual([
      { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
      { content: "Ship", status: "pending" },
    ]);
    expect("activeForm" in (c.tasks[1] as object)).toBe(false);
    expect(textOf(out)).toContain("0 completed, 1 in progress, 1 pending");
  });

  it("AskUserQuestion formats the answers", async () => {
    const c = await context({
      session: {
        askUser: async (questions) => {
          expect(questions[0]).toEqual({
            question: "Which?",
            options: [{ label: "A" }, { label: "B", description: "the other" }],
            multiSelect: false,
          });
          return [{ question: "Which?", selected: ["B"], text: "because" }];
        },
      },
    });
    const out = await askUserQuestionTool.execute(
      {
        questions: [
          {
            question: "Which?",
            options: [{ label: "A" }, { label: "B", description: "the other" }],
          },
        ],
      },
      c.ctx,
    );
    expect(textOf(out)).toBe("The person answered:\n- Which?\n  Answer: B (note: because)");
  });

  it("AskUserQuestion explains when nobody can answer or the person dismissed it", async () => {
    const none = await context({
      session: {
        askUser: async () => {
          throw new NoOneToAskError();
        },
      },
    });
    const input = { questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }] };
    expect(textOf(await askUserQuestionTool.execute(input, none.ctx))).toContain(
      "No one can answer",
    );
    const dismissed = await context({
      session: {
        askUser: async () => {
          throw new RequestDismissedError("later");
        },
      },
    });
    expect(textOf(await askUserQuestionTool.execute(input, dismissed.ctx))).toContain(
      "They said: later",
    );
  });

  it("EnterPlanMode switches to plan mode once", async () => {
    let mode: PermissionMode = "default";
    const c = await context({
      session: {
        getMode: () => mode,
        setMode: (m) => {
          mode = m;
        },
      },
    });
    expect(textOf(await enterPlanModeTool.execute({}, c.ctx))).toContain("Plan mode is on");
    expect(mode).toBe("plan");
    expect(textOf(await enterPlanModeTool.execute({}, c.ctx))).toContain("already on");
  });

  it("ExitPlanMode reports approval, rejection, and refuses outside plan mode", async () => {
    let mode: PermissionMode = "plan";
    let answer: { approved: boolean; message?: string } = { approved: true };
    const c = await context({
      session: {
        getMode: () => mode,
        proposePlan: async () => {
          if (answer.approved) mode = "acceptEdits";
          return answer;
        },
      },
    });
    const approved = await exitPlanModeTool.execute({ plan: "1. do it" }, c.ctx);
    expect(textOf(approved)).toContain("now in acceptEdits mode");
    mode = "plan";
    answer = { approved: false, message: "smaller steps" };
    const rejected = await exitPlanModeTool.execute({ plan: "1. do it" }, c.ctx);
    expect(textOf(rejected)).toContain("Their feedback: smaller steps");
    mode = "default";
    const outside = await exitPlanModeTool.execute({ plan: "x" }, c.ctx);
    expect(outside.isError).toBe(true);
  });
});
