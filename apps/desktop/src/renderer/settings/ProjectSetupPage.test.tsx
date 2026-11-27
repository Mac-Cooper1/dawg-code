import type { CompatItem, CompatReport } from "@dawg/protocol";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedTheme } from "../../shared/bridge.ts";
import { createTestStore, renderWithStore } from "../app/testing.tsx";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { ProjectSetupPage } from "./ProjectSetupPage.tsx";
import { SettingsContainer } from "./SettingsContainer.tsx";

const HOME = "/Users/me";
const TALLY = `${HOME}/code/tally`;
const NOTES = `${HOME}/code/notes`;

function item(
  kind: CompatItem["kind"],
  name: string,
  path: string,
  status: CompatItem["status"],
  notes: string[] = [],
  scope: CompatItem["source"]["scope"] = "project",
): CompatItem {
  return { kind, name, source: { path, origin: "claude", scope }, status, notes };
}

const HOOK = item(
  "hook",
  "PreToolUse on Bash: ./scripts/check.sh",
  `${TALLY}/.claude/settings.json`,
  "needs-approval",
  ["Runs a command from the project's files."],
);

function tallyReport(approved = false): CompatReport {
  return {
    projectDir: TALLY,
    items: [
      item(
        "instructions",
        "~/.claude/CLAUDE.md",
        `${HOME}/.claude/CLAUDE.md`,
        "loaded",
        [],
        "user",
      ),
      item("instructions", "CLAUDE.md", `${TALLY}/CLAUDE.md`, "loaded"),
      item(
        "settings",
        ".claude/settings.json",
        `${TALLY}/.claude/settings.json`,
        "partly-supported",
        ["Not used by dawg yet: theme."],
      ),
      item("agent", "reviewer", `${TALLY}/.claude/agents/reviewer.md`, "not-supported", [
        "Subagents arrive later in Phase 4.",
      ]),
      { ...HOOK, status: approved ? "loaded" : "needs-approval" },
      item("mcp-server", ".mcp.json", `${TALLY}/.mcp.json`, "invalid", ["Not valid JSON."]),
    ],
    approval: { hash: "sha256:1", approved, items: [HOOK] },
  };
}

function setup(
  theme: ResolvedTheme,
  answers: Record<string, CompatReport | { error: string }> = { [TALLY]: tallyReport() },
  initialProject: string | null = TALLY,
) {
  const inspect = vi.fn(
    async (dir: string | null) =>
      answers[dir ?? ""] ?? { projectDir: dir, items: [], approval: null },
  );
  const onReview = vi.fn();
  renderInTheme(
    <ProjectSetupPage
      projects={[
        { dir: TALLY, name: "tally" },
        { dir: NOTES, name: "notes" },
      ]}
      initialProject={initialProject}
      homeDir={HOME}
      inspect={inspect}
      onReview={onReview}
    />,
    theme,
  );
  return { inspect, onReview, user: userEvent.setup() };
}

const section = (name: RegExp) => screen.getByRole("region", { name });

