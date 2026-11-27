/**
 * The sandbox for real: these run commands under the actual sandbox runtime (Seatbelt on macOS)
 * and check what reaches the disk and the network, not what the code meant to do. Elsewhere they
 * are skipped; the parts that need no runtime are tested apart.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultSandboxSettings, type PermissionRule, type SandboxSettings } from "@dawg/compat";
import type { CommandDisplay } from "@dawg/protocol";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolOutput } from "../contracts/tools.ts";
import { createStateBag, createTestToolContext } from "../testing/context.ts";
import { getBackgroundTasks } from "../tools/bash/background.ts";
import { type BashInput, createBashTool } from "../tools/bash/bash.ts";
import { isExcludedCommand } from "./excluded.ts";
import { rulesForSandbox, sandboxPathsForRule } from "./rules.ts";
import { type SandboxAvailability, SandboxHost } from "./runtime.ts";
import { refusedInOutput, SANDBOX_STATE_KEY, SessionSandbox } from "./session.ts";
import { describeViolation, describeViolations } from "./violations.ts";

const onMac = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

let root: string;
let project: string;
let outside: string;
let host: SandboxHost;

function settings(overrides: Partial<SandboxSettings> = {}): SandboxSettings {
  return { ...defaultSandboxSettings(), enabled: true, ...overrides };
}

function text(out: ToolOutput): string {
  const part = out.content[0];
  return part?.type === "text" ? part.text : "";
}

/** A session with the sandbox on: calls share one state bag, as the turn loop makes them. */
function session(
  s: SandboxSettings,
  rules: { allow: PermissionRule[]; deny: PermissionRule[] } = { allow: [], deny: [] },
) {
  const state = createStateBag();
  state.get(
    SANDBOX_STATE_KEY,
    () =>
      new SessionSandbox({
        host,
        settings: () => s,
        rules: () => rules,
        homeDir: path.join(root, "home"),
      }),
  );
  const tool = createBashTool({ killGraceMs: 300 });
  return {
    state,
    tool,
    async call(input: BashInput) {
      const test = await createTestToolContext({ cwd: project, state });
      try {
        const subject = tool.permission(input, test.ctx);
        const out = await tool.execute(input, test.ctx);
        return { out, text: text(out), display: out.display as CommandDisplay, subject };
      } finally {
        await test.cleanup();
      }
    },
  };
}

