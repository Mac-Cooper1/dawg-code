/**
 * Runs the real `dawg` command as a child process against the scripted mock model, in a temporary
 * directory with its own home and data root. `close()` stops every child, the mock, and removes
 * the directory.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type MockModel,
  type MockModelOptions,
  type Script,
  type ScriptReply,
  startMockModel,
} from "@dawg/mock-model";

export const MAIN = fileURLToPath(new URL("../main.ts", import.meta.url));

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface Child {
  process: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  /** Resolves once standard output holds text matching `pattern`. */
  waitForStdout(pattern: RegExp | string, timeoutMs?: number): Promise<void>;
  exited: Promise<RunResult>;
}

export interface Harness {
  root: string;
  project: string;
  home: string;
  dawgHome: string;
  mock: MockModel;
  /** Environment every run gets; tests add to it. */
  env: Record<string, string>;
  run(
    args: string[],
    options?: { stdin?: string; env?: Record<string, string>; cwd?: string },
  ): Promise<RunResult>;
  spawn(args: string[], options?: { env?: Record<string, string>; cwd?: string }): Child;
  /** Every file under the temporary root, with its contents, for leak checks. */
  allFiles(): Promise<{ path: string; content: Buffer }[]>;
  close(): Promise<void>;
}

export async function startHarness(
  options: { script?: Script | ScriptReply[]; mock?: Omit<MockModelOptions, "script"> } = {},
): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "dawg-cli-"));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const dawgHome = path.join(home, ".dawg");
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  const mock = await startMockModel({ ...options.mock, script: options.script ?? [] });
  const children = new Set<ChildProcess>();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    DAWG_HOME: dawgHome,
    TMPDIR: root,
    LANG: "en_US.UTF-8",
    NO_COLOR: "1",
  };

  const start = (args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): Child => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      cwd: opts.cwd ?? project,
      env: { ...env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    const listeners = new Set<() => void>();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      for (const l of [...listeners]) l();
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<RunResult>((resolve) => {
      child.on("close", (code, signal) => {
        children.delete(child);
        resolve({ code, signal, stdout, stderr });
      });
    });
    return {
      process: child,
      stdout: () => stdout,
      stderr: () => stderr,
      exited,
      waitForStdout: (pattern, timeoutMs = 15_000) =>
        new Promise((resolve, reject) => {
          const test = () =>
            typeof pattern === "string" ? stdout.includes(pattern) : pattern.test(stdout);
          if (test()) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            listeners.delete(check);
            reject(new Error(`timed out waiting for ${pattern} in stdout:\n${stdout}\n${stderr}`));
          }, timeoutMs);
          const check = () => {
            if (!test()) return;
            clearTimeout(timer);
            listeners.delete(check);
            resolve();
          };
          listeners.add(check);
        }),
    };
  };

  return {
    root,
    project,
    home,
    dawgHome,
    mock,
    env,
    spawn: start,
    async run(args, opts = {}) {
      const child = start(args, opts);
      child.process.stdin?.end(opts.stdin ?? "");
      return child.exited;
    },
    async allFiles() {
      const out: { path: string; content: Buffer }[] = [];
      const walk = async (dir: string) => {
        for (const name of await readdir(dir).catch(() => [] as string[])) {
          const file = path.join(dir, name);
          const info = await stat(file).catch(() => null);
          if (info?.isDirectory()) await walk(file);
          else if (info?.isFile()) out.push({ path: file, content: await readFile(file) });
        }
      };
      await walk(root);
      return out;
    },
    async close() {
      for (const child of children) child.kill("SIGKILL");
      await mock.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The parsed lines of a stream-json run. */
export function jsonLines(stdout: string): { event: string; payload: Record<string, unknown> }[] {
  return stdout
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}
