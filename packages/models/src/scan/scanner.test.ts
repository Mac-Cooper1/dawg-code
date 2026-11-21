import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CatalogEntry } from "../types.ts";
import { defaultHashFile, defaultOllamaDir, type FileHasher, scanExistingModels } from "./index.ts";

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** Distinct small "model files" with known digests. */
const MODEL_A = Buffer.from("model A weights ".repeat(64));
const PROJ_A = Buffer.from("projector A ".repeat(32));
const MODEL_B = Buffer.from("model B weights, different size ".repeat(40));
const MODEL_C = Buffer.from("model C ".repeat(100));

function entry(id: string, model: Buffer, projector?: Buffer): CatalogEntry {
  return {
    id,
    displayName: id,
    licence: { spdx: "Apache-2.0", url: "https://example.com" },
    source: {
      repo: `org/${id}-GGUF`,
      revision: "c".repeat(40),
      file: `${id}.gguf`,
      sha256: sha(model),
      sizeBytes: model.length,
    },
    ...(projector
      ? { projector: { file: "mmproj.gguf", sha256: sha(projector), sizeBytes: projector.length } }
      : {}),
    minMemoryBytes: 1,
    context: { default: 1, max: 1 },
    capabilities: { tools: true, vision: projector !== undefined, reasoning: true },
    profile: "test",
    rank: 1,
  };
}

const catalog = [entry("a", MODEL_A, PROJ_A), entry("b", MODEL_B), entry("c", MODEL_C)];

let root: string;
let dirs: { hubDir: string; lmStudioDir: string; ollamaDir: string; hashCacheFile: string };

async function put(path: string, data: Buffer | string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, data);
}

/** Everything under a folder: path, kind, size, mtime and link target. */
async function snapshotTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string) => {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const path = join(current, item.name);
      const info = await lstat(path);
      out.push(`${relative(dir, path)} ${info.mode} ${info.size} ${info.mtimeMs}`);
      if (item.isDirectory()) await walk(path);
    }
  };
  await walk(dir);
  return out.sort();
}

function countingHasher(): FileHasher & { calls: string[] } {
  const calls: string[] = [];
  const hasher = (async (path: string, signal?: AbortSignal) => {
    calls.push(path);
    return defaultHashFile(path, signal);
  }) as FileHasher & { calls: string[] };
  hasher.calls = calls;
  return hasher;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dawg-scan-"));
  dirs = {
    hubDir: join(root, "hf", "hub"),
    lmStudioDir: join(root, "lmstudio", "models"),
    ollamaDir: join(root, "ollama", "models"),
    hashCacheFile: join(root, "dawg", "cache", "file-hashes.json"),
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Hugging Face cache", () => {
  test("matches blobs by their digest name without hashing", async () => {
    const repo = join(dirs.hubDir, "models--org--a-GGUF");
    await put(join(repo, "blobs", sha(MODEL_A)), MODEL_A);
    await put(join(repo, "blobs", sha(PROJ_A)), PROJ_A);
    // A partial download is not a copy.
    await put(join(repo, "blobs", `${sha(MODEL_B)}.incomplete`), MODEL_B.subarray(0, 10));
    await mkdir(join(repo, "snapshots", "c".repeat(40)), { recursive: true });
    await symlink(`../../blobs/${sha(MODEL_A)}`, join(repo, "snapshots", "c".repeat(40), "a.gguf"));
    const hashFile = countingHasher();

    const copies = await scanExistingModels({ catalog, ...dirs, hashFile });
    expect(hashFile.calls).toEqual([]);
    expect(copies).toEqual([
      {
        entryId: "a",
        model: {
          source: "huggingface",
          path: join(repo, "blobs", sha(MODEL_A)),
          sha256: sha(MODEL_A),
          sizeBytes: MODEL_A.length,
        },
        projector: {
          source: "huggingface",
          path: join(repo, "blobs", sha(PROJ_A)),
          sha256: sha(PROJ_A),
          sizeBytes: PROJ_A.length,
        },
        ready: true,
      },
    ]);
  });

  test("a blob whose size is wrong is ignored", async () => {
    await put(join(dirs.hubDir, "models--org--b-GGUF", "blobs", sha(MODEL_B)), "truncated");
    expect(await scanExistingModels({ catalog, ...dirs })).toEqual([]);
  });
});

