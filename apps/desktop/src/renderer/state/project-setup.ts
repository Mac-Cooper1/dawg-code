/**
 * The first-open notice (Phase 4 spec, "Compatibility report"): the first time a session's
 * project with a Claude Code setup is shown, a quiet one-line notice says what dawg found there,
 * with a link to Settings → Project setup. Shown once per project; the projects told are kept in
 * the desktop settings (`projectSetupNoticed`). Consent for the code a project supplies is the
 * trust dialog's (`reviewProjectCode`); this only informs.
 */
import type { CompatItem, CompatReport } from "@dawg/protocol";
import type { StoreApi } from "zustand";
import { basename } from "../lib/format.ts";
import type { AppStore } from "./types.ts";

/** Most projects remembered; the oldest are forgotten first. */
export const MAX_NOTICED_PROJECTS = 500;

/**
 * How each kind is counted in the notice, in the order it lists them. Instruction files are left
 * out: they load as they do in Claude Code.
 */
const KIND_WORDS: readonly [CompatItem["kind"], string, string][] = [
  ["skill", "skill", "skills"],
  ["command", "command", "commands"],
  ["agent", "subagent", "subagents"],
  ["hook", "hook", "hooks"],
  ["mcp-server", "MCP server", "MCP servers"],
  ["settings", "settings file", "settings files"],
  ["other", "other item", "other items"],
];

/**
 * What the project's own Claude Code files hold, counted by kind: "3 skills, 2 hooks, 1 MCP
 * server". Null when there is no Claude Code setup in the project: nothing from its `.claude`
 * folder, `.mcp.json` or the person's settings for it, or only instruction files (which load as
 * they do in Claude Code, so there is nothing to tell).
 */
export function projectSetupSummary(report: CompatReport): string | null {
  const own = report.items.filter(
    (item) => item.source.origin === "claude" && item.source.scope !== "user",
  );
  if (own.every((item) => item.kind === "instructions")) return null;
  const parts: string[] = [];
  for (const [kind, one, several] of KIND_WORDS) {
    const count = own.filter((item) => item.kind === kind).length;
    if (count > 0) parts.push(`${count} ${count === 1 ? one : several}`);
  }
  return parts.join(", ");
}

export function projectSetupNoticeText(projectName: string, summary: string): string {
  return `dawg found a Claude Code setup in ${projectName}: ${summary}.`;
}

export interface ProjectSetupWatchDeps {
  store: StoreApi<AppStore>;
  inspect(projectDir: string): Promise<CompatReport | { error: string }>;
  /** Shows the notice, with its link. */
  show(text: string, action: { label: string; run(): void }): void;
  /** Records that the project's notice was shown. */
  remember(projectDirs: string[]): Promise<void>;
}

/**
 * Watches the selected session's project once the engine is ready, and shows the notice for a
 * project not told about yet. Each project is inspected at most once per window, whatever the
 * outcome: a project without a setup is looked at again on the next launch. Returns a function
 * that stops watching.
 */
export function watchProjectSetup(deps: ProjectSetupWatchDeps): () => void {
  const { store } = deps;
  const checked = new Set<string>();
  let stopped = false;

  const check = async (projectDir: string): Promise<void> => {
    const report = await deps.inspect(projectDir);
    if (stopped || "error" in report) return;
    const summary = projectSetupSummary(report);
    if (summary === null) return;
    const state = store.getState();
    if (state.settings.projectSetupNoticed.includes(projectDir)) return;
    const name = state.projects[projectDir]?.name ?? basename(projectDir);
    deps.show(projectSetupNoticeText(name, summary), {
      label: "See what it uses",
      run: () => store.getState().actions.setSettingsPage("setup"),
    });
    const noticed = store
      .getState()
      .settings.projectSetupNoticed.filter((dir) => dir !== projectDir);
    await deps.remember([...noticed, projectDir].slice(-MAX_NOTICED_PROJECTS));
  };

  const look = (state: AppStore) => {
    if (stopped || state.connection.phase !== "ready") return;
    const id = state.layout.selectedSessionId;
    const session = id === null ? undefined : state.sessions[id];
    if (!session || session.summary.archived) return;
    const projectDir = session.summary.projectDir;
    if (checked.has(projectDir) || state.settings.projectSetupNoticed.includes(projectDir)) return;
    checked.add(projectDir);
    void check(projectDir);
  };

  const unsubscribe = store.subscribe(look);
  look(store.getState());
  return () => {
    stopped = true;
    unsubscribe();
  };
}
