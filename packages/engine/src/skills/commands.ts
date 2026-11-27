/**
 * Skills and custom commands as slash commands: each one a person may run becomes `/name`, per
 * session, since the project's differ from project to project. `/name args` renders the body
 * and sends it as the turn's prompt; the turn shows the command as typed, and the skill's
 * granted tools apply to that turn. dawg's own commands keep their names: a file that wants one
 * is not registered (the report and Settings → Skills and commands show the conflict).
 */
import { commandNameOf, type SkillDefinition } from "@dawg/compat";
import { CommandRegistry } from "../commands/registry.ts";
import { CommandError, type SlashCommand } from "../commands/types.ts";
import { RuntimeError } from "../runtime/errors.ts";
import type { SessionSkills } from "./session-skills.ts";

/** A description for the `/` menu and `/help`: one line, kept short. */
const MAX_MENU_DESCRIPTION = 200;

function menuDescription(skill: SkillDefinition): string {
  const line = skill.description.replace(/\s+/g, " ").trim();
  if (line === "") return skill.kind === "skill" ? "A skill" : "A custom command";
  const short =
    line.length > MAX_MENU_DESCRIPTION ? `${line.slice(0, MAX_MENU_DESCRIPTION - 1)}…` : line;
  return short.replace(/[.!?…]+$/, "");
}

/** The person's message for a forked skill they ran: start it as a subagent, then report. */
function forkPromptText(skill: SkillDefinition, args: string, body: string): string {
  const typed = `/${skill.name}${args.trim() === "" ? "" : ` ${args.trim()}`}`;
  const type = skill.agent ?? "general-purpose";
  return `${typed}\n\nThis skill runs in a subagent. Call the Agent tool once, with subagent_type "${type}", description "${skill.name}", and the instructions below as the prompt, word for word; then tell me what it reports.\n\n${body}`;
}

/** The slash command for a skill or command a person may run, or null when they may not. */
export function skillCommand(skill: SkillDefinition): SlashCommand | null {
  if (!skill.userInvocable) return null;
  const name = commandNameOf(skill.name);
  if (name === null) return null;
  return {
    name,
    description: menuDescription(skill),
    argumentHint: skill.argumentHint,
    source: skill.source.scope === "user" ? "user" : "project",
    kind: skill.kind,
    async run(ctx) {
      const session = ctx.session;
      if (session.busy) {
        throw new RuntimeError("SessionBusy", `/${name} has to wait until the current turn ends.`);
      }
      const skills = session.skills;
      const rendered = await skills.render(skill, ctx.args, new AbortController().signal);
      if (!rendered.ok) throw new CommandError(name, rendered.message);
      // `context: fork`: the agent is asked to run it as a subagent (../agents), which gives it
      // the skill's instructions as the task.
      const text = skill.fork
        ? forkPromptText(skill, ctx.args, rendered.body)
        : skills.promptText(skill, ctx.args, rendered.body);
      return {
        kind: "prompt",
        prompt: { content: [{ type: "text", text }] },
        text: null,
        options: {
          command: { name, args: ctx.args },
          invocation: { skill, body: rendered.body, grants: rendered.grants },
        },
      };
    },
  };
}

/**
 * A registry for one session: `base` (dawg's own commands, which keep their names) and the
 * session's skills and commands that a person may run.
 */
export function sessionCommandRegistry(
  base: CommandRegistry,
  skills: SessionSkills,
): CommandRegistry {
  const registry = new CommandRegistry(base.list());
  for (const skill of skills.initial) {
    const command = skillCommand(skill);
    if (command === null || registry.has(command.name)) continue;
    registry.register(command);
  }
  return registry;
}
