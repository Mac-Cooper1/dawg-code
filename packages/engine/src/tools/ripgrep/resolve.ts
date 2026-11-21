/**
 * Finds the ripgrep binary the Grep tool runs, in this order:
 *
 *   1. the path the session gives (`ctx.ripgrepPath`, set by the app to its bundled copy);
 *   2. the `DAWG_RG_PATH` environment variable;
 *   3. the copy `pnpm fetch-ripgrep` installed in this checkout;
 *   4. `rg` on PATH.
 *
 * A candidate is used only after `rg --version` runs and identifies itself. Successful checks
 * are cached for the life of the process; failures are not, so a binary fetched while the app
 * runs is picked up on the next search.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { fetchedBinaryPath } from "./lock.ts";

export type RipgrepSource = "context" | "env" | "fetched" | "path";

export interface RipgrepLocation {
  path: string;
  /** First line of `rg --version`, for example "ripgrep 15.2.0". */
  version: string;
  source: RipgrepSource;
}

export type VerifyOutcome = { ok: true; version: string } | { ok: false; problem: string };

export interface ResolveRipgrepOptions {
  /** The session's choice (`ctx.ripgrepPath`). Null or absent to search. */
  explicitPath?: string | null;
  /** Where `DAWG_RG_PATH` and `PATH` are read from. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The fetched copy's location. Defaults to this checkout's `resources/bin/<target>/rg`. */
  fetchedPath?: string;
  /** Checks that a file is a working ripgrep. Defaults to running `--version`. */
  verify?: (file: string) => Promise<VerifyOutcome>;
}

export const RIPGREP_ENV_VAR = "DAWG_RG_PATH";

export class RipgrepNotFoundError extends Error {
  readonly attempts: readonly { source: RipgrepSource; path: string; problem: string }[];

  constructor(attempts: { source: RipgrepSource; path: string; problem: string }[]) {
    const tried = attempts.map((a) => `\n  ${a.source}: ${a.path} (${a.problem})`).join("");
    super(
      "ripgrep (rg) is not available, so files cannot be searched. Run `pnpm fetch-ripgrep` to " +
        `install the pinned copy, or set ${RIPGREP_ENV_VAR} to an rg binary.` +
        (tried ? `\nTried:${tried}` : ""),
    );
    this.name = "RipgrepNotFoundError";
    this.attempts = attempts;
  }
}

const verifiedPaths = new Map<string, string>();

/** Forgets every cached check. For tests, and after a binary is found to have disappeared. */
export function clearRipgrepCache(): void {
  verifiedPaths.clear();
}

export async function resolveRipgrep(
  options: ResolveRipgrepOptions = {},
): Promise<RipgrepLocation> {
  const env = options.env ?? process.env;
  const verify = options.verify ?? verifyByRunning;
  const candidates: { source: RipgrepSource; path: string }[] = [];
  if (options.explicitPath) candidates.push({ source: "context", path: options.explicitPath });
  const fromEnv = env[RIPGREP_ENV_VAR];
  if (fromEnv) candidates.push({ source: "env", path: fromEnv });
  candidates.push({ source: "fetched", path: options.fetchedPath ?? fetchedBinaryPath() });

  const attempts: { source: RipgrepSource; path: string; problem: string }[] = [];
  for (const candidate of candidates) {
    const outcome = await check(candidate.path, verify);
    if (outcome.ok)
      return { path: candidate.path, version: outcome.version, source: candidate.source };
    attempts.push({ ...candidate, problem: outcome.problem });
  }

  const onPath = await findOnPath("rg", env.PATH ?? "");
  if (onPath.length === 0) {
    attempts.push({ source: "path", path: "rg", problem: "not found on PATH" });
  }
  for (const file of onPath) {
    const outcome = await check(file, verify);
    if (outcome.ok) return { path: file, version: outcome.version, source: "path" };
    attempts.push({ source: "path", path: file, problem: outcome.problem });
  }
  throw new RipgrepNotFoundError(attempts);
}

async function check(
  file: string,
  verify: (file: string) => Promise<VerifyOutcome>,
): Promise<VerifyOutcome> {
  if (!path.isAbsolute(file)) return { ok: false, problem: "not an absolute path" };
  const cached = verifiedPaths.get(file);
  if (cached !== undefined) return { ok: true, version: cached };
  if (!(await isExecutableFile(file))) return { ok: false, problem: "no executable file there" };
  const outcome = await verify(file);
  if (outcome.ok) verifiedPaths.set(file, outcome.version);
  return outcome;
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(name: string, pathValue: string): Promise<string[]> {
  const found: string[] = [];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, name);
    if (!found.includes(file) && (await isExecutableFile(file))) found.push(file);
  }
  return found;
}

/** Runs `<file> --version` and accepts it when the first line names ripgrep. */
export function verifyByRunning(file: string): Promise<VerifyOutcome> {
  return new Promise((resolve) => {
    execFile(
      file,
      ["--version"],
      { timeout: 10_000, env: { ...process.env, RIPGREP_CONFIG_PATH: "" } },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, problem: `--version failed: ${error.message.split("\n")[0]}` });
          return;
        }
        const first = stdout.split("\n")[0]?.trim() ?? "";
        if (/^ripgrep \d/.test(first)) resolve({ ok: true, version: first });
        else resolve({ ok: false, problem: "--version did not identify ripgrep" });
      },
    );
  });
}
