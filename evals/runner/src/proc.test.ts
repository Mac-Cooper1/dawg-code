import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HANG_AGENT, tempDir } from "./__fixtures__/paths.ts";
import { baseEnv, runProcess, splitArgs } from "./proc.ts";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runProcess", () => {
  let dir: string;
  let cleanup: () => void;
  beforeEach(() => {
    ({ dir, cleanup } = tempDir());
  });
  afterEach(() => cleanup());

  test("timeout kills a hanging process and its background children", async () => {
    const res = await runProcess({
      command: "bash",
      args: [HANG_AGENT, dir],
      cwd: dir,
      env: baseEnv(dir, dir),
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
      timeoutMs: 700,
      killGraceMs: 300,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
    expect(res.durationMs).toBeLessThan(5000);
    const parent = Number(readFileSync(join(dir, "parent.pid"), "utf8"));
    const child = Number(readFileSync(join(dir, "child.pid"), "utf8"));
    // Give the kernel a moment to reap.
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(parent)).toBe(false);
    expect(alive(child)).toBe(false);
  });

  test("stragglers left behind by a process that exits normally are killed", async () => {
    const script = join(dir, "leave-child.sh");
    writeFileSync(script, 'sleep 1000 &\necho "$!" > child.pid\nexit 3\n');
    const res = await runProcess({
      command: "bash",
      args: [script],
      cwd: dir,
      env: baseEnv(dir, dir),
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
      timeoutMs: 10_000,
    });
    expect(res.exitCode).toBe(3);
    expect(res.timedOut).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(Number(readFileSync(join(dir, "child.pid"), "utf8")))).toBe(false);
  });

  test("captures stdout and stderr to files", async () => {
    const res = await runProcess({
      command: "bash",
      args: ["-c", "echo out; echo err >&2"],
      cwd: dir,
      env: baseEnv(dir, dir),
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
      timeoutMs: 10_000,
    });
    expect(res.exitCode).toBe(0);
    expect(readFileSync(join(dir, "out.log"), "utf8")).toBe("out\n");
    expect(readFileSync(join(dir, "err.log"), "utf8")).toBe("err\n");
  });

  test("abort signal stops the process", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const res = await runProcess({
      command: "sleep",
      args: ["1000"],
      cwd: dir,
      env: baseEnv(dir, dir),
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
      timeoutMs: 10_000,
      signal: ac.signal,
    });
    expect(res.aborted).toBe(true);
    expect(res.timedOut).toBe(false);
  });

  test("a missing executable is reported, not thrown", async () => {
    const res = await runProcess({
      command: "definitely-not-a-real-binary-dawg",
      args: [],
      cwd: dir,
      env: baseEnv(dir, dir),
      stdoutPath: join(dir, "out.log"),
      stderrPath: join(dir, "err.log"),
      timeoutMs: 10_000,
    });
    expect(res.spawnError).toMatch(/ENOENT/);
  });
});

describe("splitArgs", () => {
  test.each([
    ["a b  c", ["a", "b", "c"]],
    [`agent --prompt "two words" 'it''s'`, ["agent", "--prompt", "two words", "its"]],
    [`bash -c 'echo "$HOME"'`, ["bash", "-c", 'echo "$HOME"']],
    [`a\\ b "q\\"x"`, ["a b", 'q"x']],
    [`x ""`, ["x", ""]],
  ])("%s", (input, expected) => {
    expect(splitArgs(input)).toEqual(expected);
  });
  test("unterminated quote", () => {
    expect(() => splitArgs(`a "b`)).toThrow(/unterminated/);
  });
});

describe("baseEnv", () => {
  test("uses the throwaway HOME and passes no secrets through", () => {
    process.env.DAWG_DEV_API_KEY = "sk-secret-for-test";
    process.env.OPENAI_API_KEY = "sk-other-secret";
    try {
      const env = baseEnv("/tmp/home-x", "/tmp/tmp-x");
      expect(env.HOME).toBe("/tmp/home-x");
      expect(env.TMPDIR).toBe("/tmp/tmp-x");
      expect(env.XDG_CONFIG_HOME).toBe("/tmp/home-x/.config");
      expect(env.PATH).toBeTruthy();
      expect(Object.values(env)).not.toContain("sk-secret-for-test");
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      delete process.env.DAWG_DEV_API_KEY;
      delete process.env.OPENAI_API_KEY;
    }
  });
});
