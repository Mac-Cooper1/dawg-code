// biome-ignore-all lint/suspicious/noTemplateCurlyInString: hook definitions write ${VAR} and ${path} literally, as the hooks reference does
/**
 * Tier 2 hooks and the other handler types in whole sessions, against the scripted engine
 * (Phase 4 spec, Testing → Integration): PermissionRequest answering a prompt (allowing with a
 * new input, denying with interrupt), never running when a rule decided, and in a run nobody can
 * answer; PostToolUseFailure on a failing call; PreCompact and PostCompact around manual and
 * automatic compaction; and prompt, agent and mcp_tool hooks on the session's own model, its
 * subagents and a test MCP server.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { text, toolCall } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { TEST_SERVER } from "../mcp/__fixtures__/servers.ts";
import { createPromptAssembler } from "../prompt/assembler.ts";
import { fakeCompactor } from "../runtime/__fixtures__/fakes.ts";
import {
  type Harness,
  type HarnessOptions,
  startHarness,
} from "../runtime/__fixtures__/harness.ts";
import type { Engine } from "../runtime/engine.ts";
import type { SessionRuntime } from "../runtime/session.ts";
import type { EngineOptions } from "../runtime/types.ts";
import { createTrustStore, type TrustStore } from "../trust/store.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const settings = (hooks: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ hooks, ...extra });
const command = (cmd: string, extra: Record<string, unknown> = {}) => ({
  type: "command",
  command: cmd,
  ...extra,
});
/** A command that prints `value` as JSON and saves its input to `file`. */
const answer = (value: unknown, file?: string) =>
  `${file === undefined ? "" : `cat > '${file}'; `}echo '${JSON.stringify(value)}'`;

interface Setup {
  h: Harness;
  engine: Engine;
  trust: TrustStore;
  approve(): Promise<void>;
  /** The JSON a hook saved with `answer(…, file)`. */
  saved(file: string): Promise<Record<string, unknown>>;
}

