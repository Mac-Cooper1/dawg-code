import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedTheme } from "../../shared/bridge.ts";
import { createTestStore, renderWithStore } from "../app/testing.tsx";
import { createFakePermissions, type FakeSettingsFile } from "../bridge/fake-permissions.ts";
import { setBridgeForTests } from "../bridge/index.ts";
import { createMemoryBridge } from "../bridge/memory.ts";
import { makeSummary, openSession } from "../state/__fixtures__/streams.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { PermissionsPage, permissionProjects } from "./PermissionsPage.tsx";
import { SettingsContainer } from "./SettingsContainer.tsx";

const HOME = "/Users/me";
const TALLY = `${HOME}/code/tally`;
const NOTES = `${HOME}/code/notes`;

const PATHS = {
  local: `${TALLY}/.dawg/settings.local.json`,
  claudeLocal: `${TALLY}/.claude/settings.local.json`,
  project: `${TALLY}/.dawg/settings.json`,
  claudeProject: `${TALLY}/.claude/settings.json`,
  user: `${HOME}/.dawg/settings.json`,
  claudeUser: `${HOME}/.claude/settings.json`,
};

function setup(
  theme: ResolvedTheme,
  files: Record<string, FakeSettingsFile> = {},
  initialProject: string | null = TALLY,
) {
  const fake = createFakePermissions({ homeDir: HOME, files });
  renderInTheme(
    <PermissionsPage
      api={fake.api}
      projects={[
        { dir: TALLY, name: "tally" },
        { dir: NOTES, name: "notes" },
      ]}
      initialProject={initialProject}
      homeDir={HOME}
      savedForMs={60_000}
    />,
    theme,
  );
  return { fake, user: userEvent.setup() };
}

const scope = (name: string) => screen.getByRole("region", { name });
const personal = () => scope("Personal for this project");
const shared = () => scope("Shared with the project");
const yours = () => scope("Yours everywhere");

/** The rules a section lists under a heading ("Allow", "Ask", "Deny"), in order. */
function rulesIn(section: HTMLElement, list: string): string[] {
  const heading = within(section).queryByRole("heading", {
    level: 3,
    name: new RegExp(`^${list}`),
  });
  if (!heading) return [];
  const ul = within(section).queryByRole("list", { name: heading.textContent ?? "" });
  return ul
    ? within(ul)
        .getAllByRole("listitem")
        .map((li) => li.querySelector("code")?.textContent ?? "")
    : [];
}

