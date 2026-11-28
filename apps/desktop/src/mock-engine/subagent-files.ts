/**
 * Subagent definitions in the mock engine (`project.subagents`, `subagent.create`, `/agents`):
 * what the real engine would find in the mock's home folder and projects, so Settings →
 * Subagents shows a full page in tests and the browser preview, and the "New subagent" form
 * has something to write to.
 *
 * The setup it pretends to read:
 * - dawg's built-ins: Explore and Plan (read-only) and general-purpose.
 * - The home folder: a personal `test-runner` in `~/.claude/agents` with project memory, and a
 *   `release-notes` in `~/.dawg/agents`.
 * - `~/code/tally`: a `code-reviewer` whose tools grant `Bash(npm test *)` and so waits for the
 *   project's code to be approved, a `test-runner` that takes the personal one's place, and a
 *   `designer` file without a description, which cannot be loaded.
 * - Other projects have none of their own.
 *
 * Files the form writes are kept in memory for the engine's life and listed from then on.
 */
import { ErrorCodes, type ParsedParams, RpcError, type SubagentDefinition } from "@dawg/protocol";

export interface MockSubagentsListing {
  projectDir: string | null;
  agents: SubagentDefinition[];
  folders: { user: string; project: string | null };
}

/** What the real engine refuses in a new agent's name (compat's `newAgentNameProblem`). */
export function newAgentNameProblem(name: string): string | null {
  if (name === "") return "Give the subagent a name.";
  if (name.length > 64) return "A name has at most 64 characters.";
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
    return "Use lowercase letters, digits and single hyphens, starting with a letter, as in code-reviewer.";
  }
  if (name === "fork") return "“fork” names a copy of the conversation; choose another name.";
  if (name === "general-purpose") {
    return "“general-purpose” is one of dawg's built-in agents. To replace it, write the file by hand.";
  }
  return null;
}

const MAPPED = (model: string) =>
  `model “${model}” is mapped to the session's model: model names are mapped, not obeyed.`;

function definition(
  partial: Pick<SubagentDefinition, "name" | "description"> & Partial<SubagentDefinition>,
): SubagentDefinition {
  return {
    builtIn: false,
    source: null,
    tools: null,
    disallowedTools: [],
    model: null,
    mappedModel: null,
    permissionMode: null,
    readOnly: false,
    maxTurns: null,
    skills: [],
    memory: null,
    memoryDirectory: null,
    mcpServers: [],
    background: false,
    isolation: null,
    status: "loaded",
    overriddenBy: null,
    notes: [],
    ...partial,
  };
}

const BUILT_INS: readonly SubagentDefinition[] = [
  definition({
    name: "Explore",
    description:
      'Read-only search of the codebase: finds files, code and facts and reports where they are, without changing anything. Say how thorough to be: "quick", "medium" or "very thorough".',
    builtIn: true,
    disallowedTools: ["Write", "Edit", "NotebookEdit", "TodoWrite"],
    permissionMode: "plan",
    readOnly: true,
  }),
  definition({
    name: "Plan",
    description:
      "Read-only design: studies the code and returns a step-by-step plan for a change, with the files to touch, the order of work, how to verify it and the risks.",
    builtIn: true,
    disallowedTools: ["Write", "Edit", "NotebookEdit", "TodoWrite"],
    permissionMode: "plan",
    readOnly: true,
  }),
  definition({
    name: "general-purpose",
    description:
      "Carries out a multi-step task with every tool: research, changes across files, running commands. Use it when the work is independent and its details need not be in your own context.",
    builtIn: true,
  }),
];

interface Written {
  definition: SubagentDefinition;
  /** The project it was written for, or null for the person's own. */
  projectDir: string | null;
}

export class MockSubagentFiles {
  readonly #homeDir: string;
  readonly #written: Written[] = [];

  constructor(homeDir: string) {
    this.#homeDir = homeDir;
  }

