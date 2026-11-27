/**
 * Checkpoints and rewind on a whole engine: files saved as the file tools change them, listed
 * per prompt, restored, the conversation forked, summarised from a point, and all of it after a
 * restart. Also through the protocol host (`session.checkpoints`, `session.rewind`).
 */
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { text, toolCall } from "@dawg/mock-model";
import {
  type Client,
  createClient,
  createMemoryTransportPair,
  type SessionSnapshot,
} from "@dawg/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createEngineHost } from "../host/host.ts";
import { type Harness, startHarness, textOf } from "./__fixtures__/harness.ts";
import { rewindSession } from "./rewind.ts";
import type { SessionRuntime } from "./session.ts";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const prompt = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** Three turns: make notes.txt, edit it and change app.txt, then a turn that only answers. */
const THREE_TURNS = [
  toolCall("Write", { file_path: "notes.txt", content: "first\n" }),
  text("Made it."),
  toolCall("Read", { file_path: "app.txt" }),
  toolCall("Edit", { file_path: "notes.txt", old_string: "first", new_string: "second" }),
  toolCall("Write", { file_path: "app.txt", content: "app v2\n" }),
  text("Changed both."),
  text("Nothing to change."),
];

async function threeTurns(): Promise<{ h: Harness; session: SessionRuntime }> {
  const harness = await startHarness({ files: { "app.txt": "app v1\n" }, script: THREE_TURNS });
  h = harness;
  const session = await harness.engine.createSession({ cwd: harness.project, mode: "acceptEdits" });
  await session.run(prompt("Make notes"));
  await session.run(prompt("Edit notes and the app"));
  await session.run(prompt("Anything else?"));
  return { h: harness, session };
}

const read = (harness: Harness, name: string) => readFile(path.join(harness.project, name), "utf8");
const gone = async (harness: Harness, name: string) =>
  stat(path.join(harness.project, name)).then(
    () => false,
    () => true,
  );

