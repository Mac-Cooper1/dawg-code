import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../contracts/index.ts";
import { type TempStore, tempStore } from "./__fixtures__/script.ts";
import {
  newSessionId,
  projectKey,
  resolveDawgHome,
  resolveProjectDir,
  sessionPaths,
} from "./paths.ts";
import { SessionStore } from "./store.ts";

let t: TempStore;
let home: string;

beforeEach(async () => {
  t = await tempStore();
  home = t.store.root;
});
afterEach(async () => {
  await t.cleanup();
});

describe("project keys", () => {
  it("replace every character other than ASCII letters and digits with a dash", () => {
    expect(projectKey("/Users/someone/code/my project")).toBe("-Users-someone-code-my-project");
    expect(projectKey("/tmp/a.b_c~d")).toBe("-tmp-a-b-c-d");
    expect(projectKey("/tmp/日本語")).toBe("-tmp----");
    expect(projectKey("/tmp/café")).toBe("-tmp-caf-");
  });

  it("resolve the path lexically first", () => {
    expect(projectKey("/tmp/x/../y/")).toBe(projectKey("/tmp/y"));
  });

  it("stay short enough for a file name, and distinct, for very long paths", () => {
    const base = `/tmp/${"deep/".repeat(80)}`;
    const a = projectKey(`${base}project-a`);
    const b = projectKey(`${base}project-b`);
    expect(a.length).toBeLessThanOrEqual(200);
    expect(b.length).toBeLessThanOrEqual(200);
    expect(a).not.toBe(b);
    expect(a).toMatch(/-[0-9a-f]{16}$/);
  });
});

describe("project folders", () => {
  it("give paths that share a key their own folders, stably", async () => {
    const paths = [
      "/work/my project",
      "/work/my-project",
      "/work/my_project",
      "/work/日本",
      "/work/中国",
    ];
    const dirs = [];
    for (const p of paths) dirs.push(await resolveProjectDir(home, p, { create: true }));
    expect(new Set(dirs).size).toBe(paths.length);
    expect(path.basename(dirs[0] as string)).toBe("-work-my-project");
    for (const [i, p] of paths.entries()) {
      expect(await resolveProjectDir(home, p, { create: true })).toBe(dirs[i]);
      expect(await resolveProjectDir(home, p, { create: false })).toBe(dirs[i]);
      const claim = JSON.parse(
        await readFile(path.join(dirs[i] as string, "project.json"), "utf8"),
      );
      expect(claim.path).toBe(p);
    }
  });

  it("keep sessions of colliding paths apart", async () => {
    const one = await t.store.create({ cwd: "/work/a b" });
    const two = await t.store.create({ cwd: "/work/a-b" });
    await Promise.all([one.close(), two.close()]);
    expect((await t.store.list("/work/a b")).map((s) => s.id)).toStrictEqual([one.sessionId]);
    expect((await t.store.list("/work/a-b")).map((s) => s.id)).toStrictEqual([two.sessionId]);
  });

  it("separate paths that differ only in case, which share a folder on a case-insensitive disk", async () => {
    const upper = await resolveProjectDir(home, "/work/Proj", { create: true });
    const lower = await resolveProjectDir(home, "/work/proj", { create: true });
    expect(upper).not.toBe(lower);
  });

  it("do not create anything when only looking", async () => {
    const dir = await resolveProjectDir(home, "/work/never-used", { create: false });
    expect(path.basename(dir)).toBe("-work-never-used");
    await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adopt an existing folder that has no claim, and replace a damaged claim", async () => {
    const plain = path.join(home, "projects", "-work-old");
    await mkdir(plain, { recursive: true });
    expect(await resolveProjectDir(home, "/work/old", { create: true })).toBe(plain);
    await writeFile(path.join(plain, "project.json"), "{broken");
    expect(await resolveProjectDir(home, "/work/old", { create: true })).toBe(plain);
    expect(JSON.parse(await readFile(path.join(plain, "project.json"), "utf8")).path).toBe(
      "/work/old",
    );
  });

  it("lay out session files as the README says", async () => {
    const w = await t.store.create({ cwd: t.project });
    const saved = await w.saveOutput("out.txt", "x");
    await w.close();
    const projectDir = await t.store.projectDir(t.project);
    expect(path.dirname(projectDir)).toBe(path.join(home, "projects"));
    expect(path.basename(projectDir)).toBe(projectKey(t.project));
    const p = sessionPaths(projectDir, w.sessionId);
    expect(p.file).toBe(path.join(projectDir, "sessions", `${w.sessionId}.jsonl`));
    expect(path.dirname(saved)).toBe(
      path.join(projectDir, "sessions", w.sessionId, "tool-results"),
    );
    const names = await readdir(path.join(projectDir, "sessions"));
    expect(names.sort()).toStrictEqual(
      [`${w.sessionId}`, `${w.sessionId}.jsonl`, "index.json"].sort(),
    );
  });
});

describe("the data root", () => {
  it("is $DAWG_HOME when set, else ~/.dawg", () => {
    expect(resolveDawgHome({ env: { DAWG_HOME: "/data/dawg" } })).toBe("/data/dawg");
    expect(resolveDawgHome({ env: {}, homeDir: "/home/u" })).toBe("/home/u/.dawg");
    expect(resolveDawgHome({ env: { DAWG_HOME: "  " }, homeDir: "/home/u" })).toBe("/home/u/.dawg");
    expect(new SessionStore({ env: { DAWG_HOME: "/data/x" } }).root).toBe("/data/x");
  });
});

describe("session ids", () => {
  it("are unique UUIDv7s that sort in creation order, even within one millisecond", () => {
    const ids = Array.from({ length: 10_000 }, () => newSessionId(1_700_000_000_000));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toStrictEqual(ids);
    for (const id of ids.slice(0, 5)) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    const later = newSessionId(1_700_000_000_500);
    expect(later > (ids.at(-1) as string)).toBe(true);
  });

  it("order the sessions a store creates", async () => {
    const store = new SessionStore({ root: home, durability: "none" });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const w = await store.create({ cwd: t.project });
      const m: Message = { role: "assistant", content: String(i), toolCalls: [] };
      await w.appendMessage(m);
      await w.close();
      ids.push(w.sessionId);
    }
    expect([...ids].sort()).toStrictEqual(ids);
  });
});
