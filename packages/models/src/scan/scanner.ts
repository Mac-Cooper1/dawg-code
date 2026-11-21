import { createHash, randomBytes } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { resolveHubCacheDir } from "../download/paths.ts";
import type { CatalogEntry } from "../types.ts";

export type ModelSource = "huggingface" | "lmstudio" | "ollama";

export interface FoundFile {
  source: ModelSource;
  /** Absolute path of the file, to be used in place. */
  path: string;
  sha256: string;
  sizeBytes: number;
}

export interface ExistingCopy {
  entryId: string;
  /** Where the entry's model file already is, if anywhere. */
  model?: FoundFile;
  /** Where the entry's projector file already is, if it has one and it was found. */
  projector?: FoundFile;
  /** The model is present, and so is the projector when the entry has one. */
  ready: boolean;
}

/** Hashes a file, resolving with its lowercase hex SHA-256. */
export type FileHasher = (path: string, signal?: AbortSignal) => Promise<string>;

export interface ScanOptions {
  catalog: readonly CatalogEntry[] | { entries: readonly CatalogEntry[] };
  /** Hugging Face hub cache. Defaults to `HF_HUB_CACHE` / `HF_HOME` / `~/.cache/huggingface/hub`. */
  hubDir?: string;
  /** LM Studio models folder. Defaults to `~/.lmstudio/models`. */
  lmStudioDir?: string;
  /** Ollama models folder (holding `manifests/` and `blobs/`). Defaults to `OLLAMA_MODELS` or `~/.ollama/models`. */
  ollamaDir?: string;
  /** Where hashes of LM Studio files are remembered. Defaults to `~/.dawg/cache/file-hashes.json`. */
  hashCacheFile?: string;
  hashFile?: FileHasher;
  signal?: AbortSignal;
}

export const defaultHashFile: FileHasher = async (path, signal) => {
  const hash = createHash("sha256");
  const stream = createReadStream(path, { highWaterMark: 1 << 22, signal });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
};

export function defaultLmStudioDir(home: string = homedir()): string {
  return join(home, ".lmstudio", "models");
}

export function defaultOllamaDir(
  env: { OLLAMA_MODELS?: string } = process.env,
  home: string = homedir(),
): string {
  return env.OLLAMA_MODELS || join(home, ".ollama", "models");
}

export function defaultHashCacheFile(home: string = homedir()): string {
  return join(home, ".dawg", "cache", "file-hashes.json");
}

const SHA256_NAME = /^[0-9a-f]{64}$/;

/** Catalog files being looked for: digest → expected size. */
type Wanted = Map<string, number>;

async function entriesOf(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // Missing or unreadable: that source simply has nothing.
  }
}

async function sizeIfFile(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/** Hugging Face cache: `models--<org>--<name>/blobs/<sha256>`. The blob name is the digest; no hashing. */
async function scanHubCache(hubDir: string, wanted: Wanted): Promise<FoundFile[]> {
  const found: FoundFile[] = [];
  for (const repo of await entriesOf(hubDir)) {
    if (!repo.isDirectory() || !repo.name.startsWith("models--")) continue;
    const blobs = join(hubDir, repo.name, "blobs");
    for (const blob of await entriesOf(blobs)) {
      const expected = wanted.get(blob.name);
      if (expected === undefined || !SHA256_NAME.test(blob.name)) continue;
      const path = join(blobs, blob.name);
      if ((await sizeIfFile(path)) !== expected) continue;
      found.push({ source: "huggingface", path, sha256: blob.name, sizeBytes: expected });
    }
  }
  return found;
}

const OllamaManifestSchema = z.object({
  layers: z.array(
    z.object({
      mediaType: z.string(),
      digest: z.string(),
      size: z.number().optional(),
    }),
  ),
});

const OLLAMA_WEIGHT_TYPES = new Set([
  "application/vnd.ollama.image.model",
  "application/vnd.ollama.image.projector",
]);

/**
 * Ollama: JSON manifests under `manifests/<registry>/<namespace>/<model>/<tag>` whose model or
 * projector layer names `sha256:<digest>`, stored as `blobs/sha256-<digest>`. No hashing.
 */
async function scanOllama(ollamaDir: string, wanted: Wanted): Promise<FoundFile[]> {
  const found = new Map<string, FoundFile>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    for (const item of await entriesOf(dir)) {
      const path = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      if (!item.isFile()) continue;
      let manifest: z.infer<typeof OllamaManifestSchema>;
      try {
        if ((await stat(path)).size > 1024 * 1024) continue;
        manifest = OllamaManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
      } catch {
        continue;
      }
      for (const layer of manifest.layers) {
        if (!OLLAMA_WEIGHT_TYPES.has(layer.mediaType)) continue;
        const match = /^sha256:([0-9a-f]{64})$/.exec(layer.digest);
        const digest = match?.[1];
        if (!digest || found.has(digest)) continue;
        const expected = wanted.get(digest);
        if (expected === undefined) continue;
        const blob = join(ollamaDir, "blobs", `sha256-${digest}`);
        if ((await sizeIfFile(blob)) !== expected) continue;
        found.set(digest, { source: "ollama", path: blob, sha256: digest, sizeBytes: expected });
      }
    }
  };
  await walk(join(ollamaDir, "manifests"), 0);
  return [...found.values()];
}

