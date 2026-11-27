/**
 * The slash-command registry. Built-in commands are registered at start; Phase 4 adds commands
 * from the person's and the project's files through `register`.
 */
import type { CommandInfo } from "@dawg/protocol";
import {
  type CommandContext,
  CommandError,
  type CommandResult,
  type SlashCommand,
} from "./types.ts";

/** Names may hold a namespace, as in "frontend:test", so user commands can be grouped. */
const NAME_PATTERN = /^[a-z][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)*$/;

export class CommandRegistry {
  readonly #commands = new Map<string, SlashCommand>();
  /** Alias to command name. */
  readonly #aliases = new Map<string, string>();

  constructor(commands: readonly SlashCommand[] = []) {
    for (const command of commands) this.register(command);
  }

  /**
   * Adds a command. A name or alias already taken is refused unless `replace` is set, so a
   * user-defined command cannot silently shadow a built-in one.
   */
  register(command: SlashCommand, options: { replace?: boolean } = {}): void {
    const names = [command.name, ...(command.aliases ?? [])];
    for (const name of names) {
      if (!NAME_PATTERN.test(name)) {
        throw new Error(`"${name}" is not a valid command name.`);
      }
    }
    if (options.replace) this.unregister(command.name);
    for (const name of names) {
      const owner = this.#commands.has(name) ? name : this.#aliases.get(name);
      if (owner !== undefined && owner !== command.name) {
        throw new Error(`/${name} is already taken by /${owner}.`);
      }
      if (owner === command.name && this.#commands.get(command.name) !== command) {
        throw new Error(`/${name} is already registered.`);
      }
    }
    this.#commands.set(command.name, command);
    for (const alias of command.aliases ?? []) this.#aliases.set(alias, command.name);
  }

  /** Removes a command and its aliases. False when there was none. */
  unregister(name: string): boolean {
    const command = this.#commands.get(name);
    if (command === undefined) return false;
    this.#commands.delete(name);
    for (const alias of command.aliases ?? []) this.#aliases.delete(alias);
    return true;
  }

  /** A command by name or alias, case-insensitively. */
  get(name: string): SlashCommand | undefined {
    const key = name.toLowerCase();
    return this.#commands.get(key) ?? this.#commands.get(this.#aliases.get(key) ?? "");
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** Every command, by name. */
  list(): SlashCommand[] {
    return [...this.#commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The protocol's `commands` list for a session snapshot. */
  info(): CommandInfo[] {
    return this.list().map((c) => ({
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
      source: c.source ?? "builtin",
      kind: c.kind ?? "command",
    }));
  }

  /**
   * Runs a command. An unknown name is a `CommandError`, never a prompt: text that only looks
   * like a command must be sent as a prompt by the client, on purpose.
   */
  async run(
    name: string,
    context: Omit<CommandContext, "name" | "registry" | "args"> & { args: string },
  ): Promise<CommandResult> {
    const bare = name.startsWith("/") ? name.slice(1) : name;
    const command = this.get(bare);
    if (command === undefined) {
      throw new CommandError(bare, `Unknown command /${bare}. Type /help to see the commands.`);
    }
    return command.run({ ...context, name: bare, registry: this, args: context.args.trim() });
  }
}

/**
 * Splits a typed line such as "/compact keep the API notes" into name and arguments. Null when
 * the line is not a command: no leading slash, or a slash followed by something that cannot be a
 * name (a path such as "/usr/bin" is a name-shaped word, so callers check the registry too).
 */
export function parseSlashCommand(line: string): { name: string; args: string } | null {
  const match = /^\/([A-Za-z][A-Za-z0-9_:-]*)(?:\s+([\s\S]*))?$/.exec(line.trim());
  if (match === null) return null;
  return { name: (match[1] ?? "").toLowerCase(), args: (match[2] ?? "").trim() };
}

/**
 * Splits command arguments into words, honouring single and double quotes and backslash escapes,
 * so a path with spaces can be given as one argument. Throws on an unclosed quote.
 */
export function splitArguments(text: string, command: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < text.length) {
        i += 1;
        current += text[i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && i + 1 < text.length) {
      i += 1;
      current += text[i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (quote !== null) throw new CommandError(command, `Unclosed ${quote} in the arguments.`);
  if (inWord) words.push(current);
  return words;
}
