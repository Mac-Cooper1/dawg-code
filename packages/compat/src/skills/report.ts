/**
 * The report's skills and custom commands: every one found in the person's and the project's
 * folders, nested folders included, with what dawg does with it (loaded, partly supported with
 * each ignored field named, not used and why, or invalid and why).
 */
import type { CompatItem } from "@dawg/protocol";
import type { ReportProvider } from "../report/types.ts";
import { loadSkills } from "./loader.ts";
import type { SkillDefinition } from "./types.ts";

/** How the report names a definition: as typed (`/review`) when a person can run it, else bare. */
export function skillItemName(def: SkillDefinition): string {
  return def.userInvocable ? `/${def.name}` : def.name;
}

export function skillItem(def: SkillDefinition): CompatItem {
  return {
    kind: def.kind,
    name: skillItemName(def),
    source: def.source,
    status: def.status,
    notes: [...def.notes],
  };
}

export const skillsReportProvider: ReportProvider = async (context) => {
  const set = await loadSkills({ homeDir: context.homeDir, cwd: context.projectDir, nested: true });
  return set.all.map(skillItem);
};
