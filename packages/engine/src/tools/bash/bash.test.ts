import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolOutput } from "../../contracts/tools.ts";
import {
  createStateBag,
  createTestToolContext,
  type TestToolContextOptions,
} from "../../testing/context.ts";
import { processAlive } from "../exec/process.ts";
import { processesMatching, readPid, survivors } from "../exec/test-support.ts";
import { getBackgroundTasks } from "./background.ts";
import { BACKGROUND_MAX_TIMEOUT_MS, type BashInput, createBashTool } from "./bash.ts";
import { findBash } from "./shell.ts";

// Distinctive sleep lengths let the final check find anything these tests left behind.
const MARK = "4801";

let root: string;
let cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-bash-test-"));
});
afterEach(async () => {
  await Promise.all(cleanups.map((cleanup) => cleanup()));
  cleanups = [];
  await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  expect(await processesMatching(`sleep ${MARK}`)).toEqual([]);
});

/** A test context in the root, removed again after the test. */
async function context(options: Partial<TestToolContextOptions> = {}) {
  const test = await createTestToolContext({ cwd: root, ...options });
  cleanups.push(test.cleanup);
  return test;
}

/**
 * A session: several calls sharing one state bag, as the turn loop would make them. Without
 * `bashPath` the tool picks bash itself, as it does in the app.
 */
function session(bashPath?: string, extra: Partial<TestToolContextOptions> = {}) {
  const state = createStateBag();
  const tool = createBashTool({ bashPath, killGraceMs: 300 });
  return {
    state,
    tool,
    async call(input: BashInput, options: Partial<TestToolContextOptions> = {}) {
      const test = await context({ state, ...extra, ...options });
      const out = await tool.execute(input, test.ctx);
      return { out, text: text(out), ...test };
    },
  };
}

function text(out: ToolOutput): string {
  const part = out.content[0];
  return part?.type === "text" ? part.text : "";
}

describe("Bash results", () => {
  it("returns output and treats exit code 0 as success", async () => {
    const { out, text } = await session().call({ command: "echo hello" });
    expect(text).toBe("hello");
    expect(out.isError).toBe(false);
    expect(out.display).toMatchObject({
      kind: "command",
      command: "echo hello",
      cwd: root,
      exitCode: 0,
      timedOut: false,
      interrupted: false,
      backgroundTaskId: null,
      outputPath: null,
    });
  });

  it("reports a non-zero exit code as an error", async () => {
    const { out, text } = await session().call({ command: "echo partial; exit 3" });
    expect(out.isError).toBe(true);
    expect(text).toBe("partial\n\nExit code 3");
    expect(out.display).toMatchObject({ exitCode: 3 });
  });

  it("says so when there is no output", async () => {
    expect((await session().call({ command: "true" })).text).toBe("(no output)");
    expect((await session().call({ command: "false" })).text).toBe("Exit code 1");
  });

  it("includes standard error", async () => {
    const { text } = await session().call({ command: "echo to-err >&2; ls /no/such/dir" });
    expect(text).toContain("to-err");
    expect(text).toMatch(/no\/such\/dir/);
  });

  it("interleaves the two streams in the order they were written", async () => {
    const { text, progress } = await session().call({
      command: "echo a; sleep 0.1; echo b >&2; sleep 0.1; echo c; sleep 0.1; echo d >&2",
    });
    expect(text).toBe("a\nb\nc\nd");
    const live = progress.filter((p) => p.kind === "output");
    expect(live.map((p) => (p.kind === "output" ? `${p.stream}:${p.text}` : ""))).toEqual([
      "stdout:a\n",
      "stderr:b\n",
      "stdout:c\n",
      "stderr:d\n",
    ]);
  });

  it("removes terminal escape sequences", async () => {
    const { text, progress } = await session().call({
      command: String.raw`printf '\033[1;31mred\033[0m \033]0;title\007plain\n'`,
    });
    expect(text).toBe("red plain");
    expect(progress).toContainEqual({ kind: "output", stream: "stdout", text: "red plain\n" });
  });

  it("applies carriage returns like a terminal", async () => {
    const { text } = await session().call({
      command: String.raw`printf '10%%\r50%%\r100%%\ndone\n'`,
    });
    expect(text).toBe("100%\ndone");
  });

  it("reports a missing command", async () => {
    const { out, text } = await session().call({ command: "definitely-not-a-command-xyz" });
    expect(out.isError).toBe(true);
    expect(text).toContain("Exit code 127");
  });

  it("refuses an empty command", async () => {
    const { out } = await session().call({ command: "   " });
    expect(out.isError).toBe(true);
  });
});

