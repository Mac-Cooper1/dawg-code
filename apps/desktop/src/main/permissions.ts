/**
 * Settings → Permissions in main: reads every settings file that applies, one by one, and edits
 * dawg's own (`~/.dawg/settings.json`, `<project>/.dawg/settings.json` and
 * `settings.local.json`) through @dawg/compat. Claude Code's files are shown, never written.
 * Rules are checked with the engine's own parser, so what the page accepts is what sessions
 * apply. Open sessions pick a change up from their next turn: the engine looks at the files at
 * the start of each one.
 */
import {
  dawgSettingsPath,
  type PermissionListName,
  readSettingsFiles,
  type SettingsFileState,
  type SettingsFilesState,
  type SettingsProblem,
  SettingsWriteError,
  updatePermissionSettings,
} from "@dawg/compat";
import type { z } from "zod";
import type {
  PermissionSettingsFile,
  PermissionSettingsState,
  PermissionsWriteInputSchema,
} from "../shared/bridge.ts";
import type { PermissionSettingsService } from "./ipc-handlers.ts";

export interface PermissionSettingsServiceOptions {
  /**
   * The person's home directory: the one the engine host is given as HOME (`homeDirFrom`), so
   * the page edits the files sessions read.
   */
  homeDir: string;
}

const LISTS: readonly PermissionListName[] = ["allow", "ask", "deny"];

const LIST_LABEL: Record<PermissionListName, string> = {
  allow: "Allow",
  ask: "Ask",
  deny: "Deny",
};

/** Where a rule being checked would come from; only its shape matters to the checks. */
const CHECKED = { source: "local", origin: "dawg", path: null } as const;

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The engine's rule checks, the same ones sessions apply. */
export type RuleChecks = Pick<
  typeof import("@dawg/engine"),
  "parseRuleText" | "validatePermissionRules"
>;

let ruleChecksLoad: Promise<RuleChecks> | null = null;

/**
 * Loaded on first use: a static import would put the whole engine in main's bundle, parsed at
 * every launch, for a page that is opened now and then. The engine host has it anyway.
 */
export function loadRuleChecks(): Promise<RuleChecks> {
  ruleChecksLoad ??= import("@dawg/engine");
  return ruleChecksLoad;
}

/**
 * Why a rule would be skipped in `list`, as a sentence, or null when sessions would apply it.
 * Warnings (a rule that matches more than it seems to) do not stop it; they show as problems.
 */
export function ruleError(
  checks: RuleChecks,
  rule: string,
  list: PermissionListName,
): string | null {
  const parsed = checks.parseRuleText(rule);
  if (!parsed.ok) return sentence(parsed.message);
  const rules = { allow: [], ask: [], deny: [], [list]: [{ rule, from: CHECKED }] };
  const error = checks
    .validatePermissionRules(rules)
    .find((problem) => problem.severity === "error");
  return error ? sentence(error.message) : null;
}

function describeProblem(problem: SettingsProblem): string {
  return sentence(problem.key === null ? problem.message : `${problem.key}: ${problem.message}`);
}

function toFile(checks: RuleChecks, file: SettingsFileState): PermissionSettingsFile {
  const problems = file.problems.map(describeProblem);
  // Rules that are skipped, or that do more than they seem to, as the engine sees them.
  const rules = Object.fromEntries(
    LISTS.map((list) => [list, file[list].map((rule) => ({ rule, from: CHECKED }))]),
  ) as Record<PermissionListName, { rule: string; from: typeof CHECKED }[]>;
  for (const problem of checks.validatePermissionRules(rules)) {
    problems.push(
      `${LIST_LABEL[problem.list]} rule ${problem.rule.rule}: ${sentence(problem.message)}`,
    );
  }
  const writable = file.origin === "dawg" && file.writable;
  // A file that does not parse already says so; anything else that stops a write is said here.
  if (
    file.origin === "dawg" &&
    !writable &&
    file.readOnlyReason !== null &&
    !file.problems.some((problem) => problem.key === null)
  ) {
    problems.push(sentence(file.readOnlyReason));
  }
  return {
    scope: file.source,
    origin: file.origin,
    path: file.path,
    exists: file.exists,
    writable,
    defaultMode: file.defaultMode,
    allow: [...file.allow],
    ask: [...file.ask],
    deny: [...file.deny],
    problems,
  };
}

function toState(checks: RuleChecks, state: SettingsFilesState): PermissionSettingsState {
  return {
    projectDir: state.projectDir,
    files: state.files.map((file) => toFile(checks, file)),
    defaultMode: state.defaultMode ?? "default",
    bypassDisabled: state.bypassDisabled,
  };
}

export function createPermissionSettingsService(
  options: PermissionSettingsServiceOptions,
): PermissionSettingsService {
  const { homeDir } = options;

  const read = async (projectDir: string | null): Promise<PermissionSettingsState> => {
    const [checks, state] = await Promise.all([
      loadRuleChecks(),
      readSettingsFiles({ projectDir, homeDir }),
    ]);
    return toState(checks, state);
  };

  const write = async (
    input: z.output<typeof PermissionsWriteInputSchema>,
  ): Promise<PermissionSettingsState> => {
    if (input.scope !== "user" && input.projectDir === null) {
      throw new Error("Choose a project to change its settings.");
    }
    if (input.defaultMode === "bypassPermissions" && input.scope !== "user") {
      throw new Error(
        "Only your own settings can start sessions in bypassPermissions mode; a project's settings cannot.",
      );
    }
    const projectDir = input.scope === "user" ? null : input.projectDir;
    const file = dawgSettingsPath(input.scope, { projectDir, homeDir });

    // New rules must be ones sessions apply. Rules already in the list are left as they are,
    // even ones that never worked (they show as problems), so one bad hand-written rule does
    // not stop every other edit to its list.
    const checks = await loadRuleChecks();
    const current = (await readSettingsFiles({ projectDir, homeDir })).files.find(
      (candidate) => candidate.path === file,
    );
    const lists: Partial<Record<PermissionListName, string[]>> = {};
    for (const list of LISTS) {
      const rules = input[list];
      if (rules === undefined) continue;
      const existing = new Set(current?.[list] ?? []);
      for (const rule of rules) {
        if (existing.has(rule)) continue;
        const error = ruleError(checks, rule, list);
        if (error !== null) throw new Error(`${rule}: ${error}`);
      }
      lists[list] = rules;
    }

    try {
      await updatePermissionSettings({
        file,
        ...(input.defaultMode === undefined ? {} : { defaultMode: input.defaultMode }),
        ...lists,
      });
    } catch (error) {
      // Its sentence is the whole story; the class name would only add noise in the notice.
      if (error instanceof SettingsWriteError) throw new Error(error.message);
      throw error;
    }
    return read(input.projectDir);
  };

  return {
    read,
    write,
    // A rule's own syntax, whichever list it goes to; the list's own checks run when it is added.
    checkRule: async (rule) => ruleError(await loadRuleChecks(), rule, "deny"),
  };
}
