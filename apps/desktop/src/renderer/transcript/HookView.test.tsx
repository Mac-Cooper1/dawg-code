import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { hookLine } from "../lib/hooks.ts";
import type { HookItem, HookSkippedItem } from "../state/types.ts";
import { renderInTheme, THEMES } from "../test/render.tsx";
import { HookSkippedView, HookView } from "./HookView.tsx";
import { CWD, HOME, makeEnv } from "./testing.ts";

function hookItem(overrides: Partial<HookItem> = {}): HookItem {
  return {
    kind: "hook",
    id: "hook:7",
    turnId: "turn-1",
    seq: 7,
    toolCallId: "call-1",
    toolName: "Bash",
    hook: {
      event: "PreToolUse",
      matcher: "Bash",
      type: "command",
      command: "./scripts/check-command.sh",
      source: { path: `${CWD}/.claude/settings.json`, origin: "claude", scope: "project" },
    },
    outcome: "blocked",
    exitCode: 2,
    durationMs: 41,
    decision: "deny",
    message: "rm -rf is not allowed in this project",
    time: Date.UTC(2026, 10, 27, 14, 32, 5),
    ...overrides,
  };
}

function skippedItem(overrides: Partial<HookSkippedItem> = {}): HookSkippedItem {
  return {
    kind: "hook-skipped",
    id: "hook-skipped:9",
    turnId: "turn-1",
    seq: 9,
    projectDir: CWD,
    sources: [{ path: `${CWD}/.claude/settings.json`, origin: "claude", scope: "project" }],
    ...overrides,
  };
}

describe("hookLine", () => {
  it("says what each outcome did, in one line", () => {
    expect(hookLine(hookItem())).toBe(
      "PreToolUse hook blocked Bash: rm -rf is not allowed in this project",
    );
    expect(
      hookLine(
        hookItem({
          hook: { ...hookItem().hook, event: "Stop", matcher: null },
          toolCallId: null,
          toolName: null,
          message: "Run the tests first",
        }),
      ),
    ).toBe("Stop hook kept the turn going: Run the tests first");
    expect(
      hookLine(
        hookItem({
          hook: { ...hookItem().hook, event: "UserPromptSubmit", matcher: null },
          toolCallId: null,
          toolName: null,
          decision: "block",
          message: "No secrets in prompts",
        }),
      ),
    ).toBe("UserPromptSubmit hook blocked the prompt: No secrets in prompts");
    expect(
      hookLine(
        hookItem({
          hook: { ...hookItem().hook, event: "PostToolUse" },
          toolName: "Edit",
          outcome: "success",
          exitCode: 0,
          decision: null,
          message: null,
        }),
      ),
    ).toBe("PostToolUse hook ran for Edit");
    expect(
      hookLine(
        hookItem({
          hook: { ...hookItem().hook, event: "SessionStart", matcher: "startup" },
          toolCallId: null,
          toolName: null,
          outcome: "error",
          exitCode: 1,
          decision: null,
          message: "jq: command not found",
        }),
      ),
    ).toBe("SessionStart hook failed (exit 1): jq: command not found");
    expect(
      hookLine(hookItem({ outcome: "timeout", exitCode: null, decision: null, message: null })),
    ).toBe("PreToolUse hook timed out for Bash");
    expect(
      hookLine(hookItem({ outcome: "success", exitCode: 0, decision: "allow", message: null })),
    ).toBe("PreToolUse hook allowed Bash");
  });

  it("says what the tier 2 events did", () => {
    const at = (event: string, fields: Partial<HookItem>) =>
      hookLine(hookItem({ hook: { ...hookItem().hook, event }, ...fields }));
    expect(at("PermissionRequest", { outcome: "success", decision: "allow", message: null })).toBe(
      "PermissionRequest hook allowed Bash",
    );
    expect(at("PermissionRequest", { decision: "deny", message: "Not on main" })).toBe(
      "PermissionRequest hook denied Bash: Not on main",
    );
    expect(at("PostToolUseFailure", { decision: "block", message: "Run npm install" })).toBe(
      "PostToolUseFailure hook gave feedback on Bash: Run npm install",
    );
    expect(
      at("PreCompact", {
        toolCallId: null,
        toolName: null,
        decision: "block",
        message: "Deploying",
      }),
    ).toBe("PreCompact hook blocked the compaction: Deploying");
    expect(
      at("SubagentStop", {
        toolCallId: null,
        toolName: null,
        decision: "block",
        message: "Add tests",
      }),
    ).toBe("SubagentStop hook kept the agent going: Add tests");
    expect(
      at("PostToolBatch", {
        toolCallId: null,
        toolName: null,
        decision: "block",
        message: "Run pytest",
      }),
    ).toBe("PostToolBatch hook ended the turn: Run pytest");
  });
});

