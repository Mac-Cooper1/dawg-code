/**
 * `AskUserQuestion`: puts multiple-choice questions to the person and waits for the answers.
 * Name and input follow the documented tool (`questions[]` with `question`, `header`, `options`
 * of `label` and `description`, `multiSelect`). `header`, option descriptions and `multiSelect`
 * are optional here, so a model that leaves one out still gets its question asked.
 */
import type { Question, QuestionAnswer } from "@dawg/protocol";
import type { PermissionSubject } from "../../contracts/permissions.ts";
import type { ToolContext, ToolDefinition, ToolOutput } from "../../contracts/tools.ts";
import { NoOneToAskError, RequestDismissedError } from "./errors.ts";

export interface AskUserQuestionInput {
  questions: {
    question: string;
    header?: string;
    options: { label: string; description?: string }[];
    multiSelect?: boolean;
  }[];
}

const DESCRIPTION = `Ask the person one to four multiple-choice questions and wait for the answers.

- Use it when you need a decision or a fact you cannot find out yourself: a choice between approaches, an unclear requirement, a preference.
- Give each question two to four options. The person can always type their own answer instead.
- Put the option you recommend first and say so in its description.
- Do not use it to ask for permission to run a tool (that is asked for you) or to present a plan (use ExitPlanMode).`;

export const NO_ONE_TO_ASK_MESSAGE =
  "No one can answer questions in this session. Continue with your best judgement and state the assumptions you make.";

export const askUserQuestionTool: ToolDefinition<AskUserQuestionInput> = {
  name: "AskUserQuestion",
  description: DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        description: "The questions to ask, in order.",
        items: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description: "The full question, ending with a question mark.",
            },
            header: {
              type: "string",
              description: 'A label of at most 12 characters, for example "Database".',
            },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              description: "The choices.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "The choice, in one to five words." },
                  description: {
                    type: "string",
                    description: "What choosing it means, or why you suggest it.",
                  },
                },
                required: ["label"],
                additionalProperties: false,
              },
            },
            multiSelect: {
              type: "boolean",
              description: "True when more than one option may be chosen.",
            },
          },
          required: ["question", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  // One question card at a time: a second call waits for the first to be answered.
  readOnly: false,

  permission(): PermissionSubject {
    return { kind: "none" };
  },

  async execute(input: AskUserQuestionInput, ctx: ToolContext): Promise<ToolOutput> {
    const questions = input.questions.map(toQuestion);
    let answers: QuestionAnswer[];
    try {
      answers = await ctx.session.askUser(questions);
    } catch (error) {
      if (error instanceof NoOneToAskError) {
        return { content: [{ type: "text", text: NO_ONE_TO_ASK_MESSAGE }] };
      }
      if (error instanceof RequestDismissedError) {
        const said =
          error.note === null || error.note.trim() === "" ? "" : ` They said: ${error.note.trim()}`;
        return {
          content: [
            {
              type: "text",
              text: `The person closed the questions without answering.${said}\nDo not ask the same questions again; continue with your best judgement, or stop and explain what you need.`,
            },
          ],
        };
      }
      throw error;
    }
    return { content: [{ type: "text", text: formatAnswers(questions, answers) }] };
  },
};

function toQuestion(q: AskUserQuestionInput["questions"][number]): Question {
  const out: Question = {
    question: q.question,
    options: q.options.map((o) =>
      o.description === undefined
        ? { label: o.label }
        : { label: o.label, description: o.description },
    ),
    multiSelect: q.multiSelect ?? false,
  };
  if (q.header !== undefined) out.header = q.header;
  return out;
}

function formatAnswers(questions: readonly Question[], answers: readonly QuestionAnswer[]): string {
  const lines = ["The person answered:"];
  for (const q of questions) {
    const a = answers.find((x) => x.question === q.question);
    lines.push(`- ${q.question}`);
    const parts: string[] = [];
    if (a !== undefined && a.selected.length > 0) parts.push(a.selected.join(", "));
    const text = a?.text?.trim() ?? "";
    if (text !== "")
      parts.push(a !== undefined && a.selected.length > 0 ? `(note: ${text})` : text);
    lines.push(`  Answer: ${parts.length > 0 ? parts.join(" ") : "(no answer)"}`);
  }
  return lines.join("\n");
}
