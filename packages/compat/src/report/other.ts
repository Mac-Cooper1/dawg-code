/**
 * Everything else a Claude Code setup can hold, from code.claude.com/docs/en/claude-directory
 * and the settings reference: output styles, plugins and marketplaces, the status line,
 * keybindings, terminal themes, workflows, Claude Code's auto memory for the project and
 * `.worktreeinclude`. Most arrive in Phase 5 (spec, Scope → Out); each is listed so the report
 * accounts for everything it found.
 */
import { join, resolve } from "node:path";
import type { CompatItem, CompatSource } from "@dawg/protocol";
import { settingsFilePaths } from "../settings/load.ts";
import {
  configRoots,
  displayPath,
  isDirectory,
  isPlainObject,
  listFiles,
  overriddenNotes,
  readFrontMatter,
  readJson,
  readText,
  stem,
  stringField,
} from "./files.ts";
import type { ReportContext, ReportProvider } from "./types.ts";

export const PHASE_5 = {
  outputStyles: "Output styles arrive in Phase 5.",
  plugins: "Plugins and marketplaces arrive in Phase 5.",
  statusLine: "Custom status lines arrive in Phase 5.",
  keybindings: "dawg has its own shortcuts; custom keybindings arrive in Phase 5.",
  workflows: "Workflows arrive in Phase 5.",
} as const;

function other(
  name: string,
  source: CompatSource,
  status: CompatItem["status"],
  notes: string[],
): CompatItem {
  return { kind: "other", name, source, status, notes };
}

/** `output-styles/*.md` in every configuration folder. */
async function outputStyles(context: ReportContext): Promise<CompatItem[]> {
  const items: CompatItem[] = [];
  for (const root of configRoots(context)) {
    const dir = join(root.dir, "output-styles");
    if (!(await isDirectory(dir))) continue;
    for (const path of await listFiles(dir, ".md", { recursive: false })) {
      const source = { path, origin: root.origin, scope: root.scope };
      const read = await readFrontMatter(path);
      if (read.kind === "missing") continue;
      if (read.kind === "invalid") {
        items.push(other(`Output style: ${stem(path)}`, source, "invalid", [read.message]));
        continue;
      }
      const name = stringField(read.fields, "name") ?? stem(path);
      items.push(other(`Output style: ${name}`, source, "not-supported", [PHASE_5.outputStyles]));
    }
  }
  for (const [index, note] of overriddenNotes(items, context)) items[index]?.notes.push(note);
  return items;
}

/** `workflows/*.js` in Claude Code's folders. */
async function workflows(context: ReportContext): Promise<CompatItem[]> {
  const items: CompatItem[] = [];
  for (const root of configRoots(context)) {
    const dir = join(root.dir, "workflows");
    if (!(await isDirectory(dir))) continue;
    for (const path of await listFiles(dir, ".js", { recursive: false })) {
      const source = { path, origin: root.origin, scope: root.scope };
      items.push(other(`Workflow: /${stem(path)}`, source, "not-supported", [PHASE_5.workflows]));
    }
  }
  return items;
}

