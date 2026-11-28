import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSearchSettings } from "@dawg/engine";
import { afterEach, describe, expect, it } from "vitest";
import { IPC } from "../../shared/bridge.ts";
import { fakeEncryption } from "../models/test-fakes.ts";
import { createWebInvokeHandlers } from "./ipc.ts";
import { CHECK_QUERY, createWebSettingsService, SEARCH_KEYS_FILE } from "./service.ts";

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dawg-web-settings-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

function braveAnswer(count: number) {
  return JSON.stringify({
    web: {
      results: Array.from({ length: count }, (_, i) => ({
        title: `R${i}`,
        url: `https://example.com/${i}`,
        description: "",
      })),
    },
  });
}

async function service(
  options: { status?: number; body?: string; encryption?: typeof fakeEncryption } = {},
) {
  const dataRoot = await tempDir();
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const web = createWebSettingsService({
    dataRoot,
    encryption: options.encryption ?? fakeEncryption,
    log: () => {},
    fetch: async (url, init) => {
      requests.push({ url, headers: init.headers as Record<string, string> });
      return new Response(options.body ?? braveAnswer(3), { status: options.status ?? 200 });
    },
  });
  const changes: unknown[] = [];
  web.onChange((config) => changes.push(config));
  return { web, dataRoot, requests, changes };
}

describe("web settings in main", () => {
  it("starts with web search off", async () => {
    const { web } = await service();
    expect(await web.state()).toEqual({
      provider: null,
      searxngUrl: null,
      keys: { brave: false, tavily: false },
      keychainAvailable: true,
    });
    expect(web.hostConfig()).toBeNull();
  });

  it("keeps the key encrypted and out of the settings file, and hands it to the engine host", async () => {
    const { web, dataRoot, changes } = await service();
    const state = await web.write({ provider: "brave", apiKey: "BSA-secret-123" });
    expect(state.provider).toBe("brave");
    expect(state.keys.brave).toBe(true);
    expect(JSON.stringify(state)).not.toContain("BSA-secret-123");

    const settingsText = await readFile(path.join(dataRoot, "web-search.json"), "utf8");
    expect(settingsText).not.toContain("BSA-secret-123");
    expect(await readSearchSettings(dataRoot)).toEqual({ provider: "brave", searxngUrl: null });
    const keysFile = path.join(dataRoot, SEARCH_KEYS_FILE);
    expect(await readFile(keysFile, "utf8")).not.toContain("BSA-secret-123");
    expect((await stat(keysFile)).mode & 0o777).toBe(0o600);

    expect(web.hostConfig()).toEqual({ provider: "brave", apiKey: "BSA-secret-123" });
    expect(changes).toEqual([{ provider: "brave", apiKey: "BSA-secret-123" }]);
  });

  it("reads what was saved after a relaunch", async () => {
    const { web, dataRoot } = await service();
    await web.write({ provider: "tavily", apiKey: "tvly-1" });
    const again = createWebSettingsService({ dataRoot, encryption: fakeEncryption, log: () => {} });
    await again.load();
    expect(again.hostConfig()).toEqual({ provider: "tavily", apiKey: "tvly-1" });
  });

  it("refuses a service without what it needs", async () => {
    const { web } = await service();
    await expect(web.write({ provider: "tavily" })).rejects.toThrow("Tavily needs an API key.");
    await expect(web.write({ provider: "searxng" })).rejects.toThrow(
      "SearXNG needs the address of an instance.",
    );
    expect((await web.state()).provider).toBeNull();
  });

  it("uses a SearXNG address without a key", async () => {
    const { web } = await service();
    await web.write({ provider: "searxng", searxngUrl: "http://localhost:8888" });
    expect(web.hostConfig()).toEqual({ provider: "searxng", url: "http://localhost:8888" });
  });

  it("keeps keys when web search is turned off, and switches back without asking again", async () => {
    const { web } = await service();
    await web.write({ provider: "brave", apiKey: "k1" });
    await web.write({ provider: null });
    expect(web.hostConfig()).toBeNull();
    expect((await web.state()).keys.brave).toBe(true);
    await web.write({ provider: "brave" });
    expect(web.hostConfig()).toEqual({ provider: "brave", apiKey: "k1" });
  });

  it("turns web search off when the key in use is removed", async () => {
    const { web, changes } = await service();
    await web.write({ provider: "brave", apiKey: "k1" });
    const state = await web.removeKey("brave");
    expect(state).toMatchObject({ provider: null, keys: { brave: false } });
    expect(web.hostConfig()).toBeNull();
    expect(changes.at(-1)).toBeNull();
  });

  it("refuses to store a key without the Keychain", async () => {
    const { web } = await service({
      encryption: { ...fakeEncryption, isEncryptionAvailable: () => false },
    });
    await expect(web.write({ provider: "brave", apiKey: "k" })).rejects.toThrow(
      /Keychain is not available/,
    );
    expect((await web.state()).keychainAvailable).toBe(false);
  });
});

describe("Check it works", () => {
  it("runs one search with the key given, without saving it", async () => {
    const { web, requests } = await service();
    expect(await web.check({ provider: "brave", apiKey: "trial-key" })).toEqual({
      ok: true,
      message: "Brave Search answered with 3 results.",
    });
    expect(new URL(requests[0]?.url ?? "").searchParams.get("q")).toBe(CHECK_QUERY);
    expect(requests[0]?.headers["x-subscription-token"]).toBe("trial-key");
    expect((await web.state()).keys.brave).toBe(false);
  });

  it("uses the stored key when none is given", async () => {
    const { web, requests } = await service();
    await web.write({ provider: "brave", apiKey: "stored" });
    await web.check({ provider: "brave" });
    expect(requests[0]?.headers["x-subscription-token"]).toBe("stored");
  });

  it("says what went wrong", async () => {
    expect(
      await (await service({ status: 401 })).web.check({ provider: "brave", apiKey: "x" }),
    ).toEqual({
      ok: false,
      message:
        "Brave Search refused the key (401). Check the key in Settings → Web, or DAWG_SEARCH_API_KEY.",
    });
    expect(await (await service()).web.check({ provider: "tavily" })).toEqual({
      ok: false,
      message: "Tavily needs an API key.",
    });
  });
});

describe("its IPC", () => {
  it("validates input before it reaches the service", async () => {
    const { web } = await service();
    const handlers = createWebInvokeHandlers<string>(web);
    await expect(handlers[IPC.webWrite]?.("w", [{ provider: "google" }])).rejects.toThrow(
      /Invalid web settings/,
    );
    await expect(
      handlers[IPC.webWrite]?.("w", [{ provider: "brave", apiKey: "k", evil: 1 }]),
    ).rejects.toThrow(/Invalid web settings/);
    await expect(
      handlers[IPC.webWrite]?.("w", [{ provider: "searxng", searxngUrl: "file:///etc" }]),
    ).rejects.toThrow(/Invalid web settings/);
    await expect(handlers[IPC.webRemoveKey]?.("w", ["searxng"])).rejects.toThrow(
      /Invalid search service/,
    );
    await expect(handlers[IPC.webCheck]?.("w", [{ provider: null }])).rejects.toThrow(
      /Invalid web settings/,
    );
    for (const channel of [IPC.webRead, IPC.webWrite, IPC.webRemoveKey, IPC.webCheck]) {
      expect(handlers[channel]).toBeTypeOf("function");
    }
  });
});
