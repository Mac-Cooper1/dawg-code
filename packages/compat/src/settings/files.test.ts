import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readSettingsFiles } from "./files.ts";
import { loadSettings, settingsFilePaths } from "./load.ts";
import {
  addPermissionRules,
  dawgSettingsPath,
  SettingsWriteError,
  settingsWriteProblem,
  updatePermissionSettings,
} from "./write.ts";

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dawg-compat-files-"));
  home = join(root, "home");
  project = join(root, "work", "proj");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

const p = {
  dawgLocal: () => join(project, ".dawg", "settings.local.json"),
  claudeLocal: () => join(project, ".claude", "settings.local.json"),
  dawgProject: () => join(project, ".dawg", "settings.json"),
  claudeProject: () => join(project, ".claude", "settings.json"),
  dawgUser: () => join(home, ".dawg", "settings.json"),
  claudeUser: () => join(home, ".claude", "settings.json"),
};

describe("dawgSettingsPath", () => {
  test("names dawg's own file for each scope", () => {
    const dirs = { projectDir: project, homeDir: home };
    expect(dawgSettingsPath("user", dirs)).toBe(p.dawgUser());
    expect(dawgSettingsPath("project", dirs)).toBe(p.dawgProject());
    expect(dawgSettingsPath("local", dirs)).toBe(p.dawgLocal());
    expect(dawgSettingsPath("user", { projectDir: null, homeDir: home })).toBe(p.dawgUser());
  });

  test("the project scopes need a project", () => {
    expect(() => dawgSettingsPath("local", { projectDir: null, homeDir: home })).toThrow(
      SettingsWriteError,
    );
  });
});

