import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadSettings } from "@dawg/compat";
import { text, toolCall } from "@dawg/mock-model";
import type { PermissionRequest } from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type Harness, startHarness } from "./__fixtures__/harness.ts";
import type { LoggedEvent } from "./event-log.ts";
import type { SessionRuntime } from "./session.ts";
import { loadSessionSettings, SettingsReloader, settingsStamp } from "./settings-reload.ts";

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

async function put(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

/** Outcomes of a session's tool calls, in order. */
function outcomes(harness: Harness, sessionId: string): string[] {
  return harness.ofType(sessionId, "tool.finished").map((e) => String(e.payload.outcome));
}

function errors(harness: Harness, sessionId: string): string[] {
  return harness
    .ofType(sessionId, "error")
    .map((e) => String((e.payload.error as { message: string }).message));
}

/** Two turns, each running one command and then answering. */
function twoCommands(first: string, second: string) {
  return [
    toolCall("Bash", { command: first }),
    text("ok"),
    toolCall("Bash", { command: second }, { id: "second" }),
    text("ok"),
  ];
}

describe("an open session applies settings changes from its next turn", () => {
  it("a rule added to a file mid-session takes effect next turn", async () => {
    h = await startHarness({
      // Nobody to ask, so a command that would ask is refused.
      engine: { capabilities: { permissionPrompts: false } },
      script: twoCommands("touch one.txt", "touch two.txt"),
    });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("first"));
    expect(outcomes(h, session.id)).toEqual(["denied"]);

    await put(path.join(h.project, ".dawg", "settings.json"), {
      permissions: { allow: ["Bash(touch *)"] },
    });
    await session.run(ask("second"));
    expect(outcomes(h, session.id)).toEqual(["denied", "success"]);
    expect(await exists(path.join(h.project, "two.txt"))).toBe(true);
  });

  it("a removed rule stops applying, and a deny rule added in the user's file applies", async () => {
    const shared = { permissions: { allow: ["Bash(touch *)"] } };
    h = await startHarness({
      engine: { capabilities: { permissionPrompts: false } },
      files: { ".dawg/settings.json": JSON.stringify(shared) },
      script: [
        ...twoCommands("touch one.txt", "touch two.txt"),
        toolCall("Bash", { command: "touch three.txt" }, { id: "third" }),
        text("ok"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "acceptEdits" });
    await session.run(ask("first"));
    expect(outcomes(h, session.id)).toEqual(["success"]);

    await put(path.join(h.project, ".dawg", "settings.json"), { permissions: { allow: [] } });
    await session.run(ask("second"));
    expect(outcomes(h, session.id)).toEqual(["success", "denied"]);
    expect(await exists(path.join(h.project, "two.txt"))).toBe(false);

    // Back in force from the project, but the user now denies it: deny wins.
    await put(path.join(h.project, ".dawg", "settings.json"), shared);
    await put(path.join(h.home, ".dawg", "settings.json"), {
      permissions: { deny: ["Bash(touch three.txt)"] },
    });
    await session.run(ask("third"));
    expect(outcomes(h, session.id)).toEqual(["success", "denied", "denied"]);
    expect(await exists(path.join(h.project, "three.txt"))).toBe(false);
  });

  it("an always-allowed rule follows its file once saved: removing it stops it", async () => {
    h = await startHarness({ script: twoCommands("touch one.txt", "touch one.txt") });
    const session = await h.engine.createSession({ cwd: h.project });
    const seen: PermissionRequest[] = [];
    session.subscribe((event: LoggedEvent) => {
      if (event.event !== "permission.requested") return;
      const request = event.payload.request as PermissionRequest;
      seen.push(request);
      const answer = seen.length === 1 ? "always" : "deny";
      setImmediate(() =>
        session.respondPermission(
          request.requestId,
          answer === "always" ? { behavior: "allow", scope: "always" } : { behavior: "deny" },
        ),
      );
    });
    await session.run(ask("first"));
    expect(outcomes(h, session.id)).toEqual(["success"]);
    const local = path.join(h.project, ".dawg", "settings.local.json");
    const saved = JSON.parse(await readFile(local, "utf8"));
    expect(saved.permissions.allow.length).toBeGreaterThan(0);

    // The person removes it in Settings → Permissions.
    await put(local, { permissions: { allow: [] } });
    await session.run(ask("second"));
    expect(seen).toHaveLength(2);
    expect(outcomes(h, session.id)).toEqual(["success", "denied"]);
  });

  it("an always-allowed rule that could not be saved holds for the rest of the session", async () => {
    h = await startHarness({
      files: { ".dawg/settings.local.json": "{ not json" },
      script: twoCommands("touch one.txt", "touch one.txt"),
    });
    const session = await h.engine.createSession({ cwd: h.project });
    const seen = answerAlways(session);
    await session.run(ask("first"));
    expect(errors(h, session.id)).toEqual([
      "The permission rule could not be saved to the project's settings; it applies to this session only.",
    ]);
    // Another file changes, so the next turn reloads.
    await put(path.join(h.project, ".dawg", "settings.json"), {
      permissions: { deny: ["WebFetch"] },
    });
    await session.run(ask("second"));
    expect(seen).toHaveLength(1);
    expect(outcomes(h, session.id)).toEqual(["success", "success"]);
  });

  it("keeps the rules it had while a file cannot be read, says so once, and recovers", async () => {
    h = await startHarness({
      engine: { capabilities: { permissionPrompts: false } },
      files: {
        ".dawg/settings.local.json": JSON.stringify({ permissions: { deny: ["Bash(rm *)"] } }),
      },
      script: [
        toolCall("Bash", { command: "rm -f a.txt" }),
        text("ok"),
        toolCall("Bash", { command: "rm -f a.txt" }, { id: "second" }),
        text("ok"),
        toolCall("Bash", { command: "rm -f a.txt" }, { id: "third" }),
        text("ok"),
      ],
    });
    const file = path.join(h.project, ".dawg", "settings.local.json");
    const session = await h.engine.createSession({ cwd: h.project, mode: "bypassPermissions" });

    // Half-saved: the deny rule must not vanish.
    await put(file, '{ "permissions": { "deny": [');
    await session.run(ask("first"));
    await session.run(ask("second"));
    expect(outcomes(h, session.id)).toEqual(["denied", "denied"]);
    expect(errors(h, session.id)).toEqual([
      "A settings file could not be read, so this session keeps the permission rules it had until it is fixed.",
    ]);

    // Fixed, without the rule.
    await put(file, { permissions: {} });
    await session.run(ask("third"));
    expect(outcomes(h, session.id)).toEqual(["denied", "denied", "success"]);
  });

  it("turning bypass off moves a session out of bypassPermissions mode", async () => {
    h = await startHarness({ script: [text("one"), text("two")] });
    const session = await h.engine.createSession({ cwd: h.project, mode: "bypassPermissions" });
    await session.run(ask("first"));
    await put(path.join(h.home, ".dawg", "settings.json"), {
      permissions: { disableBypassPermissionsMode: "disable" },
    });
    await session.run(ask("second"));
    expect(session.mode).toBe("default");
    expect(errors(h, session.id)).toEqual([
      "bypassPermissions mode was turned off by permissions.disableBypassPermissionsMode, so this session now asks first.",
    ]);
    expect(() => session.setMode("bypassPermissions")).toThrow(
      expect.objectContaining({ code: "InvalidState" }),
    );
    // The model is told, before the second prompt.
    const notes = session.view.filter((m) => m.role === "user").map((m) => JSON.stringify(m));
    const told = notes.findIndex((n) => n.includes('\\"mode_changed\\"') && n.includes("default"));
    expect(told).toBeGreaterThan(-1);
    expect(notes.findIndex((n) => n.includes("second"))).toBeGreaterThan(told);
  });

  it("environment variables apply to the next turn's commands", async () => {
    h = await startHarness({
      script: twoCommands(
        'printf "%s" "$DAWG_TEST_VALUE" > one.txt',
        'printf "%s" "$DAWG_TEST_VALUE" > two.txt',
      ),
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "bypassPermissions" });
    await session.run(ask("first"));
    await put(path.join(h.project, ".dawg", "settings.json"), {
      env: { DAWG_TEST_VALUE: "from settings" },
    });
    await session.run(ask("second"));
    expect(await readFile(path.join(h.project, "one.txt"), "utf8")).toBe("");
    expect(await readFile(path.join(h.project, "two.txt"), "utf8")).toBe("from settings");
  });

  it("the default mode stays a choice made when the session was created", async () => {
    h = await startHarness({ script: [text("one"), text("two")] });
    const session = await h.engine.createSession({ cwd: h.project });
    await session.run(ask("first"));
    await put(path.join(h.project, ".dawg", "settings.json"), {
      permissions: { defaultMode: "acceptEdits" },
    });
    await session.run(ask("second"));
    expect(session.mode).toBe("default");
    // A new session picks it up.
    const next = await h.engine.createSession({ cwd: h.project });
    expect(next.mode).toBe("acceptEdits");
  });
});

/** Answers every permission request with "always allow", recording the requests. */
function answerAlways(session: SessionRuntime): PermissionRequest[] {
  const seen: PermissionRequest[] = [];
  session.subscribe((event: LoggedEvent) => {
    if (event.event !== "permission.requested") return;
    const request = event.payload.request as PermissionRequest;
    seen.push(request);
    setImmediate(() =>
      session.respondPermission(request.requestId, { behavior: "allow", scope: "always" }),
    );
  });
  return seen;
}

describe("a worktree session's personal settings are its project's", () => {
  /** A worktree-style folder inside the project, as the desktop app makes them. */
  async function worktree(harness: Harness): Promise<string> {
    const dir = path.join(harness.project, ".dawg", "worktrees", "w1");
    await mkdir(dir, { recursive: true });
    return dir;
  }

  it("loads the project's personal rules and the worktree's shared ones", async () => {
    h = await startHarness({
      engine: { capabilities: { permissionPrompts: false } },
      files: {
        ".dawg/settings.local.json": JSON.stringify({
          permissions: { allow: ["Bash(touch *)"] },
        }),
      },
      script: twoCommands("touch one.txt", "touch two.txt"),
    });
    const tree = await worktree(h);
    // The worktree's own personal file does not apply; its shared file does.
    await put(path.join(tree, ".dawg", "settings.local.json"), {
      permissions: { deny: ["Bash(touch one.txt)"] },
    });
    await put(path.join(tree, ".dawg", "settings.json"), {
      permissions: { deny: ["Bash(touch two.txt)"] },
    });
    const session = await h.engine.createSession({ cwd: tree, projectDir: h.project });
    expect(session.cwd).toBe(tree);
    expect(session.projectDir).toBe(h.project);
    expect(session.summary().projectDir).toBe(h.project);
    await session.run(ask("first"));
    await session.run(ask("second"));
    expect(outcomes(h, session.id)).toEqual(["success", "denied"]);
    expect(await exists(path.join(tree, "one.txt"))).toBe(true);
  });

  it("“always allow” saves to the project, and other sessions apply it next turn", async () => {
    h = await startHarness({
      script: [
        toolCall("Bash", { command: "touch made.txt" }),
        text("ok"),
        text("plain turn"),
        toolCall("Bash", { command: "touch made.txt" }, { id: "main" }),
        text("ok"),
      ],
    });
    const tree = await worktree(h);
    const inTree = await h.engine.createSession({ cwd: tree, projectDir: h.project });
    // A session in the project itself, open meanwhile.
    const main = await h.engine.createSession({ cwd: h.project });
    const seen = answerAlways(inTree);
    await inTree.run(ask("touch"));
    expect(seen).toHaveLength(1);
    const saved = JSON.parse(
      await readFile(path.join(h.project, ".dawg", "settings.local.json"), "utf8"),
    );
    expect(saved.permissions.allow).toEqual(seen[0]?.suggestions);
    expect(await exists(path.join(tree, ".dawg", "settings.local.json"))).toBe(false);

    await main.run(ask("anything"));
    const mainSeen = answerAlways(main);
    await main.run(ask("touch"));
    expect(mainSeen).toHaveLength(0);
    expect(outcomes(h, main.id)).toEqual(["success"]);
  });

  it("a change to the project's personal file applies to the worktree session next turn", async () => {
    h = await startHarness({
      engine: { capabilities: { permissionPrompts: false } },
      script: twoCommands("touch one.txt", "touch two.txt"),
    });
    const tree = await worktree(h);
    const session = await h.engine.createSession({ cwd: tree, projectDir: h.project });
    await session.run(ask("first"));
    expect(outcomes(h, session.id)).toEqual(["denied"]);
    await put(path.join(h.project, ".dawg", "settings.local.json"), {
      permissions: { allow: ["Bash(touch *)"] },
    });
    await session.run(ask("second"));
    expect(outcomes(h, session.id)).toEqual(["denied", "success"]);
  });

  it("keeps its project through a resume, a fork and /clear", async () => {
    h = await startHarness({
      files: {
        ".dawg/settings.local.json": JSON.stringify({ permissions: { deny: ["WebFetch"] } }),
      },
    });
    const tree = await worktree(h);
    const session = await h.engine.createSession({ cwd: tree, projectDir: h.project });
    const id = session.id;
    await h.engine.close();

    const reopened = await h.newEngine().resumeSession(id);
    expect(reopened.projectDir).toBe(h.project);
    expect(reopened.summary().projectDir).toBe(h.project);
    const engine = h.newEngine();
    const listed = await engine.listSessions();
    expect(listed.sessions.find((s) => s.id === id)?.projectDir).toBe(h.project);

    const fork = await h.engine.forkSession(id);
    expect(fork.projectDir).toBe(h.project);
    const cleared = await h.engine.clearSession(fork.id);
    expect(cleared.cwd).toBe(tree);
    expect(cleared.projectDir).toBe(h.project);
  });

  it("refuses a project folder that does not exist", async () => {
    h = await startHarness();
    const tree = await worktree(h);
    await expect(
      h.engine.createSession({ cwd: tree, projectDir: path.join(h.root, "nope") }),
    ).rejects.toThrow(expect.objectContaining({ code: "InvalidState" }));
  });
});

describe("SettingsReloader", () => {
  it("loads again only when a file appears, changes or goes", async () => {
    h = await startHarness();
    const options = { projectDir: h.project, homeDir: h.home };
    const { settings, stamp } = await loadSessionSettings(options);
    const reloader = new SettingsReloader(options, stamp);
    expect(await reloader.check(settings)).toEqual({ kind: "unchanged" });

    const file = path.join(h.project, ".dawg", "settings.json");
    await put(file, { permissions: { allow: ["Read"] } });
    const changed = await reloader.check(settings);
    expect(changed.kind).toBe("changed");
    const fresh = changed.kind === "changed" ? changed.settings : settings;
    expect(fresh.permissions.allow.map((r) => r.rule)).toEqual(["Read"]);
    expect(await reloader.check(fresh)).toEqual({ kind: "unchanged" });

    await rm(file);
    const gone = await reloader.check(fresh);
    expect(gone.kind === "changed" && gone.settings.permissions.allow).toEqual([]);
  });

  it("reports a file that became unreadable once, until it changes again", async () => {
    h = await startHarness({ files: { ".dawg/settings.json": "{}" } });
    const options = { projectDir: h.project, homeDir: h.home };
    const settings = await loadSettings(options);
    const reloader = new SettingsReloader(options, null);
    const file = path.join(h.project, ".dawg", "settings.json");
    await put(file, "{ oops");
    const first = await reloader.check(settings);
    expect(first.kind).toBe("unreadable");
    expect(first.kind === "unreadable" && first.problems.map((p) => p.path)).toEqual([file]);
    expect(await reloader.check(settings)).toEqual({ kind: "unchanged" });
    await put(file, "{ still oops");
    expect((await reloader.check(settings)).kind).toBe("unreadable");
  });

  it("a file that was already unreadable does not hold back other changes", async () => {
    h = await startHarness({ files: { ".dawg/settings.json": "{ oops" } });
    const options = { projectDir: h.project, homeDir: h.home };
    const { settings, stamp } = await loadSessionSettings(options);
    const reloader = new SettingsReloader(options, stamp);
    await put(path.join(h.home, ".dawg", "settings.json"), { permissions: { deny: ["Bash"] } });
    const check = await reloader.check(settings);
    expect(check.kind === "changed" && check.settings.permissions.deny.map((r) => r.rule)).toEqual([
      "Bash",
    ]);
  });

  it("stamps a missing file as missing and an existing one by time, size and inode", async () => {
    h = await startHarness({ files: { "a.json": "{}" } });
    const a = path.join(h.project, "a.json");
    const missing = path.join(h.project, "nope.json");
    const before = await settingsStamp([a, missing]);
    expect(before.endsWith("|-")).toBe(true);
    await writeFile(a, '{"x": 1}');
    expect(await settingsStamp([a, missing])).not.toBe(before);
  });
});
