import { fileURLToPath } from "node:url";

/** Messages the watchdog sends to the supervisor over the IPC channel. */
export type WatchdogMessage =
  | { type: "spawned"; pid: number }
  | { type: "spawn-error"; message: string; code?: string }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { type: "orphaned" };

/** Absolute path of the watchdog entry point, next to this file (.ts from source, .js when built). */
export function watchdogEntry(): string {
  const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return fileURLToPath(new URL(`./watchdog.${ext}`, import.meta.url));
}
