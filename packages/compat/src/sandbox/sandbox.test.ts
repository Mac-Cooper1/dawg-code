import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readSettingsFiles } from "../settings/files.ts";
import { loadSettings } from "../settings/load.ts";
import { SettingsWriteError } from "../settings/write.ts";
import { domainEntryProblem, parseSandboxSettings, resolveSandboxPath } from "./settings.ts";
import { updateSandboxSettings } from "./write.ts";

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dawg-compat-sandbox-"));
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

const files = {
  dawgLocal: () => join(project, ".dawg", "settings.local.json"),
  claudeLocal: () => join(project, ".claude", "settings.local.json"),
  dawgProject: () => join(project, ".dawg", "settings.json"),
  claudeProject: () => join(project, ".claude", "settings.json"),
  dawgUser: () => join(home, ".dawg", "settings.json"),
  claudeUser: () => join(home, ".claude", "settings.json"),
};

const load = async (flags?: { sandbox?: boolean }) => {
  const settings = await loadSettings({ projectDir: project, homeDir: home, flags });
  if (settings.sandbox === undefined) throw new Error("no sandbox settings");
  return { settings, sandbox: settings.sandbox };
};

describe("sandbox settings: defaults and precedence", () => {
  test("off by default, as documented", async () => {
    const { sandbox, settings } = await load();
    expect(sandbox.enabled).toBe(false);
    expect(sandbox.enabledBy).toBeNull();
    expect(sandbox.autoAllowBashIfSandboxed).toBe(false);
    expect(sandbox.allowUnsandboxedCommands).toBe(true);
    expect(sandbox.failIfUnavailable).toBe(false);
    expect(sandbox.network.allowedDomains).toEqual([]);
    expect(settings.problems).toEqual([]);
  });

  test("the person's file turns it on; the sandbox key is not reported as ignored", async () => {
    await put(files.claudeUser(), { sandbox: { enabled: true } });
    const { sandbox, settings } = await load();
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.enabledBy).toBe(files.claudeUser());
    expect(settings.files.find((f) => f.path === files.claudeUser())?.ignoredKeys).toEqual([]);
  });

  test("the highest-precedence file that sets a boolean decides; dawg's beats Claude Code's", async () => {
    await put(files.claudeUser(), { sandbox: { enabled: true, failIfUnavailable: true } });
    await put(files.claudeProject(), { sandbox: { enabled: false } });
    await put(files.dawgLocal(), { sandbox: { enabled: true } });
    await put(files.claudeLocal(), { sandbox: { enabled: false } });
    const { sandbox } = await load();
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.enabledBy).toBe(files.dawgLocal());
    expect(sandbox.failIfUnavailable).toBe(true);
  });

  test("--sandbox turns it on over every file", async () => {
    await put(files.dawgLocal(), { sandbox: { enabled: false } });
    const { sandbox } = await load({ sandbox: true });
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.enabledBy).toBe("<command line>");
  });

  test("lists merge across files without duplicates", async () => {
    await put(files.claudeUser(), {
      sandbox: {
        excludedCommands: ["docker *"],
        network: { allowedDomains: ["github.com", "*.npmjs.org"], deniedDomains: ["a.github.com"] },
      },
    });
    await put(files.dawgProject(), {
      sandbox: {
        excludedCommands: ["docker *", "podman *"],
        network: { allowedDomains: ["GitHub.com", "registry.example.org:443"] },
      },
    });
    const { sandbox } = await load();
    expect(sandbox.excludedCommands).toEqual(["docker *", "podman *"]);
    expect(sandbox.network.allowedDomains).toEqual([
      "github.com",
      "registry.example.org:443",
      "*.npmjs.org",
    ]);
    expect(sandbox.network.deniedDomains).toEqual(["a.github.com"]);
  });

  test("a false allowUnsandboxedCommands in the person's file beats a project's true", async () => {
    await put(files.claudeUser(), { sandbox: { allowUnsandboxedCommands: false } });
    await put(files.claudeProject(), { sandbox: { allowUnsandboxedCommands: true } });
    expect((await load()).sandbox.allowUnsandboxedCommands).toBe(false);
  });
});

