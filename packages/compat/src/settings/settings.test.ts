import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseRuleList } from "./flags.ts";
import { FLAGS_PROBLEM_PATH, loadSettings } from "./load.ts";
import { parsePermissionMode } from "./parse.ts";
import { addPermissionRules, SettingsWriteError } from "./write.ts";

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dawg-compat-settings-"));
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

const p = {
  dawgLocal: () => join(project, ".dawg", "settings.local.json"),
  claudeLocal: () => join(project, ".claude", "settings.local.json"),
  dawgProject: () => join(project, ".dawg", "settings.json"),
  claudeProject: () => join(project, ".claude", "settings.json"),
  dawgUser: () => join(home, ".dawg", "settings.json"),
  claudeUser: () => join(home, ".claude", "settings.json"),
};

const load = (flags?: Parameters<typeof loadSettings>[0]["flags"]) =>
  loadSettings({ projectDir: project, homeDir: home, flags });

describe("loadSettings levels", () => {
  test("no files at all gives empty settings and lists every file looked at", async () => {
    const s = await load();
    expect(s.permissions).toEqual({
      allow: [],
      ask: [],
      deny: [],
      defaultMode: null,
      additionalDirectories: [],
      bypassDisabled: false,
    });
    expect(s.env).toEqual({});
    expect(s.problems).toEqual([]);
    expect(s.files.map((f) => [f.source, f.origin, f.path, f.exists])).toEqual([
      ["local", "dawg", p.dawgLocal(), false],
      ["local", "claude", p.claudeLocal(), false],
      ["project", "dawg", p.dawgProject(), false],
      ["project", "claude", p.claudeProject(), false],
      ["user", "dawg", p.dawgUser(), false],
      ["user", "claude", p.claudeUser(), false],
    ]);
  });

  const cases: [string, () => string, "local" | "project" | "user", "dawg" | "claude"][] = [
    ["dawg local", p.dawgLocal, "local", "dawg"],
    ["claude local", p.claudeLocal, "local", "claude"],
    ["dawg project", p.dawgProject, "project", "dawg"],
    ["claude project", p.claudeProject, "project", "claude"],
    ["dawg user", p.dawgUser, "user", "dawg"],
    ["claude user", p.claudeUser, "user", "claude"],
  ];
  for (const [name, path, source, origin] of cases) {
    test(`${name} file alone`, async () => {
      await put(path(), {
        permissions: {
          allow: ["Bash(npm test)"],
          ask: ["Bash(git push *)"],
          deny: ["Read(./.env)"],
          defaultMode: "acceptEdits",
          additionalDirectories: ["/abs/dir"],
        },
        env: { FOO: "bar" },
      });
      const s = await load();
      const from = { source, origin, path: path() };
      expect(s.permissions.allow).toEqual([{ rule: "Bash(npm test)", from }]);
      expect(s.permissions.ask).toEqual([{ rule: "Bash(git push *)", from }]);
      expect(s.permissions.deny).toEqual([{ rule: "Read(./.env)", from }]);
      expect(s.permissions.defaultMode).toBe("acceptEdits");
      expect(s.permissions.additionalDirectories).toEqual(["/abs/dir"]);
      expect(s.env).toEqual({ FOO: "bar" });
      expect(s.problems).toEqual([]);
      expect(s.files.find((f) => f.path === path())?.exists).toBe(true);
    });
  }

  test("flags alone", async () => {
    const s = await load({
      allowedTools: ["Bash(git log *)", "Read"],
      disallowedTools: ["Bash(rm *)"],
      permissionMode: "plan",
      addDirs: ["../shared", "~/notes"],
      env: { A: "1" },
    });
    const from = { source: "flags", origin: null, path: null };
    expect(s.permissions.allow).toEqual([
      { rule: "Bash(git log *)", from },
      { rule: "Read", from },
    ]);
    expect(s.permissions.deny).toEqual([{ rule: "Bash(rm *)", from }]);
    expect(s.permissions.defaultMode).toBe("plan");
    expect(s.permissions.additionalDirectories).toEqual([
      join(root, "work", "shared"),
      join(home, "notes"),
    ]);
    expect(s.env).toEqual({ A: "1" });
  });

  test("all levels together: lists combine highest first, single values override, env merges per key", async () => {
    await put(p.claudeUser(), {
      permissions: { allow: ["U1", "shared"], defaultMode: "dontAsk" },
      env: { A: "claude-user", B: "claude-user", C: "claude-user", D: "claude-user" },
    });
    await put(p.dawgUser(), {
      permissions: { allow: ["U2"], deny: ["D-user"] },
      env: { A: "dawg-user" },
    });
    await put(p.claudeProject(), {
      permissions: { allow: ["P1", "shared"], defaultMode: "plan" },
      env: { B: "claude-project" },
    });
    await put(p.dawgProject(), { permissions: { allow: ["P2"] } });
    await put(p.claudeLocal(), { permissions: { allow: ["L1"] }, env: { C: "claude-local" } });
    await put(p.dawgLocal(), { permissions: { allow: ["L2"], defaultMode: "acceptEdits" } });

    const s = await load({ allowedTools: ["F1"], env: { D: "flags" } });
    expect(s.permissions.allow.map((r) => r.rule)).toEqual([
      "F1",
      "L2",
      "L1",
      "P2",
      "P1",
      "shared",
      "U2",
      "U1",
    ]);
    // The duplicate keeps the highest-precedence source.
    expect(s.permissions.allow.find((r) => r.rule === "shared")?.from.path).toBe(p.claudeProject());
    expect(s.permissions.deny.map((r) => r.rule)).toEqual(["D-user"]);
    expect(s.permissions.defaultMode).toBe("acceptEdits");
    expect(s.env).toEqual({ A: "dawg-user", B: "claude-project", C: "claude-local", D: "flags" });
    expect(s.problems).toEqual([]);
  });

  test("flags mode overrides every file", async () => {
    await put(p.dawgLocal(), { permissions: { defaultMode: "acceptEdits" } });
    const s = await load({ permissionMode: "default" });
    expect(s.permissions.defaultMode).toBe("default");
  });

  test("both families at one level: .dawg wins single values, lists keep both", async () => {
    await put(p.dawgProject(), {
      permissions: { allow: ["A"], defaultMode: "plan" },
      env: { X: "dawg" },
    });
    await put(p.claudeProject(), {
      permissions: { allow: ["B", "A"], defaultMode: "acceptEdits" },
      env: { X: "claude", Y: "claude" },
    });
    const s = await load();
    expect(s.permissions.allow.map((r) => [r.rule, r.from.origin])).toEqual([
      ["A", "dawg"],
      ["B", "claude"],
    ]);
    expect(s.permissions.defaultMode).toBe("plan");
    expect(s.env).toEqual({ X: "dawg", Y: "claude" });
  });

  test("lower levels still supply a value the higher level does not set", async () => {
    await put(p.dawgLocal(), { permissions: { allow: ["x"] } });
    await put(p.claudeUser(), { permissions: { defaultMode: "plan" } });
    expect((await load()).permissions.defaultMode).toBe("plan");
  });
});

