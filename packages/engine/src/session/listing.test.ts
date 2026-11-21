import { readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TempStore, tempStore } from "./__fixtures__/script.ts";
import { indexPath } from "./listing.ts";
import { SessionStore } from "./store.ts";

let t: TempStore;

beforeEach(async () => {
  t = await tempStore();
});
afterEach(async () => {
  await t.cleanup();
});

async function makeSessions(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const w = await t.store.create({ cwd: t.project, title: `session ${i}` });
    for (let j = 0; j <= i; j++) {
      await w.appendMessage({
        role: "user",
        kind: "prompt",
        content: [{ type: "text", text: `q${j}` }],
      });
      await w.appendMessage({ role: "assistant", content: `a${j}`, toolCalls: [] });
    }
    await w.close();
    ids.push(w.sessionId);
  }
  return ids;
}

/** What the listing should say, worked out by reading every file in full. */
async function fromFiles(ids: string[]) {
  const out = [];
  for (const id of ids) {
    const { snapshot } = await t.store.read(t.project, id);
    out.push({
      id,
      title: snapshot.state.title,
      archived: snapshot.state.archived,
      messageCount: snapshot.messageCount,
      lastActivity: snapshot.lastTime,
      createdAt: snapshot.meta.time,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function core(list: Awaited<ReturnType<SessionStore["list"]>>) {
  return list
    .map(({ id, title, archived, messageCount, lastActivity, createdAt }) => ({
      id,
      title,
      archived,
      messageCount,
      lastActivity,
      createdAt,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

describe("the session listing", () => {
  it("matches the files and is kept in an index", async () => {
    const ids = await makeSessions(3);
    const list = await t.store.list(t.project);
    expect(core(list)).toStrictEqual(await fromFiles(ids));
    expect(list.map((s) => s.id)).toStrictEqual([...ids].reverse());
    expect(
      list.every((s) => s.status === "idle" && s.damaged === null && s.cwd === t.project),
    ).toBe(true);
    const index = JSON.parse(
      await readFile(indexPath(await t.store.projectDir(t.project)), "utf8"),
    );
    expect(index.sessions.map((s: { id: string }) => s.id).sort()).toStrictEqual([...ids].sort());
  });

  it("re-reads only the files that changed", async () => {
    const ids = await makeSessions(2);
    const untouched = (await t.store.paths(t.project, ids[0] as string)).file;
    // A whole-second time, so it can be set back exactly.
    const when = new Date("2026-11-20T12:00:00Z");
    await utimes(untouched, when, when);
    await t.store.list(t.project);
    // Same size and time, different content: if the listing re-read this file, it would see junk.
    const info = await stat(untouched);
    await writeFile(untouched, "x".repeat(info.size));
    await utimes(untouched, when, when);

    const w = await t.store.open(t.project, ids[1] as string);
    await w.appendMessage({
      role: "user",
      kind: "prompt",
      content: [{ type: "text", text: "more" }],
    });
    await w.close();

    const list = await t.store.list(t.project);
    expect(list.find((s) => s.id === ids[0])?.damaged).toBeNull();
    expect(list.find((s) => s.id === ids[0])?.title).toBe("session 0");
    expect(list.find((s) => s.id === ids[1])?.messageCount).toBe(5);
  });

  it("is rebuilt when the index is deleted or damaged", async () => {
    const ids = await makeSessions(3);
    const expected = core(await t.store.list(t.project));
    const file = indexPath(await t.store.projectDir(t.project));

    await unlink(file);
    expect(core(await t.store.list(t.project))).toStrictEqual(expected);
    await writeFile(file, "{ this is not json");
    expect(core(await t.store.list(t.project))).toStrictEqual(expected);
    await writeFile(file, JSON.stringify({ v: 1, sessions: [{ id: "bogus" }] }));
    expect(core(await t.store.list(t.project))).toStrictEqual(expected);
    expect(core(await t.store.list(t.project))).toStrictEqual(await fromFiles(ids));
  });

  it("drops deleted sessions and picks up sessions it has not seen", async () => {
    const ids = await makeSessions(3);
    await t.store.list(t.project);
    await unlink((await t.store.paths(t.project, ids[1] as string)).file);
    // Written by another store object, as another process would, then listed here.
    const other = new SessionStore({ root: t.store.root, durability: "none" });
    const w = await other.create({ cwd: t.project, title: "from elsewhere" });
    await w.close();
    const list = await t.store.list(t.project);
    expect(list.map((s) => s.id).sort()).toStrictEqual([ids[0], ids[2], w.sessionId].sort());
  });

  it("is empty for a project with no sessions, without creating anything", async () => {
    expect(await t.store.list(`${t.project}-other`)).toStrictEqual([]);
    await expect(stat(t.store.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reflects rename and archive, which are state records", async () => {
    const [a, b] = await makeSessions(2);
    await t.store.rename(t.project, a as string, "renamed");
    await t.store.archive(t.project, b as string);
    const visible = await t.store.list(t.project);
    expect(visible.map((s) => [s.id, s.title])).toStrictEqual([[a, "renamed"]]);
    const all = await t.store.list(t.project, { includeArchived: true });
    expect(all.find((s) => s.id === b)?.archived).toBe(true);

    const { records } = await t.store.read(t.project, a as string);
    expect(records.at(-1)).toMatchObject({ type: "state", changes: { title: "renamed" } });

    await t.store.archive(t.project, b as string, false);
    expect((await t.store.list(t.project)).map((s) => s.id).sort()).toStrictEqual([a, b].sort());
  });

  it("renames through the writer when the session is open in this process", async () => {
    const w = await t.store.create({ cwd: t.project });
    await t.store.rename(t.project, w.sessionId, "live title");
    expect(w.snapshot.state.title).toBe("live title");
    expect((await t.store.list(t.project))[0]?.title).toBe("live title");
    await w.close();
  });

  it("shows the status a live writer reports, and idle once nobody holds the session", async () => {
    const w = await t.store.create({ cwd: t.project });
    await w.setStatus("working");
    expect((await t.store.list(t.project))[0]?.status).toBe("working");
    await w.setStatus("waiting");
    expect((await t.store.list(t.project))[0]?.status).toBe("waiting");
    // A crash leaves "working" in the index but no live lock.
    await w.setStatus("working");
    await rm((await t.store.paths(t.project, w.sessionId)).lock);
    expect((await t.store.list(t.project))[0]?.status).toBe("idle");
    await w.close();
    expect((await t.store.list(t.project))[0]?.status).toBe("idle");
  });
});
