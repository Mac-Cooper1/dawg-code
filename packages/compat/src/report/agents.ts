/**
 * The report's subagents: Markdown files with front matter under `agents/` in `~/.claude`,
 * `~/.dawg`, a project's `.claude` and `.dawg`, read recursively as Claude Code reads them
 * (code.claude.com/docs/en/sub-agents). Each is read by the subagent reader (../agents), so the
 * report says what dawg does with it: loaded, partly supported with each ignored field named,
 * or invalid and why.
 */
import { join } from "node:path";
import type { CompatItem } from "@dawg/protocol";
import { readAgentFile } from "../agents/read.ts";
import { configRoots, isDirectory, listFiles, overriddenNotes } from "./files.ts";
import type { ReportProvider } from "./types.ts";

export const agentsProvider: ReportProvider = async (context) => {
  const items: CompatItem[] = [];
  for (const root of configRoots(context)) {
    const dir = join(root.dir, "agents");
    if (!(await isDirectory(dir))) continue;
    for (const path of await listFiles(dir, ".md")) {
      const def = await readAgentFile(path, { path, origin: root.origin, scope: root.scope });
      items.push({
        kind: "agent",
        name: def.name,
        source: def.source,
        status: def.status,
        notes: [...def.notes],
      });
    }
  }
  // Of several definitions with one name, the project's wins over the person's, and `.dawg`
  // over `.claude` within each.
  const valid = items.filter((item) => item.status !== "invalid");
  for (const [index, note] of overriddenNotes(valid, context)) valid[index]?.notes.push(note);
  return items;
};
