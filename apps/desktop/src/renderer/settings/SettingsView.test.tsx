import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Appearance, ResolvedTheme, ToolCallDisplay } from "../../shared/bridge.ts";
import { PlatformProvider } from "../app/platform.tsx";
import type { SettingsPage } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { SettingsView } from "./SettingsView.tsx";

interface Options {
  page?: SettingsPage;
  appearance?: Appearance;
  system?: ResolvedTheme;
  toolCalls?: ToolCallDisplay;
}

/** Holds the page, appearance and tool-call choice, as the store does. */
function Harness(
  props: Required<Options> & {
    theme: ResolvedTheme;
    on: {
      onSelectPage: (page: SettingsPage) => void;
      onSetAppearance: (appearance: Appearance) => void;
      onSetToolCallDisplay: (value: ToolCallDisplay) => void;
      onBack: () => void;
    };
  },
) {
  const [page, setPage] = useState(props.page);
  const [appearance, setAppearance] = useState(props.appearance);
  const [toolCalls, setToolCalls] = useState(props.toolCalls);
  return (
    <SettingsView
      page={page}
      appearance={appearance}
      system={props.system}
      theme={props.theme}
      toolCalls={toolCalls}
      // Settings → General's notification and new-session controls: GeneralPage.test.tsx.
      notifications
      dockBadge
      newSessionWorktree="ask"
      onSetNotifications={() => {}}
      onSetDockBadge={() => {}}
      onSetNewSessionWorktree={() => {}}
      onSelectPage={(next) => {
        setPage(next);
        props.on.onSelectPage(next);
      }}
      onSetAppearance={(next) => {
        setAppearance(next);
        props.on.onSetAppearance(next);
      }}
      onSetToolCallDisplay={(next) => {
        setToolCalls(next);
        props.on.onSetToolCallDisplay(next);
      }}
      onBack={props.on.onBack}
    />
  );
}

function setup(theme: ResolvedTheme, options: Options = {}) {
  const on = {
    onSelectPage: vi.fn(),
    onSetAppearance: vi.fn(),
    onSetToolCallDisplay: vi.fn(),
    onBack: vi.fn(),
  };
  renderInTheme(
    <PlatformProvider os="darwin">
      <Harness
        theme={theme}
        page={options.page ?? "general"}
        appearance={options.appearance ?? "system"}
        system={options.system ?? "dark"}
        toolCalls={options.toolCalls ?? "smart"}
        on={on}
      />
    </PlatformProvider>,
    theme,
  );
  return { on, user: userEvent.setup() };
}

