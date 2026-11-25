/**
 * Real pseudo-terminals, from node-pty (kept external in the main bundle: it is a native module).
 * Loaded on the first terminal, so the app starts without it and tests never load it.
 *
 * node-pty 1.1.0's macOS prebuilds ship `spawn-helper` without the executable bit, and every
 * spawn then fails with "posix_spawnp failed". The first load sets the bit.
 */
import { chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { PtyProcess, SpawnPty } from "./service.ts";

type NodePty = typeof import("node-pty");

/** Where node-pty keeps `spawn-helper`: its own build, or the prebuild for this Mac. */
export function spawnHelperCandidates(packageDir: string): string[] {
  // Unpacked from the app's asar archive, as node-pty itself expects.
  const dir = packageDir.replace(/app\.asar(?!\.unpacked)/, "app.asar.unpacked");
  return [
    path.join(dir, "build", "Release", "spawn-helper"),
    path.join(dir, "build", "Debug", "spawn-helper"),
    path.join(dir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];
}

/** Makes every `spawn-helper` node-pty has executable. Logs, never throws. */
export async function ensureSpawnHelperExecutable(
  packageDir: string,
  log: (message: string) => void,
): Promise<void> {
  if (process.platform === "win32") return;
  for (const helper of spawnHelperCandidates(packageDir)) {
    let mode: number;
    try {
      mode = (await stat(helper)).mode;
    } catch {
      continue;
    }
    if ((mode & 0o111) === 0o111) continue;
    try {
      await chmod(helper, mode | 0o111);
      log(`Made node-pty's ${helper} executable.`);
    } catch (error) {
      log(
        `Could not make ${helper} executable, so terminals may not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function nodePtyDir(): string {
  const require = createRequire(import.meta.url);
  // lib/index.js → the package folder.
  return path.dirname(path.dirname(require.resolve("node-pty")));
}

export function createNodePtySpawner(log: (message: string) => void): SpawnPty {
  let loading: Promise<NodePty> | null = null;

  async function load(): Promise<NodePty> {
    try {
      await ensureSpawnHelperExecutable(nodePtyDir(), log);
    } catch (error) {
      log(`Could not find node-pty: ${error instanceof Error ? error.message : String(error)}`);
    }
    const loaded = (await import("node-pty")) as NodePty & { default?: NodePty };
    return typeof loaded.spawn === "function" ? loaded : (loaded.default ?? loaded);
  }

  return async (file, args, options): Promise<PtyProcess> => {
    loading ??= load();
    let pty: NodePty;
    try {
      pty = await loading;
    } catch (error) {
      loading = null;
      throw new Error(
        `Terminals are not available: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return pty.spawn(file, args, {
      name: options.name,
      cwd: options.cwd,
      env: options.env,
      cols: options.cols,
      rows: options.rows,
      encoding: "utf8",
    });
  };
}
