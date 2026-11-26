/**
 * Settings → General: the notification and Dock badge switches, and where new sessions run
 * ("ask", "folder", "worktree"), with the option that opens the new-session dialog anyway.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettings } from "../../shared/bridge.ts";
import {
  createFakeBridge,
  type FakeBridge,
  type FakeBridgeOptions,
} from "./__fixtures__/fake-bridge.ts";
import { FakeEngine } from "./__fixtures__/fake-engine.ts";
import { PROJECT } from "./__fixtures__/streams.ts";
import { type AppStoreApi, createAppStore } from "./store.ts";

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

const REPO = { [PROJECT]: { current: "main", branches: ["feature/csv", "main"] } };

async function setup(
  newSessionWorktree: DesktopSettings["newSessionWorktree"],
  options: Omit<FakeBridgeOptions, "engine" | "settings"> = {},
): Promise<Harness> {
  const engine = new FakeEngine();
  const bridge = createFakeBridge({ engine, settings: { newSessionWorktree }, ...options });
  const store = createAppStore({ bridge });
  const harness = { engine, bridge, store };
  harnesses.push(harness);
  await store.getState().actions.start();
  return harness;
}

function actions(harness: Harness) {
  return harness.store.getState().actions;
}

function state(harness: Harness) {
  return harness.store.getState();
}

describe("settings actions", () => {
  it("saves the notification, badge and new-session choices", async () => {
    const harness = await setup("ask");
    await actions(harness).setNotifications(false);
    await actions(harness).setDockBadge(false);
    await actions(harness).setNewSessionWorktree("worktree");
    expect(harness.bridge.settingsUpdates).toEqual([
      { notifications: false },
      { dockBadge: false },
      { newSessionWorktree: "worktree" },
    ]);
    expect(state(harness).settings).toMatchObject({
      notifications: false,
      dockBadge: false,
      newSessionWorktree: "worktree",
    });
  });
});

describe("where new sessions run", () => {
  it("asks each time by default", async () => {
    const harness = await setup("ask", { repos: REPO });
    const pending = actions(harness).newSession({ projectDir: PROJECT });
    await vi.waitFor(() => expect(state(harness).newSessionOffer).not.toBeNull());
    expect(state(harness).newSessionOffer).toMatchObject({ worktree: false, error: null });
    await actions(harness).answerNewSessionOffer(null);
    expect(await pending).toBeNull();
  });

  it("starts in the project folder without asking", async () => {
    const harness = await setup("folder", { repos: REPO });
    const id = await actions(harness).newSession({ projectDir: PROJECT });
    expect(id).not.toBeNull();
    expect(state(harness).newSessionOffer).toBeNull();
    expect(harness.bridge.worktreesCreated).toEqual([]);
    expect(harness.engine.callsOf("session.create")).toEqual([
      expect.objectContaining({ cwd: PROJECT }),
    ]);
    expect(state(harness).layout.selectedSessionId).toBe(id);
  });

  it("starts in a new worktree from the current branch, named as the dialog would", async () => {
    const harness = await setup("worktree", { repos: REPO });
    const id = await actions(harness).newSession({ projectDir: PROJECT });
    expect(id).not.toBeNull();
    expect(state(harness).newSessionOffer).toBeNull();
    expect(harness.bridge.worktreesCreated).toEqual([
      { projectDir: PROJECT, name: expect.stringMatching(/^[a-z]+-[a-z]+$/), base: "main" },
    ]);
    const name = harness.bridge.worktreesCreated[0]?.name;
    expect(harness.engine.callsOf("session.create")).toEqual([
      expect.objectContaining({ cwd: `${PROJECT}/.dawg/worktrees/${name}`, projectDir: PROJECT }),
    ]);
  });

  it("opens the dialog saying why when the worktree cannot be made, and starts from there", async () => {
    const harness = await setup("worktree", { repos: REPO });
    harness.bridge.failNextWorktree("A branch named dawg/quiet-otter already exists.");
    const pending = actions(harness).newSession({ projectDir: PROJECT });
    await vi.waitFor(() => expect(state(harness).newSessionOffer).not.toBeNull());
    const tried = harness.bridge.worktreesCreated[0]?.name;
    expect(state(harness).newSessionOffer).toMatchObject({
      worktree: true,
      suggestedName: tried,
      busy: false,
      error: "A branch named dawg/quiet-otter already exists.",
    });
    expect(harness.engine.callsOf("session.create")).toEqual([]);

    await actions(harness).answerNewSessionOffer({
      worktree: { name: "split-cents", base: "main" },
    });
    const id = await pending;
    expect(id).not.toBeNull();
    expect(harness.engine.callsOf("session.create")).toEqual([
      expect.objectContaining({ cwd: `${PROJECT}/.dawg/worktrees/split-cents` }),
    ]);
  });

  it("opens the dialog when the project has no current branch to start from", async () => {
    const harness = await setup("worktree", {
      repos: { [PROJECT]: { current: null, branches: ["main"] } },
    });
    const pending = actions(harness).newSession({ projectDir: PROJECT });
    await vi.waitFor(() => expect(state(harness).newSessionOffer).not.toBeNull());
    expect(state(harness).newSessionOffer).toMatchObject({
      worktree: true,
      error: "The project has no current branch. Choose one to start from.",
    });
    expect(harness.bridge.worktreesCreated).toEqual([]);
    await actions(harness).answerNewSessionOffer(null);
    expect(await pending).toBeNull();
  });

  it("starts in the folder of a project that is not a git repository, whatever the setting", async () => {
    const harness = await setup("worktree");
    const id = await actions(harness).newSession({ projectDir: PROJECT });
    expect(id).not.toBeNull();
    expect(harness.bridge.worktreesCreated).toEqual([]);
    expect(state(harness).notices).toEqual([]);
  });

  it("keeps an explicit choice over the setting", async () => {
    const harness = await setup("worktree", { repos: REPO });
    await actions(harness).newSession({ projectDir: PROJECT, worktree: false });
    expect(harness.bridge.worktreesCreated).toEqual([]);
    expect(harness.engine.callsOf("session.create")).toEqual([
      expect.objectContaining({ cwd: PROJECT }),
    ]);
  });
});

describe("asking anyway", () => {
  it("opens the dialog whatever the setting says", async () => {
    const harness = await setup("folder", { repos: REPO });
    const pending = actions(harness).newSession({ projectDir: PROJECT, ask: true });
    await vi.waitFor(() => expect(state(harness).newSessionOffer).not.toBeNull());
    expect(state(harness).newSessionOffer?.worktree).toBe(false);
    await actions(harness).answerNewSessionOffer({ worktree: null });
    expect(await pending).not.toBeNull();
    expect(harness.engine.callsOf("session.create")).toEqual([
      expect.objectContaining({ cwd: PROJECT }),
    ]);
  });

  it("opens it with “Run in a worktree” checked for a new session in a worktree", async () => {
    const harness = await setup("folder", { repos: REPO });
    const pending = actions(harness).newSession({ projectDir: PROJECT, ask: "worktree" });
    await vi.waitFor(() => expect(state(harness).newSessionOffer?.worktree).toBe(true));
    await actions(harness).answerNewSessionOffer(null);
    expect(await pending).toBeNull();
  });

  it("says so when a worktree was asked for in a folder that is not a git repository", async () => {
    const harness = await setup("ask");
    const id = await actions(harness).newSession({ projectDir: PROJECT, ask: "worktree" });
    expect(id).not.toBeNull();
    expect(state(harness).notices.map((notice) => [notice.text, notice.tone])).toEqual([
      ["“tally” is not a git repository, so the session runs in the folder.", "neutral"],
    ]);
  });

  it("asks for the folder first when there is no project", async () => {
    const harness = await setup("folder", { repos: REPO, folder: PROJECT });
    const pending = actions(harness).newSession({ ask: true });
    await vi.waitFor(() => expect(state(harness).newSessionOffer?.projectDir).toBe(PROJECT));
    await actions(harness).answerNewSessionOffer(null);
    expect(await pending).toBeNull();
  });
});