const HashCacheSchema = z.object({
  version: z.literal(1),
  files: z.record(
    z.string(),
    z.object({ size: z.number(), mtimeMs: z.number(), sha256: z.string() }),
  ),
});
type HashCache = z.infer<typeof HashCacheSchema>;

async function loadHashCache(path: string): Promise<HashCache> {
  try {
    return HashCacheSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return { version: 1, files: {} };
  }
}

async function saveHashCache(path: string, cache: HashCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(cache), "utf8");
    await rename(temp, path);
  } catch {
    await rm(temp, { force: true });
    // A cache that cannot be saved only costs a re-hash next time.
  }
}

/**
 * LM Studio: `<publisher>/<model>/*.gguf`. File names carry no digest, so files whose size
 * matches a catalog file are hashed, and the hash is remembered by path, size and mtime.
 */
async function scanLmStudio(
  lmDir: string,
  wanted: Wanted,
  options: { hashCacheFile: string; hashFile: FileHasher; signal: AbortSignal | undefined },
): Promise<FoundFile[]> {
  const sizes = new Set(wanted.values());
  const candidates: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const publisher of await entriesOf(lmDir)) {
    if (!publisher.isDirectory() || publisher.name.startsWith(".")) continue;
    for (const model of await entriesOf(join(lmDir, publisher.name))) {
      if (!model.isDirectory() || model.name.startsWith(".")) continue;
      const modelDir = join(lmDir, publisher.name, model.name);
      for (const file of await entriesOf(modelDir)) {
        if (!file.name.toLowerCase().endsWith(".gguf") || file.isDirectory()) continue;
        const path = join(modelDir, file.name);
        try {
          const info = await stat(path);
          if (info.isFile() && sizes.has(info.size)) {
            candidates.push({ path, size: info.size, mtimeMs: info.mtimeMs });
          }
        } catch {
          // Broken link or unreadable: skip.
        }
      }
    }
  }
  if (candidates.length === 0) return [];

  const cache = await loadHashCache(options.hashCacheFile);
  let changed = false;
  const found: FoundFile[] = [];
  for (const candidate of candidates) {
    options.signal?.throwIfAborted();
    const cached = cache.files[candidate.path];
    let digest: string;
    if (cached && cached.size === candidate.size && cached.mtimeMs === candidate.mtimeMs) {
      digest = cached.sha256;
    } else {
      try {
        digest = await options.hashFile(candidate.path, options.signal);
      } catch {
        options.signal?.throwIfAborted();
        continue; // Unreadable file: not a match.
      }
      cache.files[candidate.path] = {
        size: candidate.size,
        mtimeMs: candidate.mtimeMs,
        sha256: digest,
      };
      changed = true;
    }
    if (wanted.get(digest) === candidate.size) {
      found.push({
        source: "lmstudio",
        path: candidate.path,
        sha256: digest,
        sizeBytes: candidate.size,
      });
    }
  }
  if (changed) await saveHashCache(options.hashCacheFile, cache);
  return found;
}

/**
 * Finds catalog files that other apps (or an earlier download) already put on disk, matching
 * by SHA-256. Read-only toward every scanned folder: nothing is moved, linked or modified;
 * the only write is the hash cache file. Returns one record per entry with at least one file
 * found; when a file exists in several places the Hugging Face cache wins, then LM Studio,
 * then Ollama.
 */
export async function scanExistingModels(options: ScanOptions): Promise<ExistingCopy[]> {
  const entries: readonly CatalogEntry[] = Array.isArray(options.catalog)
    ? (options.catalog as readonly CatalogEntry[])
    : (options.catalog as { entries: readonly CatalogEntry[] }).entries;
  const wanted: Wanted = new Map();
  for (const entry of entries) {
    wanted.set(entry.source.sha256, entry.source.sizeBytes);
    if (entry.projector) wanted.set(entry.projector.sha256, entry.projector.sizeBytes);
  }

  const hub = await scanHubCache(options.hubDir ?? resolveHubCacheDir(), wanted);
  options.signal?.throwIfAborted();
  const lmStudio = await scanLmStudio(options.lmStudioDir ?? defaultLmStudioDir(), wanted, {
    hashCacheFile: options.hashCacheFile ?? defaultHashCacheFile(),
    hashFile: options.hashFile ?? defaultHashFile,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  const ollama = await scanOllama(options.ollamaDir ?? defaultOllamaDir(), wanted);

  const best = new Map<string, FoundFile>();
  for (const file of [...hub, ...lmStudio, ...ollama]) {
    if (!best.has(file.sha256)) best.set(file.sha256, file);
  }

  const copies: ExistingCopy[] = [];
  for (const entry of entries) {
    const model = best.get(entry.source.sha256);
    const projector = entry.projector ? best.get(entry.projector.sha256) : undefined;
    if (!model && !projector) continue;
    copies.push({
      entryId: entry.id,
      ...(model ? { model } : {}),
      ...(projector ? { projector } : {}),
      ready: model !== undefined && (entry.projector === undefined || projector !== undefined),
    });
  }
  return copies;
}
