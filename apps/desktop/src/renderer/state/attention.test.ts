/**
 * The attention watcher: notifications on live transitions only, never for what the window
 * catches up on, never for a session the person is looking at; the Dock badge; and clicking a
 * notification. Driven through the real store, connection and reducer against the fake engine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand";
import type { DawgBridge } from "../../shared/bridge.ts";
import { createFakeBridge, type FakeBridge } from "./__fixtures__/fake-bridge.ts";
import { FakeEngine } from "./__fixtures__/fake-engine.ts";
import { HOME, makeSummary, openSession } from "./__fixtures__/streams.ts";
import {
  ATTENTION_BODY,
  type AttentionWatcher,
  countNeedingYou,
  createAttentionWatcher,
} from "./attention.ts";
import { type AppStoreApi, createAppStore, initialAppState } from "./store.ts";
import type { AppActions, AppStore } from "./types.ts";

interface Harness {
  engine: FakeEngine;
  bridge: FakeBridge;
  store: AppStoreApi;
  watcher: AttentionWatcher;
  focus: { window: boolean };
}

const harnesses: Harness[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const { store, bridge, watcher } of harnesses.splice(0)) {
    watcher.dispose();
    store.getState().actions.stop();
    bridge.close();
  }
});

/** The window starts as the app does: the watcher mounts, then the store connects. */
async function setup(engine: FakeEngine, options: { focused?: boolean } = {}): Promise<Harness> {
  const bridge = createFakeBridge({ engine });
  const store = createAppStore({ bridge });
  const focus = { window: options.focused ?? false };
  const watcher = createAttentionWatcher({
    store,
    notifications: bridge.notifications,
    isWindowFocused: () => focus.window,
    badgeDelayMs: 5,
  });
  const harness = { engine, bridge, store, watcher, focus };
  harnesses.push(harness);
  await store.getState().actions.start();
  return harness;
}

function state(harness: Harness) {
  return harness.store.getState();
}

/** Waits until every listed session is open and replayed. */
async function loaded(harness: Harness, ...ids: string[]): Promise<void> {
  await vi.waitFor(() => {
    for (const id of ids) expect(state(harness).sessions[id]?.loaded).toBe(true);
  });
}

function startTurn(engine: FakeEngine, id: string, turnId = "t1"): void {
  engine.emit(id, "session.status", { status: "working", waitingOn: null, message: null });
  engine.emit(id, "turn.started", {
    turnId,
    prompt: { content: [{ type: "text", text: "Fix the rounding in the split" }], mentions: [] },
    command: null,
  });
}

function askPermission(engine: FakeEngine, id: string, requestId = "r1", turnId = "t1"): void {
  engine.emit(id, "permission.requested", {
    turnId,
    request: {
      requestId,
      toolCallId: `call-${requestId}`,
      toolName: "Bash",
      input: { command: "rm -rf build && make" },
      title: "Run a shell command",
      reason: "Ask first",
      suggestions: [],
    },
  });
  engine.emit(id, "session.status", { status: "waiting", waitingOn: "permission", message: null });
}

function answer(engine: FakeEngine, id: string, requestId = "r1", turnId = "t1"): void {
  engine.emit(id, "request.resolved", {
    kind: "permission",
    turnId,
    requestId,
    outcome: "answered",
    response: { behavior: "allow", scope: "once" },
  });
  engine.emit(id, "session.status", { status: "working", waitingOn: null, message: null });
}

function finishTurn(
  engine: FakeEngine,
  id: string,
  stopReason: "completed" | "interrupted" | "error" | "turn_limit",
  turnId = "t1",
): void {
  engine.emit(id, "turn.finished", {
    turnId,
    stopReason,
    finalText: stopReason === "completed" ? "Rounded each share to the cent." : null,
    error:
      stopReason === "error"
        ? {
            kind: "model_unavailable",
            message: "The model stopped responding.",
            detail: null,
            retryable: true,
          }
        : null,
    durationMs: 1000,
  });
  engine.emit(id, "session.status", {
    status: stopReason === "error" ? "error" : "idle",
    waitingOn: null,
    message: null,
  });
}

/** Lets the window take in what the engine sent (several frames). */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

