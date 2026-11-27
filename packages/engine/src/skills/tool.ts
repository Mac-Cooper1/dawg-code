/**
 * The `Skill` tool: loads a skill's instructions into the conversation, as Claude Code's tool of
 * that name does (code.claude.com/docs/en/skills and tools-reference). Input: the skill's name
 * and, optionally, its arguments. Supporting files are read on demand with `Read`.
 *
 * Permission, as documented: loading a skill needs none, unless the skill grants or takes away
 * tools (`allowed-tools`, `disallowed-tools`) or a `Skill(...)` rule names it; then the call goes
 * through the permission engine as `Skill(name args)`. A skill marked
 * `disable-model-invocation` loads only when the person's message names `/name`.
 */
import { agentsOf, runSkillAsAgent } from "../agents/manager.ts";
import type { ToolDefinition } from "../contracts/tools.ts";
import { skillsOf } from "./session-skills.ts";

export interface SkillInput {
  skill: string;
  args?: string;
}

function failure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function specifier(input: SkillInput): string {
  const name = input.skill.trim().replace(/^\//, "");
  const args = (input.args ?? "").trim();
  return args === "" ? name : `${name} ${args}`;
}

export const skillTool: ToolDefinition<SkillInput> = {
  name: "Skill",
  description:
    "Loads a skill: instructions for a particular kind of task, from the user's or the project's skill files. The skills you can load are listed under Skills in the system message. Call it with the skill's name, and with args when the skill takes arguments, before you start a task the skill covers; the result holds the skill's instructions, which you then follow.",
  inputSchema: {
    type: "object",
    properties: {
      skill: {
        type: "string",
        description: 'The skill\'s name as listed, for example "review" or "frontend:test".',
      },
      args: {
        type: "string",
        description: "Arguments for the skill, as the user would type them after its name.",
      },
    },
    required: ["skill"],
    additionalProperties: false,
  },
  // Its `!` commands may change things, and it changes the turn's permissions.
  readOnly: false,

  permission(input, ctx) {
    const skills = skillsOf(ctx.state);
    const skill = skills?.find(input.skill);
    if (skills === null || skill === undefined) return { kind: "none" };
    const spec = specifier({ ...input, skill: skill.name });
    if (skill.allowedTools.length > 0 || skill.disallowedTools.length > 0) {
      return { kind: "other", specifier: spec };
    }
    return skills.ruleNames(spec) ? { kind: "other", specifier: spec } : { kind: "none" };
  },

  async execute(input, ctx) {
    const skills = skillsOf(ctx.state);
    const skill = skills?.find(input.skill);
    if (skills === null || skill === undefined) {
      return failure(
        `There is no skill named "${input.skill}". Use one of the skills listed under Skills in the system message, by its exact name.`,
      );
    }
    if (!skill.modelInvocable && !skills.personNamed(skill)) {
      return failure(
        `The skill "${skill.name}" runs only when the user asks for it. Do not load it yourself: suggest that they run /${skill.name}.`,
      );
    }
    const rendered = await skills.render(skill, input.args ?? "", ctx.signal);
    if (!rendered.ok) return failure(rendered.message);
    skills.grant(skill, rendered.grants);
    // `context: fork`: the skill runs as a subagent, and its final message is the result
    // (../agents). In a subagent's own session it runs inline, since agents start no agents.
    const agents = skill.fork ? agentsOf(ctx.state) : null;
    if (agents !== null) {
      return runSkillAsAgent({ manager: agents, skill, body: rendered.body, ctx });
    }
    if (skills.record(skill, rendered.body)) {
      return {
        content: [
          {
            type: "text",
            text: `The skill "${skill.name}" is already loaded above, unchanged. Follow it from there.`,
          },
        ],
      };
    }
    return { content: [{ type: "text", text: skills.toolResultText(skill, rendered.body) }] };
  },
};
