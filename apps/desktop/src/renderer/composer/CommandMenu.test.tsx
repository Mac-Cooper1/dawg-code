import type { CommandInfo } from "@dawg/protocol";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { CommandMenu } from "./CommandMenu.tsx";
import { commandOrigin, filterCommands, takesArguments } from "./commands.ts";

const COMMANDS: CommandInfo[] = [
  {
    name: "compact",
    description: "Summarise the conversation to free context",
    argumentHint: "[focus]",
    source: "builtin",
    kind: "command",
  },
  {
    name: "frontend:test",
    description: "Run the frontend tests",
    argumentHint: "[pattern]",
    source: "project",
    kind: "command",
  },
  {
    name: "review",
    description: "Review the current changes",
    argumentHint: null,
    source: "user",
    kind: "skill",
  },
  // From an engine before Phase 4: no source or kind, which means built in.
  { name: "help", description: "Show the commands", argumentHint: "[command]" },
];

describe.each(THEMES)("the / menu with custom commands and skills (%s)", (theme) => {
  it("tags each with where it comes from and shows its argument hint", () => {
    const onChoose = vi.fn();
    renderInTheme(
      <CommandMenu
        id="menu"
        commands={COMMANDS}
        active={1}
        optionId={(index) => `option-${index}`}
        onChoose={onChoose}
      />,
      theme,
    );
    const list = screen.getByRole("listbox", { name: "Commands" });
    const options = within(list).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "/compact [focus]Summarise the conversation to free context",
      "/frontend:test [pattern]projectRun the frontend tests",
      "/reviewpersonalReview the current changes",
      "/help [command]Show the commands",
    ]);
    expect(
      screen.getByRole("option", {
        name: "/frontend:test [pattern], the project's command, Run the frontend tests",
      }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("option", { name: "/review, your own skill, Review the current changes" }),
    ).toBeVisible();
  });
});

describe("command helpers", () => {
  it("names where a command comes from, and nothing for dawg's own", () => {
    expect(COMMANDS.map(commandOrigin)).toEqual([
      null,
      { tag: "project", label: "the project's command" },
      { tag: "personal", label: "your own skill" },
      null,
    ]);
  });

  it("filters namespaced names and knows which take arguments", () => {
    expect(filterCommands(COMMANDS, "test").map((c) => c.name)).toEqual(["frontend:test"]);
    expect(filterCommands(COMMANDS, "front").map((c) => c.name)).toEqual(["frontend:test"]);
    expect(takesArguments(COMMANDS[1] as CommandInfo)).toBe(true);
    expect(takesArguments(COMMANDS[2] as CommandInfo)).toBe(false);
  });
});
