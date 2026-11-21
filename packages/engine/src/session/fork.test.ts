import { readFile, stat } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../contracts/index.ts";
import { runStep, scriptedSteps, type TempStore, tempStore } from "./__fixtures__/script.ts";
import { replay } from "./replay.ts";

let t: TempStore;

beforeEach(async () => {
  t = await tempStore();
});
afterEach(async () => {
  await t.cleanup();
});

async function scriptedSession(): Promise<{ id: string; compactSeqs: number[] }> {
  const writer = await t.store.create({ cwd: t.project, title: "parent" });
  const history: Message[] = [];
  const compactSeqs: number[] = [];
  for (const step of scriptedSteps()) {
    await runStep(writer, history, step);
    if (step.kind === "compact") compactSeqs.push(writer.lastSeq);
  }
  await writer.close();
  return { id: writer.sessionId, compactSeqs };
}

describe("forking", () => {
  it("copies records up to the chosen point, before and after a compaction", async () => {
    const { id, compactSeqs } = await scriptedSession();
    const parent = await t.store.read(t.project, id);
    const firstCompact = compactSeqs[0] as number;
    const points = [
      0,
      1,
      5,
      firstCompact - 1,
      firstCompact,
      firstCompact + 3,
      parent.snapshot.lastSeq,
    ];

    for (const atSeq of points) {
      const forkId = await t.store.fork(t.project, id, { atSeq });
      const fork = await t.store.read(t.project, forkId);
      const expected = replay(parent.records.filter((r) => r.seq <= atSeq));

      expect(fork.snapshot.meta.forkedFrom).toStrictEqual({ sessionId: id, seq: atSeq });
      expect(fork.snapshot.meta.sessionId).toBe(forkId);
      expect(fork.snapshot.view).toStrictEqual(expected.view);
      expect(JSON.stringify(fork.snapshot.view)).toBe(JSON.stringify(expected.view));
      expect(fork.snapshot.state).toStrictEqual(expected.state);
      expect(fork.snapshot.compactions).toBe(expected.compactions);
      // The copied records are byte-identical to the parent's.
      expect(fork.records.slice(1)).toStrictEqual(parent.records.slice(1, atSeq + 1));
    }
  });

  it("defaults to the parent's last record and can set a title", async () => {
    const { id } = await scriptedSession();
    const parent = await t.store.read(t.project, id);
    const forkId = await t.store.fork(t.project, id, { title: "experiment" });
    const fork = await t.store.read(t.project, forkId);
    expect(fork.snapshot.meta.forkedFrom?.seq).toBe(parent.snapshot.lastSeq);
    expect(fork.snapshot.state.title).toBe("experiment");
    expect(fork.snapshot.lastSeq).toBe(parent.snapshot.lastSeq + 1);
    expect(fork.snapshot.view).toStrictEqual(parent.snapshot.view);
  });

  it("does not start out archived because its parent was", async () => {
    const { id } = await scriptedSession();
    await t.store.archive(t.project, id);
    const forkId = await t.store.fork(t.project, id);
    expect((await t.store.read(t.project, forkId)).snapshot.state.archived).toBe(false);
  });

  it("is independent of its parent afterwards", async () => {
    const { id } = await scriptedSession();
    const forkId = await t.store.fork(t.project, id, { atSeq: 10 });
    const parentBefore = await readFile((await t.store.paths(t.project, id)).file, "utf8");
    const forkBefore = await readFile((await t.store.paths(t.project, forkId)).file, "utf8");

    const fork = await t.store.open(t.project, forkId);
    await fork.appendMessage({ role: "assistant", content: "only in the fork", toolCalls: [] });
    await fork.close();
    expect(await readFile((await t.store.paths(t.project, id)).file, "utf8")).toBe(parentBefore);

    const parent = await t.store.open(t.project, id);
    await parent.appendMessage({ role: "assistant", content: "only in the parent", toolCalls: [] });
    await parent.close();
    const forkAfter = await readFile((await t.store.paths(t.project, forkId)).file, "utf8");
    expect(forkAfter.startsWith(forkBefore)).toBe(true);
    expect(forkAfter).not.toContain("only in the parent");

    // Both can be open at once: they are separate sessions with separate locks.
    const a = await t.store.open(t.project, id);
    const b = await t.store.open(t.project, forkId);
    await Promise.all([a.close(), b.close()]);
  });

  it("refuses a point outside the parent", async () => {
    const { id } = await scriptedSession();
    await expect(t.store.fork(t.project, id, { atSeq: 9999 })).rejects.toMatchObject({
      code: "invalid-argument",
    });
    await expect(t.store.fork(t.project, id, { atSeq: -1 })).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });

  it("keeps the parent's tool-result files when the parent is deleted while forks exist", async () => {
    const writer = await t.store.create({ cwd: t.project });
    const saved = await writer.saveOutput("big-output.txt", "lots of output");
    await writer.appendMessage({
      role: "tool",
      toolCallId: "c1",
      toolName: "Bash",
      content: [{ type: "text", text: `Output saved to ${saved}` }],
      isError: false,
    });
    await writer.close();
    const child = await t.store.fork(t.project, writer.sessionId);
    const grandchild = await t.store.fork(t.project, child);

    const result = await t.store.delete(t.project, writer.sessionId);
    expect(result.dependents.sort()).toStrictEqual([child, grandchild].sort());
    expect(result.keptToolResults).toBe(true);
    expect(await readFile(saved, "utf8")).toBe("lots of output");
    await expect(t.store.read(t.project, writer.sessionId)).rejects.toMatchObject({
      code: "not-found",
    });

    // A session nobody forked from loses its folder with it.
    await t.store.delete(t.project, grandchild);
    const lone = await t.store.create({ cwd: t.project });
    await lone.saveOutput("x.txt", "x");
    await lone.close();
    const { dir } = await t.store.paths(t.project, lone.sessionId);
    expect((await t.store.delete(t.project, lone.sessionId)).keptToolResults).toBe(false);
    await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