describe("Ollama", () => {
  test("reads manifests and uses the digest from the layer", async () => {
    const manifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: {
        mediaType: "application/vnd.docker.container.image.v1+json",
        digest: `sha256:${"1".repeat(64)}`,
        size: 10,
      },
      layers: [
        {
          mediaType: "application/vnd.ollama.image.model",
          digest: `sha256:${sha(MODEL_B)}`,
          size: MODEL_B.length,
        },
        {
          mediaType: "application/vnd.ollama.image.template",
          digest: `sha256:${"2".repeat(64)}`,
          size: 5,
        },
      ],
    };
    await put(
      join(dirs.ollamaDir, "manifests", "registry.ollama.ai", "library", "model-b", "latest"),
      JSON.stringify(manifest),
    );
    await put(join(dirs.ollamaDir, "blobs", `sha256-${sha(MODEL_B)}`), MODEL_B);
    // Junk next to manifests must not break the scan.
    await put(
      join(dirs.ollamaDir, "manifests", "registry.ollama.ai", "library", "broken", "x"),
      "{",
    );
    const hashFile = countingHasher();

    const copies = await scanExistingModels({ catalog, ...dirs, hashFile });
    expect(hashFile.calls).toEqual([]);
    expect(copies).toEqual([
      {
        entryId: "b",
        model: {
          source: "ollama",
          path: join(dirs.ollamaDir, "blobs", `sha256-${sha(MODEL_B)}`),
          sha256: sha(MODEL_B),
          sizeBytes: MODEL_B.length,
        },
        ready: true,
      },
    ]);
  });

  test("a manifest whose blob is missing finds nothing", async () => {
    await put(
      join(dirs.ollamaDir, "manifests", "hf.co", "org", "b", "Q4"),
      JSON.stringify({
        layers: [
          { mediaType: "application/vnd.ollama.image.model", digest: `sha256:${sha(MODEL_B)}` },
        ],
      }),
    );
    expect(await scanExistingModels({ catalog, ...dirs })).toEqual([]);
  });

  test("OLLAMA_MODELS moves the default folder", () => {
    expect(defaultOllamaDir({ OLLAMA_MODELS: "/big/ollama" }, "/home")).toBe("/big/ollama");
    expect(defaultOllamaDir({}, "/home")).toBe("/home/.ollama/models");
  });
});

