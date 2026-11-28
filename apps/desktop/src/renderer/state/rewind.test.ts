/**
 * Rewind and `/memory` on a real runtime and the fake engine: the dialog's list, each action's
 * outcome (the fork selected with the prompt back, a summary, restored files), the question about
 * files changed outside dawg, `/rewind` and `/memory` typed in the composer, and the memory folder
 * shown in the Files pane.
 */
import type { CommandInfo } from "@dawg/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeMemoryDirectory } from "../bridge/fake-workspace.ts";
import { createFakeBridge, type FakeBridge } from "./__fixtures__/fake-bridge.ts";
import { FakeEngine } from "./__fixtures__/fake-engine.ts";
import { PROJECT } from "./__fixtures__/streams.ts";
import { takePaneFile } from "./pane-requests.ts";
import { type AppStoreApi, createAppStore } from "./store.ts";

const ID = "s1";

const COMMANDS: CommandInfo[] = [
  { name: "help", description: "Show help", argumentHint: null },
  { name: "rewind", description: "Go back to an earlier point", argumentHint: null },
  { name: "memory", description: "Show the memory folder", argumentHint: null },
];

interface Harness {
  engine: FakeEngine;
  bridge: FakeBridge;
  store: AppStoreApi;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const { store, bridge } of harnesses.splice(0)) {
    store.getState().actions.stop();
    bridge.close();
  }
});

function turn(engine: FakeEngine, turnId: string, text: string): void {
  engine.emit(ID, "session.status", { status: "working", waitingOn: null, message: null });
  engine.emit(ID, "turn.started", {
    turnId,
    prompt: { content: [{ type: "text", text }], mentions: [] },
    command: null,
  });
  engine.emit(ID, "turn.finished", {
    turnId,
    stopReason: "completed",
    finalText: "Done.",
    error: null,
    durationMs: 10,
  });
  engine.emit(ID, "session.status", { status: "idle", waitingOn: null, message: null });
}

async function started(): Promise<Harness> {
  const engine = new FakeEngine();
  engine.addSession(
    ID,
    { title: "Fix the split", projectDir: PROJECT, cwd: PROJECT },
    {
      commands: COMMANDS,
    },
  );
  turn(engine, "turn-2", "Make notes");
  turn(engine, "turn-9", "Edit the notes");
  const bridge = createFakeBridge({ engine, windowState: { selectedSessionId: ID } });
  const store = createAppStore({ bridge });
  const harness = { engine, bridge, store };
  harnesses.push(harness);
  await store.getState().actions.start();
  await vi.waitFor(() => expect(store.getState().sessions[ID]?.loaded).toBe(true));
  return harness;
}

