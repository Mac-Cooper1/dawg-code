import type { CompatItem } from "@dawg/protocol";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createTestStore, HOME, renderWithStore } from "../app/testing.tsx";
import type { TrustReview } from "../state/types.ts";
import { THEMES } from "../test/render.tsx";
import { TrustDialogContainer } from "./TrustDialog.tsx";

const PROJECT = `${HOME}/code/tally`;

const HOOK: CompatItem = {
  kind: "hook",
  name: "PreToolUse on Bash: ./scripts/check-command.sh",
  source: { path: `${PROJECT}/.claude/settings.json`, origin: "claude", scope: "project" },
  status: "needs-approval",
  notes: ["Runs a command from the project's files."],
};

const USER_HOOK: CompatItem = {
  kind: "hook",
  name: "PostToolUse on Edit|Write: npm run lint",
  source: { path: `${HOME}/.claude/settings.json`, origin: "claude", scope: "user" },
  status: "needs-approval",
  notes: ["Runs a command from Claude Code's settings."],
};

const SERVER: CompatItem = {
  kind: "mcp-server",
  name: "github",
  source: { path: `${PROJECT}/.mcp.json`, origin: "claude", scope: "project" },
  status: "needs-approval",
  notes: ["Starts npx @modelcontextprotocol/server-github."],
};

function review(overrides: Partial<TrustReview> = {}): TrustReview {
  return {
    projectDir: PROJECT,
    projectName: "tally",
    phase: "ready",
    approval: { hash: "sha256:9f2c", approved: false, items: [HOOK, USER_HOOK] },
    message: null,
    ...overrides,
  };
}

function setup(theme: "dark" | "light", trustReview: TrustReview | null) {
  const test = createTestStore(() => ({ trustReview }));
  renderWithStore(<TrustDialogContainer />, { theme, store: test.store });
  return test;
}

describe.each(THEMES)("TrustDialog (%s)", (theme) => {
  it("shows nothing without a review", () => {
    setup(theme, null);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lists each hook with what it runs and its file, and approves on request", async () => {
    const user = userEvent.setup();
    const test = setup(theme, review());
    const dialog = screen.getByRole("dialog", { name: "Approve the hooks in tally?" });
    const list = within(dialog).getByRole("list", { name: "The hooks" });
    const rows = within(list)
      .getAllByRole("listitem")
      .filter((li) => li.parentElement === list);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("PreToolUse on Bash: ./scripts/check-command.sh");
    expect(rows[0]).toHaveTextContent("Runs a command from the project's files.");
    expect(rows[0]).toHaveTextContent("~/code/tally/.claude/settings.json");
    expect(rows[0]).toHaveTextContent("Claude Code’s file, shared with the project");
    expect(rows[1]).toHaveTextContent("~/.claude/settings.json");
    expect(rows[1]).toHaveTextContent("Claude Code’s file, yours everywhere");
    expect(dialog).toHaveTextContent(/keeps them off until you approve them/);

    // Not now has focus first: approving has to be chosen.
    expect(within(dialog).getByRole("button", { name: "Not now" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(test.actions.answerTrustReview).toHaveBeenCalledWith(true);
  });

  it("keeps the code off with Not now, and with Esc", async () => {
    const user = userEvent.setup();
    const test = setup(theme, review());
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(test.actions.answerTrustReview).toHaveBeenCalledWith(false);
    act(() => test.store.setState({ trustReview: review() }));
    await user.keyboard("{Escape}");
    expect(test.actions.answerTrustReview).toHaveBeenCalledTimes(2);
    expect(test.actions.answerTrustReview).toHaveBeenLastCalledWith(false);
  });

  it("names servers too, and says when the list changed", () => {
    setup(
      theme,
      review({
        approval: { hash: "sha256:a1", approved: false, items: [HOOK, SERVER] },
        message: "The project’s code changed since this list was shown. This is what it holds now.",
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Approve the hooks and MCP servers in tally?" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("changed since this list was shown");
    expect(screen.getByText("MCP server")).toBeInTheDocument();
  });

  it("waits while approving, then while reading", () => {
    const test = setup(theme, review({ phase: "saving" }));
    expect(screen.getByRole("button", { name: /Approving/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Not now" })).toBeDisabled();
    act(() => test.store.setState({ trustReview: review({ phase: "loading", approval: null }) }));
    expect(screen.getByRole("dialog", { name: "Checking tally" })).toHaveTextContent(
      "Reading the project’s setup…",
    );
  });

  it("says when nothing needs approval, or it is approved already, with only Close", async () => {
    const user = userEvent.setup();
    const test = setup(theme, review({ approval: null }));
    expect(screen.getByRole("dialog", { name: "Nothing in tally needs approval" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    act(() =>
      test.store.setState({
        trustReview: review({
          approval: { hash: "sha256:9f2c", approved: true, items: [HOOK] },
        }),
      }),
    );
    expect(screen.getByRole("dialog", { name: "The hooks in tally are approved" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(test.actions.answerTrustReview).toHaveBeenCalledWith(false);
  });
});
