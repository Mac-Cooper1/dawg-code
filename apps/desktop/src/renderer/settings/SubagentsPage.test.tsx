import type { SubagentDefinition } from "@dawg/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createTestStore, renderWithStore } from "../app/testing.tsx";
import type { SubagentsListing } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { SettingsContainer } from "./SettingsContainer.tsx";
import {
  agentDetails,
  newSubagentNameProblem,
  SubagentsPage,
  type SubagentsPageProps,
  splitTools,
} from "./SubagentsPage.tsx";

const HOME = "/Users/me";
const TALLY = `${HOME}/code/tally`;
const NOTES = `${HOME}/code/notes-cli`;

function agent(
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

const EXPLORE = agent({
  name: "Explore",
  description: "Read-only search of the codebase",
  builtIn: true,
  disallowedTools: ["Write", "Edit"],
  permissionMode: "plan",
  readOnly: true,
});

const PERSONAL = agent({
  name: "test-runner",
  description: "Runs the tests and reports failures",
  source: { path: `${HOME}/.claude/agents/test-runner.md`, origin: "claude", scope: "user" },
  tools: ["Bash", "Read"],
  model: "haiku",
  status: "overridden",
  overriddenBy: `${TALLY}/.dawg/agents/test-runner.md`,
});

const REVIEWER = agent({
  name: "code-reviewer",
  description: "Reviews the current changes",
  source: { path: `${TALLY}/.claude/agents/code-reviewer.md`, origin: "claude", scope: "project" },
  tools: ["Read", "Grep", "Bash(npm test *)", "mcp__github__*"],
  model: "sonnet",
  memory: "project",
  memoryDirectory: `${TALLY}/.dawg/agent-memory/code-reviewer`,
  mcpServers: [
    { name: "github", inline: false },
    { name: "browser", inline: true },
  ],
  background: true,
  isolation: "worktree",
  maxTurns: 12,
  skills: ["lint"],
  status: "needs-approval",
  notes: ["Lets these run without asking while the agent works: Bash(npm test *)."],
});

const BROKEN = agent({
  name: "designer",
  description: "",
  source: { path: `${TALLY}/.claude/agents/designer.md`, origin: "claude", scope: "project" },
  status: "invalid",
  notes: ["Needs a description in its front matter, as Claude Code requires."],
});

function listing(overrides: Partial<SubagentsListing> = {}): SubagentsListing {
  return {
    projectDir: TALLY,
    agents: [EXPLORE, PERSONAL, REVIEWER, BROKEN],
    folders: { user: `${HOME}/.dawg/agents`, project: `${TALLY}/.dawg/agents` },
    ...overrides,
  };
}

function setup(theme: "dark" | "light", overrides: Partial<SubagentsPageProps> = {}) {
  const props: SubagentsPageProps = {
    projects: [
      { dir: TALLY, name: "tally" },
      { dir: NOTES, name: "notes-cli" },
    ],
    initialProject: TALLY,
    homeDir: HOME,
    listSubagents: vi.fn(async (projectDir: string | null) =>
      projectDir === TALLY
        ? listing()
        : listing({
            projectDir,
            agents: [EXPLORE],
            folders: {
              user: `${HOME}/.dawg/agents`,
              project: projectDir === null ? null : `${projectDir}/.dawg/agents`,
            },
          }),
    ),
    createSubagent: vi.fn(async () => ({ error: "Not in this test." })),
    onOpenFile: vi.fn(),
    ...overrides,
  };
  renderInTheme(<SubagentsPage {...props} />, theme);
  return { props, user: userEvent.setup() };
}

const group = (name: RegExp) => screen.findByRole("list", { name });
/** An agent's row: a list item named by the agent. */
const rowOf = (list: HTMLElement, name: string) => within(list).getByRole("listitem", { name });

describe.each(THEMES)("SubagentsPage (%s)", (theme) => {
  it("groups the agents by where they come from, each with its details", async () => {
    setup(theme);
    expect(screen.getByRole("heading", { level: 1, name: "Subagents" })).toBeVisible();
    const builtIn = await group(/^Built in/);
    const explore = rowOf(builtIn, "Explore");
    expect(explore).toHaveTextContent("Built in");
    expect(explore).toHaveTextContent("dawg’s own, written for this project.");
    expect(explore).toHaveTextContent("Plan (read-only)");
    expect(explore).toHaveTextContent("Not givenWrite, Edit");
    expect(within(explore).queryByRole("button", { name: "Open file" })).toBeNull();

    const yours = screen.getByRole("list", { name: /^Yours/ });
    const personal = rowOf(yours, "test-runner");
    expect(personal).toHaveTextContent("Personal");
    expect(personal).toHaveTextContent("Overridden");
    expect(personal).toHaveTextContent("~/.claude/agents/test-runner.md");
    expect(personal).toHaveTextContent("Claude Code’s file, yours everywhere");
    expect(personal).toHaveTextContent("haiku, runs on the session’s model");
    expect(within(personal).getByRole("list", { name: "Notes" })).toHaveTextContent(
      "Not used: ~/code/tally/.dawg/agents/test-runner.md takes its place.",
    );

    const project = screen.getByRole("list", { name: /^This project/ });
    const reviewer = rowOf(project, "code-reviewer");
    expect(reviewer).toHaveTextContent("Needs approval");
    expect(reviewer).toHaveTextContent("ToolsRead, Grep, Bash(npm test *), mcp__github__*");
    expect(reviewer).toHaveTextContent(
      "MemoryThe project’s, shared: ~/code/tally/.dawg/agent-memory/code-reviewer",
    );
    expect(reviewer).toHaveTextContent("MCP serversgithub, browser (its own)");
    expect(reviewer).toHaveTextContent("In the background; In a git worktree of its own");
    expect(reviewer).toHaveTextContent("12 model requests per task");
    expect(reviewer).toHaveTextContent("Skillslint");
    expect(reviewer).toHaveTextContent("The parent’s");
    const broken = rowOf(project, "designer");
    expect(broken).toHaveTextContent("Could not be loaded");
    expect(broken).toHaveTextContent("Needs a description");
  });

  it("opens an agent's file, named for VoiceOver with the agent", async () => {
    const { props, user } = setup(theme);
    const project = await group(/^This project/);
    const button = within(rowOf(project, "code-reviewer")).getByRole("button", {
      name: "Open file",
    });
    expect(button).toHaveAccessibleDescription("code-reviewer");
    button.focus();
    await user.keyboard("{Enter}");
    expect(props.onOpenFile).toHaveBeenCalledWith(`${TALLY}/.claude/agents/code-reviewer.md`);
  });

  it("follows the project picked, and says when there are no agent files", async () => {
    const { props, user } = setup(theme);
    await group(/^This project/);
    await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), NOTES);
    await waitFor(() => expect(props.listSubagents).toHaveBeenLastCalledWith(NOTES));
    expect(await screen.findByText(/No agent files yet/)).toBeVisible();
    expect(screen.queryByRole("list", { name: /^This project/ })).toBeNull();
  });

  it("says when the list could not be read", async () => {
    setup(theme, { listSubagents: vi.fn(async () => ({ error: "The engine is not running." })) });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not list the subagents: The engine is not running.",
    );
  });

  it("checks the new agent's name and description before writing anything", async () => {
    const { props, user } = setup(theme);
    await group(/^This project/);
    await user.click(screen.getByRole("button", { name: "New subagent" }));
    const form = screen.getByRole("region", { name: "New subagent" });
    const name = within(form).getByRole("textbox", { name: "Name" });
    expect(name).toHaveFocus();
    await user.click(within(form).getByRole("button", { name: "Make subagent" }));
    expect(name).toHaveAccessibleDescription("Give the subagent a name.");
    expect(props.createSubagent).not.toHaveBeenCalled();
    await user.type(name, "Code Reviewer");
    expect(name).toHaveAccessibleDescription(/Use lowercase letters, digits and single hyphens/);
    await user.clear(name);
    await user.type(name, "general-purpose");
    expect(name).toHaveAccessibleDescription(/one of dawg’s built-in agents/);
    await user.clear(name);
    await user.type(name, "test-runner");
    // The same name elsewhere: allowed, with the order that decides between them.
    expect(name).toHaveAccessibleDescription(/An agent named “test-runner” is already listed/);
    await user.clear(name);
    await user.type(name, "reviewer");
    await user.click(within(form).getByRole("button", { name: "Make subagent" }));
    expect(within(form).getByRole("textbox", { name: "Description" })).toHaveAccessibleDescription(
      /Say what the agent does and when to use it/,
    );
    expect(props.createSubagent).not.toHaveBeenCalled();
    // Cancel closes it and gives focus back to the button.
    await user.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "New subagent" })).toHaveFocus());
  });

  it("says a project file's grants wait for approval, and refuses a file already there", async () => {
    const { user } = setup(theme);
    await group(/^This project/);
    await user.click(screen.getByRole("button", { name: "New subagent" }));
    const form = screen.getByRole("region", { name: "New subagent" });
    await user.type(within(form).getByRole("textbox", { name: "Name" }), "checker");
    expect(form).toHaveTextContent(
      "Writes ~/.dawg/agents/checker.md. New sessions can start it; sessions already open keep the agents they started with.",
    );
    await user.click(within(form).getByRole("radio", { name: /This project/ }));
    await user.type(within(form).getByRole("textbox", { name: "Tools" }), "Read, Bash(npm test *)");
    expect(form).toHaveTextContent("Writes ~/code/tally/.dawg/agents/checker.md.");
    expect(form).toHaveTextContent(
      "Its tools field lets Bash(npm test *) run without asking, so in a project file that waits until you approve the project’s code.",
    );
    // Only Yours, the grant is the person's own.
    await user.click(within(form).getByRole("radio", { name: /Just for you/ }));
    expect(form).not.toHaveTextContent("waits until you approve");
    // A name whose file is already in the folder.
    const name = within(form).getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.click(within(form).getByRole("radio", { name: /This project/ }));
    await user.type(name, "code-reviewer");
    expect(name).toHaveAccessibleDescription(/already listed/);
  });

  it("writes the file with the choices made, then shows and focuses the new agent", async () => {
    const created = agent({
      name: "checker",
      description: "Checks things",
      source: { path: `${HOME}/.dawg/agents/checker.md`, origin: "dawg", scope: "user" },
      tools: ["Read", "Grep"],
      memory: "user",
      memoryDirectory: `${HOME}/.dawg/agent-memory/checker`,
    });
    let made = false;
    const { props, user } = setup(theme, {
      listSubagents: vi.fn(async () =>
        made ? listing({ agents: [EXPLORE, created, PERSONAL] }) : listing(),
      ),
      createSubagent: vi.fn(async () => {
        made = true;
        return { path: `${HOME}/.dawg/agents/checker.md`, agent: created };
      }),
    });
    await group(/^This project/);
    await user.click(screen.getByRole("button", { name: "New subagent" }));
    const form = screen.getByRole("region", { name: "New subagent" });
    await user.type(within(form).getByRole("textbox", { name: "Name" }), "checker");
    await user.type(within(form).getByRole("textbox", { name: "Description" }), "Checks things");
    await user.type(
      within(form).getByRole("textbox", { name: "System prompt" }),
      "You check things.",
    );
    await user.type(within(form).getByRole("textbox", { name: "Tools" }), "Read Grep");
    await user.selectOptions(
      within(form).getByRole("combobox", { name: "Memory" }),
      "Yours, every project",
    );
    await user.click(within(form).getByRole("button", { name: "Make subagent" }));
    expect(props.createSubagent).toHaveBeenCalledWith({
      projectDir: TALLY,
      scope: "user",
      name: "checker",
      description: "Checks things",
      prompt: "You check things.",
      tools: ["Read", "Grep"],
      memory: "user",
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "New subagent" })).toBeNull());
    const yours = await group(/^Yours/);
    await waitFor(() => expect(rowOf(yours, "checker")).toHaveFocus());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Made checker: ~/.dawg/agents/checker.md. New sessions can start it.",
    );
  });

  it("shows the engine's refusal in the form", async () => {
    const { user } = setup(theme, {
      createSubagent: vi.fn(async () => ({
        error: "~/.dawg/agents/checker.md already exists, and dawg never overwrites a file.",
      })),
    });
    await group(/^This project/);
    await user.click(screen.getByRole("button", { name: "New subagent" }));
    const form = screen.getByRole("region", { name: "New subagent" });
    await user.type(within(form).getByRole("textbox", { name: "Name" }), "checker");
    await user.type(within(form).getByRole("textbox", { name: "Description" }), "Checks");
    await user.click(within(form).getByRole("button", { name: "Make subagent" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Could not make the subagent: ~/.dawg/agents/checker.md already exists",
    );
  });

  it("offers only the person's folder without a project", async () => {
    const { user } = setup(theme, { initialProject: null });
    await group(/^Built in/);
    await user.click(screen.getByRole("button", { name: "New subagent" }));
    const form = screen.getByRole("region", { name: "New subagent" });
    expect(within(form).getByRole("radio", { name: /This project/ })).toBeDisabled();
    expect(within(form).getByRole("radio", { name: /Just for you/ })).toBeChecked();
  });
});