describe.each(THEMES)("PermissionsPage (%s)", (theme) => {
  it("shows the mode new sessions start in, where it comes from, and every scope", async () => {
    setup(theme, {
      [PATHS.project]: { defaultMode: "acceptEdits", deny: ["Read(./.env)"] },
      [PATHS.claudeUser]: { defaultMode: "plan", allow: ["WebFetch"], ask: ["Bash(git push *)"] },
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Permissions" })).toBeVisible();
    await screen.findByText(/New sessions start in/);
    expect(screen.getByText("Accept edits", { selector: "span" })).toBeVisible();
    expect(
      screen.getByText("Set by ~/code/tally/.dawg/settings.json (Shared with the project)."),
    ).toBeVisible();
    expect(screen.getByText(/Deny beats ask and ask beats allow/)).toBeVisible();

    for (const [section, path] of [
      [personal(), "~/code/tally/.dawg/settings.local.json"],
      [shared(), "~/code/tally/.dawg/settings.json"],
      [yours(), "~/.dawg/settings.json"],
    ] as const) {
      expect(within(section).getByText(path)).toBeVisible();
    }
    expect(within(personal()).getByText("Not created yet")).toBeVisible();
    expect(rulesIn(shared(), "Deny")).toEqual(["Read(./.env)"]);
    expect(within(shared()).getByRole("combobox", { name: "Default mode" })).toHaveValue(
      "acceptEdits",
    );
  });

  it("shows Claude Code's files read-only, with their path and a note", async () => {
    setup(theme, {
      [PATHS.claudeUser]: { defaultMode: "plan", allow: ["WebFetch"], ask: ["Bash(git push *)"] },
    });
    const section = await waitFor(() => yours());
    expect(within(section).getByText("Claude Code’s file")).toBeVisible();
    expect(within(section).getByText("~/.claude/settings.json")).toBeVisible();
    expect(within(section).getByText("dawg reads this file but never changes it.")).toBeVisible();
    expect(within(section).getByText("Plan", { selector: "strong" })).toBeVisible();
    const claudeCard = within(section).getByText("Claude Code’s file").closest("div")
      ?.parentElement as HTMLElement;
    expect(within(claudeCard).getByText("WebFetch")).toBeVisible();
    expect(within(claudeCard).queryByRole("button")).toBeNull();
    expect(within(claudeCard).queryByRole("textbox")).toBeNull();
    // Files Claude Code does not have are one quiet line.
    expect(
      within(personal()).getByText(
        "No Claude Code file at ~/code/tally/.claude/settings.local.json.",
      ),
    ).toBeVisible();
  });

  it("adds a rule with Enter, saves it at once and says so quietly", async () => {
    const { fake, user } = setup(theme);
    const field = await within(await waitFor(() => personal())).findByRole("textbox", {
      name: "Add an allow rule",
    });
    await user.type(field, "Bash(npm run test *){Enter}");
    await waitFor(() => expect(rulesIn(personal(), "Allow")).toEqual(["Bash(npm run test *)"]));
    expect(fake.files.get(PATHS.local)?.allow).toEqual(["Bash(npm run test *)"]);
    expect(fake.writes.at(-1)).toEqual({
      scope: "local",
      projectDir: TALLY,
      allow: ["Bash(npm run test *)"],
    });
    expect(within(personal()).getByRole("status")).toHaveTextContent("Saved");
    expect(field).toHaveValue("");
    expect(field).toHaveFocus();
    expect(within(personal()).queryByText("Not created yet")).toBeNull();
  });

  it("checks a rule as it is typed and will not add one that does not parse", async () => {
    const { fake, user } = setup(theme);
    const field = await within(await waitFor(() => shared())).findByRole("textbox", {
      name: "Add a deny rule",
    });
    await user.type(field, "Bash(npm");
    expect(
      await within(shared()).findByText(
        'Malformed rule: rules take the form Tool or Tool(content) and must end at the closing ")".',
      ),
    ).toBeVisible();
    expect(field).toHaveAttribute("aria-invalid", "true");
    await user.keyboard("{Enter}");
    expect(fake.writes).toEqual([]);
    expect(field).toHaveValue("Bash(npm");
    expect(within(shared()).getByText(/^Malformed rule/)).toBeVisible();

    await user.type(field, " test)");
    await waitFor(() => expect(field).toHaveAttribute("aria-invalid", "false"));
    const form = field.closest("form") as HTMLElement;
    await user.click(within(form).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(rulesIn(shared(), "Deny")).toEqual(["Bash(npm test)"]));
  });

  it("adds a corrected rule with Enter straight away, before the check catches up", async () => {
    const { fake, user } = setup(theme);
    const field = await within(await waitFor(() => yours())).findByRole("textbox", {
      name: "Add a deny rule",
    });
    await user.type(field, "Bash(curl");
    await within(yours()).findByText(/^Malformed rule/);
    await user.type(field, " *){Enter}");
    await waitFor(() => expect(fake.files.get(PATHS.user)?.deny).toEqual(["Bash(curl *)"]));
    expect(field).toHaveValue("");
  });

  it("says when a rule is already in the list", async () => {
    const { user } = setup(theme, { [PATHS.user]: { allow: ["Read"] } });
    const field = await within(await waitFor(() => yours())).findByRole("textbox", {
      name: "Add an allow rule",
    });
    await user.type(field, "Read");
    expect(within(yours()).getByText("Already in this list.")).toBeVisible();
    const form = field.closest("form") as HTMLElement;
    expect(within(form).getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("removes a rule and moves focus to the one that took its place", async () => {
    const { fake, user } = setup(theme, { [PATHS.local]: { allow: ["Read", "Edit", "WebFetch"] } });
    await waitFor(() => expect(rulesIn(personal(), "Allow")).toEqual(["Read", "Edit", "WebFetch"]));
    const removeButtons = within(personal()).getAllByRole("button", { name: "Remove rule" });
    // The button says which rule it removes.
    expect(removeButtons[1]).toHaveAccessibleDescription("Edit");
    await user.click(removeButtons[1] as HTMLElement);
    await waitFor(() => expect(rulesIn(personal(), "Allow")).toEqual(["Read", "WebFetch"]));
    expect(fake.files.get(PATHS.local)?.allow).toEqual(["Read", "WebFetch"]);
    await waitFor(() => expect(document.activeElement).toHaveAccessibleDescription("WebFetch"));
  });

  it("moves a rule to another list in one save", async () => {
    const { fake, user } = setup(theme, {
      [PATHS.project]: { allow: ["Bash(git push *)", "Read"] },
    });
    await waitFor(() => expect(rulesIn(shared(), "Allow")).toHaveLength(2));
    const move = within(shared())
      .getAllByRole("button", { name: "Move to ask" })
      .find((button) => button.getAttribute("aria-describedby") !== null);
    expect(move).toHaveAccessibleDescription("Bash(git push *)");
    await user.click(move as HTMLElement);
    await waitFor(() => expect(rulesIn(shared(), "Ask")).toEqual(["Bash(git push *)"]));
    expect(rulesIn(shared(), "Allow")).toEqual(["Read"]);
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]).toEqual({
      scope: "project",
      projectDir: TALLY,
      allow: ["Read"],
      ask: ["Bash(git push *)"],
    });
  });

  it("sets and clears a scope's default mode, and the summary follows", async () => {
    const { fake, user } = setup(theme);
    const select = await within(await waitFor(() => personal())).findByRole("combobox", {
      name: "Default mode",
    });
    expect(screen.getByText("No settings file sets a mode, so this is the default.")).toBeVisible();
    // Bypass is only offered in the person's own settings.
    expect(within(select).queryByRole("option", { name: "Bypass" })).toBeNull();
    expect(
      within(within(yours()).getByRole("combobox", { name: "Default mode" })).getByRole("option", {
        name: "Bypass",
      }),
    ).toBeInTheDocument();

    await user.selectOptions(select, "acceptEdits");
    await waitFor(() =>
      expect(
        screen.getByText(
          "Set by ~/code/tally/.dawg/settings.local.json (Personal for this project).",
        ),
      ).toBeVisible(),
    );
    expect(fake.files.get(PATHS.local)?.defaultMode).toBe("acceptEdits");
    expect(select).toHaveValue("acceptEdits");

    await user.selectOptions(select, "");
    await waitFor(() => expect(fake.files.get(PATHS.local)?.defaultMode).toBeNull());
    expect(fake.writes.at(-1)).toEqual({ scope: "local", projectDir: TALLY, defaultMode: null });
    expect(screen.getByText("No settings file sets a mode, so this is the default.")).toBeVisible();
  });

  it("shows a failed save as a one-line notice that can be dismissed", async () => {
    const { fake, user } = setup(theme, { [PATHS.local]: { allow: ["Read"] } });
    await waitFor(() => expect(rulesIn(personal(), "Allow")).toEqual(["Read"]));
    fake.failNextWrite(
      "Error invoking remote method 'dawg:permissions:write': Error: The disk is full",
    );
    await user.click(within(personal()).getByRole("button", { name: "Remove rule" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The disk is full.");
    expect(rulesIn(personal(), "Allow")).toEqual(["Read"]);
    await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a rule the list refuses as a notice and keeps what was typed", async () => {
    const { user } = setup(theme);
    const field = await within(await waitFor(() => personal())).findByRole("textbox", {
      name: "Add an allow rule",
    });
    await user.type(field, "Glob(src/**){Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Glob(src/**): Glob(path) allow rules never match; use Read(...) instead.",
    );
    expect(field).toHaveValue("Glob(src/**)");
    expect(rulesIn(personal(), "Allow")).toEqual([]);
  });

  it("shows a file that does not parse read-only, with its problems", async () => {
    setup(theme, {
      [PATHS.project]: {
        parses: false,
        problems: ["Not valid JSON, file skipped: Unexpected token } in JSON at position 12."],
      },
    });
    const section = await waitFor(() => shared());
    expect(within(section).getByText("Read-only")).toBeVisible();
    expect(
      within(section).getByText("dawg cannot change this file until it is fixed by hand."),
    ).toBeVisible();
    expect(within(section).getByText(/^Not valid JSON, file skipped/)).toBeVisible();
    expect(within(section).queryByRole("textbox")).toBeNull();
    expect(within(section).getByRole("combobox", { name: "Default mode" })).toBeDisabled();
  });

  it("shows problems with a file's values", async () => {
    setup(theme, { [PATHS.local]: { defaultMode: "bypassPermissions" } });
    const section = await waitFor(() => personal());
    expect(
      within(section).getByText(
        /A project's own settings cannot start sessions in bypassPermissions/,
      ),
    ).toBeVisible();
    // Ignored, so new sessions ask first.
    expect(screen.getByText("No settings file sets a mode, so this is the default.")).toBeVisible();
  });

  it("picks a project, or only the person's own settings", async () => {
    const { fake, user } = setup(theme, {
      [`${NOTES}/.dawg/settings.json`]: { deny: ["Bash(rm *)"] },
    });
    const picker = await screen.findByRole("combobox", { name: "Project" });
    expect(picker).toHaveValue(TALLY);
    expect(within(picker).getByRole("option", { name: "tally (~/code/tally)" })).toBeVisible();

    await user.selectOptions(picker, NOTES);
    await waitFor(() => expect(rulesIn(shared(), "Deny")).toEqual(["Bash(rm *)"]));
    expect(within(shared()).getByText("~/code/notes/.dawg/settings.json")).toBeVisible();

    await user.selectOptions(picker, "No project: only your settings");
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Shared with the project" })).toBeNull(),
    );
    expect(yours()).toBeVisible();
    expect(screen.queryByRole("region", { name: "Personal for this project" })).toBeNull();

    const field = within(yours()).getByRole("textbox", { name: "Add a deny rule" });
    await user.type(field, "WebFetch{Enter}");
    await waitFor(() => expect(fake.files.get(PATHS.user)?.deny).toEqual(["WebFetch"]));
    expect(fake.writes.at(-1)).toEqual({ scope: "user", projectDir: null, deny: ["WebFetch"] });
  });

  it("starts on only the person's settings when there is no project", async () => {
    setup(theme, {}, null);
    expect(await screen.findByRole("combobox", { name: "Project" })).toHaveValue("");
    await waitFor(() => expect(yours()).toBeVisible());
  });

  it("is usable from the keyboard alone", async () => {
    const { fake, user } = setup(theme, {}, null);
    await waitFor(() => expect(yours()).toBeVisible());
    const picker = screen.getByRole("combobox", { name: "Project" });
    picker.focus();
    // Project, then the default mode, then the allow field.
    await user.tab();
    expect(within(yours()).getByRole("combobox", { name: "Default mode" })).toHaveFocus();
    await user.tab();
    expect(within(yours()).getByRole("textbox", { name: "Add an allow rule" })).toHaveFocus();
    await user.keyboard("Read{Enter}");
    await waitFor(() => expect(fake.files.get(PATHS.user)?.allow).toEqual(["Read"]));
    // The new rule's buttons come just before the field.
    await user.tab({ shift: true });
    expect(document.activeElement).toHaveAccessibleName("Remove rule");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fake.files.get(PATHS.user)?.allow).toEqual([]));
    expect(within(yours()).getByRole("textbox", { name: "Add an allow rule" })).toHaveFocus();
  });
});

describe("PermissionsPage confirmation", () => {
  it("hides “Saved” after a while", async () => {
    const fake = createFakePermissions({ homeDir: HOME });
    renderInTheme(
      <PermissionsPage
        api={fake.api}
        projects={[]}
        initialProject={null}
        homeDir={HOME}
        savedForMs={50}
      />,
      "dark",
    );
    const user = userEvent.setup();
    const field = await within(await waitFor(() => yours())).findByRole("textbox", {
      name: "Add an ask rule",
    });
    await user.type(field, "Bash(git push *){Enter}");
    await waitFor(() => expect(within(yours()).getByRole("status")).toHaveTextContent("Saved"));
    await waitFor(() => expect(within(yours()).getByRole("status")).toHaveTextContent(""));
  });
});

describe("Settings → Permissions in the app", () => {
  afterEach(() => setBridgeForTests(null));

  /** Two projects in the sidebar; notes has the newest activity, tally's session is selected. */
  function sessions() {
    const tally = openSession(
      makeSummary("s1", { cwd: TALLY, projectDir: TALLY, lastActivityAt: 1_000 }),
    );
    const notes = openSession(
      makeSummary("s2", { cwd: NOTES, projectDir: NOTES, lastActivityAt: 2_000 }),
    );
    return {
      sessions: { ...tally.sessions, ...notes.sessions },
      projects: { ...tally.projects, ...notes.projects },
    };
  }

  it("lists the sidebar's projects, newest activity first", () => {
    const { sessions: all, projects } = sessions();
    expect(permissionProjects(all, projects)).toEqual([
      { dir: NOTES, name: "notes" },
      { dir: TALLY, name: "tally" },
    ]);
  });

  it.each(THEMES)("opens on the selected session's project (%s)", async (theme) => {
    setBridgeForTests(
      createMemoryBridge({
        storage: null,
        platform: { homeDir: HOME },
        permissionFiles: { [PATHS.local]: { allow: ["Bash(uv run pytest *)"] } },
      }),
    );
    const { store } = createTestStore((state) => ({
      ...sessions(),
      layout: {
        ...state.layout,
        view: "settings",
        settingsPage: "permissions",
        selectedSessionId: "s1",
      },
    }));
    renderWithStore(<SettingsContainer />, { theme, store });
    expect(await screen.findByRole("combobox", { name: "Project" })).toHaveValue(TALLY);
    await waitFor(() => expect(rulesIn(personal(), "Allow")).toEqual(["Bash(uv run pytest *)"]));
    expect(screen.getByRole("main")).not.toHaveTextContent("Not in this build yet");
  });
});
