/**
 * The report's hooks: one item per handler, from every settings file that applies, with what
 * dawg does with it (support.ts). Consent is not decided here: the engine's trust store says
 * which handlers wait for the person, and the host marks those items "needs-approval".
 */
import { resolve } from "node:path";
import type { CompatItem } from "@dawg/protocol";
import type { ReportProvider } from "../report/types.ts";
import { type HookDefinition, loadHooks } from "./read.ts";
import { hookItemName, hookSupport, readsTranscript, TRANSCRIPT_GAP_NOTE } from "./support.ts";

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Two handlers Claude Code treats as one: "A handler defined identically ... runs once". */
export function sameHandler(a: HookDefinition, b: HookDefinition): boolean {
  return a.event === b.event && JSON.stringify(a.handler.raw) === JSON.stringify(b.handler.raw);
}

/** The report item for one handler. */
export async function hookItem(
  hook: HookDefinition,
  context: { projectDir: string | null; homeDir: string },
): Promise<CompatItem> {
  const support = hookSupport(hook);
  const notes = [...support.notes];
  let status: CompatItem["status"] = support.status;
  if (status !== "not-supported" && (await readsTranscript(hook, context))) {
    notes.push(TRANSCRIPT_GAP_NOTE);
    status = "partly-supported";
  }
  return { kind: "hook", name: hookItemName(hook), source: hook.source, status, notes };
}

export const hooksReportProvider: ReportProvider = async (context) => {
  const projectDir = context.projectDir === null ? null : resolve(context.projectDir);
  const loaded = await loadHooks({ projectDir, homeDir: context.homeDir });
  const items: CompatItem[] = [];
  const offNote =
    loaded.disabledBy === null
      ? null
      : `Turned off with every other hook by disableAllHooks in ${loaded.disabledBy}.`;
  for (const file of loaded.files) {
    const placed = new Set<(typeof file.problems)[number]>();
    for (const hook of file.hooks) {
      const item = await hookItem(hook, { projectDir, homeDir: context.homeDir });
      // A field the handler got wrong but could do without (a bad timeout): said on its item.
      for (const problem of file.problems) {
        if (problem.key?.startsWith(`${hook.location}.`) !== true) continue;
        placed.add(problem);
        item.notes.push(
          sentence(`${problem.key.slice(hook.location.length + 1)}: ${problem.message}`),
        );
        if (item.status === "loaded") item.status = "partly-supported";
      }
      const first = loaded.hooks.find((other) => sameHandler(other, hook));
      if (first !== undefined && first !== hook) {
        item.notes.push(`Defined the same way in ${first.source.path}, so it runs once.`);
      }
      if (offNote !== null) item.notes.push(offNote);
      items.push(item);
    }
    // Entries that could not be read at all: the file is accounted for, with what is wrong. A
    // file that cannot be parsed is the settings provider's to report.
    for (const problem of file.problems) {
      if (problem.key === null || placed.has(problem)) continue;
      items.push({
        kind: "hook",
        name: problem.key,
        source: file.source,
        status: "invalid",
        notes: [sentence(problem.message)],
      });
    }
  }
  return items;
};