describe("sandbox settings: what a project's files may set", () => {
  test("a project's shared file cannot turn on auto-allow or loosen isolation", async () => {
    await put(files.claudeProject(), {
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        enableWeakerNetworkIsolation: true,
        allowAppleEvents: true,
        network: {
          allowLocalBinding: true,
          allowAllUnixSockets: true,
          allowUnixSockets: ["/var/run/docker.sock"],
          allowMachLookup: ["com.apple.coresimulator.*"],
        },
        filesystem: { disabled: true },
      },
    });
    const { sandbox } = await load();
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.autoAllowBashIfSandboxed).toBe(false);
    expect(sandbox.enableWeakerNetworkIsolation).toBe(false);
    expect(sandbox.allowAppleEvents).toBe(false);
    expect(sandbox.network.allowLocalBinding).toBe(false);
    expect(sandbox.network.allowAllUnixSockets).toBe(false);
    expect(sandbox.network.allowUnixSockets).toEqual([]);
    expect(sandbox.network.allowMachLookup).toEqual([]);
    expect(sandbox.filesystem.disabled).toBe(false);
  });

  test("a project's personal file may turn on auto-allow, but not user-only keys", async () => {
    await put(files.dawgLocal(), {
      sandbox: { autoAllowBashIfSandboxed: true, allowAppleEvents: true },
    });
    const { sandbox } = await load();
    expect(sandbox.autoAllowBashIfSandboxed).toBe(true);
    expect(sandbox.allowAppleEvents).toBe(false);
  });

  test("a project's shared false still turns auto-allow off over the person's true", async () => {
    await put(files.claudeUser(), { sandbox: { autoAllowBashIfSandboxed: true } });
    await put(files.claudeProject(), { sandbox: { autoAllowBashIfSandboxed: false } });
    expect((await load()).sandbox.autoAllowBashIfSandboxed).toBe(false);
  });

  test("the person's own file may loosen what it documents", async () => {
    await put(files.dawgUser(), {
      sandbox: {
        autoAllowBashIfSandboxed: true,
        allowAppleEvents: true,
        network: { allowLocalBinding: true, allowUnixSockets: ["~/.docker/run/docker.sock"] },
      },
    });
    const { sandbox } = await load();
    expect(sandbox.autoAllowBashIfSandboxed).toBe(true);
    expect(sandbox.allowAppleEvents).toBe(true);
    expect(sandbox.network.allowLocalBinding).toBe(true);
    expect(sandbox.network.allowUnixSockets).toEqual([join(home, ".docker/run/docker.sock")]);
  });

  test("a project's shared file opens writes inside the project only", async () => {
    await put(files.claudeProject(), {
      sandbox: { filesystem: { allowWrite: ["./build", "/etc", "~/.kube", "../sibling"] } },
    });
    await put(files.dawgLocal(), { sandbox: { filesystem: { allowWrite: ["~/.cache/x"] } } });
    const { sandbox } = await load();
    expect(sandbox.filesystem.allowWrite).toEqual([join(home, ".cache/x"), join(project, "build")]);
  });
});

describe("sandbox settings: paths and values", () => {
  test("paths resolve as documented", () => {
    expect(resolveSandboxPath("/tmp/build/", "/base", "/h")).toBe("/tmp/build");
    expect(resolveSandboxPath("//tmp/build", "/base", "/h")).toBe("/tmp/build");
    expect(resolveSandboxPath("~/.kube", "/base", "/h")).toBe("/h/.kube");
    expect(resolveSandboxPath("~", "/base", "/h")).toBe("/h");
    expect(resolveSandboxPath("./output", "/base", "/h")).toBe("/base/output");
    expect(resolveSandboxPath("secrets/**", "/base", "/h")).toBe("/base/secrets/**");
  });

  test("relative paths in the person's files resolve against the folder the file is in", async () => {
    await put(files.claudeUser(), { sandbox: { filesystem: { denyRead: ["./secrets", "x"] } } });
    await put(files.dawgUser(), { sandbox: { filesystem: { denyWrite: ["./notes"] } } });
    await put(files.claudeProject(), { sandbox: { filesystem: { denyRead: [".env"] } } });
    const { sandbox } = await load();
    expect(sandbox.filesystem.denyRead).toEqual([
      join(project, ".env"),
      join(home, ".claude", "secrets"),
      join(home, ".claude", "x"),
    ]);
    expect(sandbox.filesystem.denyWrite).toEqual([join(home, ".dawg", "notes")]);
  });

  test("bad values are problems and skipped; the rest of the key still counts", async () => {
    await put(files.claudeUser(), {
      sandbox: {
        enabled: "yes",
        excludedCommands: "docker *",
        network: { allowedDomains: ["https://github.com", "*", "ok.example.com", 3] },
        filesystem: { allowWrite: ["/tmp/ok"] },
      },
    });
    const { sandbox, settings } = await load();
    expect(sandbox.enabled).toBe(false);
    expect(sandbox.network.allowedDomains).toEqual(["ok.example.com"]);
    expect(sandbox.filesystem.allowWrite).toEqual(["/tmp/ok"]);
    const keys = settings.problems.map((p) => p.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "sandbox.enabled",
        "sandbox.excludedCommands",
        "sandbox.network.allowedDomains",
        "sandbox.network.allowedDomains[3]",
      ]),
    );
  });

  test("domain entries are checked as documented", () => {
    expect(domainEntryProblem("github.com")).toBeNull();
    expect(domainEntryProblem("*.npmjs.org")).toBeNull();
    expect(domainEntryProblem("api.example.com:443")).toBeNull();
    expect(domainEntryProblem("[::1]:8080")).toBeNull();
    expect(domainEntryProblem("127.0.0.1:3000")).toBeNull();
    expect(domainEntryProblem("https://github.com")).toMatch(/URL/);
    expect(domainEntryProblem("*")).toMatch(/every host/);
    expect(domainEntryProblem("a b.com")).not.toBeNull();
    expect(domainEntryProblem("x.com:70000")).toMatch(/port/);
  });

  test("credential entries: deny kept, mask kept as deny with a note, others reported", () => {
    const { settings, problems } = parseSandboxSettings(
      {
        credentials: {
          files: [
            { path: "~/.aws/credentials", mode: "deny" },
            { path: "~/.netrc", mode: "mask" },
          ],
          envVars: [
            { name: "GITHUB_TOKEN", mode: "deny" },
            { name: "X", mode: "hide" },
          ],
          awsPairs: [],
        },
      },
      "/f.json",
    );
    expect(settings.credentials).toEqual({
      files: ["~/.aws/credentials", "~/.netrc"],
      envVars: ["GITHUB_TOKEN"],
    });
    expect(settings.ignored.map((i) => i.key)).toEqual([
      "sandbox.credentials.files",
      "sandbox.credentials.awsPairs",
    ]);
    expect(problems.map((p) => p.key)).toEqual(["sandbox.credentials.envVars[1].mode"]);
  });

  test("a sandbox value that is not an object is a problem", async () => {
    await put(files.claudeUser(), { sandbox: true });
    const { sandbox, settings } = await load();
    expect(sandbox.enabled).toBe(false);
    expect(settings.problems).toEqual([
      { path: files.claudeUser(), key: "sandbox", message: "Expected an object, found a boolean." },
    ]);
  });
});

