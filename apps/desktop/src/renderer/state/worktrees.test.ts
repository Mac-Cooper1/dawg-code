/**
 * The store's side of worktree sessions, workspace tracking and background commands: the
 * new-session dialog for git projects, worktree creation, tracking new and shown sessions,
 * cleaning up an archived worktree, and reading and stopping background commands.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakeBridge,
  FAKE_COMMIT,
  type FakeBridge,
  type FakeBridgeOptions,
} from "./__fixtures__/fake-bridge.ts";
import { FakeEngine } from "./__fixtures__/fake-engine.ts";
import { makeBackgroundTask, PROJECT } from "./__fixtures__/streams.ts";
import { selectTitleBar } from "./selectors.ts";
import { type AppStoreApi, createAppStore } from "./store.ts";
import { orderBranches, suggestWorktreeName, worktreeNameProblem } from "./worktree-names.ts";

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
const WORKTREE = `${PROJECT}/.dawg/worktrees/split-cents`;

async function setup(
  options: Omit<FakeBridgeOptions, "engine"> = {},
  engine = new FakeEngine(),
): Promise<Harness> {
  const bridge = createFakeBridge({ engine, ...options });
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

describe("new sessions", () => {
  it("starts at once in a folder that is not a git repository, and tracks the session", async () => {
    const harness = await setup();
    const id = await actions(harness).newSession({ projectDir: PROJECT });
    expect(id).not.toBeNull();
    expect(state(harness).newSessionOffer).toBeNull();
    expect(harness.engine.callsOf("session.create")).toEqual([
      expect.not.objectContaining({ projectDir: expect.anything() }),
    ]);
    await vi.waitFor(() =>
      expect(harness.bridge.tracked).toContainEqual({
        sessionId: id,
        cwd: PROJECT,
        projectDir: PROJECT,
        additionalDirectories: [],
      }),
    );
    await vi.waitFor(() => expect(state(harness).workspaces[id ?? ""]?.git).toBeNull());
  });

  it("asks where a session in a git project runs, and starts it in the folder", async () => {
    const harness = await setup({ repos: REPO });
    const pending = actions(harness).newSession({ projectDir: PROJECT });
    await vi.waitFor(() => expect(state(harness).newSessionOffer).not.toBeNull());
    const offer = state(harness).newSessionOffer;
    expect(offer).toMatchObject({
      projectDir: PROJECT,
      projectName: "tally",
      branches: ["main", "feature/csv"],
      current: "main",
      worktree: false,
      busy: false,
      error: null,
    });
    expect(offer?.suggestedName).toMatch(/^[a-z0-9][a-z0-9-]*$/);

    await actions(harness).answerNewSessionOffer({ worktree: null });
    const id = await pending;
    expect(id).not.toBeNull();
    expect(state(harness).newSessionOffer).toBeNull();
    expect(harness.bridge.worktreesCreated).toEqual([]);
    expect(harness.engine.callsOf("session.create")[0]).toMatchObject({ cwd: PROJECT });
    await vi.waitFor(() =>
      expect(state(harness).workspaces[id ?? ""]?.git).toMatchObject({
        branch: "main",
        baseCommit: FAKE_COMMIT,
        worktree: null,
      }),
    );
  });

  it("makes a worktree and starts the session in it", async () => {
    const harness = await setup({ repos: REPO });
    const pending = actions(harness).newSession({ projectDir: PROJECT });
    await vi.waitFor(() => expect(state(harness).newSessionOffer).not.toBeNull());
    await actions(harness).answerNewSessionOffer({
      worktree: { name: "split-cents", base: "main" },
    });
    const id = await pending;
    expect(harness.bridge.worktreesCreated).toEqual([
      { projectDir: PROJECT, name: "split-cents", base: "main" },
    ]);
    expect(harness.engine.callsOf("session.create")[0]).toMatchObject({
      cwd: WORKTREE,
      projectDir: PROJECT,
    });
    await vi.waitFor(() =>
      expect(harness.bridge.tracked).toContainEqual(
        expect.objectContaining({ sessionId: id, cwd: WORKTREE, projectDir: PROJECT }),
      ),
    );
    // The title bar's chip comes from the worktree main reported.
    await vi.waitFor(() =>
      expect(selectTitleBar(state(harness))).toMatchObject({
        worktreeLabel: "worktree · split-cents",
        worktreeTitle: "Runs in a worktree on dawg/split-cents, made from main",
      }),
    );

    // The next dialog starts with "Run in a worktree" checked.
    const next = actions(harness).newSession({ projectDir: PROJECT });
    await vi.waitFor(() => expect(state(harness).newSessionOffer?.worktree).toBe(true));
    await actions(harness).answerNewSessionOffer(null);
    expect(await next).toBeNull();
  });

  it("keeps the dialog open with the reason when the worktree cannot be made", async () => {
    const harness = await setup({ repos: REPO });
    harness.bridge.failNextWorktree("A branch named dawg/taken already exists.");
    const pending = actions(harness).newSession({ projectDir: PROJECT });
    await vi.waitFor(() => expect(state(harness).newSessionOffer).not.toBeNull());
    await actions(harness).answerNewSessionOffer({ worktree: { name: "taken", base: "main" } });
    expect(state(harness).newSessionOffer).toMatchObject({
      busy: false,
      error: "A branch named dawg/taken already exists.",
    });
    expect(harness.engine.callsOf("session.create")).toEqual([]);

    await actions(harness).answerNewSessionOffer({ worktree: { name: "free", base: "main" } });
    expect(await pending).not.toBeNull();
    expect(harness.engine.callsOf("session.create")[0]).toMatchObject({
      cwd: `${PROJECT}/.dawg/worktrees/free`,
    });
  });

  it("returns null when the dialog is cancelled", async () => {
    const harness = await setup({ repos: REPO });
    const pending = actions(harness).newSession({ projectDir: PROJECT });
    await vi.waitFor(() => expect(state(harness).newSessionOffer).not.toBeNull());
    await actions(harness).answerNewSessionOffer(null);
    expect(await pending).toBeNull();
    expect(state(harness).newSessionOffer).toBeNull();
    expect(harness.engine.callsOf("session.create")).toEqual([]);
  });

  it("takes the place and worktree from its options without asking", async () => {
    const harness = await setup({ repos: REPO });
    const inFolder = await actions(harness).newSession({ projectDir: PROJECT, worktree: false });
    expect(inFolder).not.toBeNull();
    const inWorktree = await actions(harness).newSession({
      projectDir: PROJECT,
      worktree: { name: "split-cents", base: "feature/csv" },
    });
    expect(inWorktree).not.toBeNull();
    expect(harness.bridge.worktreesCreated).toEqual([
      { projectDir: PROJECT, name: "split-cents", base: "feature/csv" },
    ]);
    expect(state(harness).newSessionOffer).toBeNull();
  });

  it("removes a worktree it made when the session cannot start", async () => {
    const engine = new FakeEngine();
    engine.overrides["session.create"] = () => {
      throw new Error("No model is loaded");
    };
    const harness = await setup({ repos: REPO }, engine);
    const id = await actions(harness).newSession({
      projectDir: PROJECT,
      worktree: { name: "split-cents", base: "main" },
    });
    expect(id).toBeNull();
    await vi.waitFor(() => expect(harness.bridge.worktreesCleaned).toEqual([WORKTREE]));
    expect(state(harness).notices.map((notice) => notice.text)).toContain(
      "Could not start a session: No model is loaded.",
    );
  });
});

describe("tracking", () => {
  it("tracks the session the window shows, again when its directories change", async () => {
    const engine = new FakeEngine();
    engine.addSession("s1", {}, { additionalDirectories: ["/Users/you/code/shared"] });
    engine.addSession("s2", { lastActivityAt: 1 });
    const harness = await setup({ windowState: { selectedSessionId: "s1" } }, engine);
    await vi.waitFor(() =>
      expect(harness.bridge.tracked).toContainEqual({
        sessionId: "s1",
        cwd: PROJECT,
        projectDir: PROJECT,
        additionalDirectories: ["/Users/you/code/shared"],
      }),
    );
    actions(harness).selectSession("s2");
    await vi.waitFor(() =>
      expect(harness.bridge.tracked.map((input) => input.sessionId)).toContain("s2"),
    );
    // Showing s1 again asks nothing new: its directories have not changed.
    const count = harness.bridge.tracked.length;
    actions(harness).selectSession("s1");
    expect(await actions(harness).trackSession("s1")).not.toBeNull();
    expect(harness.bridge.tracked).toHaveLength(count);
  });
});

describe("archiving and deleting", () => {
  async function worktreeSession(options: Omit<FakeBridgeOptions, "engine"> = {}) {
    const harness = await setup({ repos: REPO, ...options });
    const id = await actions(harness).newSession({
      projectDir: PROJECT,
      worktree: { name: "split-cents", base: "main" },
    });
    if (id === null) throw new Error("No session");
    await vi.waitFor(() => expect(state(harness).workspaces[id]?.git?.worktree).not.toBeNull());
    return { harness, id };
  }

  it("removes a clean, merged worktree and closes the session's terminals", async () => {
    const { harness, id } = await worktreeSession();
    const terminal = await harness.bridge.terminal.open({
      sessionId: id,
      cwd: WORKTREE,
      cols: 80,
      rows: 24,
    });
    await actions(harness).archiveSession(id);
    expect(harness.bridge.terminalsClosed).toEqual([terminal.terminalId]);
    expect(harness.bridge.untracked).toContain(id);
    expect(harness.bridge.worktreesCleaned).toEqual([WORKTREE]);
    expect(state(harness).notices).toContainEqual(
      expect.objectContaining({ text: "Removed the worktree.", tone: "neutral" }),
    );
    expect(state(harness).workspaces[id]).toBeUndefined();
  });

  it("says why it kept a worktree", async () => {
    const { harness, id } = await worktreeSession({
      cleanup: { removed: false, reason: "It has changes that are not committed." },
    });
    await actions(harness).archiveSession(id);
    expect(state(harness).notices.map((notice) => notice.text)).toContain(
      "Kept the worktree: It has changes that are not committed.",
    );
  });

  it("leaves a session in the project folder alone", async () => {
    const harness = await setup({ repos: REPO });
    const id = await actions(harness).newSession({ projectDir: PROJECT, worktree: false });
    if (id === null) throw new Error("No session");
    await actions(harness).archiveSession(id);
    expect(harness.bridge.worktreesCleaned).toEqual([]);
    expect(state(harness).notices).toEqual([]);
  });

  it("cleans up a deleted session's worktree too", async () => {
    const { harness, id } = await worktreeSession();
    await actions(harness).deleteSession(id);
    expect(harness.bridge.worktreesCleaned).toEqual([WORKTREE]);
    expect(harness.bridge.untracked).toContain(id);
    expect(state(harness).workspaces[id]).toBeUndefined();
  });
});

describe("background commands", () => {
  async function withCommand() {
    const engine = new FakeEngine();
    engine.addSession("s1");
    const harness = await setup({ windowState: { selectedSessionId: "s1" } }, engine);
    await vi.waitFor(() => expect(state(harness).sessions.s1?.loaded).toBe(true));
    engine.emit("s1", "background.updated", { task: makeBackgroundTask("bg1") });
    await vi.waitFor(() => expect(state(harness).sessions.s1?.background).toHaveLength(1));
    return { engine, harness };
  }

  it("reads a command's output from an offset", async () => {
    const { engine, harness } = await withCommand();
    engine.backgroundOutput("s1", "bg1", "listening on :3000\n");
    expect(await actions(harness).readBackgroundOutput("s1", "bg1", 0)).toEqual({
      text: "listening on :3000\n",
      nextOffset: 19,
      totalBytes: 19,
      done: false,
    });
    engine.backgroundOutput("s1", "bg1", "GET /\n");
    expect(await actions(harness).readBackgroundOutput("s1", "bg1", 19)).toMatchObject({
      text: "GET /\n",
      nextOffset: 25,
    });
  });

  it("reports a failed read as a sentence", async () => {
    const { harness } = await withCommand();
    expect(await actions(harness).readBackgroundOutput("s1", "nope", 0)).toEqual({
      error: "No background command nope.",
    });
  });

  it("stops a running command, which the next event shows", async () => {
    const { engine, harness } = await withCommand();
    expect(await actions(harness).stopBackground("s1", "bg1")).toBe(true);
    expect(engine.callsOf("background.stop")).toEqual([{ sessionId: "s1", taskId: "bg1" }]);
    await vi.waitFor(() =>
      expect(state(harness).sessions.s1?.background[0]).toMatchObject({
        status: "stopped",
        stopReason: "requested",
      }),
    );
  });
});

describe("worktree names", () => {
  it("suggests two words whose branch is free", () => {
    const first = () => 0;
    expect(suggestWorktreeName([], first)).toBe("amber-badger");
    expect(suggestWorktreeName(["dawg/amber-badger"], first)).toBe("amber-badger-2");
    expect(worktreeNameProblem(suggestWorktreeName(["main"]))).toBeNull();
  });

  it("says what is wrong with a name", () => {
    expect(worktreeNameProblem("")).toBe("Give the worktree a name.");
    expect(worktreeNameProblem("Split Cents")).toBe(
      "Use lowercase letters, digits and dashes, starting with a letter or digit.",
    );
    expect(worktreeNameProblem("a".repeat(61))).toBe("Use at most 60 characters.");
    expect(worktreeNameProblem("split-cents-2")).toBeNull();
  });

  it("lists the current branch first, once", () => {
    expect(orderBranches("main", ["feature/csv", "main"])).toEqual(["main", "feature/csv"]);
    expect(orderBranches(null, ["a", "b"])).toEqual(["a", "b"]);
  });
});