beforeAll(() => {
  host = new SandboxHost();
});
afterAll(async () => {
  await host.close();
});
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "dawg-sandbox-test-")));
  project = path.join(root, "project");
  outside = path.join(root, "outside");
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!onMac)("sandboxed commands on this Mac", () => {
  it("cannot write outside the project or temp, and the result says so", async () => {
    const target = path.join(outside, "escaped.txt");
    const {
      out,
      text: said,
      display,
    } = await session(settings()).call({
      command: `echo hi > '${target}'`,
    });
    expect(existsSync(target)).toBe(false);
    expect(out.isError).toBe(true);
    expect(display.sandbox).toMatchObject({ placement: "inside", reason: null });
    expect(display.sandbox?.blocked).toContain(`Writing ${target}`);
    expect(said).toContain("The sandbox blocked this command");
    expect(said).toContain("dangerouslyDisableSandbox");
  });

  it("can write inside the project and in its temp folder", async () => {
    const {
      out,
      text: said,
      display,
    } = await session(settings()).call({
      command: `echo in > made.txt && mkdir -p deep/er && echo t > "$TMPDIR/t.txt" && cat "$TMPDIR/t.txt" && echo "$TMPDIR"`,
    });
    expect(out.isError).toBe(false);
    expect(await readFile(path.join(project, "made.txt"), "utf8")).toBe("in\n");
    expect(said.split("\n")[0]).toBe("t");
    const tempDir = said.split("\n")[1] ?? "";
    expect(path.basename(tempDir)).toMatch(/^dawg-sandbox-/);
    expect(tempDir.startsWith(path.join(process.env.HOME ?? "/nonexistent", "."))).toBe(false);
    expect(display.sandbox).toEqual({ placement: "inside", reason: null, blocked: [] });
  });

  it("keeps the working directory between calls, as outside the sandbox", async () => {
    const s = session(settings());
    await mkdir(path.join(project, "sub"));
    await s.call({ command: "cd sub" });
    const { text: said } = await s.call({ command: "pwd" });
    expect(said).toBe(path.join(project, "sub"));
  });

  it("keeps files that can run code read-only, inside the project too", async () => {
    await mkdir(path.join(project, ".git", "hooks"), { recursive: true });
    await mkdir(path.join(project, "nested", ".dawg"), { recursive: true });
    const { display } = await session(settings()).call({
      command:
        "echo x >> .bashrc; echo x > .git/hooks/pre-commit; echo x > nested/.dawg/settings.json; echo '{}' > .mcp.json; true",
    });
    expect(existsSync(path.join(project, ".bashrc"))).toBe(false);
    expect(existsSync(path.join(project, ".git", "hooks", "pre-commit"))).toBe(false);
    expect(existsSync(path.join(project, "nested", ".dawg", "settings.json"))).toBe(false);
    expect(existsSync(path.join(project, ".mcp.json"))).toBe(false);
    expect(display.sandbox?.placement).toBe("inside");
  });

  it("honours denyRead and Read deny rules", async () => {
    await writeFile(path.join(project, ".env"), "SECRET=1\n");
    await writeFile(path.join(outside, "key.pem"), "KEY\n");
    const deny: PermissionRule[] = [
      { rule: "Read(.env)", from: { source: "project", origin: "dawg", path: null } },
    ];
    const s = session(
      settings({ filesystem: { ...defaultSandboxSettings().filesystem, denyRead: [outside] } }),
      { allow: [], deny },
    );
    // The tool is called directly here, with no permission check: the OS refuses the reads.
    const { text: said, display } = await s.call({
      command: `cat .env; cat '${outside}/key.pem'; true`,
    });
    expect(said).not.toContain("SECRET=1");
    expect(said).not.toContain("KEY");
    expect(said).toContain("Operation not permitted");
    expect(display.sandbox?.blocked).toEqual(
      expect.arrayContaining([`Reading ${path.join(outside, "key.pem")}`]),
    );
    // Without them, the same command reads both.
    const open = await session(settings()).call({ command: `cat .env '${outside}/key.pem'` });
    expect(open.text).toContain("SECRET=1");
    expect(open.text).toContain("KEY");
  });

  describe("the network", () => {
    let server: http.Server;
    let other: http.Server;
    let port: number;
    let otherPort: number;
    beforeAll(async () => {
      const start = async () => {
        const s = http.createServer((_req, res) => res.end("hello from the test server\n"));
        await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
        return s;
      };
      server = await start();
      other = await start();
      port = (server.address() as AddressInfo).port;
      otherPort = (other.address() as AddressInfo).port;
    });
    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
      await new Promise((resolve) => other.close(resolve));
    });

    // Through the proxy (NO_PROXY cleared, since it names 127.0.0.1); the test-only allow-list
    // names the local server by its address and port, which the proxy's checks accept.
    const curl = (p: number) =>
      `env -u NO_PROXY -u no_proxy curl -sS -m 10 http://127.0.0.1:${p}/ 2>&1`;

    it("reaches a listed host but not an unlisted one", async () => {
      const s = session(
        settings({
          network: { ...defaultSandboxSettings().network, allowedDomains: [`127.0.0.1:${port}`] },
        }),
      );
      const allowed = await s.call({ command: curl(port) });
      expect(allowed.text).toContain("hello from the test server");
      const refused = await s.call({ command: curl(otherPort) });
      expect(refused.text).not.toContain("hello from the test server");
      expect(refused.display.sandbox?.blocked).toContain(
        `Connecting to 127.0.0.1:${otherPort} (not on the allowed list)`,
      );
      expect(refused.text).toContain(`reach only these hosts: 127.0.0.1:${port}`);
    });

    it("cannot go around the proxy", async () => {
      const s = session(
        settings({
          network: { ...defaultSandboxSettings().network, allowedDomains: [`127.0.0.1:${port}`] },
        }),
      );
      const direct = await s.call({ command: `curl -sS -m 5 http://127.0.0.1:${port}/ 2>&1` });
      expect(direct.text).not.toContain("hello from the test server");
    });

    it("reaches nothing with an empty list, and a deny beats an allow", async () => {
      const none = await session(settings()).call({ command: curl(port) });
      expect(none.text).not.toContain("hello from the test server");
      expect(none.text).toContain("reach only no hosts at all");
      const denied = await session(
        settings({
          network: {
            ...defaultSandboxSettings().network,
            allowedDomains: [`127.0.0.1:${port}`],
            deniedDomains: [`127.0.0.1:${port}`],
          },
        }),
      ).call({ command: curl(port) });
      expect(denied.text).not.toContain("hello from the test server");
    });

    it("takes the person's WebFetch domain rules into the allow-list, not a project's unapproved", async () => {
      const rule = `WebFetch(domain:127.0.0.1:${port})`;
      const mine: PermissionRule[] = [
        {
          rule,
          from: {
            source: "user",
            origin: "dawg",
            path: path.join(root, "home", ".dawg", "settings.json"),
          },
        },
      ];
      const { text: said } = await session(settings(), { allow: mine, deny: [] }).call({
        command: curl(port),
      });
      expect(said).toContain("hello from the test server");
      const theirs: PermissionRule[] = [
        {
          rule,
          from: {
            source: "project",
            origin: "claude",
            path: path.join(project, ".claude", "settings.json"),
          },
        },
      ];
      const refused = await session(settings(), { allow: theirs, deny: [] }).call({
        command: curl(port),
      });
      expect(refused.text).not.toContain("hello from the test server");
      expect(refused.text).toContain(
        `also list 127.0.0.1:${port}, which the person has not approved yet`,
      );
    });
  });

  it("runs background commands in the sandbox too", async () => {
    const target = path.join(outside, "bg.txt");
    const s = session(settings());
    const { display } = await s.call({
      command: `echo bg > inside-bg.txt; echo x > '${target}'`,
      run_in_background: true,
    });
    expect(display.sandbox).toEqual({ placement: "inside", reason: null, blocked: [] });
    const tasks = getBackgroundTasks(s.state);
    const id = display.backgroundTaskId ?? "";
    await tasks.waitFor(id, 10_000, new AbortController().signal);
    expect(await readFile(path.join(project, "inside-bg.txt"), "utf8")).toBe("bg\n");
    expect(existsSync(target)).toBe(false);
  });

  it("retries outside the sandbox only when asked, and says so", async () => {
    const target = path.join(outside, "retried.txt");
    const s = session(settings());
    const { subject, display } = await s.call({
      command: `echo hi > '${target}'`,
      dangerouslyDisableSandbox: true,
    });
    expect(subject).toMatchObject({ kind: "command", sandbox: { run: "outside", why: "retry" } });
    expect(display.sandbox).toEqual({ placement: "outside", reason: "retry", blocked: [] });
    expect(existsSync(target)).toBe(true);
  });

  it("ignores the retry when running outside is turned off", async () => {
    const target = path.join(outside, "strict.txt");
    const s = session(settings({ allowUnsandboxedCommands: false }));
    const { subject, text: said } = await s.call({
      command: `echo hi > '${target}'`,
      dangerouslyDisableSandbox: true,
    });
    expect(subject).toMatchObject({ sandbox: { run: "inside" } });
    expect(existsSync(target)).toBe(false);
    expect(said).toContain("Running commands outside the sandbox is turned off here");
  });

  it("runs excluded commands outside, and says why", async () => {
    const target = path.join(outside, "excluded.txt");
    const s = session(settings({ excludedCommands: ["touch *"] }));
    const { subject, display } = await s.call({ command: `touch '${target}'` });
    expect(subject).toMatchObject({ sandbox: { run: "outside", why: "excluded" } });
    expect(display.sandbox).toEqual({ placement: "outside", reason: "excluded", blocked: [] });
    expect(existsSync(target)).toBe(true);
  });

  it("does nothing while the sandbox is off", async () => {
    const target = path.join(outside, "off.txt");
    const { subject, display } = await session(settings({ enabled: false })).call({
      command: `echo hi > '${target}'`,
    });
    expect(subject).not.toHaveProperty("sandbox");
    expect(display).not.toHaveProperty("sandbox");
    expect(existsSync(target)).toBe(true);
  });
});

