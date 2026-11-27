import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "./store.ts";

let root: string;
let project: string;
let history: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "dawg-checkpoints-"));
  project = path.join(root, "project");
  history = path.join(root, "session", "file-history");
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const file = (name: string) => path.join(project, name);
const read = (name: string) => readFile(file(name), "utf8");

function open(retention?: number, sessionId = "s1") {
  return CheckpointStore.open({
    dir: history,
    sessionId,
    ...(retention === undefined ? {} : { retention }),
  });
}

/** What a file tool does: the store is told before and after it writes. */
async function edit(store: CheckpointStore, turnId: string, name: string, content: string) {
  await store.beforeChange(turnId, [file(name)]);
  await writeFile(file(name), content);
  await store.afterChange([file(name)]);
}

describe("saving files", () => {
  it("saves a file's content the first time a checkpoint changes it, not again", async () => {
    await writeFile(file("a.txt"), "one\n");
    const store = await open();
    await store.open("turn-2");
    await edit(store, "turn-2", "a.txt", "two\n");
    await edit(store, "turn-2", "a.txt", "three\n");
    expect(store.filesOf("turn-2")).toEqual({
      tracked: true,
      files: [{ path: file("a.txt"), change: "modified", agents: [] }],
    });
    const plan = await store.plan("turn-2");
    expect(plan).toMatchObject([{ path: file("a.txt"), action: "write", changedOutside: false }]);
    const done = await store.restore("turn-2", { overwrite: false });
    expect(done).toMatchObject({ outcome: "done", restored: [file("a.txt")], deleted: [] });
    expect(await read("a.txt")).toBe("one\n");
  });

  it("records a file that did not exist, so restoring deletes it", async () => {
    const store = await open();
    await store.open("turn-2");
    await edit(store, "turn-2", "new.txt", "made\n");
    expect(store.filesOf("turn-2").files).toEqual([
      { path: file("new.txt"), change: "created", agents: [] },
    ]);
    expect(await store.plan("turn-2")).toMatchObject([{ action: "delete" }]);
    const done = await store.restore("turn-2", { overwrite: false });
    expect(done.deleted).toEqual([file("new.txt")]);
    await expect(stat(file("new.txt"))).rejects.toThrow();
  });

  it("restores each file to how it was at the checkpoint, across later checkpoints", async () => {
    await writeFile(file("a.txt"), "a0\n");
    const store = await open();
    await store.open("turn-2");
    await edit(store, "turn-2", "a.txt", "a1\n");
    await store.open("turn-5");
    await edit(store, "turn-5", "a.txt", "a2\n");
    await edit(store, "turn-5", "b.txt", "b1\n");

    // To the second checkpoint: a.txt as after the first turn, b.txt gone.
    let plan = await store.plan("turn-5");
    expect(plan.map((s) => [path.basename(s.path), s.action])).toEqual([
      ["a.txt", "write"],
      ["b.txt", "delete"],
    ]);
    // To the first: a.txt as it started.
    plan = await store.plan("turn-2");
    expect(plan.map((s) => path.basename(s.path))).toEqual(["a.txt", "b.txt"]);
    await store.restore("turn-2", { overwrite: false });
    expect(await read("a.txt")).toBe("a0\n");
    await expect(stat(file("b.txt"))).rejects.toThrow();
    // Nothing left to do afterwards.
    expect(await store.plan("turn-2")).toEqual([]);
  });

  it("keeps the file mode it saved", async () => {
    await writeFile(file("run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const store = await open();
    await store.open("turn-2");
    await edit(store, "turn-2", "run.sh", "#!/bin/sh\necho hi\n");
    await rm(file("run.sh"));
    await store.restore("turn-2", { overwrite: true });
    expect((await stat(file("run.sh"))).mode & 0o777).toBe(0o755);
  });
});

describe("files changed outside the file tools", () => {
  it("refuses, changing nothing, and restores with overwrite", async () => {
    await writeFile(file("a.txt"), "a0\n");
    await writeFile(file("b.txt"), "b0\n");
    const store = await open();
    await store.open("turn-2");
    await edit(store, "turn-2", "a.txt", "a1\n");
    await edit(store, "turn-2", "b.txt", "b1\n");
    // The person (or a shell command) changes b.txt afterwards.
    await writeFile(file("b.txt"), "b-by-hand\n");

    const plan = await store.plan("turn-2");
    expect(plan.map((s) => [path.basename(s.path), s.changedOutside])).toEqual([
      ["a.txt", false],
      ["b.txt", true],
    ]);
    const refused = await store.restore("turn-2", { overwrite: false });
    expect(refused).toMatchObject({ outcome: "conflicts", conflicts: [file("b.txt")] });
    expect(await read("a.txt")).toBe("a1\n");
    expect(await read("b.txt")).toBe("b-by-hand\n");

    const forced = await store.restore("turn-2", { overwrite: true });
    expect(forced.outcome).toBe("done");
    expect(await read("a.txt")).toBe("a0\n");
    expect(await read("b.txt")).toBe("b0\n");
  });

  it("counts a file deleted outside as changed", async () => {
    const store = await open();
    await store.open("turn-2");
    await writeFile(file("a.txt"), "old\n");
    await edit(store, "turn-2", "a.txt", "new\n");
    await rm(file("a.txt"));
    expect(await store.plan("turn-2")).toMatchObject([{ action: "write", changedOutside: true }]);
  });

  it("does not track a file only a shell command changed", async () => {
    const store = await open();
    await store.open("turn-2");
    await writeFile(file("by-shell.txt"), "x\n");
    expect(store.filesOf("turn-2").files).toEqual([]);
    expect(await store.plan("turn-2")).toEqual([]);
  });
});

describe("retention", () => {
  it("keeps the latest checkpoints and drops contents nothing uses", async () => {
    await writeFile(file("a.txt"), "v0\n");
    const store = await open(2);
    for (const [i, turn] of ["turn-2", "turn-5", "turn-8"].entries()) {
      await store.open(turn);
      await edit(store, turn, "a.txt", `v${i + 1}\n`);
    }
    await store.open("turn-11");
    await store.idle();
    expect(store.entries().map((e) => e.turnId)).toEqual(["turn-8", "turn-11"]);
    expect(store.filesOf("turn-2").tracked).toBe(false);
    // v0, v1 are no longer needed; v2 is turn-8's saved copy.
    const blobs = await readdir(path.join(history, "blobs"));
    expect(blobs).toHaveLength(1);
    await store.restore("turn-8", { overwrite: false });
    expect(await read("a.txt")).toBe("v2\n");
  });
});

describe("on disk", () => {
  it("survives reopening", async () => {
    await writeFile(file("a.txt"), "a0\n");
    const first = await open();
    await first.open("turn-2");
    await edit(first, "turn-2", "a.txt", "a1\n");
    await first.idle();

    const again = await open();
    expect(again.filesOf("turn-2").files).toEqual([
      { path: file("a.txt"), change: "modified", agents: [] },
    ]);
    await again.restore("turn-2", { overwrite: false });
    expect(await read("a.txt")).toBe("a0\n");
  });

  it("skips a torn last line", async () => {
    const store = await open();
    await store.open("turn-2");
    await edit(store, "turn-2", "a.txt", "x\n");
    await store.idle();
    await writeFile(path.join(history, "checkpoints.jsonl"), '{"type":"chec', { flag: "a" });
    const again = await open();
    expect(again.entries()).toHaveLength(1);
  });

  it("copies to a fork, the turns it did not copy hidden but still undone", async () => {
    await writeFile(file("a.txt"), "a0\n");
    const parent = await open();
    await parent.open("turn-2");
    await edit(parent, "turn-2", "a.txt", "a1\n");
    await parent.open("turn-5");
    await edit(parent, "turn-5", "b.txt", "b1\n");
    await parent.idle();

    const forkDir = path.join(root, "fork", "file-history");
    await CheckpointStore.copy(history, forkDir, (turnId) => turnId === "turn-2");
    const fork = await CheckpointStore.open({ dir: forkDir, sessionId: "s2" });
    expect(fork.entries().map((e) => [e.turnId, e.hidden])).toEqual([
      ["turn-2", false],
      ["turn-5", true],
    ]);
    expect(fork.filesOf("turn-5").tracked).toBe(false);
    // The fork's own turn with the same id as a hidden one is a different checkpoint.
    await fork.open("turn-5");
    expect(fork.filesOf("turn-5")).toEqual({ tracked: true, files: [] });
    // Restoring to turn-2 in the fork also removes b.txt, which the parent's hidden turn made.
    await fork.restore("turn-2", { overwrite: false });
    expect(await read("a.txt")).toBe("a0\n");
    await expect(stat(file("b.txt"))).rejects.toThrow();
  });
});

describe("subagents' changes", () => {
  const agent = {
    agentId: "agent-1",
    sessionId: "s1-agent-1",
    agentType: "general-purpose",
    description: "Tidy the notes",
  };

  it("count in the checkpoint of the turn that started the agent, marked with it", async () => {
    await writeFile(file("a.txt"), "a0\n");
    const store = await open();
    await store.open("turn-2");
    await store.beforeChange("turn-2", [file("a.txt")], agent);
    await writeFile(file("a.txt"), "by the agent\n");
    await store.afterChange([file("a.txt")]);
    expect(store.filesOf("turn-2").files).toEqual([
      { path: file("a.txt"), change: "modified", agents: [agent] },
    ]);
    // Its write is the engine's: no conflict.
    expect(await store.plan("turn-2")).toMatchObject([{ changedOutside: false }]);
    await store.idle();
    const again = await open();
    expect(again.filesOf("turn-2").files[0]?.agents).toEqual([agent]);
  });

  it("go by when they happened: a background agent of an earlier turn, after a later turn", async () => {
    await writeFile(file("a.txt"), "a0\n");
    const store = await open();
    await store.open("turn-2");
    // The conversation goes on; the next turn changes a.txt first.
    await store.open("turn-5");
    await edit(store, "turn-5", "a.txt", "a1\n");
    // Then turn-2's background agent changes it.
    await store.beforeChange("turn-2", [file("a.txt")], agent);
    await writeFile(file("a.txt"), "a2\n");
    await store.afterChange([file("a.txt")]);

    // Back to turn-2: as before anything changed it.
    expect(await store.plan("turn-2")).toMatchObject([
      { path: file("a.txt"), changedOutside: false },
    ]);
    await store.restore("turn-2", { overwrite: false });
    expect(await read("a.txt")).toBe("a0\n");
  });

  it("keep that order when the history is written afresh", async () => {
    await writeFile(file("a.txt"), "a0\n");
    const store = await open(3);
    await store.open("turn-1");
    await store.open("turn-2");
    await store.open("turn-5");
    await edit(store, "turn-5", "a.txt", "a1\n");
    await store.beforeChange("turn-2", [file("a.txt")], agent);
    await writeFile(file("a.txt"), "a2\n");
    await store.afterChange([file("a.txt")]);
    // A fourth checkpoint drops turn-1, which writes the history afresh.
    await store.open("turn-9");
    await store.idle();
    expect(store.entries().map((e) => e.turnId)).toEqual(["turn-2", "turn-5", "turn-9"]);
    const again = await open(3);
    expect(again.filesOf("turn-2").files[0]?.agents).toEqual([agent]);
    await again.restore("turn-2", { overwrite: false });
    expect(await read("a.txt")).toBe("a0\n");
  });

  it("go to the latest checkpoint for an agent started outside a turn", async () => {
    const store = await open();
    await store.open("turn-2");
    await store.beforeChange(null, [file("made.txt")], agent);
    await writeFile(file("made.txt"), "x\n");
    await store.afterChange([file("made.txt")]);
    expect(store.filesOf("turn-2").files.map((f) => f.change)).toEqual(["created"]);
  });
});
