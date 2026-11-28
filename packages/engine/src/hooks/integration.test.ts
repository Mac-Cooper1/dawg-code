/**
 * Hooks against the scripted engine (Phase 4 spec, Testing → Integration and Security): a
 * PreToolUse block, a changed input, added context, Stop keeping the turn going, a refused
 * prompt, the permission engine's answer to a hook's decision, and consent.
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { text, toolCall } from "@dawg/mock-model";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness, textOf } from "../runtime/__fixtures__/harness.ts";
import type { Engine } from "../runtime/engine.ts";
import type { EngineOptions } from "../runtime/types.ts";
import { createTrustStore, type TrustStore } from "../trust/store.ts";

let h: Harness | null = null;
afterEach(async () => {
  expect(h?.problems ?? []).toEqual([]);
  await h?.close();
  h = null;
});

const ask = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

/** A hook script that blocks `rm` (the hooks guide's example), written into the project. */
const BLOCK_RM = `#!/bin/sh
input=$(cat)
case "$input" in
  *'"command":"rm '*) echo "rm is not allowed in this project" >&2; exit 2 ;;
esac
exit 0
`;

interface Setup {
  h: Harness;
  engine: Engine;
  trust: TrustStore;
  /** Approves what the project defines now. */
  approve(): Promise<void>;
}