describe("notifications", () => {
  it("says nothing about what the window catches up on at startup", async () => {
    const engine = new FakeEngine();
    engine.addSession("waiting", { title: "Clean the build" });
    startTurn(engine, "waiting");
    askPermission(engine, "waiting");
    engine.addSession("broken", { title: "Add CSV export" });
    startTurn(engine, "broken");
    finishTurn(engine, "broken", "error");
    engine.addSession("done", { title: "Split the bill" });
    startTurn(engine, "done");
    finishTurn(engine, "done", "completed");

    const harness = await setup(engine);
    await loaded(harness, "waiting", "broken");
    await settle();
    expect(harness.bridge.notificationsShown).toEqual([]);
    // The badge still counts what waits.
    await vi.waitFor(() => expect(harness.bridge.badgeCounts.at(-1)).toBe(1));
  });

  it("tells the person a session needs them, in the sidebar's words", async () => {
    const engine = new FakeEngine();
    engine.addSession("s1", { title: "Clean the build" });
    startTurn(engine, "s1");
    const harness = await setup(engine);
    await loaded(harness, "s1");

    askPermission(engine, "s1");
    await vi.waitFor(() =>
      expect(harness.bridge.notificationsShown).toEqual([
        {
          sessionId: "s1",
          reason: "needs-you",
          title: "Clean the build",
          body: "Needs you: run a command",
        },
      ]),
    );
    // Never the command itself, or anything else the model wrote.
    expect(JSON.stringify(harness.bridge.notificationsShown)).not.toContain("rm -rf");

    // Answering and asking again is a new decision.
    answer(engine, "s1");
    askPermission(engine, "s1", "r2");
    await vi.waitFor(() => expect(harness.bridge.notificationsShown).toHaveLength(2));
    expect(harness.bridge.notificationsShown[1]).toMatchObject({ reason: "needs-you" });
  });

  it("says a turn finished, but not one the person stopped", async () => {
    const engine = new FakeEngine();
    engine.addSession("s1", { title: "Split the bill" });
    startTurn(engine, "s1");
    const harness = await setup(engine);
    await loaded(harness, "s1");

    finishTurn(engine, "s1", "interrupted");
    await settle();
    expect(harness.bridge.notificationsShown).toEqual([]);

    startTurn(engine, "s1", "t2");
    finishTurn(engine, "s1", "completed", "t2");
    await vi.waitFor(() =>
      expect(harness.bridge.notificationsShown).toEqual([
        {
          sessionId: "s1",
          reason: "finished",
          title: "Split the bill",
          body: ATTENTION_BODY.finished,
        },
      ]),
    );
    expect(JSON.stringify(harness.bridge.notificationsShown)).not.toContain("Rounded");
  });

  it("says a turn failed once, whether its end or the error status comes first", async () => {
    const engine = new FakeEngine();
    engine.addSession("s1", { title: "Add CSV export" });
    startTurn(engine, "s1");
    const harness = await setup(engine);
    await loaded(harness, "s1");

    finishTurn(engine, "s1", "error");
    await vi.waitFor(() =>
      expect(harness.bridge.notificationsShown).toEqual([
        { sessionId: "s1", reason: "failed", title: "Add CSV export", body: "The turn failed" },
      ]),
    );
    await settle();
    expect(harness.bridge.notificationsShown).toHaveLength(1);
    // The model's error message stays in the app.
    expect(JSON.stringify(harness.bridge.notificationsShown)).not.toContain("stopped responding");
  });

  it("says nothing for a finished turn with a queued message about to go", async () => {
    const engine = new FakeEngine();
    engine.addSession("s1");
    startTurn(engine, "s1");
    const harness = await setup(engine);
    await loaded(harness, "s1");
    await state(harness).actions.submit("s1", "Then run the linter");
    expect(state(harness).ui.queues.s1).toHaveLength(1);

    finishTurn(engine, "s1", "completed");
    await vi.waitFor(() => expect(engine.callsOf("session.prompt")).toHaveLength(1));
    await settle();
    expect(harness.bridge.notificationsShown).toEqual([]);
  });

  it("says nothing about what happened while the engine restarted", async () => {
    const engine = new FakeEngine();
    engine.addSession("s1", { title: "Split the bill" });
    startTurn(engine, "s1");
    const harness = await setup(engine);
    await loaded(harness, "s1");

    engine.dropConnections();
    await vi.waitFor(() => expect(state(harness).connection.phase).toBe("restarting"));
    // The turn ended while the window was cut off, and another session failed.
    finishTurn(engine, "s1", "completed");
    engine.addSession("s2");
    startTurn(engine, "s2");
    finishTurn(engine, "s2", "error");
    harness.bridge.restartEngine();
    await vi.waitFor(() => expect(state(harness).connection.phase).toBe("ready"));
    await loaded(harness, "s1", "s2");
    await vi.waitFor(() =>
      expect(state(harness).sessions.s1?.lastTurn?.stopReason).toBe("completed"),
    );
    await settle();
    expect(harness.bridge.notificationsShown).toEqual([]);

    // What happens after it is live again.
    startTurn(engine, "s1", "t2");
    askPermission(engine, "s1", "r2", "t2");
    await vi.waitFor(() =>
      expect(harness.bridge.notificationsShown.map((shown) => shown.reason)).toEqual(["needs-you"]),
    );
  });

  it("leaves out the session the person is looking at in a focused window", async () => {
    const engine = new FakeEngine();
    engine.addSession("s1", { title: "Shown" });
    startTurn(engine, "s1");
    engine.addSession("s2", { title: "Behind" });
    startTurn(engine, "s2");
    const harness = await setup(engine, { focused: true });
    state(harness).actions.selectSession("s1");
    await loaded(harness, "s1", "s2");

    askPermission(engine, "s1");
    askPermission(engine, "s2");
    // Asked for the other session; main shows it only if no window is focused.
    await vi.waitFor(() =>
      expect(harness.bridge.notificationsShown.map((shown) => shown.sessionId)).toEqual(["s2"]),
    );

    // Not looking once the window loses focus, or once Settings is in front.
    harness.focus.window = false;
    answer(engine, "s1");
    askPermission(engine, "s1", "r2");
    await vi.waitFor(() => expect(harness.bridge.notificationsShown).toHaveLength(2));
    harness.focus.window = true;
    state(harness).actions.setView("settings");
    answer(engine, "s1", "r2");
    finishTurn(engine, "s1", "completed");
    await vi.waitFor(() =>
      expect(harness.bridge.notificationsShown.map((shown) => shown.reason)).toEqual([
        "needs-you",
        "needs-you",
        "finished",
      ]),
    );
  });

  it("gives a session without a title the sidebar's name for it", async () => {
    const engine = new FakeEngine();
    engine.addSession("s1", { title: null });
    startTurn(engine, "s1");
    const harness = await setup(engine);
    await loaded(harness, "s1");
    finishTurn(engine, "s1", "completed");
    await vi.waitFor(() =>
      expect(harness.bridge.notificationsShown[0]).toMatchObject({ title: "New session" }),
    );
  });
});

