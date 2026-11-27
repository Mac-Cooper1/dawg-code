/**
 * The compatibility suite (Phase 4 spec, Testing → Fixtures): small Claude Code setups written by
 * us from Claude Code's public documentation, one per feature and edge case, each with what dawg
 * should make of it. A fixture is data: the suite writes its files into a temporary folder, so no
 * live `.claude` folder ever sits in this repository (where a coding agent working on it could
 * pick one up).
 */
import type { CompatItemKind, CompatItemStatus, CompatSource } from "@dawg/protocol";

export interface CompatFixture {
  /** One sentence: the feature or edge case, and the public doc page it follows. */
  description: string;
  /**
   * Files by path under the fixture's root, each starting with `home/` (the person's home) or
   * `project/` (the project): "home/.claude/settings.json", "project/.claude/skills/review/SKILL.md".
   * Files ending in `.sh` are made executable. In the contents, `{{home}}` and `{{project}}`
   * become the absolute folders (for `~/.claude.json`, which keys projects by path); see
   * materialise.ts.
   */
  files: Record<string, string>;
  expected: {
    /** Every item the report must hold, and (for kinds not in `ignoreKinds`) nothing else. */
    items: ExpectedItem[];
    /** How many items need consent, or null when nothing does. */
    approval: { items: number } | null;
  };
  /** Kinds the check leaves out, for a fixture about one feature. Default none. */
  ignoreKinds?: CompatItemKind[];
}

export interface ExpectedItem {
  kind: CompatItemKind;
  /** Exactly as the report names it. */
  name: string;
  scope: CompatSource["scope"];
  origin: CompatSource["origin"];
  status: CompatItemStatus;
  /** Substrings that must each appear in one of the item's notes. */
  notes?: string[];
}
