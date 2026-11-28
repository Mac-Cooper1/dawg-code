/**
 * The hooks reference's tables (code.claude.com/docs/en/hooks): matchers, exit codes and the JSON
 * output, one row per case.
 */
import type { HookHandler } from "@dawg/compat";
import { describe, expect, it } from "vitest";
import type { CommandRun } from "./command.ts";
import { matcherMatches } from "./match.ts";
import { type HandlerRun, interpretHandler, interpretRun } from "./output.ts";

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
  url: null,
  headers: {},
  allowedEnvVars: [],
  prompt: null,
  model: null,
  continueOnBlock: false,
  server: null,
  tool: null,
  input: null,
  once: false,
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

describe("tier 2 events: exit codes and JSON output", () => {
  const json = (event: string, value: unknown, h = handler()) =>
    interpretRun(event, h, run({ stdout: JSON.stringify(value) }));

  it("PermissionRequest: allow with new input and permission updates, deny with interrupt", () => {
    const updates = [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm run lint" }],
        behavior: "allow",
        destination: "session",
      },
    ];
    expect(
      json("PermissionRequest", {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "allow",
            updatedInput: { command: "npm run lint" },
            updatedPermissions: updates,
          },
        },
      }),
    ).toMatchObject({
      outcome: "success",
      decision: "allow",
      updatedInput: { command: "npm run lint" },
      updatedPermissions: updates,
    });
    expect(
      json("PermissionRequest", {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny", message: "Not on main", interrupt: true },
        },
      }),
    ).toMatchObject({
      outcome: "blocked",
      decision: "deny",
      reason: "Not on main",
      interrupt: true,
    });
    // Fields that belong to the other behaviour are not read.
    expect(
      json("PermissionRequest", {
        hookSpecificOutput: { decision: { behavior: "deny", updatedInput: { command: "x" } } },
      }),
    ).toMatchObject({ decision: "deny", updatedInput: null, interrupt: false });
    expect(
      json("PermissionRequest", { hookSpecificOutput: { decision: { behavior: "maybe" } } }),
    ).toMatchObject({ outcome: "success", decision: null });
  });

  it("PermissionRequest: exit 2 is not a decision, and onFailure block denies", () => {
    expect(
      interpretRun("PermissionRequest", handler(), run({ exitCode: 2, stderr: "nope" })),
    ).toMatchObject({ outcome: "error", decision: null });
    expect(
      interpretRun("PermissionRequest", handler({ onFailure: "block" }), run({ exitCode: 1 })),
    ).toMatchObject({ outcome: "blocked", decision: "deny" });
    expect(
      interpretRun(
        "PermissionRequest",
        handler({ onFailure: "block" }),
        run({ exitCode: null, timedOut: true, durationMs: 1000 }),
      ),
    ).toMatchObject({ outcome: "blocked", decision: "deny" });
  });

  it("PostToolUseFailure: exit 2 and decision block go to the model, context too", () => {
    expect(
      interpretRun(
        "PostToolUseFailure",
        handler(),
        run({ exitCode: 2, stderr: "Install express first" }),
      ),
    ).toMatchObject({ outcome: "blocked", decision: "block", reason: "Install express first" });
    expect(
      json("PostToolUseFailure", { decision: "block", reason: "Retry with --force" }),
    ).toMatchObject({
      decision: "block",
      reason: "Retry with --force",
    });
    expect(
      json("PostToolUseFailure", {
        hookSpecificOutput: {
          hookEventName: "PostToolUseFailure",
          additionalContext: "The cache is stale",
        },
      }).context,
    ).toEqual(["The cache is stale"]);
    // Plain output is not context here.
    expect(interpretRun("PostToolUseFailure", handler(), run({ stdout: "hi" })).context).toEqual(
      [],
    );
  });

  it("PreCompact: exit 2 and decision block block it; plain output is the summary's instructions", () => {
    expect(
      interpretRun("PreCompact", handler(), run({ exitCode: 2, stderr: "Not during a deploy" })),
    ).toMatchObject({ outcome: "blocked", decision: "block", reason: "Not during a deploy" });
    expect(json("PreCompact", { decision: "block", reason: "Later" })).toMatchObject({
      decision: "block",
    });
    expect(
      interpretRun("PreCompact", handler(), run({ stdout: "Keep the list of open bugs.\n" }))
        .context,
    ).toEqual(["Keep the list of open bugs."]);
    // "Claude Code discards systemMessage and continue."
    expect(json("PreCompact", { continue: false, systemMessage: "x" })).toMatchObject({
      outcome: "success",
      stop: null,
      systemMessage: null,
    });
  });

  it("PostCompact: no decision; exit 2 is shown to the person only", () => {
    expect(
      interpretRun("PostCompact", handler(), run({ exitCode: 2, stderr: "log failed" })),
    ).toMatchObject({ outcome: "error", decision: null, message: "log failed" });
    expect(json("PostCompact", { decision: "block", continue: false })).toMatchObject({
      outcome: "success",
      decision: null,
      stop: null,
    });
  });
});

