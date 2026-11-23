import { homedir } from "node:os";
import path from "node:path";

/**
 * The data root: `$DAWG_HOME`, else `~/.dawg`. Same rule as the engine and the command-line tool
 * (`resolveDawgHome` in @dawg/engine), so the app, the engine and `dawg` share one folder.
 */
export function resolveDataRoot(
  env: Record<string, string | undefined> = process.env,
  homeDir: string = homeDirFrom(env),
): string {
  const fromEnv = env.DAWG_HOME;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return path.resolve(fromEnv);
  return path.join(homeDir, ".dawg");
}

/** `$HOME` when set (tests and the e2e run move it), else the OS answer. */
export function homeDirFrom(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOME;
  return home !== undefined && home !== "" ? home : homedir();
}

export function settingsFile(dataRoot: string): string {
  return path.join(dataRoot, "settings.json");
}

export function stateFile(dataRoot: string): string {
  return path.join(dataRoot, "state.json");
}