describe("checkpoints", () => {
  it("opens one per prompt and saves each file the first time a turn changes it", async () => {
    const { h, session } = await threeTurns();
    const { checkpoints, retention } = await session.checkpoints();
    expect(retention).toBe(100);
    expect(checkpoints.map((c) => c.prompt)).toEqual([
      "Make notes",
      "Edit notes and the app",
      "Anything else?",
    ]);
    const [first, second, third] = checkpoints;
    const notes = path.join(h.project, "notes.txt");
    const app = path.join(h.project, "app.txt");
    expect(first?.files).toEqual([{ path: notes, change: "created", agents: [] }]);
    expect(second?.files).toEqual([
      { path: notes, change: "modified", agents: [] },
      { path: app, change: "modified", agents: [] },
    ]);
    expect(third?.files).toEqual([]);
    // Restoring to the first puts both files back: notes.txt goes, app.txt returns to v1.
    expect(first?.restore).toEqual([
      { path: notes, action: "delete", changedOutside: false },
      { path: app, action: "write", changedOutside: false },
    ]);
    expect(third?.restore).toEqual([]);
    expect(checkpoints.every((c) => c.tracked && c.time > 0)).toBe(true);
    expect(h.problems).toEqual([]);
  });

  it("restores files and tells the model at the next turn, the conversation going on", async () => {
    const { h, session } = await threeTurns();
    const { checkpoints } = await session.checkpoints();
    const second = checkpoints[1]?.id as string;
    const outcome = await session.restoreFiles(second, false);
    expect(outcome).toMatchObject({ outcome: "done", deleted: [] });
    expect(outcome.restored.map((p) => path.basename(p)).sort()).toEqual(["app.txt", "notes.txt"]);
    expect(await read(h, "notes.txt")).toBe("first\n");
    expect(await read(h, "app.txt")).toBe("app v1\n");

    h.mock.addReplies(text("Noted."));
    await session.run(prompt("Carry on"));
    const sent = h.mock.messages(-1).map((m) => JSON.stringify(m));
    expect(sent.some((m) => m.includes("put files back as they were before"))).toBe(true);
    // The rewind of files is itself undone by a later restore: nothing more to do at the second.
    expect((await session.checkpoints()).checkpoints[1]?.restore).toEqual([]);
  });

  it("refuses when a file changed outside the file tools, unless told to overwrite", async () => {
    const { h, session } = await threeTurns();
    await writeFile(path.join(h.project, "app.txt"), "edited by hand\n");
    const { checkpoints } = await session.checkpoints();
    const first = checkpoints[0];
    expect(first?.restore.find((s) => s.path.endsWith("app.txt"))?.changedOutside).toBe(true);

    const refused = await session.restoreFiles(first?.id as string, false);
    expect(refused.outcome).toBe("conflicts");
    expect(refused.conflicts).toEqual([path.join(h.project, "app.txt")]);
    expect(await read(h, "notes.txt")).toBe("second\n");

    const forced = await session.restoreFiles(first?.id as string, true);
    expect(forced.outcome).toBe("done");
    expect(await gone(h, "notes.txt")).toBe(true);
    expect(await read(h, "app.txt")).toBe("app v1\n");
  });

  it("does not track a file only a shell command changed", async () => {
    h = await startHarness({
      files: { ".dawg/settings.json": JSON.stringify({ permissions: { allow: ["Bash"] } }) },
      script: [
        toolCall("Bash", { command: "echo hi > shell.txt", description: "Write a file" }),
        text("Done."),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "acceptEdits" });
    await session.run(prompt("Use the shell"));
    const { checkpoints } = await session.checkpoints();
    expect(checkpoints[0]?.files).toEqual([]);
    expect(checkpoints[0]?.restore).toEqual([]);
    expect(await read(h, "shell.txt")).toBe("hi\n");
  });

  it("survives quitting and resuming", async () => {
    const { h, session } = await threeTurns();
    const id = session.id;
    await h.engine.close();
    const again = h.newEngine();
    const resumed = await again.resumeSession(id);
    const { checkpoints } = await resumed.checkpoints();
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints[1]?.files.map((f) => path.basename(f.path))).toEqual([
      "notes.txt",
      "app.txt",
    ]);
    await resumed.restoreFiles(checkpoints[0]?.id as string, false);
    expect(await gone(h, "notes.txt")).toBe(true);
    expect(await read(h, "app.txt")).toBe("app v1\n");
  });

  it("keeps the latest checkpoints only, past the retention limit", async () => {
    h = await startHarness({
      files: { "app.txt": "v0\n" },
      engine: { checkpointRetention: 2 },
      script: [
        toolCall("Read", { file_path: "app.txt" }),
        toolCall("Write", { file_path: "app.txt", content: "v1\n" }),
        text("1"),
        toolCall("Write", { file_path: "app.txt", content: "v2\n" }),
        text("2"),
        toolCall("Write", { file_path: "app.txt", content: "v3\n" }),
        text("3"),
      ],
    });
    const session = await h.engine.createSession({ cwd: h.project, mode: "acceptEdits" });
    for (const t of ["one", "two", "three"]) await session.run(prompt(t));
    const { checkpoints, retention } = await session.checkpoints();
    expect(retention).toBe(2);
    expect(checkpoints.map((c) => [c.prompt, c.tracked])).toEqual([
      ["one", false],
      ["two", true],
      ["three", true],
    ]);
    // The oldest is still a point for the conversation, but its files are gone.
    expect(checkpoints[0]?.restore).toEqual([]);
    await session.restoreFiles(checkpoints[1]?.id as string, false);
    expect(await read(h, "app.txt")).toBe("v1\n");
  });
});

