/**
 * `project.skills`: every skill and custom command a project's sessions get, for Settings →
 * Skills and commands. Read from the files as they are now (a session keeps what it read when it
 * opened), with folders inside the project and definitions not used included, so the page
 * accounts for everything it found.
 */
import { commandNameOf, loadSkills, type SkillDefinition } from "@dawg/compat";
import type { SkillInfo } from "@dawg/protocol";
import type { CommandRegistry } from "../commands/registry.ts";

/** Every name a registry's commands answer to, aliases included. */
export function registryNames(registry: CommandRegistry): string[] {
  return registry.list().flatMap((command) => [command.name, ...(command.aliases ?? [])]);
}

export function skillInfo(def: SkillDefinition, reserved: ReadonlySet<string>): SkillInfo {
  const typed = commandNameOf(def.name);
  return {
    name: def.name,
    kind: def.kind,
    description: def.description,
    argumentHint: def.argumentHint,
    source: def.source,
    userInvocable:
      def.userInvocable &&
      def.status !== "invalid" &&
      def.shadowedBy === null &&
      typed !== null &&
      !reserved.has(typed),
    modelInvocable: def.modelInvocable,
    status: def.status,
    notes: [...def.notes],
  };
}

export async function projectSkills(input: {
  homeDir: string;
  projectDir: string | null;
  /** dawg's own commands, which keep their names. */
  builtins: CommandRegistry;
}): Promise<{ projectDir: string | null; skills: SkillInfo[]; commands: SkillInfo[] }> {
  const reserved = registryNames(input.builtins);
  const set = await loadSkills({
    homeDir: input.homeDir,
    cwd: input.projectDir,
    nested: true,
    reservedNames: reserved,
  });
  const reservedSet = new Set(reserved);
  // By name, then in precedence order (the one in use first).
  const ordered = set.all
    .map((def, index) => ({ def, index }))
    .sort((a, b) =>
      a.def.name === b.def.name
        ? a.index - b.index
        : a.def.name.toLowerCase() < b.def.name.toLowerCase()
          ? -1
          : 1,
    )
    .map(({ def }) => skillInfo(def, reservedSet));
  return {
    projectDir: input.projectDir,
    skills: ordered.filter((info) => info.kind === "skill"),
    commands: ordered.filter((info) => info.kind === "command"),
  };
}