describe("the sandbox where it cannot run", () => {
  const unavailable: SandboxAvailability = {
    available: false,
    reason: "The sandbox cannot run here: bubblewrap (bwrap) not found.",
    warnings: [],
  };
  const fakeHost = { availability: () => unavailable } as unknown as SandboxHost;
  const make = (s: SandboxSettings) =>
    new SessionSandbox({
      host: fakeHost,
      settings: () => s,
      rules: () => ({ allow: [], deny: [] }),
      homeDir: "/home/a",
    });

  it("runs commands without it, by default, and says so", () => {
    expect(make(settings()).plan("ls", false, "/p")).toEqual({
      run: "outside",
      why: "unavailable",
    });
  });

  it("refuses them with failIfUnavailable", () => {
    const plan = make(settings({ failIfUnavailable: true })).plan("ls", false, "/p");
    expect(plan).toMatchObject({ run: "refused" });
    expect(plan?.run === "refused" ? plan.why : "").toContain("bubblewrap");
  });

  it("is off when the settings say so", () => {
    expect(make(settings({ enabled: false })).plan("ls", false, "/p")).toBeNull();
  });
});

describe("excluded commands", () => {
  const ctx = { cwd: "/p", homeDir: "/home/a" };
  it("match as documented", () => {
    expect(isExcludedCommand("docker compose up", ["docker *"], ctx)).toBe(true);
    expect(isExcludedCommand("docker", ["docker *"], ctx)).toBe(true);
    expect(isExcludedCommand("npm ci && docker build .", ["docker *"], ctx)).toBe(false);
    expect(isExcludedCommand("npm ci && docker build .", ["docker *", "npm ci"], ctx)).toBe(true);
    expect(isExcludedCommand("/usr/local/bin/docker ps", ["docker *"], ctx)).toBe(false);
    expect(isExcludedCommand("docker ps", ["docker"], ctx)).toBe(false);
  });

  it("leave calls of risky shapes sandboxed", () => {
    const docker = ["docker *", "git *"];
    expect(isExcludedCommand("docker ps > out.txt", docker, ctx)).toBe(false);
    expect(isExcludedCommand("docker ps 2>&1", docker, ctx)).toBe(true);
    expect(isExcludedCommand("cd x && docker ps", docker, ctx)).toBe(false);
    expect(isExcludedCommand("docker run $(cat img)", docker, ctx)).toBe(false);
    expect(isExcludedCommand("(docker ps)", docker, ctx)).toBe(false);
    expect(isExcludedCommand("sudo docker ps", docker, ctx)).toBe(false);
    expect(isExcludedCommand("$TOOL ps", docker, ctx)).toBe(false);
    expect(isExcludedCommand("if true; then docker ps; fi", docker, ctx)).toBe(false);
    expect(isExcludedCommand("git clone https://x/y.git ../y", docker, ctx)).toBe(false);
    expect(isExcludedCommand("git clone https://x/y.git y", docker, ctx)).toBe(true);
    expect(isExcludedCommand("git worktree add ~/w", docker, ctx)).toBe(false);
  });
});