async function setup(options: {
  files?: Record<string, string>;
  home?: Record<string, unknown>;
  script: HarnessOptions["script"];
  engine?: Partial<EngineOptions>;
  mock?: HarnessOptions["mock"];
}): Promise<Setup> {
  h = await startHarness({
    files: options.files ?? {},
    script: options.script,
    ...(options.mock === undefined ? {} : { mock: options.mock }),
    ...(options.engine === undefined ? {} : { engine: options.engine }),
  });
  const harness = h;
  for (const [rel, content] of Object.entries(options.home ?? {})) {
    const file = path.join(harness.home, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
  }
  const trust = createTrustStore({ storeRoot: harness.storeRoot, homeDir: harness.home });
  return {
    h: harness,
    engine: harness.newEngine({ trust, ...options.engine }),
    trust,
    approve: async () => {
      const approval = await trust.approval(harness.project);
      if (approval !== null) await trust.decide(harness.project, approval.hash, true);
    },
    saved: async (file) => JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>,
  };
}

/** Answers every permission prompt with `behavior`, and keeps the tool names asked about. */
function answerPrompts(session: SessionRuntime, behavior: "allow" | "deny" = "allow"): string[] {
  const asked: string[] = [];
  session.subscribe((event) => {
    if (event.event !== "permission.requested") return;
    const request = event.payload.request as {
      requestId: string;
      toolName: string;
      input: unknown;
    };
    asked.push(`${request.toolName} ${JSON.stringify(request.input)}`);
    setImmediate(() =>
      session.respondPermission(
        request.requestId,
        behavior === "allow" ? { behavior, scope: "once" } : { behavior },
      ),
    );
  });
  return asked;
}

function finished(s: Setup, sessionId: string) {
  return s.h.ofType(sessionId, "tool.finished").map((e) => ({
    outcome: e.payload.outcome as string,
    text: JSON.stringify(e.payload.content),
  }));
}

describe("PermissionRequest", () => {
  it("answers the prompt instead of the person: allow with a new input, judged again by the rules", async () => {
    const input = path.join("/tmp", `dawg-pr-${process.pid}-${Date.now()}.json`);
    const s = await setup({
      files: {
        ".claude/settings.json": settings({
          PermissionRequest: [
            {
              matcher: "Bash",
              hooks: [
                command(
                  answer(
                    {
                      hookSpecificOutput: {
                        hookEventName: "PermissionRequest",
                        decision: {
                          behavior: "allow",
                          updatedInput: { command: "echo cleaned" },
                          updatedPermissions: [
                            {
                              type: "addRules",
                              rules: [{ toolName: "Bash", ruleContent: "rm -rf build" }],
                              behavior: "allow",
                              destination: "session",
                            },
                          ],
                        },
                      },
                    },
                    input,
                  ),
                ),
              ],
            },
          ],
        }),
      },
      script: [
        toolCall("Bash", { command: "rm -rf node_modules", description: "Clean" }, { id: "b1" }),
        toolCall("Bash", { command: "rm -rf build", description: "Clean the build" }, { id: "b2" }),
        text("Cleaned."),
      ],
    });
    await s.approve();
    const session = await s.engine.createSession({ cwd: s.h.project });
    const asked = answerPrompts(session);
    await session.run(ask("clean up"));
    // No prompt: the hook answered the first; the rule it added allowed the second.
    expect(asked).toEqual([]);
    const results = finished(s, session.id);
    expect(results[0]).toMatchObject({ outcome: "success" });
    expect(results[0]?.text).toContain("cleaned");
    const ran = s.h.ofType(session.id, "hook.ran");
    expect(ran).toHaveLength(1);
    expect(ran[0]?.payload).toMatchObject({
      toolCallId: "b1",
      decision: "allow",
      outcome: "success",
      hook: { event: "PermissionRequest", matcher: "Bash" },
    });
    const sent = await s.saved(input);
    expect(sent).toMatchObject({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "rm -rf node_modules", description: "Clean" },
    });
    expect(sent.tool_use_id).toBeUndefined();
  });

  it("denies with a message for the model, and interrupt ends the turn", async () => {
    const s = await setup({
      home: {
        ".dawg/settings.json": settings({
          PermissionRequest: [
            {
              hooks: [
                command(
                  answer({
                    hookSpecificOutput: {
                      hookEventName: "PermissionRequest",
                      decision: { behavior: "deny", message: "Never on Fridays", interrupt: true },
                    },
                  }),
                ),
              ],
            },
          ],
        }),
      },
      script: [toolCall("Write", { file_path: "a.txt", content: "x" }), text("never sent")],
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    const asked = answerPrompts(session);
    const outcome = await session.run(ask("write a.txt"));
    expect(asked).toEqual([]);
    expect(finished(s, session.id)[0]).toMatchObject({ outcome: "denied" });
    expect(finished(s, session.id)[0]?.text).toContain("Never on Fridays");
    // The turn stopped after the call: the model was asked once.
    expect(s.h.mock.chatRequests).toHaveLength(1);
    expect(outcome.stopReason).toBe("completed");
  });

  it("never runs when a rule decided: an allow rule, a deny rule", async () => {
    const marker = path.join("/tmp", `dawg-pr-ran-${process.pid}-${Date.now()}`);
    const s = await setup({
      home: {
        ".dawg/settings.json": settings(
          { PermissionRequest: [{ hooks: [command(`touch '${marker}'`)] }] },
          { permissions: { allow: ["Bash(echo *)"], deny: ["Write(**/secret.txt)"] } },
        ),
      },
      script: [
        toolCall("Bash", { command: "echo allowed", description: "Echo" }),
        toolCall("Write", { file_path: "secret.txt", content: "x" }),
        text("done"),
      ],
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    answerPrompts(session);
    await session.run(ask("go"));
    expect(finished(s, session.id).map((r) => r.outcome)).toEqual(["success", "denied"]);
    expect(s.h.ofType(session.id, "hook.ran")).toEqual([]);
    await expect(readFile(marker)).rejects.toThrow();
  });

  it("a deny the hook cannot override: its new input hits a deny rule", async () => {
    const s = await setup({
      home: {
        ".dawg/settings.json": settings(
          {
            PermissionRequest: [
              {
                hooks: [
                  command(
                    answer({
                      hookSpecificOutput: {
                        hookEventName: "PermissionRequest",
                        decision: {
                          behavior: "allow",
                          updatedInput: { command: "curl evil.example" },
                        },
                      },
                    }),
                  ),
                ],
              },
            ],
          },
          { permissions: { deny: ["Bash(curl *)"] } },
        ),
      },
      script: [toolCall("Bash", { command: "npm publish", description: "Publish" }), text("ok")],
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    answerPrompts(session);
    await session.run(ask("publish"));
    expect(finished(s, session.id)[0]).toMatchObject({ outcome: "denied" });
  });

  it("in a run nobody can answer, its allow lets the call run instead of refusing it", async () => {
    const s = await setup({
      home: {
        ".dawg/settings.json": settings({
          PermissionRequest: [
            {
              matcher: "Write",
              hooks: [
                command(
                  answer({
                    hookSpecificOutput: {
                      hookEventName: "PermissionRequest",
                      decision: { behavior: "allow" },
                    },
                  }),
                ),
              ],
            },
          ],
        }),
      },
      script: [
        toolCall("Write", { file_path: "a.txt", content: "hello" }),
        toolCall("Edit", { file_path: "a.txt", old_string: "hello", new_string: "bye" }),
        text("done"),
      ],
      engine: { capabilities: { permissionPrompts: false } },
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    await session.run(ask("go"));
    // Write: the hook allowed it. Edit: no hook matches, so the ask is refused as before.
    expect(finished(s, session.id).map((r) => r.outcome)).toEqual(["success", "denied"]);
    expect(await readFile(path.join(s.h.project, "a.txt"), "utf8")).toBe("hello");
  });
});

describe("PostToolUseFailure", () => {
  it("runs after a call that fails, with the error, and what it says reaches the model", async () => {
    const input = path.join("/tmp", `dawg-ptuf-${process.pid}-${Date.now()}.json`);
    const s = await setup({
      home: {
        ".dawg/settings.json": settings(
          {
            PostToolUseFailure: [
              {
                matcher: "Bash",
                hooks: [
                  command(
                    answer(
                      {
                        hookSpecificOutput: {
                          hookEventName: "PostToolUseFailure",
                          additionalContext: "Run npm install first",
                        },
                      },
                      input,
                    ),
                  ),
                ],
              },
            ],
            PostToolUse: [{ hooks: [command("exit 0")] }],
          },
          { permissions: { allow: ["Bash"] } },
        ),
      },
      script: [
        toolCall(
          "Bash",
          { command: "echo missing module; exit 3", description: "Test" },
          { id: "f1" },
        ),
        toolCall("Bash", { command: "echo fine", description: "Echo" }, { id: "f2" }),
        text("ok"),
      ],
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    await session.run(ask("test"));
    const sent = await s.saved(input);
    expect(sent).toMatchObject({
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_use_id: "f1",
      is_interrupt: false,
    });
    expect(String(sent.error)).toMatch(/^Exit code 3\nmissing module/);
    expect(typeof sent.duration_ms).toBe("number");
    // Only the failed call ran the failure hook; the PostToolUse hook ran for the other.
    const events = s.h
      .ofType(session.id, "hook.ran")
      .map((e) => [(e.payload.hook as { event: string }).event, e.payload.toolCallId]);
    expect(events).toEqual([
      ["PostToolUseFailure", "f1"],
      ["PostToolUse", "f2"],
    ]);
    expect(JSON.stringify(s.h.mock.messages(1))).toContain("Run npm install first");
  });

  it("does not run for a call the person stopped", async () => {
    const marker = path.join("/tmp", `dawg-ptuf-stop-${process.pid}-${Date.now()}`);
    const s = await setup({
      home: {
        ".dawg/settings.json": settings(
          { PostToolUseFailure: [{ hooks: [command(`touch '${marker}'`)] }] },
          { permissions: { allow: ["Bash"] } },
        ),
      },
      script: [toolCall("Bash", { command: "sleep 5", description: "Wait" }), text("never")],
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    const done = session.run(ask("wait"));
    await s.h.waitFor((e) => e.event === "tool.started");
    await new Promise((r) => setTimeout(r, 200));
    session.interrupt();
    await done;
    await expect(readFile(marker)).rejects.toThrow();
  });
});

describe("PreCompact and PostCompact", () => {
  it("manual: get the trigger and focus, add instructions, then the summary", async () => {
    const pre = path.join("/tmp", `dawg-precompact-${process.pid}-${Date.now()}.json`);
    const post = path.join("/tmp", `dawg-postcompact-${process.pid}-${Date.now()}.json`);
    const compactor = fakeCompactor();
    const s = await setup({
      home: {
        ".dawg/settings.json": settings({
          PreCompact: [
            {
              matcher: "manual",
              hooks: [command(`cat > '${pre}'; echo 'Keep the open bugs list.'`)],
            },
          ],
          PostCompact: [{ matcher: "manual", hooks: [command(`cat > '${post}'`)] }],
        }),
      },
      script: [text("hello")],
      engine: { compactor },
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    await session.run(ask("hi"));
    const outcome = await session.compact("the auth work");
    expect(outcome.outcome).toBe("completed");
    expect(await s.saved(pre)).toMatchObject({
      hook_event_name: "PreCompact",
      trigger: "manual",
      custom_instructions: "the auth work",
    });
    expect(compactor.calls[0]?.focus).toBe("the auth work\n\nKeep the open bugs list.");
    expect(await s.saved(post)).toMatchObject({
      hook_event_name: "PostCompact",
      trigger: "manual",
      compact_summary: outcome.summary,
    });
    // The compaction's own record keeps the person's focus as they gave it.
    expect(s.h.ofType(session.id, "compaction.started")[0]?.payload.focus).toBe("the auth work");
  });

  it("manual: a PreCompact block stops it, and says why", async () => {
    const compactor = fakeCompactor();
    const s = await setup({
      home: {
        ".dawg/settings.json": settings({
          PreCompact: [{ hooks: [command("echo 'A deploy is running' >&2; exit 2")] }],
          PostCompact: [{ hooks: [command("exit 0")] }],
        }),
      },
      script: [text("hello")],
      engine: { compactor },
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    await session.run(ask("hi"));
    const outcome = await session.compact(null);
    expect(outcome.outcome).toBe("failed");
    expect(outcome.error?.message).toContain("A deploy is running");
    expect(compactor.calls).toHaveLength(0);
    expect(s.h.ofType(session.id, "compaction.finished")[0]?.payload).toMatchObject({
      outcome: "failed",
      error: { message: expect.stringContaining("PreCompact hook blocked") },
    });
    const events = s.h
      .ofType(session.id, "hook.ran")
      .map((e) => (e.payload.hook as { event: string }).event);
    expect(events).toEqual(["PreCompact"]);
  });

  it("auto: matched by the auto trigger; a block skips it and the turn goes on", async () => {
    const pre = path.join("/tmp", `dawg-precompact-auto-${process.pid}-${Date.now()}.json`);
    const run = async (block: boolean) => {
      const compactor = fakeCompactor();
      const s = await setup({
        home: {
          ".dawg/settings.json": settings({
            PreCompact: [
              {
                matcher: "auto",
                hooks: [command(block ? `cat > '${pre}'; exit 2` : `cat > '${pre}'`)],
              },
            ],
            PostCompact: [{ matcher: "auto", hooks: [command("exit 0")] }],
          }),
        },
        engine: { compactor },
        mock: { contextWindow: 16_000 },
        files: { "big.txt": `${"x".repeat(80)}\n`.repeat(750) },
        script: [toolCall("Read", { file_path: "big.txt" }), text("read it")],
      });
      const session = await s.engine.createSession({ cwd: s.h.project });
      const outcome = await session.run(ask("read big.txt"));
      const events = s.h
        .ofType(session.id, "hook.ran")
        .map((e) => (e.payload.hook as { event: string }).event);
      const input = await s.saved(pre);
      await h?.close();
      h = null;
      return { outcome, compactor, events, input };
    };
    const compacted = await run(false);
    expect(compacted.outcome.stopReason).toBe("completed");
    expect(compacted.compactor.calls).toHaveLength(1);
    expect(compacted.input).toMatchObject({ trigger: "auto", custom_instructions: null });
    expect(compacted.events).toEqual(["PreCompact", "PostCompact"]);
    const blocked = await run(true);
    expect(blocked.outcome).toMatchObject({ stopReason: "completed", finalText: "read it" });
    expect(blocked.compactor.calls).toHaveLength(0);
    expect(blocked.events).toEqual(["PreCompact"]);
  });
});

describe("prompt, agent and mcp_tool hooks in a session", () => {
  it("a prompt hook on Stop asks the session's model, and its reason keeps the turn going", async () => {
    const s = await setup({
      home: {
        ".dawg/settings.json": settings({
          Stop: [
            {
              hooks: [
                {
                  type: "prompt",
                  prompt: "Did it update the changelog? $ARGUMENTS",
                  model: "haiku",
                },
              ],
            },
          ],
        }),
      },
      script: {
        replies: [text("All done."), text("Changelog updated too.")],
        lanes: {
          check: {
            match: { system: "You check one event in a coding session for a hook" },
            replies: [
              { text: '{"ok": false, "reason": "Update CHANGELOG.md before you stop"}' },
              { text: '{"ok": true}' },
            ],
          },
        },
      },
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    const outcome = await session.run(ask("ship it"));
    expect(outcome.finalText).toBe("Changelog updated too.");
    const checks = s.h.mock.chatRequests.filter((r) =>
      JSON.stringify(r.body).includes("You check one event in a coding session"),
    );
    expect(checks).toHaveLength(2);
    expect(JSON.stringify(checks[0]?.body)).toContain("Did it update the changelog?");
    expect(JSON.stringify(checks[0]?.body)).toContain("last_assistant_message");
    // The model was told why it should keep going.
    const main = s.h.mock.chatRequests.filter((r) => !checks.includes(r));
    expect(main).toHaveLength(2);
    expect(JSON.stringify(main[1]?.body)).toContain("Update CHANGELOG.md before you stop");
    const ran = s.h.ofType(session.id, "hook.ran").map((e) => e.payload);
    expect(ran.map((r) => [r.outcome, r.decision])).toEqual([
      ["blocked", "block"],
      ["success", null],
    ]);
  });

  it("an agent hook runs a read-only subagent on a slot, and its verdict decides", async () => {
    const s = await setup({
      home: {
        ".dawg/settings.json": settings(
          {
            PreToolUse: [
              {
                matcher: "Write",
                hooks: [{ type: "agent", prompt: "Check that NOTES.md allows writing $ARGUMENTS" }],
              },
            ],
          },
          { permissions: { allow: ["Write"] } },
        ),
      },
      files: { "NOTES.md": "Do not write out.txt\n" },
      script: {
        replies: [
          toolCall("Write", { file_path: "out.txt", content: "x" }),
          text("I was stopped."),
        ],
        lanes: {
          hook: {
            match: { system: "You check one condition for a hook" },
            replies: [
              { toolCalls: [{ name: "Read", arguments: { file_path: "NOTES.md" } }] },
              { text: '{"ok": false, "reason": "NOTES.md says not to write out.txt"}' },
            ],
          },
        },
      },
      engine: { subagents: true, assembler: createPromptAssembler() },
      mock: { contextWindow: 200_000 },
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    await session.run(ask("write out.txt"));
    expect(finished(s, session.id)[0]).toMatchObject({ outcome: "denied" });
    expect(finished(s, session.id)[0]?.text).toContain("NOTES.md says not to write out.txt");
    await expect(readFile(path.join(s.h.project, "out.txt"))).rejects.toThrow();
    // It ran as a subagent of the session, shown with the call it checked.
    const agents = s.h.ofType(session.id, "subagent.updated").map(
      (e) =>
        (
          e.payload as unknown as {
            agent: { agentType: string; status: string; toolCallId: string | null };
          }
        ).agent,
    );
    expect(agents.at(-1)).toMatchObject({ agentType: "hook", status: "completed" });
    expect(agents.at(-1)?.toolCallId).toBe(
      s.h.ofType(session.id, "tool.finished")[0]?.payload.toolCallId,
    );
  });

  it("an mcp_tool hook calls a tool of a connected server with the substituted input", async () => {
    const s = await setup({
      home: {
        ".dawg/mcp.json": {
          mcpServers: { test: { command: process.execPath, args: [TEST_SERVER] } },
        },
        ".dawg/settings.json": settings({
          UserPromptSubmit: [
            {
              hooks: [
                { type: "mcp_tool", server: "test", tool: "echo", input: { text: "${prompt}" } },
              ],
            },
          ],
        }),
      },
      script: [text("ok")],
      engine: { mcp: { restartDelaysMs: [50], lingerMs: 0, connectTimeoutMs: 10_000 } },
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    await session.run(ask("release notes"));
    const ran = s.h.ofType(session.id, "hook.ran")[0]?.payload;
    expect(ran).toMatchObject({
      outcome: "success",
      hook: { type: "mcp_tool", command: "test echo" },
    });
    expect(JSON.stringify(s.h.mock.messages(0))).toContain("echo: release notes");
  });

  it("a project's hooks of every type wait for consent in a session", async () => {
    const s = await setup({
      files: {
        ".claude/settings.json": settings({
          UserPromptSubmit: [
            {
              hooks: [
                { type: "http", url: "http://127.0.0.1:9/never" },
                { type: "prompt", prompt: "never" },
                { type: "agent", prompt: "never" },
                { type: "mcp_tool", server: "x", tool: "y" },
              ],
            },
          ],
        }),
      },
      script: [text("ok")],
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    await session.run(ask("hi"));
    expect(s.h.ofType(session.id, "hook.ran")).toEqual([]);
    expect(s.h.ofType(session.id, "hook.skipped")).toHaveLength(1);
    expect(s.h.mock.chatRequests).toHaveLength(1);
  });
});
