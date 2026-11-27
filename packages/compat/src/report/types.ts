/**
 * The compatibility report (Phase 4 spec, "Compatibility report"): everything a Claude Code setup
 * holds, and what dawg does with each item. Each feature contributes its items through a provider
 * (providers.ts); `buildCompatReport` runs them all. Consent for project-supplied code is the
 * engine's to add (its trust store), so the report here has no `approval`.
 */
import type { CompatItem } from "@dawg/protocol";

export interface ReportContext {
  /** The project (absolute), or null for only the person's own setup. */
  projectDir: string | null;
  /** The person's home (absolute): `~/.claude`, `~/.dawg`, `~/.claude.json`. */
  homeDir: string;
}

/** One feature's part of the report: the items it found, each with what dawg does with it. */
export type ReportProvider = (context: ReportContext) => Promise<CompatItem[]>;

export interface CompatItemsReport {
  projectDir: string | null;
  items: CompatItem[];
}
