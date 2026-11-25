import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalDataEvent, TerminalExitEvent } from "../../shared/bridge.ts";
import { makeTempDir, removeTempDirs } from "../workspace/test-repo.ts";
import { createNodePtySpawner, ensureSpawnHelperExecutable } from "./node-pty.ts";
import {
  createTerminalService,
  loginShell,
  type PtyProcess,
  type PtySpawnOptions,
  shellEnv,
  type TerminalService,
} from "./service.ts";

afterEach(async () => {
  await removeTempDirs();
});

class FakePty implements PtyProcess {
  readonly pid = 4242;
  written: string[] = [];
  sizes: [number, number][] = [];
  killed: (string | undefined)[] = [];
  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];

  readonly file: string;
  readonly args: string[];
  readonly options: PtySpawnOptions;

  constructor(file: string, args: string[], options: PtySpawnOptions) {
    this.file = file;
    this.args = args;
    this.options = options;
  }

  onData(listener: (data: string) => void) {
    this.dataListeners.push(listener);
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.push(listener);
  }
  write(data: string) {
    this.written.push(data);
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  kill(signal?: string) {
    this.killed.push(signal);
  }
  emit(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
  exit(exitCode: number, signal?: number) {
    for (const listener of this.exitListeners) listener({ exitCode, signal });
  }
}

const SESSION_DIR = "/Users/me/code/tally";

function setup(options: { backlogChars?: number; env?: NodeJS.ProcessEnv } = {}) {
  const spawned: FakePty[] = [];
  const data: TerminalDataEvent[] = [];
  const exits: TerminalExitEvent[] = [];
  const service = createTerminalService({
    spawn: async (file, args, spawnOptions) => {
      const pty = new FakePty(file, args, spawnOptions);
      spawned.push(pty);
      return pty;
    },
    resolveDirectory: async (sessionId, dir) => {
      if (sessionId !== "s1") throw new Error(`Session ${sessionId} is not tracked.`);
      if (dir !== SESSION_DIR && !dir.startsWith(`${SESSION_DIR}/`)) {
        throw new Error(`${dir} is outside this session's folders.`);
      }
      return { real: `/private${dir}`, logical: dir };
    },
    log: () => {},
    env: options.env ?? { SHELL: "/bin/bash", HOME: "/Users/me", ELECTRON_RUN_AS_NODE: "1" },
    flushMs: 10,
    ...(options.backlogChars === undefined ? {} : { backlogChars: options.backlogChars }),
  });
  service.onData((event) => data.push(event));
  service.onExit((event) => exits.push(event));
  return { service, spawned, data, exits };
}

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

async function openOne(service: TerminalService) {
  return service.open({ sessionId: "s1", cwd: SESSION_DIR, cols: 80, rows: 24 });
}

describe("terminal service", () => {
  it("starts the login shell in the session's folder with a terminal environment", async () => {
    const { service, spawned } = setup();
    const info = await openOne(service);
    expect(info).toMatchObject({ sessionId: "s1", cwd: SESSION_DIR, title: "bash", alive: true });
    const [pty] = spawned;
    expect(pty?.file).toBe("/bin/bash");
    expect(pty?.args).toEqual(["-l"]);
    expect(pty?.options).toMatchObject({
      cwd: SESSION_DIR,
      cols: 80,
      rows: 24,
      name: "xterm-256color",
    });
    expect(pty?.options.env).toMatchObject({
      TERM: "xterm-256color",
      HOME: "/Users/me",
      PWD: SESSION_DIR,
      LANG: "en_US.UTF-8",
    });
    expect(pty?.options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("refuses folders outside the session and untracked sessions", async () => {
    const { service, spawned } = setup();
    await expect(
      service.open({ sessionId: "s1", cwd: "/etc", cols: 80, rows: 24 }),
    ).rejects.toThrow(/outside this session's folders/);
    await expect(
      service.open({ sessionId: "other", cwd: SESSION_DIR, cols: 80, rows: 24 }),
    ).rejects.toThrow(/not tracked/);
    expect(spawned).toEqual([]);
  });

  it("batches output, forwards keystrokes and resizes", async () => {
    const { service, spawned, data } = setup();
    const { terminalId } = await openOne(service);
    const pty = spawned[0] as FakePty;
    pty.emit("hel");
    pty.emit("lo\r\n");
    expect(data).toEqual([]);
    await tick();
    expect(data).toEqual([{ terminalId, data: "hello\r\n" }]);

    service.write(terminalId, "ls\r");
    service.resize(terminalId, 120, 40);
    service.write("unknown", "x");
    expect(pty.written).toEqual(["ls\r"]);
    expect(pty.sizes).toEqual([[120, 40]]);
  });

  it("keeps recent output for a reloaded window, cut at a line", async () => {
    const { service, spawned } = setup({ backlogChars: 20 });
    const { terminalId } = await openOne(service);
    const pty = spawned[0] as FakePty;
    pty.emit("line one\r\n");
    pty.emit("line two\r\n");
    pty.emit("line three\r\n");
    const [reattach] = service.list("s1");
    expect(reattach).toMatchObject({ terminalId, alive: true });
    expect(reattach?.backlog).toBe("line three\r\n");
    expect(service.list("other")).toEqual([]);
  });

  it("reports an exit after the last output, and keeps the ended terminal until closed", async () => {
    const { service, spawned, data, exits } = setup();
    const { terminalId } = await openOne(service);
    const pty = spawned[0] as FakePty;
    pty.emit("bye\r\n");
    pty.exit(0);
    expect(data).toEqual([{ terminalId, data: "bye\r\n" }]);
    expect(exits).toEqual([{ terminalId, exitCode: 0, signal: null }]);
    expect(service.list("s1")[0]).toMatchObject({ alive: false, backlog: "bye\r\n" });

    service.write(terminalId, "ignored");
    expect(pty.written).toEqual([]);
    await service.close(terminalId);
    expect(service.list("s1")).toEqual([]);
    expect(pty.killed).toEqual([]);
  });

  it("reports a shell ended by a signal", async () => {
    const { service, spawned, exits } = setup();
    const { terminalId } = await openOne(service);
    (spawned[0] as FakePty).exit(0, 9);
    expect(exits).toEqual([{ terminalId, exitCode: null, signal: 9 }]);
  });

  it("ends shells on close and when the app quits", async () => {
    const { service, spawned, exits } = setup();
    const first = await openOne(service);
    await openOne(service);
    await service.close(first.terminalId);
    expect(spawned[0]?.killed).toEqual(["SIGHUP"]);
    // A closed terminal's exit is not reported.
    spawned[0]?.exit(0, 1);
    expect(exits).toEqual([]);

    service.disposeAll();
    expect(spawned[1]?.killed).toEqual(["SIGHUP"]);
    expect(service.list("s1")).toEqual([]);
  });
});

describe("shell environment", () => {
  it("uses $SHELL when it is an absolute path, else zsh", () => {
    expect(loginShell({ SHELL: "/opt/homebrew/bin/fish" })).toBe("/opt/homebrew/bin/fish");
    expect(loginShell({ SHELL: "fish" })).toBe("/bin/zsh");
    expect(loginShell({})).toBe("/bin/zsh");
  });

  it("keeps a chosen locale", () => {
    expect(shellEnv({ LANG: "fr_FR.UTF-8" }, "/x").LANG).toBe("fr_FR.UTF-8");
    expect(shellEnv({ LC_ALL: "C" }, "/x").LANG).toBeUndefined();
  });
});

describe("node-pty", () => {
  it.skipIf(process.platform === "win32")("makes spawn-helper executable", async () => {
    const dir = await makeTempDir("dawg-pty-");
    const helperDir = path.join(dir, "prebuilds", `${process.platform}-${process.arch}`);
    await mkdir(helperDir, { recursive: true });
    const helper = path.join(helperDir, "spawn-helper");
    await writeFile(helper, "#!/bin/sh\n");
    await chmod(helper, 0o644);
    const logs: string[] = [];
    await ensureSpawnHelperExecutable(dir, (m) => logs.push(m));
    expect((await stat(helper)).mode & 0o777).toBe(0o755);
    expect(logs).toHaveLength(1);
    await ensureSpawnHelperExecutable(dir, (m) => logs.push(m));
    expect(logs).toHaveLength(1);
  });

  // node-pty has no Linux prebuild; on macOS this runs a real shell.
  it.skipIf(process.platform !== "darwin")(
    "runs a real shell",
    async () => {
      const dir = await makeTempDir("dawg-shell-");
      const service = createTerminalService({
        spawn: createNodePtySpawner(() => {}),
        resolveDirectory: async () => ({ real: dir, logical: dir }),
        log: () => {},
        env: { ...process.env, SHELL: "/bin/sh", ENV: "", BASH_ENV: "" },
      });
      let output = "";
      const exited = new Promise<TerminalExitEvent>((resolve) => service.onExit(resolve));
      service.onData((event) => {
        output += event.data;
      });
      const { terminalId } = await service.open({ sessionId: "s1", cwd: dir, cols: 80, rows: 24 });
      service.write(terminalId, "echo dawg-$((40 + 2)); pwd; exit 3\r");
      const exit = await exited;
      expect(output).toContain("dawg-42");
      expect(output).toContain(path.basename(dir));
      expect(exit).toEqual({ terminalId, exitCode: 3, signal: null });
      service.disposeAll();
    },
    20_000,
  );
});
