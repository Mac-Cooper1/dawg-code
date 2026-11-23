/** The slash-command menu's matching rules. */
import type { CommandInfo } from "@dawg/protocol";

/**
 * What the person is typing as a command name: "/co" → "co", "/" → "". Null once the draft is not
 * a bare command name (no slash at the start, or a space after the name), so the menu closes as
 * soon as arguments begin.
 */
export function commandQuery(draft: string): string | null {
  const match = /^\/(\S*)$/.exec(draft);
  return match ? (match[1] ?? "").toLowerCase() : null;
}

/** Commands whose name contains the query, those that start with it first, then by name. */
export function filterCommands(
  commands: readonly CommandInfo[],
  query: string,
): readonly CommandInfo[] {
  const matches = commands.filter((command) => command.name.toLowerCase().includes(query));
  return matches.sort((a, b) => {
    const aStarts = a.name.toLowerCase().startsWith(query);
    const bStarts = b.name.toLowerCase().startsWith(query);
    if (aStarts !== bStarts) return aStarts ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** True when the command takes arguments, so choosing it fills "/name " instead of sending. */
export function takesArguments(command: CommandInfo): boolean {
  return command.argumentHint !== null;
}