describe.each(THEMES)("ProjectSetupPage (%s)", (theme) => {
  it("groups the report by what dawg does with each item, with sources and notes", async () => {
    const { inspect } = setup(theme);
    expect(screen.getByRole("heading", { level: 1, name: "Project setup" })).toBeVisible();
    expect(screen.getByText("Reading the setup…")).toBeVisible();
    await screen.findByRole("region", { name: /^Loaded/ });
    expect(inspect).toHaveBeenCalledWith(TALLY);
    expect(inspect).toHaveBeenCalledTimes(1);

    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      "Loaded 2",
      "Needs approval 1",
      "Partly supported 1",
      "Not supported 1",
      "Invalid 1",
    ]);

    const loaded = within(section(/^Loaded/)).getAllByRole("listitem");
    expect(loaded.map((li) => li.querySelector("code")?.textContent)).toEqual([
      "~/.claude/CLAUDE.md",
      "~/code/tally/CLAUDE.md",
    ]);
    expect(within(loaded[0] as HTMLElement).getByText("Instructions")).toBeVisible();
    expect(within(loaded[0] as HTMLElement).getByText("Yours · Claude Code")).toBeVisible();
    expect(within(loaded[1] as HTMLElement).getByText("Project · Claude Code")).toBeVisible();

    const partly = section(/^Partly supported/);
    expect(within(partly).getByText(".claude/settings.json")).toBeVisible();
    expect(
      within(
        within(partly).getByRole("list", { name: "Notes on .claude/settings.json" }),
      ).getByText("Not used by dawg yet: theme."),
    ).toBeVisible();
    expect(within(section(/^Not supported/)).getByText("Subagent")).toBeVisible();
    expect(within(section(/^Invalid/)).getByText("Not valid JSON.")).toBeVisible();
    expect(within(section(/^Needs approval/)).getByText("Hook")).toBeVisible();

    // The counts, above.
    expect(screen.getByText("2 loaded")).toBeVisible();
    expect(screen.getByText("1 invalid")).toBeVisible();
  });

  it("shows the consent read-only, and Review… opens the trust dialog", async () => {
    const { onReview, user } = setup(theme);
    await screen.findByText("Not approved");
    expect(
      screen.getByText("1 hook from this setup waits for your consent before it runs."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Review…" }));
    expect(onReview).toHaveBeenCalledWith(TALLY);
  });

  it("says when the code is approved, and when nothing needs consent", async () => {
    setup(theme, {
      [TALLY]: tallyReport(true),
      [NOTES]: { projectDir: NOTES, items: [], approval: null },
    });
    await screen.findByText("Approved");
    expect(screen.getByText("You approved the code this setup supplies: 1 hook.")).toBeVisible();
    expect(screen.queryByRole("region", { name: /^Needs approval/ })).toBeNull();
  });

  it("picks another project, or only your files, and says when nothing is set up", async () => {
    const { inspect, user } = setup(theme);
    await screen.findByRole("region", { name: /^Loaded/ });
    const picker = screen.getByRole("combobox", { name: "Project" });
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["tally (~/code/tally)", "notes (~/code/notes)", "No project: only your files"]);

    await user.selectOptions(picker, NOTES);
    expect(await screen.findByText("No Claude Code setup found")).toBeVisible();
    expect(screen.getByText(/in ~\/code\/notes and your home folder/)).toBeVisible();
    expect(
      screen.getByText("Nothing in this setup runs code that needs your consent."),
    ).toBeVisible();

    await user.selectOptions(picker, "");
    await waitFor(() => expect(inspect).toHaveBeenLastCalledWith(null));
    expect(await screen.findByText(/in your home folder\./)).toBeVisible();
    // Nothing to review without a project.
    expect(screen.queryByRole("button", { name: "Review…" })).toBeNull();
  });

  it("refreshes on request and when the window comes back", async () => {
    const { inspect, user } = setup(theme);
    await screen.findByRole("region", { name: /^Loaded/ });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(3));
  });

  it("says when the setup could not be read", async () => {
    setup(theme, { [TALLY]: { error: "The engine is not running." } });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not read the setup: The engine is not running.",
    );
    expect(screen.queryByText("Reading the setup…")).toBeNull();
  });
});

describe.each(THEMES)("Settings → Project setup, connected (%s)", (theme) => {
  it("asks the store for the selected session's project and reviews through it", async () => {
    const test = createTestStore((state) => ({
      homeDir: HOME,
      layout: { ...state.layout, view: "settings", settingsPage: "setup" },
    }));
    vi.mocked(test.actions.inspectProject).mockResolvedValue({
      ...tallyReport(),
      projectDir: null,
    });
    renderWithStore(<SettingsContainer />, { theme, store: test.store });
    expect(await screen.findByRole("heading", { level: 1, name: "Project setup" })).toBeVisible();
    await screen.findByRole("region", { name: /^Loaded/ });
    expect(test.actions.inspectProject).toHaveBeenCalledWith(null);
  });
});