describe("Bash display for the app", () => {
  it("gives the output alone, with no notes, when the command succeeds", async () => {
    const { out } = await session().call({ command: "printf 'a\\nb\\n\\n'" });
    expect(out.display).toMatchObject({ exitCode: 0, output: "a\nb", notes: [] });
  });

  it("keeps the exit code out of the output and the notes", async () => {
    const { out, text } = await session().call({ command: "echo partial; exit 1" });
    expect(text).toBe("partial\n\nExit code 1");
    expect(out.display).toMatchObject({ exitCode: 1, output: "partial", notes: [] });
  });

  it("gives an empty output, never the stand-in, when nothing was printed", async () => {
    const quiet = await session().call({ command: "true" });
    expect(quiet.text).toBe("(no output)");
    expect(quiet.out.display).toMatchObject({ output: "", notes: [] });
    const failed = await session().call({ command: "false" });
    expect(failed.out.display).toMatchObject({ exitCode: 1, output: "", notes: [] });
  });

  it("puts a timeout in the notes", async () => {
    const { out } = await session().call({ command: "echo started; sleep 5", timeout: 300 });
    expect(out.display).toMatchObject({
      timedOut: true,
      output: "started",
      notes: ["The command did not finish within 300 ms and was stopped."],
    });
  });

  it("says where the full output is when it was cut", async () => {
    const { out, text, saved } = await session().call(
      { command: "seq 1 50000" },
      { limits: { bashMaxOutputChars: 1000 } },
    );
    const savedPath = saved[0]?.path ?? "";
    if (out.display?.kind !== "command") throw new Error("no command display");
    const { output, notes } = out.display;
    expect(out.display.outputPath).toBe(savedPath);
    expect(output?.startsWith("1\n2\n3\n")).toBe(true);
    expect(output?.endsWith("49999\n50000")).toBe(true);
    expect(output).toContain("characters omitted");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^The output was [\d,]+ characters, so only its beginning and end/);
    expect(notes[0]).toContain(savedPath);
    expect(text).toBe(`${output}\n\n${notes[0]}`);
  });

  it("notes a working directory that was reset", async () => {
    const { out } = await session().call({ command: "cd / && echo moved" });
    if (out.display?.kind !== "command") throw new Error("no command display");
    expect(out.display.output).toBe("moved");
    expect(out.display.notes).toHaveLength(1);
    expect(out.display.notes[0]).toContain("outside the working directories");
  });
});