describe.each(THEMES)("HookView (%s)", (theme) => {
  it("is one line that opens to its source, command, exit code and timing", async () => {
    const user = userEvent.setup();
    const setItemOpen = vi.fn();
    const { rerender } = renderInTheme(
      <HookView item={hookItem()} open={false} env={makeEnv({ setItemOpen })} />,
      theme,
    );
    const toggle = screen.getByRole("button", {
      name: "PreToolUse hook blocked Bash: rm -rf is not allowed in this project",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("./scripts/check-command.sh")).not.toBeInTheDocument();
    await user.click(toggle);
    expect(setItemOpen).toHaveBeenCalledWith("hook:7", true);

    rerender(<HookView item={hookItem()} open env={makeEnv({ setItemOpen })} />);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("./scripts/check-command.sh")).toBeInTheDocument();
    expect(screen.getByText("~/code/tally/.claude/settings.json")).toBeInTheDocument();
    expect(screen.getByText(/Claude Code’s file, shared with the project/)).toBeInTheDocument();
    expect(screen.getByText("Exit code").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText(/took 41 ms/)).toBeInTheDocument();
    expect(screen.getByText("Matcher").nextElementSibling).toHaveTextContent("Bash");
  });

  it("names a hook that is not a command by its type and target, without an exit code", () => {
    renderInTheme(
      <HookView
        item={hookItem({
          hook: { ...hookItem().hook, type: "http", command: "http://localhost:8080/check" },
          exitCode: null,
        })}
        open
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.getByText("Type").nextElementSibling).toHaveTextContent("HTTP hook");
    expect(screen.getByText("Address").nextElementSibling).toHaveTextContent(
      "http://localhost:8080/check",
    );
    expect(screen.queryByText("Exit code")).not.toBeInTheDocument();
  });

  it("keeps a plain run quiet and marks blocks and failures", () => {
    const { container, rerender } = renderInTheme(
      <HookView
        item={hookItem({ outcome: "success", exitCode: 0, decision: null, message: null })}
        open={false}
        env={makeEnv()}
      />,
      theme,
    );
    const quiet = container.firstElementChild?.className ?? "";
    rerender(<HookView item={hookItem()} open={false} env={makeEnv()} />);
    const blocked = container.firstElementChild?.className ?? "";
    rerender(
      <HookView
        item={hookItem({ outcome: "timeout", exitCode: null, decision: null, message: null })}
        open
        env={makeEnv()}
      />,
    );
    const failed = container.firstElementChild?.className ?? "";
    expect(new Set([quiet, blocked, failed]).size).toBe(3);
    expect(screen.getByText("Exit code").nextElementSibling).toHaveTextContent(
      "None: it was stopped at its time limit",
    );
  });

  it("names dawg's own files and the person's home", () => {
    renderInTheme(
      <HookView
        item={hookItem({
          hook: {
            ...hookItem().hook,
            source: { path: `${HOME}/.dawg/settings.json`, origin: "dawg", scope: "user" },
          },
        })}
        open
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.getByText("~/.dawg/settings.json")).toBeInTheDocument();
    expect(screen.getByText(/dawg’s file, yours everywhere/)).toBeInTheDocument();
  });
});

describe.each(THEMES)("HookSkippedView (%s)", (theme) => {
  it("says hooks wait for approval and offers to review them", async () => {
    const user = userEvent.setup();
    const reviewProjectCode = vi.fn();
    renderInTheme(
      <HookSkippedView item={skippedItem()} env={makeEnv({ reviewProjectCode })} />,
      theme,
    );
    expect(
      screen.getByText(
        "Hooks from this project are waiting for your approval, so they did not run.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(reviewProjectCode).toHaveBeenCalledWith(CWD);
  });

  it("names the person's Claude Code settings, and has no button without a way to review", () => {
    renderInTheme(
      <HookSkippedView
        item={skippedItem({
          sources: [{ path: `${HOME}/.claude/settings.json`, origin: "claude", scope: "user" }],
        })}
        env={makeEnv()}
      />,
      theme,
    );
    expect(screen.getByText(/Hooks from your Claude Code settings/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
  });
});
