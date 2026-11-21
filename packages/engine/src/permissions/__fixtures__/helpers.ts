/**
 * Shared helpers for the permission tests.
 */
import type { PermissionRule, SettingsFileRef } from "@dawg/compat";
import type { PermissionMode } from "@dawg/protocol";
import type {
  PermissionDecision,
  PermissionQuery,
  PermissionState,
  PermissionSubject,
} from "../../contracts/permissions.ts";
import { decidePermission } from "../decide.ts";
import type { FsProbe } from "../paths.ts";

/** A file system where nothing exists, so every path is its own real path. */
export const emptyFs: FsProbe = {
  lstat: () => undefined,
  readlink: () => {
    throw new Error("no links here");
  },
};

/**
 * A file system made of the given entries: directories, files, and links (`link` maps a path to
 * its target, relative or absolute). Parents are implied.
 */
export function fakeFs(entries: { dirs?: string[]; files?: string[]; links?: Record<string, string> }): FsProbe {
  const dirs = new Set<string>(["/"]);
  const files = new Set<string>(entries.files ?? []);
  const links = new Map(Object.entries(entries.links ?? {}));
  const addParents = (p: string) => {
    let d = p;
    while (d !== "/" && d !== "") {
      d = d.slice(0, d.lastIndexOf("/")) || "/";
      dirs.add(d);
    }
  };
  for (const d of entries.dirs ?? []) {
    dirs.add(d);
    addParents(d);
  }
  for (const f of files) addParents(f);
  for (const l of links.keys()) addParents(l);
  return {
    lstat(p) {
      if (links.has(p)) return { isSymbolicLink: () => true, isDirectory: () => false };
      if (dirs.has(p)) return { isSymbolicLink: () => false, isDirectory: () => true };
      if (files.has(p)) return { isSymbolicLink: () => false, isDirectory: () => false };
      return undefined;
    },
    readlink(p) {
      const t = links.get(p);
      if (t === undefined) throw new Error(`not a link: ${p}`);
      return t;
    },
  };
}

export const PROJECT = "/work/project";
export const HOME = "/home/alice";

export const projectFile: SettingsFileRef = {
  source: "project",
  origin: "dawg",
  path: `${PROJECT}/.dawg/settings.json`,
};
export const localFile: SettingsFileRef = {
  source: "local",
  origin: "dawg",
  path: `${PROJECT}/.dawg/settings.local.json`,
};
export const userFile: SettingsFileRef = {
  source: "user",
  origin: "claude",
  path: `${HOME}/.claude/settings.json`,
};
export const flags: SettingsFileRef = { source: "flags", origin: null, path: null };

export type RuleInput = string | { rule: string; from: SettingsFileRef };

function toRules(list: RuleInput[] | undefined): PermissionRule[] {
  return (list ?? []).map((r) => (typeof r === "string" ? { rule: r, from: projectFile } : r));
}

export interface StateInput {
  mode?: PermissionMode;
  allow?: RuleInput[];
  ask?: RuleInput[];
  deny?: RuleInput[];
  cwd?: string;
  workingDirectories?: string[];
  homeDir?: string;
}

export function makeState(input: StateInput = {}): PermissionState {
  const cwd = input.cwd ?? PROJECT;
  return {
    mode: input.mode ?? "default",
    rules: { allow: toRules(input.allow), ask: toRules(input.ask), deny: toRules(input.deny) },
    cwd,
    workingDirectories: input.workingDirectories ?? [cwd],
    homeDir: input.homeDir ?? HOME,
  };
}

export function run(
  toolName: string,
  subject: PermissionSubject,
  input: StateInput = {},
  fs: FsProbe = emptyFs,
): PermissionDecision {
  const query: PermissionQuery = { toolName, subject };
  return decidePermission(query, makeState(input), { fs });
}

export const bash = (command: string, input: StateInput = {}, fs: FsProbe = emptyFs) =>
  run("Bash", { kind: "command", command }, input, fs);
export const read = (paths: string[], input: StateInput = {}, fs: FsProbe = emptyFs) =>
  run("Read", { kind: "read", paths }, input, fs);
export const edit = (paths: string[], input: StateInput = {}, fs: FsProbe = emptyFs) =>
  run("Edit", { kind: "edit", paths }, input, fs);

/** The rule text that decided, when a rule did (looking through command parts). */
export function decidingRule(d: PermissionDecision): string | null {
  let r = d.reason;
  while (r.type === "command_part") r = r.reason;
  return r.type === "rule" ? r.rule.rule : null;
}

/** The innermost reason type. */
export function reasonType(d: PermissionDecision): string {
  let r = d.reason;
  while (r.type === "command_part") r = r.reason;
  return r.type === "protected" ? `protected:${r.why}` : r.type;
}