describe("the Dock badge", () => {
  it("counts the sessions that need the person as they come and go", async () => {
    const engine = new FakeEngine();
    engine.addSession("s1");
    startTurn(engine, "s1");
    engine.addSession("s2");
    startTurn(engine, "s2");
    const harness = await setup(engine);
    await loaded(harness, "s1", "s2");
    await vi.waitFor(() => expect(harness.bridge.badgeCounts).toEqual([0]));

    askPermission(engine, "s1");
    await vi.waitFor(() => expect(harness.bridge.badgeCounts.at(-1)).toBe(1));
    askPermission(engine, "s2");
    await vi.waitFor(() => expect(harness.bridge.badgeCounts.at(-1)).toBe(2));
    answer(engine, "s1");
    await vi.waitFor(() => expect(harness.bridge.badgeCounts.at(-1)).toBe(1));
    // Each count once, in order.
    expect(harness.bridge.badgeCounts).toEqual([0, 1, 2, 1]);
  });
});

describe("clicking a notification", () => {
  it("selects the session, leaving Settings", async () => {
    const engine = new FakeEngine();
    engine.addSession("s1");
    engine.addSession("s2");
    const harness = await setup(engine);
    state(harness).actions.selectSession("s1");
    state(harness).actions.setView("settings");
    harness.bridge.openSessionFromNotification("s2");
    await vi.waitFor(() => expect(state(harness).layout.selectedSessionId).toBe("s2"));
    expect(state(harness).layout.view).toBe("sessions");
    await loaded(harness, "s2");
  });

  it("ignores a session that was deleted meanwhile", async () => {
    const engine = new FakeEngine();
    engine.addSession("s1");
    const harness = await setup(engine);
    state(harness).actions.selectSession("s1");
    harness.bridge.openSessionFromNotification("gone");
    await settle();
    expect(state(harness).layout.selectedSessionId).toBe("s1");
  });
});

// --- Without the engine: a store set by hand, to pin down timing and the live rule ------------

function handStore() {
  const selectSession = vi.fn();
  const store = createStore<AppStore>()(() => ({
    ...initialAppState(HOME),
    resolvedTheme: "dark",
    actions: { selectSession } as unknown as AppActions,
  }));
  return { store, selectSession };
}

function fakeNotifications() {
  const shown: unknown[] = [];
  const badges: number[] = [];
  let open: ((sessionId: string) => void) | null = null;
  const notifications: DawgBridge["notifications"] = {
    show: async (input) => {
      shown.push(input);
      return true;
    },
    setBadge: async (count) => {
      badges.push(count);
    },
    onOpenSession: (listener) => {
      open = listener;
      return () => {
        open = null;
      };
    },
  };
  return { notifications, shown, badges, click: (id: string) => open?.(id) };
}