describe("Bash environment", () => {
  it("never waits for input", async () => {
    const started = Date.now();
    const { text } = await session().call({
      command: 'cat; read line; echo "read:$?"; cat /dev/tty 2>/dev/null; echo "tty:$?"',
    });
    expect(text).toMatch(/^read:1\ntty:[1-9]\d*$/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("sets non-interactive defaults and adds the session's variables", async () => {
    const { text } = await session().call(
      { command: 'echo "$PAGER $GIT_PAGER $GIT_TERMINAL_PROMPT $GIT_EDITOR $FROM_SETTINGS"' },
      { env: { FROM_SETTINGS: "yes" } },
    );
    expect(text).toBe("cat cat 0 true yes");
  });

  it("lets session variables override the defaults", async () => {
    const { text } = await session().call({ command: 'echo "$PAGER"' }, { env: { PAGER: "less" } });
    expect(text).toBe("less");
  });
});

// The bash the tool picks, and /bin/bash itself, which on macOS is the old 3.2.
const bashes = [
  { label: "the bash the tool picks", bashPath: undefined },
  { label: "/bin/bash", bashPath: "/bin/bash" },
].filter((b) => b.bashPath === undefined || existsSync(b.bashPath));

describe.each(bashes)("Bash working directory ($label)", ({ bashPath: shell }) => {
  it("carries the directory over between calls but not environment changes", async () => {
    const s = session(shell);
    await mkdir(path.join(root, "sub"));
    await s.call({ command: "cd sub && export LEAK=1" });
    const { text, out } = await s.call({ command: 'pwd; echo "leak:[$LEAK]"' });
    expect(text).toBe(`${path.join(root, "sub")}\nleak:[]`);
    expect(out.display).toMatchObject({ cwd: path.join(root, "sub") });
  });

  it("keeps the directory after a failing command and after exit", async () => {
    const s = session(shell);
    await mkdir(path.join(root, "a"));
    await mkdir(path.join(root, "b"));
    const failed = await s.call({ command: "cd a; false" });
    expect(failed.out.isError).toBe(true);
    expect((await s.call({ command: "pwd" })).text).toBe(path.join(root, "a"));
    await s.call({ command: "cd ../b; exit 4" });
    expect((await s.call({ command: "pwd" })).text).toBe(path.join(root, "b"));
  });

  it("resets to the project directory when a command leaves the working directories", async () => {
    const s = session(shell);
    const left = await s.call({ command: "cd / && echo moved" });
    expect(left.text).toBe(
      `moved\n\nThe command ended in /, outside the working directories, so the shell's working directory was reset to ${root}.`,
    );
    expect((await s.call({ command: "pwd" })).text).toBe(root);
  });

  it("allows moving into an added working directory", async () => {
    const extra = await mkdtemp(path.join(tmpdir(), "dawg-bash-extra-"));
    try {
      const s = session(shell, { workingDirectories: [root, extra] });
      const moved = await s.call({ command: `cd ${extra}` });
      expect(moved.text).toBe("(no output)");
      expect((await s.call({ command: "pwd" })).text).toBe(extra);
    } finally {
      await rm(extra, { recursive: true, force: true });
    }
  });

  it("recovers when the directory is deleted", async () => {
    const s = session(shell);
    const gone = await s.call({ command: "mkdir gone && cd gone && rmdir ../gone" });
    expect(gone.text).toContain("no longer exists");
    expect((await s.call({ command: "pwd" })).text).toBe(root);
  });

  it("recovers when the directory is deleted between calls", async () => {
    const s = session(shell);
    await mkdir(path.join(root, "later"));
    await s.call({ command: "cd later" });
    await rm(path.join(root, "later"), { recursive: true });
    const { text } = await s.call({ command: "pwd" });
    expect(text).toContain(`${root}\n\nThe previous working directory`);
  });
});

describe("Bash timeouts and interrupts", () => {
  it("stops the whole process tree at the timeout", async () => {
    const s = session();
    const command = `sh -c 'sleep ${MARK} & echo $! > gc.pid; wait' & echo $! > c.pid; wait`;
    const started = Date.now();
    const { out, text } = await s.call({ command, timeout: 500 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.isError).toBe(true);
    expect(text).toContain("did not finish within 500 ms and was stopped");
    expect(out.display).toMatchObject({ timedOut: true, interrupted: false, exitCode: null });
    const child = await readPid(path.join(root, "c.pid"));
    const grandchild = await readPid(path.join(root, "gc.pid"));
    expect(await survivors([child, grandchild])).toEqual([]);
  });

  it("caps the timeout at the maximum", async () => {
    const { out } = await session().call(
      { command: `sleep ${MARK}`, timeout: 600_000 },
      { limits: { bashMaxTimeoutMs: 300 } },
    );
    expect(out.display).toMatchObject({ timedOut: true });
  });

  it("uses the default timeout when none is given", async () => {
    const { out } = await session().call(
      { command: `sleep ${MARK}` },
      { limits: { bashDefaultTimeoutMs: 300 } },
    );
    expect(out.display).toMatchObject({ timedOut: true });
  });

  it("stops the command when the turn is interrupted", async () => {
    const s = session();
    const controller = new AbortController();
    const pending = s.call(
      { command: `echo started; sleep ${MARK} & echo $! > s.pid; wait` },
      { signal: controller.signal },
    );
    const sleeper = await readPid(path.join(root, "s.pid"));
    controller.abort();
    const { out, text } = await pending;
    expect(out.isError).toBe(true);
    expect(text).toBe("started\n\nThe command was interrupted.");
    expect(out.display).toMatchObject({ interrupted: true, timedOut: false });
    expect(await survivors([sleeper])).toEqual([]);
  });

  it("does not start when the turn is already interrupted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      session().call({ command: "touch ran" }, { signal: controller.signal }),
    ).rejects.toBeTruthy();
    await expect(stat(path.join(root, "ran"))).rejects.toThrow();
  });
});

describe("Bash leftover processes", () => {
  it("stops background jobs that keep the output open", async () => {
    const s = session();
    const started = Date.now();
    const { text } = await s.call({ command: `sleep ${MARK} & echo $! > s.pid; echo done` });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(text).toContain("done\n\nThe command left processes running");
    expect(await survivors([await readPid(path.join(root, "s.pid"))])).toEqual([]);
  });

  it("does not wait on a process that escaped the tree and still holds the output", async () => {
    const s = session();
    const started = Date.now();
    const { text } = await s.call({
      command: `perl -MPOSIX -e 'POSIX::setsid(); open(F, ">", "d.pid"); print F $$; close F; exec "sleep", "${MARK}"' & sleep 0.2; echo done`,
    });
    const escaped = await readPid(path.join(root, "d.pid"));
    try {
      expect(Date.now() - started).toBeLessThan(5000);
      expect(text).toContain("done\n\nThe command left processes running");
    } finally {
      // Such a process is out of reach once its parent has gone; clean it up by hand.
      if (processAlive(escaped)) process.kill(escaped, "SIGKILL");
    }
  });

  it("leaves detached jobs running until the session's tasks are stopped", async () => {
    const s = session();
    const { text } = await s.call({
      command: `nohup sleep ${MARK} >/dev/null 2>&1 & echo $! > s.pid`,
    });
    expect(text).toBe("(no output)");
    const pid = await readPid(path.join(root, "s.pid"));
    expect(processAlive(pid)).toBe(true);
    await getBackgroundTasks(s.state).stopAll();
    expect(await survivors([pid])).toEqual([]);
  });
});

describe("Bash output size", () => {
  it("cuts long output to head and tail and saves the full text", async () => {
    const { out, text, saved } = await session().call(
      { command: "seq 1 50000" },
      { limits: { bashMaxOutputChars: 1000 } },
    );
    expect(out.isError).toBe(false);
    expect(text.startsWith("1\n2\n3\n")).toBe(true);
    expect(text).toContain("characters omitted");
    expect(text).toMatch(/49999\n50000\n\nThe output was [\d,]+ characters/);
    expect(saved).toHaveLength(1);
    const savedPath = saved[0]?.path ?? "";
    expect(text).toContain(savedPath);
    expect(out.display).toMatchObject({ outputPath: savedPath });
    const full = await readFile(savedPath, "utf8");
    expect(full.split("\n").filter(Boolean)).toHaveLength(50000);
  });

  it("keeps memory bounded for very large output", async () => {
    const before = process.memoryUsage();
    let peak = 0;
    const sampler = setInterval(() => {
      const now = process.memoryUsage();
      peak = Math.max(
        peak,
        now.heapUsed + now.arrayBuffers - before.heapUsed - before.arrayBuffers,
      );
    }, 20);
    try {
      // 80 MB of output.
      const { out, text, saved } = await session().call({
        command: "yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c 80000000",
      });
      expect(out.isError).toBe(false);
      expect(text.length).toBeLessThan(40_000);
      expect(text).toContain("80,000,000 characters");
      const size = (await stat(saved[0]?.path ?? "")).size;
      expect(size).toBeGreaterThan(64 * 1024 * 1024 - 1);
      expect(size).toBeLessThan(64 * 1024 * 1024 + 1024);
    } finally {
      clearInterval(sampler);
    }
    expect(peak).toBeLessThan(48 * 1024 * 1024);
  });
});

describe("Bash shell choice", () => {
  /** Prints "is-zsh" under zsh and "is-bash" under bash, and exits 0 either way. */
  const WHICH_SHELL =
    'test -n "$ZSH_VERSION" && echo is-zsh; test -n "$BASH_VERSION" && echo is-bash';

  /** A directory holding a `bash` that records its use and then runs /bin/bash. */
  async function fakeBashDir(): Promise<{ dir: string; marker: string }> {
    const dir = path.join(root, "fake-bin");
    const marker = path.join(root, "fake-bash-used");
    await mkdir(dir);
    await writeFile(
      path.join(dir, "bash"),
      `#!/bin/sh\necho used > ${JSON.stringify(marker)}\nexec /bin/bash "$@"\n`,
    );
    await chmod(path.join(dir, "bash"), 0o755);
    return { dir, marker };
  }

  it("uses the first bash on the PATH the command runs with", async () => {
    const { dir } = await fakeBashDir();
    expect(findBash([dir, "/usr/bin", "/bin"].join(path.delimiter))).toBe(path.join(dir, "bash"));
  });

  it("falls back to /bin/bash when the PATH has none", async () => {
    const empty = path.join(root, "empty-bin");
    await mkdir(empty);
    expect(findBash(empty)).toBe(existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
  });

  it("runs commands with that bash and never with $SHELL", async () => {
    const { dir, marker } = await fakeBashDir();
    const { text } = await session().call(
      { command: `${WHICH_SHELL}; ps -o comm= -p $$` },
      { env: { PATH: [dir, process.env.PATH].join(path.delimiter), SHELL: "/bin/zsh" } },
    );
    const [which, comm] = text.split("\n");
    expect(which).toBe("is-bash");
    expect(comm).toMatch(/bash$/);
    expect(await readFile(marker, "utf8")).toBe("used\n");
  });

  it("runs bash by default, whatever $SHELL says", async () => {
    const { text } = await session().call({ command: WHICH_SHELL }, { env: { SHELL: "/bin/zsh" } });
    expect(text).toBe("is-bash");
  });
});

describe("Bash definition", () => {
  it("asks permission for the command line in the directory it will start in", async () => {
    const s = session();
    const probe = async () => (await context({ state: s.state })).ctx;
    expect(s.tool.permission({ command: "npm test" }, await probe())).toEqual({
      kind: "command",
      command: "npm test",
      cwd: root,
    });
    await s.call({ command: "mkdir sub && cd sub" });
    expect(s.tool.permission({ command: "ls" }, await probe())).toEqual({
      kind: "command",
      command: "ls",
      cwd: path.join(root, "sub"),
    });
    // A deleted directory is not where the next command starts.
    await rm(path.join(root, "sub"), { recursive: true });
    expect(s.tool.permission({ command: "ls" }, await probe())).toMatchObject({ cwd: root });
    expect(s.tool.readOnly).toBe(false);
  });

  it("has the documented inputs and a strict schema with an integer timeout", () => {
    const schema = createBashTool().inputSchema as {
      properties: Record<string, Record<string, unknown>>;
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties).sort()).toEqual([
      "command",
      "dangerouslyDisableSandbox",
      "description",
      "run_in_background",
      "timeout",
    ]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.timeout).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: BACKGROUND_MAX_TIMEOUT_MS,
    });
  });

  it("names bash in its description", () => {
    expect(createBashTool().description).toContain("bash");
    expect(createBashTool().description).not.toMatch(/zsh/i);
  });
});
