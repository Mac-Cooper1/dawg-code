import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSettings } from "@dawg/compat";
import { PermissionModeSchema } from "@dawg/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DefaultModeSchema,
  type PermissionSettingsState,
  type PermissionsWriteInput,
  PermissionsWriteInputSchema,
} from "../shared/bridge.ts";
import type { PermissionSettingsService } from "./ipc-handlers.ts";
import {
  createPermissionSettingsService,
  loadRuleChecks,
  ruleError,
  sandboxAvailability,
} from "./permissions.ts";

let root: string;
let home: string;
let project: string;
let service: PermissionSettingsService;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-permissions-"));
  home = path.join(root, "home");
  project = path.join(root, "code", "tally");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  service = createPermissionSettingsService({ homeDir: home });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
}

async function json(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

/** As main receives it: validated by the bridge's schema. */
function write(input: PermissionsWriteInput): Promise<PermissionSettingsState> {
  return service.write(PermissionsWriteInputSchema.parse(input));
}

const files = {
  dawgLocal: () => path.join(project, ".dawg", "settings.local.json"),
  claudeLocal: () => path.join(project, ".claude", "settings.local.json"),
  dawgProject: () => path.join(project, ".dawg", "settings.json"),
  claudeProject: () => path.join(project, ".claude", "settings.json"),
  dawgUser: () => path.join(home, ".dawg", "settings.json"),
  claudeUser: () => path.join(home, ".claude", "settings.json"),
};

describe("the contract", () => {
  it("DefaultModeSchema lists exactly the protocol's permission modes", () => {
    expect([...DefaultModeSchema.options].sort()).toEqual([...PermissionModeSchema.options].sort());
  });
});

describe("read", () => {
  it("without a project lists only the person's files", async () => {
    const state = await service.read(null);
    expect(state).toEqual({
      projectDir: null,
      files: [
        {
          scope: "user",
          origin: "dawg",
          path: files.dawgUser(),
          exists: false,
          writable: true,
          defaultMode: null,
          allow: [],
          ask: [],
          deny: [],
          problems: [],
          sandbox: null,
        },
        {
          scope: "user",
          origin: "claude",
          path: files.claudeUser(),
          exists: false,
          writable: false,
          defaultMode: null,
          allow: [],
          ask: [],
          deny: [],
          problems: [],
          sandbox: null,
        },
      ],
      defaultMode: "default",
      bypassDisabled: false,
      // Added (Phase 4): the sandbox is off until a file turns it on.
      sandbox: {
        enabled: false,
        enabledBy: null,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: true,
        allowedDomains: [],
        deniedDomains: [],
        excludedCommands: [],
        ...sandboxAvailability(),
      },
    });
  });

  it("lists every file that applies, highest precedence first, Claude Code's read-only", async () => {
    await put(files.dawgLocal(), { permissions: { allow: ["Bash(npm test)"] } });
    await put(files.claudeProject(), {
      permissions: { deny: ["Read(./.env)"], defaultMode: "plan" },
    });
    await put(files.dawgUser(), { permissions: { defaultMode: "acceptEdits" } });
    const state = await service.read(project);
    expect(state.projectDir).toBe(project);
    expect(state.files.map((f) => [f.scope, f.origin, f.path, f.exists, f.writable])).toEqual([
      ["local", "dawg", files.dawgLocal(), true, true],
      ["local", "claude", files.claudeLocal(), false, false],
      ["project", "dawg", files.dawgProject(), false, true],
      ["project", "claude", files.claudeProject(), true, false],
      ["user", "dawg", files.dawgUser(), true, true],
      ["user", "claude", files.claudeUser(), false, false],
    ]);
    // The project's Claude Code file is more specific than the person's own.
    expect(state.defaultMode).toBe("plan");
    expect(state.files[3]).toMatchObject({ defaultMode: "plan", deny: ["Read(./.env)"] });
  });

  it("reports problems as sentences: the file's, ignored values and rules that never match", async () => {
    await put(files.dawgLocal(), {
      permissions: {
        defaultMode: "bypassPermissions",
        allow: ["Glob(src/**)", "Bash(npm *)", "Bash(git * main)"],
        deny: ["Bash(oops"],
      },
    });
    await put(files.dawgProject(), "{ broken");
    await put(files.dawgUser(), { permissions: { disableBypassPermissionsMode: "disable" } });
    const state = await service.read(project);
    const local = state.files[0];
    expect(local?.writable).toBe(true);
    expect(local?.problems).toEqual([
      expect.stringMatching(
        /^permissions\.defaultMode: A project's own settings cannot start sessions in bypassPermissions mode; ignored\./,
      ),
      'Deny rule Bash(oops: Malformed rule: rules take the form Tool or Tool(content) and must end at the closing ")".',
      "Allow rule Glob(src/**): Glob(path) allow rules never match; use Read(...) instead.",
      "Allow rule Bash(git * main): This allow rule has a * before the rest of the command, so it also approves any options inserted there.",
    ]);
    const shared = state.files[2];
    expect(shared?.writable).toBe(false);
    expect(shared?.problems).toEqual([expect.stringMatching(/^Not valid JSON, file skipped/)]);
    expect(state.bypassDisabled).toBe(true);
    expect(state.defaultMode).toBe("default");
  });

  it("a dawg file that leads into .claude is read-only and says why", async () => {
    await mkdir(path.join(project, ".claude"), { recursive: true });
    await symlink(path.join(project, ".claude"), path.join(project, ".dawg"));
    const state = await service.read(project);
    expect(state.files[0]).toMatchObject({ origin: "dawg", writable: false });
    expect(state.files[0]?.problems).toEqual([
      expect.stringMatching(/^Refusing to write under a \.claude directory/),
    ]);
  });
});

describe("write", () => {
  it("adds rules and a default mode, creating .dawg, and answers with a fresh read", async () => {
    const state = await write({
      scope: "local",
      projectDir: project,
      defaultMode: "acceptEdits",
      allow: ["Bash(npm run test *)"],
    });
    expect(await json(files.dawgLocal())).toEqual({
      permissions: { defaultMode: "acceptEdits", allow: ["Bash(npm run test *)"] },
    });
    expect(state.files[0]).toMatchObject({
      exists: true,
      defaultMode: "acceptEdits",
      allow: ["Bash(npm run test *)"],
    });
    expect(state.defaultMode).toBe("acceptEdits");
    // What sessions load agrees.
    const loaded = await loadSettings({ projectDir: project, homeDir: home });
    expect(loaded.permissions.defaultMode).toBe("acceptEdits");
    expect(loaded.permissions.allow.map((r) => r.rule)).toEqual(["Bash(npm run test *)"]);
  });

  it("writes each scope to its own file and keeps other keys", async () => {
    await put(files.dawgProject(), { env: { CI: "1" }, permissions: { allow: ["Read"] } });
    await write({ scope: "project", projectDir: project, deny: ["Bash(rm *)"] });
    await write({ scope: "user", projectDir: null, ask: ["Bash(git push *)"] });
    expect(await json(files.dawgProject())).toEqual({
      env: { CI: "1" },
      permissions: { allow: ["Read"], deny: ["Bash(rm *)"] },
    });
    expect(await json(files.dawgUser())).toEqual({ permissions: { ask: ["Bash(git push *)"] } });
  });

  it("removes the default mode with null and moves a rule between lists", async () => {
    await put(files.dawgUser(), { permissions: { defaultMode: "plan", allow: ["WebFetch"] } });
    const state = await write({
      scope: "user",
      projectDir: project,
      defaultMode: null,
      allow: [],
      deny: ["WebFetch"],
    });
    expect(await json(files.dawgUser())).toEqual({ permissions: { deny: ["WebFetch"] } });
    // Answered for the project the page shows.
    expect(state.projectDir).toBe(project);
    expect(state.files).toHaveLength(6);
  });

  it("rejects a rule that does not parse, or that the list would skip, with the rule first", async () => {
    await expect(
      write({ scope: "local", projectDir: project, allow: ["Bash(npm"] }),
    ).rejects.toThrow(
      'Bash(npm: Malformed rule: rules take the form Tool or Tool(content) and must end at the closing ")".',
    );
    await expect(
      write({ scope: "local", projectDir: project, allow: ["Glob(src/**)"] }),
    ).rejects.toThrow("Glob(src/**): Glob(path) allow rules never match; use Read(...) instead.");
    await expect(
      write({ scope: "local", projectDir: project, deny: ["Not a tool"] }),
    ).rejects.toThrow('"Not a tool" is not a tool name.');
    // Nothing was written.
    await expect(readFile(files.dawgLocal(), "utf8")).rejects.toThrow();
    // The same rule is fine where it applies.
    await write({ scope: "local", projectDir: project, deny: ["Glob(src/**)"] });
    expect(await json(files.dawgLocal())).toEqual({ permissions: { deny: ["Glob(src/**)"] } });
  });

  it("leaves rules already in the list alone, even ones that never worked", async () => {
    await put(files.dawgLocal(), { permissions: { allow: ["Glob(old/**)"] } });
    await write({ scope: "local", projectDir: project, allow: ["Glob(old/**)", "Read"] });
    expect(await json(files.dawgLocal())).toEqual({
      permissions: { allow: ["Glob(old/**)", "Read"] },
    });
  });

  it("needs a project for the project scopes", async () => {
    await expect(write({ scope: "local", projectDir: null, allow: ["Read"] })).rejects.toThrow(
      "Choose a project to change its settings.",
    );
    await expect(write({ scope: "project", projectDir: null, allow: ["Read"] })).rejects.toThrow(
      "Choose a project to change its settings.",
    );
  });

  it("keeps bypassPermissions as a default mode to the person's own settings", async () => {
    await expect(
      write({ scope: "project", projectDir: project, defaultMode: "bypassPermissions" }),
    ).rejects.toThrow(/^Only your own settings can start sessions in bypassPermissions mode/);
    const state = await write({
      scope: "user",
      projectDir: null,
      defaultMode: "bypassPermissions",
    });
    expect(state.defaultMode).toBe("bypassPermissions");
  });

  it("refuses a file it cannot parse, with the compat sentence and no class name", async () => {
    await put(files.dawgLocal(), "[1]");
    const attempt = write({ scope: "local", projectDir: project, allow: ["Read"] });
    await expect(attempt).rejects.toThrow(
      `${files.dawgLocal()} does not hold a JSON object; fix it by hand first.`,
    );
    await expect(attempt).rejects.not.toHaveProperty("name", "SettingsWriteError");
    expect(await readFile(files.dawgLocal(), "utf8")).toBe("[1]");
  });

  it("never writes Claude Code's files, even through a link", async () => {
    await put(files.claudeLocal(), { permissions: { allow: ["Read"] } });
    await symlink(path.join(project, ".claude"), path.join(project, ".dawg"));
    await expect(write({ scope: "local", projectDir: project, allow: ["Edit"] })).rejects.toThrow(
      /Refusing to write under a \.claude directory/,
    );
    expect(await json(files.claudeLocal())).toEqual({ permissions: { allow: ["Read"] } });
  });
});

describe("checkRule", () => {
  it("is null for a rule that parses and a sentence for one that does not", async () => {
    expect(await service.checkRule("Bash(npm run test *)")).toBeNull();
    expect(await service.checkRule("Read(./secrets/**)")).toBeNull();
    expect(await service.checkRule("WebFetch")).toBeNull();
    expect(await service.checkRule("mcp__github__*")).toBeNull();
    expect(await service.checkRule("Bash(npm")).toBe(
      'Malformed rule: rules take the form Tool or Tool(content) and must end at the closing ")".',
    );
    expect(await service.checkRule("Bash()")).toBe("The part in parentheses is empty.");
    expect(await service.checkRule("mcp__github__create(x)")).toBe(
      "Rules for MCP tools take no part in parentheses.",
    );
  });

  it("ruleError checks the list's own limits", async () => {
    const checks = await loadRuleChecks();
    expect(ruleError(checks, "Read(!./src/**)", "deny")).toBeNull();
    expect(ruleError(checks, "Read(!./src/**)", "allow")).toBe(
      "A ! pattern only carves exceptions out of deny and ask rules.",
    );
  });
});

describe("the sandbox", () => {
  it("reads each file's sandbox key and every file merged", async () => {
    await put(files.claudeUser(), {
      sandbox: { enabled: true, network: { allowedDomains: ["github.com"] } },
    });
    await put(files.dawgProject(), {
      sandbox: { excludedCommands: ["docker *"], network: { deniedDomains: ["x.github.com"] } },
    });
    const state = await service.read(project);
    expect(state.files.find((f) => f.path === files.claudeUser())?.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: null,
      allowUnsandboxedCommands: null,
      allowedDomains: ["github.com"],
      excludedCommands: [],
    });
    expect(state.sandbox).toMatchObject({
      enabled: true,
      enabledBy: files.claudeUser(),
      allowedDomains: ["github.com"],
      deniedDomains: ["x.github.com"],
      excludedCommands: ["docker *"],
    });
  });

  it("writes the sandbox key of dawg's file, keeping the rest", async () => {
    await put(files.dawgLocal(), { permissions: { allow: ["Bash(ls)"] }, theme: "dark" });
    const state = await write({
      scope: "local",
      projectDir: project,
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowedDomains: ["registry.npmjs.org"],
      },
    });
    expect(state.sandbox).toMatchObject({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowedDomains: ["registry.npmjs.org"],
    });
    expect(await json(files.dawgLocal())).toEqual({
      permissions: { allow: ["Bash(ls)"] },
      theme: "dark",
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        network: { allowedDomains: ["registry.npmjs.org"] },
      },
    });
  });

  it("refuses auto-allow in a project's shared file, and a bad host", async () => {
    await expect(
      write({ scope: "project", projectDir: project, sandbox: { autoAllowBashIfSandboxed: true } }),
    ).rejects.toThrow("Only your own settings can run sandboxed commands without asking");
    await expect(
      write({ scope: "user", projectDir: null, sandbox: { allowedDomains: ["https://a.com"] } }),
    ).rejects.toThrow("is a URL");
  });

  it("says where the sandbox can run", () => {
    expect(sandboxAvailability("darwin", () => true)).toEqual({
      available: true,
      unavailableReason: null,
    });
    expect(sandboxAvailability("darwin", () => false).available).toBe(false);
    expect(sandboxAvailability("linux", () => true)).toEqual({
      available: false,
      unavailableReason: "The sandbox runs on macOS only in the app.",
    });
  });
});
