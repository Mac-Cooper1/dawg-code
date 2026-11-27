/**
 * The project trust dialog's state and the hooks requests, on a real runtime and the fake engine:
 * when the dialog opens by itself, what "Not now" remembers, approving, and a list that changed
 * meanwhile.
 */
import { type CodeApproval, type CompatItem, ErrorCodes, RpcError } from "@dawg/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeBridge, type FakeBridge } from "./__fixtures__/fake-bridge.ts";
import { FakeEngine } from "./__fixtures__/fake-engine.ts";
import { PROJECT } from "./__fixtures__/streams.ts";
import { type AppStoreApi, createAppStore } from "./store.ts";

const ID = "s1";

function hook(command: string): CompatItem {
  return {
    kind: "hook",
    name: `PreToolUse on Bash: ${command}`,
    source: { path: `${PROJECT}/.claude/settings.json`, origin: "claude", scope: "project" },
    status: "needs-approval",
    notes: ["Runs a command from the project's files."],
  };
}

interface Harness {
  engine: FakeEngine;
  bridge: FakeBridge;
  store: AppStoreApi;
  /** What `project.inspect` answers from now on. */
  setApproval(approval: CodeApproval | null): void;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const { store, bridge } of harnesses.splice(0)) {
    store.getState().actions.stop();
    bridge.close();
  }
});

async function started(approval: CodeApproval | null): Promise<Harness> {
  const engine = new FakeEngine();
  engine.addSession(ID);
  let current = approval;
  engine.overrides["project.inspect"] = (params) => ({
    projectDir: params.projectDir,
    items: current?.items ?? [],
    approval: current,
  });
  const bridge = createFakeBridge({ engine, windowState: { selectedSessionId: ID } });
  const store = createAppStore({ bridge });
  const harness: Harness = {
    engine,
    bridge,
    store,
    setApproval: (next) => {
      current = next;
    },
  };
  harnesses.push(harness);
  await store.getState().actions.start();
  await vi.waitFor(() => expect(store.getState().sessions[ID]?.loaded).toBe(true));
  return harness;
}

const WAITING: CodeApproval = {
  hash: "sha256:one",
  approved: false,
  items: [hook("./scripts/check.sh")],
};

function skipped(engine: FakeEngine): void {
  engine.emit(ID, "hook.skipped", {
    turnId: null,
    projectDir: PROJECT,
    sources: [{ path: `${PROJECT}/.claude/settings.json`, origin: "claude", scope: "project" }],
  });
}

describe("the project trust dialog", () => {
  it("opens by itself when the shown session's project has code waiting, once per run", async () => {
    const { store, engine } = await started(WAITING);
    await vi.waitFor(() => expect(store.getState().trustReview?.phase).toBe("ready"));
    expect(store.getState().trustReview).toMatchObject({
      projectDir: PROJECT,
      projectName: "tally",
      approval: WAITING,
      message: null,
    });
    expect(engine.callsOf("project.inspect")).toContainEqual({ projectDir: PROJECT });
    await store.getState().actions.answerTrustReview(false);
    expect(store.getState().trustReview).toBeNull();
    // Showing the session again does not ask again.
    const asked = engine.callsOf("project.inspect").length;
    store.getState().actions.selectSession(ID);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.callsOf("project.inspect")).toHaveLength(asked);
    expect(store.getState().trustReview).toBeNull();
  });

  it("stays closed when nothing waits, or the code is approved", async () => {
    const { store, engine } = await started({ ...WAITING, approved: true });
    await vi.waitFor(() => expect(engine.callsOf("project.inspect").length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getState().trustReview).toBeNull();
  });

  it("asks again after Not now only when the definitions change", async () => {
    const { store, engine, setApproval } = await started(WAITING);
    await vi.waitFor(() => expect(store.getState().trustReview?.phase).toBe("ready"));
    await store.getState().actions.answerTrustReview(false);

    // Hooks held back again, same definitions: put off, so it stays closed.
    const asked = engine.callsOf("project.inspect").length;
    skipped(engine);
    await vi.waitFor(() => expect(engine.callsOf("project.inspect")).toHaveLength(asked + 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getState().trustReview).toBeNull();

    // The project's hooks changed: a new hash, so it asks.
    const changed = { ...WAITING, hash: "sha256:two", items: [hook("./scripts/other.sh")] };
    setApproval(changed);
    skipped(engine);
    await vi.waitFor(() => expect(store.getState().trustReview?.approval).toEqual(changed));
  });

  it("approves with the hash it showed, then closes", async () => {
    const { store, engine } = await started(WAITING);
    await vi.waitFor(() => expect(store.getState().trustReview?.phase).toBe("ready"));
    await store.getState().actions.answerTrustReview(true);
    expect(engine.callsOf("project.trust")).toEqual([
      { projectDir: PROJECT, hash: "sha256:one", approved: true },
    ]);
    expect(store.getState().trustReview).toBeNull();
    expect(store.getState().notices.at(-1)).toMatchObject({ tone: "neutral" });
  });

  it("shows what is there now when the definitions changed before approving", async () => {
    const { store, engine, setApproval } = await started(WAITING);
    await vi.waitFor(() => expect(store.getState().trustReview?.phase).toBe("ready"));
    const changed = { ...WAITING, hash: "sha256:two", items: [hook("./scripts/other.sh")] };
    setApproval(changed);
    engine.overrides["project.trust"] = () => {
      throw new RpcError(ErrorCodes.InvalidState, "The definitions changed.");
    };
    await store.getState().actions.answerTrustReview(true);
    expect(store.getState().trustReview).toMatchObject({
      phase: "ready",
      approval: changed,
      message: expect.stringMatching(/changed since this list was shown/),
    });
  });

  it("opens on request, saying when nothing needs approval", async () => {
    const { store } = await started(null);
    store.getState().actions.reviewProjectCode(PROJECT);
    expect(store.getState().trustReview?.phase).toBe("loading");
    await vi.waitFor(() => expect(store.getState().trustReview?.phase).toBe("ready"));
    expect(store.getState().trustReview?.approval).toBeNull();
  });
});

describe("hooks requests", () => {
  it("lists hooks and turns one off, and turns failures into sentences", async () => {
    const { store, engine } = await started(null);
    const { actions } = store.getState();
    expect(await actions.listHooks(PROJECT)).toEqual({
      projectDir: PROJECT,
      hooks: [],
      disabledBy: null,
    });
    expect(await actions.setHookEnabled(PROJECT, "hook:1", false)).toBe(true);
    expect(engine.callsOf("hooks.setEnabled")).toEqual([
      { projectDir: PROJECT, id: "hook:1", enabled: false },
    ]);

    engine.overrides["hooks.list"] = () => {
      throw new RpcError(ErrorCodes.InternalError, "The settings could not be read");
    };
    expect(await actions.listHooks(null)).toEqual({
      error: "The settings could not be read.",
    });
    engine.overrides["hooks.setEnabled"] = () => {
      throw new RpcError(ErrorCodes.InvalidParams, "No hook with the id hook:2 applies here");
    };
    expect(await actions.setHookEnabled(PROJECT, "hook:2", true)).toBe(false);
    expect(store.getState().notices.at(-1)?.text).toBe(
      "Could not turn the hook on: No hook with the id hook:2 applies here.",
    );
  });
});
