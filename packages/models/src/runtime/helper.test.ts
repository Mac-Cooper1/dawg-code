import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cachePaths } from "../download/paths.ts";
import type { CatalogEntry } from "../types.ts";
import { buildLaunchArgs } from "./args.ts";
import {
  findDownloadedHelper,
  HELPER_SETTINGS_FILE,
  helperPaths,
  helperRuntimeConfig,
  readHelperEnabled,
  writeHelperEnabled,
} from "./helper.ts";

function helperEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    id: "tiny-helper-q8",
    role: "helper",
    displayName: "Tiny helper (8-bit)",
    licence: { spdx: "Apache-2.0", url: "https://example.com/LICENSE" },
    source: {
      repo: "org/Tiny-GGUF",
      revision: "c".repeat(40),
      file: "tiny-Q8_0.gguf",
      sha256: "d".repeat(64),
      sizeBytes: 64,
    },
    minMemoryBytes: 48 * 1024 ** 3,
    context: { default: 32768, max: 131072 },
    capabilities: { tools: false, vision: false, reasoning: true },
    profile: "minicpm5",
    rank: 10,
    ...overrides,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dawg-helper-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("helperRuntimeConfig", () => {
  test("one slot of the entry's window, thinking off, no prompt cache, named by its id", () => {
    const config = helperRuntimeConfig({
      entry: helperEntry(),
      modelPath: "/models/tiny.gguf",
      idleUnloadSeconds: 600,
    });
    expect(config).toMatchObject({
      contextSize: 32768,
      slots: 1,
      slotIds: [0],
      settings: {
        alias: "tiny-helper-q8",
        kvUnified: false,
        cacheRamMiB: 0,
        ctxCheckpoints: 0,
        reasoning: { mode: "off" },
        idleUnloadSeconds: 600,
      },
    });
    const args = buildLaunchArgs({
      ...config,
      port: 8123,
      paths: { apiKeyFile: "/k", slotSaveDir: "/s", logFile: "/l" },
    });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at("-c")).toBe("32768");
    expect(at("-np")).toBe("1");
    expect(at("--reasoning")).toBe("off");
    expect(at("--cache-ram")).toBe("0");
    expect(at("--sleep-idle-seconds")).toBe("600");
    expect(at("--alias")).toBe("tiny-helper-q8");
    expect(args).toContain("--no-kv-unified");
  });

  test("a window can be set, and idle unload left off", () => {
    const config = helperRuntimeConfig({
      entry: helperEntry(),
      modelPath: "/m.gguf",
      contextTokens: 8192,
    });
    expect(config.contextSize).toBe(8192);
    expect(config.settings.idleUnloadSeconds).toBeUndefined();
  });

  test("keeps its logs apart from the main runtime's", () => {
    expect(helperPaths("/data")).toEqual({
      slotSaveDir: "/data/runtime/helper-slots",
      logDir: "/data/logs",
      logPrefix: "helper-",
    });
  });
});

describe("the on/off setting", () => {
  test("is on until the person turns it off, and survives junk", async () => {
    expect(await readHelperEnabled(dir)).toBe(true);
    await writeHelperEnabled(dir, false);
    expect(await readHelperEnabled(dir)).toBe(false);
    expect(JSON.parse(await readFile(path.join(dir, HELPER_SETTINGS_FILE), "utf8"))).toEqual({
      enabled: false,
    });
    await writeHelperEnabled(dir, true);
    expect(await readHelperEnabled(dir)).toBe(true);
    await writeFile(path.join(dir, HELPER_SETTINGS_FILE), "{ not json");
    expect(await readHelperEnabled(dir)).toBe(true);
  });
});

describe("findDownloadedHelper", () => {
  async function place(entry: CatalogEntry, bytes: number) {
    const s = entry.source;
    const paths = cachePaths(dir, s.repo, s.revision, s.file, s.sha256);
    await mkdir(path.dirname(paths.blobPath), { recursive: true });
    await writeFile(paths.blobPath, Buffer.alloc(bytes, 1));
    await mkdir(path.dirname(paths.snapshotPath), { recursive: true });
    await symlink(paths.snapshotTarget, paths.snapshotPath);
    return paths.snapshotPath;
  }

  test("finds the catalog's helper in the Hugging Face cache at its pinned revision", async () => {
    const entry = helperEntry();
    const main = { ...helperEntry({ id: "main-q4" }), role: "main" as const };
    const snapshot = await place(entry, 64);
    expect(await findDownloadedHelper({ catalog: [main, entry], hubDir: dir })).toEqual({
      entry,
      modelPath: snapshot,
    });
  });

  test("ignores a file of the wrong size, a missing file and a catalog without a helper", async () => {
    const entry = helperEntry();
    expect(await findDownloadedHelper({ catalog: [entry], hubDir: dir })).toBeNull();
    await place(entry, 63);
    expect(await findDownloadedHelper({ catalog: [entry], hubDir: dir })).toBeNull();
    const { role: _role, ...main } = entry;
    expect(await findDownloadedHelper({ catalog: { entries: [main] }, hubDir: dir })).toBeNull();
  });
});
