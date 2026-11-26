import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEFAULT_WINDOW_STATE } from "../shared/bridge.ts";
import { readJsonObject, writeJsonAtomic } from "./json-file.ts";
import { resolveDataRoot, settingsFile, stateFile } from "./paths.ts";
import { createSettingsStore, createWindowStateStore } from "./stores.ts";

let root: string;
let logs: string[];
const log = (message: string) => logs.push(message);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-stores-"));
  logs = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

describe("resolveDataRoot", () => {
  it("uses DAWG_HOME when set, else ~/.dawg", () => {
    expect(resolveDataRoot({ DAWG_HOME: "/tmp/x" }, "/home/me")).toBe("/tmp/x");
    expect(resolveDataRoot({ DAWG_HOME: "  " }, "/home/me")).toBe("/home/me/.dawg");
    expect(resolveDataRoot({}, "/home/me")).toBe("/home/me/.dawg");
  });
});

describe("JSON files", () => {
  it("treats missing and blank files as missing", async () => {
    const file = path.join(root, "a.json");
    expect(await readJsonObject(file)).toEqual({ kind: "missing" });
    await writeFile(file, "  \n");
    expect(await readJsonObject(file)).toEqual({ kind: "missing" });
  });

  it("reports invalid JSON and non-objects as unreadable", async () => {
    const file = path.join(root, "a.json");
    await writeFile(file, "{ nope");
    expect((await readJsonObject(file)).kind).toBe("unreadable");
    await writeFile(file, "[1, 2]");
    expect((await readJsonObject(file)).kind).toBe("unreadable");
  });

  it("writes atomically, creating the folder and leaving no temp files", async () => {
    const file = path.join(root, "deep", "er", "a.json");
    await writeJsonAtomic(file, { a: 1 });
    expect(await readJson(file)).toEqual({ a: 1 });
    expect(await readdir(path.dirname(file))).toEqual(["a.json"]);
  });
});

describe("settings store", () => {
  it("returns defaults when there is no file, and creates it on update", async () => {
    const store = createSettingsStore(settingsFile(path.join(root, "new")), log);
    expect(await store.get()).toEqual(DEFAULT_SETTINGS);
    const saved = await store.update({ appearance: "light" });
    expect(saved).toEqual({ ...DEFAULT_SETTINGS, appearance: "light" });
    expect(await readJson(settingsFile(path.join(root, "new")))).toEqual({
      desktop: { ...DEFAULT_SETTINGS, appearance: "light" },
    });
  });

  it("keeps every other key, including unknown ones under desktop", async () => {
    const file = settingsFile(root);
    await writeFile(
      file,
      JSON.stringify({
        permissions: { allow: ["Bash(npm test)"] },
        model: "qwen",
        desktop: { appearance: "dark", futureThing: 3 },
      }),
    );
    const store = createSettingsStore(file, log);
    expect((await store.get()).appearance).toBe("dark");
    await store.update({ toolCalls: "open" });
    expect(await readJson(file)).toEqual({
      permissions: { allow: ["Bash(npm test)"] },
      model: "qwen",
      desktop: { ...DEFAULT_SETTINGS, appearance: "dark", toolCalls: "open", futureThing: 3 },
    });
  });

  it("never overwrites a file it could not parse, but applies the change for this run", async () => {
    const file = settingsFile(root);
    await writeFile(file, '{ "model": "qwen", oops }');
    const store = createSettingsStore(file, log);
    expect(await store.get()).toEqual(DEFAULT_SETTINGS);
    expect(await store.update({ appearance: "light" })).toMatchObject({ appearance: "light" });
    expect(await store.get()).toMatchObject({ appearance: "light" });
    expect(await readFile(file, "utf8")).toBe('{ "model": "qwen", oops }');
    expect(logs.some((line) => line.includes("Not saving"))).toBe(true);
  });

  it("falls back per field when a stored value is invalid", async () => {
    const file = settingsFile(root);
    await writeFile(file, JSON.stringify({ desktop: { appearance: "purple", toolCalls: "open" } }));
    const store = createSettingsStore(file, log);
    expect(await store.get()).toEqual({ ...DEFAULT_SETTINGS, toolCalls: "open" });
    expect(logs.join("\n")).toContain("desktop.appearance");
  });

  it("rejects invalid patches without touching the file", async () => {
    const file = settingsFile(root);
    const store = createSettingsStore(file, log);
    await expect(store.update({ appearance: "purple" })).rejects.toThrow(/Invalid settings/);
    await expect(store.update({ unknown: true })).rejects.toThrow(/Invalid settings/);
    await expect(store.update("light")).rejects.toThrow(/Invalid settings/);
    expect(await readJsonObject(file)).toEqual({ kind: "missing" });
  });

  it("serialises concurrent updates", async () => {
    const file = settingsFile(root);
    const store = createSettingsStore(file, log);
    await Promise.all([
      store.update({ appearance: "light" }),
      store.update({ toolCalls: "closed" }),
    ]);
    expect(await readJson(file)).toEqual({
      desktop: { ...DEFAULT_SETTINGS, appearance: "light", toolCalls: "closed" },
    });
  });
});

describe("window state store", () => {
  it("loads defaults, saves under windows.<id> and keeps other keys and windows", async () => {
    const file = stateFile(root);
    await writeFile(file, JSON.stringify({ recentProjects: ["/a"], windows: { other: { x: 1 } } }));
    const store = createWindowStateStore(file, log);
    expect(await store.load("main")).toEqual(DEFAULT_WINDOW_STATE);
    const state = { ...DEFAULT_WINDOW_STATE, sidebarWidth: 300, seenSeq: { s1: 4 } };
    await store.save("main", state);
    expect(await readJson(file)).toEqual({
      recentProjects: ["/a"],
      windows: { other: { x: 1 }, main: state },
    });
    expect(await store.load("main")).toEqual(state);
  });

  it("rejects invalid state and leaves an unparsable file alone", async () => {
    const file = stateFile(root);
    const store = createWindowStateStore(file, log);
    await expect(
      store.save("main", { ...DEFAULT_WINDOW_STATE, sidebarWidth: 5000 }),
    ).rejects.toThrow(/Invalid window state/);
    await writeFile(file, "not json");
    expect(await store.load("main")).toEqual(DEFAULT_WINDOW_STATE);
    await store.save("main", DEFAULT_WINDOW_STATE);
    expect(await readFile(file, "utf8")).toBe("not json");
  });

  it("keeps valid fields when one stored field is invalid", async () => {
    const file = stateFile(root);
    await writeFile(
      file,
      JSON.stringify({ windows: { main: { sidebarOpen: false, dockPane: "nope" } } }),
    );
    const store = createWindowStateStore(file, log);
    expect(await store.load("main")).toEqual({ ...DEFAULT_WINDOW_STATE, sidebarOpen: false });
  });
});
