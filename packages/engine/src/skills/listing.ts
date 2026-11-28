/**
 * The skill listing: the only part of a skill always in context (Phase 4 spec, Skills). Each
 * skill the agent may load on its own, with its description, sorted by name, in the static
 * prompt at session start. Built once per session from the files as they were then, so the
 * cached prefix never changes mid-conversation; skills added later appear in the next session.
 *
 * As documented (code.claude.com/docs/en/skills, "Skill descriptions are cut short"), every name
 * is always listed; when the listing is over its budget, descriptions are dropped. Claude Code
 * drops those of the skills used least; dawg keeps no usage counts, so it drops from the end of
 * the sorted list, which keeps the text the same for the same skills.
 */
import { listingDescription, type SkillDefinition } from "@dawg/compat";

/** The fallback budget, in characters, when 1% of the window would be smaller. */
export const MIN_LISTING_BUDGET_CHARS = 8000;
/** Documented: the budget is 1% of the context window. Characters per token, roughly. */
const LISTING_WINDOW_SHARE = 0.01;
const CHARS_PER_TOKEN = 4;

export function listingBudgetChars(contextWindow: number | null): number {
  const fromWindow = Math.floor((contextWindow ?? 0) * LISTING_WINDOW_SHARE * CHARS_PER_TOKEN);
  return Math.max(MIN_LISTING_BUDGET_CHARS, fromWindow);
}

/** The words before the list: what skills are and when to load one. Never varies. */
export const LISTING_HEADER = `# Skills

Skills are instructions for particular kinds of task, written by the user or their project. When a task matches a skill's description, call the Skill tool with the skill's name (and its arguments, if it takes any) before you start, then follow what it loads. Load a skill only when it fits the task. Skill names the user types as /name commands may also appear in their messages.

Available skills:`;

/**
 * The listing segment for the skills the agent may load on its own, or "" when there are none.
 * Depends only on their names and descriptions and the budget.
 */
export function renderSkillListing(
  skills: readonly SkillDefinition[],
  budgetChars: number,
): string {
  const listed = skills.filter((skill) => skill.modelInvocable);
  if (listed.length === 0) return "";
  const names = listed.map((skill) => `- ${skill.name}`);
  const descriptions = listed.map((skill) => listingDescription(skill));
  const lineOf = (index: number, withDescription: boolean) => {
    const description = descriptions[index] ?? "";
    return withDescription && description !== ""
      ? `${names[index]}: ${description}`
      : (names[index] ?? "");
  };
  const keep = listed.map(() => true);
  const total = () =>
    keep.reduce(
      (sum, withDescription, index) => sum + lineOf(index, withDescription).length + 1,
      0,
    );
  for (let index = listed.length - 1; index >= 0 && total() > budgetChars; index--) {
    keep[index] = false;
  }
  const lines = listed.map((_, index) => lineOf(index, keep[index] ?? false));
  return `${LISTING_HEADER}\n${lines.join("\n")}`;
}
