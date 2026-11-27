/**
 * Compatibility fixtures for skills and custom commands (see ../types.ts), written from Claude
 * Code's public docs: code.claude.com/docs/en/skills (locations, precedence, the frontmatter
 * reference, string substitutions, dynamic context) and its section on the older
 * `.claude/commands/` files.
 */
import type { CompatFixture } from "../types.ts";

const MAPPED = "mapped to the session's model";
const FORK = "the agent is asked to start the subagent";

export const FIXTURES: Record<string, CompatFixture> = {
  "skills/project-skill-and-command": {
    description:
      "A project skill with supporting files and a custom command with arguments, as the docs' examples write them (docs: skills).",
    files: {
      "project/.claude/skills/review/SKILL.md": [
        "---",
        "name: review",
        "description: Review the current changes for bugs and style. Use when the user asks for a review.",
        "allowed-tools: Read Grep Bash(git diff *)",
        "---",
        "",
        "Review the changes: !`git diff HEAD`",
        "",
        "Follow the checklist in [checklist.md](checklist.md), from ${CLAUDE_SKILL_DIR}.",
        "",
      ].join("\n"),
      "project/.claude/skills/review/checklist.md": "- Names say what things are.\n",
      "project/.claude/commands/fix-issue.md": [
        "---",
        "description: Fix a GitHub issue",
        "argument-hint: [issue-number]",
        "allowed-tools: Bash(gh *)",
        "disable-model-invocation: true",
        "---",
        "Fix GitHub issue $ARGUMENTS following our coding standards.",
        "",
      ].join("\n"),
    },
    expected: {
      items: [
        {
          kind: "skill",
          name: "/review",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["Project code: its inline shell commands and allowed-tools take effect only once you approve"],
        },
        {
          kind: "command",
          name: "/fix-issue",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["Project code: its allowed-tools take effect only once you approve"],
        },
      ],
      // Inline shell and allowed-tools from the project's files are code it supplies (principle 3).
      approval: { items: 2 },
    },
  },

  "skills/command-namespaces": {
    description:
      "Commands in subfolders of .claude/commands take the folder as a namespace: frontend/component.md is /frontend:component (docs: skills, custom commands).",
    files: {
      "project/.claude/commands/frontend/component.md": "Create a React component named $0.\n",
      "project/.claude/commands/frontend/tests/unit.md":
        "---\ndescription: Run the unit tests\n---\nRun the unit tests for $ARGUMENTS.\n",
      // Written for the older docs, where $1 was the first argument.
      "project/.claude/commands/compare.md": "Compare $1 with $2.\n",
      "home/.claude/commands/standup.md": "# Write my standup\n\nSummarise yesterday's commits.\n",
    },
    expected: {
      items: [
        { kind: "command", name: "/standup", scope: "user", origin: "claude", status: "loaded" },
        {
          kind: "command",
          name: "/compare",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["arguments count from 0"],
        },
        {
          kind: "command",
          name: "/frontend:component",
          scope: "project",
          origin: "claude",
          status: "loaded",
        },
        {
          kind: "command",
          name: "/frontend:tests:unit",
          scope: "project",
          origin: "claude",
          status: "loaded",
        },
      ],
      approval: null,
    },
  },

  "skills/precedence": {
    description:
      "One name in several places: personal over project, .dawg over .claude at one level, a skill over a command of the same name (docs: skills, where skills live; spec principle 1).",
    files: {
      "home/.claude/skills/deploy/SKILL.md": "---\ndescription: Deploy my way\n---\nDeploy.\n",
      "project/.claude/skills/deploy/SKILL.md": "---\ndescription: Deploy the project's way\n---\nDeploy.\n",
      "project/.claude/skills/lint/SKILL.md": "---\ndescription: Lint, Claude Code's file\n---\nLint.\n",
      "project/.dawg/skills/lint/SKILL.md": "---\ndescription: Lint, dawg's file\n---\nLint.\n",
      "project/.claude/commands/lint.md": "Lint everything.\n",
    },
    expected: {
      items: [
        { kind: "skill", name: "/deploy", scope: "user", origin: "claude", status: "loaded" },
        {
          kind: "skill",
          name: "/deploy",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["Not used: ~/.claude/skills/deploy/SKILL.md defines “deploy” too"],
        },
        {
          kind: "skill",
          name: "/lint",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["Not used: "],
        },
        { kind: "skill", name: "/lint", scope: "project", origin: "dawg", status: "loaded" },
        {
          kind: "command",
          name: "/lint",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["Not used: "],
        },
      ],
      approval: null,
    },
  },

  "skills/invocation-switches": {
    description:
      "user-invocable: false hides a skill from the / menu; disable-model-invocation: true keeps it out of the agent's listing; yes/no and on/off are booleans too (docs: skills, control who invokes a skill).",
    files: {
      "project/.claude/skills/legacy-context/SKILL.md":
        "---\ndescription: How the old billing system works\nuser-invocable: false\n---\nThe old system...\n",
      "project/.claude/skills/ship/SKILL.md":
        "---\ndescription: Ship a release\ndisable-model-invocation: yes\nargument-hint: [version] [channel]\n---\nShip $0 to $1.\n",
    },
    expected: {
      items: [
        { kind: "skill", name: "legacy-context", scope: "project", origin: "claude", status: "loaded" },
        { kind: "skill", name: "/ship", scope: "project", origin: "claude", status: "loaded" },
      ],
      approval: null,
    },
  },

  "skills/partly-supported-fields": {
    description:
      "Fields dawg maps or does not run yet are named: model (mapped), context: fork with agent (no subagents yet), effort, hooks, paths (docs: skills, frontmatter reference; spec principle 4).",
    files: {
      "home/.claude/skills/research/SKILL.md": [
        "---",
        "description: Research a question in the codebase",
        "context: fork",
        "agent: Explore",
        "model: haiku",
        "---",
        "Research $ARGUMENTS thoroughly.",
        "",
      ].join("\n"),
      "project/.claude/skills/api-rules/SKILL.md": [
        "---",
        "description: Rules for the API code",
        "paths: src/api/**",
        "effort: high",
        "hooks:",
        "  PostToolUse:",
        "    - matcher: Edit",
        "      hooks:",
        "        - type: command",
        "          command: npm run lint",
        "---",
        "Keep handlers small.",
        "",
      ].join("\n"),
      "project/.claude/commands/summarise.md": "---\nmodel: sonnet\n---\nSummarise the diff.\n",
    },
    expected: {
      items: [
        {
          kind: "skill",
          name: "/research",
          scope: "user",
          origin: "claude",
          status: "loaded",
          notes: [FORK, MAPPED],
        },
        {
          kind: "skill",
          name: "/api-rules",
          scope: "project",
          origin: "claude",
          status: "partly-supported",
          notes: ["paths is ignored", "effort is ignored", "hooks in a skill are not run yet"],
        },
        {
          kind: "command",
          name: "/summarise",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: [MAPPED],
        },
      ],
      approval: null,
    },
  },

  "skills/nested-folders": {
    description:
      "A monorepo: a nested .claude/skills folder loads when the agent works there, and a nested skill whose name the root has is /apps/web:deploy (docs: skills, monorepo and nested discovery).",
    files: {
      "project/.git/HEAD": "ref: refs/heads/main\n",
      "project/.claude/skills/deploy/SKILL.md": "---\ndescription: Deploy everything\n---\nDeploy.\n",
      "project/apps/web/.claude/skills/deploy/SKILL.md": "---\ndescription: Deploy the web app\n---\nDeploy web.\n",
      "project/apps/web/.claude/skills/storybook/SKILL.md": "---\ndescription: Run Storybook\n---\nRun it.\n",
    },
    expected: {
      items: [
        { kind: "skill", name: "/deploy", scope: "project", origin: "claude", status: "loaded" },
        {
          kind: "skill",
          name: "/apps/web:deploy",
          scope: "nested",
          origin: "claude",
          status: "partly-supported",
          notes: ["cannot be typed as a command here", "Loads once the agent reads or edits a file in apps/web"],
        },
        {
          kind: "skill",
          name: "/storybook",
          scope: "nested",
          origin: "claude",
          status: "loaded",
          notes: ["Loads once the agent reads or edits a file in apps/web"],
        },
      ],
      approval: null,
    },
  },

  "skills/conflicts-and-invalid-files": {
    description:
      "A command named like one of dawg's own (/compact) is a conflict; YAML that does not parse loads with no fields; a refused name does not load (docs: skills, frontmatter and name rules).",
    files: {
      "project/.claude/commands/compact.md": "Compact my notes file.\n",
      "project/.claude/skills/broken/SKILL.md": "---\ndescription: [unclosed\n  - : :\n---\nStill usable.\n",
      "project/.claude/skills/angle/SKILL.md": "---\nname: a<b>\n---\nNope.\n",
      "project/.claude/skills/extra/SKILL.md": "---\ndescription: Has an unknown field\nversion: 3\n---\nx\n",
    },
    expected: {
      items: [
        {
          kind: "skill",
          name: "/a<b>",
          scope: "project",
          origin: "claude",
          status: "invalid",
          notes: ["has a character Claude Code refuses"],
        },
        {
          kind: "skill",
          name: "/broken",
          scope: "project",
          origin: "claude",
          status: "partly-supported",
          notes: ["not valid YAML", "loads with no fields"],
        },
        {
          kind: "skill",
          name: "/extra",
          scope: "project",
          origin: "claude",
          status: "loaded",
          notes: ["Unknown field “version” is ignored"],
        },
        {
          kind: "command",
          name: "/compact",
          scope: "project",
          origin: "claude",
          status: "partly-supported",
          notes: ["/compact is one of dawg's own commands"],
        },
      ],
      approval: null,
    },
  },
};
