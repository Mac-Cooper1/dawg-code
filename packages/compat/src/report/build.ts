/**
 * Runs every provider (providers.ts) for a setup and puts what they found in one stable list:
 * by kind, then where it came from (the person's files, the project's, personal, nested), then
 * name. The same item found twice is listed once, with the notes of both. Never throws: a
 * provider that fails becomes an invalid item saying which part of the report is missing.
 */
import { basename, resolve } from "node:path";
import {
  type CompatItem,
  CompatItemKindSchema,
  CompatItemStatusSchema,
  type CompatSource,
} from "@dawg/protocol";
import { compareCodeUnits } from "../internal/paths.ts";
import { REPORT_PROVIDERS } from "./providers.ts";
import type { CompatItemsReport, ReportContext, ReportProvider } from "./types.ts";

const KIND_ORDER = new Map(CompatItemKindSchema.options.map((kind, index) => [kind, index]));
const SCOPE_ORDER: Record<CompatSource["scope"], number> = {
  user: 0,
  project: 1,
  local: 2,
  nested: 3,
  flags: 4,
};

/** The order items are listed in. Exported for tests and callers that merge reports. */
export function compareItems(a: CompatItem, b: CompatItem): number {
  return (
    (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0) ||
    SCOPE_ORDER[a.source.scope] - SCOPE_ORDER[b.source.scope] ||
    compareCodeUnits(a.name, b.name) ||
    compareCodeUnits(a.source.path, b.source.path) ||
    compareCodeUnits(a.source.origin, b.source.origin)
  );
}

function identity(item: CompatItem): string {
  return [item.kind, item.name, item.source.path, item.source.scope, item.source.origin].join("\0");
}

/** An item as the protocol requires it: a name and a path, notes as a list of sentences. */
function wellFormed(item: CompatItem, context: ReportContext): CompatItem | null {
  if (!CompatItemKindSchema.safeParse(item.kind).success) return null;
  if (!CompatItemStatusSchema.safeParse(item.status).success) return null;
  const path =
    item.source.path.trim() === "" ? (context.projectDir ?? context.homeDir) : item.source.path;
  const name = item.name.trim() === "" ? basename(path) || path : item.name;
  const notes = (item.notes ?? []).filter((note) => typeof note === "string" && note.trim() !== "");
  return { ...item, name, source: { ...item.source, path }, notes };
}

function failure(context: ReportContext, error: unknown): CompatItem {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    kind: "other",
    name: "Part of the report",
    source: {
      path: context.projectDir ?? context.homeDir,
      origin: "dawg",
      scope: context.projectDir === null ? "user" : "project",
    },
    status: "invalid",
    notes: [`Could not finish this part of the report: ${detail.replace(/\.$/, "")}.`],
  };
}

async function run(provide: ReportProvider, context: ReportContext): Promise<CompatItem[]> {
  try {
    return await provide(context);
  } catch (error) {
    return [failure(context, error)];
  }
}

export async function buildCompatReport(context: ReportContext): Promise<CompatItemsReport> {
  // One context object for every provider, so they can share work done for it (walk.ts).
  const normalised: ReportContext = {
    projectDir: context.projectDir === null ? null : resolve(context.projectDir),
    homeDir: resolve(context.homeDir),
  };
  const parts = await Promise.all(REPORT_PROVIDERS.map((provide) => run(provide, normalised)));
  const byIdentity = new Map<string, CompatItem>();
  for (const found of parts.flat()) {
    const item = wellFormed(found, normalised);
    if (item === null) continue;
    const key = identity(item);
    const seen = byIdentity.get(key);
    if (seen === undefined) {
      byIdentity.set(key, item);
      continue;
    }
    // Found twice (a file imported by two others): one item, every note once, and invalid if
    // either says so.
    for (const note of item.notes) if (!seen.notes.includes(note)) seen.notes.push(note);
    if (item.status === "invalid") seen.status = "invalid";
  }
  return { projectDir: normalised.projectDir, items: [...byIdentity.values()].sort(compareItems) };
}
