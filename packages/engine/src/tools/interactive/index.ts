/**
 * The tools that talk to the person through the session rather than to the machine: the task
 * list, questions, and plan mode. They use `ToolContext.session` (`SessionServices`), which the
 * session runtime implements.
 */
import type { AnyTool } from "../../contracts/index.ts";
import { askUserQuestionTool } from "./ask-user-question.ts";
import { enterPlanModeTool, exitPlanModeTool } from "./plan-mode.ts";
import { todoWriteTool } from "./todo-write.ts";

export {
  type AskUserQuestionInput,
  askUserQuestionTool,
  NO_ONE_TO_ASK_MESSAGE,
} from "./ask-user-question.ts";
export { NoOneToAskError, RequestDismissedError } from "./errors.ts";
export {
  type EnterPlanModeInput,
  type ExitPlanModeInput,
  enterPlanModeTool,
  exitPlanModeTool,
} from "./plan-mode.ts";
export { type TodoWriteInput, todoWriteTool } from "./todo-write.ts";

/** In a fixed order: the tool list is part of every request's cached prefix. */
export const INTERACTIVE_TOOLS: readonly AnyTool[] = [
  todoWriteTool,
  askUserQuestionTool,
  enterPlanModeTool,
  exitPlanModeTool,
];
