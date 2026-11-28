import type { HookInfo } from "@dawg/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HooksListing } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { HooksPage, type HooksPageProps } from "./HooksPage.tsx";

const HOME = "/Users/me";
const TALLY = `${HOME}/code/tally`;
const NOTES = `${HOME}/code/notes-cli`;

const CHECK: HookInfo = {
  id: "hook:check",
  event: "PreToolUse",
  matcher: "Bash",
  type: "command",
  command: "./scripts/check-command.sh",
  timeout: 10,
  source: { path: `${TALLY}/.claude/settings.json`, origin: "claude", scope: "project" },
  status: "needs-approval",
  notes: ["Runs a command from the project's files."],
  enabled: true,
};

const LINT: HookInfo = {
  id: "hook:lint",
  event: "PostToolUse",
  matcher: "Edit|Write",
  type: "command",
  command: "npm run lint --silent",
  timeout: null,
  source: { path: `${HOME}/.dawg/settings.json`, origin: "dawg", scope: "user" },
  status: "loaded",
  notes: [],
  enabled: false,
};

const REVIEW: HookInfo = {
  id: "hook:review",
  event: "Stop",
  matcher: null,
  type: "prompt",
  command: "Check that the tests pass before stopping.",
  timeout: null,
  source: { path: `${TALLY}/.claude/settings.json`, origin: "claude", scope: "project" },
  status: "loaded",
  notes: [
    "model “haiku” is mapped to the helper model, or to the session's model when there is no helper.",
  ],
  enabled: true,
  reaches: { host: null, model: "haiku", server: null, tool: null },
};

const AUDIT: HookInfo = {
  id: "hook:audit",
  event: "PermissionRequest",
  matcher: "Bash",
  type: "http",
  command: "http://localhost:8080/hooks/permission",
  timeout: null,
  source: { path: `${HOME}/.dawg/settings.json`, origin: "dawg", scope: "user" },
  status: "loaded",
  notes: [],
  enabled: true,
  reaches: { host: "localhost:8080", model: null, server: null, tool: null },
};

const SCAN: HookInfo = {
  id: "hook:scan",
  event: "FileChanged",
  matcher: ".envrc",
  type: "mcp_tool",
  command: "security scan_file",
  timeout: null,
  source: { path: `${HOME}/.dawg/settings.json`, origin: "dawg", scope: "user" },
  status: "not-supported",
  notes: ["dawg does not run FileChanged hooks yet."],
  enabled: true,
  reaches: { host: null, model: null, server: "security", tool: "scan_file" },
};

function listing(overrides: Partial<HooksListing> = {}): HooksListing {
  return {
    projectDir: TALLY,
    hooks: [CHECK, LINT, REVIEW, AUDIT, SCAN],
    disabledBy: null,
    ...overrides,
  };
}

function setup(theme: "dark" | "light", overrides: Partial<HooksPageProps> = {}) {
  const props: HooksPageProps = {
    projects: [
      { dir: TALLY, name: "tally" },
      { dir: NOTES, name: "notes-cli" },
    ],
    initialProject: TALLY,
    homeDir: HOME,
    listHooks: vi.fn(async (projectDir: string | null) => listing({ projectDir })),
    setHookEnabled: vi.fn(async () => true),
    onReview: vi.fn(),
    ...overrides,
  };
  renderInTheme(<HooksPage {...props} />, theme);
  return props;
}

describe.each(THEMES)("HooksPage (%s)", (theme) => {
  it("lists every hook with its event, matcher, command, source and state", async () => {
    const props = setup(theme);
    const list = await screen.findByRole("list", { name: "Hooks" });
    expect(props.listHooks).toHaveBeenCalledWith(TALLY);
    const rows = within(list)
      .getAllByRole("listitem")
      .filter((li) => li.parentElement === list);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent("PreToolUse on Bash");
    expect(rows[0]).toHaveTextContent("./scripts/check-command.sh");
    expect(rows[0]).toHaveTextContent("~/code/tally/.claude/settings.json");
    expect(rows[0]).toHaveTextContent("Claude Code’s file, shared with the project");
    expect(rows[0]).toHaveTextContent("Waits for your approval");
    expect(rows[0]).toHaveTextContent("times out after 10 s");
    expect(rows[1]).toHaveTextContent("PostToolUse on Edit|Write");
    expect(rows[1]).toHaveTextContent("dawg’s file, yours everywhere");
    expect(rows[1]).toHaveTextContent("Runs");
    // The other handler types: their type, and what they reach.
    expect(rows[0]).not.toHaveTextContent("Command");
    expect(rows[2]).toHaveTextContent("Stop");
    expect(rows[2]).toHaveTextContent("Prompt");
    expect(rows[2]).toHaveTextContent("Asks “haiku”, mapped to the helper model or the session’s");
    expect(rows[3]).toHaveTextContent("PermissionRequest on Bash");
    expect(rows[3]).toHaveTextContent("HTTP");
    expect(rows[3]).toHaveTextContent("Posts to localhost:8080");
    expect(rows[4]).toHaveTextContent("MCP tool");
    expect(rows[4]).toHaveTextContent("Calls scan_file on the MCP server security");
    expect(rows[4]).toHaveTextContent("Not supported yet");
    expect(rows[4]).toHaveTextContent("dawg does not run FileChanged hooks yet");
    // Where the switches live, in one line.
    expect(screen.getByText(/keeps the switches in its own data folder/)).toBeInTheDocument();
  });

  it("turns a hook off and on, and puts the switch back when that fails", async () => {
    const user = userEvent.setup();
    const setHookEnabled = vi.fn(async () => true);
    setup(theme, { setHookEnabled });
    const check = await screen.findByRole("switch", {
      name: "PreToolUse on Bash: ./scripts/check-command.sh",
    });
    expect(check).toBeChecked();
    await user.click(check);
    expect(setHookEnabled).toHaveBeenCalledWith(TALLY, "hook:check", false);
    expect(check).not.toBeChecked();

    const lint = screen.getByRole("switch", {
      name: "PostToolUse on Edit|Write: npm run lint --silent",
    });
    expect(lint).not.toBeChecked();
    setHookEnabled.mockResolvedValueOnce(false);
    await user.click(lint);
    expect(setHookEnabled).toHaveBeenLastCalledWith(TALLY, "hook:lint", true);
    expect(lint).not.toBeChecked();
  });

  it("offers a review when the project's hooks wait for approval", async () => {
    const user = userEvent.setup();
    const props = setup(theme);
    await user.click(await screen.findByRole("button", { name: "Review" }));
    expect(props.onReview).toHaveBeenCalledWith(TALLY);
  });

  it("says when disableAllHooks turns every hook off", async () => {
    setup(theme, {
      listHooks: vi.fn(async (projectDir: string | null) =>
        listing({ projectDir, disabledBy: `${HOME}/.claude/settings.json` }),
      ),
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Every hook is off: disableAllHooks is set in ~/.claude/settings.json.",
    );
  });

  it("follows the project picker, and says when there are none or the list failed", async () => {
    const user = userEvent.setup();
    const listHooks = vi.fn(async (projectDir: string | null) =>
      projectDir === NOTES
        ? { error: "The engine is not running." }
        : listing({ projectDir, hooks: [] }),
    );
    setup(theme, { listHooks });
    expect(await screen.findByText("No hooks")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Project"), NOTES);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not list the hooks: The engine is not running.",
    );
    await user.selectOptions(screen.getByLabelText("Project"), "");
    expect(listHooks).toHaveBeenLastCalledWith(null);
    expect(await screen.findByText("No hooks")).toBeInTheDocument();
  });
});
