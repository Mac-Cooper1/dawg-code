/**
 * Helpers for tests that start processes. Not exported from the package.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { processAlive, waitUntil } from "./process.ts";

/** Processes whose command line contains `marker`, other than `ps` itself. */
export function processesMatching(marker: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("ps", ["-A", "-o", "pid=,command="], { maxBuffer: 16 * 1024 * 1024 }, (error, out) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(
        out
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.includes(marker) && !/\bps -A\b/.test(line)),
      );
    });
  });
}

/** Waits briefly for every pid to be gone. Returns the ones still alive. */
export async function survivors(pids: number[], timeoutMs = 3000): Promise<number[]> {
  await waitUntil(() => pids.every((pid) => !processAlive(pid)), timeoutMs);
  return pids.filter(processAlive);
}

/** Reads a pid a test command wrote to `file`, waiting for it to appear. */
export async function readPid(file: string, timeoutMs = 5000): Promise<number> {
  let pid = Number.NaN;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readFile(file, "utf8").catch(() => "");
    pid = Number.parseInt(text.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no pid written to ${file}`);
}