describe("updateSandboxSettings", () => {
  test("writes the keys given and keeps every other key in its place", async () => {
    await put(files.dawgLocal(), {
      permissions: { allow: ["Bash(ls)"] },
      sandbox: { failIfUnavailable: true, network: { deniedDomains: ["x.org"] } },
      theme: "dark",
    });
    const result = await updateSandboxSettings({
      file: files.dawgLocal(),
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowedDomains: ["GitHub.com", "github.com", "*.npmjs.org"],
      excludedCommands: ["docker *"],
    });
    expect(result.changed).toBe(true);
    const data = JSON.parse(await readFile(files.dawgLocal(), "utf8"));
    expect(Object.keys(data)).toEqual(["permissions", "sandbox", "theme"]);
    expect(data.sandbox).toEqual({
      failIfUnavailable: true,
      network: { deniedDomains: ["x.org"], allowedDomains: ["github.com", "*.npmjs.org"] },
      enabled: true,
      autoAllowBashIfSandboxed: true,
      excludedCommands: ["docker *"],
    });
    const state = await readSettingsFiles({ projectDir: project, homeDir: home });
    expect(state.sandbox.enabled).toBe(true);
    expect(state.sandbox.network.allowedDomains).toEqual(["github.com", "*.npmjs.org"]);
  });

  test("null and empty lists remove keys, and an empty sandbox object goes", async () => {
    await put(files.dawgUser(), {
      sandbox: { enabled: true, network: { allowedDomains: ["a.com"] } },
    });
    await updateSandboxSettings({ file: files.dawgUser(), enabled: null, allowedDomains: [] });
    const data = JSON.parse(await readFile(files.dawgUser(), "utf8"));
    expect(data).toEqual({});
  });

  test("nothing to change writes nothing, and no file is created to remove a key", async () => {
    const result = await updateSandboxSettings({ file: files.dawgLocal(), enabled: null });
    expect(result.changed).toBe(false);
    await expect(readFile(files.dawgLocal(), "utf8")).rejects.toThrow();
  });

  test("refuses a bad domain, Claude Code's files and a file it cannot parse", async () => {
    await expect(
      updateSandboxSettings({ file: files.dawgLocal(), allowedDomains: ["https://a.com"] }),
    ).rejects.toBeInstanceOf(SettingsWriteError);
    await expect(
      updateSandboxSettings({ file: files.claudeLocal(), enabled: true }),
    ).rejects.toBeInstanceOf(SettingsWriteError);
    await put(files.dawgProject(), "{ not json");
    await expect(
      updateSandboxSettings({ file: files.dawgProject(), enabled: true }),
    ).rejects.toBeInstanceOf(SettingsWriteError);
    await put(files.dawgUser(), { sandbox: [] });
    await expect(updateSandboxSettings({ file: files.dawgUser(), enabled: true })).rejects.toThrow(
      /not an object/,
    );
  });
});
