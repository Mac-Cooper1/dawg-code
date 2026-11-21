/**
 * `ripgrep.lock.json` at the repo root pins the ripgrep release the Grep tool runs, with one
 * archive per supported platform. `scripts/fetch-ripgrep.ts` installs from it.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Platforms we pin a binary for, named `<process.platform>-<process.arch>`. */
export const RIPGREP_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64"] as const;
export type RipgrepTarget = (typeof RIPGREP_TARGETS)[number];

export function isRipgrepTarget(value: string): value is RipgrepTarget {
  return (RIPGREP_TARGETS as readonly string[]).includes(value);
}

/** The target for this process, whether or not a binary is pinned for it. */
export function currentTarget(): string {
  return `${process.platform}-${process.arch}`;
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256");

const archiveSchema = z.object({
  name: z.string().regex(/^[\w.-]+\.tar\.gz$/),
  url: z.url({ protocol: /^https$/ }),
  sizeBytes: z.number().int().positive(),
  sha256,
});
export type RipgrepArchive = z.infer<typeof archiveSchema>;

export const ripgrepLockSchema = z.object({
  ripgrep: z.object({
    repo: z.string(),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    tag: z.string(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    publishedAt: z.string(),
    licence: z.string(),
    /** Files copied from the archive next to the binary. */
    licenceFiles: z.array(z.string().regex(/^[\w.-]+$/)).min(1),
    note: z.string().optional(),
    archives: z.object({
      "darwin-arm64": archiveSchema,
      "darwin-x64": archiveSchema,
      "linux-x64": archiveSchema,
    }),
  }),
});
export type RipgrepLock = z.infer<typeof ripgrepLockSchema>;

/** The repository root, found relative to this file (`packages/engine/src/tools/ripgrep/`). */
export const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

export const defaultLockPath = path.join(repoRoot, "ripgrep.lock.json");

/** Where `pnpm fetch-ripgrep` puts binaries: `apps/desktop/resources/bin/<target>/`. */
export const defaultBinRoot = path.join(repoRoot, "apps", "desktop", "resources", "bin");

export function fetchedBinaryPath(target: string = currentTarget(), binRoot = defaultBinRoot) {
  return path.join(binRoot, target, "rg");
}

export async function readRipgrepLock(file: string = defaultLockPath): Promise<RipgrepLock> {
  return ripgrepLockSchema.parse(JSON.parse(await readFile(file, "utf8")));
}
