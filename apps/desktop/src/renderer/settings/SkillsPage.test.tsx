import type { SkillInfo } from "@dawg/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createTestStore, renderWithStore } from "../app/testing.tsx";
import type { SkillsListing } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { SettingsContainer } from "./SettingsContainer.tsx";
import { SkillsPage, type SkillsPageProps, whoRuns } from "./SkillsPage.tsx";

const HOME = "/Users/me";
const TALLY = `${HOME}/code/tally`;
const NOTES = `${HOME}/code/notes-cli`;

const REVIEW: SkillInfo = {
  name: "review",
  kind: "skill",
  description: "Review the current changes for bugs and style",
  argumentHint: "[focus]",
  source: { path: `${HOME}/.claude/skills/review/SKILL.md`, origin: "claude", scope: "user" },
  userInvocable: true,
  modelInvocable: true,
  status: "partly-supported",
  notes: ["model “sonnet” is mapped to the session's model: model names are mapped, not obeyed."],
};

const RELEASE: SkillInfo = {
  name: "release",
  kind: "skill",
  description: "Cut a release",
  argumentHint: "[version]",
  source: { path: `${TALLY}/.dawg/skills/release/SKILL.md`, origin: "dawg", scope: "project" },
  userInvocable: true,
  modelInvocable: false,
  status: "loaded",
  notes: [],
};

const SHADOWED: SkillInfo = {
  ...REVIEW,
  description: "The project's review",
  source: { path: `${TALLY}/.claude/skills/review/SKILL.md`, origin: "claude", scope: "project" },
  userInvocable: false,
  status: "loaded",
  notes: ["Not used: ~/.claude/skills/review/SKILL.md defines “review” too and takes its place."],
};

const TEST_COMMAND: SkillInfo = {
  name: "frontend:test",
  kind: "command",
  description: "Run the frontend tests",
  argumentHint: null,
  source: {
    path: `${TALLY}/.claude/commands/frontend/test.md`,
    origin: "claude",
    scope: "project",
  },
  userInvocable: true,
  modelInvocable: true,
  status: "loaded",
  notes: [],
};

function listing(overrides: Partial<SkillsListing> = {}): SkillsListing {
  return {
    projectDir: TALLY,
    skills: [RELEASE, REVIEW, SHADOWED],
    commands: [TEST_COMMAND],
    ...overrides,
  };
}

function setup(theme: "dark" | "light", overrides: Partial<SkillsPageProps> = {}) {
  const props: SkillsPageProps = {
    projects: [
      { dir: TALLY, name: "tally" },
      { dir: NOTES, name: "notes-cli" },
    ],
    initialProject: TALLY,
    homeDir: HOME,
    listSkills: vi.fn(async (projectDir: string | null) =>
      projectDir === TALLY ? listing() : listing({ projectDir, skills: [], commands: [] }),
    ),
    ...overrides,
  };
  renderInTheme(<SkillsPage {...props} />, theme);
  return { props, user: userEvent.setup() };
}

describe.each(THEMES)("SkillsPage (%s)", (theme) => {
  it("lists each skill and command with its file, who may run it and its notes", async () => {
    setup(theme);
    expect(screen.getByRole("heading", { level: 1, name: "Skills and commands" })).toBeVisible();
    const skills = await screen.findByRole("list", { name: /^Skills/ });
    const rows = within(skills)
      .getAllByRole("listitem")
      .filter((li) => li.parentElement === skills);
    expect(rows).toHaveLength(3);
    const [release, review, shadowed] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(release).toHaveTextContent("/release [version]");
    expect(release).toHaveTextContent("~/code/tally/.dawg/skills/release/SKILL.md");
    expect(release).toHaveTextContent("dawg’s file, shared with the project");
    expect(release).toHaveTextContent("Only you start it, with /release.");
    expect(review).toHaveTextContent("Personal");
    expect(review).toHaveTextContent("Partly supported");
    expect(review).toHaveTextContent("~/.claude/skills/review/SKILL.md");
    expect(within(review).getByRole("list", { name: "Notes" })).toHaveTextContent(
      "mapped to the session's model",
    );
    expect(review).toHaveTextContent(
      "You run it with /review; the agent loads it when a task fits.",
    );
    expect(shadowed).toHaveTextContent("Not used");
    const commands = screen.getByRole("list", { name: /^Commands/ });
    expect(commands).toHaveTextContent("/frontend:test");
    expect(commands).toHaveTextContent("Run the frontend tests");
  });

  it("follows the project picked, by keyboard too", async () => {
    const { props, user } = setup(theme);
    await screen.findByRole("list", { name: /^Skills/ });
    const picker = screen.getByRole("combobox", { name: "Project" });
    picker.focus();
    await user.selectOptions(picker, NOTES);
    await waitFor(() => expect(props.listSkills).toHaveBeenLastCalledWith(NOTES));
    expect(await screen.findByText("No skills or commands")).toBeVisible();
    expect(screen.getByText("~/.claude/skills/<name>/SKILL.md")).toBeVisible();
    await user.selectOptions(picker, "");
    await waitFor(() => expect(props.listSkills).toHaveBeenLastCalledWith(null));
  });

  it("says when the list could not be read", async () => {
    setup(theme, { listSkills: vi.fn(async () => ({ error: "The engine is not running." })) });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not list the skills and commands: The engine is not running.",
    );
  });
});

describe("whoRuns", () => {
  it("covers each way a skill can be started", () => {
    expect(whoRuns({ ...REVIEW, userInvocable: false })).toBe(
      "Only the agent loads it; it is not in the / menu.",
    );
    expect(whoRuns({ ...REVIEW, userInvocable: false, modelInvocable: false })).toBe(
      "Neither you nor the agent can start it.",
    );
    expect(whoRuns({ ...REVIEW, status: "invalid" })).toBe("Not used.");
  });
});

describe("Settings → Skills and commands", () => {
  it.each(THEMES)("the container hands the page the store's action (%s)", async (theme) => {
    const { store, actions } = createTestStore((state) => ({
      layout: { ...state.layout, view: "settings", settingsPage: "skills" },
    }));
    renderWithStore(<SettingsContainer />, { theme, store });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Skills and commands" }),
    ).toBeVisible();
    await waitFor(() => expect(actions.listSkills).toHaveBeenCalled());
    expect(await screen.findByText("No skills or commands")).toBeVisible();
    expect(screen.getByRole("main")).not.toHaveTextContent("Not in this build yet");
  });
});
