/**
 * The hook runner with real commands: input on stdin, environment, working directory, parallel
 * runs, identical handlers run once, timeouts, consent and the person's switches.
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventFields } from "../loop/types.ts";
import { hookId } from "../trust/definitions.ts";
import { type CodeTrust, NO_CODE_TRUST } from "../trust/index.ts";
import { createTrustStore } from "../trust/store.ts";
import { SessionHooks, STOP_HOOK_CAP } from "./session-hooks.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Setup {
  root: string;
  home: string;
  project: string;
  store: string;
  events: { event: string; fields: Record<string, unknown> }[];
  notes: string[];
  write(rel: string, content: unknown): Promise<string>;
  hooks(trust?: CodeTrust, env?: Record<string, string>): Promise<SessionHooks>;
}

async function setup(): Promise<Setup> {
  const root = await mkdtemp(path.join(tmpdir(), "dawg-session-hooks-"));
  roots.push(root);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const store = path.join(root, "store");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  const events: Setup["events"] = [];
  const notes: string[] = [];
  return {
    root,
    home,
    project,
    store,
    events,
    notes,
    async write(rel, content) {
      const file = path.join(root, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, typeof content === "string" ? content : JSON.stringify(content), {
        mode: rel.endsWith(".sh") ? 0o755 : 0o644,
      });
      return file;
    },
    async hooks(trust = NO_CODE_TRUST, env = {}) {
      const hooks = new SessionHooks({
        sessionId: "s1",
        cwd: project,
        projectDir: project,
        homeDir: home,
        transcriptPath: path.join(store, "s1.jsonl"),
        trust,
        env: () => env,
        mode: () => "acceptEdits",
        emit: ((event: string, fields: Record<string, unknown>) =>
          events.push({ event, fields })) as never,
        queueNote: (text) => notes.push(text),
        now: Date.now,
      });
      await hooks.reload();
      return hooks;
    },
  };
}

const settings = (hooks: Record<string, unknown>) => ({ hooks });
const cmd = (command: string, extra: Record<string, unknown> = {}) => ({
  type: "command",
  command,
  ...extra,
});
const signal = () => new AbortController().signal;
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

function ran(s: Setup): EventFields<"hook.ran">[] {
  return s.events.filter((e) => e.event === "hook.ran").map((e) => e.fields as never);
}

describe("running hooks", () => {
  it("gives the documented input on stdin, the environment, and the project as working directory", async () => {
    const s = await setup();
    const out = path.join(s.root, "seen.json");
    await s.write(
      "home/.dawg/settings.json",
      settings({
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              cmd(
                `cat > ${out}; printf '%s|%s|%s|%s' "$CLAUDE_PROJECT_DIR" "$DAWG_PROJECT_DIR" "$PWD" "$FROM_SETTINGS" > ${out}.env`,
              ),
            ],
          },
        ],
      }),
    );
    const hooks = await s.hooks(NO_CODE_TRUST, { FROM_SETTINGS: "yes" });
    const verdict = await hooks.preToolUse({
      turnId: "t1",
      toolCallId: "c1",
      toolName: "Bash",
      toolInput: { command: "npm test" },
      signal: signal(),
    });
    expect(verdict.decision).toBeNull();
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual({
      session_id: "s1",
      transcript_path: path.join(s.store, "s1.jsonl"),
      cwd: s.project,
      permission_mode: "acceptEdits",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_use_id: "c1",
    });
    const [projectDir, dawgDir, pwd, fromSettings] = (await readFile(`${out}.env`, "utf8")).split(
      "|",
    );
    expect(projectDir).toBe(s.project);
    expect(dawgDir).toBe(s.project);
    expect(pwd).toBe(s.project);
    expect(fromSettings).toBe("yes");
    expect(ran(s)).toEqual([
      expect.objectContaining({
        turnId: "t1",
        toolCallId: "c1",
        outcome: "success",
        exitCode: 0,
        decision: null,
        hook: expect.objectContaining({ event: "PreToolUse", matcher: "Bash", type: "command" }),
      }),
    ]);
  });

  it("runs the handlers of one event in parallel, and an identical one only once", async () => {
    const s = await setup();
    const log = path.join(s.root, "log");
    const twice = cmd(`echo once >> ${log}`);
    await s.write(
      "home/.dawg/settings.json",
      settings({
        Stop: [{ hooks: [cmd("sleep 0.6"), cmd("sleep 0.6 && true"), twice] }],
      }),
    );
    await s.write("home/.claude/settings.json", settings({ Stop: [{ hooks: [twice] }] }));
    const store = createTrustStore({ storeRoot: s.store, homeDir: s.home });
    // Claude Code's user hooks wait for consent; approve them so both files run.
    const approval = await store.approval(s.project);
    await store.decide(s.project, approval?.hash ?? "", true);
    const hooks = await s.hooks(store);
    const started = Date.now();
    await hooks.stop({ turnId: "t1", lastMessage: "done", signal: signal() });
    expect(Date.now() - started).toBeLessThan(1100);
    expect(await readFile(log, "utf8")).toBe("once\n");
    expect(ran(s)).toHaveLength(3);
  });

  it("runs the exec form without a shell", async () => {
    const s = await setup();
    const out = path.join(s.root, "args");
    await s.write(
      "home/.dawg/settings.json",
      settings({
        SessionEnd: [
          { hooks: [cmd("/bin/sh", { args: ["-c", `echo "$0" > ${out}`, "one arg; not split"] })] },
        ],
      }),
    );
    const hooks = await s.hooks();
    await hooks.sessionEnd("other");
    expect(await readFile(out, "utf8")).toBe("one arg; not split\n");
  });

  it("stops a handler at its own timeout, and the process with it", async () => {
    const s = await setup();
    const marker = path.join(s.root, "finished");
    await s.write(
      "home/.dawg/settings.json",
      settings({
        PreToolUse: [{ hooks: [cmd(`sleep 3; touch ${marker}`, { timeout: 0.3 })] }],
      }),
    );
    const hooks = await s.hooks();
    const started = Date.now();
    const verdict = await hooks.preToolUse({
      turnId: "t1",
      toolCallId: "c1",
      toolName: "Read",
      toolInput: {},
      signal: signal(),
    });
    expect(Date.now() - started).toBeLessThan(2000);
    // A timeout does not block PreToolUse unless onFailure says so.
    expect(verdict.decision).toBeNull();
    expect(ran(s)[0]).toMatchObject({ outcome: "timeout", exitCode: null });
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(await exists(marker)).toBe(false);
  });

  it("combines PreToolUse decisions: deny over ask over allow", async () => {
    const s = await setup();
    const say = (decision: string, reason: string) =>
      cmd(
        `echo '${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } })}'`,
      );
    await s.write(
      "home/.dawg/settings.json",
      settings({
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [say("allow", "fine"), say("ask", "check"), say("deny", "never")],
          },
        ],
      }),
    );
    const hooks = await s.hooks();
    const verdict = await hooks.preToolUse({
      turnId: "t1",
      toolCallId: "c1",
      toolName: "Bash",
      toolInput: { command: "x" },
      signal: signal(),
    });
    expect(verdict).toMatchObject({ decision: "deny", reason: "never", updatedInput: null });
  });

  it("evaluates `if` with the caller's rule check, and skips it on other events", async () => {
    const s = await setup();
    const log = path.join(s.root, "if-log");
    await s.write(
      "home/.dawg/settings.json",
      settings({
        PreToolUse: [{ hooks: [cmd(`echo pre >> ${log}`, { if: "Bash(rm *)" })] }],
        UserPromptSubmit: [{ hooks: [cmd(`echo prompt >> ${log}`, { if: "Bash(rm *)" })] }],
      }),
    );
    const hooks = await s.hooks();
    const call = (matches: boolean) =>
      hooks.preToolUse({
        turnId: "t1",
        toolCallId: "c1",
        toolName: "Bash",
        toolInput: {},
        signal: signal(),
        ifMatches: () => matches,
      });
    await call(false);
    await call(true);
    await hooks.userPromptSubmit({ text: "hi", signal: signal() });
    expect(await readFile(log, "utf8")).toBe("pre\n");
  });

  it("keeps Stop going with stop_hook_active, up to the documented cap", async () => {
    const s = await setup();
    const out = path.join(s.root, "active");
    await s.write(
      "home/.dawg/settings.json",
      settings({
        Stop: [{ hooks: [cmd(`cat >> ${out}; echo >> ${out}; echo 'Run the tests' >&2; exit 2`)] }],
      }),
    );
    const hooks = await s.hooks();
    hooks.turnStarted();
    const notes: (string | null)[] = [];
    for (let i = 0; i <= STOP_HOOK_CAP; i++) {
      notes.push(await hooks.stop({ turnId: "t1", lastMessage: "Done.", signal: signal() }));
    }
    expect(notes.slice(0, STOP_HOOK_CAP).every((n) => n?.includes("Run the tests"))).toBe(true);
    expect(notes[STOP_HOOK_CAP]).toBeNull();
    const inputs = (await readFile(out, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(inputs[0]).toMatchObject({ stop_hook_active: false, last_assistant_message: "Done." });
    expect(inputs[1]).toMatchObject({ stop_hook_active: true });
    // A tool call starts the count again.
    hooks.toolsRan();
    expect(await hooks.stop({ turnId: "t1", lastMessage: "x", signal: signal() })).not.toBeNull();
  });

  it("runs async hooks in the background and keeps their context for later", async () => {
    const s = await setup();
    await s.write(
      "home/.dawg/settings.json",
      settings({
        PostToolUse: [
          {
            hooks: [
              cmd(
                'sleep 0.2; echo \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"lint: 2 warnings"}}\'',
                { async: true },
              ),
            ],
          },
        ],
      }),
    );
    const hooks = await s.hooks();
    const effects = await hooks.postToolUse({
      turnId: "t1",
      toolCallId: "c1",
      toolName: "Edit",
      toolInput: {},
      toolResponse: { filePath: "/x", success: true },
      durationMs: 3,
      signal: signal(),
    });
    expect(effects.notes).toEqual([]);
    expect(s.notes).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(s.notes).toEqual([expect.stringContaining("lint: 2 warnings")]);
    expect(ran(s)).toHaveLength(1);
  });

  it("adds context from SessionStart and UserPromptSubmit, and refuses a blocked prompt", async () => {
    const s = await setup();
    await s.write(
      "home/.dawg/settings.json",
      settings({
        SessionStart: [{ matcher: "startup", hooks: [cmd("echo 'Branch: main'")] }],
        UserPromptSubmit: [
          {
            hooks: [
              cmd(
                `grep -q secret && { echo 'Prompt has a secret' >&2; exit 2; }; echo 'Ticket: ABC-1'`,
              ),
            ],
          },
        ],
      }),
    );
    const hooks = await s.hooks();
    expect((await hooks.sessionStart({ source: "resume", model: null })).notes).toEqual([]);
    expect((await hooks.sessionStart({ source: "startup", model: "m" })).notes).toEqual([
      expect.stringContaining("Branch: main"),
    ]);
    const ok = await hooks.userPromptSubmit({ text: "fix the bug", signal: signal() });
    expect(ok.blocked).toBeNull();
    expect(ok.notes).toEqual([expect.stringContaining("Ticket: ABC-1")]);
    const refused = await hooks.userPromptSubmit({ text: "my secret is x", signal: signal() });
    expect(refused.blocked).toEqual({ reason: "Prompt has a secret" });
  });
});

describe("consent and switches", () => {
  it("never runs an unapproved project hook, and says so once", async () => {
    const s = await setup();
    const marker = path.join(s.root, "ran");
    await s.write(
      "project/.claude/settings.json",
      settings({
        PreToolUse: [{ hooks: [cmd(`touch ${marker}`)] }],
      }),
    );
    const store = createTrustStore({ storeRoot: s.store, homeDir: s.home });
    const hooks = await s.hooks(store);
    const call = () =>
      hooks.preToolUse({
        turnId: "t1",
        toolCallId: "c1",
        toolName: "Read",
        toolInput: {},
        signal: signal(),
      });
    await call();
    await call();
    expect(await exists(marker)).toBe(false);
    expect(ran(s)).toEqual([]);
    const skipped = s.events.filter((e) => e.event === "hook.skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.fields).toMatchObject({
      projectDir: s.project,
      sources: [{ path: path.join(s.project, ".claude", "settings.json"), scope: "project" }],
    });

    const approval = await store.approval(s.project);
    await store.decide(s.project, approval?.hash ?? "", true);
    await call();
    expect(await exists(marker)).toBe(true);
  });

  it("holds back a hook whose definition changed since the approval", async () => {
    const s = await setup();
    const first = path.join(s.root, "first");
    const second = path.join(s.root, "second");
    const file = await s.write(
      "project/.dawg/settings.json",
      settings({
        Stop: [{ hooks: [cmd(`touch ${first}`)] }],
      }),
    );
    const store = createTrustStore({ storeRoot: s.store, homeDir: s.home });
    const approval = await store.approval(s.project);
    await store.decide(s.project, approval?.hash ?? "", true);
    const hooks = await s.hooks(store);
    await writeFile(
      file,
      JSON.stringify(settings({ Stop: [{ hooks: [cmd(`touch ${second}`)] }] })),
    );
    // The session still holds the approved definition, but the file no longer is what was
    // approved; after reloading, the new one waits for consent.
    await hooks.stop({ turnId: "t1", lastMessage: null, signal: signal() });
    await hooks.reload();
    await hooks.stop({ turnId: "t1", lastMessage: null, signal: signal() });
    expect(await exists(first)).toBe(false);
    expect(await exists(second)).toBe(false);
    expect(s.events.filter((e) => e.event === "hook.skipped")).toHaveLength(2);
  });

  it("makes Claude Code's user hooks wait, and runs the person's own dawg hooks", async () => {
    const s = await setup();
    const claude = path.join(s.root, "claude");
    const dawg = path.join(s.root, "dawg");
    await s.write(
      "home/.claude/settings.json",
      settings({ SessionEnd: [{ hooks: [cmd(`touch ${claude}`)] }] }),
    );
    await s.write(
      "home/.dawg/settings.json",
      settings({ SessionEnd: [{ hooks: [cmd(`touch ${dawg}`)] }] }),
    );
    const hooks = await s.hooks(createTrustStore({ storeRoot: s.store, homeDir: s.home }));
    await hooks.sessionEnd("other");
    expect(await exists(claude)).toBe(false);
    expect(await exists(dawg)).toBe(true);
  });

  it("never runs a hook the person switched off", async () => {
    const s = await setup();
    const marker = path.join(s.root, "ran");
    await s.write(
      "home/.dawg/settings.json",
      settings({ SessionEnd: [{ hooks: [cmd(`touch ${marker}`)] }] }),
    );
    const store = createTrustStore({ storeRoot: s.store, homeDir: s.home });
    const hooks = await s.hooks(store);
    const hook = hooks.loaded?.hooks[0];
    if (hook === undefined) throw new Error("no hook");
    await store.switches.set({
      projectDir: s.project,
      id: hookId(hook),
      scope: "user",
      enabled: false,
    });
    await hooks.sessionEnd("other");
    expect(await exists(marker)).toBe(false);
    await store.switches.set({
      projectDir: s.project,
      id: hookId(hook),
      scope: "user",
      enabled: true,
    });
    await hooks.sessionEnd("other");
    expect(await exists(marker)).toBe(true);
  });

  it("runs nothing while disableAllHooks is set", async () => {
    const s = await setup();
    const marker = path.join(s.root, "ran");
    await s.write("home/.dawg/settings.json", {
      disableAllHooks: true,
      ...settings({ SessionEnd: [{ hooks: [cmd(`touch ${marker}`)] }] }),
    });
    const hooks = await s.hooks();
    expect(hooks.has("SessionEnd")).toBe(false);
    await hooks.sessionEnd("other");
    expect(await exists(marker)).toBe(false);
  });
});
