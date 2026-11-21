import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * `runtime.lock.json` at the repo root pins the llama.cpp build (one archive per macOS
 * architecture) and the tiny model the runtime integration test uses.
 */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256");

const archiveSchema = z.object({
  name: z.string().regex(/^[\w.-]+\.tar\.gz$/),
  url: z.url({ protocol: /^https$/ }),
  sizeBytes: z.number().int().positive(),
  sha256,
});

export const runtimeLockSchema = z.object({
  llamaCpp: z.object({
    repo: z.string(),
    /** Release tag that carries the archives, for example "b12359". */
    tag: z.string().regex(/^b\d+$/),
    /** Named release this build corresponds to, when there is one. */
    release: z.string().optional(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    publishedAt: z.string(),
    note: z.string().optional(),
    archives: z.object({ arm64: archiveSchema, x64: archiveSchema }),
  }),
  testModel: z.object({
    repo: z.string(),
    revision: z.string().regex(/^[0-9a-f]{40}$/),
    file: z.string().regex(/^[\w.-]+\.gguf$/),
    url: z.url({ protocol: /^https$/ }),
    sizeBytes: z.number().int().positive(),
    sha256,
    licence: z.string(),
    note: z.string().optional(),
  }),
});

export type RuntimeLock = z.infer<typeof runtimeLockSchema>;
export type RuntimeArchive = z.infer<typeof archiveSchema>;
export type TestModelPin = RuntimeLock["testModel"];

/** The repository root, found relative to this file (`packages/models/{src,dist}/runtime/`). */
export const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

export const defaultLockPath = join(repoRoot, "runtime.lock.json");

export async function readRuntimeLock(path: string = defaultLockPath): Promise<RuntimeLock> {
  const text = await readFile(path, "utf8");
  return runtimeLockSchema.parse(JSON.parse(text));
}
