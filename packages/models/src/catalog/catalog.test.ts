import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CatalogEntry, HardwareProfile } from "../types.ts";
import {
  BUNDLED_CATALOG_PATH,
  CACHE_BYTES_PER_TOKEN,
  CatalogEntrySchema,
  entryMemoryNeed,
  fitsMemoryRule,
  loadCatalog,
  maxContextForMemory,
  parseCatalog,
  recommend,
  requiredMemoryBytes,
} from "./index.ts";

const GiB = 1024 ** 3;
const HEX64 = "a".repeat(64);
const COMMIT = "b".repeat(40);

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "test-model-q4",
    displayName: "Test model",
    licence: { spdx: "Apache-2.0", url: "https://example.com/LICENSE" },
    source: {
      repo: "org/Test-GGUF",
      revision: COMMIT,
      file: "test-Q4_K_M.gguf",
      sha256: HEX64,
      sizeBytes: 1000,
    },
    minMemoryBytes: 24 * GiB,
    context: { default: 65536, max: 131072 },
    capabilities: { tools: true, vision: false, reasoning: true },
    profile: "test",
    rank: 1,
    ...overrides,
  };
}

function catalogOf(entries: CatalogEntry[], version = 1) {
  return { schemaVersion: 1, version, entries };
}

describe("schema", () => {
  test("accepts a well-formed entry", () => {
    expect(CatalogEntrySchema.safeParse(entry()).success).toBe(true);
  });

  const bad: Array<[string, unknown]> = [
    ["branch instead of commit", { source: { ...entry().source, revision: "main" } }],
    ["short sha256", { source: { ...entry().source, sha256: "abc" } }],
    ["uppercase sha256", { source: { ...entry().source, sha256: "A".repeat(64) } }],
    ["zero size", { source: { ...entry().source, sizeBytes: 0 } }],
    ["fractional size", { source: { ...entry().source, sizeBytes: 1.5 } }],
    ["path escape", { source: { ...entry().source, file: "../x.gguf" } }],
    ["absolute path", { source: { ...entry().source, file: "/x.gguf" } }],
    ["repo without org", { source: { ...entry().source, repo: "Test-GGUF" } }],
    ["default above max", { context: { default: 200000, max: 131072 } }],
    ["vision without projector", { capabilities: { tools: true, vision: true, reasoning: true } }],
    [
      "projector without vision",
      { projector: { file: "mmproj.gguf", sha256: HEX64, sizeBytes: 1 } },
    ],
    ["intel chip class", { chipClasses: ["intel"] }],
    ["empty chip classes", { chipClasses: [] }],
    ["unknown field", { extra: true }],
    ["http licence url", { licence: { spdx: "MIT", url: "http://example.com" } }],
    ["uppercase id", { id: "Test" }],
  ];
  test.each(bad)("rejects %s", (_label, overrides) => {
    const result = CatalogEntrySchema.safeParse({ ...entry(), ...(overrides as object) });
    expect(result.success).toBe(false);
  });

  test("rejects duplicate ids and wrong schema versions", () => {
    expect(() => parseCatalog(catalogOf([entry(), entry()]))).toThrow(/duplicate id/);
    expect(() => parseCatalog({ ...catalogOf([entry()]), schemaVersion: 2 })).toThrow();
  });
});