describe("validation", () => {
  test("invalid JSON skips that file only and reports it", async () => {
    await put(p.claudeProject(), '{ "permissions": { "allow": ["A"], } }');
    await put(p.claudeUser(), { permissions: { allow: ["U"] } });
    const s = await load();
    expect(s.permissions.allow.map((r) => r.rule)).toEqual(["U"]);
    expect(s.problems).toHaveLength(1);
    expect(s.problems[0]).toMatchObject({ path: p.claudeProject(), key: null });
    expect(s.problems[0]?.message).toMatch(/not valid JSON/i);
  });

  test("a top level that is not an object is reported", async () => {
    await put(p.dawgUser(), "[1, 2]");
    const s = await load();
    expect(s.problems[0]).toMatchObject({ path: p.dawgUser(), key: null });
  });

  test("an empty file is not a problem", async () => {
    await put(p.dawgLocal(), "  \n");
    const s = await load();
    expect(s.problems).toEqual([]);
    expect(s.files[0]?.exists).toBe(true);
  });

  test("wrong types skip the key and keep the rest of the file", async () => {
    await put(p.claudeProject(), {
      permissions: {
        allow: "Bash",
        ask: ["Good", 42, "", null],
        deny: ["Read(./.env)"],
        defaultMode: 3,
        additionalDirectories: { a: 1 },
        disableBypassPermissionsMode: true,
      },
      env: { OK: "yes", NUM: 5, OBJ: {} },
    });
    const s = await load();
    expect(s.permissions.allow).toEqual([]);
    expect(s.permissions.ask.map((r) => r.rule)).toEqual(["Good"]);
    expect(s.permissions.deny.map((r) => r.rule)).toEqual(["Read(./.env)"]);
    expect(s.permissions.defaultMode).toBeNull();
    expect(s.permissions.additionalDirectories).toEqual([]);
    expect(s.permissions.bypassDisabled).toBe(false);
    expect(s.env).toEqual({ OK: "yes" });
    expect(s.problems.map((pr) => pr.key).sort()).toEqual(
      [
        "permissions.allow",
        "permissions.ask[1]",
        "permissions.ask[2]",
        "permissions.ask[3]",
        "permissions.defaultMode",
        "permissions.additionalDirectories",
        "permissions.disableBypassPermissionsMode",
        "env.NUM",
        "env.OBJ",
      ].sort(),
    );
    for (const problem of s.problems) expect(problem.path).toBe(p.claudeProject());
  });

  test("permissions and env that are not objects are reported", async () => {
    await put(p.dawgUser(), { permissions: ["Bash"], env: "A=1" });
    const s = await load();
    expect(s.problems.map((pr) => pr.key)).toEqual(["permissions", "env"]);
  });

  test("unsupported modes are problems; manual is an alias for default", async () => {
    await put(p.dawgProject(), { permissions: { defaultMode: "auto" } });
    await put(p.claudeUser(), { permissions: { defaultMode: "manual" } });
    const s = await load();
    expect(s.permissions.defaultMode).toBe("default");
    expect(s.problems).toHaveLength(1);
    expect(s.problems[0]).toMatchObject({ path: p.dawgProject(), key: "permissions.defaultMode" });
    expect(parsePermissionMode("manual")).toBe("default");
    expect(parsePermissionMode("bypassPermissions")).toBe("bypassPermissions");
    expect(parsePermissionMode("nonsense")).toBeNull();
  });

  test("a __proto__ env name stays an ordinary key", async () => {
    await put(p.dawgUser(), '{"env": {"__proto__": "x", "SAFE": "1"}}');
    const s = await load();
    expect(Object.getPrototypeOf(s.env)).toBe(Object.prototype);
    expect(Object.keys(s.env).sort()).toEqual(["SAFE", "__proto__"]);
  });
});