/** Keys of a settings file with items of their own: the status line, output style, plugins. */
async function settingsKeys(context: ReportContext): Promise<CompatItem[]> {
  const home = resolve(context.homeDir);
  const project = context.projectDir === null ? null : resolve(context.projectDir);
  const items: CompatItem[] = [];
  for (const spec of settingsFilePaths(project, home)) {
    const read = await readJson(spec.path);
    if (read.kind !== "ok" || !isPlainObject(read.data)) continue;
    const data = read.data;
    const source: CompatSource = { path: spec.path, origin: spec.origin, scope: spec.source };
    if (data.statusLine !== undefined) {
      const command = isPlainObject(data.statusLine) ? data.statusLine.command : undefined;
      items.push(
        other("Status line", source, "not-supported", [
          ...(typeof command === "string" && command.trim() !== ""
            ? [`Runs ${command.trim()}.`]
            : []),
          PHASE_5.statusLine,
        ]),
      );
    }
    if (typeof data.outputStyle === "string" && data.outputStyle.trim() !== "") {
      items.push(
        other(`Output style setting: ${data.outputStyle.trim()}`, source, "not-supported", [
          PHASE_5.outputStyles,
        ]),
      );
    }
    if (isPlainObject(data.enabledPlugins)) {
      for (const [plugin, on] of Object.entries(data.enabledPlugins)) {
        items.push(
          other(`Plugin: ${plugin}`, source, "not-supported", [
            ...(on === false ? ["Turned off in this file."] : []),
            PHASE_5.plugins,
          ]),
        );
      }
    }
    if (isPlainObject(data.extraKnownMarketplaces)) {
      for (const marketplace of Object.keys(data.extraKnownMarketplaces)) {
        items.push(
          other(`Plugin marketplace: ${marketplace}`, source, "not-supported", [PHASE_5.plugins]),
        );
      }
    }
  }
  return items;
}

/** Files only the person's `~/.claude` holds. */
async function homeFiles(context: ReportContext): Promise<CompatItem[]> {
  const claude = join(resolve(context.homeDir), ".claude");
  const user = (path: string): CompatSource => ({ path, origin: "claude", scope: "user" });
  const items: CompatItem[] = [];

  const keybindings = join(claude, "keybindings.json");
  const bindings = await readText(keybindings);
  if (bindings.kind !== "missing") {
    items.push(
      bindings.kind === "invalid"
        ? other("Keybindings", user(keybindings), "invalid", [bindings.message])
        : other("Keybindings", user(keybindings), "not-supported", [PHASE_5.keybindings]),
    );
  }

  const plugins = join(claude, "plugins");
  const installed = join(plugins, "installed_plugins.json");
  if ((await readText(installed)).kind !== "missing") {
    items.push(other("Installed plugins", user(installed), "not-supported", [PHASE_5.plugins]));
  }

  const themes = join(claude, "themes");
  if (await isDirectory(themes)) {
    for (const path of await listFiles(themes, ".json", { recursive: false })) {
      items.push(
        other(`Terminal theme: ${stem(path)}`, user(path), "not-supported", [
          "A theme for Claude Code's terminal; dawg has its own appearance settings.",
        ]),
      );
    }
  }

  if (context.projectDir !== null) {
    // Claude Code keys a project's folder by its path with everything but letters and digits
    // turned into "-" (claude-directory docs, "Session scratchpad directory").
    const key = resolve(context.projectDir).replace(/[^A-Za-z0-9]/g, "-");
    const memory = join(claude, "projects", key, "memory", "MEMORY.md");
    if ((await readText(memory)).kind === "ok") {
      items.push(
        other("Claude Code's auto memory for this project", user(memory), "not-supported", [
          "dawg keeps its own memory, which arrives later in Phase 4; Claude Code's notes are not read.",
        ]),
      );
    }
  }
  return items;
}

/** `.worktreeinclude` at the project root: the app copies the files it lists into worktrees. */
async function worktreeInclude(context: ReportContext): Promise<CompatItem[]> {
  if (context.projectDir === null) return [];
  const path = join(resolve(context.projectDir), ".worktreeinclude");
  const read = await readText(path);
  if (read.kind === "missing") return [];
  const source: CompatSource = { path, origin: "claude", scope: "project" };
  return read.kind === "invalid"
    ? [other(displayPath(path, context), source, "invalid", [read.message])]
    : [
        other(displayPath(path, context), source, "loaded", [
          "dawg-code copies the ignored files it lists into each new worktree.",
        ]),
      ];
}

export const otherProvider: ReportProvider = async (context) => {
  const parts = await Promise.all([
    outputStyles(context),
    workflows(context),
    settingsKeys(context),
    homeFiles(context),
    worktreeInclude(context),
  ]);
  return parts.flat();
};
