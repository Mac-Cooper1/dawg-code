/**
 * Skills and custom commands in the mock engine (`project.skills`): what the real engine would
 * find in the mock's home folder and projects, so Settings → Skills and commands shows a full
 * page in tests and the browser preview.
 *
 * The setup it pretends to read:
 * - The home folder: a personal `review` skill and a `standup` command.
 * - `~/code/tally`: a `release` skill only the person may start, a `money-rules` skill only the
 *   agent loads, a namespaced `frontend:test` command, a project `review` the personal one
 *   replaces, and a `compact.md` command that wants one of dawg's own names.
 * - Other projects have none of their own.
 */
import type { SkillInfo } from "@dawg/protocol";

export interface MockSkillsListing {
  projectDir: string | null;
  skills: SkillInfo[];
  commands: SkillInfo[];
}

function info(
  partial: Pick<SkillInfo, "name" | "kind" | "description"> & Partial<SkillInfo>,
  path: string,
  scope: SkillInfo["source"]["scope"],
): SkillInfo {
  return {
    argumentHint: null,
    userInvocable: true,
    modelInvocable: true,
    status: "loaded",
    notes: [],
    ...partial,
    source: { path, origin: "claude", scope },
  };
}

export function mockSkills(projectDir: string | null, homeDir: string): MockSkillsListing {
  const skills: SkillInfo[] = [
    info(
      {
        name: "review",
        kind: "skill",
        description: "Review the current changes for bugs and style. Use when asked for a review.",
        argumentHint: "[focus]",
        status: "partly-supported",
        notes: [
          "model “sonnet” is mapped to the session's model: model names are mapped, not obeyed.",
        ],
      },
      `${homeDir}/.claude/skills/review/SKILL.md`,
      "user",
    ),
  ];
  const commands: SkillInfo[] = [
    info(
      {
        name: "standup",
        kind: "command",
        description: "Write my standup from yesterday's commits",
      },
      `${homeDir}/.claude/commands/standup.md`,
      "user",
    ),
  ];
  if (projectDir === `${homeDir}/code/tally`) {
    skills.push(
      info(
        {
          name: "money-rules",
          kind: "skill",
          description: "How Tally rounds and splits money",
          userInvocable: false,
        },
        `${projectDir}/.claude/skills/money-rules/SKILL.md`,
        "project",
      ),
      info(
        {
          name: "release",
          kind: "skill",
          description: "Cut a release and write its notes",
          argumentHint: "[version]",
          modelInvocable: false,
        },
        `${projectDir}/.claude/skills/release/SKILL.md`,
        "project",
      ),
      info(
        {
          name: "review",
          kind: "skill",
          description: "Review against the project's checklist",
          userInvocable: false,
          notes: [
            "Not used: ~/.claude/skills/review/SKILL.md defines “review” too and takes its place.",
          ],
        },
        `${projectDir}/.claude/skills/review/SKILL.md`,
        "project",
      ),
    );
    commands.push(
      info(
        {
          name: "compact",
          kind: "command",
          description: "Compact the ledger file",
          userInvocable: false,
          status: "partly-supported",
          notes: [
            "/compact is one of dawg's own commands, so typing it runs that; the agent can still load this command.",
          ],
        },
        `${projectDir}/.claude/commands/compact.md`,
        "project",
      ),
      info(
        {
          name: "frontend:test",
          kind: "command",
          description: "Run the frontend tests",
          argumentHint: "[pattern]",
        },
        `${projectDir}/.claude/commands/frontend/test.md`,
        "project",
      ),
    );
  }
  const byName = (a: SkillInfo, b: SkillInfo) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    projectDir,
    skills: skills.sort((a, b) => byName(a, b) || (a.source.scope === "user" ? -1 : 1)),
    commands: commands.sort(byName),
  };
}
