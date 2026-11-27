/**
 * The hooks reference's tables (code.claude.com/docs/en/hooks): matchers, exit codes and the JSON
 * output, one row per case.
 */
import type { HookHandler } from "@dawg/compat";
import { describe, expect, it } from "vitest";
import type { CommandRun } from "./command.ts";
import { matcherMatches } from "./match.ts";
import { interpretRun } from "./output.ts";

describe("matchers", () => {
  it.each([
    ["*", "Bash", true],
    ["", "Bash", true],
    [null, "Bash", true],
    ["Bash", "Bash", true],
    ["Bash", "BashOutput", false],
    ["Edit|Write", "Write", true],
    ["Edit, Write", "Edit", true],
    ["Edit|Write", "MultiEdit", false],
    ["Edit.*", "Edit", true],
    ["Edit.*", "NotebookEdit", true],
    ["^Edit$", "NotebookEdit", false],
    ["mcp__memory__.*", "mcp__memory__create", true],
    ["mcp__memory", "mcp__memory__create", false],
    ["(unclosed", "(unclosed", false],
  ] as const)("%s against %s: %s", (matcher, value, expected) => {
    expect(matcherMatches("PreToolUse", matcher, value)).toBe(expected);
  });

  it("ignores the matcher on events without one", () => {
    expect(matcherMatches("Stop", "Bash", "anything")).toBe(true);
    expect(matcherMatches("UserPromptSubmit", "nope", "x")).toBe(true);
  });

  it("matches session sources and notification types", () => {
    expect(matcherMatches("SessionStart", "startup|resume", "resume")).toBe(true);
    expect(matcherMatches("SessionStart", "startup", "compact")).toBe(false);
    expect(matcherMatches("Notification", "permission_prompt", "permission_prompt")).toBe(true);
    expect(matcherMatches("Notification", "permission_prompt", "idle_prompt")).toBe(false);
  });
});

const handler = (extra: Partial<HookHandler> = {}): HookHandler => ({
  type: "command",
  command: "x",
  args: null,
  timeout: null,
  if: null,
  async: false,
  asyncRewake: false,
  shell: null,
  onFailure: null,
  statusMessage: null,
  target: "x",
  unknownKeys: [],
  raw: { type: "command", command: "x" },
  ...extra,
});

const run = (fields: Partial<CommandRun>): CommandRun => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  startError: null,
  aborted: false,
  durationMs: 12,
  ...fields,
});

describe("exit codes", () => {
  it("exit 0 with plain text: context on UserPromptSubmit and SessionStart only", () => {
    expect(
      interpretRun("UserPromptSubmit", handler(), run({ stdout: "Branch: main\n" })).context,
    ).toEqual(["Branch: main"]);
    expect(interpretRun("SessionStart", handler(), run({ stdout: "hi" })).context).toEqual(["hi"]);
    expect(interpretRun("PreToolUse", handler(), run({ stdout: "hi" }))).toMatchObject({
      outcome: "success",
      context: [],
      decision: null,
    });
  });

  it("exit 2 blocks where the event can, with stderr as the reason", () => {
    const stderr = "rm -rf is not allowed\n";
    expect(interpretRun("PreToolUse", handler(), run({ exitCode: 2, stderr }))).toMatchObject({
      outcome: "blocked",
      decision: "deny",
      reason: "rm -rf is not allowed",
      message: "rm -rf is not allowed",
    });
    for (const event of ["UserPromptSubmit", "Stop", "PostToolUse"]) {
      expect(interpretRun(event, handler(), run({ exitCode: 2, stderr }))).toMatchObject({
        outcome: "blocked",
        decision: "block",
        reason: "rm -rf is not allowed",
      });
    }
    for (const event of ["SessionStart", "SessionEnd", "Notification"]) {
      expect(interpretRun(event, handler(), run({ exitCode: 2, stderr }))).toMatchObject({
        outcome: "error",
        decision: null,
        message: "rm -rf is not allowed",
      });
    }
  });

  it("exit 2 stays blocking even when the JSON says allow", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
    expect(
      interpretRun("PreToolUse", handler(), run({ exitCode: 2, stdout, stderr: "no" })),
    ).toMatchObject({
      decision: "deny",
      outcome: "blocked",
    });
  });

  it("continue: false on Stop wins over exit 2", () => {
    const stdout = JSON.stringify({ continue: false, stopReason: "Enough" });
    expect(
      interpretRun("Stop", handler(), run({ exitCode: 2, stdout, stderr: "keep going" })),
    ).toMatchObject({
      stop: { reason: "Enough" },
      decision: null,
    });
  });

  it("other exit codes are non-blocking errors shown to the person", () => {
    expect(
      interpretRun("PreToolUse", handler(), run({ exitCode: 1, stderr: "something broke" })),
    ).toMatchObject({
      outcome: "error",
      decision: null,
      message: "Failed with non-blocking status code 1: something broke",
    });
  });

  it("a timeout, a command that cannot start and broken JSON are failures", () => {
    expect(
      interpretRun(
        "PreToolUse",
        handler(),
        run({ exitCode: null, timedOut: true, durationMs: 2000 }),
      ),
    ).toMatchObject({
      outcome: "timeout",
      decision: null,
    });
    expect(
      interpretRun("Stop", handler(), run({ exitCode: null, startError: "spawn ENOENT" })),
    ).toMatchObject({
      outcome: "error",
      message: "It could not start: spawn ENOENT",
    });
    expect(interpretRun("PreToolUse", handler(), run({ stdout: "{ nope" }))).toMatchObject({
      outcome: "error",
    });
  });

  it("onFailure: block makes a failure block, except on Stop", () => {
    const blocking = handler({ onFailure: "block" });
    expect(
      interpretRun("PreToolUse", blocking, run({ exitCode: null, timedOut: true })),
    ).toMatchObject({
      outcome: "blocked",
      decision: "deny",
    });
    expect(interpretRun("UserPromptSubmit", blocking, run({ exitCode: 1 }))).toMatchObject({
      decision: "block",
    });
    expect(interpretRun("Stop", blocking, run({ exitCode: 1 }))).toMatchObject({
      outcome: "error",
      decision: null,
    });
  });
});