describe("ignored keys", () => {
  test("unused keys are recorded per file and never reach the settings", async () => {
    await put(p.claudeUser(), {
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      model: "some-hosted-model",
      apiKeyHelper: "/bin/get-key",
      hooks: {},
      permissions: { allow: ["Read"], disableAutoMode: "disable" },
      env: {
        ANTHROPIC_API_KEY: "secret-value",
        ANTHROPIC_BASE_URL: "https://example.invalid",
        CLAUDE_CODE_USE_BEDROCK: "1",
        NODE_ENV: "test",
      },
    });
    const s = await load();
    const file = s.files.find((f) => f.path === p.claudeUser());
    expect(file?.ignoredKeys).toEqual([
      "model",
      "apiKeyHelper",
      "hooks",
      "permissions.disableAutoMode",
      "env.ANTHROPIC_API_KEY",
      "env.ANTHROPIC_BASE_URL",
      "env.CLAUDE_CODE_USE_BEDROCK",
    ]);
    expect(s.env).toEqual({ NODE_ENV: "test" });
    expect(JSON.stringify(s)).not.toContain("secret-value");
    expect(JSON.stringify(s)).not.toContain("some-hosted-model");
    expect(s.problems).toEqual([]);
  });

  test("our own files may set any environment variable", async () => {
    await put(p.dawgUser(), { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" } });
    expect((await load()).env).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:1" });
  });
});

describe("bypass safety", () => {
  for (const [name, path] of [
    ["dawg local", p.dawgLocal],
    ["claude local", p.claudeLocal],
    ["dawg project", p.dawgProject],
    ["claude project", p.claudeProject],
  ] as const) {
    test(`bypassPermissions from the ${name} file is ignored and reported`, async () => {
      await put(path(), { permissions: { defaultMode: "bypassPermissions" } });
      await put(p.claudeUser(), { permissions: { defaultMode: "plan" } });
      const s = await load();
      expect(s.permissions.defaultMode).toBe("plan");
      expect(s.problems).toHaveLength(1);
      expect(s.problems[0]).toMatchObject({ path: path(), key: "permissions.defaultMode" });
    });
  }

  test("bypassPermissions is accepted from the user's files and from flags", async () => {
    await put(p.claudeUser(), { permissions: { defaultMode: "bypassPermissions" } });
    expect((await load()).permissions.defaultMode).toBe("bypassPermissions");
    await rm(p.claudeUser());
    await put(p.dawgUser(), { permissions: { defaultMode: "bypassPermissions" } });
    expect((await load()).permissions.defaultMode).toBe("bypassPermissions");
    await rm(p.dawgUser());
    const s = await load({ permissionMode: "bypassPermissions" });
    expect(s.permissions.defaultMode).toBe("bypassPermissions");
    expect(s.problems).toEqual([]);
  });

  test("disableBypassPermissionsMode from any level turns bypass off, including from flags", async () => {
    await put(p.claudeProject(), { permissions: { disableBypassPermissionsMode: "disable" } });
    await put(p.dawgUser(), { permissions: { defaultMode: "bypassPermissions" } });
    await put(p.claudeUser(), { permissions: { defaultMode: "acceptEdits" } });
    const s = await load({ permissionMode: "bypassPermissions" });
    expect(s.permissions.bypassDisabled).toBe(true);
    expect(s.permissions.defaultMode).toBe("acceptEdits");
    expect(s.problems.map((pr) => pr.path)).toEqual([FLAGS_PROBLEM_PATH, p.dawgUser()]);
  });

  test("a project that is the home directory reads its shared files once, as the user's", async () => {
    await put(p.claudeUser(), { permissions: { defaultMode: "bypassPermissions" } });
    const s = await loadSettings({ projectDir: home, homeDir: home });
    expect(s.permissions.defaultMode).toBe("bypassPermissions");
    expect(s.files.filter((f) => f.path === p.claudeUser())).toHaveLength(1);
  });
});

describe("additional directories", () => {
  test("resolved to absolute paths per level and de-duplicated", async () => {
    await put(p.claudeProject(), {
      permissions: { additionalDirectories: ["../docs/", "./lib", "~/shared", "/abs/x"] },
    });
    await put(p.claudeUser(), {
      permissions: { additionalDirectories: ["notes", "~/shared", "/abs/x/"] },
    });
    const s = await load({ addDirs: ["lib"] });
    expect(s.permissions.additionalDirectories).toEqual([
      join(project, "lib"),
      join(root, "work", "docs"),
      join(home, "shared"),
      "/abs/x",
      join(home, "notes"),
    ]);
  });
});

describe("parseRuleList", () => {
  test("one rule per value, keeping spaces and brackets inside the specifier", () => {
    expect(parseRuleList(["Bash(git log *)", "Bash(git diff *)", "Read"])).toEqual([
      "Bash(git log *)",
      "Bash(git diff *)",
      "Read",
    ]);
  });

  test("several rules in one value, separated by commas or spaces outside brackets", () => {
    expect(parseRuleList("Bash,Edit,Read")).toEqual(["Bash", "Edit", "Read"]);
    expect(parseRuleList("Read Edit  Bash(npm run test, lint)")).toEqual([
      "Read",
      "Edit",
      "Bash(npm run test, lint)",
    ]);
    expect(parseRuleList("Bash(echo $(date) [x]),Read(./photos [2024]/**)")).toEqual([
      "Bash(echo $(date) [x])",
      "Read(./photos [2024]/**)",
    ]);
  });

  test("duplicates and blanks are dropped; unbalanced brackets keep the value whole", () => {
    expect(parseRuleList(["Read", " Read ", "", " , "])).toEqual(["Read"]);
    expect(parseRuleList(["Bash(echo (oops"])).toEqual(["Bash(echo (oops"]);
  });
});

describe("addPermissionRules", () => {
  test("creates .dawg/settings.local.json when missing", async () => {
    const r = await addPermissionRules({
      projectDir: project,
      list: "allow",
      rules: ["Bash(npm test)"],
    });
    expect(r).toEqual({ path: p.dawgLocal(), added: ["Bash(npm test)"] });
    expect(JSON.parse(await readFile(p.dawgLocal(), "utf8"))).toEqual({
      permissions: { allow: ["Bash(npm test)"] },
    });
    const s = await load();
    expect(s.permissions.allow).toEqual([
      { rule: "Bash(npm test)", from: { source: "local", origin: "dawg", path: p.dawgLocal() } },
    ]);
  });

  test("appends, skips duplicates and keeps every other key", async () => {
    await put(p.dawgLocal(), {
      theme: "dark",
      env: { A: "1" },
      permissions: { allow: ["Read"], deny: ["Bash(rm *)"], extra: true },
    });
    const r = await addPermissionRules({
      projectDir: project,
      list: "allow",
      rules: ["Read", "Edit(src/**)", "Edit(src/**)", "Bash(git status)"],
    });
    expect(r.added).toEqual(["Edit(src/**)", "Bash(git status)"]);
    expect(JSON.parse(await readFile(p.dawgLocal(), "utf8"))).toEqual({
      theme: "dark",
      env: { A: "1" },
      permissions: {
        allow: ["Read", "Edit(src/**)", "Bash(git status)"],
        deny: ["Bash(rm *)"],
        extra: true,
      },
    });
    const again = await addPermissionRules({ projectDir: project, list: "allow", rules: ["Read"] });
    expect(again.added).toEqual([]);
  });

  test("concurrent calls do not lose rules", async () => {
    await Promise.all(
      ["A", "B", "C", "D", "E"].map((rule) =>
        addPermissionRules({ projectDir: project, list: "deny", rules: [rule] }),
      ),
    );
    const data = JSON.parse(await readFile(p.dawgLocal(), "utf8"));
    expect([...data.permissions.deny].sort()).toEqual(["A", "B", "C", "D", "E"]);
  });

  test("refuses to overwrite a file it cannot parse", async () => {
    await put(p.dawgLocal(), "{ not json");
    await expect(
      addPermissionRules({ projectDir: project, list: "allow", rules: ["Read"] }),
    ).rejects.toBeInstanceOf(SettingsWriteError);
    expect(await readFile(p.dawgLocal(), "utf8")).toBe("{ not json");
  });

  test("refuses to write under .claude, directly or through a link", async () => {
    const inside = join(home, ".claude", "proj");
    await mkdir(inside, { recursive: true });
    await expect(
      addPermissionRules({ projectDir: inside, list: "allow", rules: ["Read"] }),
    ).rejects.toBeInstanceOf(SettingsWriteError);

    await mkdir(join(project, ".claude"), { recursive: true });
    await symlink(join(project, ".claude"), join(project, ".dawg"));
    await expect(
      addPermissionRules({ projectDir: project, list: "allow", rules: ["Read"] }),
    ).rejects.toBeInstanceOf(SettingsWriteError);
    await expect(readFile(p.claudeLocal(), "utf8")).rejects.toThrow();
  });

  test("rejects empty rules", async () => {
    await expect(
      addPermissionRules({ projectDir: project, list: "ask", rules: [" "] }),
    ).rejects.toBeInstanceOf(SettingsWriteError);
  });
});
