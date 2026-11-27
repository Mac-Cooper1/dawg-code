/**
 * The sandbox on shell-command cards and permission cards (Phase 4), in both themes: the mark in
 * a command's header and its accessible name, what the sandbox blocked, why a command ran
 * outside it, and the line on a permission card for a command that would run outside it.
 */
import type { CommandDisplay } from "@dawg/protocol";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PermissionCard } from "../cards/PermissionCard.tsx";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { makeEnv, permissionItem, permissionRequest, toolItem } from "./testing.ts";

function command(display: Partial<CommandDisplay>) {
  const base = toolItem();
  return toolItem({ display: { ...(base.display as CommandDisplay), ...display } });
}

describe.each(THEMES)("the sandbox on command cards (%s)", (theme) => {
  it("marks a sandboxed command in its header and its name", () => {
    renderInTheme(
      <ToolCard
        item={command({ sandbox: { placement: "inside", reason: null, blocked: [] } })}
        open={false}
        env={makeEnv()}
      />,
      theme,
    );
    const header = screen.getByRole("button", {
      name: "Ran uv run pytest -q, exit 0, sandboxed, 0.8 s",
    });
    const mark = within(header).getByText("sandboxed");
    expect(mark.className).toMatch(/inside/);
    expect(mark.querySelector("svg")).not.toBeNull();
  });

  it("says what the sandbox blocked, in the header and the body", () => {
    renderInTheme(
      <ToolCard
        item={command({
          exitCode: 1,
          output: "bash: /etc/hosts: Operation not permitted",
          sandbox: {
            placement: "inside",
            reason: null,
            blocked: [
              "Writing /etc/hosts",
              "Connecting to example.com:443 (not on the allowed list)",
            ],
          },
        })}
        open
        env={makeEnv()}
      />,
      theme,
    );
    const header = screen.getByRole("button", { name: /sandbox blocked 2 actions/ });
    expect(within(header).getByText("sandbox blocked 2 actions").className).toMatch(/blocked/);
    const blocked = screen.getByRole("region", { name: "Blocked by the sandbox" });
    expect(
      within(blocked)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Writing /etc/hosts", "Connecting to example.com:443 (not on the allowed list)"]);
    expect(blocked).toHaveTextContent("dawg asks you before running a command outside the sandbox");
  });

  it("says why a command ran outside the sandbox", () => {
    renderInTheme(
      <ToolCard
        item={command({ sandbox: { placement: "outside", reason: "excluded", blocked: [] } })}
        open
        env={makeEnv()}
      />,
      theme,
    );
    const header = screen.getByRole("button", { name: /outside the sandbox/ });
    expect(within(header).getByText("outside the sandbox").className).toMatch(/outside/);
    expect(
      screen.getByText(
        "Ran outside the sandbox: it is one of the commands the settings exclude from the sandbox.",
      ),
    ).toBeVisible();
  });

  it("shows nothing about the sandbox while it is off", () => {
    renderInTheme(<ToolCard item={toolItem()} open env={makeEnv()} />, theme);
    expect(screen.queryByText(/sandbox/i)).toBeNull();
  });
});

describe.each(THEMES)("the sandbox on permission cards (%s)", (theme) => {
  it("warns that a retry would run outside the sandbox", () => {
    renderInTheme(
      <PermissionCard
        item={permissionItem({
          request: permissionRequest({
            title: "Run a shell command outside the sandbox",
            input: { command: "curl https://example.com", dangerouslyDisableSandbox: true },
            sandbox: { placement: "outside", reason: "retry", blocked: [] },
          }),
        })}
        shownAgain={false}
        autoFocus={false}
        env={makeEnv()}
      />,
      theme,
    );
    const card = screen.getByRole("region", {
      name: "Permission needed: Run a shell command outside the sandbox",
    });
    const line = within(card).getByText(/Runs outside the sandbox, with full access/);
    expect(line).toHaveTextContent(
      "Runs outside the sandbox, with full access: the sandbox blocked it, so it is being tried again without the sandbox.",
    );
    expect(line.className).toMatch(/outsideText/);
  });

  it("says when the command runs in the sandbox", () => {
    renderInTheme(
      <PermissionCard
        item={permissionItem({
          request: permissionRequest({
            sandbox: { placement: "inside", reason: null, blocked: [] },
          }),
        })}
        shownAgain={false}
        autoFocus={false}
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.getByText(/Runs in the sandbox/)).toBeVisible();
  });

  it("says nothing while the sandbox is off", () => {
    renderInTheme(
      <PermissionCard
        item={permissionItem()}
        shownAgain={false}
        autoFocus={false}
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.queryByText(/sandbox/i)).toBeNull();
  });
});