  #folders(projectDir: string | null) {
    return {
      user: `${this.#homeDir}/.dawg/agents`,
      project: projectDir === null ? null : `${projectDir}/.dawg/agents`,
    };
  }

  list(projectDir: string | null): MockSubagentsListing {
    const home = this.#homeDir;
    const tally = `${home}/code/tally`;
    const inTally = projectDir === tally;
    const personal: SubagentDefinition[] = [
      definition({
        name: "test-runner",
        description: "Runs the test suite and reports the failures, with their causes.",
        source: { path: `${home}/.claude/agents/test-runner.md`, origin: "claude", scope: "user" },
        tools: ["Bash", "Read", "Grep"],
        model: "haiku",
        memory: "project",
        memoryDirectory:
          projectDir === null ? null : `${projectDir}/.dawg/agent-memory/test-runner`,
        status: inTally ? "overridden" : "loaded",
        overriddenBy: inTally ? `${tally}/.claude/agents/test-runner.md` : null,
        notes: [
          MAPPED("haiku"),
          ...(inTally
            ? [
                "Not used: .claude/agents/test-runner.md defines “test-runner” too and takes its place.",
              ]
            : []),
        ],
      }),
      definition({
        name: "release-notes",
        description: "Writes release notes from the commits since the last tag.",
        source: { path: `${home}/.dawg/agents/release-notes.md`, origin: "dawg", scope: "user" },
        tools: ["Read", "Grep", "Glob", "Bash(git log *)"],
        background: true,
      }),
    ];
    const project: SubagentDefinition[] = inTally
      ? [
          definition({
            name: "code-reviewer",
            description: "Reviews the current changes for bugs, style and missing tests.",
            source: {
              path: `${tally}/.claude/agents/code-reviewer.md`,
              origin: "claude",
              scope: "project",
            },
            tools: ["Read", "Grep", "Glob", "Bash(npm test *)", "mcp__github__*"],
            model: "sonnet",
            mcpServers: [{ name: "github", inline: false }],
            status: "needs-approval",
            notes: [
              "Lets these run without asking while the agent works: Bash(npm test *), so it waits for your approval.",
              MAPPED("sonnet"),
              "Project code: its tool grants take effect only once you approve the project's code.",
            ],
          }),
          definition({
            name: "designer",
            description: "",
            source: {
              path: `${tally}/.claude/agents/designer.md`,
              origin: "claude",
              scope: "project",
            },
            status: "invalid",
            notes: ["Needs a description in its front matter, as Claude Code requires."],
          }),
          definition({
            name: "test-runner",
            description: "Runs Tally's tests against the local database.",
            source: {
              path: `${tally}/.claude/agents/test-runner.md`,
              origin: "claude",
              scope: "project",
            },
            tools: ["Bash", "Read"],
            maxTurns: 20,
            isolation: "worktree",
          }),
        ]
      : [];
    const written = this.#written
      .filter((w) => w.projectDir === null || w.projectDir === projectDir)
      .map((w) => w.definition);
    const order = (a: SubagentDefinition, b: SubagentDefinition) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    return {
      projectDir,
      agents: [
        ...BUILT_INS,
        ...[...personal, ...written.filter((d) => d.source?.scope === "user")].sort(order),
        ...[...project, ...written.filter((d) => d.source?.scope !== "user")].sort(order),
      ],
      folders: this.#folders(projectDir),
    };
  }

  /** `subagent.create`: checks the name and the folder, then keeps the new file. */
  create(params: ParsedParams<"subagent.create">): {
    path: string;
    agent: SubagentDefinition;
  } {
    const name = params.name.trim();
    const problem = newAgentNameProblem(name);
    if (problem !== null) throw new RpcError(ErrorCodes.InvalidParams, problem);
    if (params.description.trim() === "") {
      throw new RpcError(ErrorCodes.InvalidParams, "Give the subagent a description.");
    }
    const folders = this.#folders(params.projectDir);
    const folder = params.scope === "user" ? folders.user : folders.project;
    if (folder === null) {
      throw new RpcError(ErrorCodes.InvalidParams, "A project subagent needs a project.");
    }
    const path = `${folder}/${name}.md`;
    const taken =
      this.list(params.projectDir).agents.some((d) => d.source?.path === path) ||
      this.#written.some((w) => w.definition.source?.path === path);
    if (taken) {
      throw new RpcError(
        ErrorCodes.InvalidState,
        `${path.replace(this.#homeDir, "~")} already exists, and dawg never overwrites a file. Choose another name, or edit that file.`,
      );
    }
    const memory = params.memory ?? null;
    const agent = definition({
      name,
      description: params.description.replace(/\s+/g, " ").trim(),
      source: { path, origin: "dawg", scope: params.scope === "user" ? "user" : "project" },
      tools: params.tools ?? null,
      memory,
      memoryDirectory:
        memory === null
          ? null
          : memory === "user"
            ? `${this.#homeDir}/.dawg/agent-memory/${name}`
            : params.projectDir === null
              ? null
              : `${params.projectDir}/.dawg/${memory === "project" ? "agent-memory" : "agent-memory-local"}/${name}`,
    });
    this.#written.push({
      definition: agent,
      projectDir: params.scope === "user" ? null : params.projectDir,
    });
    return { path, agent };
  }

  /** `/agents`, for clients without Settings: the listing as text. */
  text(projectDir: string | null): string {
    const { agents } = this.list(projectDir);
    const lines = ["Subagents new sessions here can start:"];
    for (const agent of agents) {
      if (agent.status === "invalid" || agent.status === "overridden") continue;
      const where = agent.builtIn
        ? "built in"
        : agent.source?.scope === "user"
          ? "yours"
          : "project";
      lines.push(`  ${agent.name} (${where}): ${agent.description}`);
    }
    lines.push("", "Settings → Subagents shows each one's details and makes new ones.");
    return lines.join("\n");
  }
}
