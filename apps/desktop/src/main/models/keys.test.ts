import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  displayUrl,
  fileModelId,
  formatContext,
  formatDisk,
  formatMemory,
  remoteServerId,
  shortLabelFor,
  splitServerModelId,
} from "./format.ts";
import { createKeyStore, KEYS_FILE } from "./keys.ts";
import { createModelsStore, modelsFilePath } from "./store.ts";
import { fakeEncryption } from "./test-fakes.ts";

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dawg-keys-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

describe("server keys", () => {
  it("are stored encrypted, readable only to this user, and survive a relaunch", async () => {
    const dir = await tempDir();
    const keys = createKeyStore(dir, fakeEncryption, () => {});
    await keys.load();
    await keys.set("remote:abc123", "sk-secret-key");
    expect(keys.has("remote:abc123")).toBe(true);
    const file = path.join(dir, KEYS_FILE);
    expect(await readFile(file, "utf8")).not.toContain("sk-secret-key");
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const again = createKeyStore(dir, fakeEncryption, () => {});
    await again.load();
    expect(again.has("remote:abc123")).toBe(true);
    expect(await again.get("remote:abc123")).toBe("sk-secret-key");
    expect(await again.get("remote:other")).toBeUndefined();

    await again.delete("remote:abc123");
    expect(again.has("remote:abc123")).toBe(false);
    await expect(stat(file)).rejects.toThrow();
  });

  it("refuses to store a key when the Keychain is not available", async () => {
    const dir = await tempDir();
    const keys = createKeyStore(
      dir,
      { ...fakeEncryption, isEncryptionAvailable: () => false },
      () => {},
    );
    await keys.load();
    await expect(keys.set("remote:abc123", "sk")).rejects.toThrow(/cannot be stored safely/);
    expect(keys.has("remote:abc123")).toBe(false);
  });

  it("ignores a damaged key file, and a key it cannot decrypt", async () => {
    const dir = await tempDir();
    const logs: string[] = [];
    await writeFile(path.join(dir, KEYS_FILE), "{ not json");
    const keys = createKeyStore(dir, fakeEncryption, (m) => logs.push(m));
    await keys.load();
    expect(keys.has("anything")).toBe(false);
    expect(logs[0]).toMatch(/not a valid key file/);

    const broken = createKeyStore(
      dir,
      {
        ...fakeEncryption,
        decryptString: () => {
          throw new Error("bad key");
        },
      },
      (m) => logs.push(m),
    );
    await broken.load();
    await broken.set("remote:x", "sk");
    expect(await broken.get("remote:x")).toBeUndefined();
    expect(logs.join("\n")).not.toContain("sk\n");
  });
});

describe("the saved models file", () => {
  it("keeps the good fields of a file edited by hand", async () => {
    const dir = await tempDir();
    const file = modelsFilePath(dir);
    await writeFile(
      file,
      JSON.stringify({
        installed: [{ id: "a", source: "download", modelPath: "/m/a.gguf" }],
        idleUnloadMinutes: -3,
        defaultModelId: "a",
      }),
    );
    const logs: string[] = [];
    const saved = await createModelsStore(file, (m) => logs.push(m)).load();
    expect(saved).toMatchObject({ defaultModelId: "a", idleUnloadMinutes: null, files: [] });
    expect(saved.installed).toHaveLength(1);
    expect(logs[0]).toMatch(/idleUnloadMinutes/);
  });
});

describe("ids and labels", () => {
  it("makes stable ids", () => {
    expect(fileModelId("/m/a.gguf")).toMatch(/^file:[0-9a-f]{64}$/);
    expect(fileModelId("/m/a.gguf")).toBe(fileModelId("/m/../m/a.gguf"));
    expect(remoteServerId("https://example.com/v1")).toMatch(/^remote:[0-9a-f]{6}$/);
    expect(splitServerModelId("ollama/qwen3:32b", ["ollama", "lmstudio"])).toEqual({
      serverId: "ollama",
      model: "qwen3:32b",
    });
    expect(splitServerModelId("remote:1f3a9c/org/model", ["remote:1f3a9c"])).toEqual({
      serverId: "remote:1f3a9c",
      model: "org/model",
    });
    expect(splitServerModelId("qwen3.8-27b-q8", ["ollama"])).toBeNull();
    expect(splitServerModelId("ollama/", ["ollama"])).toBeNull();
  });

  it("formats names and sizes", () => {
    expect(shortLabelFor("Qwen3.8 27B (8-bit)")).toBe("Qwen3.8 27B · 8-bit");
    expect(shortLabelFor("Plain name")).toBe("Plain name");
    expect(formatContext(131_072)).toBe("128K");
    expect(formatContext(40_000)).toBe("39.1K");
    expect(formatContext(512)).toBe("512");
    expect(formatMemory(64 * 1024 ** 3)).toBe("64 GB");
    expect(formatMemory(1.5 * 1024 ** 3)).toBe("1.5 GB");
    expect(formatDisk(29_640_000_000)).toBe("29.6 GB");
    expect(formatDisk(900_000_000)).toBe("900 MB");
    expect(displayUrl("https://user:pw@example.com/v1?key=1")).toBe("https://example.com");
    expect(displayUrl("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
  });
});
