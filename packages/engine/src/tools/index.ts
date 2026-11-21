/**
 * The built-in tools. `CORE_TOOLS` is in a fixed order because the tool list is part of every
 * request's prefix: reordering it would throw away the prompt cache.
 */
import type { AnyTool } from "../contracts/index.ts";
import { bashTool, taskStopTool } from "./bash/index.ts";
import { editTool } from "./edit/index.ts";
import { globTool } from "./glob/index.ts";
import { grepTool } from "./grep/index.ts";
import { readTool } from "./read/index.ts";
import { writeTool } from "./write/index.ts";

export {
  type BackgroundTaskInfo,
  type BackgroundTaskStatus,
  type BackgroundTasks,
  getBackgroundTasks,
  getShellState,
} from "./bash/index.ts";
export { fileTracker } from "./files/index.ts";
export { RipgrepNotFoundError, resolveRipgrep } from "./ripgrep/index.ts";
export { bashTool, editTool, globTool, grepTool, readTool, taskStopTool, writeTool };

export const CORE_TOOLS: readonly AnyTool[] = [
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  bashTool,
  taskStopTool,
];
