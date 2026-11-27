/**
 * A person's own words survive a quit: each session's draft and its queued and held messages are
 * saved with the window state, and come back on the next launch, every message held. Images are
 * not saved; the message says so instead. See window-state.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SavedComposer, WindowStateSchema } from "../../shared/bridge.ts";
import { createFakeBridge, type FakeBridge } from "./__fixtures__/fake-bridge.ts";
import { FakeEngine } from "./__fixtures__/fake-engine.ts";
import { selectComposer } from "./selectors.ts";
import { type AppStoreApi, createAppStore, initialAppState } from "./store.ts";
import type { ImageAttachment, UiState } from "./types.ts";
import {
  applyWindowState,
  composersOf,
  forgetComposersExcept,
  windowStateOf,
} from "./window-state.ts";

interface Harness {
  engine: FakeEngine;
  bridge: FakeBridge;
  store: AppStoreApi;
}

const harnesses: Harness[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const { store, bridge } of harnesses.splice(0)) {
    store.getState().actions.stop();
    bridge.close();
  }
});

async function launch(
  engine: FakeEngine,
  composers: Record<string, Partial<SavedComposer>> = {},
): Promise<Harness> {
  const windowState = WindowStateSchema.parse({ selectedSessionId: "s1", composers });
  const bridge = createFakeBridge({ engine, windowState });
  const store = createAppStore({ bridge });
  const harness = { engine, bridge, store };
  harnesses.push(harness);
  await store.getState().actions.start();
  return harness;
}

/** A session whose turn is running. */
function running(engine: FakeEngine, id: string, turnId = "t1"): void {
  engine.addSession(id);
  engine.emit(id, "session.status", { status: "working", waitingOn: null, message: null });
  engine.emit(id, "turn.started", {
    turnId,
    prompt: { content: [{ type: "text", text: "Work" }], mentions: [] },
    command: null,
  });
}

function finish(engine: FakeEngine, id: string, turnId: string): void {
  engine.emit(id, "turn.finished", {
    turnId,
    stopReason: "completed",
    finalText: null,
    error: null,
    durationMs: 1000,
  });
  engine.emit(id, "session.status", { status: "idle", waitingOn: null, message: null });
}

const IMAGE: ImageAttachment = {
  id: "img-1",
  name: "Pasted image",
  mediaType: "image/png",
  data: "iVBORw0KGgo=",
  width: 1,
  height: 1,
};

describe("the window state's composers", () => {
  it("loads window state saved before composers were kept", () => {
    const old = WindowStateSchema.parse({ sidebarOpen: false, seenSeq: { s1: 3 } });
    expect(old.composers).toEqual({});
    expect(old.sidebarOpen).toBe(false);
  });

  it("keeps words and mentions, counts images instead of saving them, and skips image-only messages", () => {
    const ui: Pick<
      UiState,
      "drafts" | "mentionPaths" | "attachments" | "queues" | "draftImagesNotKept"
    > = {
      drafts: { s1: "half typed @src/a.ts" },
      mentionPaths: { s1: ["src/a.ts"] },
      attachments: { s1: [IMAGE] },
      draftImagesNotKept: { s1: 1 },
      queues: {
        s1: [
          { id: "q1", text: "then this", state: "queued", mentions: [{ path: "src/b.ts" }] },
          { id: "q2", text: "", state: "held", images: [IMAGE] },
          { id: "q3", text: "and this", state: "held", images: [IMAGE], imagesNotKept: 2 },
        ],
        s2: [],
      },
    };
    expect(composersOf(ui)).toEqual({
      s1: {
        draft: "half typed @src/a.ts",
        mentionPaths: ["src/a.ts"],
        imagesNotKept: 2,
        queue: [
          { text: "then this", mentions: [{ path: "src/b.ts" }], imagesNotKept: 0 },
          { text: "and this", mentions: [], imagesNotKept: 3 },
        ],
      },
    });
    const saved = WindowStateSchema.parse(
      JSON.parse(JSON.stringify({ composers: composersOf(ui) })),
    );
    expect(JSON.stringify(saved)).not.toContain(IMAGE.data);
  });

  it("brings drafts back as they were and every message held, without overwriting the window's own", () => {
    const state = initialAppState("/Users/you");
    const saved = WindowStateSchema.parse({
      composers: {
        s1: {
          draft: "half typed",
          mentionPaths: ["src/a.ts"],
          imagesNotKept: 1,
          queue: [{ text: "then this", mentions: [{ path: "src/a.ts" }], imagesNotKept: 2 }],
        },
        s2: { queue: [{ text: "queued" }] },
      },
    });
    const withOwn = { ...state, ui: { ...state.ui, drafts: { s2: "typed already" } } };
    const { ui } = applyWindowState(withOwn, saved);
    expect(ui.drafts).toEqual({ s1: "half typed", s2: "typed already" });
    expect(ui.mentionPaths).toEqual({ s1: ["src/a.ts"] });
    expect(ui.draftImagesNotKept).toEqual({ s1: 1 });
    expect(ui.queues.s1).toEqual([
      {
        id: "restored-s1-0",
        text: "then this",
        state: "held",
        restored: true,
        mentions: [{ path: "src/a.ts" }],
        imagesNotKept: 2,
      },
    ]);
    expect(ui.queues.s2?.map((message) => message.state)).toEqual(["held"]);
    // Saving again keeps the images it had counted.
    expect(windowStateOf({ layout: state.layout, ui }).composers.s1?.queue[0]?.imagesNotKept).toBe(
      2,
    );
  });

  it("forgets the words of sessions that are gone", () => {
    const { ui } = initialAppState("/Users/you");
    const before: UiState = {
      ...ui,
      drafts: { s1: "a", gone: "b" },
      queues: { gone: [{ id: "q", text: "c", state: "held" }] },
      draftImagesNotKept: { gone: 1 },
    };
    const after = forgetComposersExcept(before, new Set(["s1"]));
    expect(after.drafts).toEqual({ s1: "a" });
    expect(after.queues).toEqual({});
    expect(after.draftImagesNotKept).toEqual({});
    expect(forgetComposersExcept(after, new Set(["s1"]))).toBe(after);
  });
});