describe("rewinding the conversation", () => {
  it("forks before the prompt, with the files back, and keeps the original as it was", async () => {
    const { h, session } = await threeTurns();
    const before = session.view.length;
    const { checkpoints } = await session.checkpoints();
    const second = checkpoints[1];
    const outcome = await rewindSession(h.engine, session, {
      checkpointId: second?.id as string,
      action: "both",
      overwrite: false,
      instructions: null,
    });
    expect(outcome.outcome).toBe("done");
    expect(outcome.prompt).toBe("Edit notes and the app");
    expect(outcome.files?.restored.map((p) => path.basename(p)).sort()).toEqual([
      "app.txt",
      "notes.txt",
    ]);
    expect(await read(h, "notes.txt")).toBe("first\n");

    const fork = outcome.session as SessionRuntime;
    expect(fork.id).not.toBe(session.id);
    expect(fork.summary().forkedFrom).toEqual({
      sessionId: session.id,
      point: { position: "beforeTurn", turnId: second?.turnId },
    });
    // The fork's conversation ends just before the prompt; the original keeps everything.
    const forkPrompts = fork.view.filter((m) => m.role === "user" && m.kind === "prompt");
    expect(forkPrompts.map(textOf)).toEqual(["Make notes"]);
    expect(session.view.length).toBe(before);
    // The fork lists its one checkpoint, and restoring to it still undoes the hidden later turn.
    const forked = await fork.checkpoints();
    expect(forked.checkpoints.map((c) => c.prompt)).toEqual(["Make notes"]);
    expect(forked.checkpoints[0]?.restore.map((s) => s.action)).toEqual(["delete"]);
  });

  it("forks without touching files for `conversation`", async () => {
    const { h, session } = await threeTurns();
    const { checkpoints } = await session.checkpoints();
    const outcome = await rewindSession(h.engine, session, {
      checkpointId: checkpoints[0]?.id as string,
      action: "conversation",
      overwrite: false,
      instructions: null,
    });
    expect(outcome.files).toBeNull();
    expect(await read(h, "notes.txt")).toBe("second\n");
    expect(outcome.session?.view.filter((m) => m.role === "user" && m.kind === "prompt")).toEqual(
      [],
    );
  });

  it("stops before forking when files changed outside", async () => {
    const { h, session } = await threeTurns();
    await writeFile(path.join(h.project, "notes.txt"), "by hand\n");
    const { checkpoints } = await session.checkpoints();
    const outcome = await rewindSession(h.engine, session, {
      checkpointId: checkpoints[1]?.id as string,
      action: "both",
      overwrite: false,
      instructions: null,
    });
    expect(outcome).toMatchObject({ outcome: "conflicts", session: null, prompt: null });
    expect(h.engine.openSessions()).toHaveLength(1);
  });

  it("refuses an unknown checkpoint", async () => {
    const { h, session } = await threeTurns();
    await expect(
      rewindSession(h.engine, session, {
        checkpointId: "turn-999",
        action: "files",
        overwrite: false,
        instructions: null,
      }),
    ).rejects.toMatchObject({ code: "InvalidParams" });
  });
});

describe("summarising from a point", () => {
  it("replaces the turns from the prompt on with a summary, keeping what is before", async () => {
    const { h, session } = await threeTurns();
    const { checkpoints } = await session.checkpoints();
    const second = checkpoints[1];
    const viewBefore = [...session.view];
    const firstPromptAt = viewBefore.findIndex((m) => m.role === "user" && m.kind === "prompt");
    const secondPromptAt = viewBefore.findIndex(
      (m, i) => i > firstPromptAt && m.role === "user" && m.kind === "prompt",
    );
    const outcome = await rewindSession(h.engine, session, {
      checkpointId: second?.id as string,
      action: "summarize",
      overwrite: false,
      instructions: "the app change",
    });
    expect(outcome.prompt).toBe("Edit notes and the app");
    expect(session.busy).toBe(true);
    await session.waitForIdle();

    const view = session.view;
    expect(view.slice(0, secondPromptAt)).toEqual(viewBefore.slice(0, secondPromptAt));
    expect(view).toHaveLength(secondPromptAt + 1);
    expect(textOf(view.at(-1) as never)).toContain("replaces the messages from that point on");
    const started = h.ofType(session.id, "compaction.started").at(-1);
    expect(started?.payload).toMatchObject({ trigger: "manual", focus: "the app change" });
    const finished = h.ofType(session.id, "compaction.finished").at(-1);
    expect(finished?.payload).toMatchObject({ outcome: "completed" });
    // Files are left as they are.
    expect(await read(h, "notes.txt")).toBe("second\n");
  });
});

describe("through the protocol", () => {
  it("lists checkpoints and rewinds, the fork open on the connection", async () => {
    const { h, session } = await threeTurns();
    const [clientEnd, engineEnd] = createMemoryTransportPair();
    const host = createEngineHost(h.engine, engineEnd, { homeDir: h.home, detachGraceMs: 0 });
    const client: Client = createClient(clientEnd);
    await client.initialize({ client: { name: "test", version: "0" }, capabilities: {} });
    await client.request("session.resume", { sessionId: session.id });

    const listed = await client.request("session.checkpoints", { sessionId: session.id });
    expect(listed.checkpoints).toHaveLength(3);
    const result = await client.request("session.rewind", {
      sessionId: session.id,
      checkpointId: listed.checkpoints[1]?.id as string,
      action: "both",
    });
    expect(result.outcome).toBe("done");
    const fork = result.session as SessionSnapshot;
    expect(fork.session.forkedFrom?.sessionId).toBe(session.id);
    expect(host.openSessions()).toContain(fork.session.id);
    // The fork answers like any open session.
    const again = await client.request("session.checkpoints", { sessionId: fork.session.id });
    expect(again.checkpoints.map((c) => c.prompt)).toEqual(["Make notes"]);
    await expect(
      client.request("session.rewind", {
        sessionId: session.id,
        checkpointId: "nope",
        action: "files",
      }),
    ).rejects.toMatchObject({ code: -32602 });
    client.close();
    await host.done;
  });
});
