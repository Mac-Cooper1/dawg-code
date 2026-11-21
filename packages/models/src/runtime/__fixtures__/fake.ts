import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const fakeServerScript = fileURLToPath(new URL("./fake-llama-server.ts", import.meta.url));

export interface FakeModelSpec {
  loadDelayMs?: number;
  neverHealthy?: boolean;
  crashOnStart?: boolean | number;
  crashAfterMs?: number;
  crashTimes?: number;
  hangOnTerm?: boolean;
  leakKey?: boolean;
  logLines?: number;
  logLineBytes?: number;
  nCtxTrain?: number;
  chatTemplate?: string;
  templateCaps?: Record<string, unknown>;
  content?: string;
}

export interface FakeRuntime {
  dir: string;
  /** An executable `llama-server` that runs the fake under this Node. */
  binary: string;
  paths: { slotSaveDir: string; logDir: string; keyDir: string };
  /** Writes a fake model; launch counts and argv records go next to it. */
  model(name: string, spec?: FakeModelSpec): Promise<FakeModel>;
  cleanup(): Promise<void>;
}

export interface FakeModel {
  path: string;
  counterFile: string;
  recordFile: string;
  launches(): Promise<number>;
  record(): Promise<{
    argv: string[];
    pid: number;
    launch: number;
    keyFileMode: number | null;
    keyDirMode: number | null;
    env: Record<string, string | null>;
  }>;
}

export async function makeFakeRuntime(): Promise<FakeRuntime> {
  const dir = await mkdtemp(join(tmpdir(), "dawg-fake-runtime-"));
  const binary = join(dir, "llama-server");
  await writeFile(binary, `#!/bin/sh\nexec "${process.execPath}" "${fakeServerScript}" "$@"\n`);
  await chmod(binary, 0o755);
  const paths = {
    slotSaveDir: join(dir, "slots"),
    logDir: join(dir, "logs"),
    keyDir: join(dir, "keys"),
  };
  await mkdir(paths.keyDir, { recursive: true });
  await mkdir(join(dir, "models"), { recursive: true });
  return {
    dir,
    binary,
    paths,
    async model(name, spec = {}) {
      const path = join(dir, "models", `${name}.json`);
      const counterFile = join(dir, "models", `${name}.count`);
      const recordFile = join(dir, "models", `${name}.record.json`);
      await writeFile(path, JSON.stringify({ ...spec, counterFile, recordFile }));
      return {
        path,
        counterFile,
        recordFile,
        async launches() {
          try {
            return Number(await readFile(counterFile, "utf8"));
          } catch {
            return 0;
          }
        },
        async record() {
          return JSON.parse(await readFile(recordFile, "utf8"));
        },
      };
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** True while a process with this pid exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