describe("the form's rules", () => {
  it("checks names as the engine does", () => {
    expect(newSubagentNameProblem("code-reviewer")).toBeNull();
    expect(newSubagentNameProblem("v2-checker")).toBeNull();
    for (const bad of ["", "Code", "a b", "-a", "a--b", "a-", "a/b", "x".repeat(65)]) {
      expect(newSubagentNameProblem(bad), bad).not.toBeNull();
    }
    expect(newSubagentNameProblem("fork")).toContain("copy of the conversation");
  });

  it("splits tools as the reader does, keeping a rule's spaces", () => {
    expect(splitTools("Read, Grep  Bash(npm test *),mcp__github__*")).toEqual([
      "Read",
      "Grep",
      "Bash(npm test *)",
      "mcp__github__*",
    ]);
    expect(splitTools("  ")).toEqual([]);
  });

  it("leaves out details that say nothing", () => {
    const labels = agentDetails(agent({ name: "x", description: "X" }), HOME).map((d) => d.label);
    expect(labels).toEqual(["Tools", "Model", "Permission mode"]);
  });
});

describe("Settings → Subagents", () => {
  it.each(THEMES)("the container hands the page the store's actions (%s)", async (theme) => {
    const { store, actions } = createTestStore((state) => ({
      layout: { ...state.layout, view: "settings", settingsPage: "subagents" },
    }));
    renderWithStore(<SettingsContainer />, { theme, store });
    expect(await screen.findByRole("heading", { level: 1, name: "Subagents" })).toBeVisible();
    await waitFor(() => expect(actions.listSubagents).toHaveBeenCalled());
    expect(await screen.findByText(/No agent files yet/)).toBeVisible();
    expect(screen.getByRole("main")).not.toHaveTextContent("Not in this build yet");
    expect(screen.getByRole("button", { name: "Subagents" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