describe("tier 3 events: exit codes and JSON output", () => {
  const json = (event: string, value: unknown) =>
    interpretRun(event, handler(), run({ stdout: JSON.stringify(value) }));

  it("PostToolBatch and UserPromptExpansion: exit 2 and decision block block; context counts", () => {
    for (const event of ["PostToolBatch", "UserPromptExpansion"]) {
      expect(interpretRun(event, handler(), run({ exitCode: 2, stderr: "Not now" }))).toMatchObject(
        {
          outcome: "blocked",
          decision: "block",
          reason: "Not now",
        },
      );
      expect(json(event, { decision: "block", reason: "No" })).toMatchObject({ decision: "block" });
      expect(
        json(event, {
          hookSpecificOutput: { hookEventName: event, additionalContext: "Note this" },
        }).context,
      ).toEqual(["Note this"]);
    }
  });

  it("StopFailure: output and exit code change nothing", () => {
    expect(interpretRun("StopFailure", handler(), run({ exitCode: 2, stderr: "x" }))).toMatchObject(
      {
        decision: null,
      },
    );
    expect(
      json("StopFailure", { continue: false, systemMessage: "x", decision: "block" }),
    ).toMatchObject({
      outcome: "success",
      decision: null,
      stop: null,
      systemMessage: null,
    });
  });
});

describe("Elicitation and ElicitationResult: exit codes and JSON output", () => {
  const json = (event: string, value: unknown) =>
    interpretRun(event, handler(), run({ stdout: JSON.stringify(value) }));

  it("an action answers: accept with content, decline, cancel; none leaves it to the person", () => {
    for (const event of ["Elicitation", "ElicitationResult"]) {
      expect(
        json(event, {
          hookSpecificOutput: { hookEventName: event, action: "accept", content: { a: 1 } },
        }),
      ).toMatchObject({
        outcome: "success",
        decision: "allow",
        elicitation: { action: "accept", content: { a: 1 } },
      });
      expect(
        json(event, { hookSpecificOutput: { action: "decline", content: { a: 1 } } }),
      ).toMatchObject({
        outcome: "blocked",
        elicitation: { action: "decline", content: null },
      });
      expect(json(event, { hookSpecificOutput: { action: "cancel" } })).toMatchObject({
        decision: null,
        elicitation: { action: "cancel" },
      });
      expect(interpretRun(event, handler(), run({ stdout: "" }))).toMatchObject({
        outcome: "success",
        elicitation: null,
      });
    }
  });

  it("exit 2 and a top-level block decline, ignoring the hook's action; reason and systemMessage are discarded", () => {
    for (const event of ["Elicitation", "ElicitationResult"]) {
      const accept = JSON.stringify({
        hookSpecificOutput: { action: "accept", content: { a: 1 } },
      });
      expect(
        interpretRun(event, handler(), run({ exitCode: 2, stdout: accept, stderr: "no" })),
      ).toMatchObject({ outcome: "blocked", decision: "block", elicitation: null, message: null });
      expect(
        json(event, {
          decision: "block",
          reason: "secret",
          systemMessage: "x",
          continue: false,
          hookSpecificOutput: { action: "accept", content: { a: 1 } },
        }),
      ).toMatchObject({
        decision: "block",
        elicitation: null,
        reason: null,
        systemMessage: null,
        stop: null,
        message: null,
      });
      // A failure with onFailure block declines too.
      expect(
        interpretRun(event, handler({ onFailure: "block" }), run({ exitCode: 1 })),
      ).toMatchObject({ outcome: "blocked", decision: "block" });
    }
  });
});