describe("loadCatalog", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dawg-catalog-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const bundled = catalogOf([entry({ id: "bundled" })], 1);
  const newer = catalogOf([entry({ id: "remote" })], 2);
  const jsonFetch =
    (body: unknown, status = 200): typeof fetch =>
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  test("uses a valid remote catalog and caches it", async () => {
    const cacheFile = join(dir, "sub", "catalog.json");
    const loaded = await loadCatalog({
      bundled,
      remoteUrl: "https://catalog.test/catalog.json",
      cacheFile,
      fetch: jsonFetch(newer),
    });
    expect(loaded.source).toBe("remote");
    expect(loaded.catalog.entries[0]?.id).toBe("remote");
    expect(JSON.parse(await readFile(cacheFile, "utf8"))).toEqual(newer);
  });

  test.each([
    ["network error", (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch],
    ["HTTP 500", jsonFetch("oops", 500)],
    ["not JSON", jsonFetch("<html>")],
    ["invalid catalog", jsonFetch({ schemaVersion: 1, version: 9, entries: [{ id: "x" }] })],
  ])("%s falls back to the last good cached copy", async (_label, fetchImpl) => {
    const cacheFile = join(dir, "catalog.json");
    await writeFile(cacheFile, JSON.stringify(newer));
    const loaded = await loadCatalog({
      bundled,
      remoteUrl: "https://catalog.test/catalog.json",
      cacheFile,
      fetch: fetchImpl,
    });
    expect(loaded.source).toBe("cache");
    expect(loaded.catalog.entries[0]?.id).toBe("remote");
    expect(loaded.problems.length).toBeGreaterThan(0);
    // The bad response did not overwrite the good cache.
    expect(JSON.parse(await readFile(cacheFile, "utf8"))).toEqual(newer);
  });

  test("times out a hanging fetch and falls back to the bundled copy", async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const loaded = await loadCatalog({
      bundled,
      remoteUrl: "https://catalog.test/catalog.json",
      cacheFile: join(dir, "missing.json"),
      fetch: hanging,
      timeoutMs: 20,
    });
    expect(loaded.source).toBe("bundled");
    expect(loaded.catalog.entries[0]?.id).toBe("bundled");
  });

  test("a corrupt cache falls back to the bundled copy", async () => {
    const cacheFile = join(dir, "catalog.json");
    await writeFile(cacheFile, "{ not json");
    const loaded = await loadCatalog({ bundled, cacheFile });
    expect(loaded.source).toBe("bundled");
  });

  test("an older remote or cached copy does not replace a newer bundled one", async () => {
    const cacheFile = join(dir, "catalog.json");
    const old = catalogOf([entry({ id: "old" })], 0);
    const remote = await loadCatalog({
      bundled,
      remoteUrl: "https://catalog.test/c.json",
      fetch: jsonFetch(old),
    });
    expect(remote.source).toBe("bundled");
    await writeFile(cacheFile, JSON.stringify(old));
    expect((await loadCatalog({ bundled, cacheFile })).source).toBe("bundled");
  });

  test("an invalid bundled catalog is a packaging bug and throws", async () => {
    await expect(loadCatalog({ bundled: { entries: [] } })).rejects.toThrow(/bundled catalog/);
  });

  test("rejects an oversized remote response", async () => {
    const loaded = await loadCatalog({
      bundled,
      remoteUrl: "https://catalog.test/c.json",
      fetch: jsonFetch(newer),
      maxBytes: 10,
    });
    expect(loaded.source).toBe("bundled");
  });
});

describe("recommend", () => {
  const sparse = { chipClasses: ["base", "pro"] as CatalogEntry["chipClasses"] };
  const catalog = [
    entry({ id: "small", minMemoryBytes: 24 * GiB, rank: 10 }),
    entry({ id: "dense-32", minMemoryBytes: 32 * GiB, rank: 20 }),
    entry({ id: "sparse-32", minMemoryBytes: 32 * GiB, rank: 30, ...sparse }),
    entry({ id: "sparse-36", minMemoryBytes: 36 * GiB, rank: 35, ...sparse }),
    entry({ id: "dense-48", minMemoryBytes: 48 * GiB, rank: 40 }),
    entry({ id: "dense-64", minMemoryBytes: 64 * GiB, rank: 50 }),
  ];

  function machine(memoryGiB: number, chipClass: HardwareProfile["chipClass"]): HardwareProfile {
    return {
      arch: chipClass === "intel" ? "x64" : "arm64",
      chip: "test",
      chipClass,
      memoryBytes: memoryGiB * GiB,
      performanceCores: 8,
      freeDiskBytes: 1000 * GiB,
      macosVersion: "15.0",
    };
  }

  test.each([
    [16, "base", []],
    [18, "pro", []],
    [64, "intel", []],
    [24, "base", ["small"]],
    [32, "base", ["sparse-32", "dense-32", "small"]],
    [32, "pro", ["sparse-32", "dense-32", "small"]],
    [32, "max", ["dense-32", "small"]],
    [36, "pro", ["sparse-36", "sparse-32", "dense-32", "small"]],
    [36, "max", ["dense-32", "small"]],
    [48, "pro", ["dense-48", "sparse-36", "sparse-32", "dense-32", "small"]],
    [64, "max", ["dense-64", "dense-48", "dense-32", "small"]],
    [128, "ultra", ["dense-64", "dense-48", "dense-32", "small"]],
  ] as const)("%i GiB %s → %j", (memory, chipClass, expected) => {
    expect(recommend(machine(memory, chipClass), catalog).map((e) => e.id)).toEqual(expected);
  });

  test("an x64 machine gets nothing even if mislabelled", () => {
    expect(recommend({ ...machine(128, "max"), arch: "x64" }, catalog)).toEqual([]);
  });

  test("accepts a whole catalog object and breaks rank ties by tier then id", () => {
    const tied = catalogOf([
      entry({ id: "b", rank: 5, minMemoryBytes: 24 * GiB }),
      entry({ id: "a", rank: 5, minMemoryBytes: 24 * GiB }),
      entry({ id: "c", rank: 5, minMemoryBytes: 32 * GiB }),
    ]);
    expect(recommend(machine(64, "max"), tied).map((e) => e.id)).toEqual(["c", "a", "b"]);
  });
});