/** A session waiting on a permission, as a snapshot leaves it. */
function waitingSlice(id: string) {
  return openSession(makeSummary(id, { status: "waiting" }), {
    activeTurnId: "t1",
    pending: [
      {
        kind: "permission",
        turnId: "t1",
        request: {
          requestId: `${id}-r1`,
          toolCallId: "c1",
          toolName: "Edit",
          input: {},
          title: "Edit a file",
          reason: "Ask first",
          suggestions: [],
        },
      },
    ],
  });
}

describe("the watcher on its own", () => {
  it("notifies a change only when live events made it", async () => {
    const { store } = handStore();
    const fake = fakeNotifications();
    const watcher = createAttentionWatcher({
      store,
      notifications: fake.notifications,
      isWindowFocused: () => false,
    });
    const idle = openSession(makeSummary("s1"));
    store.setState({ ...idle });
    // Caught up on (a snapshot): no notification.
    const waiting = waitingSlice("s1");
    store.setState({ sessions: waiting.sessions, pending: waiting.pending });
    await Promise.resolve();
    expect(fake.shown).toEqual([]);
    // Back to idle, then the same change made by a live batch.
    store.setState({ sessions: idle.sessions, pending: idle.pending });
    store.setState({
      sessions: waiting.sessions,
      pending: waiting.pending,
      liveBatches: { s1: 1 },
    });
    await Promise.resolve();
    expect(fake.shown).toEqual([
      { sessionId: "s1", reason: "needs-you", title: "Session s1", body: "Needs you" },
    ]);
    watcher.dispose();
  });

  it("starts from what the store holds when it mounts", async () => {
    const { store } = handStore();
    const fake = fakeNotifications();
    const idle = openSession(makeSummary("s1"));
    store.setState({ ...idle });
    const watcher = createAttentionWatcher({
      store,
      notifications: fake.notifications,
      isWindowFocused: () => false,
    });
    const waiting = waitingSlice("s1");
    store.setState({
      sessions: waiting.sessions,
      pending: waiting.pending,
      liveBatches: { s1: 1 },
    });
    await Promise.resolve();
    expect(fake.shown).toHaveLength(1);
    watcher.dispose();
  });

  it("sends the badge at most once per delay, with the latest count, and only when it changed", () => {
    vi.useFakeTimers();
    const { store } = handStore();
    const fake = fakeNotifications();
    const watcher = createAttentionWatcher({
      store,
      notifications: fake.notifications,
      isWindowFocused: () => false,
      badgeDelayMs: 250,
    });
    vi.advanceTimersByTime(250);
    expect(fake.badges).toEqual([0]);

    const one = waitingSlice("s1");
    const two = waitingSlice("s2");
    store.setState({ sessions: one.sessions, pending: one.pending });
    vi.advanceTimersByTime(100);
    store.setState({
      sessions: { ...one.sessions, ...two.sessions },
      pending: { ...one.pending, ...two.pending },
    });
    vi.advanceTimersByTime(150);
    expect(fake.badges).toEqual([0, 2]);
    // A change that leaves the count alone sends nothing.
    store.setState({ sessions: { ...one.sessions, ...two.sessions } });
    vi.advanceTimersByTime(250);
    expect(fake.badges).toEqual([0, 2]);
    // Archived sessions are not in the sidebar, so not in the count.
    const archived = waitingSlice("s3");
    const s3 = archived.sessions.s3;
    if (!s3) throw new Error("no s3");
    store.setState({
      sessions: {
        ...store.getState().sessions,
        s3: { ...s3, summary: { ...s3.summary, archived: true } },
      },
      pending: { ...store.getState().pending, ...archived.pending },
    });
    vi.advanceTimersByTime(250);
    expect(fake.badges).toEqual([0, 2]);
    expect(countNeedingYou(store.getState())).toBe(2);

    // Nothing waiting is sent after it stops.
    store.setState({ sessions: {}, pending: {} });
    watcher.dispose();
    vi.advanceTimersByTime(250);
    expect(fake.badges).toEqual([0, 2]);
  });

  it("selects a clicked session once the session list arrives", async () => {
    const { store, selectSession } = handStore();
    const fake = fakeNotifications();
    const watcher = createAttentionWatcher({
      store,
      notifications: fake.notifications,
      isWindowFocused: () => false,
    });
    fake.click("s1");
    await Promise.resolve();
    expect(selectSession).not.toHaveBeenCalled();
    store.setState({ ...openSession(makeSummary("s1")) });
    await Promise.resolve();
    expect(selectSession).toHaveBeenCalledWith("s1");
    watcher.dispose();
  });
});
