/**
 * Names for new worktrees. A worktree `<name>` lives in `.dawg/worktrees/<name>` on the branch
 * `dawg/<name>`, so a suggestion is two short words no branch uses yet ("quiet-otter").
 */
import { WorktreeNameSchema } from "../../shared/bridge.ts";

const FIRST = [
  "amber",
  "brave",
  "bright",
  "calm",
  "clever",
  "eager",
  "gentle",
  "golden",
  "happy",
  "keen",
  "lively",
  "lucky",
  "mellow",
  "nimble",
  "patient",
  "quick",
  "quiet",
  "steady",
  "sunny",
  "swift",
  "tidy",
  "witty",
] as const;

const SECOND = [
  "badger",
  "beagle",
  "bison",
  "corgi",
  "falcon",
  "ferret",
  "finch",
  "heron",
  "husky",
  "lynx",
  "marten",
  "otter",
  "panda",
  "puffin",
  "robin",
  "setter",
  "terrier",
  "walrus",
  "whippet",
  "wren",
] as const;

function pick<T>(list: readonly T[], random: () => number): T {
  const index = Math.min(list.length - 1, Math.floor(random() * list.length));
  return list[index] as T;
}

/** A name whose branch (`dawg/<name>`) is not among `branches`. */
export function suggestWorktreeName(
  branches: readonly string[],
  random: () => number = Math.random,
): string {
  const taken = new Set(branches);
  const free = (name: string) => !taken.has(`dawg/${name}`);
  let name = `${pick(FIRST, random)}-${pick(SECOND, random)}`;
  for (let attempt = 0; attempt < 20 && !free(name); attempt++) {
    name = `${pick(FIRST, random)}-${pick(SECOND, random)}`;
  }
  let suffix = 2;
  const stem = name;
  while (!free(name)) name = `${stem}-${suffix++}`;
  return name;
}

/** Null when `name` is a valid worktree name; else what is wrong with it, as a sentence. */
export function worktreeNameProblem(name: string): string | null {
  if (name === "") return "Give the worktree a name.";
  const parsed = WorktreeNameSchema.safeParse(name);
  if (parsed.success) return null;
  return name.length > 60
    ? "Use at most 60 characters."
    : "Use lowercase letters, digits and dashes, starting with a letter or digit.";
}

/** The branches as the dialog lists them: the current one first, each once. */
export function orderBranches(current: string | null, branches: readonly string[]): string[] {
  const ordered = current !== null ? [current, ...branches] : [...branches];
  return [...new Set(ordered)];
}