describe("violations as people read them", () => {
  it("describes writes, reads and connections, and drops noise", () => {
    expect(describeViolation("bash(91245) deny(1) file-write-create /tmp/x/y")).toBe(
      "Writing /tmp/x/y",
    );
    expect(describeViolation("cat(1) deny(1) file-read-data /Users/a/.ssh/id_rsa")).toBe(
      "Reading /Users/a/.ssh/id_rsa",
    );
    expect(describeViolation("curl(9) deny(1) network-outbound remote:*:6060")).toBe(
      "Connecting to port 6060 directly, not through the proxy",
    );
    expect(
      describeViolation("deny network-outbound example.com:443 (host is not on the allow list)"),
    ).toBe("Connecting to example.com:443 (not on the allowed list)");
    expect(
      describeViolation("curl(9) deny(1) mach-lookup com.apple.SystemConfiguration.configd"),
    ).toBeNull();
  });

  it("falls back to the refusals a command printed", () => {
    expect(
      refusedInOutput(
        "bash: /etc/hosts: Operation not permitted\ntouch: /x/y: Operation not permitted\nok\nbash: /etc/hosts: Operation not permitted",
      ),
    ).toEqual(["Not permitted: /etc/hosts", "Not permitted: /x/y"]);
    expect(refusedInOutput("all fine")).toEqual([]);
  });

  it("honours ignoreViolations", () => {
    const lines = [
      "bash(1) deny(1) file-write-create /usr/bin/x",
      "bash(1) deny(1) file-write-create /a",
    ];
    expect(describeViolations(lines, "make all", { "*": ["/usr/bin"] })).toEqual(["Writing /a"]);
    expect(describeViolations(lines, "make all", { npm: ["/a"] })).toHaveLength(2);
    expect(describeViolations(lines, "npm test", { npm: ["/a"] })).toEqual(["Writing /usr/bin/x"]);
  });
});