async function setup(options: {
  files?: Record<string, string>;
  script: Parameters<typeof startHarness>[0] extends infer O
    ? O extends { script?: infer S }
      ? S
      : never
    : never;
  home?: Record<string, unknown>;
  engine?: Partial<EngineOptions>;
}): Promise<Setup> {
  h = await startHarness({ files: options.files ?? {}, script: options.script });
  const harness = h;
  for (const [rel, content] of Object.entries(options.home ?? {})) {
    const file = path.join(harness.home, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
  }
  const trust = createTrustStore({ storeRoot: harness.storeRoot, homeDir: harness.home });
  const engine = harness.newEngine({ trust, ...options.engine });
  return {
    h: harness,
    engine,
    trust,
    approve: async () => {
      const approval = await trust.approval(harness.project);
      if (approval !== null) await trust.decide(harness.project, approval.hash, true);
    },
  };
}

const settings = (hooks: Record<string, unknown>) => JSON.stringify({ hooks });
const command = (cmd: string) => ({ type: "command", command: cmd });
const json = (value: unknown) => `echo '${JSON.stringify(value)}'`;

describe("hooks in a session", () => {
  it("a PreToolUse hook blocks a Bash call, and the model is told why", async () => {
    const s = await setup({
      files: {
        ".claude/settings.json": settings({
          PreToolUse: [{ matcher: "Bash", hooks: [command(".claude/hooks/block-rm.sh")] }],
        }),
        ".claude/hooks/block-rm.sh": BLOCK_RM,
        "keep.txt": "precious\n",
      },
      script: [toolCall("Bash", { command: "rm keep.txt" }), text("I could not remove it.")],
      engine: { settingsFlags: { allowedTools: ["Bash"] } },
    });
    const { chmod } = await import("node:fs/promises");
    await chmod(path.join(s.h.project, ".claude", "hooks", "block-rm.sh"), 0o755);
    await s.approve();
    const session = await s.engine.createSession({ cwd: s.h.project });
    await session.run(ask("remove keep.txt"));
    expect(await exists(path.join(s.h.project, "keep.txt"))).toBe(true);
    const finished = s.h.ofType(session.id, "tool.finished")[0];
    expect(finished?.payload).toMatchObject({ outcome: "denied" });
    expect(JSON.stringify(finished?.payload.content)).toContain(
      "rm is not allowed in this project",
    );
    const [hookRan] = s.h.ofType(session.id, "hook.ran");
    expect(hookRan?.payload).toMatchObject({
      outcome: "blocked",
      decision: "deny",
      exitCode: 2,
      message: "rm is not allowed in this project",
      toolCallId: finished?.payload.toolCallId,
      hook: { event: "PreToolUse", matcher: "Bash", command: ".claude/hooks/block-rm.sh" },
    });
    // Announced after the call's start and before its result.
    const names = s.h.names(session.id);
    expect(names.indexOf("hook.ran")).toBeGreaterThan(names.indexOf("tool.started"));
    expect(names.indexOf("hook.ran")).toBeLessThan(names.indexOf("tool.finished"));
  });

  it("a PreToolUse hook changes the call's input, and permission rules judge the new one", async () => {
    const s = await setup({
      home: {
        ".dawg/settings.json": settings({
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                command(
                  json({
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "allow",
                      updatedInput: { command: "echo rewritten" },
                    },
                  }),
                ),
              ],
            },
          ],
        }),
      },
      script: [toolCall("Bash", { command: "echo original" }), text("ok")],
      engine: { capabilities: { permissionPrompts: false } },
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    await session.run(ask("echo"));
    const finished = s.h.ofType(session.id, "tool.finished")[0];
    // Allowed by the hook with nobody to ask, and run with the new input.
    expect(finished?.payload.outcome).toBe("success");
    expect(JSON.stringify(finished?.payload.content)).toContain("rewritten");
    expect(JSON.stringify(finished?.payload.content)).not.toContain("original");
  });

  it("a hook's allow skips the prompt but not a deny rule, and its ask forces one", async () => {
    const allowAll = command(
      json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }),
    );
    const s = await setup({
      home: {
        ".dawg/settings.json": JSON.stringify({
          permissions: { deny: ["Write(**/denied.txt)"], allow: ["Read"] },
          hooks: {
            PreToolUse: [
              { matcher: "Write", hooks: [allowAll] },
              {
                matcher: "Read",
                hooks: [
                  command(
                    json({
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "ask",
                        permissionDecisionReason: "Reads are audited here",
                      },
                    }),
                  ),
                ],
              },
            ],
          },
        }),
      },
      files: { "notes.txt": "hello\n" },
      script: [
        toolCall("Write", { file_path: "allowed.txt", content: "x\n" }),
        toolCall("Write", { file_path: "denied.txt", content: "x\n" }, { id: "w2" }),
        toolCall("Read", { file_path: "notes.txt" }, { id: "r1" }),
        text("done"),
      ],
    });
    // Write needs a prompt in default mode; the hook's allow skips it.
    const session = await s.engine.createSession({ cwd: s.h.project });
    const asked: string[] = [];
    session.subscribe((event) => {
      if (event.event !== "permission.requested") return;
      const request = event.payload.request as {
        requestId: string;
        toolName: string;
        reason: string;
      };
      asked.push(`${request.toolName}: ${request.reason}`);
      setImmediate(() =>
        session.respondPermission(request.requestId, { behavior: "allow", scope: "once" }),
      );
    });
    await session.run(ask("go"));
    const outcomes = s.h.ofType(session.id, "tool.finished").map((e) => e.payload.outcome);
    expect(outcomes).toEqual(["success", "denied", "success"]);
    expect(asked).toEqual([
      expect.stringMatching(/^Read: A PreToolUse hook asks you to confirm: Reads are audited here/),
    ]);
  });

  it("adds context from SessionStart, UserPromptSubmit and PostToolUse to what the model reads", async () => {
    const s = await setup({
      home: {
        ".dawg/settings.json": settings({
          SessionStart: [
            { matcher: "startup", hooks: [command("echo 'Current branch: feat/auth'")] },
          ],
          UserPromptSubmit: [{ hooks: [command("echo 'Ticket: AUTH-12'")] }],
          PostToolUse: [
            {
              matcher: "Read",
              hooks: [
                command(
                  json({
                    hookSpecificOutput: {
                      hookEventName: "PostToolUse",
                      additionalContext: "This file is generated.",
                    },
                  }),
                ),
              ],
            },
          ],
        }),
      },
      files: { "notes.txt": "hello\n" },
      script: [toolCall("Read", { file_path: "notes.txt" }), text("ok")],
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    await session.run(ask("read the notes"));
    const view = session.view.map(textOf);
    const prompt = view.findIndex((t) => t.includes("read the notes"));
    const branch = view.findIndex((t) => t.includes("Current branch: feat/auth"));
    const ticket = view.findIndex((t) => t.includes("Ticket: AUTH-12"));
    const generated = view.findIndex((t) => t.includes("This file is generated."));
    const result = session.view.findIndex((m) => m.role === "tool");
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(prompt);
    expect(ticket).toBe(prompt + 1);
    expect(generated).toBeGreaterThan(result);
  });

  it("a Stop hook keeps the turn going once, using stop_hook_active as its guard", async () => {
    const s = await setup({
      home: {
        ".dawg/settings.json": settings({
          Stop: [
            {
              hooks: [
                command(
                  `grep -q '"stop_hook_active":true' && exit 0; echo 'Run the tests before you finish.' >&2; exit 2`,
                ),
              ],
            },
          ],
        }),
      },
      script: [text("All done."), text("Tests pass. Done.")],
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    const outcome = await session.run(ask("fix it"));
    expect(outcome.stopReason).toBe("completed");
    expect(outcome.finalText).toBe("Tests pass. Done.");
    const view = session.view.map(textOf);
    expect(view.some((t) => t.includes("Run the tests before you finish."))).toBe(true);
    expect(s.h.ofType(session.id, "hook.ran").map((e) => e.payload.outcome)).toEqual([
      "blocked",
      "success",
    ]);
  });

  it("a UserPromptSubmit hook refuses a prompt, which never reaches the transcript", async () => {
    const s = await setup({
      home: {
        ".dawg/settings.json": settings({
          UserPromptSubmit: [
            {
              hooks: [
                command(`grep -q 'API_KEY=' && { echo 'Prompt holds a key' >&2; exit 2; }; exit 0`),
              ],
            },
          ],
        }),
      },
      script: [text("ok")],
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    await expect(session.prompt(ask("use API_KEY=sk-123"))).rejects.toThrow(
      "A UserPromptSubmit hook blocked this prompt: Prompt holds a key",
    );
    expect(session.view.some((m) => textOf(m).includes("sk-123"))).toBe(false);
    expect(session.busy).toBe(false);
    expect(s.h.ofType(session.id, "turn.started")).toHaveLength(0);
    expect(s.h.ofType(session.id, "hook.ran")[0]?.payload).toMatchObject({
      turnId: null,
      outcome: "blocked",
      decision: "block",
    });
    // The next prompt goes through.
    await session.run(ask("hello"));
    expect(s.h.ofType(session.id, "turn.started")).toHaveLength(1);
  });

  it("runs SessionEnd when the session closes, and Notification when a request waits", async () => {
    const s = await setup({
      home: {
        ".dawg/settings.json": settings({
          Notification: [
            {
              matcher: "permission_prompt",
              hooks: [command('cat > "$DAWG_PROJECT_DIR/notified.json"')],
            },
          ],
          SessionEnd: [{ hooks: [command('cat > "$DAWG_PROJECT_DIR/ended.json"')] }],
        }),
      },
      script: [toolCall("Write", { file_path: "a.txt", content: "x\n" }), text("ok")],
      engine: { limits: { permissionNotificationMs: 50 } },
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    const requested = s.h.waitFor((e) => e.event === "permission.requested");
    await session.prompt(ask("write"));
    const event = await requested;
    await s.h.waitFor(
      (e) =>
        e.event === "hook.ran" &&
        (e.payload as unknown as { hook: { event: string } }).hook.event === "Notification",
    );
    session.respondPermission((event.payload.request as { requestId: string }).requestId, {
      behavior: "deny",
    });
    await session.waitForIdle();
    const { readFile } = await import("node:fs/promises");
    expect(
      JSON.parse(await readFile(path.join(s.h.project, "notified.json"), "utf8")),
    ).toMatchObject({
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "dawg needs your permission to use Write",
    });
    await session.close();
    expect(JSON.parse(await readFile(path.join(s.h.project, "ended.json"), "utf8"))).toMatchObject({
      hook_event_name: "SessionEnd",
      reason: "other",
    });
  });

  it("picks up hooks added to the settings from the next turn", async () => {
    const s = await setup({ script: [text("one"), text("two")] });
    const session = await s.engine.createSession({ cwd: s.h.project });
    await session.run(ask("first"));
    await mkdir(path.join(s.h.home, ".dawg"), { recursive: true });
    await writeFile(
      path.join(s.h.home, ".dawg", "settings.json"),
      settings({ UserPromptSubmit: [{ hooks: [command("echo 'Added later'")] }] }),
    );
    await session.run(ask("second"));
    expect(session.view.some((m) => textOf(m).includes("Added later"))).toBe(true);
  });
});

describe("consent in a session", () => {
  it("never runs an unapproved project hook, and tells the client once", async () => {
    const s = await setup({
      files: {
        ".claude/settings.json": settings({
          PreToolUse: [{ hooks: [command('touch "$CLAUDE_PROJECT_DIR/hook-ran"')] }],
          SessionStart: [{ hooks: [command('touch "$CLAUDE_PROJECT_DIR/start-ran"')] }],
        }),
        "notes.txt": "x\n",
      },
      script: [
        toolCall("Read", { file_path: "notes.txt" }),
        toolCall("Read", { file_path: "notes.txt" }, { id: "again" }),
        text("ok"),
      ],
    });
    const session = await s.engine.createSession({ cwd: s.h.project });
    await session.run(ask("read twice"));
    expect(await exists(path.join(s.h.project, "hook-ran"))).toBe(false);
    expect(await exists(path.join(s.h.project, "start-ran"))).toBe(false);
    expect(s.h.ofType(session.id, "hook.ran")).toHaveLength(0);
    expect(s.h.ofType(session.id, "hook.skipped")).toHaveLength(1);
  });

  it("runs nothing from the project with the default (no trust store)", async () => {
    h = await startHarness({
      files: {
        ".dawg/settings.local.json": settings({
          UserPromptSubmit: [{ hooks: [command('touch "$CLAUDE_PROJECT_DIR/ran"')] }],
        }),
      },
      script: [text("ok")],
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("hi"));
    expect(await exists(path.join(h.project, "ran"))).toBe(false);
  });
});
