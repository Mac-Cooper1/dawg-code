/**
 * The facts written once into a session's context message: where it runs and the state of the
 * repository. Git is asked only read-only questions, with optional locks off so that asking never
 * takes the index lock from a git command the person is running.
 */
import { execFile } from "node:child_process";
import { release, type } from "node:os";
import type { SessionEnvironment } from "../contracts/prompt.ts";
import { localDate } from "./known.ts";

export interface EnvironmentInput {
  cwd: string;
  additionalDirectories: readonly string[];
  /** Milliseconds since the epoch; gives the session's date. */
  now: number;
}

const GIT_TIMEOUT_MS = 5_000;
const MAX_STATUS_CHARS = 2_000;
const RECENT_COMMITS = 5;

function run(command: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        windowsHide: true,
      },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

async function osVersion(): Promise<string> {
  if (process.platform === "darwin") {
    const version = (await run("sw_vers", ["-productVersion"], "/"))?.trim();
    if (version) return `macOS ${version}`;
  }
  return `${type()} ${release()}`;
}

async function gitFacts(cwd: string): Promise<SessionEnvironment["git"]> {
  const inside = (await run("git", ["rev-parse", "--is-inside-work-tree"], cwd))?.trim();
  if (inside !== "true") return null;
  const [branchOut, statusOut, logOut] = await Promise.all([
    run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    run("git", ["status", "--porcelain=v1", "--untracked-files=normal"], cwd),
    run("git", ["log", "--oneline", "--no-decorate", "-n", String(RECENT_COMMITS)], cwd),
  ]);
  const branch = branchOut?.trim() ?? "";
  return {
    branch: branch === "" || branch === "HEAD" ? null : branch,
    status: capLines(statusOut?.replace(/\s+$/, "") ?? "", MAX_STATUS_CHARS),
    recentCommits: logOut?.replace(/\s+$/, "") ?? "",
  };
}

/** Keeps whole lines up to `max` characters and says how many were left out. */
function capLines(text: string, max: number): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > max) break;
    kept.push(line);
    size += line.length + 1;
  }
  return `${kept.join("\n")}\n... and ${lines.length - kept.length} more`;
}

export async function gatherEnvironment(input: EnvironmentInput): Promise<SessionEnvironment> {
  const [os, git] = await Promise.all([osVersion(), gitFacts(input.cwd)]);
  return {
    cwd: input.cwd,
    additionalDirectories: [...input.additionalDirectories],
    platform: process.platform,
    osVersion: os,
    shell: "bash",
    date: localDate(input.now),
    git,
  };
}