describe("rules the sandbox takes in", () => {
  const from = { source: "project", origin: "dawg", path: null } as const;
  const dirs = { cwd: "/p", homeDir: "/h" };
  it("maps Read and Edit deny rules to paths", () => {
    expect(sandboxPathsForRule(".env", from, dirs)).toEqual([
      "/p/.env",
      "/p/**/.env",
      "/p/**/.env/**",
    ]);
    expect(sandboxPathsForRule("~/.ssh/**", from, dirs)).toEqual(["/h/.ssh/**"]);
    expect(sandboxPathsForRule("//etc/hosts", from, dirs)).toEqual(["/etc/hosts"]);
    expect(sandboxPathsForRule("./secrets/*.pem", from, dirs)).toEqual([
      "/p/secrets/*.pem",
      "/p/secrets/*.pem/**",
    ]);
    expect(sandboxPathsForRule("!keep", from, dirs)).toEqual([]);
  });

  it("collects domains and paths from the rules in force", () => {
    const r = (rule: string): PermissionRule => ({ rule, from });
    expect(
      rulesForSandbox(
        {
          allow: [
            r("WebFetch(domain:Docs.Example.com)"),
            r("WebFetch(domain:*)"),
            r("Edit(src/**)"),
          ],
          deny: [r("WebFetch(domain:evil.example.com)"), r("Read(~/.aws/**)"), r("Edit(//etc/**)")],
        },
        dirs,
      ),
    ).toEqual({
      allowedDomains: ["docs.example.com"],
      allowedDomainsFrom: [{ domain: "docs.example.com", from }],
      deniedDomains: ["evil.example.com"],
      denyRead: ["/h/.aws/**"],
      denyWrite: ["/h/.aws/**", "/etc/**"],
    });
  });
});