describe("JSON output", () => {
  const json = (event: string, value: unknown) =>
    interpretRun(event, handler(), run({ stdout: JSON.stringify(value) }));

  it("PreToolUse: decision, reason, new input and context", () => {
    expect(
      json("PreToolUse", {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: "Production database",
          updatedInput: { command: "npm test -- --ci" },
          additionalContext: "CI mode is on",
        },
      }),
    ).toMatchObject({
      outcome: "success",
      decision: "ask",
      reason: "Production database",
      updatedInput: { command: "npm test -- --ci" },
      context: ["CI mode is on"],
    });
    expect(
      json("PreToolUse", { hookSpecificOutput: { permissionDecision: "deny" } }),
    ).toMatchObject({
      outcome: "blocked",
      decision: "deny",
    });
  });

  it("PreToolUse: the deprecated approve and block", () => {
    expect(json("PreToolUse", { decision: "approve", reason: "fine" })).toMatchObject({
      decision: "allow",
      reason: "fine",
    });
    expect(json("PreToolUse", { decision: "block", reason: "no" })).toMatchObject({
      decision: "deny",
    });
  });

  it("ignores hookSpecificOutput written for another event", () => {
    expect(
      json("PostToolUse", { hookSpecificOutput: { hookEventName: "Stop", additionalContext: "x" } })
        .context,
    ).toEqual([]);
  });

  it("decision block with a reason on PostToolUse, UserPromptSubmit and Stop", () => {
    for (const event of ["PostToolUse", "UserPromptSubmit", "Stop"]) {
      expect(json(event, { decision: "block", reason: "Run the tests first" })).toMatchObject({
        outcome: "blocked",
        decision: "block",
        reason: "Run the tests first",
      });
    }
  });

  it("continue, stopReason, systemMessage, suppressOutput and sessionTitle", () => {
    expect(
      json("PostToolUse", {
        continue: false,
        stopReason: "Build is broken",
        systemMessage: "Heads up",
        suppressOutput: true,
      }),
    ).toMatchObject({
      outcome: "blocked",
      stop: { reason: "Build is broken" },
      systemMessage: "Heads up",
      message: "Build is broken",
    });
    expect(
      json("UserPromptSubmit", {
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: "Auth work" },
      }).sessionTitle,
    ).toBe("Auth work");
  });

  it("caps context at the documented 10,000 characters", () => {
    const long = "x".repeat(12_000);
    const result = json("SessionStart", {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: long },
    });
    expect(result.context[0]?.length).toBeLessThan(10_100);
    expect(result.context[0]).toContain("[cut: 2,000 more characters]");
  });
});