describe("memory rule", () => {
  test("weights + cache + 2 GiB within 70% of memory", () => {
    const need = { weightsBytes: 10 * GiB, cacheBytesPerToken: 65536, contextTokens: 65536 };
    // 10 + 4 + 2 = 16 GiB working set → needs 16 / 0.7 ≈ 22.86 GiB.
    expect(requiredMemoryBytes(need)).toBe(Math.ceil((16 * GiB) / 0.7));
    expect(fitsMemoryRule(need, 23 * GiB)).toBe(true);
    expect(fitsMemoryRule(need, 22 * GiB)).toBe(false);
    expect(maxContextForMemory(10 * GiB, 65536, 32 * GiB)).toBe(
      Math.floor((32 * GiB * 0.7 - 12 * GiB) / 65536),
    );
    expect(maxContextForMemory(30 * GiB, 65536, 32 * GiB)).toBe(0);
  });
});

describe("the real catalog file", () => {
  const raw = JSON.parse(readFileSync(BUNDLED_CATALOG_PATH, "utf8"));
  const catalog = parseCatalog(raw, "catalog/catalog.json");

  test("validates and loads as the bundled catalog", async () => {
    const loaded = await loadCatalog();
    expect(loaded.source).toBe("bundled");
    expect(loaded.catalog).toEqual(catalog);
    expect(catalog.entries.length).toBeGreaterThan(0);
  });

  test("has nothing below the 24 GB tier and no Intel entries", () => {
    for (const e of catalog.entries) {
      expect(e.minMemoryBytes).toBeGreaterThanOrEqual(24 * GiB);
      expect(e.chipClasses ?? []).not.toContain("intel");
    }
  });

  test.each(catalog.entries.map((e) => [e.id, e] as const))(
    "%s satisfies the memory rule at its default context for its own minMemoryBytes",
    (_id, e) => {
      expect(
        CACHE_BYTES_PER_TOKEN[e.source.repo],
        `no cache estimate for ${e.source.repo}`,
      ).toBeGreaterThan(0);
      const need = entryMemoryNeed(e);
      expect(need, `no cache estimate for ${e.source.repo}`).toBeDefined();
      if (!need) return;
      expect(fitsMemoryRule(need, e.minMemoryBytes)).toBe(true);
    },
  );

  test("recommends the PLAN.md section 6 tiers", () => {
    const pick = (memoryGiB: number, chipClass: HardwareProfile["chipClass"]) =>
      recommend(
        {
          arch: "arm64",
          chip: "test",
          chipClass,
          memoryBytes: memoryGiB * GiB,
          performanceCores: 8,
          freeDiskBytes: 0,
          macosVersion: "15.0",
        },
        catalog,
      )[0]?.id;
    expect(pick(16, "base")).toBeUndefined();
    expect(pick(24, "pro")).toBe("gpt-oss-20b-q4");
    expect(pick(32, "max")).toBe("qwen3.8-27b-q4");
    expect(pick(32, "base")).toBe("qwen3.6-35b-a3b-q4");
    expect(pick(36, "pro")).toBe("laguna-xs-2.1-q4");
    expect(pick(48, "max")).toBe("qwen3.8-27b-q6");
    expect(pick(64, "max")).toBe("qwen3.8-27b-q8");
    expect(pick(128, "ultra")).toBe("qwen3.8-27b-q8");
  });
});
