/**
 * The report's settings files: each one that exists, read and merged as sessions read them. A
 * file is loaded when dawg uses everything in it, partly supported when it holds keys dawg
 * ignores (each named, grouped by why), and invalid when it cannot be parsed. Keys follow
 * code.claude.com/docs/en/settings-reference.
 */

import { resolve } from "node:path";
import type { CompatItem } from "@dawg/protocol";
import { mergeSettings, settingsFilePaths } from "../settings/load.ts";
import { readSettingsFile } from "../settings/parse.ts";
import { displayPath, sentence } from "./files.ts";
import { type KeyGroup, keyGroup, MCP_APPROVAL_KEYS } from "./settings-keys.ts";
import type { ReportProvider } from "./types.ts";

/** The note for each group of ignored keys, for one key and for several. */
const GROUP_NOTES: Record<Exclude<KeyGroup, "own-item">, [one: string, several: string]> = {
  unused: ["Not used by dawg yet", "Not used by dawg yet"],
  later: [
    "For a feature that arrives later in Phase 4, so ignored for now",
    "For features that arrive later in Phase 4, so ignored for now",
  ],
  cloud: [
    "Depends on Anthropic's cloud or an Anthropic account, so it does nothing in dawg",
    "Depend on Anthropic's cloud or an Anthropic account, so they do nothing in dawg",
  ],
  model: [
    "Names Anthropic models; dawg uses its own choice of model instead",
    "Name Anthropic models; dawg uses its own choice of model instead",
  ],
  "hosted-env": [
    "Configures Claude Code or Anthropic's API, so it is not passed to sessions",
    "Configure Claude Code or Anthropic's API, so they are not passed to sessions",
  ],
};

const GROUP_ORDER: readonly Exclude<KeyGroup, "own-item">[] = [
  "unused",
  "later",
  "model",
  "cloud",
  "hosted-env",
];

export const settingsProvider: ReportProvider = async (context) => {
  const homeDir = resolve(context.homeDir);
  const projectDir = context.projectDir === null ? null : resolve(context.projectDir);
  const specs = settingsFilePaths(projectDir, homeDir);
  const parsed = await Promise.all(specs.map((spec) => readSettingsFile(spec.path, spec.origin)));
  // Merging finds the problems that depend on where a value is (a project's bypass mode).
  const merged = mergeSettings({
    projectDir: projectDir ?? homeDir,
    homeDir,
    flags: {},
    specs,
    parsed,
  });
  const items: CompatItem[] = [];
  for (const [index, spec] of specs.entries()) {
    const read = parsed[index];
    if (!read?.exists) continue;
    const file = {
      ...spec,
      ignoredKeys: read.ignoredKeys,
      problems: merged.problems.filter((problem) => problem.path === spec.path),
    };
    const item: CompatItem = {
      kind: "settings",
      name: displayPath(file.path, context),
      source: { path: file.path, origin: file.origin, scope: file.source },
      status: "loaded",
      notes: [],
    };
    // A problem without a key is about the whole file: it was skipped.
    const fatal = file.problems.find((problem) => problem.key === null);
    if (fatal) {
      item.status = "invalid";
      item.notes.push(sentence(fatal.message));
      items.push(item);
      continue;
    }
    const groups = new Map<KeyGroup, string[]>();
    for (const key of file.ignoredKeys) {
      const group = keyGroup(key);
      groups.set(group, [...(groups.get(group) ?? []), key]);
    }
    for (const group of GROUP_ORDER) {
      const keys = groups.get(group);
      if (!keys || keys.length === 0) continue;
      const [one, several] = GROUP_NOTES[group];
      item.notes.push(`${keys.length === 1 ? one : several}: ${keys.join(", ")}.`);
    }
    // Only the person's own files approve a project's MCP servers (../mcp/settings.ts).
    const approvals = file.ignoredKeys.filter((key) => MCP_APPROVAL_KEYS.has(key));
    if (file.source !== "user" && approvals.length > 0) {
      item.notes.push(
        `Approves MCP servers, which only your own settings can do, so ignored here: ${approvals.join(", ")}.`,
      );
    }
    for (const problem of file.problems) {
      // The sandbox's own item (../sandbox/report.ts) reports problems with its keys.
      if (problem.key?.startsWith("sandbox") === true) continue;
      item.notes.push(sentence(`${problem.key}: ${problem.message}`));
    }
    if (item.notes.length > 0) item.status = "partly-supported";
    items.push(item);
  }
  return items;
};
