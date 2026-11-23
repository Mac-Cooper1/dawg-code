/**
 * What the model is told when a decision ends a tool call, worded as the real engine's tools word
 * it (packages/engine/src/tools/interactive, loop/executor.ts). Shared by the recordings and the
 * engine, which rewrites a recorded result to match the answer actually given.
 */
import type {
  PermissionMode,
  PlanResponse,
  Question,
  QuestionAnswer,
  QuestionResponse,
} from "@dawg/protocol";

export const INTERRUPTED_RUNNING =
  "Interrupted: the person stopped the turn before this call finished.";
export const INTERRUPTED_WAITING =
  "Interrupted: the person stopped the turn while this call waited for permission.";

/** The result of a call the person refused. */
export function deniedText(toolName: string, message?: string): string {
  const said = message?.trim() ?? "";
  return `Denied: the person did not allow this ${toolName} call.${said === "" ? "" : ` They said: ${said}`} Do not try it again unchanged; adjust your approach or ask what they would prefer.`;
}

/** The AskUserQuestion result for an answer or a dismissal. */
export function questionText(questions: readonly Question[], response: QuestionResponse): string {
  if (response.outcome === "dismissed") {
    const note = response.message?.trim() ?? "";
    const said = note === "" ? "" : ` They said: ${note}`;
    return `The person closed the questions without answering.${said}\nDo not ask the same questions again; continue with your best judgement, or stop and explain what you need.`;
  }
  return formatAnswers(questions, response.answers);
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

/** The ExitPlanMode result. `mode` is the mode the session continues in after an approval. */
export function planText(response: PlanResponse, mode: PermissionMode): string {
  if (response.decision === "approve") {
    return `The person approved the plan. Plan mode is off; the session is now in ${mode} mode. Carry out the plan.`;
  }
  const message = response.message?.trim() ?? "";
  const feedback = message === "" ? "" : `\nTheir feedback: ${message}`;
  return `The person did not approve the plan and wants to keep planning.${feedback}\nStay in plan mode, revise the plan, and present it again with ExitPlanMode.`;
}
