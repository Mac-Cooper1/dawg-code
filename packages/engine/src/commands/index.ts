/**
 * Slash commands: a registry Phase 4 can add user-defined commands to, and the built-in commands.
 * The protocol server runs them for `session.command`.
 */
import { BUILTIN_COMMANDS } from "./builtins.ts";
import { CommandRegistry } from "./registry.ts";

export { BUILTIN_COMMANDS, showPath } from "./builtins.ts";
export { chooseInstructionFile, type InitTarget, initPrompt } from "./init.ts";
export { memoryCommand } from "./memory.ts";
export { CommandRegistry, parseSlashCommand, splitArguments } from "./registry.ts";
export { rewindCommand, SHELL_CAVEAT } from "./rewind.ts";
export {
  type CommandContext,
  CommandError,
  type CommandResult,
  type EndpointDescription,
  type SlashCommand,
} from "./types.ts";

/** A registry holding the built-in commands. Each host gets its own, so additions stay local. */
export function createCommandRegistry(): CommandRegistry {
  return new CommandRegistry(BUILTIN_COMMANDS);
}
