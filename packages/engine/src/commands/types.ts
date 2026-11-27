/** The slash-command contract: what a command receives and what it hands back. */
import type { SettingsFlags } from "@dawg/compat";
import type { ClientCapabilities, PromptInput } from "@dawg/protocol";
import type { Engine } from "../runtime/engine.ts";
import type { SessionRuntime } from "../runtime/session.ts";
import type { SkillPromptOptions } from "../skills/session-skills.ts";
import type { CommandRegistry } from "./registry.ts";

/** Where a session's model requests go, as shown by `/status` and `/model`. */
export interface EndpointDescription {
  /** `bundled`, `ollama`, `lmstudio` or `remote`. */
  kind: string;
  /** The OpenAI-compatible root, without credentials or query. Null when there is nothing to show. */
  url: string | null;
}

export interface CommandContext {
  /** The name as typed, without the slash (an alias stays an alias). */
  name: string;
  /** Everything after the name, trimmed. */
  args: string;
  session: SessionRuntime;
  engine: Engine;
  registry: CommandRegistry;
  /** The person's home directory: user settings and `~` in paths. */
  homeDir: string;
  /** Command-line settings in force, so `/permissions` can show where each rule came from. */
  settingsFlags: SettingsFlags | undefined;
  /** What the client that ran the command can answer; sessions it opens get the same. */
  capabilities: Partial<ClientCapabilities>;
  /** Describes the endpoint behind a session's current model, when the host knows it. */
  describeEndpoint(session: SessionRuntime): EndpointDescription | null;
}

/**
 * What a command did. Exactly one of three things:
 * - `output`: it answered at once; `text` (Markdown) is for the client to show.
 * - `prompt`: it wants a turn; the host sends `prompt` to the model and returns the turn's id.
 * - `session`: it opened another session (`/clear`, `/resume`); `replaces` names a session it
 *   closed on the way, if any.
 */
export type CommandResult =
  | { kind: "output"; text: string }
  | {
      kind: "prompt";
      prompt: PromptInput;
      text: string | null;
      /** For a skill or custom command: the command as typed, and the skill that ran. */
      options?: SkillPromptOptions;
    }
  | {
      kind: "session";
      session: SessionRuntime;
      text: string | null;
      replaces: string | null;
    };

export interface SlashCommand {
  /** Lowercase, without the slash, for example "compact". */
  name: string;
  /** One line for the `/` menu and `/help`. */
  description: string;
  /** Shown after the name, for example "[focus]". Null when it takes no arguments. */
  argumentHint: string | null;
  /** Other names that run the same command, for example "reset" for "clear". */
  aliases?: readonly string[];
  /** Where it came from: built in, or a custom command or skill from the person's or the project's files. */
  source?: "builtin" | "user" | "project";
  /** A slash command, or a skill the person can also run by name. Default "command". */
  kind?: "command" | "skill";
  run(context: CommandContext): CommandResult | Promise<CommandResult>;
}

/**
 * A command the person mistyped: an unknown name or a bad argument. The message is written for
 * the person. Never turned into a prompt for the model.
 */
export class CommandError extends Error {
  override name = "CommandError";
  /** The command, without the slash. */
  readonly command: string;

  constructor(command: string, message: string) {
    super(message);
    this.command = command;
  }
}