describe("the rewind dialog", () => {
  it("lists the checkpoints newest first", async () => {
    const { store } = await started();
    await store.getState().actions.openRewind(ID);
    const dialog = store.getState().rewind;
    expect(dialog).toMatchObject({ sessionId: ID, phase: "ready", retention: 100, error: null });
    expect(dialog?.checkpoints.map((c) => c.prompt)).toEqual(["Edit the notes", "Make notes"]);
    store.getState().actions.closeRewind();
    expect(store.getState().rewind).toBeNull();
  });

  it("opens from /rewind typed in the composer, which is not sent", async () => {
    const { store, engine } = await started();
    store.getState().actions.setDraft(ID, "/rewind");
    await store.getState().actions.submit(ID, "/rewind");
    expect(store.getState().rewind?.phase).toBe("ready");
    expect(engine.callsOf("session.command")).toEqual([]);
    expect(store.getState().ui.drafts[ID]).toBeUndefined();
  });

  it("waits while a turn runs", async () => {
    const { store, engine } = await started();
    engine.emit(ID, "session.status", { status: "working", waitingOn: null, message: null });
    await vi.waitFor(() => expect(store.getState().sessions[ID]?.status).toBe("working"));
    await store.getState().actions.openRewind(ID);
    expect(store.getState().rewind).toBeNull();
    expect(store.getState().notices.at(-1)?.text).toBe(
      "Rewinding has to wait until the current turn ends.",
    );
  });

  it("goes on in the fork, selected, with the prompt back in its composer", async () => {
    const { store, engine } = await started();
    const { actions } = store.getState();
    await actions.openRewind(ID);
    engine.overrides["session.rewind"] = undefined;
    await actions.rewind("turn-9", "both");
    expect(engine.callsOf("session.rewind")).toEqual([
      { sessionId: ID, checkpointId: "turn-9", action: "both", overwrite: false },
    ]);
    expect(store.getState().rewind).toBeNull();
    const fork = store.getState().layout.selectedSessionId;
    expect(fork).not.toBe(ID);
    expect(store.getState().sessions[fork ?? ""]?.summary.forkedFrom).toEqual({
      sessionId: ID,
      point: { position: "beforeTurn", turnId: "turn-9" },
    });
    // The original stays in the sidebar as it was.
    expect(store.getState().sessions[ID]).toBeDefined();
  });

  it("puts the prompt back after a summary, and reports restored files", async () => {
    const { store, engine } = await started();
    const { actions } = store.getState();
    engine.overrides["session.rewind"] = (params) => ({
      outcome: "done",
      conflicts: [],
      files:
        params.action === "files"
          ? { restored: [`${PROJECT}/notes.txt`], deleted: [`${PROJECT}/new.txt`], skipped: [] }
          : null,
      session: null,
      prompt: params.action === "summarize" ? "Edit the notes" : null,
    });
    await actions.openRewind(ID);
    await actions.rewind("turn-9", "summarize", { instructions: "  the cache  " });
    expect(engine.callsOf("session.rewind").at(-1)).toMatchObject({
      action: "summarize",
      instructions: "the cache",
    });
    expect(store.getState().ui.drafts[ID]).toBe("Edit the notes");

    await actions.openRewind(ID);
    await actions.rewind("turn-2", "files");
    expect(store.getState().notices.at(-1)?.text).toBe(
      "Put back 1 file and removed 1 file made since.",
    );
  });

  it("asks before overwriting files changed outside dawg", async () => {
    const { store, engine } = await started();
    const { actions } = store.getState();
    engine.overrides["session.rewind"] = (params) =>
      params.overwrite
        ? { outcome: "done", conflicts: [], files: null, session: null, prompt: null }
        : {
            outcome: "conflicts",
            conflicts: [`${PROJECT}/notes.txt`],
            files: null,
            session: null,
            prompt: null,
          };
    await actions.openRewind(ID);
    await actions.rewind("turn-2", "files");
    expect(store.getState().rewind).toMatchObject({
      phase: "conflicts",
      conflict: { checkpointId: "turn-2", action: "files", files: [`${PROJECT}/notes.txt`] },
    });
    actions.dismissRewindConflict();
    expect(store.getState().rewind?.phase).toBe("ready");
    await actions.rewind("turn-2", "files");
    await actions.rewind("turn-2", "files", { overwrite: true });
    expect(engine.callsOf("session.rewind").at(-1)).toMatchObject({ overwrite: true });
    expect(store.getState().rewind).toBeNull();
  });

  it("keeps the dialog open with the reason when the rewind fails", async () => {
    const { store, engine } = await started();
    engine.overrides["session.rewind"] = () => {
      throw new Error("A turn is running");
    };
    await store.getState().actions.openRewind(ID);
    await store.getState().actions.rewind("turn-2", "conversation");
    expect(store.getState().rewind).toMatchObject({ phase: "ready", error: "A turn is running." });
  });
});

describe("/memory", () => {
  it("runs the engine's command, then shows the memory folder in the Files pane", async () => {
    const { store, engine, bridge } = await started();
    await store.getState().actions.submit(ID, "/memory");
    expect(engine.callsOf("session.command")).toEqual([
      { sessionId: ID, name: "memory", args: "" },
    ]);
    const items = store.getState().transcripts[ID] ?? [];
    expect(items.at(-1)).toMatchObject({ kind: "command-output", command: "/memory" });
    expect(store.getState().ui.memoryShown[ID]).toBe(true);
    expect(bridge.tracked.at(-1)).toMatchObject({ sessionId: ID, memory: true });
    const folder = fakeMemoryDirectory(PROJECT);
    expect(store.getState().workspaces[ID]?.memoryDirectory).toBe(folder);
    expect(store.getState().layout).toMatchObject({ dockOpen: true, dockPane: "files" });
    expect(takePaneFile(ID)).toBe(`${folder}/MEMORY.md`);
  });
});