describe("in the store", () => {
  it("saves the draft and queued messages as they change, debounced, without images", async () => {
    const engine = new FakeEngine();
    running(engine, "s1");
    const harness = await launch(engine);
    const { actions } = harness.store.getState();
    vi.useFakeTimers();
    actions.setDraft("s1", "draft words");
    actions.addAttachments("s1", [IMAGE]);
    vi.advanceTimersByTime(500);
    expect(harness.bridge.saved.at(-1)?.composers).toEqual({
      s1: { draft: "draft words", mentionPaths: [], imagesNotKept: 1, queue: [] },
    });

    // Sent while dawg works: queued, with the image, and the draft as it was.
    await actions.submit("s1", "queued words");
    vi.advanceTimersByTime(500);
    expect(harness.store.getState().ui.queues.s1?.map((m) => m.state)).toEqual(["queued"]);
    expect(harness.bridge.saved.at(-1)?.composers).toEqual({
      s1: {
        draft: "draft words",
        mentionPaths: [],
        imagesNotKept: 0,
        queue: [{ text: "queued words", mentions: [], imagesNotKept: 1 }],
      },
    });

    // Emptying the draft drops it from the saved state.
    actions.setDraft("s1", "");
    vi.advanceTimersByTime(500);
    expect(harness.bridge.saved.at(-1)?.composers.s1?.draft).toBe("");
  });

  it("saves at least every two seconds while the state keeps changing, as it does while a reply streams", async () => {
    const engine = new FakeEngine();
    running(engine, "s1");
    const harness = await launch(engine);
    const { actions } = harness.store.getState();
    vi.useFakeTimers();
    const before = harness.bridge.saved.length;
    actions.setDraft("s1", "typed while dawg works");
    // A change every 100 ms: a plain debounce would never save.
    for (let i = 0; i < 20; i++) {
      actions.setSidebarWidth(260 + (i % 2));
      vi.advanceTimersByTime(100);
    }
    expect(harness.bridge.saved.length).toBe(before + 1);
    expect(harness.bridge.saved.at(-1)?.composers.s1?.draft).toBe("typed while dawg works");
  });

  it("restores drafts and holds every queued message, sending none until asked", async () => {
    const engine = new FakeEngine();
    running(engine, "s1");
    const harness = await launch(engine, {
      s1: {
        draft: "half typed",
        imagesNotKept: 1,
        queue: [
          { text: "then this", mentions: [{ path: "src/a.ts" }], imagesNotKept: 2 },
          { text: "and this", mentions: [], imagesNotKept: 0 },
        ],
      },
      gone: { draft: "for a deleted session" },
    });
    const state = harness.store.getState();
    expect(state.ui.drafts).toEqual({ s1: "half typed" });
    const view = selectComposer(state, "s1");
    expect(view?.draft).toBe("half typed");
    expect(view?.draftImagesNotKept).toBe(1);
    expect(view?.queue.map((m) => [m.text, m.state, m.restored, m.imagesNotKept])).toEqual([
      ["then this", "held", true, 2],
      ["and this", "held", true, undefined],
    ]);

    // The running turn ends: a held message stays where it is.
    finish(engine, "s1", "t1");
    await vi.waitFor(() => expect(harness.store.getState().sessions.s1?.activeTurnId).toBeNull());
    expect(engine.callsOf("session.prompt")).toEqual([]);

    // Send now sends it, with its mentions.
    const first = harness.store.getState().ui.queues.s1?.[0];
    await harness.store.getState().actions.sendQueuedNow("s1", first?.id ?? "");
    expect(engine.callsOf("session.prompt")).toEqual([
      expect.objectContaining({
        prompt: {
          content: [{ type: "text", text: "then this" }],
          mentions: [{ path: "src/a.ts" }],
        },
      }),
    ]);
    expect(harness.store.getState().ui.queues.s1?.map((m) => m.text)).toEqual(["and this"]);
  });

  it("clears the line about images once the restored draft is sent", async () => {
    const engine = new FakeEngine();
    engine.addSession("s1");
    const harness = await launch(engine, { s1: { draft: "send me", imagesNotKept: 1 } });
    await harness.store.getState().actions.submit("s1", "send me");
    const state = harness.store.getState();
    expect(state.ui.drafts.s1).toBeUndefined();
    expect(selectComposer(state, "s1")?.draftImagesNotKept).toBe(0);
  });
});
