import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = dirname(fileURLToPath(import.meta.url));
export const TASKS = join(FIXTURES, "tasks");
export const SLOW_TASKS = join(FIXTURES, "slow-tasks");
export const RECORDS = join(FIXTURES, "records");
export const FAKE_PROXY = join(FIXTURES, "fake-proxy.mjs");
export const FAKE_AGENT = join(FIXTURES, "fake-agent.mjs");
export const HANG_AGENT = join(FIXTURES, "hang-agent.sh");

/** A fresh temp directory, removed by the returned cleanup function. */
export function tempDir(prefix = "dawg-runner-test-"): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Copies a fixture task into a temp tasks root so a test can break it. */
export function copyTask(root: string, from: string, id: string): string {
  const dest = join(root, id);
  cpSync(from, dest, { recursive: true });
  return dest;
}