describe("other handler types", () => {
  const out = (from: "http" | "mcp_tool", text: string): HandlerRun => ({
    kind: "output",
    from,
    text,
    durationMs: 5,
  });
  const verdict = (ok: boolean, reason: string | null = null, impossible = false): HandlerRun => ({
    kind: "verdict",
    ok,
    reason,
    impossible,
    durationMs: 5,
  });
  const http = handler({ type: "http", command: null, url: "http://localhost/x" });
  const mcp = handler({ type: "mcp_tool", command: null, server: "s", tool: "t" });
  const prompt = handler({ type: "prompt", command: null, prompt: "x" });
  const agent = handler({ type: "agent", command: null, prompt: "x" });

  it("http: an empty 2xx is success, a JSON body decides, other text is an error", () => {
    expect(interpretHandler("PreToolUse", http, out("http", ""))).toMatchObject({
      outcome: "success",
      decision: null,
      exitCode: null,
    });
    expect(
      interpretHandler(
        "PreToolUse",
        http,
        out(
          "http",
          JSON.stringify({
            hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "No" },
          }),
        ),
      ),
    ).toMatchObject({ outcome: "blocked", decision: "deny", reason: "No" });
    expect(interpretHandler("UserPromptSubmit", http, out("http", "Some context"))).toMatchObject({
      outcome: "error",
      context: [],
    });
    expect(interpretHandler("PreToolUse", http, out("http", "{ nope"))).toMatchObject({
      outcome: "error",
    });
  });

  it("a failed request is non-blocking unless onFailure blocks", () => {
    const failed: HandlerRun = {
      kind: "failed",
      outcome: "error",
      detail: "It answered with status 500.",
      durationMs: 3,
    };
    expect(interpretHandler("PreToolUse", http, failed)).toMatchObject({
      outcome: "error",
      decision: null,
      message: "It answered with status 500.",
    });
    expect(interpretHandler("PreToolUse", { ...http, onFailure: "block" }, failed)).toMatchObject({
      outcome: "blocked",
      decision: "deny",
    });
    expect(
      interpretHandler("PreToolUse", http, {
        kind: "failed",
        outcome: "timeout",
        detail: "slow",
        durationMs: 9,
      }),
    ).toMatchObject({ outcome: "timeout" });
  });

  it("mcp_tool: the text is read like standard output; with onFailure block plain text is a failure", () => {
    expect(
      interpretHandler("UserPromptSubmit", mcp, out("mcp_tool", "Branch: main")),
    ).toMatchObject({
      outcome: "success",
      context: ["Branch: main"],
    });
    const blocking = { ...mcp, onFailure: "block" as const };
    expect(interpretHandler("PreToolUse", blocking, out("mcp_tool", "looks risky"))).toMatchObject({
      outcome: "blocked",
      decision: "deny",
    });
    expect(interpretHandler("PreToolUse", blocking, out("mcp_tool", "{}"))).toMatchObject({
      outcome: "success",
    });
    expect(
      interpretHandler("PreToolUse", blocking, out("mcp_tool", JSON.stringify({ reason: "x" }))),
    ).toMatchObject({
      outcome: "blocked",
    });
  });

  it("prompt and agent: ok decides per event, as the response schema says", () => {
    // ok: true lets the action go on; on PermissionRequest it grants it.
    expect(interpretHandler("PreToolUse", prompt, verdict(true))).toMatchObject({
      decision: null,
      stop: null,
    });
    expect(interpretHandler("PermissionRequest", prompt, verdict(true))).toMatchObject({
      decision: "allow",
    });
    // Stop: the reason keeps the turn going, unless impossible.
    expect(interpretHandler("Stop", prompt, verdict(false, "Tests fail"))).toMatchObject({
      decision: "block",
      reason: "Tests fail",
    });
    expect(interpretHandler("Stop", prompt, verdict(false, "Cannot", true))).toMatchObject({
      decision: null,
    });
    // An agent hook ignores impossible.
    expect(interpretHandler("Stop", agent, verdict(false, "Cannot", true))).toMatchObject({
      decision: "block",
    });
    // PreToolUse: denied, and the turn ends unless the reason goes back (continueOnBlock, agent).
    expect(interpretHandler("PreToolUse", prompt, verdict(false, "Reads .env"))).toMatchObject({
      decision: "deny",
      stop: { reason: "Reads .env" },
    });
    expect(
      interpretHandler(
        "PreToolUse",
        { ...prompt, continueOnBlock: true },
        verdict(false, "Reads .env"),
      ),
    ).toMatchObject({ decision: "deny", stop: null });
    expect(interpretHandler("PreToolUse", agent, verdict(false, "Reads .env"))).toMatchObject({
      decision: "deny",
      stop: null,
    });
    // PostToolUse: the turn ends by default; continueOnBlock feeds the reason back.
    expect(interpretHandler("PostToolUse", prompt, verdict(false, "Lint fails"))).toMatchObject({
      decision: null,
      stop: { reason: "Lint fails" },
    });
    expect(
      interpretHandler(
        "PostToolUse",
        { ...prompt, continueOnBlock: true },
        verdict(false, "Lint fails"),
      ),
    ).toMatchObject({ decision: "block", stop: null });
    // UserPromptSubmit refuses the prompt; PostToolUseFailure tells the model.
    expect(
      interpretHandler("UserPromptSubmit", prompt, verdict(false, "No secrets")),
    ).toMatchObject({
      decision: "block",
    });
    expect(
      interpretHandler("PostToolUseFailure", prompt, verdict(false, "Try again")),
    ).toMatchObject({
      decision: "block",
    });
    // PermissionRequest: ok false does not deny.
    expect(interpretHandler("PermissionRequest", prompt, verdict(false, "Unsure"))).toMatchObject({
      decision: null,
      message: "Unsure",
    });
  });
});
