/**
 * Hosts a project's settings open to sandboxed commands (Phase 4) wait for approval like its
 * code: the trust dialog lists them as network access, in both themes, and says what approving
 * them does.
 */
import type { CompatItem } from "@dawg/protocol";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createTestStore, HOME, renderWithStore } from "../app/testing.tsx";
import { isSandboxHost } from "../lib/sandbox.ts";
import type { TrustReview } from "../state/types.ts";
import { THEMES } from "../test/render.tsx";
import { codeWords, TrustDialogContainer } from "./TrustDialog.tsx";

const PROJECT = `${HOME}/code/tally`;

const HOST: CompatItem = {
  kind: "other",
  name: "Network access to registry.npmjs.org (sandbox)",
  source: { path: `${PROJECT}/.claude/settings.json`, origin: "claude", scope: "project" },
  status: "needs-approval",
  notes: [
    "Lets the project's sandboxed shell commands reach this host; until you approve it, they cannot.",
  ],
};

const HOOK: CompatItem = {
  kind: "hook",
  name: "PreToolUse on Bash: ./check.sh",
  source: HOST.source,
  status: "needs-approval",
  notes: ["Runs a command from the project's files."],
};

function review(items: CompatItem[]): TrustReview {
  return {
    projectDir: PROJECT,
    projectName: "tally",
    phase: "ready",
    approval: { hash: "sha256:1", approved: false, items },
    message: null,
  };
}

describe("sandbox host items", () => {
  it("are told from code by name", () => {
    expect(isSandboxHost(HOST)).toBe(true);
    expect(isSandboxHost(HOOK)).toBe(false);
    expect(isSandboxHost({ kind: "other", name: "Output style: terse" })).toBe(false);
    expect(codeWords([HOOK, HOST])).toBe("hooks and network hosts");
  });
});

describe.each(THEMES)("the trust dialog with sandbox hosts (%s)", (theme) => {
  it("lists a host as network access, says what approving does, and approves on request", async () => {
    const user = userEvent.setup();
    const test = createTestStore(() => ({ trustReview: review([HOST]) }));
    renderWithStore(<TrustDialogContainer />, { theme, store: test.store });
    const dialog = screen.getByRole("dialog", { name: "Approve the network hosts in tally?" });
    const list = within(dialog).getByRole("list", { name: "The network hosts" });
    const row = within(list)
      .getAllByRole("listitem")
      .filter((li) => li.parentElement === list)[0];
    expect(row).toHaveTextContent("Network");
    expect(row).toHaveTextContent("Network access to registry.npmjs.org (sandbox)");
    expect(row).toHaveTextContent("~/code/tally/.claude/settings.json");
    expect(dialog).toHaveTextContent(
      "The project’s settings let sandboxed commands reach these hosts, so dawg keeps them off the list until you approve them.",
    );
    expect(within(dialog).getByRole("button", { name: "Not now" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Approve" }));
    expect(test.actions.answerTrustReview).toHaveBeenCalledWith(true);
  });

  it("lists hosts with code, under the usual words", () => {
    const test = createTestStore(() => ({ trustReview: review([HOOK, HOST]) }));
    renderWithStore(<TrustDialogContainer />, { theme, store: test.store });
    const dialog = screen.getByRole("dialog", {
      name: "Approve the hooks and network hosts in tally?",
    });
    expect(dialog).toHaveTextContent(/run commands on your Mac/);
    expect(
      within(dialog).getByText("Network access to registry.npmjs.org (sandbox)"),
    ).toBeVisible();
  });
});
