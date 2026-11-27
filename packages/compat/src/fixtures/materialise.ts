/**
 * Writes a fixture's files into a temporary folder and checks a report against what the fixture
 * expects. Shared by the compatibility suite in this package (report/fixtures.test.ts) and the
 * engine's checks of consent, so both read fixtures the same way.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { CompatItem } from "@dawg/protocol";
import type { CompatFixture, ExpectedItem } from "./types.ts";

/**
 * Written in a fixture's file contents, these become the folders the suite made: needed where a
 * file names a path, as `~/.claude.json` keys its per-project servers by the project's path.
 */
export const FIXTURE_HOME = "{{home}}";
export const FIXTURE_PROJECT = "{{project}}";

export interface MaterialisedFixture {
  /** `<root>/home`, absolute. */
  homeDir: string;
  /** `<root>/project`, absolute. */
  projectDir: string;
}

/**
 * Writes every file of `fixture` under `root` (which should be empty), with `{{home}}` and
 * `{{project}}` replaced. Both folders are made even when the fixture has no files in them.
 * Files ending in `.sh` are made executable.
 */
export async function materialiseFixture(
  fixture: CompatFixture,
  root: string,
): Promise<MaterialisedFixture> {
  const homeDir = resolve(root, "home");
  const projectDir = resolve(root, "project");
  await mkdir(homeDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  for (const [rel, content] of Object.entries(fixture.files)) {
    if (!rel.startsWith("home/") && !rel.startsWith("project/")) {
      throw new Error(`Fixture file ${rel} must start with home/ or project/.`);
    }
    const path = resolve(root, rel);
    if (!path.startsWith(`${resolve(root)}${sep}`)) throw new Error(`Fixture file ${rel} leaves the fixture.`);
    await mkdir(dirname(path), { recursive: true });
    const text = content.replaceAll(FIXTURE_HOME, homeDir).replaceAll(FIXTURE_PROJECT, projectDir);
    await writeFile(path, text);
    if (path.endsWith(".sh")) await chmod(path, 0o755);
  }
  return { homeDir, projectDir };
}

function matches(item: CompatItem, expected: ExpectedItem): boolean {
  return (
    item.kind === expected.kind &&
    item.name === expected.name &&
    item.source.scope === expected.scope &&
    item.source.origin === expected.origin
  );
}

function describe(item: Pick<CompatItem, "kind" | "name"> & { scope: string; origin: string }) {
  return `${item.kind} “${item.name}” (${item.scope}, ${item.origin})`;
}

/**
 * Every way `items` differs from what `fixture` expects, as sentences; empty when they agree.
 * Each expected item must be there once, with its status and every note substring; items of
 * kinds outside `ignoreKinds` that the fixture does not expect are differences too.
 */
export function fixtureDifferences(fixture: CompatFixture, items: readonly CompatItem[]): string[] {
  const out: string[] = [];
  const ignored = new Set(fixture.ignoreKinds ?? []);
  for (const expected of fixture.expected.items) {
    const found = items.filter((item) => matches(item, expected));
    if (found.length === 0) {
      out.push(`Missing ${describe(expected)}.`);
      continue;
    }
    if (found.length > 1) out.push(`${describe(expected)} is listed ${found.length} times.`);
    const item = found[0] as CompatItem;
    if (item.status !== expected.status) {
      out.push(`${describe(expected)} is ${item.status}, expected ${expected.status}.`);
    }
    for (const part of expected.notes ?? []) {
      if (!item.notes.some((note) => note.includes(part))) {
        out.push(
          `${describe(expected)} has no note containing “${part}”; its notes: ${JSON.stringify(item.notes)}.`,
        );
      }
    }
  }
  for (const item of items) {
    if (ignored.has(item.kind)) continue;
    if (fixture.expected.items.some((expected) => matches(item, expected))) continue;
    out.push(
      `Unexpected ${describe({ ...item, ...item.source })}: ${item.status}, ${JSON.stringify(item.notes)}.`,
    );
  }
  return out;
}
