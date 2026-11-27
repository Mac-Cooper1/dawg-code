/**
 * Settings → Permissions → Sandbox (Phase 4), in both themes: off until turned on, the switches
 * write to the file chosen, auto-allow cannot go into a project's shared file, allowed hosts are
 * added and removed, and excluded commands are shown.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { PermissionSettingsState, ResolvedTheme } from "../../shared/bridge.ts";
import { createFakePermissions, type FakeSettingsFile } from "../bridge/fake-permissions.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { PermissionsPage } from "./PermissionsPage.tsx";
import { SandboxSection } from "./SandboxSection.tsx";

const HOME = "/Users/me";
const TALLY = `${HOME}/code/tally`;
const LOCAL = `${TALLY}/.dawg/settings.local.json`;
const SHARED = `${TALLY}/.dawg/settings.json`;
const CLAUDE_PROJECT = `${TALLY}/.claude/settings.json`;

function setup(theme: ResolvedTheme, files: Record<string, FakeSettingsFile> = {}) {
  const fake = createFakePermissions({ homeDir: HOME, files });
  renderInTheme(
    <PermissionsPage
      api={fake.api}
      projects={[{ dir: TALLY, name: "tally" }]}
      initialProject={TALLY}
      homeDir={HOME}
      savedForMs={60_000}
    />,
    theme,
  );
  return { fake, user: userEvent.setup() };
}

const section = () => screen.getByRole("region", { name: "Sandbox" });
const sw = (name: string) => within(section()).getByRole("switch", { name });

describe.each(THEMES)("Settings sandbox section (%s)", (theme) => {
  it("is off until turned on, and turning it on saves to the project's personal file", async () => {
    const { fake, user } = setup(theme);
    await screen.findByRole("region", { name: "Sandbox" });
    expect(within(section()).getByText("Off: no settings file turns it on.")).toBeVisible();
    expect(sw("Run shell commands in the sandbox")).toHaveAttribute("aria-checked", "false");
    expect(within(section()).getByRole("combobox", { name: "Save changes to" })).toHaveValue(
      "local",
    );
    await user.click(sw("Run shell commands in the sandbox"));
    await waitFor(() =>
      expect(
        within(section()).getByText(
          "On for new sessions, set by ~/code/tally/.dawg/settings.local.json.",
        ),
      ).toBeVisible(),
    );
    expect(fake.writes.at(-1)).toEqual({
      scope: "local",
      projectDir: TALLY,
      sandbox: { enabled: true },
    });
    expect(fake.files.get(LOCAL)?.sandbox).toEqual({ enabled: true });
    expect(sw("Run shell commands in the sandbox")).toHaveAttribute("aria-checked", "true");
  });

  it("keeps auto-allow out of a project's shared file", async () => {
    const { fake, user } = setup(theme);
    await screen.findByRole("region", { name: "Sandbox" });
    await user.click(sw("Run sandboxed commands without asking"));
    await waitFor(() =>
      expect(fake.files.get(LOCAL)?.sandbox?.autoAllowBashIfSandboxed).toBe(true),
    );
    await user.selectOptions(
      within(section()).getByRole("combobox", { name: "Save changes to" }),
      "project",
    );
    const auto = sw("Run sandboxed commands without asking");
    expect(auto).toBeDisabled();
    expect(within(section()).getByText(/Only your own settings can turn this on/)).toBeVisible();
    // The retry switch still writes to the shared file.
    await user.click(sw("Offer to retry a blocked command outside the sandbox"));
    await waitFor(() =>
      expect(fake.files.get(SHARED)?.sandbox?.allowUnsandboxedCommands).toBe(false),
    );
  });

  it("adds and removes allowed hosts, and names hosts other files allow", async () => {
    const { fake, user } = setup(theme, {
      [CLAUDE_PROJECT]: {
        sandbox: { allowedDomains: ["github.com"], excludedCommands: ["docker *"] },
      },
    });
    await screen.findByRole("region", { name: "Sandbox" });
    expect(within(section()).getByText("Also allowed by other files: github.com.")).toBeVisible();
    const field = within(section()).getByRole("textbox", { name: "Add an allowed host" });
    await user.type(field, "https://registry.npmjs.org{Enter}");
    expect(
      within(section()).getByText("Type the host name alone, such as github.com."),
    ).toBeVisible();
    await user.clear(field);
    await user.type(field, "Registry.npmjs.org{Enter}");
    await waitFor(() =>
      expect(fake.files.get(LOCAL)?.sandbox?.allowedDomains).toEqual(["registry.npmjs.org"]),
    );
    const hosts = within(section()).getByRole("list", { name: /Allowed hosts/ });
    expect(within(hosts).getByText("registry.npmjs.org")).toBeVisible();
    await user.click(within(hosts).getByRole("button", { name: "Remove registry.npmjs.org" }));
    await waitFor(() => expect(fake.files.get(LOCAL)?.sandbox?.allowedDomains).toEqual([]));
    // Excluded commands are shown, from every file.
    const excluded = within(section()).getByRole("list", { name: "Excluded commands" });
    expect(within(excluded).getByText("docker *")).toBeVisible();
  });

  it("warns when the sandbox cannot run here", () => {
    const state: PermissionSettingsState = {
      projectDir: null,
      files: [
        {
          scope: "user",
          origin: "dawg",
          path: `${HOME}/.dawg/settings.json`,
          exists: false,
          writable: true,
          defaultMode: null,
          allow: [],
          ask: [],
          deny: [],
          problems: [],
          sandbox: null,
        },
      ],
      defaultMode: "default",
      bypassDisabled: false,
      sandbox: {
        enabled: true,
        enabledBy: "<command line>",
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: true,
        allowedDomains: [],
        deniedDomains: [],
        excludedCommands: [],
        available: false,
        unavailableReason: "The sandbox runs on macOS only in the app.",
      },
    };
    renderInTheme(<SandboxSection state={state} homeDir={HOME} save={async () => true} />, theme);
    expect(screen.getByRole("note")).toHaveTextContent(
      "The sandbox runs on macOS only in the app. With it on, commands run without it.",
    );
    expect(screen.getByText("On for new sessions, set by the command line.")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Save changes to" })).toHaveValue("user");
  });
});