describe("updatePermissionSettings", () => {
  test("creates the file and its .dawg folder when needed", async () => {
    const result = await updatePermissionSettings({
      file: p.dawgProject(),
      defaultMode: "acceptEdits",
      allow: ["Bash(npm test)"],
      deny: ["Read(./.env)"],
    });
    expect(result).toEqual({ path: p.dawgProject(), changed: true });
    expect(await json(p.dawgProject())).toEqual({
      permissions: {
        defaultMode: "acceptEdits",
        allow: ["Bash(npm test)"],
        deny: ["Read(./.env)"],
      },
    });
    const text = await readFile(p.dawgProject(), "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "permissions": {\n    "defaultMode"');
    expect((await stat(p.dawgProject())).mode & 0o777).toBe(0o600);
  });

  test("replaces only the lists given and keeps every other key in its place", async () => {
    await put(p.dawgLocal(), {
      $schema: "https://example.com/schema.json",
      env: { A: "1" },
      permissions: {
        allow: ["Read", "Edit(src/**)"],
        additionalDirectories: ["../shared"],
        ask: ["Bash(git push *)"],
        deny: ["Bash(rm *)"],
        defaultMode: "plan",
        disableBypassPermissionsMode: "disable",
      },
      model: "something",
    });
    await updatePermissionSettings({ file: p.dawgLocal(), allow: ["Read", "Bash(ls)"] });
    const data = (await json(p.dawgLocal())) as Record<string, Record<string, unknown>>;
    expect(Object.keys(data)).toEqual(["$schema", "env", "permissions", "model"]);
    expect(Object.keys(data.permissions ?? {})).toEqual([
      "allow",
      "additionalDirectories",
      "ask",
      "deny",
      "defaultMode",
      "disableBypassPermissionsMode",
    ]);
    expect(data.permissions).toEqual({
      allow: ["Read", "Bash(ls)"],
      additionalDirectories: ["../shared"],
      ask: ["Bash(git push *)"],
      deny: ["Bash(rm *)"],
      defaultMode: "plan",
      disableBypassPermissionsMode: "disable",
    });
    expect(data.env).toEqual({ A: "1" });
  });

  test("sets, keeps and removes the default mode", async () => {
    await put(p.dawgUser(), { permissions: { allow: ["Read"] } });
    await updatePermissionSettings({ file: p.dawgUser(), defaultMode: "dontAsk" });
    expect(await json(p.dawgUser())).toEqual({
      permissions: { allow: ["Read"], defaultMode: "dontAsk" },
    });
    await updatePermissionSettings({ file: p.dawgUser(), ask: ["Bash"] });
    expect(await json(p.dawgUser())).toEqual({
      permissions: { allow: ["Read"], defaultMode: "dontAsk", ask: ["Bash"] },
    });
    await updatePermissionSettings({ file: p.dawgUser(), defaultMode: null });
    expect(await json(p.dawgUser())).toEqual({ permissions: { allow: ["Read"], ask: ["Bash"] } });
  });

  test("an empty list removes it; an emptied permissions object stays", async () => {
    await put(p.dawgLocal(), { permissions: { allow: ["Read"], deny: ["Bash(rm *)"] } });
    await updatePermissionSettings({ file: p.dawgLocal(), allow: [], deny: [] });
    expect(await json(p.dawgLocal())).toEqual({ permissions: {} });
  });

  test("moves a rule between lists in one write", async () => {
    await put(p.dawgLocal(), { permissions: { allow: ["Bash(git push *)", "Read"] } });
    await updatePermissionSettings({
      file: p.dawgLocal(),
      allow: ["Read"],
      ask: ["Bash(git push *)"],
    });
    expect(await json(p.dawgLocal())).toEqual({
      permissions: { allow: ["Read"], ask: ["Bash(git push *)"] },
    });
  });

  test("writes nothing when nothing changes, and creates nothing just to remove", async () => {
    const removed = await updatePermissionSettings({
      file: p.dawgLocal(),
      defaultMode: null,
      allow: [],
    });
    expect(removed.changed).toBe(false);
    await expect(stat(join(project, ".dawg"))).rejects.toThrow();

    await put(p.dawgLocal(), '{"permissions":{"allow":["Read"]}}');
    const same = await updatePermissionSettings({ file: p.dawgLocal(), allow: ["Read"] });
    expect(same.changed).toBe(false);
    expect(await readFile(p.dawgLocal(), "utf8")).toBe('{"permissions":{"allow":["Read"]}}');
  });

  test("drops duplicate rules and keeps rules as written", async () => {
    await updatePermissionSettings({
      file: p.dawgLocal(),
      deny: ["Bash(rm *)", "Read(./secrets/**)", "Bash(rm *)"],
    });
    expect(await json(p.dawgLocal())).toEqual({
      permissions: { deny: ["Bash(rm *)", "Read(./secrets/**)"] },
    });
  });

  test("keeps an existing file's permission bits", async () => {
    await put(p.dawgProject(), { permissions: {} });
    await chmod(p.dawgProject(), 0o644);
    await updatePermissionSettings({ file: p.dawgProject(), allow: ["Read"] });
    expect((await stat(p.dawgProject())).mode & 0o777).toBe(0o644);
  });

  test("keeps a __proto__ key as an ordinary key and reads a byte-order mark", async () => {
    await put(p.dawgLocal(), '﻿{"__proto__":{"x":1},"permissions":{"__proto__":["y"]}}');
    await updatePermissionSettings({ file: p.dawgLocal(), allow: ["Read"] });
    const text = await readFile(p.dawgLocal(), "utf8");
    expect(text).toContain('"__proto__": {\n    "x": 1\n  }');
    expect(text).toContain('"__proto__": [\n      "y"\n    ]');
    expect(text).toContain('"allow": [\n      "Read"\n    ]');
  });

  test("refuses files it cannot parse and leaves them as they were", async () => {
    const cases: [string, RegExp][] = [
      ["{ not json", /is not valid JSON; fix it by hand first\.$/],
      ["[1, 2]", /does not hold a JSON object; fix it by hand first\.$/],
      ['{"permissions": []}', /"permissions" value that is not an object/],
      ['{"permissions": {"deny": "Bash"}}', /"permissions\.deny" value that is not a list/],
    ];
    for (const [content, message] of cases) {
      await put(p.dawgLocal(), content);
      const attempt = updatePermissionSettings({ file: p.dawgLocal(), allow: ["Read"] });
      await expect(attempt).rejects.toBeInstanceOf(SettingsWriteError);
      await expect(attempt).rejects.toThrow(message);
      expect(await readFile(p.dawgLocal(), "utf8")).toBe(content);
    }
  });

  test("replaces a list whose entries are not all strings", async () => {
    await put(p.dawgLocal(), { permissions: { allow: ["Read", 3, null] } });
    await updatePermissionSettings({ file: p.dawgLocal(), allow: ["Read", "Edit"] });
    expect(await json(p.dawgLocal())).toEqual({ permissions: { allow: ["Read", "Edit"] } });
  });

  test("refuses .claude files, directly or through a link", async () => {
    await expect(
      updatePermissionSettings({ file: p.claudeLocal(), allow: ["Read"] }),
    ).rejects.toBeInstanceOf(SettingsWriteError);

    // The project's .dawg folder is a link to its .claude folder.
    await mkdir(join(project, ".claude"), { recursive: true });
    await symlink(join(project, ".claude"), join(project, ".dawg"));
    await expect(
      updatePermissionSettings({ file: p.dawgLocal(), allow: ["Read"] }),
    ).rejects.toThrow(/Refusing to write under a \.claude directory/);
    await expect(readFile(p.claudeLocal(), "utf8")).rejects.toThrow();

    // A project that lies inside a .claude folder.
    const inside = join(home, ".claude", "proj");
    await expect(
      updatePermissionSettings({
        file: join(inside, ".dawg", "settings.json"),
        allow: ["Read"],
      }),
    ).rejects.toBeInstanceOf(SettingsWriteError);
  });

  test("refuses the user's file when it is a link into .claude", async () => {
    await put(p.claudeUser(), { permissions: { allow: ["Read"] } });
    await mkdir(join(home, ".dawg"), { recursive: true });
    await symlink(p.claudeUser(), p.dawgUser());
    await expect(
      updatePermissionSettings({ file: p.dawgUser(), allow: ["Edit"] }),
    ).rejects.toBeInstanceOf(SettingsWriteError);
    expect(await json(p.claudeUser())).toEqual({ permissions: { allow: ["Read"] } });
  });

  test("writes through a link that does not lead into .claude, keeping the link", async () => {
    const dotfiles = join(root, "dotfiles", "dawg");
    await put(join(dotfiles, "settings.json"), { permissions: { allow: ["Read"] } });
    await symlink(dotfiles, join(home, ".dawg"));
    await updatePermissionSettings({ file: p.dawgUser(), allow: ["Read", "Edit"] });
    expect(await json(join(dotfiles, "settings.json"))).toEqual({
      permissions: { allow: ["Read", "Edit"] },
    });
  });

  test("refuses anything that is not one of dawg's settings files", async () => {
    for (const file of [
      join(project, "settings.json"),
      join(project, ".dawg", "other.json"),
      join(project, ".dawg", "settings.json", "x"),
      ".dawg/settings.json",
    ]) {
      await expect(updatePermissionSettings({ file, allow: ["Read"] })).rejects.toBeInstanceOf(
        SettingsWriteError,
      );
    }
  });

  test("refuses empty rules and unknown modes", async () => {
    await expect(
      updatePermissionSettings({ file: p.dawgLocal(), allow: ["Read", "  "] }),
    ).rejects.toThrow("Permission rules must be non-empty strings.");
    await expect(
      updatePermissionSettings({
        file: p.dawgLocal(),
        defaultMode: "auto" as unknown as "default",
      }),
    ).rejects.toThrow('"auto" is not a permission mode.');
    await expect(stat(p.dawgLocal())).rejects.toThrow();
  });

  test("shares the per-file queue with addPermissionRules, so no write is lost", async () => {
    await Promise.all([
      updatePermissionSettings({ file: p.dawgLocal(), deny: ["Bash(rm *)"] }),
      addPermissionRules({ projectDir: project, list: "allow", rules: ["A"] }),
      updatePermissionSettings({ file: p.dawgLocal(), ask: ["Bash(git push *)"] }),
      addPermissionRules({ projectDir: project, list: "allow", rules: ["B"] }),
      updatePermissionSettings({ file: p.dawgLocal(), defaultMode: "plan" }),
    ]);
    expect(await json(p.dawgLocal())).toEqual({
      permissions: {
        deny: ["Bash(rm *)"],
        allow: ["A", "B"],
        ask: ["Bash(git push *)"],
        defaultMode: "plan",
      },
    });
  });
});

describe("settingsWriteProblem", () => {
  test("null for a file it would write, missing or not", async () => {
    expect(await settingsWriteProblem(p.dawgLocal())).toBeNull();
    await put(p.dawgLocal(), { permissions: { allow: ["Read"] } });
    expect(await settingsWriteProblem(p.dawgLocal())).toBeNull();
  });

  test("a sentence for one it would refuse", async () => {
    await put(p.dawgLocal(), "{ nope");
    expect(await settingsWriteProblem(p.dawgLocal())).toBe(
      `${p.dawgLocal()} is not valid JSON; fix it by hand first.`,
    );
    expect(await settingsWriteProblem(p.claudeLocal())).toMatch(/not one of dawg's settings files/);
  });
});

describe("personal files from another folder (a worktree's project)", () => {
  // A worktree of the project, as the desktop app makes them.
  const tree = () => join(project, ".dawg", "worktrees", "w1");

  test("settingsFilePaths takes the personal files from localDir and the rest from the project", () => {
    expect(
      settingsFilePaths(tree(), home, project).map((f) => [f.source, f.origin, f.path]),
    ).toEqual([
      ["local", "dawg", p.dawgLocal()],
      ["local", "claude", p.claudeLocal()],
      ["project", "dawg", join(tree(), ".dawg", "settings.json")],
      ["project", "claude", join(tree(), ".claude", "settings.json")],
      ["user", "dawg", p.dawgUser()],
      ["user", "claude", p.claudeUser()],
    ]);
    // Without one, the project's own.
    expect(settingsFilePaths(tree(), home)[0]?.path).toBe(
      join(tree(), ".dawg", "settings.local.json"),
    );
  });

  test("loadSettings reads the project's personal rules and the worktree's shared ones", async () => {
    await put(p.dawgLocal(), {
      permissions: { allow: ["Bash(npm test)"], additionalDirectories: ["../shared"] },
    });
    await put(p.claudeLocal(), { permissions: { ask: ["Bash(git push *)"] } });
    // The worktree's own personal file (left by hand, say) does not apply; its shared one does.
    await put(join(tree(), ".dawg", "settings.local.json"), { permissions: { deny: ["Read"] } });
    await put(join(tree(), ".dawg", "settings.json"), { permissions: { deny: ["WebFetch"] } });
    const s = await loadSettings({ projectDir: tree(), localDir: project, homeDir: home });
    expect(s.permissions.allow).toEqual([
      { rule: "Bash(npm test)", from: { source: "local", origin: "dawg", path: p.dawgLocal() } },
    ]);
    expect(s.permissions.ask.map((r) => r.rule)).toEqual(["Bash(git push *)"]);
    expect(s.permissions.deny.map((r) => r.rule)).toEqual(["WebFetch"]);
    // Relative to the folder the personal file is in.
    expect(s.permissions.additionalDirectories).toEqual([join(root, "work", "shared")]);
    expect(s.files.map((f) => f.path)).toEqual(
      settingsFilePaths(tree(), home, project).map((f) => f.path),
    );
  });

  test("readSettingsFiles lists the same files", async () => {
    await put(p.dawgLocal(), { permissions: { defaultMode: "acceptEdits" } });
    const state = await readSettingsFiles({ projectDir: tree(), localDir: project, homeDir: home });
    expect(state.files[0]).toMatchObject({ path: p.dawgLocal(), defaultMode: "acceptEdits" });
    expect(state.files[2]?.path).toBe(join(tree(), ".dawg", "settings.json"));
    expect(state.defaultMode).toBe("acceptEdits");
  });
});

describe("readSettingsFiles", () => {
  test("without a project, lists only the user's files", async () => {
    const state = await readSettingsFiles({ projectDir: null, homeDir: home });
    expect(state.projectDir).toBeNull();
    expect(state.files.map((f) => [f.source, f.origin, f.path, f.exists, f.writable])).toEqual([
      ["user", "dawg", p.dawgUser(), false, true],
      ["user", "claude", p.claudeUser(), false, false],
    ]);
    expect(state.defaultMode).toBeNull();
    expect(state.bypassDisabled).toBe(false);
  });

  test("with a project, lists every file in precedence order with its own values", async () => {
    await put(p.dawgLocal(), { permissions: { allow: ["Bash(npm test)"], defaultMode: "plan" } });
    await put(p.claudeLocal(), { permissions: { ask: ["Bash(git push *)"] } });
    await put(p.dawgProject(), { permissions: { deny: ["Read(./.env)"], defaultMode: "default" } });
    await put(p.claudeProject(), { permissions: { allow: ["Read"] } });
    await put(p.dawgUser(), { permissions: { allow: ["Edit"], defaultMode: "acceptEdits" } });
    await put(p.claudeUser(), { permissions: { deny: ["WebFetch"] } });

    const state = await readSettingsFiles({ projectDir: project, homeDir: home });
    expect(state.projectDir).toBe(project);
    expect(
      state.files.map((f) => [f.source, f.origin, f.exists, f.writable, f.readOnlyReason]),
    ).toEqual([
      ["local", "dawg", true, true, null],
      [
        "local",
        "claude",
        true,
        false,
        "dawg reads Claude Code's settings files but never changes them.",
      ],
      ["project", "dawg", true, true, null],
      [
        "project",
        "claude",
        true,
        false,
        "dawg reads Claude Code's settings files but never changes them.",
      ],
      ["user", "dawg", true, true, null],
      [
        "user",
        "claude",
        true,
        false,
        "dawg reads Claude Code's settings files but never changes them.",
      ],
    ]);
    expect(state.files.map((f) => [f.defaultMode, f.allow, f.ask, f.deny])).toEqual([
      ["plan", ["Bash(npm test)"], [], []],
      [null, [], ["Bash(git push *)"], []],
      ["default", [], [], ["Read(./.env)"]],
      [null, ["Read"], [], []],
      ["acceptEdits", ["Edit"], [], []],
      [null, [], [], ["WebFetch"]],
    ]);
    expect(state.files.every((f) => f.problems.length === 0)).toBe(true);
    // The most specific file wins, as for a new session.
    expect(state.defaultMode).toBe("plan");
    const loaded = await loadSettings({ projectDir: project, homeDir: home });
    expect(state.defaultMode).toBe(loaded.permissions.defaultMode);
  });

  test("a file it cannot parse is read-only and says why", async () => {
    await put(p.dawgProject(), "{ broken");
    const state = await readSettingsFiles({ projectDir: project, homeDir: home });
    const file = state.files.find((f) => f.path === p.dawgProject());
    expect(file).toMatchObject({ exists: true, writable: false, allow: [] });
    expect(file?.readOnlyReason).toBe(
      `${p.dawgProject()} is not valid JSON; fix it by hand first.`,
    );
    expect(file?.problems).toEqual([
      expect.objectContaining({ key: null, message: expect.stringMatching(/^Not valid JSON/) }),
    ]);
  });

  test("a dawg file that leads into .claude is read-only", async () => {
    await mkdir(join(project, ".claude"), { recursive: true });
    await symlink(join(project, ".claude"), join(project, ".dawg"));
    const state = await readSettingsFiles({ projectDir: project, homeDir: home });
    const local = state.files.find((f) => f.path === p.dawgLocal());
    expect(local?.writable).toBe(false);
    expect(local?.readOnlyReason).toMatch(/Refusing to write under a \.claude directory/);
  });

  test("problems go to their own file, including values sessions ignore", async () => {
    await put(p.dawgLocal(), {
      permissions: { defaultMode: "bypassPermissions", allow: ["Read", 4] },
    });
    await put(p.claudeUser(), {
      permissions: { defaultMode: "bypassPermissions", disableBypassPermissionsMode: "disable" },
    });
    await put(p.dawgUser(), { permissions: { defaultMode: "auto" } });
    const state = await readSettingsFiles({ projectDir: project, homeDir: home });
    const byPath = new Map(state.files.map((f) => [f.path, f]));
    expect(byPath.get(p.dawgLocal())?.defaultMode).toBe("bypassPermissions");
    expect(byPath.get(p.dawgLocal())?.problems.map((x) => x.message)).toEqual([
      "Expected a string, found a number.",
      expect.stringMatching(/^A project's own settings cannot start sessions in bypassPermissions/),
    ]);
    expect(byPath.get(p.dawgUser())?.problems.map((x) => x.message)).toEqual([
      'Permission mode "auto" is not supported; ignored.',
    ]);
    expect(byPath.get(p.claudeUser())?.problems.map((x) => x.message)).toEqual([
      expect.stringMatching(/^bypassPermissions mode is disabled/),
    ]);
    expect(byPath.get(p.dawgProject())?.problems).toEqual([]);
    expect(state.bypassDisabled).toBe(true);
    expect(state.defaultMode).toBeNull();
  });

  test("when the project is the home folder, its shared file is listed once, as the user's", async () => {
    const state = await readSettingsFiles({ projectDir: home, homeDir: home });
    expect(state.files.map((f) => [f.source, f.origin])).toEqual([
      ["local", "dawg"],
      ["local", "claude"],
      ["user", "dawg"],
      ["user", "claude"],
    ]);
  });

  test("what it reads matches what a write left", async () => {
    await updatePermissionSettings({
      file: p.dawgLocal(),
      defaultMode: "acceptEdits",
      allow: ["Bash(npm run test *)"],
      ask: ["Bash(git push *)"],
      deny: ["Read(./secrets/**)"],
    });
    const state = await readSettingsFiles({ projectDir: project, homeDir: home });
    expect(state.files[0]).toMatchObject({
      path: p.dawgLocal(),
      exists: true,
      writable: true,
      defaultMode: "acceptEdits",
      allow: ["Bash(npm run test *)"],
      ask: ["Bash(git push *)"],
      deny: ["Read(./secrets/**)"],
      problems: [],
    });
    expect(state.defaultMode).toBe("acceptEdits");
  });
});