describe.each(THEMES)("SettingsView (%s)", (theme) => {
  it("has its own title bar with the theme switch and Back to sessions", async () => {
    const { on, user } = setup(theme);
    const bar = screen.getByRole("banner");
    expect(bar).toHaveTextContent("Settings");
    expect(bar).toHaveAttribute("data-traffic-lights", "true");
    const next = theme === "dark" ? "light" : "dark";
    await user.click(within(bar).getByRole("button", { name: `Switch to ${next} appearance` }));
    expect(on.onSetAppearance).toHaveBeenCalledWith(next);
    await user.click(within(bar).getByRole("button", { name: "Back to sessions" }));
    expect(on.onBack).toHaveBeenCalledOnce();
  });

  it("goes back to the sessions on Esc, unless focus is in a text field", async () => {
    const { on, user } = setup(theme, { page: "shortcuts" });
    await user.click(screen.getByRole("searchbox", { name: "Filter shortcuts" }));
    await user.keyboard("{Escape}");
    expect(on.onBack).not.toHaveBeenCalled();
    const nav = screen.getByRole("navigation", { name: "Settings pages" });
    await user.click(within(nav).getByRole("button", { name: "Shortcuts" }));
    await user.keyboard("{Escape}");
    expect(on.onBack).toHaveBeenCalledOnce();
  });

  it("lists the pages and marks the current one", async () => {
    const { on, user } = setup(theme);
    const nav = screen.getByRole("navigation", { name: "Settings pages" });
    const pages = within(nav).getAllByRole("button");
    expect(pages.map((page) => page.textContent)).toEqual([
      "General",
      "Models",
      "Permissions",
      "Project setup",
      "Hooks",
      "Skills and commands",
      "MCP servers",
      "Web",
      "Shortcuts",
    ]);
    expect(within(nav).getByRole("button", { name: "General" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await user.click(within(nav).getByRole("button", { name: "Permissions" }));
    expect(on.onSelectPage).toHaveBeenCalledWith("permissions");
    expect(within(nav).getByRole("button", { name: "Permissions" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it.each([["permissions", "Permissions", "The default permission mode"]] as const)(
    "says the %s page is not in this build yet",
    (page, title, line) => {
      setup(theme, { page });
      const main = screen.getByRole("main");
      expect(within(main).getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
      expect(main).toHaveTextContent("Not in this build yet");
      expect(main).toHaveTextContent(line);
    },
  );

  it("shows the keymap on Shortcuts", () => {
    setup(theme, { page: "shortcuts" });
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 1, name: "Shortcuts" })).toBeInTheDocument();
    expect(within(main).getByRole("searchbox", { name: "Filter shortcuts" })).toBeInTheDocument();
    expect(main).not.toHaveTextContent("Not in this build yet");
  });

  it("shows General: how dawg looks", () => {
    setup(theme);
    expect(screen.getByRole("heading", { level: 1, name: "General" })).toBeInTheDocument();
    expect(screen.getByText(/^How dawg looks/)).toBeInTheDocument();
    expect(screen.getByText(/moon and sun button in each window’s title bar/)).toBeInTheDocument();
  });

  it("offers three appearances with previews, the current one checked", () => {
    setup(theme, { appearance: "system", system: "dark" });
    const group = screen.getByRole("radiogroup", { name: "Appearance" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(within(group).getByRole("radio", { name: "Match macOS" })).toHaveAccessibleDescription(
      "Follows System Settings. Right now: Dark",
    );
    expect(within(group).getByRole("radio", { name: "Dark" })).toHaveAccessibleDescription(
      "Always dark",
    );
    expect(within(group).getByRole("radio", { name: "Light" })).toHaveAccessibleDescription(
      "Always light",
    );
  });

  it("says what macOS shows right now", () => {
    setup(theme, { system: "light" });
    expect(screen.getByText("Follows System Settings. Right now: Light")).toBeInTheDocument();
  });

  it("chooses an appearance by click and by arrow keys", async () => {
    const { on, user } = setup(theme, { appearance: "system" });
    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(on.onSetAppearance).toHaveBeenLastCalledWith("light");
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");

    // Held down, as a person would: Radix chooses when focus arrives while an arrow is pressed.
    await user.keyboard("{ArrowLeft>}");
    await waitFor(() => expect(on.onSetAppearance).toHaveBeenLastCalledWith("dark"));
    await user.keyboard("{/ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
  });

  it("reaches the appearance group with Tab, on the checked card", async () => {
    const { user } = setup(theme, { appearance: "dark" });
    screen.getByRole("button", { name: "Shortcuts" }).focus();
    await user.tab();
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveFocus();
  });

  it("chooses how tool calls show", async () => {
    const { on, user } = setup(theme, { toolCalls: "smart" });
    const group = screen.getByRole("radiogroup", { name: "Tool calls in the transcript" });
    const options = within(group).getAllByRole("radio");
    expect(options.map((option) => option.textContent)).toEqual([
      "Open what needs a lookFailed commands and edits open; reads, searches and passing commands stay closed",
      "All closedOne line per call; click a line to open it",
      "All openEvery output and diff, in full",
    ]);
    expect(within(group).getByRole("radio", { name: "Open what needs a look" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(within(group).getByRole("radio", { name: "All open" }));
    expect(on.onSetToolCallDisplay).toHaveBeenCalledWith("open");
    expect(within(group).getByRole("radio", { name: "All open" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});