describe("LM Studio", () => {
  const modelPath = () => join(dirs.lmStudioDir, "someone", "model-c-GGUF", "model-c-Q4_K_M.gguf");

  test("hashes size-matching GGUF files and caches the result", async () => {
    await put(modelPath(), MODEL_C);
    // Same size as a catalog file but different bytes: hashed, not matched.
    const impostor = Buffer.alloc(MODEL_C.length, 7);
    await put(join(dirs.lmStudioDir, "someone", "other", "impostor.gguf"), impostor);
    // No catalog file has this size: never hashed.
    await put(join(dirs.lmStudioDir, "someone", "other", "small.gguf"), "tiny");
    // Not a GGUF.
    await put(join(dirs.lmStudioDir, "someone", "model-c-GGUF", "README.md"), MODEL_C);

    const first = countingHasher();
    const copies = await scanExistingModels({ catalog, ...dirs, hashFile: first });
    expect(first.calls.sort()).toEqual(
      [modelPath(), join(dirs.lmStudioDir, "someone", "other", "impostor.gguf")].sort(),
    );
    expect(copies).toEqual([
      {
        entryId: "c",
        model: {
          source: "lmstudio",
          path: modelPath(),
          sha256: sha(MODEL_C),
          sizeBytes: MODEL_C.length,
        },
        ready: true,
      },
    ]);

    // Second scan: everything comes from the cache.
    const second = countingHasher();
    expect(await scanExistingModels({ catalog, ...dirs, hashFile: second })).toEqual(copies);
    expect(second.calls).toEqual([]);
    const cache = JSON.parse(await readFile(dirs.hashCacheFile, "utf8"));
    expect(cache.files[modelPath()].sha256).toBe(sha(MODEL_C));
  });

  test("a changed mtime or size invalidates the cached hash", async () => {
    await put(modelPath(), MODEL_C);
    await scanExistingModels({ catalog, ...dirs, hashFile: countingHasher() });

    const later = new Date(Date.now() + 60_000);
    await utimes(modelPath(), later, later);
    const afterTouch = countingHasher();
    await scanExistingModels({ catalog, ...dirs, hashFile: afterTouch });
    expect(afterTouch.calls).toEqual([modelPath()]);

    // Replaced by different bytes of the same size: re-hashed, no longer a match.
    await writeFile(modelPath(), Buffer.alloc(MODEL_C.length, 1));
    const afterReplace = countingHasher();
    expect(await scanExistingModels({ catalog, ...dirs, hashFile: afterReplace })).toEqual([]);
    expect(afterReplace.calls).toEqual([modelPath()]);
  });

  test("a corrupt hash cache is ignored and rebuilt", async () => {
    await put(modelPath(), MODEL_C);
    await put(dirs.hashCacheFile, "not json");
    const copies = await scanExistingModels({ catalog, ...dirs });
    expect(copies.map((c) => c.entryId)).toEqual(["c"]);
    expect(JSON.parse(await readFile(dirs.hashCacheFile, "utf8")).version).toBe(1);
  });
});

describe("across sources", () => {
  test("prefers the HF cache, reports partial entries, and changes nothing it scans", async () => {
    // Model A in LM Studio and in the HF cache; its projector only in Ollama.
    await put(join(dirs.lmStudioDir, "p", "a", "a.gguf"), MODEL_A);
    await put(join(dirs.hubDir, "models--org--a-GGUF", "blobs", sha(MODEL_A)), MODEL_A);
    await put(
      join(dirs.ollamaDir, "manifests", "registry.ollama.ai", "library", "a", "latest"),
      JSON.stringify({
        layers: [
          { mediaType: "application/vnd.ollama.image.projector", digest: `sha256:${sha(PROJ_A)}` },
        ],
      }),
    );
    await put(join(dirs.ollamaDir, "blobs", `sha256-${sha(PROJ_A)}`), PROJ_A);
    // Model B's projector-less entry is absent; entry "c" only has nothing.
    const before = await Promise.all([
      snapshotTree(dirs.hubDir),
      snapshotTree(dirs.lmStudioDir),
      snapshotTree(dirs.ollamaDir),
    ]);

    const copies = await scanExistingModels({ catalog: { entries: catalog }, ...dirs });
    expect(copies).toHaveLength(1);
    expect(copies[0]?.model?.source).toBe("huggingface");
    expect(copies[0]?.projector?.source).toBe("ollama");
    expect(copies[0]?.ready).toBe(true);

    const after = await Promise.all([
      snapshotTree(dirs.hubDir),
      snapshotTree(dirs.lmStudioDir),
      snapshotTree(dirs.ollamaDir),
    ]);
    expect(after).toEqual(before);
  });

  test("a model without its projector is found but not ready", async () => {
    await put(join(dirs.hubDir, "models--org--a-GGUF", "blobs", sha(MODEL_A)), MODEL_A);
    const copies = await scanExistingModels({ catalog, ...dirs });
    expect(copies).toEqual([expect.objectContaining({ entryId: "a", ready: false })]);
    expect(copies[0]?.projector).toBeUndefined();
  });

  test("missing folders are simply empty", async () => {
    expect(await scanExistingModels({ catalog, ...dirs })).toEqual([]);
  });

  test("an aborted scan throws", async () => {
    await put(join(dirs.lmStudioDir, "p", "c", "c.gguf"), MODEL_C);
    await expect(
      scanExistingModels({ catalog, ...dirs, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
});
